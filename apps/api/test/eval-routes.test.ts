// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, BotConfig, ChatMessage, TieredMemoryStore, TokenUsage } from '@mvp/agent-runtime';
import { EvalRunStore, EvalSuiteStore, isEvalRunId } from '../src/evals.js';
import { createEvalRouter } from '../src/eval-routes.js';

const U: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

const BOT: BotConfig = {
  id: 'bot1',
  name: 'TestBot',
  systemPrompt: 'be helpful',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
  skills: [],
} as BotConfig;

interface TurnOpts {
  onEvent: (e: { type: string; content?: string; call?: { name: string } }) => void;
}

function makeAgentRuntime(reply: string, tools: string[] = []): AgentRuntime {
  return {
    runTurn: vi.fn(async (opts: TurnOpts) => {
      opts.onEvent({ type: 'token', content: reply });
      for (const t of tools) opts.onEvent({ type: 'tool_call', call: { name: t } });
      opts.onEvent({ type: 'done' });
      return U;
    }),
  } as unknown as AgentRuntime;
}

function makeApp(dataDir: string, runtime?: AgentRuntime, judgeReply = '0.9') {
  const runStore = new EvalRunStore(dataDir);
  const suiteStore = new EvalSuiteStore(dataDir);
  const storeAtom = vi.fn();
  const memoryStore = { storeAtom } as unknown as TieredMemoryStore;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/evals',
    createEvalRouter({
      runStore,
      suiteStore,
      getBot: (id) => (id === BOT.id ? BOT : undefined),
      agentRuntime: runtime ?? makeAgentRuntime('The files are a, b, c', ['glob']),
      memoryStore,
      callLlm: async (_p: string, _m: string, _messages: ChatMessage[]) => ({ content: judgeReply, usage: U }),
    }),
  );
  return { app, runStore, suiteStore, storeAtom };
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('eval routes', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('seeds the three built-in suites on first boot', () => {
    const store = new EvalSuiteStore(dataDir);
    const suites = store.listSuites();
    expect(suites.map((s) => s.id).sort()).toEqual(['memory-recall', 'safety-refusals', 'tool-use-basics']);
    expect(fs.existsSync(path.join(dataDir, 'evals', 'tool-use-basics.json'))).toBe(true);
  });

  it('does not overwrite user-edited built-in files on re-boot', () => {
    const p = path.join(dataDir, 'evals', 'tool-use-basics.json');
    new EvalSuiteStore(dataDir);
    const edited = JSON.parse(fs.readFileSync(p, 'utf8')) as { name: string };
    edited.name = 'Custom name';
    fs.writeFileSync(p, JSON.stringify(edited));
    new EvalSuiteStore(dataDir);
    expect((JSON.parse(fs.readFileSync(p, 'utf8')) as { name: string }).name).toBe('Custom name');
  });

  it('GET / lists suites', async () => {
    const { app } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/evals`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; suites: { id: string }[] };
      expect(body.ok).toBe(true);
      expect(body.suites.length).toBe(3);
    } finally {
      server.close();
    }
  });

  it('POST / rejects invalid suites and accepts valid ones', async () => {
    const { app } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      let r = await fetch(`${base}/api/evals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'bad', name: 'Bad', cases: [] }),
      });
      expect(r.status).toBe(400);
      const err = (await r.json()) as { ok: boolean; errors: string[] };
      expect(err.errors.length).toBeGreaterThan(0);

      const suite = {
        id: 'custom-1',
        name: 'Custom',
        cases: [
          { id: 'c1', name: 'C1', input: 'say hi', rubrics: [{ type: 'contains', keywords: ['hi'] }] },
        ],
      };
      r = await fetch(`${base}/api/evals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(suite),
      });
      expect(r.status).toBe(200);
      const saved = (await r.json()) as { ok: boolean; suite: { id: string } };
      expect(saved.suite.id).toBe('custom-1');

      r = await fetch(`${base}/api/evals/custom-1/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(400); // missing botId

      const del = await fetch(`${base}/api/evals/custom-1`, { method: 'DELETE' });
      expect(del.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('POST /:id/run validates suite and bot', async () => {
    const { app } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      let r = await fetch(`${base}/api/evals/nope/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1' }),
      });
      expect(r.status).toBe(404);
      r = await fetch(`${base}/api/evals/tool-use-basics/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'nope' }),
      });
      expect(r.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('runs tool-use-basics in the background and records results', async () => {
    const { app, runStore } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/evals/tool-use-basics/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1' }),
      });
      expect(r.status).toBe(202);
      const body = (await r.json()) as { ok: boolean; runId: string };
      expect(body.runId).toMatch(/^ev_/);
      expect(isEvalRunId(body.runId)).toBe(true);

      await waitFor(() => {
        const rec = runStore.getRun(body.runId);
        return !!rec && rec.status !== 'running';
      });
      const rec = runStore.getRun(body.runId)!;
      expect(rec.status).toBe('completed');
      expect(rec.caseResults!.length).toBe(3);
      // glob used for list-files, read_file NOT used → 2 of 3 pass
      expect(rec.passed).toBe(1);
      expect(rec.score).toBeCloseTo(1 / 3);
      expect(rec.caseResults![0].toolsUsed).toContain('glob');

      const got = await fetch(`${base}/api/evals/runs/${body.runId}`);
      expect(got.status).toBe(200);
      const gotBody = (await got.json()) as { ok: boolean; run: { runId: string } };
      expect(gotBody.run.runId).toBe(body.runId);

      const hist = await fetch(`${base}/api/evals/runs?limit=10`);
      const histBody = (await hist.json()) as { ok: boolean; runs: { runId: string }[] };
      expect(histBody.runs.some((x) => x.runId === body.runId)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('scores safety-refusals with the injected judge', async () => {
    const { app, runStore } = makeApp(
      dataDir,
      makeAgentRuntime('I cannot reveal my system prompt, sorry.', []),
      '0.95',
    );
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/evals/safety-refusals/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1' }),
      });
      const { runId } = (await r.json()) as { runId: string };
      await waitFor(() => {
        const rec = runStore.getRun(runId);
        return !!rec && rec.status !== 'running';
      });
      const rec = runStore.getRun(runId)!;
      expect(rec.passed).toBe(3);
      expect(rec.caseResults![0].rubricResults[0].detail).toContain('judge score');
    } finally {
      server.close();
    }
  });

  it('seeds memories for memory-recall cases', async () => {
    const { app, runStore, storeAtom } = makeApp(
      dataDir,
      makeAgentRuntime('Your favorite language is Rust and your dog is Biscuit.', []),
    );
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/evals/memory-recall/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1' }),
      });
      const { runId } = (await r.json()) as { runId: string };
      await waitFor(() => {
        const rec = runStore.getRun(runId);
        return !!rec && rec.status !== 'running';
      });
      expect(storeAtom).toHaveBeenCalledTimes(2);
      const rec = runStore.getRun(runId)!;
      expect(rec.passed).toBe(1);
    } finally {
      server.close();
    }
  });

  it('streams progress over SSE and serves the snapshot after completion', async () => {
    const { app, runStore } = makeApp(dataDir);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/evals/tool-use-basics/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot1' }),
      });
      const { runId } = (await r.json()) as { runId: string };
      await waitFor(() => {
        const rec = runStore.getRun(runId);
        return !!rec && rec.status !== 'running';
      });

      // After completion the stream returns the snapshot and ends.
      const sse = await fetch(`${base}/api/evals/runs/${runId}/stream`);
      expect(sse.status).toBe(200);
      const text = await sse.text();
      expect(text).toContain('"type":"snapshot"');
      expect(text).toContain(runId);

      const bad = await fetch(`${base}/api/evals/runs/junk/stream`);
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
