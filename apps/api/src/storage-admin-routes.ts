// SPDX-License-Identifier: Apache-2.0
// Storage admin routes for pluggable workspace backends
// (packages/agent-runtime/src/workspace-backends.ts). Router factory —
// the parent mounts it in index.ts:
//
//   import { createStorageAdminRouter } from './storage-admin-routes.js';
//   import { loadWorkspaceBackendsFromEnv } from '@mvp/agent-runtime/dist/workspace-backends.js';
//   const wsBackends = await loadWorkspaceBackendsFromEnv();
//   if (wsBackends) app.use('/api/storage', createStorageAdminRouter({ backends: wsBackends.backends, assignments: wsBackends.assignments }));
//
// Routes (mounted at /api/storage):
//   GET /            → [{ name, kind, assignedBots }]
//   GET /health      → [{ name, kind, ok, detail?, objectCount? }]
//   GET /:name       → { name, kind, objectCount, assignedBots }
//   GET /:name/count → { name, objectCount }
//
// The backend type is structural (the WorkspaceBackend interface), so this
// module has no runtime dependency on the backends module.

import express, { type Request, type Response, type Router } from 'express';

/** Structural subset of WorkspaceBackend used by the admin routes. */
export interface StorageBackendLike {
  readonly kind: string;
  name?: string;
  list(prefix?: string): Promise<string[]>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
}

export interface StorageAdminDeps {
  backends: Map<string, StorageBackendLike> | Record<string, StorageBackendLike>;
  assignments?: Record<string, string>;
}

function toMap(input: StorageAdminDeps['backends']): Map<string, StorageBackendLike> {
  return input instanceof Map ? input : new Map(Object.entries(input));
}

export function createStorageAdminRouter(deps: StorageAdminDeps): Router {
  const backends = toMap(deps.backends);
  const assignments = deps.assignments ?? {};
  const botsFor = (name: string): string[] =>
    Object.entries(assignments)
      .filter(([, backend]) => backend === name)
      .map(([botId]) => botId)
      .sort();

  const router = express.Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      backends: [...backends.entries()].map(([name, b]) => ({
        name,
        kind: b.kind,
        assignedBots: botsFor(name),
      })),
    });
  });

  router.get('/health', async (_req: Request, res: Response) => {
    const results: Array<{ name: string; kind: string; ok: boolean; detail?: string; objectCount?: number }> = [];
    for (const [name, b] of backends.entries()) {
      try {
        const health = b.health ? await b.health() : { ok: true };
        let objectCount: number | undefined;
        if (health.ok) {
          try {
            objectCount = (await b.list('')).length;
          } catch {
            objectCount = undefined;
          }
        }
        results.push({ name, kind: b.kind, ok: health.ok, detail: health.detail, objectCount });
      } catch (err) {
        results.push({ name, kind: b.kind, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
    res.json({ backends: results });
  });

  router.get('/:name/count', async (req: Request, res: Response) => {
    const backend = backends.get(req.params.name);
    if (!backend) {
      res.status(404).json({ error: `unknown storage backend: ${req.params.name}` });
      return;
    }
    try {
      const objects = await backend.list('');
      res.json({ name: req.params.name, objectCount: objects.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/:name', async (req: Request, res: Response) => {
    const backend = backends.get(req.params.name);
    if (!backend) {
      res.status(404).json({ error: `unknown storage backend: ${req.params.name}` });
      return;
    }
    try {
      const objects = await backend.list('');
      res.json({
        name: req.params.name,
        kind: backend.kind,
        objectCount: objects.length,
        assignedBots: botsFor(req.params.name),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
