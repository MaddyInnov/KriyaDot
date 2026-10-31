// SPDX-License-Identifier: Apache-2.0
// W13: observability routes — runs list with filters, run detail with
// spans + totals + loop finding, tag add/remove, per-bot outcomes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { SpanStore } from '@mvp/agent-runtime';
import { registerObservabilityRoutes } from '../src/observability-routes.js';

let store: SpanStore;
let server: ReturnType<express.Express['listen']>;
let base: string;
let runId: string;

function seedRun(botId: string, outcome: 'success' | 'failed', loop = false): string {
  const run = store.createRun({ sessionId: `s-${botId}-${Math.random()}`, botId });
  const turn = store.startSpan({
    runId: run.runId, sessionId: 's', kind: 'turn', name: 'turn', botId,
  });
  for (let i = 0; i < (loop ? 3 : 1); i++) {
    store.recordSpan({
      runId: run.runId, sessionId: 's', parentSpanId: turn.id, kind: 'tool', name: 'web_search',
      botId, status: 'ok', costCents: 2, payload: { input: { query: 'same' } },
      startedAt: 1000 + i * 10, endedAt: 1005 + i * 10,
    });
  }
  if (loop) {
    store.flagLoop(run.runId, [
      { kind: 'tool', key: 'web_search', count: 3, spanIds: ['span_a', 'span_b', 'span_c'] },
    ]);
  }
  store.finalizeRun(run.runId, outcome);
  return run.runId;
}

beforeEach(async () => {
  store = new SpanStore(':memory:');
  runId = seedRun('bot-a', 'success');
  seedRun('bot-a', 'failed');
  seedRun('bot-b', 'success', true);
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerObservabilityRoutes(router, { spanStore: store });
  app.use('/api', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

describe('observability routes', () => {
  it('lists runs, composable bot/outcome filters, totals attached', async () => {
    const all = (await (await fetch(`${base}/api/observability/runs`)).json()) as { runs: unknown[] };
    expect(all.runs).toHaveLength(3);
    const filtered = (await (
      await fetch(`${base}/api/observability/runs?botId=bot-a&outcome=failed`)
    ).json()) as { runs: Array<{ botId: string; outcome: string; totals: { toolCostCents: number } }> };
    expect(filtered.runs).toHaveLength(1);
    expect(filtered.runs[0]?.outcome).toBe('failed');
    expect(filtered.runs[0]?.totals.toolCostCents).toBe(2);
    const bad = await fetch(`${base}/api/observability/runs?outcome=nope`);
    expect(bad.status).toBe(400);
  });

  it('sessionId filter returns only that chat session runs', async () => {
    // Seed runs share random session ids; create two runs on one session.
    const shared = store.createRun({ sessionId: 'chat-session-1', botId: 'bot-a' });
    store.finalizeRun(shared.runId, 'success');
    const bySession = (await (
      await fetch(`${base}/api/observability/runs?sessionId=chat-session-1`)
    ).json()) as { runs: Array<{ runId: string; sessionId: string }> };
    expect(bySession.runs.map((r) => r.runId)).toEqual([shared.runId]);
    expect(bySession.runs[0]?.sessionId).toBe('chat-session-1');
    const none = (await (
      await fetch(`${base}/api/observability/runs?sessionId=no-such-session`)
    ).json()) as { runs: unknown[] };
    expect(none.runs).toHaveLength(0);
  });

  it('run detail returns spans + totals + loop finding; 404 for unknown', async () => {
    const detail = (await (await fetch(`${base}/api/observability/runs/${runId}`)).json()) as {
      run: { outcome: string };
      spans: Array<{ kind: string }>;
      totals: { spanCount: number };
      findings: unknown[];
    };
    expect(detail.run.outcome).toBe('success');
    expect(detail.spans.some((s) => s.kind === 'tool')).toBe(true);
    expect(detail.totals.spanCount).toBe(detail.spans.length);
    expect(detail.findings).toEqual([]);

    const loopRuns = (await (await fetch(`${base}/api/observability/runs?botId=bot-b`)).json()) as {
      runs: Array<{ runId: string; loopDetected: boolean }>;
    };
    expect(loopRuns.runs[0]?.loopDetected).toBe(true);
    const loopDetail = (await (
      await fetch(`${base}/api/observability/runs/${loopRuns.runs[0]!.runId}`)
    ).json()) as { findings: Array<{ signal: string; title: string }> };
    expect(loopDetail.findings).toHaveLength(1);
    expect(loopDetail.findings[0]?.signal).toBe('loop');

    const missing = await fetch(`${base}/api/observability/runs/run_nope`);
    expect(missing.status).toBe(404);
  });

  it('tags: add via POST, filter by tag, remove via DELETE', async () => {
    const added = (await (
      await fetch(`${base}/api/observability/runs/${runId}/tags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'release-check' }),
      })
    ).json()) as { tags: string[] };
    expect(added.tags).toEqual(['release-check']);

    const byTag = (await (await fetch(`${base}/api/observability/runs?tag=release-check`)).json()) as {
      runs: Array<{ runId: string }>;
    };
    expect(byTag.runs.map((r) => r.runId)).toEqual([runId]);

    const removed = (await (
      await fetch(`${base}/api/observability/runs/${runId}/tags/release-check`, { method: 'DELETE' })
    ).json()) as { tags: string[] };
    expect(removed.tags).toEqual([]);

    const empty = await fetch(`${base}/api/observability/runs/${runId}/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: '  ' }),
    });
    expect(empty.status).toBe(400);
    const unknownRun = await fetch(`${base}/api/observability/runs/run_nope/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'x' }),
    });
    expect(unknownRun.status).toBe(404);
  });

  it('outcomes endpoint aggregates per-bot success rates', async () => {
    const out = (await (await fetch(`${base}/api/observability/outcomes`)).json()) as {
      byBot: Array<{ botId: string; success: number; failed: number; successRate: number }>;
    };
    const a = out.byBot.find((b) => b.botId === 'bot-a');
    expect(a).toMatchObject({ success: 1, failed: 1 });
    expect(a?.successRate).toBeCloseTo(0.5);
    const b = out.byBot.find((x) => x.botId === 'bot-b');
    expect(b?.successRate).toBe(1);
  });
});
