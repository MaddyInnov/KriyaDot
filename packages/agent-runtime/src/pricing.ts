// SPDX-License-Identifier: Apache-2.0
//
// Cost-in-dollars estimates for model usage.
//
// PRICES ARE ESTIMATES FROM PUBLIC DATA — NOT LIVE BILLING. The numbers
// below are compiled from providers' published list-price pages (October
// 2026). Actual invoices may differ (volume discounts, prompt caching,
// batch tiers, regional pricing, price changes). Every entry carries
// `estimate: true` to say so in code; the UI surfaces the same caveat in
// tooltips. Free-tier models resolve to $0 via the catalog's `free` flag
// (consulted first), not via this table.
//
// Key format: "providerId/modelId" (e.g. "openai/gpt-4o"). A bare modelId
// (e.g. "gpt-4o") falls back to the first entry whose key ends with
// "/<modelId>". OpenRouter-style nested ids ("anthropic/claude-sonnet-4-5")
// are keyed as "openrouter/anthropic/claude-sonnet-4-5".

import type { TokenUsage } from './types.js';
import { cacheTokensOf, type CacheAwareTokenUsage } from './usage.js';
import { isFreeModel } from './providers/catalog.js';

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1M: number;
  /**
   * USD per 1M prompt-cache READ tokens (Octomind parity #137).
   * Absent → cache reads are billed at the base input rate
   * ({@link cacheRatesFor} applies that default).
   */
  cacheReadPer1M?: number;
  /**
   * USD per 1M prompt-cache WRITE (creation) tokens (#137).
   * Absent → cache writes are billed at the base input rate.
   */
  cacheWritePer1M?: number;
  /** True when the price is a public-list-price estimate (see header). */
  estimate: boolean;
}

/** Resolved cache rates for a price: known rates win, else base input. */
export function cacheRatesFor(price: ModelPrice): { cacheReadPer1M: number; cacheWritePer1M: number } {
  return {
    cacheReadPer1M: price.cacheReadPer1M ?? price.inputPer1M,
    cacheWritePer1M: price.cacheWritePer1M ?? price.inputPer1M,
  };
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // --- Groq (list prices, Oct 2026) ---
  'groq/gpt-oss-20b': { inputPer1M: 0.1, outputPer1M: 0.5, estimate: true },
  'groq/gpt-oss-120b': { inputPer1M: 0.15, outputPer1M: 0.75, estimate: true },
  // Groq Compound: agentic system around gpt-oss-120b / gpt-oss-20b class
  // base models. Token rates below are base-model estimates; Compound bills
  // its built-in tools separately (e.g. search calls, code-execution time),
  // so treat these as lower bounds.
  'groq/groq/compound': { inputPer1M: 0.15, outputPer1M: 0.6, estimate: true },
  'groq/groq/compound-mini': { inputPer1M: 0.1, outputPer1M: 0.5, estimate: true },
  // --- OpenAI (list prices, Oct 2026) ---
  // Prompt-cache reads bill at half the input rate; writes carry no
  // separate published rate, so they default to the base input rate.
  'openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0, cacheReadPer1M: 1.25, estimate: true },
  'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075, estimate: true },
  // --- Anthropic (list prices, Oct 2026) ---
  // Prompt caching: reads 0.1x base input, writes 1.25x base input.
  'anthropic/claude-3-5-sonnet-latest': {
    inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, estimate: true,
  },
  'anthropic/claude-3-5-haiku-latest': {
    inputPer1M: 0.8, outputPer1M: 4.0, cacheReadPer1M: 0.08, cacheWritePer1M: 1.0, estimate: true,
  },
  // --- OpenRouter: popular models (OpenRouter list prices, Oct 2026) ---
  'openrouter/anthropic/claude-sonnet-4-5': {
    inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, estimate: true,
  },
  'openrouter/openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0, estimate: true },
  // --- DeepSeek direct (list prices, Oct 2026) ---
  // Context-cache hits bill at 0.1x the cache-miss input rate.
  'deepseek/deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1, cacheReadPer1M: 0.027, estimate: true },
  'deepseek/deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19, cacheReadPer1M: 0.055, estimate: true },
  'openrouter/deepseek/deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1, estimate: true },
  'openrouter/deepseek/deepseek-r1': { inputPer1M: 0.55, outputPer1M: 2.19, estimate: true },
  'openrouter/google/gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, estimate: true },
  'openrouter/meta-llama/llama-3.3-70b-instruct': { inputPer1M: 0.12, outputPer1M: 0.18, estimate: true },
  'openrouter/moonshotai/kimi-k2': { inputPer1M: 1.0, outputPer1M: 3.0, estimate: true },
  'openrouter/qwen/qwen3-235b-a22b': { inputPer1M: 0.2, outputPer1M: 0.6, estimate: true },
  // --- Subscription/CLI bridges: marginal $0 under the user's own
  // subscription (no per-token billing); estimate:true because the billing
  // model is "your subscription", not a token price.
  'claude-subscription/claude-sonnet-4-5': { inputPer1M: 0, outputPer1M: 0, estimate: true },
  'claude-subscription/claude-haiku-4-5': { inputPer1M: 0, outputPer1M: 0, estimate: true },
  'codex-subscription/gpt-5': { inputPer1M: 0, outputPer1M: 0, estimate: true },
  'codex-subscription/gpt-5-mini': { inputPer1M: 0, outputPer1M: 0, estimate: true },
};

const ZERO_PRICE: ModelPrice = { inputPer1M: 0, outputPer1M: 0, estimate: false };

/**
 * Price for a model. Free-tier models (catalog `free: true`, OpenRouter
 * `:free` suffix, Zen `-free` suffix) resolve to $0 with estimate:false —
 * the catalog flag wins over this table. Returns undefined when the model
 * has no price entry and is not free.
 */
export function priceOfModel(providerId: string, modelId: string): ModelPrice | undefined {
  if (isFreeModel(providerId, modelId)) return ZERO_PRICE;
  const exact = MODEL_PRICES[`${providerId}/${modelId}`];
  if (exact) return exact;
  // Bare modelId fallback: first entry ending in "/<modelId>".
  const suffix = `/${modelId}`;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (key.endsWith(suffix)) return MODEL_PRICES[key];
  }
  return undefined;
}

export interface UsageCost {
  /** USD for prompt tokens. */
  input: number;
  /** USD for completion tokens. */
  output: number;
  /**
   * USD for prompt-cache READ tokens (#137). Only present when the
   * usage record actually reported cache tokens, so cache-free callers
   * see exactly the pre-#137 shape.
   */
  cacheRead?: number;
  /** USD for prompt-cache WRITE tokens (#137). Same presence rule. */
  cacheWrite?: number;
  /** input + output (+ cache buckets when reported), in USD. */
  total: number;
  /**
   * True when the number is a public-list-price estimate OR the price is
   * unknown (unknown prices cost as $0 with estimated:true — the UI must
   * not present them as exact).
   */
  estimated: boolean;
}

/**
 * Dollar cost of a token usage record. Free models → $0 (estimated:false).
 * Unknown prices → $0 with estimated:true (honest "we don't know", not a
 * claim of free).
 */
export function costOfUsage(
  providerId: string,
  modelId: string,
  usage: TokenUsage,
): UsageCost {
  const price = priceOfModel(providerId, modelId);
  if (!price) return { input: 0, output: 0, total: 0, estimated: true };
  const input = (usage.promptTokens / 1_000_000) * price.inputPer1M;
  const output = (usage.completionTokens / 1_000_000) * price.outputPer1M;
  // Cache buckets (#137): reported as separate buckets alongside
  // promptTokens (see CacheAwareTokenUsage in usage.ts), priced at the
  // model's cache rates, defaulting to the base input rate when the
  // catalog entry carries no cache rates.
  const cache = cacheTokensOf(usage as CacheAwareTokenUsage);
  if (cache.cacheReadTokens === 0 && cache.cacheWriteTokens === 0) {
    return { input, output, total: input + output, estimated: price.estimate };
  }
  const rates = cacheRatesFor(price);
  const cacheRead = (cache.cacheReadTokens / 1_000_000) * rates.cacheReadPer1M;
  const cacheWrite = (cache.cacheWriteTokens / 1_000_000) * rates.cacheWritePer1M;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    estimated: price.estimate,
  };
}
