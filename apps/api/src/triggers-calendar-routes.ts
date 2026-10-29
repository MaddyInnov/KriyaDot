// SPDX-License-Identifier: Apache-2.0
/**
 * Triggers calendar (item 4e): schedules + runs in a date range.
 * GET /?from=<ms>&to=<ms> → { routines: [{id,name,schedule,occurrences[]}], runs: [...] }
 * HOST WIRING: app.use('/api/triggers/calendar', createTriggersCalendarRouter({ routineStore, runStore }))
 */
import express, { type Router } from 'express';
import type { RoutineStore } from './bot-routines.js';
import type { RoutineRunStore } from './routine-runs.js';
import { nextRuns } from './routine-schedules.js';
export function createTriggersCalendarRouter(deps: { routineStore: RoutineStore; runStore?: RoutineRunStore }): Router {
  const router = express.Router();
  router.get('/', (req, res) => {
    const from = Number(req.query.from) || Date.now();
    const to = Number(req.query.to) || (from + 7*24*3600_000);
    if (to < from) { res.status(400).json({ ok:false, error:'to must be >= from' }); return; }
    const routines = deps.routineStore.list().map(r => {
      let occurrences: Array<{ at: number; atIso: string; label: string }> = [];
      if (r.schedule && r.schedule.enabled && r.enabled) {
        try { occurrences = nextRuns(r.schedule, 100, from-1).filter(o=>o.at<=to); } catch { occurrences = []; }
        if (r.schedule.kind==='startup') occurrences = [{ at: from, atIso: new Date(from).toISOString(), label: 'on server startup' }];
      }
      return { id: r.id, name: r.name, botId: r.botId, enabled: r.enabled, schedule: r.schedule ?? null, occurrences };
    });
    let runs: unknown[] = [];
    if (deps.runStore) {
      runs = deps.routineStore.list().flatMap(r => deps.runStore!.listByRoutine(r.id, 200)).filter(run => {
        const t = run.scheduledFor ?? run.startedAt ?? run.createdAt; return t>=from && t<=to;
      }).sort((a,b)=> ((a.scheduledFor??a.createdAt) - (b.scheduledFor??b.createdAt)));
    }
    res.json({ ok: true, from, to, routines, runs });
  });
  return router;
}
