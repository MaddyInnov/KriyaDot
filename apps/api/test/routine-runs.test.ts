// SPDX-License-Identifier: Apache-2.0
// Routine run lifecycle (OpenMausBot parity P0 #7): run records, statuses,
// missed-run catch-up, boot reconciliation, failure-streak auto-pause,
// manual controls (run-now / cancel / retry), and the run-history API.
// The agent runtime is always mocked — zero paid API usage.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, BotConfig, StreamEvent } from '@mvp/agent-runtime';
import { RoutineRunExecutor, RoutineRunStore } from '../src/routine-runs.js';
import { RoutineScheduler, validateRoutineSchedule } from '../src/routine-schedules.js';
import { RoutineStore, registerRoutineRoutes } from '../src/bot-routines.js';
import { registerRoutineRunRoutes } from '../src/routine-run-routes.js';
import { RoutineHookStore } from '../src/routine-hooks.js';

const BOT: BotConfig = {
  id: 'helper',
  name: 'Helper',
  description: 'test',
  systemPrompt: 'test',
  provider: 'groq',
  model: 'gpt-oss-20b',
  skills: [],
  tools: [],
  mcpServers: [],
} as unknown as BotConfig;

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'routine-runs-'));
}

/** Fake runtime that streams two token events then a done event with usage. */
function fakeRuntime(opts?: { failWith?: string; hang?: boolean }) {
  const turns: Array<{ message: string; sessionId: string; signal?: AbortSignal }> = [];
  const runtime = {
    runTurn: vi.fn(async (args: { message: string; sessionId: string; signal?: AbortSignal; onEvent: (e: StreamEvent) => void }) => {
      turns.push({ message: args.message, sessionId: args.sessionId, signal: args.signal });
      if (opts?.failWith) throw new Error(opts.failWith);
      if (opts?.hang) {
        await new Promise<void>((resolve, reject) => {
          args.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      }
      args.onEvent({ type: 'token', content: 'hello ' });
      args.onEvent({ type: 'token', content: 'world' });
      args.onEvent({ type: 'done', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });
      return { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    }),
  } as unknown as AgentRuntime;
  return { runtime, turns };
}

function addCronRoutine(store: RoutineStore, expression: string, extra?: Record<string, unknown>) {
  return store.create({
    name: 'cronjob',
    botId: 'helper',
    promptTemplate: 'do the thing: {{payload}}',
    schedule: validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression, ...extra }),
  });
}

describe('RoutineRunStore lifecycle', () => {
  let d: string;
  beforeEach(() => { d = dir(); });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('runs go queued -> running -> succeeded and record output excerpt + tokens', () => {
    const s = new RoutineRunStore(d);
    const run = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    expect(run.status).toBe('queued');
    expect(run.startedAt).toBeNull();
    const started = s.startRun(run.id);
    expect(started?.status).toBe('running');
    expect(started?.startedAt).not.toBeNull();
    const { run: done, consecutiveFailures } = s.finishRun(run.id, {
      status: 'succeeded',
      outputExcerpt: 'hello world',
      tokens: 15,
    })!;
    expect(done.status).toBe('succeeded');
    expect(done.outputExcerpt).toBe('hello world');
    expect(done.tokens).toBe(15);
    expect(done.endedAt).not.toBeNull();
    expect(consecutiveFailures).toBe(0);
    expect(s.getStreak('r1')).toMatchObject({ consecutiveFailures: 0, lastFailedAt: null });
  });

  it('tracks consecutive failures and resets on success', () => {
    const s = new RoutineRunStore(d);
    for (let i = 0; i < 3; i++) {
      const run = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'schedule' });
      s.startRun(run.id);
      const res = s.finishRun(run.id, { status: 'failed', error: `boom ${i}` })!;
      expect(res.consecutiveFailures).toBe(i + 1);
    }
    expect(s.getStreak('r1').consecutiveFailures).toBe(3);
    expect(s.getStreak('r1').lastFailedAt).not.toBeNull();
    // Success resets the streak.
    const ok = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    s.startRun(ok.id);
    s.finishRun(ok.id, { status: 'succeeded' });
    expect(s.getStreak('r1')).toMatchObject({ consecutiveFailures: 0, lastFailedAt: null });
  });

  it('cancelled runs do not touch the failure streak', () => {
    const s = new RoutineRunStore(d);
    const f = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    s.startRun(f.id);
    s.finishRun(f.id, { status: 'failed', error: 'x' });
    const c = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    s.startRun(c.id);
    s.finishRun(c.id, { status: 'cancelled' });
    expect(s.getStreak('r1').consecutiveFailures).toBe(1);
  });

  it('rejects finishing an already-terminal run', () => {
    const s = new RoutineRunStore(d);
    const run = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    s.startRun(run.id);
    s.finishRun(run.id, { status: 'succeeded' });
    expect(() => s.finishRun(run.id, { status: 'failed', error: 'x' })).toThrow(/already succeeded/);
  });

  it('startRun only works from queued', () => {
    const s = new RoutineRunStore(d);
    const run = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    s.startRun(run.id);
    expect(s.startRun(run.id)).toBeUndefined();
  });

  it('markMissed creates a missed record directly', () => {
    const s = new RoutineRunStore(d);
    const at = Date.UTC(2026, 9, 16, 12, 0, 0);
    const run = s.markMissed('r1', 'R', at, 'skipped: previous run still in flight (overlap: skip)');
    expect(run.status).toBe('missed');
    expect(run.scheduledFor).toBe(at);
    expect(run.error).toContain('overlap: skip');
    expect(run.trigger).toBe('schedule');
  });

  it('reconcileRunning marks queued/running as failed with the restart reason', () => {
    const s = new RoutineRunStore(d);
    const q = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'schedule' });
    const r = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'schedule' });
    s.startRun(r.id);
    const done = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'schedule' });
    s.startRun(done.id);
    s.finishRun(done.id, { status: 'succeeded' });
    expect(s.reconcileRunning()).toBe(2);
    expect(s.get(q.id)?.status).toBe('failed');
    expect(s.get(r.id)?.error).toContain('server restarted');
    expect(s.get(done.id)?.status).toBe('succeeded');
    // Interrupted runs are not routine failures: the streak is untouched.
    expect(s.getStreak('r1').consecutiveFailures).toBe(0);
  });

  it('cancelRun moves queued/running to cancelled and refuses terminal runs', () => {
    const s = new RoutineRunStore(d);
    const q = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    expect(s.cancelRun(q.id)).toBe(true);
    expect(s.get(q.id)?.status).toBe('cancelled');
    expect(s.cancelRun(q.id)).toBe(false);
    expect(s.cancelRun('nope')).toBe(false);
  });

  it('lists runs newest-first with pagination', () => {
    const s = new RoutineRunStore(d);
    for (let i = 0; i < 25; i++) {
      const run = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
      s.startRun(run.id);
      s.finishRun(run.id, { status: 'succeeded' });
    }
    expect(s.countByRoutine('r1')).toBe(25);
    const page1 = s.listByRoutine('r1', 10, 0);
    const page2 = s.listByRoutine('r1', 10, 10);
    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(10);
    expect(new Set([...page1, ...page2].map((r) => r.id)).size).toBe(20);
    // Newest first.
    expect(page1[0].createdAt).toBeGreaterThanOrEqual(page2[9].createdAt);
  });

  it('deleteByRoutine removes runs and streaks', () => {
    const s = new RoutineRunStore(d);
    const run = s.createRun({ routineId: 'r1', routineName: 'R', trigger: 'manual' });
    s.startRun(run.id);
    s.finishRun(run.id, { status: 'failed', error: 'x' });
    s.deleteByRoutine('r1');
    expect(s.countByRoutine('r1')).toBe(0);
    expect(s.getStreak('r1').consecutiveFailures).toBe(0);
  });
});

describe('RoutineRunExecutor', () => {
  let d: string;
  beforeEach(() => { d = dir(); });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('records a successful run with output excerpt and tokens', async () => {
    const { runtime, turns } = fakeRuntime();
    const runStore = new RoutineRunStore(d);
    const ex = new RoutineRunExecutor({ runStore, agentRuntime: runtime, getBots: () => [BOT] });
    const routine = { id: 'r1', name: 'R', botId: 'helper', promptTemplate: 'do: {{payload}}', enabled: true, createdAt: 0 };
    const settled = await ex.executeWait({ routine, trigger: 'manual', payload: { a: 1 } });
    expect(settled.status).toBe('succeeded');
    expect(turns).toHaveLength(1);
    expect(turns[0].message).toContain('"a":1');
    const run = runStore.get(settled.runId)!;
    expect(run.status).toBe('succeeded');
    expect(run.outputExcerpt).toBe('hello world');
    expect(run.tokens).toBe(15);
    expect(run.trigger).toBe('manual');
  });

  it('records failures with the error message', async () => {
    const { runtime } = fakeRuntime({ failWith: 'boom' });
    const runStore = new RoutineRunStore(d);
    const ex = new RoutineRunExecutor({ runStore, agentRuntime: runtime, getBots: () => [BOT] });
    const routine = { id: 'r1', name: 'R', botId: 'helper', promptTemplate: 'x', enabled: true, createdAt: 0 };
    const settled = await ex.executeWait({ routine, trigger: 'webhook', payload: {} });
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('boom');
    expect(runStore.get(settled.runId)?.status).toBe('failed');
    expect(runStore.getStreak('r1').consecutiveFailures).toBe(1);
  });

  it('cancel aborts a running turn and marks the run cancelled', async () => {
    const { runtime } = fakeRuntime({ hang: true });
    const runStore = new RoutineRunStore(d);
    const ex = new RoutineRunExecutor({ runStore, agentRuntime: runtime, getBots: () => [BOT] });
    const routine = { id: 'r1', name: 'R', botId: 'helper', promptTemplate: 'x', enabled: true, createdAt: 0 };
    let settledStatus: string | undefined;
    const runId = await ex.execute({ routine, trigger: 'manual', onSettled: (r) => { settledStatus = r.status; } });
    expect(ex.isActive(runId)).toBe(true);
    expect(ex.cancel(runId)).toBe(true);
    await vi.waitFor(() => expect(settledStatus).toBe('cancelled'));
    expect(runStore.get(runId)?.status).toBe('cancelled');
    expect(ex.isActive(runId)).toBe(false);
    // A cancelled run is not a failure.
    expect(runStore.getStreak('r1').consecutiveFailures).toBe(0);
  });

  it('cancel on a terminal run returns false', async () => {
    const { runtime } = fakeRuntime();
    const runStore = new RoutineRunStore(d);
    const ex = new RoutineRunExecutor({ runStore, agentRuntime: runtime, getBots: () => [BOT] });
    const routine = { id: 'r1', name: 'R', botId: 'helper', promptTemplate: 'x', enabled: true, createdAt: 0 };
    const settled = await ex.executeWait({ routine, trigger: 'manual' });
    expect(ex.cancel(settled.runId)).toBe(false);
  });

  it('throws for an unknown bot before creating a run', async () => {
    const { runtime } = fakeRuntime();
    const runStore = new RoutineRunStore(d);
    const ex = new RoutineRunExecutor({ runStore, agentRuntime: runtime, getBots: () => [BOT] });
    const routine = { id: 'r1', name: 'R', botId: 'ghost', promptTemplate: 'x', enabled: true, createdAt: 0 };
    await expect(ex.execute({ routine, trigger: 'manual' })).rejects.toThrow(/Unknown bot/);
    expect(runStore.countByRoutine('r1')).toBe(0);
  });
});

describe('RoutineScheduler run lifecycle', () => {
  let d: string;
  let store: RoutineStore;
  let runStore: RoutineRunStore;
  beforeEach(() => {
    d = dir();
    store = new RoutineStore(d);
    runStore = new RoutineRunStore(d);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  function schedulerWith(runtime: AgentRuntime, extra?: Record<string, unknown>) {
    const fires: Array<{ routineId: string; ok: boolean; skipped?: boolean; error?: string }> = [];
    const paused: Array<{ id: string; streak: number }> = [];
    const sched = new RoutineScheduler({
      routineStore: store,
      runStore,
      agentRuntime: runtime,
      getBots: () => [BOT],
      onFire: (info) => fires.push({ routineId: info.routine.id, ok: info.ok, skipped: info.skipped, error: info.error }),
      onScheduleAutoPaused: (routine, streak) => paused.push({ id: routine.id, streak }),
      ...extra,
    });
    return { sched, fires, paused };
  }

  it('scheduled fires create succeeded run records', async () => {
    const { runtime, turns } = fakeRuntime();
    const { sched, fires } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '0 12 * * *');
    const t0 = Date.UTC(2026, 9, 16, 11, 59, 0);
    store.setLastFiredAt(routine.id, t0);
    await sched.tick(Date.UTC(2026, 9, 16, 12, 1, 0));
    await vi.waitFor(() => expect(fires).toHaveLength(1));
    expect(turns).toHaveLength(1);
    const runs = runStore.listByRoutine(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      outputExcerpt: 'hello world',
      tokens: 15,
      scheduledFor: Date.UTC(2026, 9, 16, 12, 0, 0),
    });
  });

  it('overlap skips leave missed run records', async () => {
    const { runtime, turns } = fakeRuntime({ hang: true });
    const { sched, fires } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '* * * * *', { overlap: 'skip' });
    const t0 = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 30) / 60_000) * 60_000;
    store.setLastFiredAt(routine.id, t0 - 60_000);
    await sched.tick(t0 + 30_000);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    store.setLastFiredAt(routine.id, t0);
    await sched.tick(t0 + 90_000);
    expect(fires.some((f) => f.skipped)).toBe(true);
    const runs = runStore.listByRoutine(routine.id);
    const missed = runs.filter((r) => r.status === 'missed');
    expect(missed).toHaveLength(1);
    expect(missed[0].error).toContain('overlap: skip');
    sched.stop();
  });

  it('failed schedule fires record the error and grow the streak', async () => {
    const { runtime } = fakeRuntime({ failWith: 'kaput' });
    const { sched, fires } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '0 12 * * *');
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 11, 59, 0));
    await sched.tick(Date.UTC(2026, 9, 16, 12, 1, 0));
    await vi.waitFor(() => expect(fires).toHaveLength(1));
    const runs = runStore.listByRoutine(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'kaput' });
    expect(runStore.getStreak(routine.id).consecutiveFailures).toBe(1);
  });

  it('auto-pauses the schedule after failureStreakLimit consecutive failures', async () => {
    const { runtime } = fakeRuntime({ failWith: 'always' });
    const { sched, fires, paused } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '* * * * *', { failureStreakLimit: 2 });
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 12, 0, 0));
    await sched.tick(Date.UTC(2026, 9, 16, 12, 1, 30));
    await vi.waitFor(() => expect(fires).toHaveLength(1));
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 12, 1, 30));
    await sched.tick(Date.UTC(2026, 9, 16, 12, 2, 30));
    await vi.waitFor(() => expect(fires).toHaveLength(2));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ id: routine.id, streak: 2 });
    expect(store.get(routine.id)?.schedule?.enabled).toBe(false);
  });

  it('reconcileMissedRuns marks downtime occurrences as missed', async () => {
    const { runtime, turns } = fakeRuntime();
    const { sched } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '0 * * * *'); // hourly
    // Server was down for 3 hours.
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 9, 0, 0));
    const res = await sched.reconcileMissedRuns(Date.UTC(2026, 9, 16, 12, 0, 0));
    expect(res.routines).toBe(1);
    expect(res.missed).toBe(3);
    expect(res.catchUpRuns).toBe(0);
    expect(turns).toHaveLength(0); // nothing fired
    const missed = runStore.listByRoutine(routine.id);
    expect(missed.every((r) => r.status === 'missed')).toBe(true);
    expect(missed.every((r) => r.error?.includes('server was down'))).toBe(true);
  });

  it('reconcileMissedRuns runs bounded catch-up for catchUp:true', async () => {
    const { runtime, turns } = fakeRuntime();
    const { sched } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '* * * * *', { catchUp: true }); // every minute
    // Down for 10 minutes → 10 missed, but at most 3 backfill runs.
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 12, 0, 0));
    const res = await sched.reconcileMissedRuns(Date.UTC(2026, 9, 16, 12, 10, 0));
    expect(res.missed).toBe(10);
    expect(res.catchUpRuns).toBe(3);
    await vi.waitFor(() => expect(turns).toHaveLength(3));
  });

  it('reconcileMissedRuns ignores windows older than the catch-up window', async () => {
    const { runtime, turns } = fakeRuntime();
    const { sched } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '0 * * * *');
    // Down for 3 days — beyond the default 24h window.
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 13, 12, 0, 0));
    const res = await sched.reconcileMissedRuns(Date.UTC(2026, 9, 16, 12, 0, 0));
    expect(res).toMatchObject({ routines: 0, missed: 0, catchUpRuns: 0 });
    expect(turns).toHaveLength(0);
    expect(runStore.countByRoutine(routine.id)).toBe(0);
  });

  it('reconcileMissedRuns skips routines without a watermark or with disabled schedules', async () => {
    const { runtime } = fakeRuntime();
    const { sched } = schedulerWith(runtime);
    addCronRoutine(store, '0 * * * *'); // no watermark → skipped
    const disabled = store.create({
      name: 'off',
      botId: 'helper',
      promptTemplate: 'x',
      schedule: validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '0 * * * *', enabled: false }),
    });
    store.setLastFiredAt(disabled.id, Date.UTC(2026, 9, 16, 9, 0, 0));
    const res = await sched.reconcileMissedRuns(Date.UTC(2026, 9, 16, 12, 0, 0));
    expect(res).toMatchObject({ routines: 0, missed: 0 });
  });

  it('runNow fires a manual run', async () => {
    const { runtime, turns } = fakeRuntime();
    const { sched } = schedulerWith(runtime);
    const routine = store.create({ name: 'manual', botId: 'helper', promptTemplate: 'go {{payload}}' });
    const runId = await sched.runNow(routine.id);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const run = runStore.get(runId)!;
    expect(run).toMatchObject({ trigger: 'manual', status: 'succeeded' });
    expect(turns[0].message).toContain('"source":"manual"');
  });

  it('runNow refuses unknown routines, paused routines, and unknown bots', async () => {
    const { runtime } = fakeRuntime();
    const { sched } = schedulerWith(runtime);
    await expect(sched.runNow('nope')).rejects.toThrow(/Unknown routine/);
    const paused = store.create({ name: 'p', botId: 'helper', promptTemplate: 'x', schedule: null });
    store.update(paused.id, { enabled: false });
    await expect(sched.runNow(paused.id)).rejects.toThrow(/paused/);
    const ghost = store.create({ name: 'g', botId: 'ghost', promptTemplate: 'x' });
    await expect(sched.runNow(ghost.id)).rejects.toThrow(/Unknown bot/);
  });

  it('cancelRun aborts a running scheduled run', async () => {
    const { runtime, turns } = fakeRuntime({ hang: true });
    const { sched } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '0 12 * * *');
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 11, 59, 0));
    await sched.tick(Date.UTC(2026, 9, 16, 12, 1, 0));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const running = runStore.listByRoutine(routine.id).find((r) => r.status === 'running');
    expect(running).toBeDefined();
    expect(sched.cancelRun(running!.id)).toBe(true);
    await vi.waitFor(() => expect(runStore.get(running!.id)?.status).toBe('cancelled'));
    sched.stop();
  });

  it('retryRun creates a fresh manual run from a failed run', async () => {
    const fail = fakeRuntime({ failWith: 'bad' });
    const { sched } = schedulerWith(fail.runtime);
    const routine = addCronRoutine(store, '0 12 * * *');
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 11, 59, 0));
    await sched.tick(Date.UTC(2026, 9, 16, 12, 1, 0));
    await vi.waitFor(() => expect(runStore.listByRoutine(routine.id)).toHaveLength(1));
    const failed = runStore.listByRoutine(routine.id)[0];
    expect(failed.status).toBe('failed');
    const newId = await sched.retryRun(failed.id);
    expect(newId).not.toBe(failed.id);
    await vi.waitFor(() => expect(runStore.get(newId)?.status).toBe('failed'));
    expect(runStore.get(newId)).toMatchObject({ trigger: 'manual', scheduledFor: failed.scheduledFor });
  });

  it('retryRun refuses non-failed runs', async () => {
    const { runtime } = fakeRuntime();
    const { sched } = schedulerWith(runtime);
    const routine = addCronRoutine(store, '0 12 * * *');
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 11, 59, 0));
    await sched.tick(Date.UTC(2026, 9, 16, 12, 1, 0));
    await vi.waitFor(() => expect(runStore.listByRoutine(routine.id)).toHaveLength(1));
    const ok = runStore.listByRoutine(routine.id)[0];
    await expect(sched.retryRun(ok.id)).rejects.toThrow(/only failed\/cancelled\/missed/);
    await expect(sched.retryRun('nope')).rejects.toThrow(/Unknown run/);
  });
});

describe('schedule validation: run-governance options', () => {
  it('accepts catchUp and failureStreakLimit', () => {
    const s = validateRoutineSchedule({
      kind: 'cron',
      timezone: 'UTC',
      expression: '* * * * *',
      catchUp: true,
      failureStreakLimit: 5,
    });
    expect(s.catchUp).toBe(true);
    expect(s.failureStreakLimit).toBe(5);
  });

  it('defaults catchUp:false and failureStreakLimit:3', () => {
    const s = validateRoutineSchedule({ kind: 'daily', timezone: 'UTC', time: '09:00' });
    expect(s.catchUp).toBe(false);
    expect(s.failureStreakLimit).toBe(3);
  });

  it('rejects invalid governance values', () => {
    expect(() =>
      validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '* * * * *', catchUp: 'yes' }),
    ).toThrow(/catchUp must be a boolean/);
    expect(() =>
      validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '* * * * *', failureStreakLimit: 0 }),
    ).toThrow(/failureStreakLimit/);
    expect(() =>
      validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '* * * * *', failureStreakLimit: 21 }),
    ).toThrow(/failureStreakLimit/);
  });
});

describe('routine run API', () => {
  let d: string;
  let base: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: RoutineStore;
  let runStore: RoutineRunStore;
  let scheduler: RoutineScheduler;
  const bots = [BOT];

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  beforeEach(async () => {
    d = dir();
    const app = express();
    app.use(express.json());
    const routinesRouter = express.Router();
    const hookStore = new RoutineHookStore(d);
    runStore = new RoutineRunStore(d);
    const reg = registerRoutineRoutes(routinesRouter, {
      dataDir: d,
      getBots: () => bots,
      hookStore,
      getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
      runStore,
    });
    store = reg.routineStore;
    const { runtime } = fakeRuntime();
    scheduler = new RoutineScheduler({
      routineStore: store,
      runStore,
      agentRuntime: runtime,
      getBots: () => bots,
    });
    registerRoutineRunRoutes(routinesRouter, { routineStore: store, runStore, scheduler });
    app.use('/api/routines', routinesRouter);
    await new Promise<void>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve());
      server = s;
    });
    base = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}`;
  });

  afterEach(async () => {
    scheduler.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    rmSync(d, { recursive: true, force: true });
  });

  it('lists paginated runs with the failure streak', async () => {
    const r = await req('POST', '/api/routines', { name: 'R', botId: 'helper', promptTemplate: 'x' });
    const id = r.json.routine.id as string;
    for (let i = 0; i < 5; i++) {
      const run = runStore.createRun({ routineId: id, routineName: 'R', trigger: 'manual' });
      runStore.startRun(run.id);
      runStore.finishRun(run.id, { status: i < 2 ? 'failed' : 'succeeded', error: i < 2 ? 'e' : null });
    }
    const page = await req('GET', `/api/routines/${id}/runs?limit=2&offset=2`);
    expect(page.status).toBe(200);
    expect(page.json.runs).toHaveLength(2);
    expect(page.json.total).toBe(5);
    expect(page.json.streak).toMatchObject({ consecutiveFailures: 0 });
  });

  it('returns run detail and 404s for unknown runs/routines', async () => {
    const r = await req('POST', '/api/routines', { name: 'R', botId: 'helper', promptTemplate: 'x' });
    const id = r.json.routine.id as string;
    const run = runStore.createRun({ routineId: id, routineName: 'R', trigger: 'manual' });
    const detail = await req('GET', `/api/routines/${id}/runs/${run.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.run.id).toBe(run.id);
    expect((await req('GET', `/api/routines/${id}/runs/nope`)).status).toBe(404);
    expect((await req('GET', `/api/routines/nope/runs`)).status).toBe(404);
    expect((await req('GET', `/api/routines/bad id!/runs`)).status).toBe(400);
  });

  it('run-now starts a manual run (202)', async () => {
    const r = await req('POST', '/api/routines', { name: 'R', botId: 'helper', promptTemplate: 'x' });
    const id = r.json.routine.id as string;
    const res = await req('POST', `/api/routines/${id}/run-now`);
    expect(res.status).toBe(202);
    expect(res.json.runId).toBeTruthy();
    await vi.waitFor(() => expect(runStore.get(res.json.runId as string)?.status).toBe('succeeded'));
  });

  it('run-now refuses paused routines', async () => {
    const r = await req('POST', '/api/routines', { name: 'R', botId: 'helper', promptTemplate: 'x' });
    const id = r.json.routine.id as string;
    await req('PATCH', `/api/routines/${id}`, { enabled: false });
    const res = await req('POST', `/api/routines/${id}/run-now`);
    expect(res.status).toBe(400);
  });

  it('cancel and retry a failed run', async () => {
    const r = await req('POST', '/api/routines', { name: 'R', botId: 'helper', promptTemplate: 'x' });
    const id = r.json.routine.id as string;
    const run = runStore.createRun({ routineId: id, routineName: 'R', trigger: 'manual' });
    runStore.startRun(run.id);
    runStore.finishRun(run.id, { status: 'failed', error: 'e' });
    const retry = await req('POST', `/api/routines/${id}/runs/${run.id}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.json.runId).not.toBe(run.id);
    const cancelDone = await req('POST', `/api/routines/${id}/runs/${run.id}/cancel`);
    expect(cancelDone.json.cancelled).toBe(false); // already terminal
    // Retry a succeeded run is refused.
    const okRun = runStore.get(retry.json.runId as string)!;
    await vi.waitFor(() => expect(runStore.get(okRun.id)?.status).toBe('succeeded'));
    expect((await req('POST', `/api/routines/${id}/runs/${okRun.id}/retry`)).status).toBe(400);
  });

  it('deleting a routine cascades its run history', async () => {
    const r = await req('POST', '/api/routines', { name: 'R', botId: 'helper', promptTemplate: 'x' });
    const id = r.json.routine.id as string;
    runStore.createRun({ routineId: id, routineName: 'R', trigger: 'manual' });
    expect(runStore.countByRoutine(id)).toBe(1);
    const del = await req('DELETE', `/api/routines/${id}`);
    expect(del.status).toBe(200);
    expect(runStore.countByRoutine(id)).toBe(0);
  });
});
