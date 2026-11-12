// SPDX-License-Identifier: Apache-2.0
// CLI identity declarations + safe matching + pin registry (Timon parity A8).
//
// Why this module exists
// ----------------------
// Before A8 the identity probes for the three subscription CLI bridges
// (Claude Code, Codex, OpenCode) were hardcoded RegExp literals buried in
// cli-bridge.ts. That made them impossible to audit as data, impossible to
// reuse from provider manifests, and dependent on regexes evaluated against
// UNTRUSTED output (whatever a same-named binary on PATH chooses to print).
// A8 turns the probes into DECLARED data: one declaration per bridge that
// the resolver consumes. The shape is deliberately manifest-friendly (plain
// JSON-compatible values only — no RegExp objects, no functions) so the A2
// provider manifests can adopt these declarations verbatim later.
//
// Threat model
// ------------
// - The probed binary is untrusted: it may be an unrelated namesake, a
//   hostile plant, or a broken install. It controls its stdout/stderr
//   bytes, its exit code, and (within the spawn timeout) its runtime.
// - Pattern matching must therefore be ReDoS-safe BY CONSTRUCTION. The
//   built-in matchers are linear scans (case-insensitive substring /
//   prefix / a hand-parsed semver prefix) over length-capped input — there
//   is no backtracking engine in the path at all. A `regex` matcher kind
//   exists for future manifest authors, but a declaration only loads if
//   its pattern passes assertSafeRegexPattern() (no nested quantifiers,
//   no backreferences, bounded length) AND it is only ever run against
//   the capped first line / capped output, never the raw stream.
// - Refusals quote the program's first printed line so the user can see
//   WHAT answered — always through redactCliSecrets() first, because a
//   broken or hostile binary could print credential-shaped text.
// - A user-pinned CLI path (see the pin registry below) is a LOCATION
//   hint, never a trust grant: pinned binaries go through exactly the
//   same identity probe as PATH candidates.
//
// Honest limits
// -------------
// - Identity is a banner check, not attestation: a binary that prints the
//   right banner passes. That is the same bar as v0.2.2 — the goal is to
//   never mistake an unrelated namesake for the real CLI, not to prove
//   provenance of a deliberately impersonating binary.
// - The spawn itself is bounded by the caller's timeout in cli-bridge;
//   this module bounds only the matching work after output is captured.
// - The pin registry is process-local state layered over an env var; the
//   API layer owns persistence (providers.local.json) and re-applies pins
//   into this registry at boot and on every change, so resolution reads
//   the current pin at resolve time with no restart.

import { statSync } from 'node:fs';

/** Bridge ids covered by identity declarations (mirrors CliBridgeId in cli-bridge). */
export type CliIdentityBridgeId = 'claude' | 'codex' | 'opencode';

/**
 * A2: every bridge id, including the five manifest-first bridges whose
 * identity declarations live in their provider manifests (provider-
 * manifest.ts) rather than in CLI_IDENTITY_DECLARATIONS below. The pin
 * registry is keyed by this wider id so A2 bridges get pinnable CLI
 * paths through exactly the same machinery.
 */
export type CliIdentityAnyBridgeId =
  | CliIdentityBridgeId
  | 'copilot'
  | 'grok'
  | 'kimi'
  | 'pi'
  | 'hermes';

/**
 * One identity test, as data. All kinds are evaluated by matchIdentity()
 * with linear scans over capped input, except `regex`, which is gated by
 * assertSafeRegexPattern() at declaration load.
 */
export type CliIdentityMatch =
  /** First printed line contains `needle` (case-insensitive). */
  | { kind: 'firstLineContains'; needle: string }
  /** First printed line starts with `needle` (case-insensitive) at a word boundary. */
  | { kind: 'firstLinePrefix'; needle: string }
  /** First printed line starts with a `major.minor.patch` version number. */
  | { kind: 'firstLineSemver' }
  /** Whole (capped) output contains `needle` (case-insensitive). */
  | { kind: 'outputContains'; needle: string }
  /** First printed line matches a pre-validated simple regex (see header). */
  | { kind: 'regex'; source: string; flags?: string };

/** Declared identity probe for one bridge CLI. Plain data — manifest-ready. */
export interface CliIdentityDeclaration {
  bridgeId: CliIdentityBridgeId;
  /** Bare command name the bridge resolves on PATH (e.g. "codex"). */
  commandName: string;
  /** Args for the primary probe (almost always `--version`). */
  versionArgs: string[];
  /** The primary probe passes when this matches the version output. */
  versionMatch: CliIdentityMatch;
  /** Fallback probe, run only when the primary output is uninformative. */
  helpArgs?: string[];
  helpMatch?: CliIdentityMatch;
  /**
   * Case-insensitive substrings that mark the output as a known-broken
   * runtime dump (e.g. a Python traceback from a same-named package).
   * Checked before any accept match.
   */
  rejectIfOutputContains: string[];
}

/**
 * The declared identity patterns for all three bridges (A8 §1). These are
 * the v0.2.2 probes, restated as data:
 * - claude: real `--version` prints "2.1.316 (Claude Code)".
 * - codex: real `--version` prints "codex-cli 0.142.0" — anchored at the
 *   line start because a namesake's crash output mentions "codex" in file
 *   paths, so an unanchored mention proves nothing.
 * - opencode: real `--version` prints a bare semver ("1.0.119"), which is
 *   weak evidence on its own, so `--help` must also name the tool.
 */
export const CLI_IDENTITY_DECLARATIONS: Record<CliIdentityBridgeId, CliIdentityDeclaration> = {
  claude: {
    bridgeId: 'claude',
    commandName: 'claude',
    versionArgs: ['--version'],
    versionMatch: { kind: 'firstLineContains', needle: 'claude code' },
    rejectIfOutputContains: ['traceback (most recent call last)', 'modulenotfounderror', 'importerror'],
  },
  codex: {
    bridgeId: 'codex',
    commandName: 'codex',
    versionArgs: ['--version'],
    versionMatch: { kind: 'firstLinePrefix', needle: 'codex-cli' },
    rejectIfOutputContains: ['traceback (most recent call last)', 'modulenotfounderror', 'importerror'],
  },
  opencode: {
    bridgeId: 'opencode',
    commandName: 'opencode',
    versionArgs: ['--version'],
    versionMatch: { kind: 'firstLineSemver' },
    helpArgs: ['--help'],
    helpMatch: { kind: 'outputContains', needle: 'opencode' },
    rejectIfOutputContains: ['traceback (most recent call last)', 'modulenotfounderror', 'importerror'],
  },
};

/** Every declared bridge id, in declaration order. */
export const CLI_IDENTITY_BRIDGE_IDS = Object.keys(CLI_IDENTITY_DECLARATIONS) as CliIdentityBridgeId[];

// ---------------------------------------------------------------------------
// Bounded matching (ReDoS-safe by construction).
// ---------------------------------------------------------------------------

/** Identity matching never looks past this many output characters. */
export const IDENTITY_OUTPUT_CAP = 16_384;
/** Nor past this many characters of the first printed line. */
export const IDENTITY_FIRST_LINE_CAP = 512;

/** The first non-empty printed line of a probe output, trimmed and capped. */
export function firstPrintedLine(output: string): string {
  const capped = output.length > IDENTITY_OUTPUT_CAP ? output.slice(0, IDENTITY_OUTPUT_CAP) : output;
  for (const raw of capped.split('\n')) {
    const line = raw.trim();
    if (line.length > 0) return line.slice(0, IDENTITY_FIRST_LINE_CAP);
  }
  return '';
}

function containsCi(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** True when output carries any declared reject marker (linear scans). */
export function outputMatchesReject(output: string, rejectNeedles: string[]): boolean {
  const capped = output.length > IDENTITY_OUTPUT_CAP ? output.slice(0, IDENTITY_OUTPUT_CAP) : output;
  const lower = capped.toLowerCase();
  return rejectNeedles.some((n) => lower.includes(n.toLowerCase()));
}

/**
 * Reject regex sources that can backtrack catastrophically: nested
 * quantifiers over groups (`(a+)+`, `(.*)*`), backreferences, and
 * over-long patterns. This is a conservative allowlist-style gate for the
 * `regex` matcher kind — the built-in declarations use no regexes at all.
 */
export function assertSafeRegexPattern(source: string): boolean {
  if (typeof source !== 'string' || source.length === 0 || source.length > 200) return false;
  if (/\\[1-9]/.test(source)) return false; // backreference
  if (/\{\d+,\d*\}\s*(?:[+*]|\{)/.test(source)) return false; // stacked bounded quantifiers
  // Quantified groups are the classic ReDoS shape: `(a+)+`, `(.*)*`,
  // `(a|aa)+`. Only a single-literal group may repeat (`(a)+` is linear);
  // anything richer — quantifiers, alternation, or multiple atoms inside
  // a repeated group — is refused. Conservative by design: banner checks
  // never need grouped repetition.
  const groupRe = /\((?:\?(?::|<=|<!|=|!))?([^()]*)\)\s*(?:[+*]|\{)/g;
  let m: RegExpExecArray | null;
  while ((m = groupRe.exec(source)) !== null) {
    const body = m[1];
    if (body.length !== 1 || /[+*|\\[.]/.test(body)) return false;
  }
  return true;
}

/**
 * Evaluate one declared match against probe output. Input is capped
 * BEFORE any work, and every built-in kind is a linear scan or a
 * hand-rolled parse — a hostile binary printing pathological output
 * cannot make this hang.
 */
export function matchIdentity(match: CliIdentityMatch, output: string): boolean {
  const capped = output.length > IDENTITY_OUTPUT_CAP ? output.slice(0, IDENTITY_OUTPUT_CAP) : output;
  const firstLine = firstPrintedLine(capped);
  switch (match.kind) {
    case 'firstLineContains':
      return containsCi(firstLine, match.needle);
    case 'firstLinePrefix': {
      const line = firstLine.toLowerCase();
      const needle = match.needle.toLowerCase();
      if (!line.startsWith(needle)) return false;
      const next = line.charAt(needle.length);
      return next === '' || /[^a-z0-9_-]/.test(next); // word boundary after the prefix
    }
    case 'firstLineSemver':
      return parseLeadingSemver(firstLine) !== undefined;
    case 'outputContains':
      return containsCi(capped, match.needle);
    case 'regex': {
      if (!assertSafeRegexPattern(match.source)) return false;
      try {
        return new RegExp(match.source, match.flags ?? '').test(firstLine);
      } catch {
        return false;
      }
    }
  }
}

/** Parse a leading `major.minor.patch` by hand (linear, no regex). */
export function parseLeadingSemver(text: string): string | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text.slice(0, IDENTITY_FIRST_LINE_CAP));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/** Extract the first semver-looking token from a (capped) line, if any. */
export function extractSemver(text: string): string | undefined {
  const capped = text.slice(0, IDENTITY_FIRST_LINE_CAP);
  const re = /\d+\.\d+\.\d+(?:[-.+\w]*)?/; // fixed, quantifier-flat pattern over ≤512 chars
  return re.exec(capped)?.[0];
}

// ---------------------------------------------------------------------------
// Secret redaction for quoted output (refusals quote the first printed
// line — never raw: a broken/hostile binary could print credential text).
// ---------------------------------------------------------------------------

/**
 * Redact credential-shaped substrings before text leaves the resolver.
 * Covers the token shapes the bridges themselves handle (Anthropic /
 * OpenAI keys, JWTs, GitHub tokens, `key=value` secret pairs, Bearer
 * headers). Deliberately conservative: ordinary error text is untouched.
 */
export function redactCliSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/gho_[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{8,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){0,2}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [REDACTED]')
    .replace(
      /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["'\s:=]+[A-Za-z0-9._~+/-]{8,}/gi,
      '$1=[REDACTED]',
    );
}

/** The first printed line of `output`, redacted and length-capped for display. */
export function redactedFirstLine(output: string, maxChars = 180): string {
  const line = redactCliSecrets(firstPrintedLine(output));
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// Identity probe cache, keyed per file by (absolute path + size + mtime)
// (A8 §2). A hit requires BOTH size and mtime to match the live stat, so
// replacing or touching the binary invalidates the entry and re-probes.
// ---------------------------------------------------------------------------

export interface CachedIdentity<T> {
  size: number;
  mtimeMs: number;
  result: T;
}

const identityCache = new Map<string, CachedIdentity<unknown>>();

export function getCachedIdentity<T>(path: string, size: number, mtimeMs: number): T | undefined {
  const entry = identityCache.get(path);
  if (!entry) return undefined;
  if (entry.size !== size || entry.mtimeMs !== mtimeMs) return undefined;
  return entry.result as T;
}

export function setCachedIdentity<T>(path: string, size: number, mtimeMs: number, result: T): void {
  identityCache.set(path, { size, mtimeMs, result });
}

export function clearIdentityCache(): void {
  identityCache.clear();
}

/** Stat a candidate for cache keying; undefined when the file is gone. */
export function statForCache(path: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// User-pinnable CLI paths (A8 §5). Process-local registry layered over an
// env var; the API layer persists pins and re-applies them here at boot
// and on change, so reads at resolve time are always live. A pin is a
// location hint only — identity verification still applies in full.
// ---------------------------------------------------------------------------

/** Env var the API layer mirrors a persisted pin into (boot path). */
export function cliPathPinEnvName(id: CliIdentityAnyBridgeId): string {
  return `KRIYADOT_CLI_PATH_${id.toUpperCase()}`;
}

const cliPathPins = new Map<CliIdentityAnyBridgeId, string>();

function normalizePin(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return v.length > 0 ? v : undefined;
}

/** Set (or, with an empty/undefined value, clear) the in-memory pin for a bridge. */
export function setCliPathPin(id: CliIdentityAnyBridgeId, rawPath: string | undefined | null): void {
  const v = normalizePin(rawPath);
  if (v) cliPathPins.set(id, v);
  else cliPathPins.delete(id);
}

/**
 * The effective pin for a bridge: an explicit per-call override wins,
 * then the in-memory registry, then the mirrored env var.
 */
export function getCliPathPin(
  id: CliIdentityAnyBridgeId,
  opts: { override?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const override = normalizePin(opts.override);
  if (override) return override;
  const registered = cliPathPins.get(id);
  if (registered) return registered;
  const env = opts.env ?? process.env;
  return normalizePin(env[cliPathPinEnvName(id)]);
}

/** All in-memory pins (env-only pins are not listed; the API merges those itself). */
export function getAllCliPathPins(): Partial<Record<CliIdentityAnyBridgeId, string>> {
  return Object.fromEntries(cliPathPins) as Partial<Record<CliIdentityAnyBridgeId, string>>;
}

/** Test helper: drop all in-memory pins. */
export function resetCliPathPins(): void {
  cliPathPins.clear();
}
