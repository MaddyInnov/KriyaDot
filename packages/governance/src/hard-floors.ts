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
      const patterns: Array<[RegExp, string]> = [
        [/\brm\s+(-r\s+-f|-f\s+-r|-rf?)\s+\/(?![\w])/i, 'rm -rf /'],
        [/\brm\s+(-r\s+-f|-f\s+-r|-rf?)\s+\/\*/, 'rm -rf /*'],
        [/\bmkfs\b/, 'mkfs'],
        [/\bdd\b[^;&|]*\bof=\s*\/dev\//i, 'dd writing to a raw block device'],
        [/\b(shred|wipefs|fdisk|sfdisk|gdisk|sgdisk|cgdisk|parted)\b/i, 'disk wipe/partition tool'],
        [/:(\(\))\s*\{\s*:\|:\&\s*\}\s*;?\s*:/, 'fork bomb'],
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
    toolPattern: '^(write_file|delete_file|edit|patch)$',
    argCheck: (args) => {
      const p = args['path'];
      if (typeof p === 'string' && (p.startsWith('/') || p.startsWith('~') || p.includes('..'))) {
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
