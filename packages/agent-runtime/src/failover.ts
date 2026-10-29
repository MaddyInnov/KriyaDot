// SPDX-License-Identifier: Apache-2.0
/**
 * AI failover + limit handling (W1).
 *
 * Original implementation. Three concerns:
 *
 * 1. Error classification — distinguish a hard usage-limit / quota /
 *    rate-limit-EXHAUSTION failure (the provider will keep refusing until
 *    its window resets, so the turn should switch providers) from a
 *    transient 429 (per-minute throttling that the provider drivers already
 *    retry with backoff) and from ordinary errors. Only `limit` failures
 *    trigger failover. Classification reuses the signals the drivers
 *    already produce: HTTP status embedded in the error message, provider
 *    error `code`/`type` strings in the response body, structured fields
 *    drivers attach to thrown errors (status/code/retryAfterMs/resetAt),
 *    and the rate-limit snapshot registry (providers/rate-limit.ts).
 *
 * 2. Near-limit warnings — derived ONLY from data the runtime can actually
 *    observe: rate-limit header snapshots and spend-cap ledger figures the
 *    host passes in. Providers that expose no usage data yield `null`
 *    (no warning) — numbers are never invented.
 *
 * 3. Failover target resolution + limit-reset resume times — pure helpers
 *    the runtime and the API scheduler share.
 */

import { getDefaultModel, getProviderPreset, isFreeModel, listProviderPresets } from './providers/catalog.js';
import { getRateLimit, type RateLimitSnapshot } from './providers/rate-limit.js';
import { freeOnlyActive } from './routing.js';
import type { BotConfig } from './types.js';

export type ProviderErrorKind = 'limit' | 'transient' | 'other';

export interface ClassifiedProviderError {
  kind: ProviderErrorKind;
  /** True only for hard usage-limit / quota exhaustion failures. */
  isLimit: boolean;
  /** True for a 429/throttle that is NOT a hard limit (drivers retry these). */
  isTransientRateLimit: boolean;
  status?: number;
  /** Provider error code/type (e.g. "insufficient_quota"), when present. */
  code?: string;
  /** Provider-advised wait before retrying, in ms, when present. */
  retryAfterMs?: number;
  /** Provider-advised quota/limit reset instant (epoch ms), when present. */
  resetAtMs?: number;
  /** Usage consumed as a percentage (0..100), when the error carries it. */
  usagePercent?: number;
  message: string;
}

/** Hard-limit error codes/types across providers (quota semantics). */
const LIMIT_CODE_RE =
  /insufficient_quota|quota_exceeded|quota_exhausted|usage_limit|rate_limit_exceeded|billing_hard_limit|hard_limit_reached|limit_exceeded|out_of_credits/i;

/** Hard-limit phrasing in provider error messages (quota semantics). */
const LIMIT_TEXT_RE =
  /insufficient_quota|insufficient (?:quota|credits|balance)|quota (?:exceeded|reached|exhausted|limit)|exceeded your (?:current )?quota|usage limit (?:reached|exceeded|hit|is)|hit your usage limit|daily (?:usage )?limit (?:reached|exceeded)|monthly (?:usage )?limit (?:reached|exceeded)|billing (?:hard )?limit|out of credits|plan limit (?:reached|exceeded)/i;

const TRANSIENT_TEXT_RE = /overloaded|temporarily unavailable|service unavailable|try again|too many requests/i;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function numField(rec: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!rec) return undefined;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function strField(rec: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!rec) return undefined;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/** Parse a duration phrase ("90s", "2m", "1.5 min", "retry after 30 seconds") to ms. */
export function parseDurationMs(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0) return undefined;
  const unit = m[2]!;
  if (unit.startsWith('ms') || unit.startsWith('millisecond')) return v;
  if (unit.startsWith('h')) return v * 3_600_000;
  if (unit.startsWith('m')) return v * 60_000;
  return v * 1000; // seconds
}

/** Extract a retry-after wait (ms) from an error message, when phrased there. */
export function parseRetryAfterMsFromMessage(message: string): number | undefined {
  const m = /retry (?:after|in)\s+([0-9][0-9a-z.: ]*)/i.exec(message) ?? /try again in\s+([0-9][0-9a-z.: ]*)/i.exec(message);
  if (!m) return undefined;
  return parseDurationMs(m[1]!);
}

/** Extract an ISO reset timestamp (epoch ms) from an error message, when present. */
export function parseResetAtMsFromMessage(message: string): number | undefined {
  const m = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(message);
  if (!m) return undefined;
  const t = new Date(m[0]).getTime();
  return Number.isFinite(t) ? t : undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as { get?: (n: string) => string | null };
  if (typeof h.get === 'function') {
    try {
      const v = h.get(name);
      return typeof v === 'string' && v !== '' ? v : undefined;
    } catch {
      return undefined;
    }
  }
  const rec = asRecord(headers);
  if (!rec) return undefined;
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === name.toLowerCase() && typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/**
 * Classify a provider failure. Pure and total: any thrown value yields a
 * classification. `limit` requires quota semantics — a bare 429 is
 * transient throttling, NOT a failover trigger.
 */
export function classifyProviderError(err: unknown, opts?: { providerId?: string }): ClassifiedProviderError {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const rec = asRecord(err);
  const inner = asRecord(rec?.error);

  // HTTP status: structured field first, then the drivers' message format
  // ("Provider request failed: 429 …" / "Anthropic request failed: 429 …").
  let status = numField(rec, ['status', 'statusCode', 'httpStatus']) ?? numField(inner, ['status', 'statusCode']);
  if (status === undefined) {
    const m = /request failed: (\d{3})\b/.exec(message) ?? /\bHTTP (\d{3})\b/.exec(message) ?? /^\s*(\d{3})\b/.exec(message);
    if (m) status = Number(m[1]);
  }

  // Provider error code/type: structured fields, then the JSON body the
  // drivers embed after " — " in the message.
  let code =
    strField(rec, ['code', 'type', 'errorCode']) ?? strField(inner, ['code', 'type']);
  if (!code) {
    const cm = /"(?:code|type)"\s*:\s*"([^"]+)"/.exec(message);
    if (cm) code = cm[1];
  }

  // Retry-after / reset: structured fields, headers, message, snapshot.
  let retryAfterMs =
    numField(rec, ['retryAfterMs', 'retry_after_ms']) ??
    (numField(rec, ['retryAfter', 'retry_after']) !== undefined
      ? numField(rec, ['retryAfter', 'retry_after'])! * 1000
      : undefined);
  if (retryAfterMs === undefined) {
    const h = headerValue(rec?.headers, 'retry-after');
    if (h) retryAfterMs = /^\d+(\.\d+)?$/.test(h.trim()) ? Number(h) * 1000 : parseDurationMs(h);
  }
  if (retryAfterMs === undefined) retryAfterMs = parseRetryAfterMsFromMessage(message);

  let resetAtMs: number | undefined;
  const resetRaw = rec?.resetAt ?? rec?.resetAtMs ?? inner?.resetAt;
  if (typeof resetRaw === 'number' && Number.isFinite(resetRaw)) resetAtMs = resetRaw;
  else if (typeof resetRaw === 'string') {
    const t = new Date(resetRaw).getTime();
    if (Number.isFinite(t)) resetAtMs = t;
  }
  if (resetAtMs === undefined) resetAtMs = parseResetAtMsFromMessage(message);
  if (resetAtMs === undefined && opts?.providerId) {
    const snap = getRateLimit(opts.providerId);
    if (snap?.resetAt) {
      const t = new Date(snap.resetAt).getTime();
      if (Number.isFinite(t)) resetAtMs = t;
    }
  }

  // Usage percent: structured fields, message phrasing, snapshot math.
  let usagePercent =
    numField(rec, ['usagePercent', 'usedPercent', 'usage_percent']) ??
    numField(inner, ['usagePercent', 'usedPercent']);
  if (usagePercent === undefined) {
    const um = /(\d+(?:\.\d+)?)\s*%\s*(?:used|of (?:your |the )?(?:quota|limit|usage))/.exec(message) ??
      /(?:used|usage)[^0-9%]{0,24}(\d+(?:\.\d+)?)\s*%/.exec(message);
    if (um) usagePercent = Number(um[1]);
  }
  if (usagePercent === undefined && opts?.providerId) {
    const w = usageWarningFromSnapshot(opts.providerId, getRateLimit(opts.providerId), 0);
    if (w) usagePercent = w.usedPercent;
  }

  const haystack = `${code ?? ''} ${message}`;
  const hasLimitSemantics = LIMIT_CODE_RE.test(haystack) || LIMIT_TEXT_RE.test(message);
  // A structured exhaustion signal: the provider reports zero remaining.
  const remaining = numField(rec, ['remaining', 'remainingRequests', 'remainingTokens']);
  const exhausted = remaining === 0 && (status === 429 || /rate.?limit/i.test(haystack));

  let kind: ProviderErrorKind = 'other';
  if (hasLimitSemantics || exhausted) {
    kind = 'limit';
  } else if (
    status === 429 ||
    status === 408 ||
    status === 503 ||
    /rate.?limit/i.test(haystack) ||
    TRANSIENT_TEXT_RE.test(message)
  ) {
    kind = 'transient';
  }

  return {
    kind,
    isLimit: kind === 'limit',
    isTransientRateLimit: kind === 'transient' && (status === 429 || /rate.?limit/i.test(haystack)),
    status,
    code,
    retryAfterMs,
    resetAtMs,
    usagePercent,
    message,
  };
}

/** Convenience predicate used by the runtime's failover gate. */
export function isLimitError(err: unknown, opts?: { providerId?: string }): boolean {
  return classifyProviderError(err, opts).isLimit;
}

/** Default wait when a limit error carries no reset/retry-after signal. */
export const DEFAULT_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

/**
 * When a limit-blocked turn/routine may resume: the provider's reset time
 * when known, else now + retry-after, else now + the configurable default
 * backoff. Always strictly in the future.
 */
export function computeResumeAtMs(
  classified: Pick<ClassifiedProviderError, 'resetAtMs' | 'retryAfterMs'>,
  opts?: { nowMs?: number; defaultBackoffMs?: number },
): number {
  const now = opts?.nowMs ?? Date.now();
  const fallback = opts?.defaultBackoffMs ?? DEFAULT_LIMIT_BACKOFF_MS;
  if (classified.resetAtMs !== undefined && classified.resetAtMs > now) return classified.resetAtMs;
  if (classified.retryAfterMs !== undefined && classified.retryAfterMs > 0) return now + classified.retryAfterMs;
  return now + Math.max(1000, fallback);
}

// ---- Near-limit warnings ---------------------------------------------------

export interface UsageWarning {
  providerId: string;
  /** Display name (catalog name when known, else the provider id). */
  providerName: string;
  /** Percentage of the observed window consumed (0..100, 1 decimal). */
  usedPercent: number;
  source: 'rate-limit' | 'spend-cap' | 'error';
  /** Human line, e.g. "Claude: 92% used". */
  message: string;
}

/** Warning threshold: at/above this usage percentage the user is warned. */
export const NEAR_LIMIT_WARN_PCT = 80;

function pctFromRemaining(remaining?: number, limit?: number): number | undefined {
  if (remaining === undefined || limit === undefined || limit <= 0) return undefined;
  const used = ((limit - remaining) / limit) * 100;
  return Math.min(100, Math.max(0, used));
}

/**
 * Warning from a rate-limit header snapshot. Returns null when the snapshot
 * carries no usable numbers (provider exposes no usage data) or usage is
 * below the threshold — honest absence, never a fabricated figure.
 * Pass threshold 0 to read the raw usage percentage regardless of level.
 */
export function usageWarningFromSnapshot(
  providerId: string,
  snap: RateLimitSnapshot | null,
  threshold = NEAR_LIMIT_WARN_PCT,
): UsageWarning | null {
  if (!snap) return null;
  const pcts = [
    pctFromRemaining(snap.remainingRequests, snap.limitRequests),
    pctFromRemaining(snap.remainingTokens, snap.limitTokens),
  ].filter((p): p is number => p !== undefined);
  if (pcts.length === 0) return null;
  const used = Math.max(...pcts);
  if (used < threshold) return null;
  const usedPercent = Math.round(used * 10) / 10;
  const name = getProviderPreset(providerId)?.name ?? providerId;
  return {
    providerId,
    providerName: name,
    usedPercent,
    source: 'rate-limit',
    message: `${name}: ${usedPercent}% used`,
  };
}

/** Warning from internal spend figures (usage ledger vs a spend cap). */
export function usageWarningFromSpend(opts: {
  providerId?: string;
  label: string;
  spentCents: number;
  capCents: number | null;
  threshold?: number;
}): UsageWarning | null {
  const threshold = opts.threshold ?? NEAR_LIMIT_WARN_PCT;
  if (opts.capCents === null || opts.capCents <= 0) return null;
  const used = (opts.spentCents / opts.capCents) * 100;
  if (!Number.isFinite(used) || used < threshold) return null;
  const usedPercent = Math.round(Math.min(100, used) * 10) / 10;
  return {
    providerId: opts.providerId ?? 'spend-cap',
    providerName: opts.label,
    usedPercent,
    source: 'spend-cap',
    message: `${opts.label}: ${usedPercent}% used`,
  };
}

/** Current near-limit warning for a provider from its latest snapshot. */
export function currentUsageWarning(providerId: string, threshold?: number): UsageWarning | null {
  return usageWarningFromSnapshot(providerId, getRateLimit(providerId), threshold);
}

// ---- Failover target resolution ---------------------------------------------

export interface FailoverTarget {
  providerId: string;
  modelId: string;
  reason: string;
}

/**
 * Resolve where a limit-blocked turn continues:
 * 1. The bot's configured backup (`backupProvider`/`backupModel`) wins.
 * 2. Otherwise the next eligible catalog provider (catalog order) other
 *    than the failed one, using its default model.
 * The free-only guard is fail-closed in both paths: under
 * FREE_MODELS_ONLY a non-free target is skipped (path 2) or rejected
 * (path 1 — an explicit backup the guard forbids yields no target rather
 * than a silent paid call). Returns null when nothing is eligible.
 */
export function resolveFailoverTarget(input: {
  bot: Pick<BotConfig, 'backupProvider' | 'backupModel' | 'provider' | 'model'>;
  excludeProviderId: string;
  freeOnly?: boolean;
}): FailoverTarget | null {
  const constrained = freeOnlyActive(input.freeOnly);
  const { bot } = input;

  if (bot.backupProvider && bot.backupProvider !== input.excludeProviderId) {
    const modelId = bot.backupModel ?? getDefaultModel(bot.backupProvider) ?? bot.model;
    if (modelId) {
      if (constrained && !isFreeModel(bot.backupProvider, modelId)) return null;
      return {
        providerId: bot.backupProvider,
        modelId,
        reason: `configured backup ${bot.backupProvider}/${modelId}`,
      };
    }
  }

  for (const preset of listProviderPresets()) {
    if (preset.id === input.excludeProviderId) continue;
    if (preset.id === 'demo') continue;
    const modelId = getDefaultModel(preset.id) ?? preset.models[0]?.id;
    if (!modelId) continue;
    if (constrained && !isFreeModel(preset.id, modelId)) continue;
    return {
      providerId: preset.id,
      modelId,
      reason: `next eligible provider ${preset.id}/${modelId}`,
    };
  }
  return null;
}
