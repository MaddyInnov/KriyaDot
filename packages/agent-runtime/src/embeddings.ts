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
 * Selection story (parity #13 — neural by default when available):
 *   - `createEmbedderFromEnv` (sync, legacy/host-compatible):
 *     EMBEDDING_MODEL set → neural; otherwise the trigram embedder.
 *   - `selectDefaultEmbedder` (async, preferred for hosts that can
 *     await): neural becomes the DEFAULT when a local embeddings
 *     endpoint is configured (EMBEDDING_BASE_URL / EMBEDDING_MODEL) or
 *     an Ollama endpoint answers a health check; a configured bundled
 *     ONNX model file that exists on disk wins over the HTTP probe;
 *     the trigram hash embedder is the offline fallback, no longer the
 *     unconditional default. Reachability results are cached briefly.
 * No key is ever required — keyless local endpoints (Ollama) work with
 * no apiKey.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
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
  readonly kind = 'neural' as const;
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

// ---- Bundled local ONNX model (parity #13b) --------------------------------
//
// HONEST SCOPE: this tree carries NO ONNX runtime dependency
// (onnxruntime-node is a native module and adding one is out of scope
// for this workstream), so real ONNX inference cannot run from the
// bundled code alone. What ships here is the complete loader seam:
//   - a configured model path (EMBEDDING_ONNX_MODEL_PATH),
//   - file-exists gating (`capability.filePresent`),
//   - a capability report stating plainly whether inference is live,
//   - an injectable `sessionRunner` — a host that bundles an ONNX
//     runtime passes its session here and inference goes live with no
//     other changes.
// Without a runner, embed() degrades to the trigram fallback projected
// into the model dimension (same resilience contract as the HTTP
// embedder) and `capability.available` is false with the reason.

/** Runs one ONNX inference session over tokenized inputs (host-supplied). */
export type OnnxSessionRunner = (texts: string[]) => Promise<Float32Array[]>;

export interface BundledOnnxCapability {
  /** Configured model file path. */
  path: string;
  /** The model file exists on disk. */
  filePresent: boolean;
  /** A session runner (ONNX runtime) is available. */
  runtimeAvailable: boolean;
  /** True only when file AND runtime are both present. */
  available: boolean;
  /** Plain-language reason when not available. */
  reason: string;
}

export interface BundledOnnxEmbedderOptions {
  modelPath: string;
  /** Output dimension. Default 384 (small bundled-model class). */
  dim?: number;
  fallback?: SyncEmbedder;
  existsFn?: (path: string) => boolean;
  /** Host-supplied ONNX session; without it inference is unavailable. */
  sessionRunner?: OnnxSessionRunner;
}

export class BundledOnnxEmbedder implements SyncEmbedder {
  readonly name: string;
  readonly dim: number;
  readonly kind = 'onnx' as const;
  readonly capability: BundledOnnxCapability;
  private readonly fallback: SyncEmbedder;
  private readonly sessionRunner?: OnnxSessionRunner;

  constructor(opts: BundledOnnxEmbedderOptions) {
    this.name = `onnx:${basename(opts.modelPath)}`;
    this.dim = opts.dim ?? 384;
    this.fallback = opts.fallback ?? new TrigramEmbedder();
    this.sessionRunner = opts.sessionRunner;
    const existsFn = opts.existsFn ?? existsSync;
    const filePresent = existsFn(opts.modelPath);
    const runtimeAvailable = typeof opts.sessionRunner === 'function';
    this.capability = {
      path: opts.modelPath,
      filePresent,
      runtimeAvailable,
      available: filePresent && runtimeAvailable,
      reason: !filePresent
        ? `bundled ONNX model file not found at ${opts.modelPath}`
        : !runtimeAvailable
          ? 'no ONNX runtime is bundled with this build (onnxruntime is not a dependency of agent-runtime); ' +
            'a host-supplied sessionRunner is required for live ONNX inference'
          : 'bundled ONNX inference available',
    };
  }

  private project(v: Float32Array): Float32Array {
    if (v.length === this.dim) return l2NormalizeInto(v);
    const out = new Float32Array(this.dim);
    out.set(v.subarray(0, Math.min(v.length, this.dim)));
    return l2NormalizeInto(out);
  }

  embedSync(texts: string[]): Float32Array[] {
    return this.fallback.embedSync(texts).map((v) => this.project(v));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.capability.available && this.sessionRunner) {
      const vectors = await this.sessionRunner(texts);
      return vectors.map((v) => this.project(Float32Array.from(v)));
    }
    // Capability seam only (see header): degrade like the HTTP embedder.
    return this.embedSync(texts);
  }
}

// ---- Default selection: neural when reachable (parity #13a) -----------------

export type EmbedderSelectionSource =
  | 'forced-trigram'
  | 'explicit-env'
  | 'bundled-onnx'
  | 'local-endpoint'
  | 'offline-fallback';

export interface EmbedderSelection {
  embedder: SyncEmbedder;
  source: EmbedderSelectionSource;
  /** Plain-language explanation of the choice (logs / settings UI). */
  reason: string;
  /** Endpoints health-checked during selection, in order. */
  checkedEndpoints: string[];
}

export interface SelectDefaultEmbedderOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Health probe override (tests). Default: GET <base>/models. */
  healthFn?: (baseUrl: string) => Promise<boolean>;
  existsFn?: (path: string) => boolean;
  /** Host-supplied ONNX session for the bundled-model path. */
  onnxSessionRunner?: OnnxSessionRunner;
  now?: () => number;
  /** Reachability cache TTL in ms. Default 60_000. 0 disables. */
  cacheTtlMs?: number;
}

const selectionCache = new Map<string, { at: number; selection: EmbedderSelection }>();

/** Drop cached reachability results (tests / settings changes). */
export function clearEmbedderSelectionCache(): void {
  selectionCache.clear();
}

async function defaultHealth(fetchFn: typeof fetch, baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '');
  const probes = [`${base}/models`];
  // Ollama also answers on its native tags endpoint at the origin.
  if (base.endsWith('/v1')) probes.push(`${base.slice(0, -3)}/api/tags`);
  for (const url of probes) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // try the next probe
    }
  }
  return false;
}

/**
 * The default embedder story (parity #13): neural FIRST when it is
 * genuinely available, trigram hash as the offline fallback.
 *
 * Order:
 *   1. EMBEDDING_PROVIDER=trigram → trigram (explicit user choice).
 *   2. A configured bundled ONNX path (EMBEDDING_ONNX_MODEL_PATH, alias
 *      EMBEDDING_BUNDLED_MODEL_PATH) whose file exists → BundledOnnx
 *      (capability report rides on the embedder).
 *   3. EMBEDDING_MODEL set → neural via createEmbedderFromEnv semantics
 *      (an explicitly configured endpoint is trusted, no probe).
 *   4. A local endpoint is reachable: EMBEDDING_BASE_URL when set, else
 *      Ollama at http://localhost:11434/v1 → neural with
 *      EMBEDDING_LOCAL_MODEL (default nomic-embed-text).
 *   5. Nothing reachable → trigram offline fallback.
 *
 * Steps 4–5 outcomes are cached for `cacheTtlMs` so per-turn callers do
 * not re-probe; steps 1–3 are config-pure and recomputed cheaply.
 */
export async function selectDefaultEmbedder(
  opts: SelectDefaultEmbedderOptions = {},
): Promise<EmbedderSelection> {
  const env = opts.env ?? process.env;
  const fetchFn =
    opts.fetchFn ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch);
  const existsFn = opts.existsFn ?? existsSync;
  const now = opts.now ?? (() => Date.now());
  const cacheTtlMs = opts.cacheTtlMs ?? 60_000;

  if ((env.EMBEDDING_PROVIDER ?? '').toLowerCase() === 'trigram') {
    return {
      embedder: new TrigramEmbedder(),
      source: 'forced-trigram',
      reason: 'EMBEDDING_PROVIDER=trigram forces the offline hash embedder',
      checkedEndpoints: [],
    };
  }

  const onnxPath = (env.EMBEDDING_ONNX_MODEL_PATH ?? env.EMBEDDING_BUNDLED_MODEL_PATH ?? '').trim();
  if (onnxPath && existsFn(onnxPath)) {
    const embedder = new BundledOnnxEmbedder({
      modelPath: onnxPath,
      existsFn,
      sessionRunner: opts.onnxSessionRunner,
      dim: Number(env.EMBEDDING_DIM ?? '') > 0 ? Math.floor(Number(env.EMBEDDING_DIM)) : undefined,
    });
    return {
      embedder,
      source: 'bundled-onnx',
      reason: embedder.capability.available
        ? `bundled ONNX model at ${onnxPath} with a live runtime session`
        : `bundled ONNX model present at ${onnxPath}; ${embedder.capability.reason} — sync/async legs degrade to the trigram projection until a runtime is supplied`,
      checkedEndpoints: [],
    };
  }

  if ((env.EMBEDDING_MODEL ?? '').trim()) {
    return {
      embedder: createEmbedderFromEnv(env),
      source: 'explicit-env',
      reason: 'EMBEDDING_MODEL is configured — neural embedder (explicit endpoint, not probed)',
      checkedEndpoints: [],
    };
  }

  const configuredBase = (env.EMBEDDING_BASE_URL ?? '').trim();
  const candidateBase = configuredBase || 'http://localhost:11434/v1';
  const cacheKey = `local:${candidateBase}:${env.EMBEDDING_LOCAL_MODEL ?? ''}`;
  if (cacheTtlMs > 0) {
    const hit = selectionCache.get(cacheKey);
    if (hit && now() - hit.at < cacheTtlMs) return hit.selection;
  }
  const healthFn = opts.healthFn ?? ((base: string) => defaultHealth(fetchFn, base));
  const healthy = await healthFn(candidateBase);
  let selection: EmbedderSelection;
  if (healthy) {
    const model = (env.EMBEDDING_LOCAL_MODEL ?? '').trim() || 'nomic-embed-text';
    selection = {
      embedder: new HttpNeuralEmbedder({
        baseUrl: candidateBase,
        model,
        apiKey: (env.EMBEDDING_API_KEY ?? '').trim() || undefined,
        fetchFn,
      }),
      source: 'local-endpoint',
      reason: `local embeddings endpoint reachable at ${candidateBase} — neural embedder (${model}) is the default`,
      checkedEndpoints: [candidateBase],
    };
  } else {
    selection = {
      embedder: new TrigramEmbedder(),
      source: 'offline-fallback',
      reason: `no local embeddings endpoint reachable at ${candidateBase} — trigram hash fallback (offline, lexical only)`,
      checkedEndpoints: [candidateBase],
    };
  }
  if (cacheTtlMs > 0) selectionCache.set(cacheKey, { at: now(), selection });
  return selection;
}
