// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  decideAutoActivation,
  discoverByIntent,
  type DiscoverableItem,
  type DiscoveryHit,
} from '../src/discovery.js';
import { TrigramEmbedder } from '../src/hybrid-search.js';

const embedder = new TrigramEmbedder();

const item = (id: string, name: string, description: string): DiscoverableItem => ({
  kind: 'skill',
  id,
  name,
  description,
});

const hit = (id: string, score: number): DiscoveryHit => ({
  item: item(id, id, ''),
  score,
});

describe('discoverByIntent', () => {
  it('ranks items by embedding similarity to the intent', async () => {
    const hits = await discoverByIntent(
      'publish a blog post to the company website',
      [
        item('blog', 'Blog Publisher', 'publish blog post website article'),
        item('calc', 'Calculator', 'arithmetic math numbers add subtract'),
      ],
      embedder,
      { topK: 2, minScore: 0 },
    );
    expect(hits[0]!.item.id).toBe('blog');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('respects topK and minScore', async () => {
    const hits = await discoverByIntent(
      'zzqq unrelated gibberish tokens',
      [item('a', 'A', 'completely different words')],
      embedder,
      { topK: 1, minScore: 0.999 },
    );
    expect(hits).toEqual([]);
  });

  it('returns [] for an empty intent', async () => {
    expect(await discoverByIntent('  ', [item('a', 'A', 'x')], embedder)).toEqual([]);
  });
});

describe('decideAutoActivation', () => {
  it('activates clear winners above threshold with margin', () => {
    const d = decideAutoActivation([hit('a', 0.9), hit('b', 0.5)], {
      threshold: 0.3,
      margin: 0.05,
      maxActivate: 3,
    });
    expect(d.abstained).toBe(false);
    expect(d.activate.map((h) => h.item.id)).toEqual(['a', 'b']);
  });

  it('abstains on empty results and below-threshold hits', () => {
    expect(decideAutoActivation([], { threshold: 0.3, margin: 0.05 }).abstained).toBe(true);
    expect(decideAutoActivation([hit('a', 0.2)], { threshold: 0.3, margin: 0.05 }).abstained).toBe(
      true,
    );
  });

  it('abstains on a near-tie for a single activation slot', () => {
    const d = decideAutoActivation([hit('a', 0.9), hit('b', 0.88)], {
      threshold: 0.3,
      margin: 0.05,
      maxActivate: 1,
    });
    expect(d.abstained).toBe(true);
    expect(d.reason).toContain('tie at the activation boundary');
  });

  it('caps activations at maxActivate', () => {
    const d = decideAutoActivation([hit('a', 0.9), hit('b', 0.8), hit('c', 0.7), hit('d', 0.6)], {
      threshold: 0.3,
      margin: 0.01,
      maxActivate: 2,
    });
    expect(d.activate.map((h) => h.item.id)).toEqual(['a', 'b']);
  });
});
