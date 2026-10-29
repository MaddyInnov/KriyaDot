// SPDX-License-Identifier: Apache-2.0
// Invocation decision model — HTTP routes (router factory).
//
// Mount alongside the routing-learn routes (e.g. app.use('/api/routing',
// createDecisionRouter({ dataDir }))) — paths are distinct from theirs:
//
//   GET  /invocation-decisions[?limit=&kind=]  → { ok, decisions }
//   GET  /invocation-decisions/stats           → { ok, stats } — per-kind
//        totals, outcome counts, avg confidence, and agreement rates
//        computed ONLY over user-judged records (labelled as agreement).
//   POST /invocation-decisions/:id/judgment    → { correct: boolean }
//        records the user's judgment that a decision was right/wrong.

import express, { type Router } from 'express';
import {
  InvocationDecisionLog,
  computeInvocationStats,
  isInvocationKind,
} from '@mvp/agent-runtime';

export interface DecisionRouteDeps {
  dataDir: string;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

export function createDecisionRouter(deps: DecisionRouteDeps): Router {
  const router = express.Router();

  router.get('/invocation-decisions/stats', (_req, res) => {
    res.json({ ok: true, stats: computeInvocationStats(deps.dataDir) });
  });

  router.get('/invocation-decisions', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (kind !== undefined && !isInvocationKind(kind)) {
      res.status(400).json(errorBody('kind must be routing|skill-activation|tool-invocation|delegation'));
      return;
    }
    const log = new InvocationDecisionLog(deps.dataDir);
    res.json({
      ok: true,
      decisions: log.list(Number.isFinite(limit) ? limit : 100, kind),
    });
  });

  router.post('/invocation-decisions/:id/judgment', (req, res) => {
    const body = (req.body ?? {}) as { correct?: unknown };
    if (typeof body.correct !== 'boolean') {
      res.status(400).json(errorBody('Body must be { correct: boolean }'));
      return;
    }
    const log = new InvocationDecisionLog(deps.dataDir);
    const entry = log.markJudged(req.params.id, body.correct);
    if (!entry) {
      res.status(404).json(errorBody(`Unknown invocation decision "${req.params.id}"`));
      return;
    }
    deps.audit?.('invocation_decision.judged', {
      actor: 'user',
      detail: { decisionId: entry.id, kind: entry.kind, correct: body.correct },
    });
    res.json({ ok: true, decision: entry });
  });

  return router;
}
