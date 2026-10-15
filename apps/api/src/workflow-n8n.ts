// SPDX-License-Identifier: Apache-2.0
// n8n workflow interchange endpoints.
//
// POST /workflows/import       { n8nJson } → { workflow, unmapped }
//   Parses a standard n8n workflow export, registers the resulting KriyaDot
//   definition, and reports nodes that had no mapping (the import itself
//   never fails on unknown nodes).
// GET  /workflows/:id/export-n8n → n8n-format JSON (best-effort reverse mapping)
//
// Mount at boot, e.g. `app.use('/api', createWorkflowN8nRouter({ workflowRunner }))`
// — before the `/api` unknown-route 404 handler. The WorkflowRunner is
// constructed in the API boot sequence (src/index.ts).

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { WorkflowRunner } from '@mvp/workflows';
import { exportN8nWorkflow, importN8nWorkflow } from '@mvp/workflows';

export interface WorkflowN8nRouterOptions {
  workflowRunner: WorkflowRunner;
}

function errorBody(message: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error: message, detail } : { error: message };
}

export function createWorkflowN8nRouter(opts: WorkflowN8nRouterOptions): Router {
  const router = Router();

  router.post('/workflows/import', (req: Request, res: Response) => {
    const n8nJson = (req.body as { n8nJson?: unknown } | undefined)?.n8nJson;
    if (n8nJson === undefined) {
      res.status(400).json(errorBody('Request body must contain n8nJson'));
      return;
    }
    try {
      const { workflow, unmapped } = importN8nWorkflow(n8nJson);
      opts.workflowRunner.register(workflow);
      res.json({ workflow, unmapped });
    } catch (err) {
      res
        .status(400)
        .json(errorBody('Failed to import n8n workflow', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/workflows/:id/export-n8n', (req: Request, res: Response) => {
    try {
      const def = opts.workflowRunner.getWorkflow(req.params.id);
      res.json(exportN8nWorkflow(def));
    } catch (err) {
      res
        .status(404)
        .json(errorBody('Unknown workflow', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
