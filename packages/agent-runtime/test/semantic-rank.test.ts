// SPDX-License-Identifier: Apache-2.0
// OH-2: blended ranker math (synthetic scores) — deterministic, weights, trigram downgrade.
import { describe, expect, it } from 'vitest';
import {
  blendRank,
  isSemanticEmbedder,
  BLEND_KEYWORD_WEIGHT,
  BLEND_SEMANTIC_WEIGHT,
  BLEND_SEMANTIC_WEIGHT_TRIGRAM,
} from '../src/semantic-rank.js';
import { TrigramEmbedder } from '../src/hybrid-search.js';
import { HttpNeuralEmbedder } from '../src/embeddings.js';

describe('blendRank', () => {
  it('blends normalized keyword and semantic scores at 0.6/0.4 when semantic is active', () => {
    expect(BLEND_KEYWORD_WEIGHT).toBe(0.6);
    expect(BLEND_SEMANTIC_WEIGHT).toBe(0.4);
    const r = blendRank(
      [
        { id: 'a', keywordScore: 10, semanticScore: 0 },
        { id: 'b', keywordScore: 0, semanticScore: 1 },
      ],
      { semanticActive: true },
    );
    expect(r.semanticActive).toBe(true);
    expect(r.hits[0]!.id).toBe('a'); // 0.6*1 + 0.4*0 = 0.6
    expect(r.hits[0]!.score).toBeCloseTo(0.6, 6);
    expect(r.hits[1]!.score).toBeCloseTo(0.4, 6);
  });

  it('drops the semantic weight to the trigram value when semantic is inactive', () => {
    const r = blendRank([{ id: 'a', keywordScore: 5, semanticScore: 1 }], { semanticActive: false });
    expect(r.semanticActive).toBe(false);
    expect(r.semanticWeight).toBe(BLEND_SEMANTIC_WEIGHT_TRIGRAM);
    expect(r.hits[0]!.score).toBeCloseTo(0.9 * 1 + BLEND_SEMANTIC_WEIGHT_TRIGRAM * 1, 6);
  });

  it('is deterministic with id-ascending tie-breaks and clamps negative cosine', () => {
    const items = [
      { id: 'zeta', keywordScore: 2, semanticScore: -0.5 },
      { id: 'alpha', keywordScore: 2, semanticScore: -0.5 },
    ];
    const r1 = blendRank(items, { semanticActive: true });
    const r2 = blendRank([...items].reverse(), { semanticActive: true });
    expect(r1.hits.map((h) => h.id)).toEqual(['alpha', 'zeta']);
    expect(r2.hits.map((h) => h.id)).toEqual(['alpha', 'zeta']);
    expect(r1.hits[0]!.score).toBeCloseTo(0.6, 6);
  });

  it('keyword-only items (no semantic score) rank on keyword alone', () => {
    const r = blendRank([{ id: 'a', keywordScore: 3 }, { id: 'b', keywordScore: 9 }], { semanticActive: false });
    expect(r.hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(r.hits[0]!.semanticScore).toBeNull();
  });
});

describe('isSemanticEmbedder', () => {
  it('treats the trigram hash fallback as non-semantic and HTTP neural as semantic', () => {
    expect(isSemanticEmbedder(new TrigramEmbedder())).toBe(false);
    expect(isSemanticEmbedder(new HttpNeuralEmbedder({ baseUrl: 'http://localhost:1/v1', model: 'nomic-embed-text' }))).toBe(true);
    expect(isSemanticEmbedder(undefined)).toBe(false);
  });
});
