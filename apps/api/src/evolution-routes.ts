// SPDX-License-Identifier: Apache-2.0
/**
 * Evolution governance endpoints (#83): the distinct REJECT endpoint the
 * routing-learn surface was missing, alongside promote/rollback mirrors
 * so a client can use one router for all three human decisions.
 *
 *   POST /routing/rules/:id/reject    → mark a candidate REJECTED
 *   POST /routing/rules/:id/promote   → approve (same semantics as the
 *                                       routing-learn router's promote)
 *   POST /routing/rules/:id/rollback  → retire (same as rollback there)
 *
 * Reject is DISTINCT from rollback: rollback retires a rule that was
 * live; reject refuses a shadow candidate that was never promoted.
 * The runtime's rule-status type has no 'rejected' value, so rejections
 * are recorded API-side in <dataDir>/routing-rejections.json (the rule
 * itself is retired in the rules file so it can never match, and this
 * router's responses report status 'rejected' for recorded ids).
 *
 * HOST WIRING (parent): mount at '/api/routing' —
 *   app.use('/api/routing', createEvolutionRouter({ dataDir: config.dataDir }))
 * It coexists with registerRoutingLearnRoutes on the same prefix (the
 * /rules/:id/reject path is new; promote/rollback paths would collide,
 * so mount ONLY this router's reject by using { only: ['reject'] } if
 * the parent prefers a single owner per path).
 */

import fs from 'node:fs';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { loadRoutingRules, promoteRule, retireRule, saveRoutingRules } from '@mvp/agent-runtime';

export interface EvolutionRouterDeps {
  dataDir: string;
  only?: Array<'reject' | 'promote' | 'rollback'>;
}

function rejectionsPath(dataDir: string): string {
  return join(dataDir, 'routing-rejections.json');
}

export function loadRejections(dataDir: string): Record<string, { at: string; reason?: string }> {
  try {
    const parsed = JSON.parse(fs.readFileSync(rejectionsPath(dataDir), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, { at: string; reason?: string }>) : {};
  } catch {
    return {};
  }
}

export function recordRejection(dataDir: string, id: string, reason?: string): void {
  const all = loadRejections(dataDir);
  all[id] = { at: new Date().toISOString(), ...(reason ? { reason } : {}) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(rejectionsPath(dataDir), JSON.stringify(all, null, 2) + '\n', 'utf8');
}

export function createEvolutionRouter(deps: EvolutionRouterDeps): Router {
  const router = express.Router();
  const only = deps.only ?? ['reject', 'promote', 'rollback'];
  const withStatus = (rules: ReturnType<typeof loadRoutingRules>) => {
    const rejected = loadRejections(deps.dataDir);
    return rules.map((r) => (rejected[r.id] ? { ...r, status: 'rejected' as const, rejectedAt: rejected[r.id]!.at } : r));
  };
  const findOr404 = (res: express.Response, id: string) => {
    const rules = loadRoutingRules(deps.dataDir);
    if (!rules.some((r) => r.id === id)) {
      res.status(404).json({ error: `Unknown rule "${id}"` });
      return null;
    }
    return rules;
  };

  if (only.includes('reject')) {
    router.post('/rules/:id/reject', (req, res) => {
      const rules = findOr404(res, req.params.id);
      if (!rules) return;
      const reason = typeof (req.body as { reason?: unknown })?.reason === 'string' ? (req.body as { reason: string }).reason.slice(0, 500) : undefined;
      saveRoutingRules(deps.dataDir, retireRule(rules, req.params.id));
      recordRejection(deps.dataDir, req.params.id, reason);
      res.json({ ok: true, action: 'rejected', id: req.params.id, rules: withStatus(loadRoutingRules(deps.dataDir)) });
    });
  }
  if (only.includes('promote')) {
    router.post('/rules/:id/promote', (req, res) => {
      const rules = findOr404(res, req.params.id);
      if (!rules) return;
      const next = promoteRule(rules, req.params.id);
      saveRoutingRules(deps.dataDir, next);
      res.json({ ok: true, action: 'promoted', id: req.params.id, rules: withStatus(next) });
    });
  }
  if (only.includes('rollback')) {
    router.post('/rules/:id/rollback', (req, res) => {
      const rules = findOr404(res, req.params.id);
      if (!rules) return;
      const next = retireRule(rules, req.params.id);
      saveRoutingRules(deps.dataDir, next);
      res.json({ ok: true, action: 'rolled-back', id: req.params.id, rules: withStatus(next) });
    });
  }
  router.get('/rejections', (_req, res) => {
    res.json({ ok: true, rejections: loadRejections(deps.dataDir) });
  });
  return router;
}
