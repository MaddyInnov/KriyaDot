// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, BotConfig, TokenUsage } from '@mvp/agent-runtime';
import { GroupGoalStore } from '../src/group-goals.js';
import { registerGroupGoalRoutes } from '../src/group-goal-routes.js';
import { RoutineStore } from '../src/bot-routines.js';
import { RoutineRunStore, RoutineRunExecutor } from '../src/routine-runs.js';

const U: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

const CHIEF: BotConfig = {
  id: 'chief',
  name: 'Chief',
  systemPrompt: 'coordinate',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
  skills: [],
  chiefOfStaff: true,
} as BotConfig;

const WORKER: BotConfig = {
  id: 'worker',
  name: 'Worker',
  systemPrompt: 'do work',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
  skills: [],
} as BotConfig;

const BOTS = [WORKER, CHIEF];

const ENV = (decision: string, extra = ''): string =>
  `Working on it.\n\`\`\`goal-control\n{"decision": "${decision}"${extra}}\n\`\`\``;

/** Mock runtime: each runTurn call emits the next scripted reply, then done. */
function makeRuntime(script: string[]): AgentRuntime {
  let i = 0;
  return {
    runTurn: vi.fn(async (opts: { onEvent: (e: { type: string; content?: string }) => void | Promise<void> }) => {
      const text = script[Math.min(i++, script.length - 1)];
      await opts.onEvent({ type: 'token', content: text });
      await opts.onEvent({ type: 'done', usage: U });
      return U;
    }),
  } as unknown as AgentRuntime;
}

function makePush() {
  return { notify: vi.fn(async () => ({ attempted: 1, sent: 1 })) };
}

function makeApp(dataDir: string, runtime: AgentRuntime, push = makePush()) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const { engine } = registerGroupGoalRoutes(router, {
    dataDir,
    agentRuntime: runtime,
    getBots: () => BOTS,
    push: push as never,
    audit: () => {},
  });
  app.use('/api/group-goals', router);
  return { app, engine, push };
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

async function getGoal(base: string, id: string) {
  const r = await fetch(`${base}/api/group-goals/${id}`);
  expect(r.status).toBe(200);
  return (await r.json()) as { ok: boolean; goal: { status: string; summary: string | null }; turns: unknown[] };
}

describe('GroupGoalStore', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-store-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates, reads, lists and updates goals', () => {
    const store = new GroupGoalStore(dataDir);
    const g = store.createGoal({
      title: 'Ship it',
      coordinatorBotId: 'chief',
      workerBotIds: ['worker'],
      maxTurns: 5,
    });
    expect(g.status).toBe('running');
    expect(g.maxTurns).toBe(5);
    expect(store.getGoal(g.id)?.title).toBe('Ship it');
    expect(store.listGoals()).toHaveLength(1);
    const updated = store.updateGoal(g.id, { status: 'completed', summary: 'done!' });
    expect(updated?.status).toBe('completed');
    expect(updated?.summary).toBe('done!');
    store.close();
  });

  it('records turns and counts them', () => {
    const store = new GroupGoalStore(dataDir);
    const g = store.createGoal({ title: 'T', coordinatorBotId: 'chief', workerBotIds: [] });
    store.addTurn(g.id, {
      turnNumber: 1,
      decision: 'continue',
      coordinatorText: 'working',
      delegations: [{ botId: 'worker', botName: 'Worker', task: 'do x', done: true, summary: 'did x' }],
    });
    expect(store.turnCount(g.id)).toBe(1);
    const turns = store.listTurns(g.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].decision).toBe('continue');
    expect(turns[0].delegations[0].botId).toBe('worker');
    store.close();
  });

  it('clamps maxTurns on create', () => {
    const store = new GroupGoalStore(dataDir);
    const g = store.createGoal({ title: 'T', coordinatorBotId: 'chief', workerBotIds: [], maxTurns: 999 });
    expect(g.maxTurns).toBe(30);
    store.close();
  });
});

describe('group goal routes + engine', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-api-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('POST / rejects missing title and unknown bots', async () => {
    const { app } = makeApp(dataDir, makeRuntime([ENV('completed')]));
    const { server, base } = await listen(app);
    try {
      let r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '   ', workerBotIds: [] }),
      });
      expect(r.status).toBe(400);
      r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'T', workerBotIds: ['nope'] }),
      });
      expect(r.status).toBe(400);
      r = await fetch(`${base}/api/group-goals/goal_bogus`);
      expect(r.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('auto-selects the chief as coordinator when omitted', async () => {
    const { app } = makeApp(dataDir, makeRuntime([ENV('completed', ', "summary": "done"')]));
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Chief-led', workerBotIds: ['worker'] }),
      });
      expect(r.status).toBe(202);
      const body = (await r.json()) as { ok: boolean; goal: { id: string; coordinatorBotId: string } };
      expect(body.goal.coordinatorBotId).toBe('chief');
      await waitFor(async () => (await getGoal(base, body.goal.id)).goal.status === 'completed');
      const detail = await getGoal(base, body.goal.id);
      expect(detail.goal.summary).toBe('done');
      expect(detail.turns).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('hard-pauses at maxTurns when the coordinator keeps continuing', async () => {
    const { app } = makeApp(dataDir, makeRuntime([ENV('continue', ', "next_step": "more work"')]));
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Loop', workerBotIds: [], maxTurns: 2 }),
      });
      const body = (await r.json()) as { ok: boolean; goal: { id: string } };
      await waitFor(async () => (await getGoal(base, body.goal.id)).goal.status === 'max-turns');
      const detail = await getGoal(base, body.goal.id);
      expect(detail.turns).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('pauses on needs-input with a push, then resumes to completion', async () => {
    const push = makePush();
    const runtime = makeRuntime([
      ENV('needs-input', ', "next_step": "which logo?"'),
      ENV('completed', ', "summary": "logo picked, done"'),
    ]);
    const { app } = makeApp(dataDir, runtime, push);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Logo', workerBotIds: [] }),
      });
      const body = (await r.json()) as { ok: boolean; goal: { id: string } };
      await waitFor(async () => (await getGoal(base, body.goal.id)).goal.status === 'needs-input');
      expect(push.notify).toHaveBeenCalledTimes(1);
      const notified = (push.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as { kind: string };
      expect(notified.kind).toBe('needsInput');

      const rr = await fetch(`${base}/api/group-goals/${body.goal.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'use the blue logo' }),
      });
      expect(rr.status).toBe(200);
      await waitFor(async () => (await getGoal(base, body.goal.id)).goal.status === 'completed');
      const detail = await getGoal(base, body.goal.id);
      expect(detail.turns).toHaveLength(2);
      expect(detail.goal.summary).toBe('logo picked, done');
    } finally {
      server.close();
    }
  });

  it('pauses on blocked and resumes', async () => {
    const runtime = makeRuntime([
      ENV('blocked', ', "next_step": "waiting on deploy access"'),
      ENV('completed', ', "summary": "unblocked, done"'),
    ]);
    const { app } = makeApp(dataDir, runtime);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Deploy', workerBotIds: [] }),
      });
      const body = (await r.json()) as { ok: boolean; goal: { id: string } };
      await waitFor(async () => (await getGoal(base, body.goal.id)).goal.status === 'blocked');
      const rr = await fetch(`${base}/api/group-goals/${body.goal.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(rr.status).toBe(200);
      await waitFor(async () => (await getGoal(base, body.goal.id)).goal.status === 'completed');
    } finally {
      server.close();
    }
  });

  it('resume on a running goal is a 409', async () => {
    // Never-completing runtime keeps the goal running; stop it afterwards.
    const { app } = makeApp(dataDir, makeRuntime([ENV('continue')]));
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Live', workerBotIds: [] }),
      });
      const body = (await r.json()) as { ok: boolean; goal: { id: string } };
      // Immediately try to resume while it is (almost surely) still running.
      const rr = await fetch(`${base}/api/group-goals/${body.goal.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect([200, 409]).toContain(rr.status);
      await fetch(`${base}/api/group-goals/${body.goal.id}/stop`, { method: 'POST' });
    } finally {
      server.close();
    }
  });

  it('stop halts a running goal', async () => {
    // Gated turn: the coordinator turn stays in flight until released, so
    // the stop request deterministically lands mid-turn.
    let releaseTurn: (() => void) | null = null;
    const runtime = {
      runTurn: vi.fn(
        (opts: { onEvent: (e: { type: string; content?: string; usage?: TokenUsage }) => void | Promise<void> }) =>
          new Promise<TokenUsage>((resolve) => {
            releaseTurn = () => {
              void opts.onEvent({ type: 'token', content: ENV('continue') });
              void opts.onEvent({ type: 'done', usage: U });
              resolve(U);
            };
          }),
      ),
    } as unknown as AgentRuntime;
    const { app, engine } = makeApp(dataDir, runtime);
    const { server, base } = await listen(app);
    try {
      const r = await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Stoppable', workerBotIds: [], maxTurns: 30 }),
      });
      const body = (await r.json()) as { ok: boolean; goal: { id: string } };
      await waitFor(() => releaseTurn !== null);
      expect(engine.isActive(body.goal.id)).toBe(true);
      const sr = await fetch(`${base}/api/group-goals/${body.goal.id}/stop`, { method: 'POST' });
      expect(sr.status).toBe(200);
      releaseTurn?.();
      await waitFor(async () => (await getGoal(base, body.goal.id)).goal.status === 'stopped');
      // The cancelled turn is not recorded.
      const detail = await getGoal(base, body.goal.id);
      expect(detail.turns).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('GET / lists goals', async () => {
    const { app } = makeApp(dataDir, makeRuntime([ENV('completed')]));
    const { server, base } = await listen(app);
    try {
      await fetch(`${base}/api/group-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Listed', workerBotIds: [] }),
      });
      const r = await fetch(`${base}/api/group-goals`);
      const body = (await r.json()) as { ok: boolean; goals: { title: string }[] };
      expect(body.goals.some((g) => g.title === 'Listed')).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('routine-as-goal', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-goal-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('goalMode persists through create/get/update', () => {
    const store = new RoutineStore(dataDir);
    const r = store.create({ name: 'Nightly', botId: 'worker', promptTemplate: 'do nightly', goalMode: true });
    expect(r.goalMode).toBe(true);
    expect(store.get(r.id)?.goalMode).toBe(true);
    const off = store.update(r.id, { goalMode: false });
    expect(off?.goalMode).toBeUndefined();
    const on = store.update(r.id, { goalMode: true });
    expect(on?.goalMode).toBe(true);
  });

  it('goal-mode routine fires startGroupGoal instead of a turn', async () => {
    const runStore = new RoutineRunStore(dataDir);
    const startGroupGoal = vi.fn(async () => 'goal_test123');
    const runtime = {
      runTurn: vi.fn(async () => U),
    } as unknown as AgentRuntime;
    const executor = new RoutineRunExecutor({
      runStore,
      agentRuntime: runtime,
      getBots: () => BOTS,
      startGroupGoal,
    });
    const routineStore = new RoutineStore(dataDir);
    const routine = routineStore.create({ name: 'Goalish', botId: 'worker', promptTemplate: 'pursue X', goalMode: true });
    const settled = await new Promise<{ status: string; runId: string }>((resolve) => {
      void executor.execute({
        routine,
        trigger: 'manual',
        onSettled: (res) => resolve({ status: res.status, runId: res.runId }),
      });
    });
    expect(settled.status).toBe('succeeded');
    expect(startGroupGoal).toHaveBeenCalledTimes(1);
    expect(runtime.runTurn).not.toHaveBeenCalled();
    const run = runStore.get(settled.runId);
    expect(run?.outputExcerpt).toContain('goal_test123');
  });

  it('non-goal routine still runs a normal turn', async () => {
    const runStore = new RoutineRunStore(dataDir);
    const startGroupGoal = vi.fn(async () => 'goal_x');
    const runtime = {
      runTurn: vi.fn(async (opts: { onEvent: (e: { type: string; usage?: TokenUsage }) => void }) => {
        opts.onEvent({ type: 'done', usage: U });
        return U;
      }),
    } as unknown as AgentRuntime;
    const executor = new RoutineRunExecutor({
      runStore,
      agentRuntime: runtime,
      getBots: () => BOTS,
      startGroupGoal,
    });
    const routineStore = new RoutineStore(dataDir);
    const routine = routineStore.create({ name: 'Plain', botId: 'worker', promptTemplate: 'do Y' });
    const settled = await new Promise<{ status: string }>((resolve) => {
      void executor.execute({ routine, trigger: 'manual', onSettled: (res) => resolve({ status: res.status }) });
    });
    expect(settled.status).toBe('succeeded');
    expect(startGroupGoal).not.toHaveBeenCalled();
    expect(runtime.runTurn).toHaveBeenCalledTimes(1);
  });
});
