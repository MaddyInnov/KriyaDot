// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic discovery (Octomind parity).
 *
 * Bots, skills and MCP bundles used to be found by name or by asking an
 * LLM. This module adds the embedding path: rank discoverable items by
 * cosine similarity between the intent text and each item's
 * name+description embedding, deterministically (score desc, id asc as
 * the tie-break — same inputs, same order, every time).
 *
 * On top of ranking sits the DETERMINISTIC auto-activation policy (no
 * LLM in the loop): candidates must clear a score threshold, and the
 * last activated candidate must lead the first non-activated one by a
 * margin — a tie at the activation boundary abstains entirely rather
 * than guessing. Thresholds are caller-tunable because cosine scales
 * differ between embedders (neural models cluster higher than the
 * trigram hash fallback).
 */

import { cosineSimilarity, type SyncEmbedder } from './hybrid-search.js';
import { embeddingCacheKey } from './embeddings.js';

export type DiscoverableKind = 'bot' | 'skill' | 'mcp' | 'capability';

export interface DiscoverableItem {
  kind: DiscoverableKind;
  id: string;
  name: string;
  description: string;
}

export interface DiscoveryHit {
  item: DiscoverableItem;
  score: number;
}

const itemVectorCache = new Map<string, Float32Array>();
const MAX_CACHE_ENTRIES = 2_000;

function itemText(item: DiscoverableItem): string {
  return `${item.name}: ${item.description}`;
}

async function embedAll(
  embedder: SyncEmbedder,
  texts: string[],
): Promise<Float32Array[]> {
  return await embedder.embed(texts);
}

/**
 * Rank items by semantic similarity to `intent`. Item embeddings are
 * cached per (embedder, text) — item catalogs change rarely, intents
 * are embedded fresh each call.
 */
export async function discoverByIntent(
  intent: string,
  items: DiscoverableItem[],
  embedder: SyncEmbedder,
  opts: { topK?: number; minScore?: number } = {},
): Promise<DiscoveryHit[]> {
  if (!intent.trim() || items.length === 0) return [];
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? -1;

  const missing: Array<{ index: number; text: string }> = [];
  const vectors: Array<Float32Array | undefined> = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const key = embeddingCacheKey(embedder.name, itemText(items[i]!));
    const hit = itemVectorCache.get(key);
    if (hit) vectors[i] = hit;
    else missing.push({ index: i, text: itemText(items[i]!) });
  }
  if (missing.length > 0) {
    const embedded = await embedAll(embedder, missing.map((m) => m.text));
    for (let j = 0; j < missing.length; j++) {
      const v = embedded[j];
      if (!v) continue;
      vectors[missing[j]!.index] = v;
      if (itemVectorCache.size >= MAX_CACHE_ENTRIES) itemVectorCache.clear();
      itemVectorCache.set(embeddingCacheKey(embedder.name, missing[j]!.text), v);
    }
  }
  const [intentVector] = await embedAll(embedder, [intent]);
  if (!intentVector) return [];

  const hits: DiscoveryHit[] = [];
  for (let i = 0; i < items.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    const score = cosineSimilarity(intentVector, v);
    if (score >= minScore) hits.push({ item: items[i]!, score });
  }
  hits.sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return hits.slice(0, topK);
}

export interface ActivationDecision {
  activate: DiscoveryHit[];
  abstained: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Invocation-decision sink (routing-decisions.ts invocation model)
// ---------------------------------------------------------------------------
//
// decideAutoActivation() is the exact function the runtime calls for
// skill activation. Hosts may register ONE sink here (the invocation
// decision log's createInvocationSink) and every activation decision —
// including the runtime's — is recorded, with no runtime changes. The
// sink is notified after the decision is computed; a throwing sink can
// never change or break the decision.

export type DiscoveryDecisionSink = (decision: ActivationDecision, hits: DiscoveryHit[]) => void;

let discoveryDecisionSink: DiscoveryDecisionSink | undefined;

/** Register (or clear, with undefined) the activation-decision sink. */
export function registerDiscoveryDecisionSink(sink: DiscoveryDecisionSink | undefined): void {
  discoveryDecisionSink = sink;
}

function notifyDiscoveryDecision(decision: ActivationDecision, hits: DiscoveryHit[]): ActivationDecision {
  if (discoveryDecisionSink) {
    try {
      discoveryDecisionSink(decision, hits);
    } catch {
      // Recording must never break discovery.
    }
  }
  return decision;
}

/**
 * Deterministic auto-activation policy (see header). Pure function.
 *
 * Defaults are tuned for neural embedders; trigram-hash cosines run
 * lower and noisier — callers on the fallback should pass a lower
 * threshold and a wider margin.
 */
export function decideAutoActivation(
  hits: DiscoveryHit[],
  opts: { threshold?: number; margin?: number; maxActivate?: number } = {},
): ActivationDecision {
  const threshold = opts.threshold ?? 0.32;
  const margin = opts.margin ?? 0.04;
  const maxActivate = opts.maxActivate ?? 3;
  const eligible = hits.filter((h) => h.score >= threshold);
  if (eligible.length === 0) {
    return notifyDiscoveryDecision({ activate: [], abstained: true, reason: 'no candidate above the activation threshold' }, hits);
  }
  const chosen = eligible.slice(0, maxActivate);
  const boundary = eligible[maxActivate];
  if (boundary && chosen[chosen.length - 1]!.score - boundary.score < margin) {
    return notifyDiscoveryDecision({
      activate: [],
      abstained: true,
      reason: `tie at the activation boundary (${chosen[chosen.length - 1]!.item.id} vs ${boundary.item.id}) — abstaining`,
    }, hits);
  }
  if (chosen.length === 1 && eligible.length > 1 && chosen[0]!.score - eligible[1]!.score < margin) {
    return notifyDiscoveryDecision({
      activate: [],
      abstained: true,
      reason: `top candidates too close (${chosen[0]!.item.id} vs ${eligible[1]!.item.id}) — abstaining`,
    }, hits);
  }
  return notifyDiscoveryDecision({
    activate: chosen,
    abstained: false,
    reason: `activated ${chosen.map((c) => c.item.id).join(', ')} (top score ${chosen[0]!.score.toFixed(3)})`,
  }, hits);
}

/** Test hook: clear the item-vector cache. */
export function clearDiscoveryCache(): void {
  itemVectorCache.clear();
}

// ---------------------------------------------------------------------------
// Closure build (2026-10-30): bot/role discovery (#15) + MCP auto-activation
// (#139) + a discover_specialists tool surface.
// ---------------------------------------------------------------------------

import type { ToolDefinition } from './types.js';

export interface RankableBot {
  id: string;
  name: string;
  description?: string;
}

/** Rank BOTS/roles by intent embedding (#15) — discoverByIntent over kind:'bot'. */
export async function rankBotsByIntent(
  intent: string,
  bots: RankableBot[],
  embedder: SyncEmbedder,
  opts: { topK?: number; minScore?: number } = {},
): Promise<DiscoveryHit[]> {
  const items: DiscoverableItem[] = bots.map((b) => ({
    kind: 'bot',
    id: b.id,
    name: b.name,
    description: b.description ?? '',
  }));
  return discoverByIntent(intent, items, embedder, opts);
}

/** Pick the best bot for an intent, or undefined when nothing clears minScore. */
export async function pickBotForIntent(
  intent: string,
  bots: RankableBot[],
  embedder: SyncEmbedder,
  opts: { minScore?: number } = {},
): Promise<RankableBot | undefined> {
  const hits = await rankBotsByIntent(intent, bots, embedder, { topK: 1, minScore: opts.minScore ?? 0.15 });
  const top = hits[0];
  return top ? bots.find((b) => b.id === top.item.id) : undefined;
}

/**
 * Deterministic auto-activation over the MCP server / capability catalog
 * (#139): the SAME decideAutoActivation policy (threshold + margin +
 * abstain-on-tie, no LLM), restricted to mcp/capability hits.
 */
export function decideMcpAutoActivation(
  hits: DiscoveryHit[],
  opts: { threshold?: number; margin?: number; maxActivate?: number } = {},
): ActivationDecision {
  return decideAutoActivation(
    hits.filter((h) => h.item.kind === 'mcp' || h.item.kind === 'capability'),
    opts,
  );
}

/**
 * The `discover_specialists` tool (#15): ranks bots/roles (and optionally
 * skills/MCP items) by intent embedding and returns the ranked list.
 * Hosts register it like other runtime-created tools; delegation paths
 * (bot-team/delegate) can consult `rankBotsByIntent` directly.
 */
export function createDiscoverSpecialistsTool(deps: {
  items: () => DiscoverableItem[] | Promise<DiscoverableItem[]>;
  embedder: SyncEmbedder;
}): ToolDefinition {
  return {
    name: 'discover_specialists',
    description:
      'Discover which bot/role (or skill/MCP capability) best matches an intent, ranked by semantic similarity. ' +
      'Use before delegating when you are unsure which specialist fits.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What needs doing, in plain language.' },
        kind: { type: 'string', description: 'Optional filter: bot | skill | mcp | capability' },
      },
      required: ['intent'],
    },
    mutating: false,
    handler: async (args) => {
      const intent = typeof args.intent === 'string' ? args.intent : '';
      if (!intent.trim()) return { error: 'intent is required' };
      const all = await deps.items();
      const kind = typeof args.kind === 'string' ? args.kind : undefined;
      const items = kind ? all.filter((i) => i.kind === kind) : all;
      const hits = await discoverByIntent(intent, items, deps.embedder, { topK: 5 });
      return {
        matches: hits.map((h) => ({
          kind: h.item.kind,
          id: h.item.id,
          name: h.item.name,
          score: Math.round(h.score * 1000) / 1000,
        })),
      };
    },
  };
}
