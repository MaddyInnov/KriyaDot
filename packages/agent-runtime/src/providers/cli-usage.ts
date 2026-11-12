// SPDX-License-Identifier: Apache-2.0
// Per-account usage gauges for the subscription CLI bridges (Timon parity A1 §1).
//
// Why this module exists
// ----------------------
// A bridge account (a Claude Code / Codex / OpenCode login on this machine)
// burns against the vendor plan's own windows (a rolling multi-hour window
// plus a weekly window), but KriyaDot could not see where an account stood
// until a turn died on the limit. A1 adds a gauge per (bridge, account):
// window utilisation % + reset instant, probed from whatever surface the
// CLI itself exposes, and surfaced in Settings → Providers.
//
// What the CLIs actually expose (investigated 2026-11-12, clean-room —
// behaviour only, no vendor text or code copied):
// - Claude Code: plan usage lives ONLY in the interactive `/usage` TUI
//   screen (aliases `/cost`, `/stats`). There is no documented
//   non-interactive usage subcommand or flag. `claude auth status` prints
//   login JSON ({"loggedIn": …}) with NO usage fields. Driving the TUI
//   screen (or a print-mode slash prompt) from a passive probe would spend
//   a real model turn to read a screen scrape, so it is deliberately NOT
//   a probe surface here. The declared probe is `auth status`: if a future
//   CLI build adds usage fields to that JSON, the parser below picks them
//   up; today the honest gauge is `null` (unknown), never a fabricated 0.
// - Codex: remaining limits live ONLY in the in-session `/status` slash
//   screen (and the web dashboard). `codex login status` — the only
//   standalone status command — prints login/account lines with NO usage
//   percentages. It is the declared probe (future fields parse the same
//   way); today the honest gauge is `null`.
// - OpenCode: no status or usage command exists at all (`opencode models`
//   lists models; auth is `opencode auth …` with no usage output). No
//   probe is declared; the gauge is always `null`.
//
// Honesty rules (hard):
// - A gauge is a number ONLY when a probe output actually carried one.
//   Absence of a surface, an unparseable output, or a failed probe all
//   yield utilisation `null` — the UI renders "usage unknown".
// - Percentages are clamped to 0..100; a "remaining" figure is converted
//   to used (100 − remaining) and labelled by the parse, never guessed.
// - When several windows are reported, the gauge is the MOST utilised
//   window (the binding constraint) with that window's reset instant.
// - Probe results are cached briefly (identity probes already cache per
//   file; spawning a CLI per Providers render would be wasteful).

import { parseDurationMs, parseResetAtMsFromMessage } from '../failover.js';
import {
  resolveVerifiedCliExecutable,
  runCliSync,
  type CliBridgeId,
  type DetectOptions,
} from './cli-bridge.js';

/** The default (only, until A6) account id for a bridge login. */
export const DEFAULT_BRIDGE_ACCOUNT_ID = 'default';

/** One bridge account's usage gauge. `utilisationPercent: null` = unknown. */
export interface BridgeUsageGauge {
  bridgeId: CliBridgeId;
  /** Account dimension (A6-ready): 'default' today, a profile id later. */
  accountId: string;
  /** Window utilisation 0..100, or null when the CLI exposes no figure. */
  utilisationPercent: number | null;
  /** Epoch ms when the binding window resets, when the CLI reported one. */
  resetAtMs: number | null;
  /** Which declared surface produced (or failed to produce) the figure. */
  source: 'cli-status' | 'no-surface' | 'cli-unavailable';
  /** Epoch ms of the probe that produced this gauge. */
  probedAtMs: number;
}

/** Declared probe surface for one bridge (plain data, manifest-friendly). */
export interface CliUsageProbeDeclaration {
  bridgeId: CliBridgeId;
  /** argv for the status probe, or null when the CLI has no status surface. */
  statusArgs: string[] | null;
  /** Plain-words note on what the surface does/doesn't carry (for the A1 log). */
  note: string;
}

export const CLI_USAGE_PROBES: Record<CliBridgeId, CliUsageProbeDeclaration> = {
  claude: {
    bridgeId: 'claude',
    statusArgs: ['auth', 'status'],
    note:
      'claude auth status prints login JSON only — no usage fields today; ' +
      'plan usage exists only in the interactive /usage screen, which a passive probe must not drive.',
  },
  codex: {
    bridgeId: 'codex',
    statusArgs: ['login', 'status'],
    note:
      'codex login status prints login/account lines only — no usage percentages today; ' +
      'remaining limits exist only in the in-session /status screen and the web dashboard.',
  },
  opencode: {
    bridgeId: 'opencode',
    statusArgs: null,
    note: 'OpenCode exposes no status/usage command at all; the gauge is always unknown.',
  },
};

// ---------------------------------------------------------------------------
// Parsing (pure). Every extractor returns undefined when the output carries
// no usable figure — callers turn that into the honest null gauge.
// ---------------------------------------------------------------------------

function clampPct(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n > 100.5) return undefined;
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

/** A percent field may be a 0..1 fraction or a 0..100 percent; >1 means percent. */
function pctField(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return clampPct(v <= 1 ? v * 100 : v);
}

function resetFieldMs(v: unknown, nowMs: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Epoch seconds vs ms heuristic (same rule as bridgeTokenExpiry).
    const ms = v < 1e12 ? v * 1000 : v;
    return ms > 0 ? ms : undefined;
  }
  if (typeof v === 'string' && v.trim()) {
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) return t;
    const dur = parseDurationMs(v);
    if (dur !== undefined) return nowMs + dur;
  }
  return undefined;
}

const USED_KEYS = ['utilisation', 'utilization', 'usagepercent', 'usedpercent', 'percentused', 'usage_percent', 'used_percent'];
const REMAINING_KEYS = ['remainingpercent', 'percentremaining', 'remaining_percent'];
const RESET_KEYS = ['resetsat', 'resetat', 'resets_at', 'reset_at', 'reset', 'resettime'];

function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

interface WindowFigure {
  usedPercent: number;
  resetAtMs?: number;
}

/** Extract window figures from one JSON object (shallow + one level of window objects). */
function figuresFromObject(obj: Record<string, unknown>, nowMs: number): WindowFigure[] {
  const out: WindowFigure[] = [];
  let used: number | undefined;
  let reset: number | undefined;
  for (const [k, v] of Object.entries(obj)) {
    const nk = normKey(k);
    if (USED_KEYS.includes(nk)) used = pctField(v) ?? used;
    else if (REMAINING_KEYS.includes(nk)) {
      const r = pctField(v);
      if (r !== undefined) used = clampPct(100 - r) ?? used;
    } else if (RESET_KEYS.includes(nk)) reset = resetFieldMs(v, nowMs) ?? reset;
    else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      // A named window object (five_hour / seven_day / primary / secondary…).
      out.push(...figuresFromObject(v as Record<string, unknown>, nowMs));
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'object' && item !== null) {
          out.push(...figuresFromObject(item as Record<string, unknown>, nowMs));
        }
      }
    }
  }
  if (used !== undefined) out.push({ usedPercent: used, ...(reset !== undefined ? { resetAtMs: reset } : {}) });
  return out;
}

/** Parse a reset instant from free text: ISO timestamp, or "resets in 2h 30m". */
export function parseUsageResetMsFromText(text: string, nowMs: number): number | undefined {
  const iso = parseResetAtMsFromMessage(text);
  if (iso !== undefined) return iso;
  const m = /reset[s]?\s+(?:at|in)\s+([0-9][0-9a-z.: ]*)/i.exec(text) ?? /try again in\s+([0-9][0-9a-z.: ]*)/i.exec(text);
  if (!m) return undefined;
  // Sum multi-unit durations ("1h 10m", "12h29m") token by token.
  const tokens = m[1]!.match(/\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/g) ?? [];
  let total = 0;
  let any = false;
  for (const t of tokens) {
    const d = parseDurationMs(t);
    if (d !== undefined) {
      total += d;
      any = true;
    }
  }
  return any ? nowMs + total : undefined;
}

/** Parse usage figures from free-text status output ("59% used, resets Sun 03:00"). */
export function parseUsageFromText(text: string, nowMs: number): WindowFigure | undefined {
  // Collect every window figure in the text; the gauge is the MOST
  // utilised window (the binding constraint), as with the JSON path.
  const figures: number[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:used|of\s+(?:your\s+|the\s+)?(?:limit|quota|allowance|usage))/g)) {
    const v = clampPct(Number(m[1]));
    if (v !== undefined) figures.push(v);
  }
  if (figures.length === 0) {
    for (const m of text.matchAll(/(?:usage|limit|quota|allowance)[^%\n]{0,40}?(\d+(?:\.\d+)?)\s*%/g)) {
      const v = clampPct(Number(m[1]));
      if (v !== undefined) figures.push(v);
    }
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:remaining|left)/g)) {
    const r = clampPct(Number(m[1]));
    if (r !== undefined) {
      const used = clampPct(100 - r);
      if (used !== undefined) figures.push(used);
    }
  }
  if (figures.length === 0) return undefined;
  const used = Math.max(...figures);
  const resetAtMs = parseUsageResetMsFromText(text, nowMs);
  return { usedPercent: used, ...(resetAtMs !== undefined ? { resetAtMs } : {}) };
}

/**
 * Parse any CLI status/usage output into the binding window figure.
 * JSON (whole output or the first embedded object) wins; free text is the
 * fallback. Returns undefined when the output carries NO usage figure —
 * the caller must surface that as an unknown gauge, never as 0%.
 */
export function parseCliUsageOutput(output: string, nowMs: number = Date.now()): WindowFigure | undefined {
  const text = (output ?? '').slice(0, 16_384);
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        parsed = undefined;
      }
    }
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const figures = figuresFromObject(parsed as Record<string, unknown>, nowMs);
    if (figures.length > 0) {
      figures.sort((a, b) => b.usedPercent - a.usedPercent);
      return figures[0];
    }
    // Parsed JSON with no usage fields (today's `claude auth status`):
    // fall through to text — a stray "%" in an email must not invent one,
    // and the text patterns require usage wording, so this stays honest.
  }
  return parseUsageFromText(text, nowMs);
}

// ---------------------------------------------------------------------------
// Probing. Spawns the identity-verified CLI's declared status surface via
// runCliSync; injectable for tests (fake CLI shims / stub runners).
// ---------------------------------------------------------------------------

export type UsageRunFn = (
  executablePath: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; timeoutMs?: number },
) => { code: number | null; output: string };

export interface ProbeBridgeUsageOptions {
  accountId?: string;
  detect?: DetectOptions;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  nowMs?: number;
  /** Test seam: replace the sync CLI runner. */
  runFn?: UsageRunFn;
  /** Test seam: replace identity-verified resolution (returns a path). */
  resolveFn?: (id: CliBridgeId) => string | undefined;
  /** Bypass the probe cache (manual re-check). */
  fresh?: boolean;
}

const gaugeCache = new Map<string, { at: number; gauge: BridgeUsageGauge }>();
const GAUGE_TTL_MS = 60_000;
const GAUGE_UNKNOWN_TTL_MS = 15_000;

/** Test/UI helper: drop cached gauges (e.g. after a manual re-check). */
export function resetBridgeUsageCache(): void {
  gaugeCache.clear();
}

/**
 * Probe one bridge account's usage gauge. Never throws and never invents
 * a figure: no declared surface → `no-surface`; CLI missing/unverified →
 * `cli-unavailable`; surface ran but carried no usage figure → `cli-status`
 * with a null utilisation.
 */
export function probeBridgeUsage(id: CliBridgeId, opts: ProbeBridgeUsageOptions = {}): BridgeUsageGauge {
  const accountId = opts.accountId ?? DEFAULT_BRIDGE_ACCOUNT_ID;
  const nowMs = opts.nowMs ?? Date.now();
  const decl = CLI_USAGE_PROBES[id];
  if (!decl.statusArgs) {
    return { bridgeId: id, accountId, utilisationPercent: null, resetAtMs: null, source: 'no-surface', probedAtMs: nowMs };
  }
  const resolveFn = opts.resolveFn ?? ((bid: CliBridgeId) => resolveVerifiedCliExecutable(bid, opts.detect ?? {}).path);
  const resolvedPath = resolveFn(id);
  const cacheKey = `${id}:${accountId}:${resolvedPath ?? 'none'}`;
  const cached = gaugeCache.get(cacheKey);
  if (!opts.fresh && cached) {
    const ttl = cached.gauge.utilisationPercent !== null ? GAUGE_TTL_MS : GAUGE_UNKNOWN_TTL_MS;
    if (nowMs - cached.at < ttl) return cached.gauge;
  }
  let gauge: BridgeUsageGauge;
  if (!resolvedPath) {
    gauge = { bridgeId: id, accountId, utilisationPercent: null, resetAtMs: null, source: 'cli-unavailable', probedAtMs: nowMs };
  } else {
    const runFn = opts.runFn ?? runCliSync;
    let output = '';
    try {
      output = runFn(resolvedPath, decl.statusArgs, { platform: opts.platform, timeoutMs: opts.timeoutMs ?? 5000 }).output;
    } catch {
      output = '';
    }
    const figure = parseCliUsageOutput(output, nowMs);
    gauge = {
      bridgeId: id,
      accountId,
      utilisationPercent: figure ? figure.usedPercent : null,
      resetAtMs: figure?.resetAtMs ?? null,
      source: 'cli-status',
      probedAtMs: nowMs,
    };
  }
  gaugeCache.set(cacheKey, { at: nowMs, gauge });
  return gauge;
}

/** Gauges for several accounts of one bridge (A6-ready account dimension). */
export function probeBridgeUsageForAccounts(
  id: CliBridgeId,
  accountIds: string[],
  opts: ProbeBridgeUsageOptions = {},
): BridgeUsageGauge[] {
  const ids = accountIds.length > 0 ? accountIds : [DEFAULT_BRIDGE_ACCOUNT_ID];
  return ids.map((accountId) => probeBridgeUsage(id, { ...opts, accountId }));
}

/** One-line UI label: "82% used · resets 14:00" or exactly "usage unknown". */
export function formatBridgeUsage(gauge: BridgeUsageGauge): string {
  if (gauge.utilisationPercent === null) return 'usage unknown';
  const base = `${gauge.utilisationPercent}% used`;
  if (gauge.resetAtMs === null) return base;
  return `${base} · resets ${new Date(gauge.resetAtMs).toISOString()}`;
}
