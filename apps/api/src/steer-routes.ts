// SPDX-License-Identifier: Apache-2.0
/**
 * Mid-turn steering routes (item 1).
 * POST /sessions/:id/steer { text } → enqueue a steering message.
 * When a turn is running it is injected at the next model-call boundary;
 * when no turn is running it stays queued and is drained at the start of
 * the next turn for that session (existing queue behaviour, documented
 * in agent-runtime steer.ts).
 * HOST WIRING: app.use('/api', createSteerRouter({ enqueueSteer, isTurnRunning }))
 *   — mount so the path is /api/sessions/:id/steer, or mount at
 *   '/api/sessions' and the route is '/:id/steer'.
 */
import express, { type Router } from 'express';
export interface SteerRouterDeps {
  enqueueSteer: (sessionId: string, text: string) => { id: string; running: boolean; pending: number };
  isTurnRunning?: (sessionId: string) => boolean;
}
export function createSteerRouter(deps: SteerRouterDeps): Router {
  const router = express.Router();
  router.post('/sessions/:id/steer', (req, res) => {
    const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text.trim() : '';
    if (!text) { res.status(400).json({ ok: false, error: 'text is required' }); return; }
    const r = deps.enqueueSteer(req.params.id, text);
    res.status(202).json({ ok: true, steerId: r.id, running: r.running, pending: r.pending, delivery: r.running ? 'next-model-call-boundary' : 'queued-for-next-turn' });
  });
  // Also support mounting at /api/sessions
  router.post('/:id/steer', (req, res) => {
    const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text.trim() : '';
    if (!text) { res.status(400).json({ ok: false, error: 'text is required' }); return; }
    const r = deps.enqueueSteer(req.params.id, text);
    res.status(202).json({ ok: true, steerId: r.id, running: r.running, pending: r.pending, delivery: r.running ? 'next-model-call-boundary' : 'queued-for-next-turn' });
  });
  return router;
}
