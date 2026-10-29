// SPDX-License-Identifier: Apache-2.0
// Managed knowledge bases (Octop §2.14 parity): named corpora with folders,
// per-KB limits, retained original + edited document text, per-KB embedding
// provider choice, corpus sharing (read | contribute), and cited search.
//
// This is the API-layer managed store (JSON-file persistence under the
// data dir, same style as notes.ts). It complements — does not replace —
// the muse-modules KnowledgeBaseStore behind the legacy kb_search tool.
// Chunking mirrors that store's word-boundary algorithm; vectors are
// stored per chunk in this store and search is cosine over them with a
// keyword fallback when no vector scores.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TrigramEmbedder, cosineSimilarity, type SyncEmbedder } from '@mvp/agent-runtime';

export type KbEmbeddingProvider = 'local' | 'neural';
export type KbShareRole = 'read' | 'contribute';
export type KbPrincipalType = 'user' | 'org';

export interface KbFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface KbShare {
  principalType: KbPrincipalType;
  principalId: string;
  role: KbShareRole;
}

export interface KbCorpus {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  orgId?: string;
  folders: KbFolder[];
  /** Per-KB limits — enforced on document add/edit. */
  maxDocs: number;
  maxBytes: number;
  embeddingProvider: KbEmbeddingProvider;
  shares: KbShare[];
  createdAt: number;
  updatedAt: number;
}

export interface KbDocument {
  id: string;
  kbId: string;
  title: string;
  fileName: string;
  folderId: string | null;
  /** Text exactly as ingested — never overwritten by edits. */
  originalText: string;
  /** User-edited text; null until the first edit. Effective text = edited ?? original. */
  editedText: string | null;
  byteSize: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface KbChunkRecord {
  docId: string;
  chunkIndex: number;
  text: string;
  vector: number[];
}

export interface KbCitation {
  kbId: string;
  docId: string;
  docTitle: string;
  chunkIndex: number;
  excerpt: string;
  score: number;
}

export interface KbActor {
  userId: string;
  orgId?: string;
}

interface KbFileShape {
  corpora: KbCorpus[];
  documents: KbDocument[];
  chunks: KbChunkRecord[];
}

export const DEFAULT_KB_MAX_DOCS = 500;
export const DEFAULT_KB_MAX_BYTES = 50 * 1024 * 1024;

/** Word-boundary chunking (same algorithm family as muse-modules chunkText). */
export function chunkKbText(text: string, chunkChars = 2048, overlapChars = 200): string[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= chunkChars) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkChars, clean.length);
    if (end < clean.length) {
      const ws = clean.lastIndexOf(' ', end);
      if (ws > start + chunkChars * 0.5) end = ws;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

export interface KbStoreOptions {
  /** Embedder overrides (tests / host wiring). Defaults: local = trigram, neural = trigram unless a neural embedder is injected. */
  embedders?: Partial<Record<KbEmbeddingProvider, SyncEmbedder>>;
  fileName?: string; // default 'kb-managed.json'
}

export class KbStore {
  private readonly file: string;
  private readonly embedders: Record<KbEmbeddingProvider, SyncEmbedder>;

  constructor(dataDir: string, opts: KbStoreOptions = {}) {
    this.file = join(dataDir, opts.fileName ?? 'kb-managed.json');
    const local = opts.embedders?.local ?? new TrigramEmbedder();
    this.embedders = {
      local,
      // 'neural' without an injected neural embedder degrades to the local
      // trigram vectors (documented resilience, same as embeddings.ts).
      neural: opts.embedders?.neural ?? local,
    };
  }

  path(): string {
    return this.file;
  }

  private readAll(): KbFileShape {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KbFileShape>;
      return {
        corpora: Array.isArray(parsed.corpora) ? parsed.corpora : [],
        documents: Array.isArray(parsed.documents) ? parsed.documents : [],
        chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { corpora: [], documents: [], chunks: [] };
      throw err;
    }
  }

  private writeAll(data: KbFileShape): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, this.file);
  }

  // ---- access control -----------------------------------------------------

  canRead(actor: KbActor, corpus: KbCorpus): boolean {
    if (corpus.ownerId === actor.userId) return true;
    return corpus.shares.some(
      (s) =>
        (s.principalType === 'user' && s.principalId === actor.userId) ||
        (s.principalType === 'org' && actor.orgId !== undefined && s.principalId === actor.orgId),
    );
  }

  canContribute(actor: KbActor, corpus: KbCorpus): boolean {
    if (corpus.ownerId === actor.userId) return true;
    return corpus.shares.some(
      (s) =>
        s.role === 'contribute' &&
        ((s.principalType === 'user' && s.principalId === actor.userId) ||
          (s.principalType === 'org' && actor.orgId !== undefined && s.principalId === actor.orgId)),
    );
  }

  isOwner(actor: KbActor, corpus: KbCorpus): boolean {
    return corpus.ownerId === actor.userId;
  }

  private requireCorpus(data: KbFileShape, kbId: string): KbCorpus {
    const corpus = data.corpora.find((c) => c.id === kbId);
    if (!corpus) throw new Error(`unknown knowledge base: ${kbId}`);
    return corpus;
  }

  requireReadable(actor: KbActor, kbId: string): KbCorpus {
    const corpus = this.requireCorpus(this.readAll(), kbId);
    if (!this.canRead(actor, corpus)) throw new Error(`knowledge base not shared with you: ${kbId}`);
    return corpus;
  }

  // ---- corpora ------------------------------------------------------------

  createCorpus(
    actor: KbActor,
    input: {
      name: string;
      description?: string;
      maxDocs?: number;
      maxBytes?: number;
      embeddingProvider?: KbEmbeddingProvider;
    },
  ): KbCorpus {
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw new Error('knowledge base name is required');
    const now = Date.now();
    const corpus: KbCorpus = {
      id: randomUUID(),
      name,
      description: (input.description ?? '').slice(0, 500),
      ownerId: actor.userId,
      orgId: actor.orgId,
      folders: [],
      maxDocs: input.maxDocs && input.maxDocs > 0 ? Math.floor(input.maxDocs) : DEFAULT_KB_MAX_DOCS,
      maxBytes: input.maxBytes && input.maxBytes > 0 ? Math.floor(input.maxBytes) : DEFAULT_KB_MAX_BYTES,
      embeddingProvider: input.embeddingProvider === 'neural' ? 'neural' : 'local',
      shares: [],
      createdAt: now,
      updatedAt: now,
    };
    const data = this.readAll();
    data.corpora.push(corpus);
    this.writeAll(data);
    return corpus;
  }

  listCorpora(actor: KbActor): KbCorpus[] {
    return this.readAll().corpora.filter((c) => this.canRead(actor, c));
  }

  getCorpus(actor: KbActor, kbId: string): KbCorpus {
    return this.requireReadable(actor, kbId);
  }

  updateCorpus(
    actor: KbActor,
    kbId: string,
    patch: Partial<Pick<KbCorpus, 'name' | 'description' | 'maxDocs' | 'maxBytes' | 'embeddingProvider'>>,
  ): KbCorpus {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.isOwner(actor, corpus)) throw new Error('only the owner can update a knowledge base');
    if (patch.name !== undefined && patch.name.trim()) corpus.name = patch.name.trim().slice(0, 120);
    if (patch.description !== undefined) corpus.description = patch.description.slice(0, 500);
    if (patch.maxDocs !== undefined && patch.maxDocs > 0) corpus.maxDocs = Math.floor(patch.maxDocs);
    if (patch.maxBytes !== undefined && patch.maxBytes > 0) corpus.maxBytes = Math.floor(patch.maxBytes);
    if (patch.embeddingProvider === 'local' || patch.embeddingProvider === 'neural') {
      corpus.embeddingProvider = patch.embeddingProvider;
    }
    corpus.updatedAt = Date.now();
    this.writeAll(data);
    return corpus;
  }

  deleteCorpus(actor: KbActor, kbId: string): void {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.isOwner(actor, corpus)) throw new Error('only the owner can delete a knowledge base');
    const docIds = new Set(data.documents.filter((d) => d.kbId === kbId).map((d) => d.id));
    data.corpora = data.corpora.filter((c) => c.id !== kbId);
    data.documents = data.documents.filter((d) => d.kbId !== kbId);
    data.chunks = data.chunks.filter((ch) => !docIds.has(ch.docId));
    this.writeAll(data);
  }

  addFolder(actor: KbActor, kbId: string, name: string, parentId: string | null = null): KbFolder {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.canContribute(actor, corpus)) throw new Error('contribute access is required to add folders');
    const trimmed = name.trim().slice(0, 120);
    if (!trimmed) throw new Error('folder name is required');
    if (parentId && !corpus.folders.some((f) => f.id === parentId)) throw new Error(`unknown folder: ${parentId}`);
    const folder: KbFolder = { id: randomUUID(), name: trimmed, parentId, createdAt: Date.now() };
    corpus.folders.push(folder);
    corpus.updatedAt = Date.now();
    this.writeAll(data);
    return folder;
  }

  share(actor: KbActor, kbId: string, share: KbShare): KbCorpus {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.isOwner(actor, corpus)) throw new Error('only the owner can share a knowledge base');
    if (share.role !== 'read' && share.role !== 'contribute') throw new Error('share role must be read or contribute');
    if (!share.principalId?.trim()) throw new Error('share principalId is required');
    corpus.shares = corpus.shares.filter(
      (s) => !(s.principalType === share.principalType && s.principalId === share.principalId),
    );
    corpus.shares.push({ principalType: share.principalType, principalId: share.principalId, role: share.role });
    corpus.updatedAt = Date.now();
    this.writeAll(data);
    return corpus;
  }

  unshare(actor: KbActor, kbId: string, principalType: KbPrincipalType, principalId: string): KbCorpus {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.isOwner(actor, corpus)) throw new Error('only the owner can unshare a knowledge base');
    corpus.shares = corpus.shares.filter(
      (s) => !(s.principalType === principalType && s.principalId === principalId),
    );
    corpus.updatedAt = Date.now();
    this.writeAll(data);
    return corpus;
  }

  // ---- documents ----------------------------------------------------------

  private indexChunks(data: KbFileShape, corpus: KbCorpus, doc: KbDocument, text: string): void {
    data.chunks = data.chunks.filter((ch) => ch.docId !== doc.id);
    const pieces = chunkKbText(text);
    const embedder = this.embedders[corpus.embeddingProvider];
    const vectors = pieces.length > 0 ? embedder.embedSync(pieces) : [];
    pieces.forEach((piece, i) => {
      data.chunks.push({
        docId: doc.id,
        chunkIndex: i,
        text: piece,
        vector: vectors[i] ? Array.from(vectors[i]) : [],
      });
    });
    doc.chunkCount = pieces.length;
  }

  private corpusUsage(data: KbFileShape, kbId: string, excludeDocId?: string): { docs: number; bytes: number } {
    const docs = data.documents.filter((d) => d.kbId === kbId && d.id !== excludeDocId);
    return { docs: docs.length, bytes: docs.reduce((sum, d) => sum + d.byteSize, 0) };
  }

  addDocument(
    actor: KbActor,
    kbId: string,
    input: { title: string; text: string; fileName?: string; folderId?: string | null },
  ): KbDocument {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.canContribute(actor, corpus)) throw new Error('contribute access is required to add documents');
    if (!input.text?.trim()) throw new Error('document has no text');
    if (input.folderId && !corpus.folders.some((f) => f.id === input.folderId)) {
      throw new Error(`unknown folder: ${input.folderId}`);
    }
    const byteSize = Buffer.byteLength(input.text, 'utf8');
    const usage = this.corpusUsage(data, kbId);
    if (usage.docs + 1 > corpus.maxDocs) {
      throw new Error(`knowledge base document limit reached (${corpus.maxDocs})`);
    }
    if (usage.bytes + byteSize > corpus.maxBytes) {
      throw new Error(`knowledge base byte limit reached (${corpus.maxBytes})`);
    }
    const now = Date.now();
    const doc: KbDocument = {
      id: randomUUID(),
      kbId,
      title: (input.title ?? '').trim().slice(0, 200) || input.fileName || 'Untitled',
      fileName: (input.fileName ?? '').slice(0, 200),
      folderId: input.folderId ?? null,
      originalText: input.text,
      editedText: null,
      byteSize,
      chunkCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.indexChunks(data, corpus, doc, input.text);
    data.documents.push(doc);
    corpus.updatedAt = now;
    this.writeAll(data);
    return doc;
  }

  listDocuments(actor: KbActor, kbId: string): KbDocument[] {
    const data = this.readAll();
    this.requireReadableFromData(actor, data, kbId);
    return data.documents.filter((d) => d.kbId === kbId);
  }

  private requireReadableFromData(actor: KbActor, data: KbFileShape, kbId: string): KbCorpus {
    const corpus = this.requireCorpus(data, kbId);
    if (!this.canRead(actor, corpus)) throw new Error(`knowledge base not shared with you: ${kbId}`);
    return corpus;
  }

  getDocument(actor: KbActor, kbId: string, docId: string): KbDocument {
    const data = this.readAll();
    this.requireReadableFromData(actor, data, kbId);
    const doc = data.documents.find((d) => d.id === docId && d.kbId === kbId);
    if (!doc) throw new Error(`unknown document: ${docId}`);
    return doc;
  }

  /** Edit a document's text. The original is retained; chunks re-index from the edited text. */
  editDocument(actor: KbActor, kbId: string, docId: string, editedText: string): KbDocument {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.canContribute(actor, corpus)) throw new Error('contribute access is required to edit documents');
    const doc = data.documents.find((d) => d.id === docId && d.kbId === kbId);
    if (!doc) throw new Error(`unknown document: ${docId}`);
    if (!editedText?.trim()) throw new Error('edited text must not be empty');
    const usage = this.corpusUsage(data, kbId, docId);
    const byteSize = Buffer.byteLength(editedText, 'utf8');
    if (usage.bytes + byteSize > corpus.maxBytes) {
      throw new Error(`knowledge base byte limit reached (${corpus.maxBytes})`);
    }
    doc.editedText = editedText;
    doc.byteSize = byteSize;
    doc.updatedAt = Date.now();
    this.indexChunks(data, corpus, doc, editedText);
    this.writeAll(data);
    return doc;
  }

  deleteDocument(actor: KbActor, kbId: string, docId: string): void {
    const data = this.readAll();
    const corpus = this.requireCorpus(data, kbId);
    if (!this.canContribute(actor, corpus)) throw new Error('contribute access is required to delete documents');
    const before = data.documents.length;
    data.documents = data.documents.filter((d) => !(d.id === docId && d.kbId === kbId));
    if (data.documents.length === before) throw new Error(`unknown document: ${docId}`);
    data.chunks = data.chunks.filter((ch) => ch.docId !== docId);
    this.writeAll(data);
  }

  effectiveText(doc: KbDocument): string {
    return doc.editedText ?? doc.originalText;
  }

  // ---- search ---------------------------------------------------------------

  /**
   * Search one corpus (or all corpora the actor can read when kbId is
   * omitted). Cosine over stored chunk vectors; when no chunk vector
   * scores above zero (no embedder coverage), falls back to keyword
   * overlap so search still works. Returns clickable citations.
   */
  search(actor: KbActor, query: string, opts?: { kbId?: string; topK?: number }): KbCitation[] {
    const q = (query ?? '').trim();
    if (!q) return [];
    const topK = Math.min(Math.max(opts?.topK ?? 5, 1), 20);
    const data = this.readAll();
    const corpora = data.corpora.filter(
      (c) => this.canRead(actor, c) && (!opts?.kbId || c.id === opts.kbId),
    );
    if (corpora.length === 0) return [];
    const byId = new Map(corpora.map((c) => [c.id, c]));
    const docsById = new Map(
      data.documents.filter((d) => byId.has(d.kbId)).map((d) => [d.id, d]),
    );
    const chunks = data.chunks.filter((ch) => docsById.has(ch.docId));
    if (chunks.length === 0) return [];

    const terms = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
    const scored: Array<{ citation: KbCitation; score: number }> = [];
    // Group chunks by corpus so each corpus uses ITS embedding provider.
    for (const corpus of corpora) {
      const corpusChunks = chunks.filter((ch) => docsById.get(ch.docId)?.kbId === corpus.id);
      if (corpusChunks.length === 0) continue;
      const embedder = this.embedders[corpus.embeddingProvider];
      const [qv] = embedder.embedSync([q]);
      for (const ch of corpusChunks) {
        let score = ch.vector.length > 0 && qv ? cosineSimilarity(qv, ch.vector) : 0;
        if (!(score > 0)) {
          // Keyword fallback: fraction of query terms present in the chunk.
          const lower = ch.text.toLowerCase();
          const hits = terms.filter((t) => t.length >= 2 && lower.includes(t)).length;
          score = terms.length > 0 ? hits / terms.length : 0;
        }
        if (score <= 0) continue;
        const doc = docsById.get(ch.docId)!;
        scored.push({
          score,
          citation: {
            kbId: corpus.id,
            docId: doc.id,
            docTitle: doc.title,
            chunkIndex: ch.chunkIndex,
            excerpt: ch.text.slice(0, 600),
            score: Math.round(score * 10000) / 10000,
          },
        });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.citation);
  }
}
