// SPDX-License-Identifier: Apache-2.0
/**
 * Cache keep-warm (item 14): for cache-capable providers (Anthropic-style
 * prompt caching), a scheduled minimal request primes the cache so the
 * first real turn is fast/cheap. Harmless no-op for other providers.
 */
import type { LLMProvider } from './types.js';
export function isCacheCapable(providerId: string): boolean { return /anthropic|claude/i.test(providerId); }
export interface CacheWarmSettings { enabled: boolean; intervalMinutes: number; providerId: string; }
export function shouldWarm(now: number, lastWarmedAt: number | null, settings: CacheWarmSettings): boolean {
  if (!settings.enabled) return false;
  if (!isCacheCapable(settings.providerId)) return false;
  if (lastWarmedAt === null) return true;
  return now - lastWarmedAt >= settings.intervalMinutes * 60_000;
}
/** Build the minimal cache-priming request body (Anthropic shape). */
export function buildWarmRequest(input: { model: string; systemPrompt: string }): Record<string, unknown> {
  return {
    model: input.model, max_tokens: 1,
    system: [{ type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'ping' }],
  };
}
export async function warmCache(provider: LLMProvider, input: { model: string; systemPrompt: string }): Promise<{ warmed: boolean; reason?: string; request?: Record<string, unknown> }> {
  if (!isCacheCapable(provider.providerId)) return { warmed: false, reason: 'provider is not cache-capable' };
  const request = buildWarmRequest(input);
  // The generic provider interface cannot carry cache_control blocks, so
  // the warm call is a minimal chat whose system text is the primed
  // prompt; Anthropic-shaped hosts intercept buildWarmRequest. We still
  // exercise the provider so connection + model are warm.
  await provider.chat([{ role:'system', content: input.systemPrompt }, { role:'user', content:'ping' }], [], { model: input.model, maxTokens: 1 });
  return { warmed: true, request };
}
/**
 * Structural per-bot shape for the factory below (Octomind parity #137).
 * Deliberately NOT the BotConfig type from types.ts: the factory only
 * needs these fields, and any object with this shape (a BotConfig
 * included) is accepted. The per-bot opt-in field is:
 *
 *   cacheWarm?: boolean | { intervalMs?: number }
 *
 * - absent / false → no warmer for this bot.
 * - true           → warmer with the default interval (5 minutes).
 * - { intervalMs } → warmer with that interval (clamped to >= 60s).
 */
export interface CacheWarmBotConfigLike {
  provider: string;
  model: string;
  systemPrompt: string;
  cacheWarm?: boolean | { intervalMs?: number };
}

export const DEFAULT_CACHE_WARM_INTERVAL_MS = 5 * 60_000;

/** Normalize a bot's `cacheWarm` field into settings, or null when off. */
export function cacheWarmSettingsForBot(
  botConfig: CacheWarmBotConfigLike,
): CacheWarmSettings | null {
  const cfg = botConfig.cacheWarm;
  if (cfg === undefined || cfg === false) return null;
  if (!isCacheCapable(botConfig.provider)) return null;
  const intervalMs =
    cfg === true || typeof cfg.intervalMs !== 'number' || !Number.isFinite(cfg.intervalMs)
      ? DEFAULT_CACHE_WARM_INTERVAL_MS
      : Math.max(60_000, cfg.intervalMs);
  return { enabled: true, intervalMinutes: intervalMs / 60_000, providerId: botConfig.provider };
}

/**
 * Factory (Octomind parity #137): build a ready-to-start CacheWarmer for
 * one bot from its config, or return null when the bot has not opted in
 * (`cacheWarm` absent/false) or its provider is not cache-capable.
 *
 * PARENT / API-HOST WIRING (this module does not instantiate anything on
 * its own): in apps/api startup (or wherever bots are loaded), for each
 * bot call
 *   const warmer = createCacheWarmerForBot(bot, { provider: () => resolveProvider(bot) });
 *   warmer?.start();
 * and keep the returned instances to `stop()` on shutdown / bot reload.
 * `deps.provider` may be a provider instance or a factory function; the
 * factory form is preferred so a re-resolved provider is picked up.
 */
export function createCacheWarmerForBot(
  botConfig: CacheWarmBotConfigLike,
  deps: {
    provider: LLMProvider | (() => LLMProvider);
    onWarm?: (r: unknown) => void;
  },
): CacheWarmer | null {
  const settings = cacheWarmSettingsForBot(botConfig);
  if (!settings) return null;
  const resolve = typeof deps.provider === 'function'
    ? (deps.provider as () => LLMProvider)
    : () => deps.provider as LLMProvider;
  return new CacheWarmer({
    provider: resolve,
    settings: () => settings,
    model: botConfig.model,
    systemPrompt: botConfig.systemPrompt,
    ...(deps.onWarm ? { onWarm: deps.onWarm } : {}),
  });
}

export class CacheWarmer {
  private timer: ReturnType<typeof setInterval> | null = null; lastWarmedAt: number | null = null;
  constructor(private readonly deps: { provider: () => LLMProvider; settings: () => CacheWarmSettings; model: string; systemPrompt: string; onWarm?: (r: unknown) => void }) {}
  async tick(now = Date.now()): Promise<boolean> {
    const s = this.deps.settings(); if (!shouldWarm(now, this.lastWarmedAt, s)) return false;
    try { const r = await warmCache(this.deps.provider(), { model: this.deps.model, systemPrompt: this.deps.systemPrompt }); if (r.warmed) { this.lastWarmedAt = now; this.deps.onWarm?.(r); return true; } } catch { /* warm is best-effort */ }
    return false;
  }
  start(): void { if (this.timer) return; const mins = Math.max(1, this.deps.settings().intervalMinutes); this.timer = setInterval(()=>{ void this.tick(); }, mins*60_000); if (typeof this.timer==='object' && 'unref' in this.timer) (this.timer as {unref:()=>void}).unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
