// SPDX-License-Identifier: Apache-2.0
// FL-12 — File metadata operations: pin / unpin, rename, manual reorder.
//
// Organisation state lives on file records in file-lifecycle.db
// (`file_meta`, keyed by workspace root + workspace-relative path):
//   - pinned: pinned files sort first in the Library / files panel.
//   - sortOrder: manual order within a directory listing (lower first);
//     assigned by the reorder endpoint as 0..n for the submitted order.
//   - displayName: an optional label override kept on the record (the
//     rename endpoint performs the real on-disk rename AND migrates the
//     metadata rows, including children of a renamed directory).
//
// listWorkspaceFiles() consumers can pass the metadata map through
// annotateFileNodes() (files.ts) to get pinned/sortOrder on each node and
// pinned-first, manual-order sorting. The Library worker (FL-11/FL-15)
// consumes these endpoints + fields; the files panel already shows a pin
// toggle and a rename action.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { confineFile, type FileNode } from './files.js';

export interface FileMeta {
  relPath: string;
  pinned: boolean;
  sortOrder?: number;
  displayName?: string;
  updatedAt: number;
}

interface FileMetaRow {
  rel_path: string;
  pinned: number;
  sort_order: number | null;
  display_name: string | null;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS file_meta (
    workspace_root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    display_name TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_root, rel_path)
  );
`;

function rowToMeta(r: FileMetaRow): FileMeta {
  return {
    relPath: r.rel_path,
    pinned: r.pinned === 1,
    sortOrder: r.sort_order ?? undefined,
    displayName: r.display_name ?? undefined,
    updatedAt: r.updated_at,
  };
}

function normalizeRel(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

export class FileMetaStore {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = openSqliteDb(path.join(dataDir, 'file-lifecycle.db'));
    this.db.exec(SCHEMA);
  }

  get(workspaceRoot: string, relPath: string): FileMeta | undefined {
    const row = this.db
      .prepare('SELECT * FROM file_meta WHERE workspace_root = ? AND rel_path = ?')
      .get(path.resolve(workspaceRoot), normalizeRel(relPath)) as unknown as FileMetaRow | undefined;
    return row ? rowToMeta(row) : undefined;
  }

  /** All metadata for one workspace root, keyed by relPath. */
  mapForRoot(workspaceRoot: string): Map<string, FileMeta> {
    const rows = this.db
      .prepare('SELECT * FROM file_meta WHERE workspace_root = ?')
      .all(path.resolve(workspaceRoot)) as unknown as FileMetaRow[];
    return new Map(rows.map((r) => [r.rel_path, rowToMeta(r)]));
  }

  listForRoot(workspaceRoot: string): FileMeta[] {
    return [...this.mapForRoot(workspaceRoot).values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  private upsert(workspaceRoot: string, relPath: string, patch: Partial<Omit<FileMeta, 'relPath' | 'updatedAt'>>): FileMeta {
    const root = path.resolve(workspaceRoot);
    const rel = normalizeRel(relPath);
    const current = this.get(root, rel);
    const next: FileMeta = {
      relPath: rel,
      pinned: patch.pinned ?? current?.pinned ?? false,
      sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : current?.sortOrder,
      displayName: patch.displayName !== undefined ? patch.displayName : current?.displayName,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO file_meta (workspace_root, rel_path, pinned, sort_order, display_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_root, rel_path) DO UPDATE SET pinned = excluded.pinned, sort_order = excluded.sort_order, display_name = excluded.display_name, updated_at = excluded.updated_at`,
      )
      .run(root, rel, next.pinned ? 1 : 0, next.sortOrder ?? null, next.displayName ?? null, next.updatedAt);
    return next;
  }

  setPinned(workspaceRoot: string, relPath: string, pinned: boolean): FileMeta {
    return this.upsert(workspaceRoot, relPath, { pinned });
  }

  setDisplayName(workspaceRoot: string, relPath: string, displayName: string | undefined): FileMeta {
    const clean = displayName === undefined ? undefined : displayName.trim().slice(0, 200);
    return this.upsert(workspaceRoot, relPath, { displayName: clean || undefined });
  }

  /**
   * Persist a manual order for the given paths (index = sortOrder).
   * Paths not listed keep their previous order values.
   */
  reorder(workspaceRoot: string, orderedPaths: string[]): FileMeta[] {
    if (!Array.isArray(orderedPaths) || orderedPaths.length === 0) {
      throw new Error('"paths" must be a non-empty array of workspace-relative paths');
    }
    if (orderedPaths.length > 2000) throw new Error('"paths" exceeds 2000 entries');
    return orderedPaths.map((p, i) => {
      if (typeof p !== 'string' || !p) throw new Error('"paths" entries must be non-empty strings');
      return this.upsert(workspaceRoot, p, { sortOrder: i });
    });
  }

  /**
   * Rename on disk (confinement-checked) and migrate metadata: the file's
   * own row moves to the new path, and so do rows for children when a
   * directory is renamed. Returns the new metadata (if any existed).
   */
  rename(workspaceRoot: string, fromRel: string, toRel: string): { from: string; to: string; meta?: FileMeta } {
    const from = normalizeRel(fromRel);
    const to = normalizeRel(toRel);
    if (!from || !to) throw new Error('rename "from" and "to" are required');
    if (from === to) throw new Error('rename "from" and "to" are identical');
    const fromAbs = confineFile(workspaceRoot, from);
    const toAbs = confineFile(workspaceRoot, to);
    if (!fs.existsSync(fromAbs)) throw new Error(`file not found: ${from}`);
    if (fs.existsSync(toAbs)) throw new Error(`cannot rename: "${to}" already exists`);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    const root = path.resolve(workspaceRoot);
    const rows = this.db
      .prepare('SELECT * FROM file_meta WHERE workspace_root = ? AND (rel_path = ? OR rel_path LIKE ?)')
      .all(root, from, `${from}/%`) as unknown as FileMetaRow[];
    for (const row of rows) {
      const nextRel = to + row.rel_path.slice(from.length);
      this.db.prepare('DELETE FROM file_meta WHERE workspace_root = ? AND rel_path = ?').run(root, row.rel_path);
      this.db
        .prepare(
          'INSERT OR REPLACE INTO file_meta (workspace_root, rel_path, pinned, sort_order, display_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(root, nextRel, row.pinned, row.sort_order, row.display_name, Date.now());
    }
    return { from, to, meta: this.get(root, to) };
  }

  /** Drop metadata for a path (and children). Used when a file is permanently deleted. */
  removeForPath(workspaceRoot: string, relPath: string): number {
    const root = path.resolve(workspaceRoot);
    const rel = normalizeRel(relPath);
    const r = this.db
      .prepare('DELETE FROM file_meta WHERE workspace_root = ? AND (rel_path = ? OR rel_path LIKE ?)')
      .run(root, rel, `${rel}/%`);
    return Number(r.changes);
  }
}

/**
 * Apply a metadata map to a FileNode tree: stamps pinned/sortOrder/
 * displayName onto nodes and re-sorts each level pinned-first, then by
 * manual sortOrder, then directories-first + name (the files.ts default).
 */
export function applyFileMeta(nodes: FileNode[], meta: Map<string, FileMeta>): FileNode[] {
  const apply = (list: FileNode[]): FileNode[] => {
    const stamped = list.map((n) => {
      const m = meta.get(n.path);
      const node: FileNode = { ...n };
      if (m) {
        node.pinned = m.pinned;
        node.sortOrder = m.sortOrder;
        if (m.displayName) node.displayName = m.displayName;
      }
      if (node.children) node.children = apply(node.children);
      return node;
    });
    stamped.sort((a, b) => {
      if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) return a.pinned ? -1 : 1;
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return stamped;
  };
  return apply(nodes);
}

// ---------------------------------------------------------------------------
// Routes — mount on a router at /api/files (paths are /meta…)
// ---------------------------------------------------------------------------

export interface FileMetaDeps {
  dataDir: string;
  workspaceRoot: string | (() => string);
  store?: FileMetaStore;
}

export function registerFileMetaRoutes(router: Router, deps: FileMetaDeps): void {
  const store = deps.store ?? new FileMetaStore(deps.dataDir);
  const root = (): string => (typeof deps.workspaceRoot === 'function' ? deps.workspaceRoot() : deps.workspaceRoot);
  const fail = (res: Response, err: unknown, fallback: string): void => {
    const message = err instanceof Error ? err.message : fallback;
    const status = /escapes/.test(message) ? 403 : /not found/.test(message) ? 404 : /already exists/.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  };

  router.get('/meta', (req: Request, res: Response) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rel) {
      res.json({ ok: true, meta: store.listForRoot(root()) });
      return;
    }
    res.json({ ok: true, meta: store.get(root(), rel) ?? null });
  });

  router.patch('/meta', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { path?: unknown; pinned?: unknown; displayName?: unknown };
      if (typeof body.path !== 'string' || !body.path) {
        res.status(400).json({ error: '"path" is required' });
        return;
      }
      // The file must exist — metadata for ghosts would rot silently.
      confineFile(root(), body.path);
      if (!fs.existsSync(confineFile(root(), body.path))) {
        res.status(404).json({ error: `file not found: ${body.path}` });
        return;
      }
      let meta = store.get(root(), body.path);
      if (typeof body.pinned === 'boolean') meta = store.setPinned(root(), body.path, body.pinned);
      if (typeof body.displayName === 'string' || body.displayName === null) {
        meta = store.setDisplayName(root(), body.path, body.displayName === null ? undefined : body.displayName);
      }
      res.json({ ok: true, meta: meta ?? store.get(root(), body.path) ?? null });
    } catch (err) {
      fail(res, err, 'failed to update file metadata');
    }
  });

  router.post('/meta/pin', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { path?: unknown; pinned?: unknown };
      if (typeof body.path !== 'string' || !body.path || typeof body.pinned !== 'boolean') {
        res.status(400).json({ error: '"path" and boolean "pinned" are required' });
        return;
      }
      res.json({ ok: true, meta: store.setPinned(root(), body.path, body.pinned) });
    } catch (err) {
      fail(res, err, 'failed to pin file');
    }
  });

  router.post('/meta/rename', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
      if (typeof body.from !== 'string' || typeof body.to !== 'string') {
        res.status(400).json({ error: '"from" and "to" are required' });
        return;
      }
      res.json({ ok: true, ...store.rename(root(), body.from, body.to) });
    } catch (err) {
      fail(res, err, 'failed to rename file');
    }
  });

  router.post('/meta/reorder', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { paths?: unknown };
      const meta = store.reorder(root(), body.paths as string[]);
      res.json({ ok: true, meta });
    } catch (err) {
      fail(res, err, 'failed to reorder files');
    }
  });
}
