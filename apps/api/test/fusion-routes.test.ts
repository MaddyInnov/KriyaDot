// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, BotConfig, ChatMessage, TokenUsage } from '@mvp/agent-runtime';
import { FusionRunStore } from '../src/fusion.js';
import { createFusionRouter } from '../src/fusion-routes.js';

const U: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

const BOT: BotConfig = {
  id: 'bot1',
  name: 'TestBot',
  systemPrompt: 'be helpful',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
  skills: [],
} as BotConfig;

function makeAgentRuntime(): AgentRuntime {
  return {
    runTurn: vi.fn(async (opts: { onEvent: (e: { type: string; content?: string }) => void }) => {
      opts.onEvent({ type: 'token', content: 'worker says hi' });
      opts.onEvent({ type: 'done', usage: U });
      return U;
    }),
  } as unknown as AgentRuntime;
}

function makeApp(dataDir: string, runtime?: AgentRuntime) {
  const store = new FusionRunStore(dataDir);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/fusion',
    createFusionRouter({
      store,
      getBot: (id) => (id === BOT.id ? BOT : undefined),
      agentRuntime: runtime ?? makeAgentRuntime(),
      callLlm: async (_providerId: string, _model: string, messages: ChatMessage[]) => {
        const text = messages.map((m) => m.content).join('\n');
        if (text.includes('task planner')) {
          return {
            content:
              '{"subtasks": [{"id": "s1", "title": "Part A", "description": "do A", "dependencies": []}], "rationale": "simple"}',
            usage: U,
          };
        }
        return { content: 'FUSED: all done', usage: U };
      },
    }),
  );
  return { app, store };
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('fusion routes', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('POST /runs rejects missing botId/task', async () => {
    const { app } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      let r = await fetch(`${base}/api/fusion/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'hi' }),
      });
      expect(r.status).toBe(400);
      r = await fetch(`${base}/api/fusion/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1', task: '   ' }),
      });
      expect(r.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('POST /runs rejects unknown bot', async () => {
    const { app } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/fusion/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'nope', task: 'hi' }),
      });
      expect(r.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('POST /runs starts a run and completes it in the background', async () => {
    const { app, store } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/fusion/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1', task: 'do the thing' }),
      });
      expect(r.status).toBe(202);
      const body = (await r.json()) as { ok: boolean; runId: string };
      expect(body.ok).toBe(true);
      expect(body.runId).toMatch(/^fr_/);

      await waitFor(() => {
        const rec = store.getRun(body.runId);
        return rec?.status === 'completed';
      });
      const rec = store.getRun(body.runId)!;
      expect(rec.fused).toBe('FUSED: all done');
      expect(rec.plan?.subtasks).toHaveLength(1);
      expect(rec.workerResults).toHaveLength(1);
      expect(rec.workerResults[0].output).toBe('worker says hi');
      expect(rec.fallbackSingleAgent).toBe(false);
      expect(rec.completedAt).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('falls back to single-agent when the planner output is garbage', async () => {
    const store = new FusionRunStore(dataDir);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/fusion',
      createFusionRouter({
        store,
        getBot: (id) => (id === BOT.id ? BOT : undefined),
        agentRuntime: makeAgentRuntime(),
        callLlm: async () => ({ content: 'garbage{{{', usage: U }),
      }),
    );
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/fusion/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1', task: 'simple' }),
      });
      const { runId } = (await r.json()) as { runId: string };
      await waitFor(() => store.getRun(runId)?.status === 'completed');
      const rec = store.getRun(runId)!;
      expect(rec.fallbackSingleAgent).toBe(true);
      expect(rec.fused).toBe('worker says hi');
    } finally {
      server.close();
    }
  });

  it('GET /runs/:id returns 400 for malformed ids and 404 for unknown', async () => {
    const { app } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      expect((await fetch(`${base}/api/fusion/runs/nope`)).status).toBe(400);
      expect((await fetch(`${base}/api/fusion/runs/fr_abc_def`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('GET /runs lists runs newest-first', async () => {
    const { app, store } = makeApp(dataDir);
    store.createRun({ botId: 'bot1', botName: 'TestBot', task: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    store.createRun({ botId: 'bot1', botName: 'TestBot', task: 'second' });
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/fusion/runs?limit=10`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; runs: Array<{ task: string }> };
      expect(body.runs).toHaveLength(2);
      expect(body.runs[0].task).toBe('second');
    } finally {
      server.close();
    }
  });

  it('GET /runs/:id/stream sends a snapshot for a finished run', async () => {
    const { app, store } = makeApp(dataDir);
    const rec = store.createRun({ botId: 'bot1', botName: 'TestBot', task: 'snap' });
    store.completeRun(rec.runId, {
      task: 'snap',
      status: 'completed',
      plan: null,
      workerResults: [],
      fused: 'done!',
      fallbackSingleAgent: true,
      usage: U,
    });
    const { server, base } = await listen(app);
    try {
      const controller = new AbortController();
      const r = await fetch(`${base}/api/fusion/runs/${rec.runId}/stream`, {
        signal: controller.signal,
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const read = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes('"type":"snapshot"')) break;
        }
        controller.abort();
      })();
      await read;
      expect(text).toContain('"type":"snapshot"');
      expect(text).toContain('done!');
    } finally {
      server.close();
    }
  });

  it('unattended worker approvals fail closed (short timeout)', async () => {
    const seen: Record<string, unknown>[] = [];
    const runtime = {
      runTurn: vi.fn(async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return U;
      }),
    } as unknown as AgentRuntime;
    const { app, store } = makeApp(dataDir, runtime);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/fusion/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1', task: 't' }),
      });
      const { runId } = (await r.json()) as { runId: string };
      await waitFor(() => store.getRun(runId)?.status === 'completed');
      expect(seen[0].approvalTimeoutMs).toBe(5000);
      expect(typeof seen[0].sessionId).toBe('string');
      expect(String(seen[0].sessionId)).toMatch(/^fusion_/);
    } finally {
      server.close();
    }
  });
});

describe('FusionRunStore', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-store-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a run record', () => {
    const store = new FusionRunStore(dataDir);
    const rec = store.createRun({ botId: 'b', botName: 'B', task: 't' });
    expect(rec.status).toBe('running');
    store.setPlan(rec.runId, { subtasks: [] });
    store.completeRun(rec.runId, {
      task: 't',
      status: 'completed',
      plan: { subtasks: [] },
      workerResults: [{ subtaskId: 's1', title: 'A', output: 'o', usage: U }],
      fused: 'f',
      fallbackSingleAgent: false,
      usage: U,
      costUsd: 0.01,
    });
    const got = store.getRun(rec.runId)!;
    expect(got.status).toBe('completed');
    expect(got.fused).toBe('f');
    expect(got.costUsd).toBe(0.01);
    expect(got.workerResults).toHaveLength(1);
    store.close();
  });

  it('failRun marks the run failed', () => {
    const store = new FusionRunStore(dataDir);
    const rec = store.createRun({ botId: 'b', botName: 'B', task: 't' });
    store.failRun(rec.runId, 'kaboom');
    const got = store.getRun(rec.runId)!;
    expect(got.status).toBe('failed');
    expect(got.error).toBe('kaboom');
    store.close();
  });
});
