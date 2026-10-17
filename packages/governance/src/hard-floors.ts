// SPDX-License-Identifier: Apache-2.0
/**
 * Hard floors — operations checked FIRST in the evaluation pipeline, before
 * policy rules, always-allow rules, learned allow-preferences, and the
 * reviewer model. No mode can bypass a hard floor.
 *
 * TWO TIERS (do not collapse them):
 *
 *   TIER 1 — 'catastrophic': instant, irreversible destruction of the host or
 *   its data (wiping the root filesystem, formatting disks, raw block-device
 *   writes, fork bombs, …). A human approval click is NOT a sufficient
 *   safeguard here — misclicks and social-engineered approvals happen — so
 *   catastrophic calls are DENIED UNCONDITIONALLY. They are never executable,
 *   never approvable: no approval record is minted, there is nothing for a
 *   human to approve, and re-evaluation keeps denying even if some other
 *   layer minted an approval for the same call.
 *
 *   TIER 2 — 'destructive': destructive-but-recoverable or merely privileged
 *   operations (sudo, shutdown, deleting a specific project file, dropping a
 *   table, sending an external message, …). These REQUIRE HUMAN APPROVAL:
 *   the gateway mints a pending approval and the call only runs if a human
 *   explicitly approves it.
 *
 * Users can ADD extra patterns via config, but CANNOT remove or weaken the
 * built-ins. Extra patterns always enter tier 2 ('destructive'): a user
 * config can never create an unapprovable floor, only request approval for
 * more operations.
 */

export type HardFloorTier = 'catastrophic' | 'destructive';

export interface HardFloorPattern {
  /** Stable id for audit messages. */
  id: string;
  /** Case-insensitive regex matched against the tool name. */
  toolPattern: string;
  /**
   * Tier of this floor.
   * - 'catastrophic': unconditional denial, never approvable.
   * - 'destructive': requires human approval.
   * Built-ins set this explicitly; user-added extras default to 'destructive'.
   */
  tier?: HardFloorTier;
  /**
   * Optional check against the (redacted) args. Return a reason string when
   * the floor hits, or null when it doesn't. If omitted, any call matching
   * toolPattern hits the floor.
   */
  argCheck?: (args: Record<string, unknown>) => string | null;
}

export interface HardFloorConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** User-added patterns. Built-ins cannot be removed. Always tier 2. */
  extraPatterns?: HardFloorPattern[];
}

/** Serialize args to a searchable string (values only, redacted upstream). */
function argsText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

/**
 * Classify one `rm` operand token as a catastrophic target, or null.
 * Mirrors the previous regex semantics: `/`, `/*`, the system directories,
 * and the home directory (~, $HOME, ${HOME}).
 */
function classifyRmTarget(operand: string): string | null {
  if (/^\/([^a-zA-Z0-9_*]|$)/.test(operand)) return 'rm -rf /';
  if (operand.startsWith('/*')) return 'rm -rf /*';
  if (/^\/(tmp|etc|home|root|var|usr)(\/|$)/.test(operand)) return 'rm -rf on system dir';
  if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(operand)) return 'rm -rf on home directory';
  return null;
}

/**
 * Detect `rm` invocations that would recursively delete a catastrophic
 * target (`/`, `/*`, system dirs, home dir).
 *
 * Short-flag clusters are expanded letter by letter, so `rm -rfv /etc`,
 * `rm -rf --one-file-system /` and `rm -rfv --preserve-root=no /` are
 * caught exactly like `rm -rf /etc`; `--recursive` counts too. Matching the
 * previous regex semantics, a recursive flag alone (no `-f`) is enough for
 * these targets. A lone `--` ends flag parsing (everything after is an
 * operand), and an `rm` invocation never spans `;`, `&`, `|` or newlines.
 *
 * Returns a label for the matched target, or null.
 * Exported for the agent-runtime tool-level denylist (defense in depth):
 * the same hard floor applies to CLI-observed tool calls.
 */
export function catastrophicRmTarget(text: string): string | null {
  const segments = text.split(/[;&|\n]+/);
  for (const seg of segments) {
    const rmRe = /\brm\b/g;
    let m: RegExpExecArray | null;
    while ((m = rmRe.exec(seg)) !== null) {
      const rest = seg.slice(m.index + m[0].length);
      const tokens = rest.trim().split(/\s+/).filter(Boolean);
      let recursive = false;
      let endOfFlags = false;
      let target: string | null = null;
      for (const tok of tokens) {
        if (!endOfFlags && tok === '--') {
          endOfFlags = true;
          continue;
        }
        if (!endOfFlags && tok.startsWith('--') && tok.length > 2) {
          // Long flags: --recursive counts; --force / --no-preserve-root are
          // handled by their own patterns; the rest (--one-file-system,
          // --preserve-root=no, …) are ignored for flag purposes.
          if (tok.slice(2).split('=')[0].toLowerCase() === 'recursive') recursive = true;
          continue;
        }
        if (!endOfFlags && tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
          for (const ch of tok.slice(1)) {
            if (ch === 'r' || ch === 'R') recursive = true;
          }
          continue;
        }
        // Operand: strip JSON/string punctuation the serializer may add.
        const operand = tok.replace(/^["']+|["',}\]]+$/g, '');
        if (!target) target = classifyRmTarget(operand);
      }
      if (recursive && target) return target;
    }
  }
  return null;
}

/**
 * Built-in hard floors. These cannot be disabled individually. Patterns are
 * evaluated in array order — the catastrophic shell floor comes first so a
 * catastrophic command is never misclassified as merely destructive.
 */
export const HARD_FLOOR_PATTERNS: HardFloorPattern[] = [
  {
    id: 'catastrophic-shell',
    tier: 'catastrophic',
    toolPattern: '^(run_command|shell|exec)$',
    argCheck: (args) => {
      const text = argsText(args);
      // rm flag-variant bypass fix (M1): expand short-flag clusters so
      // `rm -rfv /etc`, `rm -rf --one-file-system /` etc. are caught.
      const rmHit = catastrophicRmTarget(text);
      if (rmHit) return `catastrophic shell pattern: ${rmHit}`;
      // L3: `${IFS}` alone is a legitimate (if unusual) shell feature, not a
      // catastrophe — only flag it when combined with a destructive payload
      // in the same command (the classic obfuscation trick).
      if (
        /\$\{IFS\}/.test(text) &&
        /\b(rm|dd|mkfs|shred|wipefs|fdisk|sfdisk|gdisk|sgdisk|cgdisk|parted|chmod|chown|curl|wget)\b|:\(\)\s*\{\s*:[|\s]+:[&\s]*\s*\}|\/dev\//i.test(
          text,
        )
      ) {
        return 'catastrophic shell pattern: ${IFS} obfuscation with destructive command';
      }
      const patterns: Array<[RegExp, string]> = [
        [/\brm\s+.*--no-preserve-root\b/i, 'rm with --no-preserve-root'],
        [/\bmkfs\b/, 'mkfs'],
        [/\bdd\b[^;&|]*\bof\s*=\s*\/dev\//i, 'dd writing to a raw block device'],
        // MEDIUM fix: shell redirection straight into a block device
        // (e.g. `cat img.iso > /dev/sda`) — same destruction as dd.
        [/(?:^|[;&|])[^;&|]*?>{1,2}\s*\/dev\/[a-zA-Z0-9]+/, 'shell redirection into a block device'],
        // MEDIUM fix: recursive delete via find on the filesystem root.
        [/\bfind\s+\/\*?\s+[^;&|]*-delete\b/, 'find / -delete'],
        [/\b(shred|wipefs|fdisk|sfdisk|gdisk|sgdisk|cgdisk|parted)\b/i, 'disk wipe/partition tool'],
        [/:\(\)\s*\{\s*:[|\s]+:[&\s]*\s*\}\s*;?\s*:?/, 'fork bomb'],
      ];
      for (const [re, label] of patterns) {
        if (re.test(text)) return `catastrophic shell pattern: ${label}`;
      }
      return null;
    },
  },
  {
    id: 'destructive-shell',
    tier: 'destructive',
    toolPattern: '^(run_command|shell|exec)$',
    argCheck: (args) => {
      const text = argsText(args);
      const patterns: Array<[RegExp, string]> = [
        [/\bsudo\b/, 'sudo'],
        [/\bdd\s+if=/, 'dd with input file'],
        [/chmod\s+-R\s+777\s+\//, 'chmod -R 777 /'],
        [/\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, 'shutdown/reboot'],
        // Shell redirection into an absolute/escaping target — the classic
        // run_command escape around file-write approvals (e.g. `echo x >
        // /etc/cron.d/pwn`). Tier 2 (needs human), not catastrophic: legit
        // `> workspace/out.txt` uses relative paths and never matches.
        [/(?:^|[;&|])[^;&|]*?>{1,2}\s*(?:\/|~|[a-zA-Z]:[\\/]|\\\\|\.\.)/, 'redirection into absolute/escaping path'],
      ];
      for (const [re, label] of patterns) {
        if (re.test(text)) return `destructive shell pattern: ${label}`;
      }
      return null;
    },
  },
  {
    id: 'file-escape-workspace',
    tier: 'destructive',
    toolPattern: '^(write_file|delete_file|edit|patch|create_file|edit_file|remove_file)$',
    argCheck: (args) => {
      const p = args['path'];
      if (typeof p === 'string' && (p.startsWith('/') || p.startsWith('~') || p.includes('..') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\'))) {
        return `absolute or escaping path: ${p.slice(0, 80)}`;
      }
      return null;
    },
  },
  {
    id: 'external-send',
    tier: 'destructive',
    toolPattern: '^(messaging\\.send|send_message|send_email)$',
    // Any external send hits the floor; test channels are allow-listed by arg.
    argCheck: (args) => {
      const to = args['to'] ?? args['channel'] ?? args['recipient'];
      if (typeof to === 'string' && /test|localhost|example\.com/i.test(to)) return null;
      return 'external message send';
    },
  },
  {
    id: 'untrusted-mcp',
    tier: 'destructive',
    toolPattern: '^mcp:',
    argCheck: (args) => {
      // The gateway marks untrusted-server calls in ctx; here we check the
      // explicit flag the tool registry sets on the args envelope.
      if (args['__untrusted'] === true) return 'untrusted MCP server';
      return null;
    },
  },
];

export interface HardFloorHit {
  patternId: string;
  tier: HardFloorTier;
  reason: string;
}

/**
 * Check hard floors. Returns a hit when the call must be human-gated
 * (tier 'destructive') or denied outright (tier 'catastrophic').
 * Checked before policy rules, always-allow, learned preferences, reviewer.
 */
export function checkHardFloor(
  toolName: string,
  args: Record<string, unknown>,
  config?: HardFloorConfig,
): HardFloorHit | null {
  const cfg = config ?? { enabled: true };
  if (!cfg.enabled) return null;
  const patterns = [...HARD_FLOOR_PATTERNS, ...(cfg.extraPatterns ?? [])];
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.toolPattern, 'i');
    } catch {
      continue;
    }
    if (!re.test(toolName)) continue;
    if (!p.argCheck) {
      return { patternId: p.id, tier: p.tier ?? 'destructive', reason: `hard floor: ${p.id}` };
    }
    let reason: string | null = null;
    try {
      reason = p.argCheck(args);
    } catch {
      reason = null;
    }
    if (reason) {
      return { patternId: p.id, tier: p.tier ?? 'destructive', reason: `Hard floor: ${reason}` };
    }
  }
  return null;
}
