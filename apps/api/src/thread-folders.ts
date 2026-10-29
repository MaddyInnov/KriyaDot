// SPDX-License-Identifier: Apache-2.0
// Thread folders (chat polish): named folders per bot; threads are
// assigned to at most one folder. JSON persistence under dataDir.
//
// HOST WIRING (parent):
//   app.use('/api', createThreadFoldersRouter({ dataDir: config.dataDir,
//     audit: (a, f) => governance.audit(a, f) }));
// Routes: GET/POST /thread-folders · PATCH/DELETE /thread-folders/:id
//         PUT/DELETE /thread-folders/:id/threads/:threadId
//         GET /thread-folders/:id/threads

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

export interface ThreadFolder { id: string; botId: string; name: string; createdAt: number }

interface FoldersFile { folders: ThreadFolder[]; assignments: Record<string, string> }

export class ThreadFolderStore {
  private data: FoldersFile = { folders: [], assignments: {} };
  constructor(private readonly dataDir?: string) {
    if (dataDir) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'thread-folders.json'), 'utf8')) as FoldersFile;
        if (parsed && Array.isArray(parsed.folders)) this.data = { folders: parsed.folders, assignments: parsed.assignments ?? {} };
      } catch { /* start empty */ }
    }
  }
  private save(): void {
    if (!this.dataDir) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, 'thread-folders.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(this.dataDir, 'thread-folders.json'));
  }
  list(botId?: string): ThreadFolder[] {
    return this.data.folders.filter((f) => !botId || f.botId === botId);
  }
  get(id: string): ThreadFolder | undefined { return this.data.folders.find((f) => f.id === id); }
  create(input: { botId: string; name: string }): ThreadFolder {
    const name = input.name.trim();
    if (!name) throw new Error('name is required');
    if (!input.botId.trim()) throw new Error('botId is required');
    const folder: ThreadFolder = { id: `folder_${randomUUID().replace(/-/g, '').slice(0, 16)}`, botId: input.botId, name: name.slice(0, 80), createdAt: Date.now() };
    this.data.folders.push(folder); this.save(); return folder;
  }
  rename(id: string, name: string): ThreadFolder | undefined {
    const f = this.get(id); if (!f) return undefined;
    const n = name.trim(); if (!n) throw new Error('name is required');
    f.name = n.slice(0, 80); this.save(); return f;
  }
  remove(id: string): boolean {
    const before = this.data.folders.length;
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    if (this.data.folders.length === before) return false;
    for (const [t, fid] of Object.entries(this.data.assignments)) if (fid === id) delete this.data.assignments[t];
    this.save(); return true;
  }
  assign(folderId: string, threadId: string): boolean {
    if (!this.get(folderId)) return false;
    this.data.assignments[threadId] = folderId; this.save(); return true;
  }
  unassign(folderId: string, threadId: string): boolean {
    if (this.data.assignments[threadId] !== folderId) return false;
    delete this.data.assignments[threadId]; this.save(); return true;
  }
  folderOf(threadId: string): string | undefined { return this.data.assignments[threadId]; }
  threadsIn(folderId: string): string[] {
    return Object.entries(this.data.assignments).filter(([, f]) => f === folderId).map(([t]) => t);
  }
}

export function createThreadFoldersRouter(deps: { dataDir?: string; store?: ThreadFolderStore; audit?: (a: string, f: Record<string, unknown>) => void }): express.Router {
  const store = deps.store ?? new ThreadFolderStore(deps.dataDir);
  const router = express.Router();
  const bad = (res: express.Response, s: number, e: string) => res.status(s).json({ ok: false, error: e });

  router.get('/thread-folders', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
    res.json({ ok: true, folders: store.list(botId).map((f) => ({ ...f, threadIds: store.threadsIn(f.id) })) });
  });
  router.post('/thread-folders', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const folder = store.create({ botId: typeof b.botId === 'string' ? b.botId : '', name: typeof b.name === 'string' ? b.name : '' });
      deps.audit?.('chat.folder_create', { detail: { folderId: folder.id, botId: folder.botId } });
      res.status(201).json({ ok: true, folder });
    } catch (e) { bad(res, 400, e instanceof Error ? e.message : String(e)); }
  });
  router.patch('/thread-folders/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const folder = store.rename(req.params.id, typeof b.name === 'string' ? b.name : '');
      if (!folder) { bad(res, 404, 'folder not found'); return; }
      res.json({ ok: true, folder });
    } catch (e) { bad(res, 400, e instanceof Error ? e.message : String(e)); }
  });
  router.delete('/thread-folders/:id', (req, res) => {
    if (!store.remove(req.params.id)) { bad(res, 404, 'folder not found'); return; }
    deps.audit?.('chat.folder_delete', { detail: { folderId: req.params.id } });
    res.json({ ok: true, deleted: req.params.id });
  });
  router.get('/thread-folders/:id/threads', (req, res) => {
    if (!store.get(req.params.id)) { bad(res, 404, 'folder not found'); return; }
    res.json({ ok: true, folderId: req.params.id, threadIds: store.threadsIn(req.params.id) });
  });
  router.put('/thread-folders/:id/threads/:threadId', (req, res) => {
    if (!store.assign(req.params.id, req.params.threadId)) { bad(res, 404, 'folder not found'); return; }
    res.json({ ok: true, folderId: req.params.id, threadId: req.params.threadId });
  });
  router.delete('/thread-folders/:id/threads/:threadId', (req, res) => {
    if (!store.unassign(req.params.id, req.params.threadId)) { bad(res, 404, 'thread is not in this folder'); return; }
    res.json({ ok: true, removed: true });
  });
  return router;
}
