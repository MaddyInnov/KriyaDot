// SPDX-License-Identifier: Apache-2.0
/**
 * Workflow file-format + dry-run surface (Octomind parity #143/#151).
 *
 * The @mvp/workflows library already had a versioned file format
 * (serialize/parse, JSON) and a dryRun() plan builder — wired to NO
 * surface. This router is that surface:
 *
 *   GET  /workflows/:id/export?format=json|toml
 *   POST /workflows/import            { content, format? } | { definition }
 *   POST /workflows/:id/dry-run       → dry-run plan for a stored workflow
 *   POST /workflows/dry-run           { content, format? } | { definition }
 *                                     → ad-hoc dry-run, spawns nothing
 *
 * TOML uses the package's toml-format module (serializeWorkflowToml /
 * parseWorkflowToml) added by the workflows workstream. Dry-run is the
 * library's dryRun() — it builds the execution plan and spawns nothing.
 *
 * HOST WIRING (parent): mount at '/api' —
 *   app.use('/api', createWorkflowSurfaceRouter({
 *     getWorkflow: (id) => workflowStore.get(id)?.definition,
 *     saveWorkflow: (def) => workflowStore.save(def),   // optional
 *   }))
 */

import express, { type Router } from 'express';
import {
  dryRun,
  formatRunEventsJsonl,
  parseWorkflowFile,
  parseWorkflowToml,
  runEventsFromRun,
  serializeWorkflow,
  serializeWorkflowToml,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunEvent,
} from '@mvp/workflows';

export interface WorkflowSurfaceDeps {
  getWorkflow: (id: string) => WorkflowDefinition | undefined | Promise<WorkflowDefinition | undefined>;
  saveWorkflow?: (def: WorkflowDefinition) => unknown | Promise<unknown>;
  /**
   * Run-events source for the JSONL export (#152): the host's collected
   * live events for a run, or a run snapshot to reconstruct them from.
   * Optional — the snapshot-export endpoint below works without it.
   */
  getRunEvents?: (runId: string) => WorkflowRunEvent[] | undefined | Promise<WorkflowRunEvent[] | undefined>;
  getRun?: (runId: string) => WorkflowRun | undefined | Promise<WorkflowRun | undefined>;
}

type Format = 'json' | 'toml';

function parseDefinition(body: Record<string, unknown>): { def: WorkflowDefinition; format: Format } {
  const format: Format = body.format === 'toml' ? 'toml' : 'json';
  if (typeof body.content === 'string' && body.content.trim()) {
    return { def: format === 'toml' ? parseWorkflowToml(body.content) : parseWorkflowFile(body.content), format };
  }
  if (body.definition && typeof body.definition === 'object') {
    // Round-trip through the serializer so the definition is validated
    // against the file format exactly like an imported file would be.
    return { def: parseWorkflowFile(serializeWorkflow(body.definition as WorkflowDefinition)), format };
  }
  if (body.workflow && typeof body.workflow === 'object') {
    return { def: parseWorkflowFile(body.workflow), format };
  }
  throw new Error('Provide { content, format? } or { definition }');
}

export function createWorkflowSurfaceRouter(deps: WorkflowSurfaceDeps): Router {
  const router = express.Router();

  router.get('/workflows/:id/export', async (req, res) => {
    const def = await deps.getWorkflow(req.params.id);
    if (!def) { res.status(404).json({ error: `unknown workflow "${req.params.id}"` }); return; }
    const format: Format = req.query.format === 'toml' ? 'toml' : 'json';
    const content = format === 'toml' ? serializeWorkflowToml(def) : serializeWorkflow(def);
    res.json({ ok: true, id: req.params.id, format, content, definition: def });
  });

  router.post('/workflows/import', async (req, res) => {
    try {
      const { def } = parseDefinition((req.body ?? {}) as Record<string, unknown>);
      if (deps.saveWorkflow) await deps.saveWorkflow(def);
      res.status(201).json({ ok: true, imported: true, persisted: !!deps.saveWorkflow, workflow: def });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/workflows/dry-run', (req, res) => {
    try {
      const { def } = parseDefinition((req.body ?? {}) as Record<string, unknown>);
      res.json({ ok: true, dryRun: true, spawned: false, plan: dryRun(def) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/workflows/:id/dry-run', async (req, res) => {
    const def = await deps.getWorkflow(req.params.id);
    if (!def) { res.status(404).json({ error: `unknown workflow "${req.params.id}"` }); return; }
    try {
      res.json({ ok: true, dryRun: true, spawned: false, id: req.params.id, plan: dryRun(def) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -- JSONL observability export (#152) -----------------------------------
  // Per-step + aggregated cost events as JSON Lines: one JSON object per
  // line (run_started / step_completed / run_finished), priced per #150.

  router.get('/workflows/runs/:runId/events.jsonl', async (req, res) => {
    try {
      let events = deps.getRunEvents ? await deps.getRunEvents(req.params.runId) : undefined;
      if (!events && deps.getRun) {
        const run = await deps.getRun(req.params.runId);
        if (run) events = runEventsFromRun(run);
      }
      if (!events) { res.status(404).json({ error: `unknown run "${req.params.runId}"` }); return; }
      res.type('application/x-ndjson').send(formatRunEventsJsonl(events));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Snapshot export: the caller posts a WorkflowRun snapshot (e.g. from
  // the run store / CLI) and gets its JSONL event stream back. This is
  // also the CLI-facing shape — a CLI can fetch a run, then render or
  // archive its events without a live collector on the server.
  router.post('/workflows/runs/events/export', (req, res) => {
    try {
      const run = (req.body as { run?: unknown })?.run;
      if (!run || typeof run !== 'object') {
        res.status(400).json({ error: 'Provide { run } — a workflow run snapshot' });
        return;
      }
      const events = runEventsFromRun(run as WorkflowRun);
      if (req.query.format === 'json') {
        res.json({ ok: true, events });
        return;
      }
      res.type('application/x-ndjson').send(formatRunEventsJsonl(events));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
