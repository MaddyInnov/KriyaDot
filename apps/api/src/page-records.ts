// SPDX-License-Identifier: Apache-2.0
// FL-5 — Mini-app data API for Pages.
//
// Pages were static (markdown/HTML/JSX). This module gives each page its
// own record store so an agent-built page can behave like a mini-app:
//   - Collections: named record sets per page, each with a `publicRead`
//     flag (default false). A collection holds key/value records
//     (explicit `key`) and/or anonymous records (server-minted id).
//   - Owner API (authenticated, mounted on the pages router):
//       GET    /:id/collections
//       POST   /:id/collections            { name, publicRead? }
//       PATCH  /:id/collections/:name      { publicRead }
//       DELETE /:id/collections/:name      (cascades its records)
//       GET    /:id/records/:collection            → records[]
//       POST   /:id/records/:collection            { key?, value } → record (201)
//       GET    /:id/records/:collection/:key
//       PUT    /:id/records/:collection/:key       { value } → record (upsert)
//       DELETE /:id/records/:collection/:key
//   - Runtime read path for the published page (NO auth, mounted on the
//     express app): GET /p/:slug/records/:collection[/:key] — served only
//     when the page is published AND the collection opted into public
//     read. Writes are owner-only; there is no public write path.
//
// Storage: `page_collections` + `page_records` tables in the shared
// pages.db (same file as PageStore / PagePublicationStore), following the
// existing per-module openDb pattern. Values are arbitrary JSON, capped at
// 64KB serialized per record. NOTE: no directory named `data` is used —
// the store lives in this module and the pages.db tables above.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import type { Express, Request, Response } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { PageStore } from './pages.js';
import { PagePublicationStore } from './public-pages.js';

export const MAX_RECORD_VALUE_BYTES = 64 * 1024;
export const MAX_RECORDS_PER_COLLECTION = 10_000;

export interface PageCollection {
  pageId: string;
  name: string;
  publicRead: boolean;
  createdAt: number;
  recordCount: number;
}

export interface PageRecord {
  id: string;
  pageId: string;
  collection: string;
  /** Explicit key for key/value records; null for anonymous records (use `id`). */
  key: string | null;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

interface CollectionRow {
  page_id: string;
  name: string;
  public_read: number;
  created_at: number;
}

interface RecordRow {
  id: string;
  page_id: string;
  collection: string;
  record_key: string | null;
  value: string;
  created_at: number;
  updated_at: number;
}

const RECORDS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS page_collections (
    page_id TEXT NOT NULL,
    name TEXT NOT NULL,
    public_read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, name)
  );
  CREATE TABLE IF NOT EXISTS page_records (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    record_key TEXT,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_page_records_key
    ON page_records(page_id, collection, record_key) WHERE record_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_page_records_coll
    ON page_records(page_id, collection, created_at ASC);
`;

function openRecordsDb(dataDir: string): DatabaseSync {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db = openSqliteDb(join(dataDir, 'pages.db'));
  db.exec(RECORDS_SCHEMA);
  return db;
}

const COLLECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RECORD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidCollectionName(name: unknown): name is string {
  return typeof name === 'string' && COLLECTION_NAME_RE.test(name);
}

function requireCollectionName(name: unknown): string {
  if (!isValidCollectionName(name)) {
    throw new Error('"collection" name must be 1-64 chars: letters, digits, "_" or "-", starting alphanumeric');
  }
  return name;
}

function requireRecordKey(key: unknown): string {
  if (typeof key !== 'string' || !RECORD_KEY_RE.test(key)) {
    throw new Error('"key" must be 1-128 chars: letters, digits, ".", "_" or "-", starting alphanumeric');
  }
  return key;
}

function serializeValue(value: unknown): string {
  if (value === undefined) throw new Error('record "value" is required');
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error('record "value" must be JSON-serializable');
  }
  if (json === undefined) throw new Error('record "value" must be JSON-serializable');
  if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_VALUE_BYTES) {
    throw new Error(`record "value" exceeds ${MAX_RECORD_VALUE_BYTES / 1024}KB`);
  }
  return json;
}

function rowToRecord(r: RecordRow): PageRecord {
  let value: unknown = null;
  try {
    value = JSON.parse(r.value);
  } catch {
    value = null;
  }
  return {
    id: r.id,
    pageId: r.page_id,
    collection: r.collection,
    key: r.record_key,
    value,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class PageRecordStore {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openRecordsDb(dataDir);
  }

  // ---- Collections --------------------------------------------------------

  defineCollection(pageId: string, input: { name: string; publicRead?: boolean }): PageCollection {
    const name = requireCollectionName(input.name);
    const existing = this.getCollection(pageId, name);
    if (existing) {
      if (input.publicRead !== undefined && input.publicRead !== existing.publicRead) {
        return this.setPublicRead(pageId, name, input.publicRead);
      }
      return existing;
    }
    this.db
      .prepare('INSERT INTO page_collections (page_id, name, public_read, created_at) VALUES (?, ?, ?, ?)')
      .run(pageId, name, input.publicRead === true ? 1 : 0, Date.now());
    return this.getCollection(pageId, name)!;
  }

  getCollection(pageId: string, name: string): PageCollection | undefined {
    const row = this.db
      .prepare('SELECT * FROM page_collections WHERE page_id = ? AND name = ?')
      .get(pageId, name) as unknown as CollectionRow | undefined;
    if (!row) return undefined;
    return {
      pageId: row.page_id,
      name: row.name,
      publicRead: row.public_read === 1,
      createdAt: row.created_at,
      recordCount: this.countRecords(pageId, name),
    };
  }

  listCollections(pageId: string): PageCollection[] {
    const rows = this.db
      .prepare('SELECT * FROM page_collections WHERE page_id = ? ORDER BY name ASC')
      .all(pageId) as unknown as CollectionRow[];
    return rows.map((row) => ({
      pageId: row.page_id,
      name: row.name,
      publicRead: row.public_read === 1,
      createdAt: row.created_at,
      recordCount: this.countRecords(pageId, row.name),
    }));
  }

  setPublicRead(pageId: string, name: string, publicRead: boolean): PageCollection {
    const r = this.db
      .prepare('UPDATE page_collections SET public_read = ? WHERE page_id = ? AND name = ?')
      .run(publicRead ? 1 : 0, pageId, name);
    if (r.changes === 0) throw new Error(`unknown collection: ${name}`);
    return this.getCollection(pageId, name)!;
  }

  /** Delete a collection and all of its records. Returns records removed. */
  deleteCollection(pageId: string, name: string): number {
    const existing = this.getCollection(pageId, name);
    if (!existing) throw new Error(`unknown collection: ${name}`);
    const removed = this.countRecords(pageId, name);
    this.db.prepare('DELETE FROM page_records WHERE page_id = ? AND collection = ?').run(pageId, name);
    this.db.prepare('DELETE FROM page_collections WHERE page_id = ? AND name = ?').run(pageId, name);
    return removed;
  }

  // ---- Records --------------------------------------------------------------

  countRecords(pageId: string, collection: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM page_records WHERE page_id = ? AND collection = ?')
      .get(pageId, collection) as unknown as { n: number };
    return row.n;
  }

  countForPage(pageId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM page_records WHERE page_id = ?')
      .get(pageId) as unknown as { n: number };
    return row.n;
  }

  private requireCollection(pageId: string, collection: string): PageCollection {
    const c = this.getCollection(pageId, requireCollectionName(collection));
    if (!c) throw new Error(`unknown collection: ${collection}`);
    return c;
  }

  /** Create or replace a record. With `key`: upsert by key. Without: a new anonymous record. */
  put(pageId: string, collection: string, input: { key?: string; value: unknown }): PageRecord {
    this.requireCollection(pageId, collection);
    const json = serializeValue(input.value);
    const now = Date.now();
    if (input.key !== undefined) {
      const key = requireRecordKey(input.key);
      const existing = this.getByKey(pageId, collection, key);
      if (existing) {
        this.db
          .prepare('UPDATE page_records SET value = ?, updated_at = ? WHERE id = ?')
          .run(json, Math.max(now, existing.updatedAt + 1), existing.id);
        return this.getByKey(pageId, collection, key)!;
      }
      if (this.countRecords(pageId, collection) >= MAX_RECORDS_PER_COLLECTION) {
        throw new Error(`collection "${collection}" is full (${MAX_RECORDS_PER_COLLECTION} records)`);
      }
      const record: PageRecord = {
        id: randomUUID(),
        pageId,
        collection,
        key,
        value: input.value,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare(
          'INSERT INTO page_records (id, page_id, collection, record_key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(record.id, pageId, collection, key, json, now, now);
      return record;
    }
    if (this.countRecords(pageId, collection) >= MAX_RECORDS_PER_COLLECTION) {
      throw new Error(`collection "${collection}" is full (${MAX_RECORDS_PER_COLLECTION} records)`);
    }
    const record: PageRecord = {
      id: randomUUID(),
      pageId,
      collection,
      key: null,
      value: input.value,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO page_records (id, page_id, collection, record_key, value, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)',
      )
      .run(record.id, pageId, collection, json, now, now);
    return record;
  }

  getByKey(pageId: string, collection: string, key: string): PageRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM page_records WHERE page_id = ? AND collection = ? AND record_key = ?')
      .get(pageId, collection, key) as unknown as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Fetch by explicit key, falling back to record id (anonymous records). */
  get(pageId: string, collection: string, keyOrId: string): PageRecord | undefined {
    const byKey = this.getByKey(pageId, collection, keyOrId);
    if (byKey) return byKey;
    const row = this.db
      .prepare('SELECT * FROM page_records WHERE page_id = ? AND collection = ? AND id = ?')
      .get(pageId, collection, keyOrId) as unknown as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(pageId: string, collection: string, opts: { limit?: number; offset?: number } = {}): PageRecord[] {
    this.requireCollection(pageId, collection);
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = this.db
      .prepare(
        'SELECT * FROM page_records WHERE page_id = ? AND collection = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
      )
      .all(pageId, collection, limit, offset) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  remove(pageId: string, collection: string, keyOrId: string): PageRecord {
    const record = this.get(pageId, collection, keyOrId);
    if (!record) throw new Error(`unknown record: ${keyOrId}`);
    this.db.prepare('DELETE FROM page_records WHERE id = ?').run(record.id);
    return record;
  }

  /** Remove every collection + record for a page (FL-8 atomic delete helper). Returns counts. */
  clearPage(pageId: string): { collections: number; records: number } {
    const records = this.countForPage(pageId);
    const collections = this.listCollections(pageId).length;
    this.db.prepare('DELETE FROM page_records WHERE page_id = ?').run(pageId);
    this.db.prepare('DELETE FROM page_collections WHERE page_id = ?').run(pageId);
    return { collections, records };
  }
}

// ---------------------------------------------------------------------------
// Owner routes — mount on the pages router (paths are /:id/collections…)
// ---------------------------------------------------------------------------

export interface PageRecordDeps {
  dataDir: string;
  pageStore?: PageStore;
  store?: PageRecordStore;
}

function sendStoreError(res: Response, err: unknown, fallback: string): void {
  const message = err instanceof Error ? err.message : fallback;
  const status = /unknown collection|unknown record/.test(message) ? 404 : 400;
  res.status(status).json({ error: message });
}

export function registerPageRecordRoutes(router: Router, deps: PageRecordDeps): void {
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);
  const store = deps.store ?? new PageRecordStore(deps.dataDir);
  const requirePage = (req: Request, res: Response): boolean => {
    if (!pages.get(req.params.id)) {
      res.status(404).json({ error: `unknown page: ${req.params.id}` });
      return false;
    }
    return true;
  };

  router.get('/:id/collections', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    res.json(store.listCollections(req.params.id));
  });

  router.post('/:id/collections', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    try {
      const body = (req.body ?? {}) as { name?: unknown; publicRead?: unknown };
      const collection = store.defineCollection(req.params.id, {
        name: body.name as string,
        publicRead: body.publicRead === true,
      });
      res.status(201).json(collection);
    } catch (err) {
      sendStoreError(res, err, 'failed to define collection');
    }
  });

  router.patch('/:id/collections/:name', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    try {
      const body = (req.body ?? {}) as { publicRead?: unknown };
      if (typeof body.publicRead !== 'boolean') {
        res.status(400).json({ error: '"publicRead" must be a boolean' });
        return;
      }
      res.json(store.setPublicRead(req.params.id, req.params.name, body.publicRead));
    } catch (err) {
      sendStoreError(res, err, 'failed to update collection');
    }
  });

  router.delete('/:id/collections/:name', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    try {
      const removedRecords = store.deleteCollection(req.params.id, req.params.name);
      res.json({ ok: true, removedRecords });
    } catch (err) {
      sendStoreError(res, err, 'failed to delete collection');
    }
  });

  router.get('/:id/records/:collection', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    try {
      const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      const offset = req.query.offset === undefined ? undefined : Number(req.query.offset);
      res.json(
        store.list(req.params.id, req.params.collection, {
          limit: Number.isFinite(limit) ? limit : undefined,
          offset: Number.isFinite(offset) ? offset : undefined,
        }),
      );
    } catch (err) {
      sendStoreError(res, err, 'failed to list records');
    }
  });

  router.post('/:id/records/:collection', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    try {
      const body = (req.body ?? {}) as { key?: unknown; value?: unknown };
      const record = store.put(req.params.id, req.params.collection, {
        key: typeof body.key === 'string' ? body.key : undefined,
        value: body.value,
      });
      res.status(201).json(record);
    } catch (err) {
      sendStoreError(res, err, 'failed to create record');
    }
  });

  router.get('/:id/records/:collection/:key', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    const record = store.get(req.params.id, req.params.collection, req.params.key);
    if (!record) {
      res.status(404).json({ error: `unknown record: ${req.params.key}` });
      return;
    }
    res.json(record);
  });

  router.put('/:id/records/:collection/:key', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    try {
      const body = (req.body ?? {}) as { value?: unknown };
      const record = store.put(req.params.id, req.params.collection, {
        key: req.params.key,
        value: body.value,
      });
      res.json(record);
    } catch (err) {
      sendStoreError(res, err, 'failed to write record');
    }
  });

  router.delete('/:id/records/:collection/:key', (req: Request, res: Response) => {
    if (!requirePage(req, res)) return;
    try {
      store.remove(req.params.id, req.params.collection, req.params.key);
      res.json({ ok: true });
    } catch (err) {
      sendStoreError(res, err, 'failed to delete record');
    }
  });
}

// ---------------------------------------------------------------------------
// Public runtime read path — mount on the express app (no auth).
// Serves records only for a published page + a publicRead collection.
// ---------------------------------------------------------------------------

export interface PageRecordPublicDeps extends PageRecordDeps {
  publicationStore?: PagePublicationStore;
}

export function registerPageRecordPublicRoutes(app: Express, deps: PageRecordPublicDeps): void {
  const publications = deps.publicationStore ?? new PagePublicationStore(deps.dataDir);
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);
  const store = deps.store ?? new PageRecordStore(deps.dataDir);

  const resolvePublicCollection = (
    slug: string,
    collectionName: string,
  ): { pageId: string } | { error: string; status: number } => {
    const pub = publications.getBySlug(slug);
    if (!pub || !pub.pageId) return { error: 'not found', status: 404 };
    if (!pages.get(pub.pageId)) return { error: 'not found', status: 404 };
    const collection = store.getCollection(pub.pageId, collectionName);
    if (!collection) return { error: 'not found', status: 404 };
    if (!collection.publicRead) return { error: 'collection is not public', status: 403 };
    return { pageId: pub.pageId };
  };

  app.get('/p/:slug/records/:collection', (req: Request, res: Response) => {
    const resolved = resolvePublicCollection(req.params.slug, req.params.collection);
    if ('error' in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    const offset = req.query.offset === undefined ? undefined : Number(req.query.offset);
    res.json(
      store.list(resolved.pageId, req.params.collection, {
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      }),
    );
  });

  app.get('/p/:slug/records/:collection/:key', (req: Request, res: Response) => {
    const resolved = resolvePublicCollection(req.params.slug, req.params.collection);
    if ('error' in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const record = store.get(resolved.pageId, req.params.collection, req.params.key);
    if (!record) {
      res.status(404).json({ error: `unknown record: ${req.params.key}` });
      return;
    }
    res.json(record);
  });
}
