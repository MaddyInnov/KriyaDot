// SPDX-License-Identifier: Apache-2.0
// #152 workflow JSONL observability export via the workflow surface router.

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowSurfaceRouter } from '../src/workflow-surface-routes.js';

const servers: Array<{ close(cb: () => void): void }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function serve(router: express.Router): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await new Promise<{ address(): AddressInfo; close(cb: () => void): void }>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv as never));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api`;
}

const RUN = {
  id: 'run-1',
  workflowId: 'wf-1',
  status: 'succeeded',
  createdAt: 1_000,
  updatedAt: 5_000,
  nodeStates: {
    a: { status: 'succeeded', endedAt: 2_000, costUsd: 0.25 },
    b: { status: 'succeeded', endedAt: 3_000, costUsd: 0.75 },
  },
};

describe('workflow JSONL export (#152)', () => {
  it('exports a posted run snapshot as JSONL with aggregated cost', async () => {
    const base = await serve(createWorkflowSurfaceRouter({ getWorkflow: () => undefined }));
    const res = await fetch(`${base}/workflows/runs/events/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run: RUN }),
    });
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.type)).toEqual(['run_started', 'step_completed', 'step_completed', 'run_finished']);
    const finished = lines[3]!;
    expect(finished.totalCostUsd).toBeCloseTo(1.0);
  });

  it('serves JSONL by run id when the host provides events', async () => {
    const base = await serve(
      createWorkflowSurfaceRouter({
        getWorkflow: () => undefined,
        getRunEvents: (runId) =>
          runId === 'run-9'
            ? [{ type: 'run_started', ts: 1, runId: 'run-9', workflowId: 'wf-9' }]
            : undefined,
      }),
    );
    const res = await fetch(`${base}/workflows/runs/run-9/events.jsonl`);
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toContain('"run_started"');
    expect((await fetch(`${base}/workflows/runs/nope/events.jsonl`)).status).toBe(404);
  });
});
