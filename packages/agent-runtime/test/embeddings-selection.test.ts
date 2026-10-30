// SPDX-License-Identifier: Apache-2.0
// Parity #13: neural embedder is the default WHEN a local endpoint is
// reachable/configured; trigram hash is the offline fallback; bundled
// ONNX path is a file-gated loader seam with an honest capability
// report. All probes are injected — no network.

import { afterEach, describe, expect, it } from 'vitest';
import {
  BundledOnnxEmbedder,
  HttpNeuralEmbedder,
  clearEmbedderSelectionCache,
  selectDefaultEmbedder,
} from '../src/embeddings.js';
import { TrigramEmbedder } from '../src/hybrid-search.js';

afterEach(() => {
  clearEmbedderSelectionCache();
});

describe('selectDefaultEmbedder', () => {
  it('falls back to trigram when no local endpoint is reachable', async () => {
    const sel = await selectDefaultEmbedder({
      env: {},
      healthFn: async () => false,
      cacheTtlMs: 0,
    });
    expect(sel.embedder).toBeInstanceOf(TrigramEmbedder);
    expect(sel.source).toBe('offline-fallback');
    expect(sel.checkedEndpoints).toEqual(['http://localhost:11434/v1']);
  });

  it('makes the neural embedder the default when Ollama answers', async () => {
    const sel = await selectDefaultEmbedder({
      env: {},
      healthFn: async () => true,
      cacheTtlMs: 0,
    });
    expect(sel.embedder).toBeInstanceOf(HttpNeuralEmbedder);
    expect(sel.embedder.kind).toBe('neural');
    expect(sel.embedder.name).toBe('neural:nomic-embed-text');
    expect(sel.source).toBe('local-endpoint');
  });

  it('honors a configured EMBEDDING_BASE_URL as the probe target', async () => {
    const probed: string[] = [];
    const sel = await selectDefaultEmbedder({
      env: { EMBEDDING_BASE_URL: 'http://localhost:9999/v1', EMBEDDING_LOCAL_MODEL: 'bge-small-en-v1.5' },
      healthFn: async (base) => {
        probed.push(base);
        return true;
      },
      cacheTtlMs: 0,
    });
    expect(probed).toEqual(['http://localhost:9999/v1']);
    expect(sel.embedder.name).toBe('neural:bge-small-en-v1.5');
    expect(sel.embedder.dim).toBe(384);
  });

  it('caches reachability within the TTL (probe runs once)', async () => {
    let probes = 0;
    const opts = {
      env: {},
      healthFn: async () => {
        probes++;
        return true;
      },
      now: () => 5000,
      cacheTtlMs: 60_000,
    };
    const first = await selectDefaultEmbedder(opts);
    const second = await selectDefaultEmbedder(opts);
    expect(probes).toBe(1);
    expect(second).toBe(first);
  });

  it('EMBEDDING_MODEL set → explicit neural, no probe', async () => {
    const sel = await selectDefaultEmbedder({
      env: { EMBEDDING_MODEL: 'text-embedding-3-small' },
      healthFn: async () => {
        throw new Error('must not probe');
      },
    });
    expect(sel.source).toBe('explicit-env');
    expect(sel.embedder).toBeInstanceOf(HttpNeuralEmbedder);
  });

  it('EMBEDDING_PROVIDER=trigram forces the hash embedder', async () => {
    const sel = await selectDefaultEmbedder({
      env: { EMBEDDING_PROVIDER: 'trigram', EMBEDDING_MODEL: 'nomic-embed-text' },
      healthFn: async () => true,
    });
    expect(sel.source).toBe('forced-trigram');
    expect(sel.embedder).toBeInstanceOf(TrigramEmbedder);
  });
});

describe('BundledOnnxEmbedder (loader seam)', () => {
  it('reports capability honestly when the file exists but no runtime is bundled', async () => {
    const emb = new BundledOnnxEmbedder({
      modelPath: '/models/embeddings/model.onnx',
      existsFn: () => true,
    });
    expect(emb.kind).toBe('onnx');
    expect(emb.capability.filePresent).toBe(true);
    expect(emb.capability.runtimeAvailable).toBe(false);
    expect(emb.capability.available).toBe(false);
    expect(emb.capability.reason).toMatch(/no ONNX runtime is bundled/);
    // Degraded legs still return dimension-consistent vectors.
    const [v] = await emb.embed(['hello']);
    expect(v).toHaveLength(384);
  });

  it('reports file-missing when the configured path does not exist', () => {
    const emb = new BundledOnnxEmbedder({
      modelPath: '/nope/model.onnx',
      existsFn: () => false,
      sessionRunner: async (texts) => texts.map(() => new Float32Array(384)),
    });
    expect(emb.capability.filePresent).toBe(false);
    expect(emb.capability.available).toBe(false);
    expect(emb.capability.reason).toMatch(/not found/);
  });

  it('goes live when a host supplies a session runner', async () => {
    const seen: string[][] = [];
    const emb = new BundledOnnxEmbedder({
      modelPath: '/models/model.onnx',
      existsFn: () => true,
      sessionRunner: async (texts) => {
        seen.push(texts);
        return texts.map(() => Float32Array.from([3, 4]));
      },
    });
    expect(emb.capability.available).toBe(true);
    const [v] = await emb.embed(['abc']);
    expect(seen).toEqual([['abc']]);
    // Runner output is projected into the embedder dim and normalized.
    expect(v).toHaveLength(384);
    expect(v![0]).toBeCloseTo(0.6);
    expect(v![1]).toBeCloseTo(0.8);
  });

  it('selection picks the bundled path when the configured file exists', async () => {
    const sel = await selectDefaultEmbedder({
      env: { EMBEDDING_ONNX_MODEL_PATH: '/models/model.onnx' },
      existsFn: () => true,
      healthFn: async () => {
        throw new Error('bundled path must win over the HTTP probe');
      },
    });
    expect(sel.source).toBe('bundled-onnx');
    expect(sel.embedder).toBeInstanceOf(BundledOnnxEmbedder);
  });

  it('selection skips a configured ONNX path whose file is missing', async () => {
    const sel = await selectDefaultEmbedder({
      env: { EMBEDDING_ONNX_MODEL_PATH: '/models/model.onnx' },
      existsFn: () => false,
      healthFn: async () => false,
      cacheTtlMs: 0,
    });
    expect(sel.source).toBe('offline-fallback');
  });
});
