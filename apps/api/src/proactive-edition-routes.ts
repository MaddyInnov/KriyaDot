// SPDX-License-Identifier: Apache-2.0
// HTTP routes for proactive editions + pacing (CT-11 / CT-12).
// Register-style: the coordinator mounts createProactiveEditionRouter at
// /api/proactive (see the wave4-calls WIRING note). Does not collide with
// the existing /api/proactive-care routes — editions are a separate router.
//
//   GET  /pacing            → { config, sendsToday, lastSentAt, decision }
//   PUT  /pacing            → set pacing config (waking hours, cap, gap, steering)
//   POST /editions          → build an edition from candidate items (no send)
//   GET  /editions          → editions
//   GET  /editions/:id
//   POST /editions/:id/deliver → pacing-gated delivery
//   POST /publish           → build + deliver in one call (scheduler path)

import { Router } from 'express';
import type { Request, Response } from 'express';
import { ProactiveEditionService, type EditionItemInput } from './proactive-editions.js';

export interface ProactiveEditionRouteDeps { service: ProactiveEditionService }

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function createProactiveEditionRouter(deps: ProactiveEditionRouteDeps): Router {
  const { service } = deps;
  const router = Router();

  router.get('/pacing', (_req: Request, res: Response) => {
    res.json(service.pacingStatus());
  });

  router.put('/pacing', (req: Request, res: Response) => {
    try { res.json({ config: service.setPacingConfig(req.body ?? {}) }); }
    catch (err) { res.status(400).json({ error: errMessage(err, 'invalid pacing config') }); }
  });

  const parseEditionBody = (req: Request): { title: string; items: EditionItemInput[] } => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return {
      title: typeof b.title === 'string' ? b.title : '',
      items: Array.isArray(b.items) ? (b.items as EditionItemInput[]) : [],
    };
  };

  router.post('/editions', (req: Request, res: Response) => {
    try {
      const { edition, excluded } = service.createEdition(parseEditionBody(req));
      res.status(201).json({ edition, excludedCount: excluded.length });
    } catch (err) { res.status(400).json({ error: errMessage(err, 'invalid edition') }); }
  });

  router.get('/editions', (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json({ editions: service.listEditions(Number.isFinite(limit) ? limit : undefined) });
  });

  router.get('/editions/:id', (req: Request, res: Response) => {
    const edition = service.getEdition(req.params.id);
    if (!edition) { res.status(404).json({ error: 'unknown edition' }); return; }
    res.json({ edition });
  });

  router.post('/editions/:id/deliver', async (req: Request, res: Response) => {
    try { res.json({ edition: await service.deliverEdition(req.params.id) }); }
    catch (err) {
      const status = (err as { status?: unknown })?.status === 404 ? 404 : 500;
      res.status(status).json({ error: errMessage(err, 'failed to deliver edition') });
    }
  });

  router.post('/publish', async (req: Request, res: Response) => {
    try {
      const { edition, excluded } = await service.publishEdition(parseEditionBody(req));
      res.status(201).json({ edition, excludedCount: excluded.length });
    } catch (err) { res.status(400).json({ error: errMessage(err, 'invalid edition') }); }
  });

  return router;
}
