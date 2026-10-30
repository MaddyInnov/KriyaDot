// SPDX-License-Identifier: Apache-2.0
// Hybrid search primitives (Laya-inspired, adapted — not copied):
// vector + lexical (SQLite FTS5 / BM25) retrieval fused with
// Reciprocal Rank Fusion. Dependency-free: FTS5 ships inside node:sqlite,
// embeddings are hash-based (see TrigramEmbedder), no network, no keys.
//
// Shared by the agent-runtime memory path (TieredMemoryStore) and the
// muse-modules knowledge-base path (KnowledgeBaseStore) so both fuse with
// identical semantics.

/**
 * Minimal embedder contract for hybrid search. `embedSync` exists because
 * some call sites (e.g. TieredMemoryStore.storeAtom) are synchronous;
 * hash embedders are fast enough that sync is always fine.
 *
 * `kind` (parity #13) lets discovery/auto-activation judge embedding
 * quality: 'neural' (HTTP model) and 'onnx' (bundled local model) are
 * semantic; 'hash' (the trigram fallback) is lexical-only. The DEFAULT
 * selection story lives in embeddings.ts (`selectDefaultEmbedder`):
 * neural when a local endpoint is reachable/configured, bundled ONNX
 * when a model file is configured and present, trigram hash as the
 * offline fallback — this module stays the dependency-free floor.
 */
export interface SyncEmbedder {
  readonly name: string;
  readonly dim: number;
  /** Embedding quality tier, when the embedder declares one. */
  readonly kind?: 'hash' | 'neural' | 'onnx';
  embedSync(texts: string[]): Float32Array[];
  embed(texts: string[]): Float32Array[] | Promise<Float32Array[]>;
}

/** FNV-1a 32-bit hash (public so tests/embedders can reuse it). */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2Normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/**
 * Zero-dependency local embedder: char-trigram hashing into 384 dims,
 * TF-weighted, L2-normalized. Deterministic and offline. Same algorithm
 * family as muse-modules' LocalEmbedder (which subclasses this); kept here
 * so agent-runtime's memory path has no dependency on muse-modules.
 */
export class TrigramEmbedder implements SyncEmbedder {
  readonly name = 'trigram-384';
  readonly dim = 384;
  readonly kind = 'hash' as const;

  embedSync(texts: string[]): Float32Array[] {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      const s = `  ${t.toLowerCase()}  `;
      for (let i = 0; i + 3 <= s.length; i++) {
        v[fnv1a32(s.slice(i, i + 3)) % this.dim] += 1;
      }
      return l2Normalize(v);
    });
  }

  embed(texts: string[]): Float32Array[] {
    return this.embedSync(texts);
  }
}

/** Cosine similarity; 0 when either vector is empty/zero. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface FusedRank {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion (Cormack et al.): score(id) = Σ 1/(k + rank)
 * over the ranked lists, rank 1-based. k=60 is the standard constant.
 * Each input list is best-first; duplicate ids within one list count once
 * (first occurrence wins).
 */
export function reciprocalRankFuse(lists: string[][], k = 60): FusedRank[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Tokenize free text into FTS5-safe terms: unicode letters/digits,
 * lowercased, deduped, min length 2, capped at 32 terms.
 */
export function ftsTerms(text: string): string[] {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms)].filter((t) => t.length >= 2).slice(0, 32);
}

/**
 * Build a safe FTS5 MATCH expression from a raw user query: every term is
 * double-quoted (embedded quotes doubled so injection is impossible) and
 * OR-joined for broad lexical recall. Returns '' when the query has no
 * usable terms — callers must skip the FTS leg in that case.
 */
export function buildFtsMatchQuery(query: string): string {
  const terms = ftsTerms(query);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
