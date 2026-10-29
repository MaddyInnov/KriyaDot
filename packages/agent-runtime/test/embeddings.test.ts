// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { HttpNeuralEmbedder, createEmbedderFromEnv } from '../src/embeddings.js';
import { TrigramEmbedder } from '../src/hybrid-search.js';

function stubFetch(payload: unknown, seen?: { url?: string; body?: Record<string, unknown> }) {
  return (async (url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as typeof fetch;
}

describe('HttpNeuralEmbedder', () => {
  it('embeds via the OpenAI-compatible endpoint and normalizes', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const embedder = new HttpNeuralEmbedder({
      baseUrl: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
      fetchFn: stubFetch(
        { data: [{ index: 0, embedding: [3, 4] }, { index: 1, embedding: [0, 2] }] },
        seen,
      ),
    });
    expect(embedder.dim).toBe(768);
    expect(embedder.name).toBe('neural:nomic-embed-text');
    const vectors = await embedder.embed(['a', 'b']);
    expect(seen.url).toBe('http://localhost:11434/v1/embeddings');
    expect(seen.body?.model).toBe('nomic-embed-text');
    // The endpoint's short vectors are normalized in place (not padded).
    expect(vectors[0]).toHaveLength(2);
    expect(vectors[0]![0]).toBeCloseTo(0.6);
    expect(vectors[0]![1]).toBeCloseTo(0.8);
    expect(vectors[1]![1]).toBeCloseTo(1);
  });

  it('falls back to the trigram projection on HTTP failure', async () => {
    const embedder = new HttpNeuralEmbedder({
      baseUrl: 'http://localhost:9/v1',
      model: 'text-embedding-3-small',
      fetchFn: (async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
    });
    const vectors = await embedder.embed(['hello world']);
    expect(vectors[0]).toHaveLength(1536); // projected into the model dim
    const norm = Math.hypot(...vectors[0]!);
    expect(norm).toBeCloseTo(1);
  });

  it('falls back when the response shape mismatches the inputs', async () => {
    const embedder = new HttpNeuralEmbedder({
      baseUrl: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
      fetchFn: stubFetch({ data: [] }),
    });
    const vectors = await embedder.embed(['a', 'b']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(768);
  });

  it('embedSync is the trigram projection (sync-compatible)', () => {
    const embedder = new HttpNeuralEmbedder({
      baseUrl: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
      fetchFn: stubFetch({ data: [] }),
    });
    const [v] = embedder.embedSync(['some text']);
    expect(v).toHaveLength(768);
    const [base] = new TrigramEmbedder().embedSync(['some text']);
    expect(Array.from(v!.slice(0, 384))).toEqual(Array.from(base!));
  });
});

describe('createEmbedderFromEnv', () => {
  it('defaults to the trigram embedder (offline)', () => {
    const e = createEmbedderFromEnv({});
    expect(e).toBeInstanceOf(TrigramEmbedder);
  });

  it('builds a neural embedder when EMBEDDING_MODEL is set', () => {
    const e = createEmbedderFromEnv({ EMBEDDING_MODEL: 'nomic-embed-text' });
    expect(e).toBeInstanceOf(HttpNeuralEmbedder);
    expect(e.name).toBe('neural:nomic-embed-text');
    expect(e.dim).toBe(768);
  });

  it('honors the trigram override', () => {
    expect(
      createEmbedderFromEnv({ EMBEDDING_MODEL: 'x', EMBEDDING_PROVIDER: 'trigram' }),
    ).toBeInstanceOf(TrigramEmbedder);
  });
});
