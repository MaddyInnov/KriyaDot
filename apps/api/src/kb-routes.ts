// SPDX-License-Identifier: Apache-2.0
// Managed knowledge-base HTTP routes (see kb.ts). Router factory — the
// parent mounts it in index.ts:
//
//   import { createKbRouter } from './kb-routes.js';
//   app.use('/api/kb', createKbRouter({ dataDir: config.dataDir }));
//
// Actor identity: `x-user-id` header (default 'default-user', matching the
// single-user loopback convention elsewhere) and optional `x-org-id`.
// Sharing (owner-only share/unshare; read | contribute roles) is enforced
// inside KbStore on every route — these handlers only translate HTTP.
//
// Routes (mounted at /api/kb):
//   POST   /                              create corpus
//   GET    /                              list corpora visible to the actor
//   GET    /search?q=&kbId=&topK=         cited search across visible corpora
//   GET    /:id                           corpus detail
//   PATCH  /:id                           owner update (limits, embeddingProvider…)
//   DELETE /:id                           owner delete
//   POST   /:id/folders                   { name, parentId? } (contribute)
//   POST   /:id/share                     { principalType, principalId, role } (owner)
//   POST   /:id/unshare                   { principalType, principalId } (owner)
//   GET    /:id/documents                 list documents (read)
//   POST   /:id/documents                 { title, text, fileName?, folderId? } (contribute)
//   GET    /:id/documents/:docId          document incl. original + edited text (read)
//   PUT    /:id/documents/:docId          { editedText } (contribute)
//   DELETE /:id/documents/:docId          (contribute)
//   GET    /:id/search?q=&topK=           cited search in this corpus

import express, { type Request, type Response, type Router } from 'express';
import { KbStore, type KbActor } from './kb.js';

export interface KbRouterDeps {
  dataDir: string;
  store?: KbStore;
}

export function actorFromRequest(req: Request): KbActor {
  const userId = (req.header('x-user-id') ?? '').trim() || 'default-user';
  const orgId = (req.header('x-org-id') ?? '').trim() || undefined;
  return { userId, orgId };
}

function fail(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = message.startsWith('unknown ')
    ? 404
    : /access is required|only the owner|not shared/.test(message)
      ? 403
      : /required|limit|must/.test(message)
        ? 400
        : 403;
  res.status(status).json({ error: message });
}

export function createKbRouter(deps: KbRouterDeps): Router {
  const store = deps.store ?? new KbStore(deps.dataDir);
  const router = express.Router();

  router.post('/', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const corpus = store.createCorpus(actorFromRequest(req), {
        name: String(body.name ?? ''),
        description: typeof body.description === 'string' ? body.description : undefined,
        maxDocs: typeof body.maxDocs === 'number' ? body.maxDocs : undefined,
        maxBytes: typeof body.maxBytes === 'number' ? body.maxBytes : undefined,
        embeddingProvider: body.embeddingProvider === 'neural' ? 'neural' : 'local',
      });
      res.status(201).json(corpus);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/', (req: Request, res: Response) => {
    try {
      res.json({ corpora: store.listCorpora(actorFromRequest(req)) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/search', (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const kbId = typeof req.query.kbId === 'string' ? req.query.kbId : undefined;
      const topK = typeof req.query.topK === 'string' ? Number(req.query.topK) : undefined;
      res.json({ citations: store.search(actorFromRequest(req), q, { kbId, topK }) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    try {
      res.json(store.getCorpus(actorFromRequest(req), req.params.id));
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/:id', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(
        store.updateCorpus(actorFromRequest(req), req.params.id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          maxDocs: typeof body.maxDocs === 'number' ? body.maxDocs : undefined,
          maxBytes: typeof body.maxBytes === 'number' ? body.maxBytes : undefined,
          embeddingProvider:
            body.embeddingProvider === 'neural' || body.embeddingProvider === 'local'
              ? body.embeddingProvider
              : undefined,
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      store.deleteCorpus(actorFromRequest(req), req.params.id);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/folders', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const folder = store.addFolder(
        actorFromRequest(req),
        req.params.id,
        String(body.name ?? ''),
        typeof body.parentId === 'string' ? body.parentId : null,
      );
      res.status(201).json(folder);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/share', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const corpus = store.share(actorFromRequest(req), req.params.id, {
        principalType: body.principalType === 'org' ? 'org' : 'user',
        principalId: String(body.principalId ?? ''),
        role: body.role === 'contribute' ? 'contribute' : 'read',
      });
      res.json(corpus);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/unshare', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const corpus = store.unshare(
        actorFromRequest(req),
        req.params.id,
        body.principalType === 'org' ? 'org' : 'user',
        String(body.principalId ?? ''),
      );
      res.json(corpus);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/documents', (req: Request, res: Response) => {
    try {
      res.json({ documents: store.listDocuments(actorFromRequest(req), req.params.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/documents', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const doc = store.addDocument(actorFromRequest(req), req.params.id, {
        title: String(body.title ?? ''),
        text: String(body.text ?? ''),
        fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
        folderId: typeof body.folderId === 'string' ? body.folderId : null,
      });
      res.status(201).json(doc);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/documents/:docId', (req: Request, res: Response) => {
    try {
      res.json(store.getDocument(actorFromRequest(req), req.params.id, req.params.docId));
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/:id/documents/:docId', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(
        store.editDocument(actorFromRequest(req), req.params.id, req.params.docId, String(body.editedText ?? '')),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/:id/documents/:docId', (req: Request, res: Response) => {
    try {
      store.deleteDocument(actorFromRequest(req), req.params.id, req.params.docId);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/search', (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const topK = typeof req.query.topK === 'string' ? Number(req.query.topK) : undefined;
      res.json({
        citations: store.search(actorFromRequest(req), q, { kbId: req.params.id, topK }),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
