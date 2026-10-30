// SPDX-License-Identifier: Apache-2.0
// Pure helpers for presenting token usage and context-window consumption.
// The web app mirrors these in apps/web/lib/usage.ts so both surfaces agree.

import type { TokenUsage } from './types.js';

/**
 * Token usage with prompt-cache accounting (Octomind parity #137).
 *
 * `cacheReadTokens` / `cacheWriteTokens` are reported by cache-capable
 * providers as SEPARATE buckets alongside prompt/completion tokens
 * (Anthropic-style: `cache_read_input_tokens` /
 * `cache_creation_input_tokens`). Drivers must NOT also fold them into
 * `promptTokens`, or pricing would double-count them. Both fields are
 * optional so every existing TokenUsage producer stays valid; absent
 * means "the provider reported no cache tokens" (treated as 0).
 *
 * NOTE: this extended shape lives here, not on the core TokenUsage type
 * in types.ts, so producers opt in by returning this type.
 */
export interface CacheAwareTokenUsage extends TokenUsage {
  /** Prompt tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Prompt tokens written into the provider's prompt cache. */
  cacheWriteTokens?: number;
}

/** Normalized cache buckets for a usage record (absent → 0). */
export function cacheTokensOf(usage: TokenUsage): { cacheReadTokens: number; cacheWriteTokens: number } {
  const u = usage as CacheAwareTokenUsage;
  return {
    cacheReadTokens: Math.max(0, u.cacheReadTokens ?? 0),
    cacheWriteTokens: Math.max(0, u.cacheWriteTokens ?? 0),
  };
}

/** A zeroed cache-aware usage record. */
export function emptyCacheUsage(): CacheAwareTokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Sum two usage records including the cache buckets. The result always
 * carries explicit cache fields (0 when neither side reported any), so
 * aggregated/session-level usage can be priced cache-aware.
 */
export function addCacheUsage(a: TokenUsage, b: TokenUsage): CacheAwareTokenUsage {
  const ca = cacheTokensOf(a);
  const cb = cacheTokensOf(b);
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: ca.cacheReadTokens + cb.cacheReadTokens,
    cacheWriteTokens: ca.cacheWriteTokens + cb.cacheWriteTokens,
  };
}

/** Fold a list of usage records into one cache-aware total. */
export function sumCacheUsage(usages: TokenUsage[]): CacheAwareTokenUsage {
  return usages.reduce<CacheAwareTokenUsage>((acc, u) => addCacheUsage(acc, u), emptyCacheUsage());
}

/** Compact token count: 999 → "999", 1240 → "1.2k", 2_400_000 → "2.4M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
}

export interface ContextMeter {
  /** Tokens consumed (per turn or per session). */
  used: number;
  /** Model context window in tokens. */
  limit: number;
  /** used / limit * 100. */
  pct: number;
  /** True once pct >= 80 — the UI should warn the user. */
  warn: boolean;
}

export const CONTEXT_WARN_PCT = 80;

/**
 * Context-window consumption for a turn or a session. Returns null when the
 * model's context length is unknown (no meter can be drawn honestly).
 */
export function contextMeter(usedTokens: number, contextLength?: number): ContextMeter | null {
  if (contextLength === undefined || contextLength <= 0 || !Number.isFinite(usedTokens) || usedTokens < 0) {
    return null;
  }
  const pct = (usedTokens / contextLength) * 100;
  return { used: usedTokens, limit: contextLength, pct, warn: pct >= CONTEXT_WARN_PCT };
}
