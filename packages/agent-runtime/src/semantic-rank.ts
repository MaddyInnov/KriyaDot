// SPDX-License-Identifier: Apache-2.0
/**
 * OH-2: blended keyword + semantic ranking.
 *
 * Blends an existing keyword score (any existing scoring function's
 * output, normalized here by max) with an optional embedding cosine
 * score. When the active embedder is the trigram hash fallback ONLY,
 * the semantic lane is lexical too — blending it at full weight would
 * double-count lexical overlap — so the semantic weight drops to
 * BLEND_SEMANTIC_WEIGHT_TRIGRAM and `semanticActive` is false, telling
 * callers the ranking was produced in offline/lexical mode. With a
 * neural/onnx embedder the weights are 0.6 keyword / 0.4 semantic.
 * Deterministic: score desc, id asc tie-break.
 */
import type { SyncEmbedder } from './hybrid-search.js';

export const BLEND_KEYWORD_WEIGHT = 0.6;
export const BLEND_SEMANTIC_WEIGHT = 0.4;
export const BLEND_SEMANTIC_WEIGHT_TRIGRAM = 0.1;
/** Weights when semanticActive=false: keyword keeps (1 - trigram weight). */
export const BLEND_KEYWORD_WEIGHT_TRIGRAM = 0.9;

export interface BlendItem {
  id: string;
  /** Raw keyword score from an existing scoring function (any scale >= 0). */
  keywordScore?: number;
  /** Embedding cosine score, typically -1..1. */
  semanticScore?: number;
}

export interface BlendedHit {
  id: string;
  score: number;
  keywordScore: number;
  semanticScore: number | null;
}

export interface BlendResult {
  hits: BlendedHit[];
  /** True only when a non-hash (neural/onnx) embedder produced the semantic scores. */
  semanticActive: boolean;
  keywordWeight: number;
  semanticWeight: number;
}

/** True when the embedder is a real semantic lane (not the trigram hash fallback). */
export function isSemanticEmbedder(embedder: SyncEmbedder | undefined | null): boolean {
  if (!embedder) return false;
  if (embedder.kind) return embedder.kind !== 'hash';
  // Legacy embedders without a kind: the trigram fallback is known by name.
  return embedder.name !== 'trigram-384' && !embedder.name.startsWith('trigram');
}

export function blendRank(
  items: BlendItem[],
  opts: { semanticActive?: boolean; keywordWeight?: number; semanticWeight?: number; topK?: number } = {},
): BlendResult {
  const semanticActive = opts.semanticActive ?? items.some((i) => i.semanticScore !== undefined);
  const kwW = opts.keywordWeight ?? (semanticActive ? BLEND_KEYWORD_WEIGHT : BLEND_KEYWORD_WEIGHT_TRIGRAM);
  const semW = opts.semanticWeight ?? (semanticActive ? BLEND_SEMANTIC_WEIGHT : BLEND_SEMANTIC_WEIGHT_TRIGRAM);
  const maxKw = Math.max(0, ...items.map((i) => i.keywordScore ?? 0));
  const hits: BlendedHit[] = items.map((i) => {
    const kwNorm = maxKw > 0 ? (i.keywordScore ?? 0) / maxKw : 0;
    const sem = i.semanticScore !== undefined ? Math.max(0, i.semanticScore) : null;
    const score = sem === null ? kwNorm : kwW * kwNorm + semW * sem;
    return { id: i.id, score, keywordScore: kwNorm, semanticScore: sem };
  });
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    hits: opts.topK ? hits.slice(0, opts.topK) : hits,
    semanticActive,
    keywordWeight: kwW,
    semanticWeight: semW,
  };
}

/**
 * Keyword scoring used by the bot-ranking blend path: token overlap of
 * the intent against an item's name+description (whole tokens, len>=2),
 * plus a phrase bonus when the item name appears verbatim in the intent.
 * Deterministic; mirrors the message-router's direct-hit spirit.
 */
export function keywordScoreForText(intent: string, text: string): number {
  const intentTokens = new Set((intent.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2));
  const textTokens = new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2));
  let score = 0;
  for (const t of intentTokens) if (textTokens.has(t)) score += 1;
  return score;
}
