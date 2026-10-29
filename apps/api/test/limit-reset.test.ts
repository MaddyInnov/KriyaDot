// SPDX-License-Identifier: Apache-2.0
// W1: limit-reset trigger kind, resume-time computation, persistent
// pending resumes (survive restart + boot reconciliation), scheduler
// firing, HTTP routes, and per-bot backup persistence.
// Zero paid API usage — fake runtimes only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import { RoutineStore } from '../src/bot-routines.js';
import { registerRoutineRoutes } from '../src/bot-routines.js';
import { RoutineHookStore } from '../src/routine-hooks.js';
import { LimitResetResumeStore } from '../src/limit-reset-resumes.js';
import {
  RoutineScheduler,
  computeLimitResetResumeAt,
  nextRuns,
  validateRoutineSchedule,
} from '../src/routine-schedules.js';
import { applyBotModels, saveBotModel } from '../src/bot-models.js';

const BOT: BotConfig = {
  id: 'helper', name: 'Helper', description: 'test', systemPrompt: 'test',
  provider: 'groq', model: 'gpt-oss-20b', skills: [], tools: [], mcpServers: [],
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'limit-reset-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function limitErr(extra?: Record<string, unknown>): Error {
  const e = new Error('Provider request failed: 429 — {"error":{"code":"insufficient_quota"}}') as Error & Record<string, unknown>;
  e.status = 429;
  e.code = 'insufficient_quota';
  Object.assign(e, extra ?? {});
  return e;
}

describe('limit-reset schedule validation', () => {
  it('accepts a bare limit-reset schedule with defaults', () => {
    const s = validateRoutineSchedule({ kind: 'limit-reset', timezone: 'UTC' });
    expect(s.kind).toBe('limit-reset');
    if (s.kind === 'limit-reset') {
      expect(s.defaultBackoffMinutes).toBe(60);
      expect(s.resumeAt).toBeUndefined();
    }
  });
  it('accepts providerId, backoff and an armed resumeAt', () => {
    const s = validateRoutineSchedule({
      kind: 'limit-reset', timezone: 'Asia/Kolkata', providerId: 'groq',
      defaultBackoffMinutes: 30, resumeAt: '2027-01-01T00:00:00Z',
    });
    expect(s.kind).toBe('limit-reset');
    if (s.kind === 'limit-reset') {
      expect(s.providerId).toBe('groq');
      expect(s.defaultBackoffMinutes).toBe(30);
      expect(s.resumeAt).toBe('2027-01-01T00:00:00Z');
    }
  });
  it('rejects out-of-range backoff and garbage resumeAt', () => {
    expect(() => validateRoutineSchedule({ kind: 'limit-reset', timezone: 'UTC', defaultBackoffMinutes: 0 })).toThrow(/defaultBackoffMinutes/);
    expect(() => validateRoutineSchedule({ kind: 'limit-reset', timezone: 'UTC', defaultBackoffMinutes: 99999 })).toThrow(/defaultBackoffMinutes/);
    expect(() => validateRoutineSchedule({ kind: 'limit-reset', timezone: 'UTC', resumeAt: 'not-a-date' })).toThrow();
  });
});

describe('nextRuns for limit-reset', () => {
  it('unarmed schedule has no next runs; armed schedule fires once at resumeAt', () => {
    const unarmed = validateRoutineSchedule({ kind: 'limit-reset', timezone: 'UTC' });
    expect(nextRuns(unarmed, 5, 1000)).toEqual([]);
    const at = Date.UTC(2027, 0, 1, 0, 0, 0);
    const armed = validateRoutineSchedule({ kind: 'limit-reset', timezone: 'UTC', resumeAt: new Date(at).toISOString() });
    const runs = nextRuns(armed, 5, at - 1000);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.at).toBe(at);
    expect(nextRuns(armed, 5, at + 1000)).toEqual([]);
  });
});

describe('computeLimitResetResumeAt', () => {
  const now = 1_700_000_000_000;
  it('uses the provider reset timestamp from the error', () => {
    const reset = new Date(now + 2 * 3_600_000).toISOString();
    expect(computeLimitResetResumeAt(limitErr({ resetAt: reset }), { nowMs: now })).toBe(now + 2 * 3_600_000);
  });
  it('uses retry-after when no reset is carried', () => {
    expect(computeLimitResetResumeAt(limitErr({ retryAfterMs: 45 * 60_000 }), { nowMs: now })).toBe(now + 45 * 60_000);
  });
  it('falls back to the configurable default backoff', () => {
    expect(computeLimitResetResumeAt(limitErr(), { nowMs: now, defaultBackoffMinutes: 15 })).toBe(now + 15 * 60_000);
    expect(computeLimitResetResumeAt(limitErr(), { nowMs: now })).toBe(now + 60 * 60_000);
  });
});

describe('LimitResetResumeStore persistence + reconciliation', () => {
  it('pending resumes survive a restart (new store instance, same dir)', () => {
    const s1 = new LimitResetResumeStore(dir);
    const r = s1.schedule({ botId: 'helper', providerId: 'groq', resumeAt: Date.now() + 60_000, reason: 'quota' });
    const s2 = new LimitResetResumeStore(dir);
    expect(s2.get(r.id)).toMatchObject({ status: 'pending', providerId: 'groq' });
    expect(s2.listByRoutine(r.routineId ?? 'none')).toEqual([]);
    const r2 = s1.schedule({ routineId: 'rt-1', botId: 'helper', providerId: 'groq', resumeAt: Date.now() + 1000, reason: 'quota' });
    expect(new LimitResetResumeStore(dir).listByRoutine('rt-1')).toHaveLength(1);
    expect(r2.routineId).toBe('rt-1');
  });
  it('reconcileOnBoot recovers crash-orphaned firing resumes to pending', () => {
    const s = new LimitResetResumeStore(dir);
    const r = s.schedule({ botId: 'helper', providerId: 'groq', resumeAt: Date.now() - 1000, reason: 'quota' });
    expect(s.claim(r.id)).toBe(true);
    expect(s.get(r.id)!.status).toBe('firing');
    const rec = new LimitResetResumeStore(dir).reconcileOnBoot();
    expect(rec.recovered).toBe(1);
    expect(rec.due).toBe(1);
    expect(s.get(r.id)!.status).toBe('pending');
  });
  it('duePending, claim, markFired and cancel follow the lifecycle', () => {
    const s = new LimitResetResumeStore(dir);
    const future = s.schedule({ botId: 'b', providerId: 'p', resumeAt: Date.now() + 3_600_000, reason: 'x' });
    const due = s.schedule({ botId: 'b', providerId: 'p', resumeAt: Date.now() - 5, reason: 'x' });
    expect(s.duePending(Date.now()).map((x) => x.id)).toEqual([due.id]);
    expect(s.claim(due.id)).toBe(true);
    expect(s.claim(due.id)).toBe(false); // already claimed
    s.markFired(due.id);
    expect(s.get(due.id)!.status).toBe('fired');
    expect(s.cancel(future.id)).toBe(true);
    expect(s.get(future.id)!.status).toBe('cancelled');
  });
});

describe('RoutineScheduler limit-reset firing', () => {
  function fakeRuntime() {
    const turns: Array<{ message: string }> = [];
    const runtime = {
      runTurn: vi.fn(async (args: { message: string }) => { turns.push({ message: args.message }); }),
    } as unknown as AgentRuntime;
    return { runtime, turns };
  }

  it('arms a resume from a limit error and fires it when due', async () => {
    const routineStore = new RoutineStore(dir);
    const routine = routineStore.create({
      name: 'lr', botId: 'helper', promptTemplate: 'resume the work',
      schedule: validateRoutineSchedule({ kind: 'limit-reset', timezone: 'UTC', providerId: 'groq', defaultBackoffMinutes: 30 }),
    });
    const resumeStore = new LimitResetResumeStore(dir);
    const { runtime, turns } = fakeRuntime();
    const scheduler = new RoutineScheduler({
      routineStore, agentRuntime: runtime, getBots: () => [BOT], resumeStore, now: () => 1_700_000_000_000,
    });
    const resetAt = new Date(1_700_000_000_000 + 10 * 60_000).toISOString();
    const resume = scheduler.armLimitResetResume(routineStore.get(routine.id)!, limitErr({ resetAt }), { providerId: 'groq', nowMs: 1_700_000_000_000 });
    expect(resume.resumeAt).toBe(1_700_000_000_000 + 10 * 60_000);
    expect(resume.status).toBe('pending');
    // Not yet due.
    await scheduler.tick(1_700_000_000_000 + 5 * 60_000);
    expect(turns).toHaveLength(0);
    // Due: fires exactly once and is marked fired.
    await scheduler.tick(1_700_000_000_000 + 11 * 60_000);
    expect(turns).toHaveLength(1);
    expect(resumeStore.get(resume.id)!.status).toBe('fired');
    await scheduler.tick(1_700_000_000_000 + 12 * 60_000);
    expect(turns).toHaveLength(1);
  });

  it('reconcileLimitResetResumes reports recovered + due after a crash', async () => {
    const resumeStore = new LimitResetResumeStore(dir);
    const r = resumeStore.schedule({ botId: 'helper', providerId: 'groq', resumeAt: 1000, reason: 'quota' });
    resumeStore.claim(r.id);
    const routineStore = new RoutineStore(dir);
    const { runtime } = fakeRuntime();
    const scheduler = new RoutineScheduler({ routineStore, agentRuntime: runtime, getBots: () => [BOT], resumeStore });
    expect(scheduler.reconcileLimitResetResumes(2000)).toEqual({ recovered: 1, due: 1 });
  });
});

describe('limit-reset HTTP routes + backup model persistence', () => {
  let base: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    const routinesRouter = express.Router();
    registerRoutineRoutes(routinesRouter, {
      dataDir: dir,
      getBots: () => [BOT],
      hookStore: new RoutineHookStore(dir),
      getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
      resumeStore: new LimitResetResumeStore(dir),
    });
    app.use('/api/routines', routinesRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  it('creates a routine with a limit-reset schedule and arms/lists/cancels a resume', async () => {
    const created = await call('POST', '/api/routines', {
      name: 'lr-routine', botId: 'helper', promptTemplate: 'do it later',
      schedule: { kind: 'limit-reset', timezone: 'UTC', providerId: 'groq', defaultBackoffMinutes: 45 },
    });
    expect(created.status).toBe(201);
    const id = created.json.routine.id as string;
    expect(created.json.routine.schedule).toMatchObject({ kind: 'limit-reset', providerId: 'groq' });

    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const armed = await call('POST', `/api/routines/${id}/limit-reset`, {
      providerId: 'groq', errorMessage: 'quota exceeded', resetAt,
    });
    expect(armed.status).toBe(201);
    expect(armed.json.resume.resumeAt).toBe(new Date(resetAt).getTime());
    expect(armed.json.resume.status).toBe('pending');

    const listed = await call('GET', `/api/routines/${id}/limit-resets`);
    expect(listed.json.resumes).toHaveLength(1);

    const resumeId = armed.json.resume.id as string;
    const cancelled = await call('DELETE', `/api/routines/${id}/limit-resets/${resumeId}`);
    expect(cancelled.json).toMatchObject({ ok: true, cancelled: true });
    const after = await call('GET', `/api/routines/${id}/limit-resets`);
    expect(after.json.resumes[0].status).toBe('cancelled');
  });

  it('arms with the default backoff when no reset signal is supplied', async () => {
    const created = await call('POST', '/api/routines', {
      name: 'lr2', botId: 'helper', promptTemplate: 'later',
      schedule: { kind: 'limit-reset', timezone: 'UTC', defaultBackoffMinutes: 45 },
    });
    const id = created.json.routine.id as string;
    const before = Date.now();
    const armed = await call('POST', `/api/routines/${id}/limit-reset`, { errorMessage: 'usage limit reached' });
    expect(armed.status).toBe(201);
    expect(armed.json.resume.resumeAt).toBeGreaterThanOrEqual(before + 44 * 60_000);
    expect(armed.json.resume.resumeAt).toBeLessThanOrEqual(Date.now() + 46 * 60_000);
  });

  it('rejects an invalid limit-reset schedule with 400', async () => {
    const res = await call('POST', '/api/routines', {
      name: 'bad', botId: 'helper', promptTemplate: 'x',
      schedule: { kind: 'limit-reset', timezone: 'UTC', defaultBackoffMinutes: 0 },
    });
    expect(res.status).toBe(400);
  });

  it('persists per-bot backup provider/model (save + apply at boot)', () => {
    const bots: BotConfig[] = [{ ...BOT }];
    const sel = saveBotModel(dir, bots, 'helper', undefined, undefined, {
      backupProvider: 'anthropic', backupModel: 'claude-3-5-haiku-latest',
    });
    expect(sel).toMatchObject({ backupProvider: 'anthropic', backupModel: 'claude-3-5-haiku-latest' });
    expect(bots[0]!.backupProvider).toBe('anthropic');
    const fresh: BotConfig[] = [{ ...BOT }];
    applyBotModels(fresh, dir);
    expect(fresh[0]!.backupProvider).toBe('anthropic');
    expect(fresh[0]!.backupModel).toBe('claude-3-5-haiku-latest');
    // Clear works too.
    saveBotModel(dir, bots, 'helper', undefined, undefined, { backupProvider: null, backupModel: null });
    expect(bots[0]!.backupProvider).toBeUndefined();
    const fresh2: BotConfig[] = [{ ...BOT }];
    applyBotModels(fresh2, dir);
    expect(fresh2[0]!.backupProvider).toBeUndefined();
  });
});
