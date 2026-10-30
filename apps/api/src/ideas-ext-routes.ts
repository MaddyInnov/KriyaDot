// SPDX-License-Identifier: Apache-2.0
/**
 * Ideas closure routes (I-3 / I-5 / I-6) — register-style router factory.
 *
 *   GET  /ideas/:id/run-state        → card state bound to the run (I-3)
 *   GET  /ideas/:id/run-events       → SSE stream of live run progress (I-3)
 *   POST /ideas/:id/run-start        → start a run, bind it to the card
 *   POST /ideas/runs/:runId/progress → executor reports progress
 *   POST /ideas/runs/:runId/complete → executor finishes the run
 *   POST /ideas/runs/:runId/fail     → executor fails the run
 *   POST /ideas/curate               → run one daily curation pass (I-6)
 *   POST /ideas/expire-sweep         → apply the store expiry rules (I-5)
 *   GET  /ideas/ranked               → 'new' ideas ordered by rank (I-6)
 *
 * HOST WIRING (coordinator): mount at '/api' BEFORE the muse-modules
 * router so /ideas/ranked and /ideas/curate are not captured by its
 * '/ideas/:id'-style paths (the existing router has no such GET paths,
 * so ordering only matters for safety):
 *   app.use('/api', createIdeasExtRouter({ mdb, dreamCandidates, goalsContext, memoryContext, isPaused }))
 *
 * The dream bridge (I-6): when `dreamCandidates` is supplied, curation
 * candidates are those fresh dream ideas PLUS any candidates in the
 * request body — dreaming thereby feeds the Ideas tab, not only the
 * briefing. `runDreamCuration()` below is the same bridge as a plain
 * function for the nightly timer in index.ts.
 */
import express, { type Router } from 'express';
import {
  DailyIdeaCurator,
  GoalStore,
  IdeaRunTracker,
  IdeaStore,
  statusForError,
  type CurationContext,
  type IdeaCandidate,
} from '@mvp/muse-modules';
import type { ModuleDb } from '@mvp/muse-modules';
import type { DreamIdea } from './dreaming.js';

export interface IdeasExtDeps {
  mdb: ModuleDb;
  /** Fresh dream ideas to fold into curation (I-6 dream bridge). */
  dreamCandidates?: () => DreamIdea[];
  /** Extra memory snippets for curation context (goals come from GoalStore). */
  memoryContext?: () => string[];
  isPaused?: () => boolean;
}

/** Map dream output into curation candidates. */
export function dreamIdeasToCandidates(dreams: DreamIdea[]): IdeaCandidate[] {
  return dreams.map((d) => ({ title: d.title, description: d.detail ?? '', origin: 'dream' }));
}

/** Build the curation context from the live goal store + memory snippets. */
export function curationContextFor(deps: IdeasExtDeps): CurationContext {
  const goals = new GoalStore(deps.mdb).list('active').map((g) => `${g.title} ${g.description}`.trim());
  return { goals, memorySnippets: deps.memoryContext?.() ?? [] };
}

/**
 * One curation pass fed by dreaming (I-6): rank dream candidates (plus
 * any extra candidates) against goals+memory and file the best into
 * the IdeaStore. Returns the curator result; empty when paused.
 */
export function runDreamCuration(
  deps: IdeasExtDeps,
  extraCandidates: IdeaCandidate[] = [],
  curatorOpts?: ConstructorParameters<typeof DailyIdeaCurator>[1],
) {
  const store = new IdeaStore(deps.mdb);
  const curator = new DailyIdeaCurator(store, curatorOpts);
  const dreams = deps.dreamCandidates?.() ?? [];
  return curator.curate([...dreamIdeasToCandidates(dreams), ...extraCandidates], curationContextFor(deps));
}

export function createIdeasExtRouter(deps: IdeasExtDeps): Router {
  const router = express.Router();
  const ideas = new IdeaStore(deps.mdb);
  const tracker = new IdeaRunTracker(deps.mdb);

  const fail = (res: express.Response, err: unknown, fallback: string) => {
    res.status(statusForError(err)).json({ ok: false, error: err instanceof Error ? err.message : fallback });
  };

  router.get('/ideas/ranked', (_req, res) => {
    try {
      res.json({ ok: true, ideas: ideas.listRanked('new') });
    } catch (err) {
      fail(res, err, 'failed to list ranked ideas');
    }
  });

  router.get('/ideas/:id/run-state', (req, res) => {
    try {
      res.json({ ok: true, ...tracker.state(req.params.id) });
    } catch (err) {
      fail(res, err, 'failed to read run state');
    }
  });

  router.get('/ideas/:id/run-events', (req, res) => {
    let state: ReturnType<IdeaRunTracker['state']>;
    try {
      state = tracker.state(req.params.id);
    } catch (err) {
      fail(res, err, 'failed to read run state');
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'state', ...state });
    const unsubscribe = tracker.subscribe((event) => {
      if (event.ideaId === req.params.id) send({ type: 'event', event });
    });
    req.on('close', unsubscribe);
  });

  router.post('/ideas/:id/run-start', (req, res) => {
    try {
      const note = typeof (req.body as { note?: unknown })?.note === 'string' ? (req.body as { note: string }).note : undefined;
      res.status(201).json({ ok: true, ...tracker.start(req.params.id, note) });
    } catch (err) {
      fail(res, err, 'failed to start run');
    }
  });

  router.post('/ideas/runs/:runId/progress', (req, res) => {
    try {
      const body = (req.body ?? {}) as { pct?: unknown; note?: unknown };
      res.json({ ok: true, event: tracker.progress(req.params.runId, Number(body.pct ?? 0), String(body.note ?? '')) });
    } catch (err) {
      fail(res, err, 'failed to report progress');
    }
  });

  router.post('/ideas/runs/:runId/complete', (req, res) => {
    try {
      const note = typeof (req.body as { note?: unknown })?.note === 'string' ? (req.body as { note: string }).note : undefined;
      res.json({ ok: true, event: tracker.complete(req.params.runId, note) });
    } catch (err) {
      fail(res, err, 'failed to complete run');
    }
  });

  router.post('/ideas/runs/:runId/fail', (req, res) => {
    try {
      const note = typeof (req.body as { note?: unknown })?.note === 'string' ? (req.body as { note: string }).note : undefined;
      res.json({ ok: true, event: tracker.fail(req.params.runId, note) });
    } catch (err) {
      fail(res, err, 'failed to fail run');
    }
  });

  router.post('/ideas/curate', (req, res) => {
    if (deps.isPaused?.()) {
      res.status(409).json({ ok: false, error: 'system is paused' });
      return;
    }
    try {
      const body = (req.body ?? {}) as { candidates?: IdeaCandidate[] };
      const extra = Array.isArray(body.candidates) ? body.candidates : [];
      res.json({ ok: true, ...runDreamCuration(deps, extra) });
    } catch (err) {
      fail(res, err, 'curation failed');
    }
  });

  router.post('/ideas/expire-sweep', (_req, res) => {
    try {
      res.json({ ok: true, expired: ideas.expireStale() });
    } catch (err) {
      fail(res, err, 'expiry sweep failed');
    }
  });

  return router;
}
