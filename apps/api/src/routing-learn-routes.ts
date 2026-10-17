// SPDX-License-Identifier: Apache-2.0
// Learning-from-corrections routing HTTP API (feature #4: corrections
// actually update routing).
//
//   GET  /api/routing/rules         → { ok, rules } (learned rules, newest first)
//   POST /api/routing/corrections   → { taskType, routedProviderId, routedModelId,
//                                       correctedProviderId, correctedModelId,
//                                       message? } → { ok, rules }
//
// The chat route loads the stored rules via loadRoutingRules() and passes
// them into runTurn({ routingRules }) — which routeModel() honors — so a
// correction recorded here changes future routing decisions. Learning is
// fully local (pattern → rule template), no LLM, no network.
//
// Mounted by the integrator (routes.ts), e.g.:
//
//   import { registerRoutingLearnRoutes } from './routing-learn-routes.js';
//   const rlRouter = express.Router();
//   registerRoutingLearnRoutes(rlRouter, { dataDir: config.dataDir });
//   router.use('/routing', rlRouter);

import type { Request, Response, Router } from 'express';
import {
  RouterDecisionLog,
  computeRoutingStats,
  loadMessageCorrections,
  loadRouterWeights,
  recordMessageCorrection,
  saveRouterWeights,
} from '@mvp/agent-runtime';
import {
  loadRoutingRules,
  recordRoutingCorrection,
  type RoutingCorrection,
} from '@mvp/agent-runtime';

export interface RoutingLearnRouteDeps {
  dataDir: string;
}

const TASK_TYPES = new Set(['code', 'chat', 'reasoning', 'simple-qa']);

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new Error(`"${name}" must be a non-empty string (max 200 chars).`);
  }
  return value.trim();
}

/** Validate a correction body; throws on the first problem. */
export function parseCorrectionBody(body: unknown): RoutingCorrection {
  const b = (body ?? {}) as Record<string, unknown>;
  const taskType = b.taskType;
  if (typeof taskType !== 'string' || !TASK_TYPES.has(taskType)) {
    throw new Error('"taskType" must be one of: code, chat, reasoning, simple-qa.');
  }
  const correction: RoutingCorrection = {
    taskType: taskType as RoutingCorrection['taskType'],
    routedProviderId: requiredId(b.routedProviderId, 'routedProviderId'),
    routedModelId: requiredId(b.routedModelId, 'routedModelId'),
    correctedProviderId: requiredId(b.correctedProviderId, 'correctedProviderId'),
    correctedModelId: requiredId(b.correctedModelId, 'correctedModelId'),
  };
  if (typeof b.message === 'string' && b.message.trim() !== '') {
    correction.message = b.message.slice(0, 4000);
  }
  return correction;
}

export function registerRoutingLearnRoutes(router: Router, deps: RoutingLearnRouteDeps): void {
  router.get('/rules', (_req: Request, res: Response) => {
    try {
      const rules = loadRoutingRules(deps.dataDir);
      res.json({ ok: true, rules });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load routing rules', errMessage(err)));
    }
  });

  router.post('/corrections', (req: Request, res: Response) => {
    let correction: RoutingCorrection;
    try {
      correction = parseCorrectionBody(req.body);
    } catch (err) {
      res.status(400).json(errorBody('Invalid correction', errMessage(err)));
      return;
    }
    try {
      const rules = recordRoutingCorrection(deps.dataDir, correction);
      res.status(201).json({ ok: true, rules });
    } catch (err) {
      res.status(500).json(errorBody('Failed to record correction', errMessage(err)));
    }
  });

  // -- Message-router decision log (honest "Jev equivalent" observability) --
  // The message router is deterministic heuristics, NOT a learned model.
  // These endpoints expose what it honestly offers: a scored decision log
  // (features + per-bot scores + winner, raw text never logged), accuracy
  // measured ONLY over user-judged decisions, and tunable weights.
  //
  //   GET  /decisions[?limit]        → recent routing decisions
  //   GET  /stats                    → volume/confidence/accuracy stats
  //   GET  /message-corrections      → user judgments
  //   POST /message-corrections      { message, routedBotId, correctedBotId }
  //   GET  /weights                  → current heuristic weights
  //   PUT  /weights                  { directHit?, topicHit?, phraseBonus? }

  router.get('/decisions', (req: Request, res: Response) => {
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isSafeInteger(rawLimit) ? rawLimit : 100;
    try {
      const log = new RouterDecisionLog(deps.dataDir);
      res.json({ ok: true, decisions: log.list(limit) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list routing decisions', errMessage(err)));
    }
  });

  router.get('/stats', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, stats: computeRoutingStats(deps.dataDir) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to compute routing stats', errMessage(err)));
    }
  });

  router.get('/message-corrections', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, corrections: loadMessageCorrections(deps.dataDir) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list message corrections', errMessage(err)));
    }
  });

  router.post('/message-corrections', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { message?: unknown; routedBotId?: unknown; correctedBotId?: unknown };
    try {
      if (typeof body.message !== 'string' || typeof body.routedBotId !== 'string' || typeof body.correctedBotId !== 'string') {
        throw new Error('Body must be { message: string, routedBotId: string, correctedBotId: string }');
      }
      const corrections = recordMessageCorrection(deps.dataDir, {
        message: body.message,
        routedBotId: body.routedBotId,
        correctedBotId: body.correctedBotId,
      });
      res.status(201).json({ ok: true, corrections: corrections.slice(0, 20) });
    } catch (err) {
      res.status(400).json(errorBody('Invalid message correction', errMessage(err)));
    }
  });

  router.get('/weights', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, weights: loadRouterWeights(deps.dataDir) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load routing weights', errMessage(err)));
    }
  });

  router.put('/weights', (req: Request, res: Response) => {
    try {
      const weights = saveRouterWeights(deps.dataDir, (req.body ?? {}) as Record<string, unknown>);
      res.json({ ok: true, weights });
    } catch (err) {
      res.status(400).json(errorBody('Invalid weights', errMessage(err)));
    }
  });
}

export default registerRoutingLearnRoutes;
