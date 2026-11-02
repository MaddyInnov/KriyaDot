// SPDX-License-Identifier: Apache-2.0
// OH-5: automatic model routing — the per-bot model sentinel 'auto'.
//
// A bot whose persisted model selection is exactly 'auto' (PUT
// /api/bots/:id/model accepts arbitrary model strings, so 'auto' rides
// the existing bot-models.json overlay unchanged) gets its turn model
// resolved PER TURN by the deterministic rules below. Explicit user
// picks (any non-'auto' model) are never overridden, and a per-turn
// explicit override (next-turn-only model) still wins over auto — the
// chat route only consults this module when no explicit turn model was
// supplied.
//
// Rules (deterministic; no LLM, no network):
//   candidates  — models of CONFIGURED providers only (providers.ts
//                 isProviderConfigured over the shipped catalog; local
//                 and keyless lanes count as configured by definition).
//                 Unconfigured providers are never chosen.
//   strong lane — the message carries a code fence, is longer than
//                 8000 chars, or the turn has tools: prefer the
//                 configured model with the largest catalog context
//                 length (filtered to models whose context fits the
//                 estimated need when any fit), so long/code/tool
//                 turns land on a model that can actually hold them.
//   cheap lane  — short, simple messages: prefer free / keyless / local
//                 models first, then the smallest context (the fastest
//                 lane), so trivial turns stay on the zero-cost stack.
//   fallback    — nothing else configured (or no candidates at all):
//                 the bot's own provider default model.
// Ties break by catalog provider order, then model id ascending — the
// same inputs always choose the same model.
//
// Every auto decision is recorded through the unified invocation
// decision log (kind 'routing', the same log universal.ts routing
// decisions land in) with metadata { via: 'auto', chosen, reason },
// and surfaced on the turn as modelRoute { chosen, reason }.

import {
  InvocationDecisionLog,
  getDefaultModel,
  getProviderPreset,
  isFreeModel,
  listProviderPresets,
  type BotConfig,
  type ModelInfo,
} from '@mvp/agent-runtime';
import { isProviderConfigured } from './providers.js';

export const AUTO_MODEL_SENTINEL = 'auto';
/** Messages longer than this take the strong lane. */
export const AUTO_STRONG_MIN_CHARS = 8000;

export interface AutoModelCatalogEntry {
  providerId: string;
  configured: boolean;
  keyless?: boolean;
  local?: boolean;
  models: ModelInfo[];
}

export interface AutoModelDecision {
  providerId: string;
  model: string;
  /** '<providerId>/<model>' — the decision-log / response-meta form. */
  chosen: string;
  reason: string;
  tier: 'strong' | 'cheap' | 'default';
}

/** The default catalog: shipped presets + live configured checks (sync, catalog models only). */
export function buildAutoModelCatalog(): AutoModelCatalogEntry[] {
  return listProviderPresets().map((preset) => ({
    providerId: preset.id,
    configured: isProviderConfigured(preset.id),
    keyless: preset.keyless === true,
    local: preset.local === true,
    models: (preset.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
      free: isFreeModel(preset.id, m.id),
    })),
  }));
}

interface FlatCandidate {
  providerId: string;
  modelId: string;
  contextLength: number;
  free: boolean;
  zeroCost: boolean;
  providerOrder: number;
}

function flatten(catalog: AutoModelCatalogEntry[]): FlatCandidate[] {
  const out: FlatCandidate[] = [];
  catalog.forEach((entry, providerOrder) => {
    if (!entry.configured) return;
    for (const m of entry.models) {
      out.push({
        providerId: entry.providerId,
        modelId: m.id,
        contextLength: typeof m.contextLength === 'number' && m.contextLength > 0 ? m.contextLength : 0,
        free: m.free === true,
        zeroCost: m.free === true || entry.keyless === true || entry.local === true,
        providerOrder,
      });
    }
  });
  return out;
}

function byIdAsc(a: FlatCandidate, b: FlatCandidate): number {
  return a.providerOrder - b.providerOrder || (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0);
}

export function isStrongMessage(messageText: string, hasTools: boolean): boolean {
  return hasTools || messageText.length > AUTO_STRONG_MIN_CHARS || /```/.test(messageText);
}

/**
 * Resolve the turn model for a bot whose model is 'auto'. Pure given a
 * catalog; the default catalog is built from live configuration.
 */
export function resolveAutoModel(
  bot: Pick<BotConfig, 'id' | 'provider' | 'model'>,
  messageText: string,
  opts: { hasTools?: boolean; catalog?: AutoModelCatalogEntry[] } = {},
): AutoModelDecision {
  const catalog = opts.catalog ?? buildAutoModelCatalog();
  const candidates = flatten(catalog);
  const botProvider = bot.provider ?? 'groq';

  if (candidates.length === 0) {
    const model = bot.model && bot.model !== AUTO_MODEL_SENTINEL ? bot.model : (getDefaultModel(botProvider) ?? bot.model ?? AUTO_MODEL_SENTINEL);
    return {
      providerId: botProvider,
      model,
      chosen: `${botProvider}/${model}`,
      reason: 'auto: no configured provider models available — fell back to the bot provider default',
      tier: 'default',
    };
  }

  const strong = isStrongMessage(messageText ?? '', opts.hasTools === true);
  if (strong) {
    // Estimated need: message tokens (~chars/4) + headroom for the reply/tools.
    const needTokens = Math.ceil((messageText?.length ?? 0) / 4) + 8192;
    const fitting = candidates.filter((c) => c.contextLength >= needTokens);
    const pool = fitting.length > 0 ? fitting : candidates;
    const pick = [...pool].sort((a, b) => b.contextLength - a.contextLength || byIdAsc(a, b))[0]!;
    const why = opts.hasTools
      ? 'turn uses tools'
      : messageText.length > AUTO_STRONG_MIN_CHARS
        ? `long message (${messageText.length} chars)`
        : 'message contains code';
    return {
      providerId: pick.providerId,
      model: pick.modelId,
      chosen: `${pick.providerId}/${pick.modelId}`,
      reason: `auto: ${why} — strongest configured model (context ${pick.contextLength || 'unknown'})`,
      tier: 'strong',
    };
  }

  // Cheap lane: zero-cost lanes first, then smallest context (fastest).
  const pick = [...candidates].sort(
    (a, b) =>
      Number(b.zeroCost) - Number(a.zeroCost) ||
      (a.contextLength || Number.MAX_SAFE_INTEGER) - (b.contextLength || Number.MAX_SAFE_INTEGER) ||
      byIdAsc(a, b),
  )[0]!;
  return {
    providerId: pick.providerId,
    model: pick.modelId,
    chosen: `${pick.providerId}/${pick.modelId}`,
    reason: pick.zeroCost
      ? 'auto: short simple message — cheapest configured lane (free/keyless/local first)'
      : 'auto: short simple message — smallest configured model',
    tier: 'cheap',
  };
}

/** The bot-provider default fallback (used when the bot provider itself is the only configured lane). */
export function botDefaultDecision(bot: Pick<BotConfig, 'provider' | 'model'>): AutoModelDecision {
  const providerId = bot.provider ?? 'groq';
  const model = bot.model && bot.model !== AUTO_MODEL_SENTINEL ? bot.model : (getDefaultModel(providerId) ?? bot.model ?? AUTO_MODEL_SENTINEL);
  return {
    providerId,
    model,
    chosen: `${providerId}/${model}`,
    reason: 'auto: fell back to the bot provider default',
    tier: 'default',
  };
}

/**
 * Record an auto-model decision in the unified invocation decision log
 * (kind 'routing' — the same mechanism universal.ts routing uses).
 * Best-effort: recording must never break a turn.
 */
export function recordAutoModelDecision(
  dataDir: string,
  botId: string,
  decision: AutoModelDecision,
): void {
  try {
    new InvocationDecisionLog(dataDir).record({
      kind: 'routing',
      subject: decision.chosen,
      outcome: 'routed',
      confidence: 1,
      rationale: decision.reason,
      botId,
      actor: 'auto-model',
      metadata: { via: 'auto', chosen: decision.chosen, reason: decision.reason, tier: decision.tier },
    });
  } catch {
    // Decision logging is best-effort by design.
  }
}

/** True when a preset exists for the provider (catalog sanity for tests/hosts). */
export function providerKnown(providerId: string): boolean {
  return getProviderPreset(providerId) !== undefined;
}
