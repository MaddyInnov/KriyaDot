// SPDX-License-Identifier: Apache-2.0
// FL-13 — Workspace trash with 30-day recovery.
//
// Deleting a workspace file (or a chat-upload file) no longer destroys its
// bytes: the file is MOVED into a trash blob area under
// <dataDir>/workspace-trash-blobs/<trashId>/ and a metadata row is kept in
// <dataDir>/file-lifecycle.db (`trash_items`). From there it can be:
//   - listed   (GET    /trash)
//   - restored (POST   /trash/:id/restore) — moved back to its original path
//   - destroyed (DELETE /trash/:id)        — permanent delete
//   - purged   (POST   /trash/purge)       — sweep for entries whose 30-day
//     retention has expired; also exported as runTrashPurge() so the host
//     can schedule it (e.g. a daily routine) without HTTP.
//
// HOST WIRING (see the worker report): routes.ts / index.ts were out of
// scope for this build, so the existing DELETE /api/files/:id handler in
// routes.ts still destroys uploads directly. Mount
// registerWorkspaceTrashRoutes() on a router at /api/files and point the
// UI delete action at POST /api/files/trash (or swap the handler body for
// store.trashUploadFile(...)) to make delete → trash everywhere.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { confineFile } from './files.js';
import { LifecycleAuditLog, auditLifecycle, type LifecycleGovernance } from './lifecycle-approval.js';

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type TrashScope = 'workspace' | 'upload';

export interface TrashItem {
  id: string;
  scope: TrashScope;
  /** Absolute workspace root the file belongs to (scope 'workspace'), or the uploads dir (scope 'upload'). */
  root: string;
  /** Workspace-relative path (scope 'workspace') or stored upload filename (scope 'upload'). */
  originalPath: string;
  /** Display name (basename). */
  name: string;
  isDir: boolean;
  size: number;
  mimeType?: string;
  /** Upload id (scope 'upload' only). */
  uploadId?: string;
  trashedBy: string;
  trashedAt: number;
  /** trashedAt + retention. The purge sweep destroys the item at/after this. */
  expiresAt: number;
}

interface TrashRow {
  id: string;
  scope: string;
  root: string;
  original_path: string;
  name: string;
  is_dir: number;
  size: number;
  mime_type: string | null;
  upload_id: string | null;
  trashed_by: string;
  trashed_at: number;
  expires_at: number;
}

function rowToItem(r: TrashRow): TrashItem {
  return {
    id: r.id,
    scope: r.scope === 'upload' ? 'upload' : 'workspace',
    root: r.root,
    originalPath: r.original_path,
    name: r.name,
    isDir: r.is_dir === 1,
    size: r.size,
    mimeType: r.mime_type ?? undefined,
    uploadId: r.upload_id ?? undefined,
    trashedBy: r.trashed_by,
    trashedAt: r.trashed_at,
    expiresAt: r.expires_at,
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS trash_items (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    root TEXT NOT NULL,
    original_path TEXT NOT NULL,
    name TEXT NOT NULL,
    is_dir INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT,
    upload_id TEXT,
    trashed_by TEXT NOT NULL DEFAULT '',
    trashed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trash_expires ON trash_items(expires_at ASC);
  CREATE INDEX IF NOT EXISTS idx_trash_trashed ON trash_items(trashed_at DESC);
`;

function openLifecycleDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openSqliteDb(path.join(dataDir, 'file-lifecycle.db'));
  db.exec(SCHEMA);
  return db;
}

/** Move a file/dir, falling back to copy+remove across devices. */
function movePath(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function dirSizeBytes(abs: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(child);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(child).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

export interface TrashStoreOptions {
  retentionMs?: number;
  now?: () => number;
}

export class TrashStore {
  protected readonly db: DatabaseSync;
  readonly blobDir: string;
  private readonly retentionMs: number;
  private readonly nowFn: () => number;

  constructor(
    protected readonly dataDir: string,
    opts: TrashStoreOptions = {},
  ) {
    this.db = openLifecycleDb(dataDir);
    this.blobDir = path.join(dataDir, 'workspace-trash-blobs');
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.retentionMs = opts.retentionMs ?? TRASH_RETENTION_MS;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  private blobPathFor(id: string): string {
    return path.join(this.blobDir, id, 'blob');
  }

  private insert(item: TrashItem): void {
    this.db
      .prepare(
        `INSERT INTO trash_items (id, scope, root, original_path, name, is_dir, size, mime_type, upload_id, trashed_by, trashed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.scope,
        item.root,
        item.originalPath,
        item.name,
        item.isDir ? 1 : 0,
        item.size,
        item.mimeType ?? null,
        item.uploadId ?? null,
        item.trashedBy,
        item.trashedAt,
        item.expiresAt,
      );
  }

  /**
   * Soft-delete a workspace file/dir: move its bytes into the trash blob
   * area and record metadata. `relPath` is workspace-relative and confined
   * (traversal / symlink escape rejected via confineFile).
   */
  trashWorkspaceFile(workspaceRoot: string, relPath: string, trashedBy = ''): TrashItem {
    const abs = confineFile(workspaceRoot, relPath);
    const stat = fs.statSync(abs); // throws ENOENT for a missing file
    const isDir = stat.isDirectory();
    if (!isDir && !stat.isFile()) throw new Error(`not a file or directory: ${relPath}`);
    const now = this.nowFn();
    const item: TrashItem = {
      id: randomUUID(),
      scope: 'workspace',
      root: path.resolve(workspaceRoot),
      originalPath: relPath.split(path.sep).join('/'),
      name: path.basename(relPath),
      isDir,
      size: isDir ? dirSizeBytes(abs) : stat.size,
      trashedBy: trashedBy.slice(0, 100),
      trashedAt: now,
      expiresAt: now + this.retentionMs,
    };
    movePath(abs, this.blobPathFor(item.id));
    try {
      this.insert(item);
    } catch (err) {
      // Roll the bytes back so a DB failure never loses the file.
      try {
        movePath(this.blobPathFor(item.id), abs);
      } catch {
        /* best effort */
      }
      throw err;
    }
    return item;
  }

  /**
   * Soft-delete a chat upload (files stored as `<uploadId>-<name>` under
   * the uploads dir, with a `<file>.meta.json` sidecar). The extracted-text
   * sidecar is regenerable and is dropped; name/mime are kept in metadata
   * so restore can rebuild the sidecar.
   */
  trashUploadFile(uploadsDir: string, uploadId: string, trashedBy = ''): TrashItem {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error(`invalid upload id: ${uploadId}`);
    const entries = fs.readdirSync(uploadsDir);
    const match = entries.find((f) => f.startsWith(`${uploadId}-`) && !f.endsWith('.meta.json') && !f.endsWith('.extracted.txt'));
    if (!match) throw new Error(`upload not found: ${uploadId}`);
    const abs = path.join(uploadsDir, match);
    const stat = fs.statSync(abs);
    let name = match.slice(uploadId.length + 1);
    let mimeType: string | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(`${abs}.meta.json`, 'utf8')) as { name?: string; mimeType?: string };
      if (meta.name) name = meta.name;
      if (meta.mimeType) mimeType = meta.mimeType;
    } catch {
      /* sidecar optional */
    }
    const now = this.nowFn();
    const item: TrashItem = {
      id: randomUUID(),
      scope: 'upload',
      root: path.resolve(uploadsDir),
      originalPath: match,
      name,
      isDir: false,
      size: stat.size,
      mimeType,
      uploadId,
      trashedBy: trashedBy.slice(0, 100),
      trashedAt: now,
      expiresAt: now + this.retentionMs,
    };
    movePath(abs, this.blobPathFor(item.id));
    for (const suffix of ['.meta.json', '.extracted.txt']) {
      try {
        fs.unlinkSync(`${abs}${suffix}`);
      } catch {
        /* ignore */
      }
    }
    try {
      this.insert(item);
    } catch (err) {
      try {
        movePath(this.blobPathFor(item.id), abs);
      } catch {
        /* best effort */
      }
      throw err;
    }
    return item;
  }

  list(scope?: TrashScope): TrashItem[] {
    const rows = (
      scope
        ? this.db.prepare('SELECT * FROM trash_items WHERE scope = ? ORDER BY trashed_at DESC').all(scope)
        : this.db.prepare('SELECT * FROM trash_items ORDER BY trashed_at DESC').all()
    ) as unknown as TrashRow[];
    return rows.map(rowToItem);
  }

  get(id: string): TrashItem | undefined {
    const row = this.db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id) as unknown as TrashRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  /** Move a trashed item back to its original location. Fails when the destination already exists. */
  restore(id: string): TrashItem {
    const item = this.get(id);
    if (!item) throw new Error(`unknown trash item: ${id}`);
    const blob = this.blobPathFor(id);
    if (!fs.existsSync(blob)) throw new Error(`trash blob missing for item: ${id}`);
    let dest: string;
    if (item.scope === 'workspace') {
      dest = confineFile(item.root, item.originalPath);
    } else {
      dest = path.join(item.root, item.originalPath);
      // Stored upload names are server-generated (`<uuid>-<name>`); refuse
      // anything that would escape the uploads dir anyway.
      if (path.dirname(dest) !== path.resolve(item.root)) throw new Error('upload restore path escapes uploads dir');
    }
    if (fs.existsSync(dest)) throw new Error(`cannot restore: "${item.originalPath}" already exists`);
    movePath(blob, dest);
    if (item.scope === 'upload') {
      const meta = {
        id: item.uploadId,
        name: item.name,
        size: item.size,
        mimeType: item.mimeType ?? 'application/octet-stream',
        uploadedAt: new Date(item.trashedAt).toISOString(),
        restoredFromTrashAt: new Date(this.nowFn()).toISOString(),
      };
      try {
        fs.writeFileSync(`${dest}.meta.json`, JSON.stringify(meta));
      } catch {
        /* sidecar is best-effort */
      }
    }
    this.db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
    try {
      fs.rmdirSync(path.join(this.blobDir, id));
    } catch {
      /* ignore */
    }
    return item;
  }

  /** Permanent delete: destroy retained bytes + metadata. */
  permanentDelete(id: string): TrashItem {
    const item = this.get(id);
    if (!item) throw new Error(`unknown trash item: ${id}`);
    fs.rmSync(path.join(this.blobDir, id), { recursive: true, force: true });
    this.db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
    return item;
  }

  /**
   * Retention sweep: permanently delete every item whose retention has
   * expired at `now`. Host-schedulable — call from a daily routine or the
   * POST /trash/purge endpoint. Returns what was purged.
   */
  purgeExpired(now: number = this.nowFn()): { purged: number; items: TrashItem[] } {
    const rows = this.db
      .prepare('SELECT * FROM trash_items WHERE expires_at <= ? ORDER BY expires_at ASC')
      .all(now) as unknown as TrashRow[];
    const items = rows.map(rowToItem);
    for (const item of items) this.permanentDelete(item.id);
    return { purged: items.length, items };
  }
}

/** Standalone purge entry point for host schedulers (no HTTP, no store kept open by the caller). */
export function runTrashPurge(dataDir: string, now: number = Date.now()): { purged: number; items: TrashItem[] } {
  return new TrashStore(dataDir).purgeExpired(now);
}

// ---------------------------------------------------------------------------
// Routes — mount on a router at /api/files (paths are /trash…)
// ---------------------------------------------------------------------------

export interface WorkspaceTrashDeps {
  dataDir: string;
  /** Shared/global workspace root, or a resolver for it. */
  workspaceRoot: string | (() => string);
  /** Chat uploads dir (defaults to <dataDir>/uploads). */
  uploadsDir?: string;
  store?: TrashStore;
  governance?: LifecycleGovernance;
}

export function registerWorkspaceTrashRoutes(router: Router, deps: WorkspaceTrashDeps): void {
  const store = deps.store ?? new TrashStore(deps.dataDir);
  const auditLog = new LifecycleAuditLog(deps.dataDir);
  const uploadsDir = deps.uploadsDir ?? path.join(deps.dataDir, 'uploads');
  const root = (): string => (typeof deps.workspaceRoot === 'function' ? deps.workspaceRoot() : deps.workspaceRoot);
  const fail = (res: Response, err: unknown, fallback: string): void => {
    const message = err instanceof Error ? err.message : fallback;
    const status = /unknown trash item|upload not found/.test(message)
      ? 404
      : /escapes|already exists|invalid upload id/.test(message)
        ? 409
        : /ENOENT|no such file/.test(message)
          ? 404
          : 400;
    res.status(status).json({ error: message });
  };

  router.get('/trash', (req: Request, res: Response) => {
    const scope = req.query.scope === 'workspace' || req.query.scope === 'upload' ? req.query.scope : undefined;
    res.json({ ok: true, items: store.list(scope), retentionDays: TRASH_RETENTION_DAYS });
  });

  router.post('/trash', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { path?: unknown; uploadId?: unknown; actor?: unknown };
      const actor = typeof body.actor === 'string' ? body.actor : 'api';
      let item: TrashItem;
      if (typeof body.uploadId === 'string' && body.uploadId) {
        item = store.trashUploadFile(uploadsDir, body.uploadId, actor);
      } else if (typeof body.path === 'string' && body.path) {
        item = store.trashWorkspaceFile(root(), body.path, actor);
      } else {
        res.status(400).json({ error: '"path" (workspace-relative) or "uploadId" is required' });
        return;
      }
      auditLifecycle(deps.governance, auditLog, 'file.trashed', actor, {
        trashId: item.id,
        scope: item.scope,
        path: item.originalPath,
        size: item.size,
        expiresAt: item.expiresAt,
      });
      res.status(201).json({ ok: true, item });
    } catch (err) {
      fail(res, err, 'failed to trash file');
    }
  });

  router.post('/trash/purge', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { now?: unknown; actor?: unknown };
      const now = typeof body.now === 'number' ? body.now : Date.now();
      const result = store.purgeExpired(now);
      auditLifecycle(deps.governance, auditLog, 'file.trash_purged', typeof body.actor === 'string' ? body.actor : 'api', {
        purged: result.purged,
        ids: result.items.map((i) => i.id),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      fail(res, err, 'failed to purge trash');
    }
  });

  router.post('/trash/:id/restore', (req: Request, res: Response) => {
    try {
      const item = store.restore(req.params.id);
      auditLifecycle(deps.governance, auditLog, 'file.restored_from_trash', 'api', {
        trashId: item.id,
        scope: item.scope,
        path: item.originalPath,
      });
      res.json({ ok: true, item });
    } catch (err) {
      fail(res, err, 'failed to restore file');
    }
  });

  router.delete('/trash/:id', (req: Request, res: Response) => {
    try {
      const item = store.permanentDelete(req.params.id);
      auditLifecycle(deps.governance, auditLog, 'file.permanently_deleted', 'api', {
        trashId: item.id,
        scope: item.scope,
        path: item.originalPath,
      });
      res.json({ ok: true, item });
    } catch (err) {
      fail(res, err, 'failed to permanently delete file');
    }
  });
}

// Re-export so hosts can mount the trash router standalone in tests.
export { Router };
