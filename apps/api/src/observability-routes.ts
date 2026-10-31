// SPDX-License-Identifier: Apache-2.0
// W13 observability API: recorded runs (span traces) for Activity → Runs.
//
//   GET    /api/observability/runs?botId=&outcome=&tag=&sessionId=&limit=
//   GET    /api/observability/runs/:runId        → run + spans + totals (+ loop finding)
//   POST   /api/observability/runs/:runId/tags   { tag }
//   DELETE /api/observability/runs/:runId/tags/:tag
//   GET    /api/observability/outcomes           → per-bot outcome counts + success rate
//
// Span payloads served here were redacted + size-capped at write time by
// the SpanStore (see packages/agent-runtime/src/spans.ts) — this layer
// never sees a raw prompt or tool payload.

import express from 'express';
import type { RunOutcome, SpanStore } from '@mvp/agent-runtime';
import { loopFinding } from '@mvp/run-health';
import type { HealthFinding } from '@mvp/run-health';

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

const OUTCOMES: ReadonlySet<string> = new Set(['success', 'failed', 'cancelled', 'needs-input']);

export interface ObservabilityRouteDeps {
  spanStore: SpanStore;
}

export function registerObservabilityRoutes(
  router: express.Router,
  deps: ObservabilityRouteDeps,
): void {
  const { spanStore } = deps;

  router.get('/observability/runs', (req, res) => {
    try {
      const botId = typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : undefined;
      const sessionId =
        typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined;
      const tag = typeof req.query.tag === 'string' && req.query.tag ? req.query.tag : undefined;
      let outcome: RunOutcome | undefined;
      if (typeof req.query.outcome === 'string' && req.query.outcome) {
        if (!OUTCOMES.has(req.query.outcome)) {
          res.status(400).json(errorBody(`outcome must be one of ${[...OUTCOMES].join('|')}`));
          return;
        }
        outcome = req.query.outcome as RunOutcome;
      }
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
      const runs = spanStore.listRuns({ botId, outcome, tag, sessionId, limit }).map((run) => ({
        ...run,
        totals: spanStore.runTotals(run.runId),
      }));
      res.json({ runs });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list runs', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/observability/runs/:runId', (req, res) => {
    try {
      const run = spanStore.getRun(req.params.runId);
      if (!run) {
        res.status(404).json(errorBody(`Unknown run "${req.params.runId}"`));
        return;
      }
      const findings: HealthFinding[] = run.loopDetected
        ? run.loopEvidence.map((e) => loopFinding(e))
        : [];
      res.json({
        run,
        spans: spanStore.listSpans(run.runId),
        totals: spanStore.runTotals(run.runId),
        findings,
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load run', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/observability/runs/:runId/tags', (req, res) => {
    const tag = (req.body as { tag?: unknown } | undefined)?.tag;
    if (typeof tag !== 'string' || !tag.trim()) {
      res.status(400).json(errorBody('tag (non-empty string) is required'));
      return;
    }
    try {
      const tags = spanStore.addTag(req.params.runId, tag);
      res.json({ runId: req.params.runId, tags });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message.startsWith('Unknown run') ? 404 : 400).json(errorBody('Failed to add tag', message));
    }
  });

  router.delete('/observability/runs/:runId/tags/:tag', (req, res) => {
    try {
      if (!spanStore.getRun(req.params.runId)) {
        res.status(404).json(errorBody(`Unknown run "${req.params.runId}"`));
        return;
      }
      const tags = spanStore.removeTag(req.params.runId, req.params.tag);
      res.json({ runId: req.params.runId, tags });
    } catch (err) {
      res.status(500).json(errorBody('Failed to remove tag', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/observability/outcomes', (_req, res) => {
    try {
      res.json({ byBot: spanStore.outcomesByBot() });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load outcomes', err instanceof Error ? err.message : String(err)));
    }
  });
}
