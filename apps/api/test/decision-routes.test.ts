// SPDX-License-Identifier: Apache-2.0
// Invocation decision routes: list/filter, per-kind stats, judgment.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { InvocationDecisionLog } from '@mvp/agent-runtime';
import { createDecisionRouter } from '../src/decision-routes.js';

describe('decision-routes (invocation model)', () => {
  let dir: string;
  let base: string;
  let server: ReturnType<express.Express['listen']>;
  let firstId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'decroutes-'));
    const log = new InvocationDecisionLog(dir);
    firstId = log.record({ kind: 'routing', subject: 'support', outcome: 'routed', confidence: 0.9, rationale: 'kw' }).id;
    log.record({ kind: 'tool-invocation', subject: 'read_file', outcome: 'allow', confidence: 1, rationale: 'rule' });
    const app = express();
    app.use(express.json());
    app.use('/api/routing', createDecisionRouter({ dataDir: dir, audit: vi.fn() }));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/routing`;
  });
  afterEach(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it('lists decisions, filters by kind, rejects bad kinds', async () => {
    const all = await (await fetch(`${base}/invocation-decisions`)).json() as { decisions: unknown[] };
    expect(all.decisions).toHaveLength(2);
    const filtered = await (await fetch(`${base}/invocation-decisions?kind=routing`)).json() as { decisions: Array<{ kind: string }> };
    expect(filtered.decisions).toHaveLength(1);
    expect(filtered.decisions[0]!.kind).toBe('routing');
    expect((await fetch(`${base}/invocation-decisions?kind=bogus`)).status).toBe(400);
  });

  it('stats aggregate per kind; judgment moves agreement rate', async () => {
    const before = await (await fetch(`${base}/invocation-decisions/stats`)).json() as {
      stats: { total: number; agreementRate: number | null; perKind: Record<string, { total: number }> };
    };
    expect(before.stats.total).toBe(2);
    expect(before.stats.agreementRate).toBeNull();
    expect(before.stats.perKind['tool-invocation'].total).toBe(1);

    const judged = await fetch(`${base}/invocation-decisions/${firstId}/judgment`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ correct: true }),
    });
    expect(judged.status).toBe(200);
    const after = await (await fetch(`${base}/invocation-decisions/stats`)).json() as {
      stats: { agreementRate: number | null; perKind: Record<string, { agreementRate: number | null }> };
    };
    expect(after.stats.agreementRate).toBe(1);
    expect(after.stats.perKind.routing.agreementRate).toBe(1);
    expect(after.stats.perKind['tool-invocation'].agreementRate).toBeNull();

    expect((await fetch(`${base}/invocation-decisions/nope/judgment`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ correct: true }),
    })).status).toBe(404);
  });
});
