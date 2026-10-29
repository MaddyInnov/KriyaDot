// SPDX-License-Identifier: Apache-2.0
/**
 * Neural embeddings provider (Octomind parity).
 *
 * The memory/discovery stack was built on a char-trigram HASH embedder
 * (hybrid-search.ts): deterministic and offline, but with no semantic
 * understanding — "automobile" and "car" are unrelated vectors. This
 * module adds a real neural embedder behind the same SyncEmbedder
 * interface, speaking the OpenAI-compatible embeddings API (which also
 * covers OpenAI, OpenRouter-style gateways, and Ollama's /v1/embeddings
 * for local models like nomic-embed-text).
 *
 * Interface honesty: the SyncEmbedder contract has a synchronous leg
 * because some call sites (TieredMemoryStore.storeAtom) are sync. A
 * network embedder cannot be synchronous, so:
 *   - `embed()` (async) is the real neural path — discovery and any
 *     async consumer get true model embeddings.
 *   - `embedSync()` degrades to the trigram fallback projected into the
 *     model's dimension (zero-padded + renormalized), so sync callers
 *     keep working offline and dimension-consistent. Neural-vs-hash
 *     quality differs; the fallback is resilience, not a claim of
 *     equivalence, and HTTP failures in `embed()` degrade the same way
 *     instead of breaking a turn.
 *
 * Selection is env-driven (createEmbedderFromEnv): EMBEDDING_MODEL set
 * → neural; otherwise the trigram embedder, unchanged. No key is ever
 * required — keyless local endpoints (Ollama) work with no apiKey.
 */

import {
  TrigramEmbedder,
  cosineSimilarity,
  fnv1a32,
  type SyncEmbedder,
} from './hybrid-search.js';

export { cosineSimilarity };

/** Known output dimensions for common embedding models. */
export const KNOWN_EMBEDDING_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'bge-small-en-v1.5': 384,
  'bge-large-en-v1.5': 1024,
};

export interface HttpNeuralEmbedderOptions {
  /** Base URL of an OpenAI-compatible API (no trailing slash needed). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Output dimension; inferred from the model name when omitted. */
  dim?: number;
  /** Sync/offline fallback. Default: TrigramEmbedder. */
  fallback?: SyncEmbedder;
  /** Injectable for tests. Default: global fetch. */
  fetchFn?: typeof fetch;
}

function l2NormalizeInto(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export class HttpNeuralEmbedder implements SyncEmbedder {
  readonly name: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly fallback: SyncEmbedder;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpNeuralEmbedderOptions) {
    this.model = opts.model;
    this.name = `neural:${opts.model}`;
    this.dim = opts.dim ?? KNOWN_EMBEDDING_DIMS[opts.model] ?? 1536;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fallback = opts.fallback ?? new TrigramEmbedder();
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Project a fallback vector into this embedder's dimension. */
  private project(v: Float32Array): Float32Array {
    if (v.length === this.dim) return v;
    const out = new Float32Array(this.dim);
    out.set(v.subarray(0, Math.min(v.length, this.dim)));
    return l2NormalizeInto(out);
  }

  embedSync(texts: string[]): Float32Array[] {
    return this.fallback.embedSync(texts).map((v) => this.project(v));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    try {
      const res = await this.fetchFn(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings request failed: ${res.status}`);
      const data = (await res.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      if (!Array.isArray(data.data) || data.data.length !== texts.length) {
        throw new Error('embeddings response shape mismatch');
      }
      const ordered = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return ordered.map((d) => {
        if (!Array.isArray(d.embedding)) throw new Error('embeddings response missing vector');
        return l2NormalizeInto(Float32Array.from(d.embedding));
      });
    } catch {
      // Resilience: a dead embeddings endpoint degrades to the offline
      // fallback instead of failing the caller (documented in header).
      return this.embedSync(texts);
    }
  }
}

/**
 * Build the platform embedder from the environment.
 *
 *   EMBEDDING_MODEL        — set → neural embedder (e.g. text-embedding-3-small, nomic-embed-text)
 *   EMBEDDING_BASE_URL     — default: Ollama /v1 when the model is a known local one, else OpenAI /v1
 *   EMBEDDING_API_KEY      — default: OPENAI_API_KEY (never required for local endpoints)
 *   EMBEDDING_DIM          — explicit dimension override
 *   EMBEDDING_PROVIDER     — 'trigram' forces the offline hash embedder
 */
export function createEmbedderFromEnv(env: NodeJS.ProcessEnv = process.env): SyncEmbedder {
  const fallback = new TrigramEmbedder();
  if ((env.EMBEDDING_PROVIDER ?? '').toLowerCase() === 'trigram') return fallback;
  const model = (env.EMBEDDING_MODEL ?? '').trim();
  if (!model) return fallback;
  const isLocalModel = model in KNOWN_EMBEDDING_DIMS && !model.startsWith('text-embedding');
  const baseUrl =
    (env.EMBEDDING_BASE_URL ?? '').trim() ||
    (isLocalModel ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1');
  const apiKey = (env.EMBEDDING_API_KEY ?? env.OPENAI_API_KEY ?? '').trim() || undefined;
  const dimRaw = Number(env.EMBEDDING_DIM ?? '');
  return new HttpNeuralEmbedder({
    baseUrl,
    apiKey,
    model,
    dim: Number.isFinite(dimRaw) && dimRaw > 0 ? Math.floor(dimRaw) : undefined,
    fallback,
  });
}

/** Stable cache key for an (embedder, text) pair. */
export function embeddingCacheKey(embedderName: string, text: string): string {
  return `${embedderName}:${fnv1a32(text).toString(16)}:${text.length}`;
}
