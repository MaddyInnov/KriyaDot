// SPDX-License-Identifier: Apache-2.0
// Routine run lifecycle API — OpenMausBot parity P0 #7.
//
// Mounted on the same router as the routine management routes:
//
//   GET    /api/routines/:id/runs?limit=20&offset=0 → paginated run history + failure streak
//   GET    /api/routines/:id/runs/:runId            → one run (incl. output excerpt)
//   POST   /api/routines/:id/run-now               → 202 { runId } (manual fire)
//   POST   /api/routines/:id/runs/:runId/cancel     → cancel a queued/running run
//   POST   /api/routines/:id/runs/:runId/retry      → 202 { runId } (fresh manual run)
//
// Storage: <dataDir>/routine-runs.db (see routine-runs.ts).

import type { Request, Response, Router } from 'express';
import type { BotRoutine, RoutineStore } from './bot-routines.js';
import type { RoutineRun, RoutineRunStore } from './routine-runs.js';
import type { RoutineScheduler } from './routine-schedules.js';

export interface RoutineRunRouteDeps {
  routineStore: RoutineStore;
  runStore: RoutineRunStore;
  scheduler: RoutineScheduler;
}

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export function registerRoutineRunRoutes(router: Router, deps: RoutineRunRouteDeps): void {
  const { routineStore, runStore, scheduler } = deps;

  const requireRoutine = (res: Response, id: string): BotRoutine | undefined => {
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid routine id'));
      return undefined;
    }
    const routine = routineStore.get(id);
    if (!routine) {
      res.status(404).json(errorBody(`Unknown routine "${id}"`));
      return undefined;
    }
    return routine;
  };

  const requireRun = (res: Response, routine: BotRoutine, runId: string): RoutineRun | undefined => {
    if (!validId(runId)) {
      res.status(400).json(errorBody('Invalid run id'));
      return undefined;
    }
    const run = runStore.get(runId);
    if (!run || run.routineId !== routine.id) {
      res.status(404).json(errorBody(`Unknown run "${runId}" for this routine`));
      return undefined;
    }
    return run;
  };

  router.get('/:id/runs', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({
      ok: true,
      runs: runStore.listByRoutine(routine.id, limit, offset),
      total: runStore.countByRoutine(routine.id),
      limit,
      offset,
      streak: runStore.getStreak(routine.id),
    });
  });

  router.get('/:id/runs/:runId', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const run = requireRun(res, routine, req.params.runId);
    if (!run) return;
    res.json({ ok: true, run });
  });

  router.post('/:id/run-now', async (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    try {
      const runId = await scheduler.runNow(routine.id);
      res.status(202).json({ ok: true, runId });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to start run'));
    }
  });

  router.post('/:id/runs/:runId/cancel', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const run = requireRun(res, routine, req.params.runId);
    if (!run) return;
    const cancelled = scheduler.cancelRun(run.id);
    res.json({ ok: true, cancelled });
  });

  router.post('/:id/runs/:runId/retry', async (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const run = requireRun(res, routine, req.params.runId);
    if (!run) return;
    try {
      const runId = await scheduler.retryRun(run.id);
      res.status(202).json({ ok: true, runId });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to retry run'));
    }
  });
}
