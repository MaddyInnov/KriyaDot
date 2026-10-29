// SPDX-License-Identifier: Apache-2.0
/**
 * Context-budget route (item 5).
 * HOST WIRING: app.use('/api', createContextBudgetRouter({ getContextBudget }))
 *   → GET /api/sessions/:id/context-budget
 */
import express, { type Router } from 'express';
export function createContextBudgetRouter(deps: { getContextBudget: (sessionId: string) => { estimatedTokens: number; budget: number; ratio: number; level: string } }): Router {
  const router = express.Router();
  router.get('/sessions/:id/context-budget', (req, res) => {
    try { res.json({ ok: true, ...deps.getContextBudget(req.params.id) }); }
    catch (e) { res.status(500).json({ ok:false, error: e instanceof Error ? e.message : String(e) }); }
  });
  return router;
}
