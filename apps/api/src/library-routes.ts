// SPDX-License-Identifier: Apache-2.0
// Library routes (C-15 / FL-11 / FL-14) — register-style, host-mounted.
//
//   GET  /library                 unified items (?q=&kind=artifact|deck|media|file|all)
//   GET  /library/system-files    FL-11 metadata-only data-dir listing
//   PUT  /library/artifacts/:id   FL-14 in-viewer markdown edit → new version
//   PUT  /library/decks/:id       FL-14 in-viewer deck edit (title/slides)
//
// HOST WIRING (see wave5-chat-surfaces-WIRING.md): mount at /api with the
// SAME ArtifactStore / SlideDeckStore instances muse-modules.ts uses —
// pass factories that construct them over the shared ModuleDb so edits
// land in the one store, never a copy.

import express, { type Router } from 'express';
import { buildLibraryItems, filterLibraryItems, listSystemFiles, type LibrarySources } from './library.js';
import { listWorkspaceFiles } from './files.js';

export interface LibraryArtifactStore {
  list(): Array<{ id: string; title: string; version: number; content: string; updatedAt: number }>;
  get(id: string): { id: string; title: string; version: number; content: string; updatedAt: number };
  update(id: string, content: string): { id: string; title: string; version: number; content: string; updatedAt: number };
}
export interface LibraryDeckStore {
  list(): Array<{ id: string; title: string; slides: unknown[]; updatedAt: number }>;
  update(id: string, input: { title?: string; slides?: Array<Record<string, unknown>> }): unknown;
}

export interface LibraryRouteDeps {
  dataDir: string;
  workspaceDir: string;
  artifacts: LibraryArtifactStore;
  decks: LibraryDeckStore;
  /** Media assets generated this process (the media store is provider-side). */
  media?: LibrarySources['media'];
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

function err(res: express.Response, status: number, error: string): void {
  res.status(status).json({ ok: false, error });
}
function statusFor(e: unknown): number {
  const name = (e as { name?: string })?.name;
  if (name === 'NotFoundError') return 404;
  if (name === 'ValidationError') return 400;
  return 500;
}

export function createLibraryRouter(deps: LibraryRouteDeps): Router {
  const router = express.Router();
  const sources: LibrarySources = {
    artifacts: () => deps.artifacts.list(),
    decks: () => deps.decks.list() as LibrarySources['decks'] extends () => infer R ? R : never,
    media: deps.media ?? (() => []),
    files: () => listWorkspaceFiles(deps.workspaceDir) as LibrarySources['files'] extends () => infer R ? R : never,
  };

  router.get('/library', (req, res) => {
    try {
      const items = filterLibraryItems(
        buildLibraryItems(sources),
        typeof req.query.q === 'string' ? req.query.q : undefined,
        typeof req.query.kind === 'string' ? req.query.kind : undefined,
      );
      res.json({ ok: true, items, counts: {
        artifact: items.filter((i) => i.kind === 'artifact').length,
        deck: items.filter((i) => i.kind === 'deck').length,
        media: items.filter((i) => i.kind === 'media').length,
        file: items.filter((i) => i.kind === 'file').length,
      } });
    } catch (e) {
      err(res, 500, e instanceof Error ? e.message : 'failed to build library');
    }
  });

  // FL-11 — System Files view (metadata only; contents never served here).
  router.get('/library/system-files', (_req, res) => {
    res.json({ ok: true, files: listSystemFiles(deps.dataDir), dataDirName: 'instance-data' });
  });

  // FL-14 — in-viewer markdown artifact edit: saves as a NEW version via
  // the owning store (version history is preserved by ArtifactStore).
  router.put('/library/artifacts/:id', (req, res) => {
    const content = (req.body as { content?: unknown })?.content;
    if (typeof content !== 'string' || !content.trim()) { err(res, 400, 'content (markdown) is required'); return; }
    try {
      const updated = deps.artifacts.update(req.params.id, content);
      deps.audit?.('library.artifact_edit', { detail: { artifactId: req.params.id, version: updated.version } });
      res.json({ ok: true, artifact: updated });
    } catch (e) {
      err(res, statusFor(e), e instanceof Error ? e.message : 'edit failed');
    }
  });

  // FL-14 — in-viewer deck edit: title and/or slides through the owning
  // store's validation (layouts, caps) — no parallel deck format.
  router.put('/library/decks/:id', (req, res) => {
    const body = (req.body ?? {}) as { title?: unknown; slides?: unknown };
    if (body.title !== undefined && typeof body.title !== 'string') { err(res, 400, 'title must be a string'); return; }
    if (body.slides !== undefined && !Array.isArray(body.slides)) { err(res, 400, 'slides must be an array'); return; }
    try {
      const updated = deps.decks.update(req.params.id, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(Array.isArray(body.slides) ? { slides: body.slides as Array<Record<string, unknown>> } : {}),
      });
      deps.audit?.('library.deck_edit', { detail: { deckId: req.params.id } });
      res.json({ ok: true, deck: updated });
    } catch (e) {
      err(res, statusFor(e), e instanceof Error ? e.message : 'edit failed');
    }
  });

  return router;
}
