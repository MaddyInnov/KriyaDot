// SPDX-License-Identifier: Apache-2.0
// Placement + anchors + reporting (Part 5). HTTP + store + scheduler-gate
// tests with stub runtimes; no network beyond loopback, no paid APIs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PlacementStore,
  ReportingService,
  anchorLabel,
  createPlacementRouter,
  inQuietHours,
  resolveRoutineAnchor,
  shouldExecuteForRole,
} from '../src/placement.js';
import { SyncHubStore } from '../src/sync-hub.js';
import { RoutineStore, registerRoutineRoutes, type BotRoutine } from '../src/bot-routines.js';
import { RoutineHookStore } from '../src/routine-hooks.js';
import { RoutineScheduler } from '../src/routine-schedules.js';
import type { BotConfig } from '@mvp/agent-runtime';

const OWNER = 'owner-token-p';
const BOTS = [{ id: 'worker', name: 'Worker', description: 'd', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] }] as unknown as BotConfig[];
const DAILY = { kind: 'daily', timezone: 'UTC', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6], enabled: true, overlap: 'skip' } as const;

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  const addr = server.address();
  return { server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}
function tmp(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

describe('anchor resolution', () => {
  it('explicit anchor wins', () => {
    expect(resolveRoutineAnchor({ schedule: DAILY as never, explicitAnchor: 'local', cloudConnected: true })).toEqual({ anchor: 'local', anchorWarning: false });
    expect(resolveRoutineAnchor({ schedule: null, explicitAnchor: 'cloud', cloudConnected: false }).anchor).toBe('cloud');
  });
  it('time-based defaults to cloud when connected, else local WITH warning', () => {
    expect(resolveRoutineAnchor({ schedule: DAILY as never, cloudConnected: true })).toEqual({ anchor: 'cloud', anchorWarning: false });
    expect(resolveRoutineAnchor({ schedule: DAILY as never, cloudConnected: false })).toEqual({ anchor: 'local', anchorWarning: true });
  });
  it('manual/webhook-only routines follow the bot placement executor side', () => {
    expect(resolveRoutineAnchor({ schedule: null, botPlacement: 'cloud-report', cloudConnected: false }).anchor).toBe('cloud');
    expect(resolveRoutineAnchor({ schedule: null, botPlacement: 'cloud-only', cloudConnected: false }).anchor).toBe('cloud');
    expect(resolveRoutineAnchor({ schedule: null, botPlacement: 'local', cloudConnected: true }).anchor).toBe('local');
    expect(resolveRoutineAnchor({ schedule: null, cloudConnected: false }).anchor).toBe('local');
  });
  it('anchorLabel uses the exact plain-words strings', () => {
    expect(anchorLabel({ anchor: 'cloud' }, false)).toBe('Runs in your cloud — fires even while your PC is off');
    expect(anchorLabel({ anchor: 'local' }, true)).toBe("Runs on this device — only while it's on");
    expect(anchorLabel({ schedule: DAILY as never }, true)).toBe('Runs in your cloud — fires even while your PC is off');
  });
  it('executor gate matches anchor to role both ways', () => {
    expect(shouldExecuteForRole('cloud', 'cloud')).toBe(true);
    expect(shouldExecuteForRole('cloud', 'local')).toBe(false);
    expect(shouldExecuteForRole('local', 'local')).toBe(true);
    expect(shouldExecuteForRole('local', 'cloud')).toBe(false);
    expect(shouldExecuteForRole(undefined, 'local')).toBe(true);
  });
});

describe('routine routes resolve anchors at create/update', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('anchor-routes-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function boot(cloudConnected: boolean) {
    const app = express();
    app.use(express.json());
    const r = express.Router();
    registerRoutineRoutes(r, {
      dataDir: dir,
      getBots: () => BOTS,
      hookStore: new RoutineHookStore(dir),
      getBaseUrls: () => ({ localPort: 4567 }),
      resolveAnchor: ({ schedule, botId, explicitAnchor }) =>
        resolveRoutineAnchor({ schedule, explicitAnchor, botPlacement: 'local', cloudConnected }),
    });
    app.use('/api/routines', r);
    return listen(app);
  }

  it('daily routine created with cloud connected is cloud-anchored; explicit local wins; webhook-only follows bot', async () => {
    const { server, base } = await boot(true);
    try {
      const create = async (body: Record<string, unknown>) => {
        const res = await fetch(`${base}/api/routines`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return (await res.json()) as { routine: BotRoutine };
      };
      const daily = await create({ name: 'd', botId: 'worker', promptTemplate: 'x', schedule: DAILY });
      expect(daily.routine.anchor).toBe('cloud');
      expect(daily.routine.anchorWarning).toBeUndefined();
      const explicit = await create({ name: 'e', botId: 'worker', promptTemplate: 'x', schedule: DAILY, anchor: 'local', reporting: { mode: 'both', quietStart: '22:00', quietEnd: '07:00' } });
      expect(explicit.routine.anchor).toBe('local');
      expect(explicit.routine.reporting).toEqual({ mode: 'both', quietStart: '22:00', quietEnd: '07:00' });
      const manual = await create({ name: 'm', botId: 'worker', promptTemplate: 'x' });
      expect(manual.routine.anchor).toBe('local');
    } finally { server.close(); }
  });

  it('daily routine with NO cloud is local-anchored with the warning', async () => {
    const { server, base } = await boot(false);
    try {
      const res = await fetch(`${base}/api/routines`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'd', botId: 'worker', promptTemplate: 'x', schedule: DAILY }) });
      const json = (await res.json()) as { routine: BotRoutine };
      expect(json.routine.anchor).toBe('local');
      expect(json.routine.anchorWarning).toBe(true);
    } finally { server.close(); }
  });
});

describe('RoutineScheduler executor gate', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('gate-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function scenario(shouldExecute: boolean) {
    const store = new RoutineStore(dir);
    const routine = store.create({
      name: 'gated', botId: 'worker', promptTemplate: 'hi',
      schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 1, enabled: true, overlap: 'skip' } as never,
    });
    store.setLastFiredAt(routine.id, Date.now() - 120_000);
    const runTurn = vi.fn(async () => ({ totalTokens: 0 }));
    const scheduler = new RoutineScheduler({
      routineStore: store,
      agentRuntime: { runTurn } as never,
      getBots: () => BOTS,
      shouldExecute: () => shouldExecute,
    });
    await scheduler.tick(Date.now());
    await new Promise((r) => setTimeout(r, 60));
    return runTurn;
  }

  it('non-executor side never fires', async () => {
    expect((await scenario(false)).mock.calls.length).toBe(0);
  });
  it('executor side fires', async () => {
    expect((await scenario(true)).mock.calls.length).toBeGreaterThan(0);
  });
});

describe('placement routes', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('placement-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function boot(opts: { configured: boolean; active?: boolean }) {
    const store = new PlacementStore(dir);
    const pushes: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(express.json());
    app.use('/api', createPlacementRouter({
      dataDir: dir,
      store,
      loopbackToken: OWNER,
      getBots: () => BOTS as never,
      getRoutinesForBot: () => [],
      hasActiveRunForBot: () => opts.active ?? false,
      isSyncConfigured: () => opts.configured,
      pushPlacement: async (a) => { pushes.push(a as never); },
      role: 'local',
    }));
    return { store, pushes, app };
  }
  const put = async (base: string, botId: string, body: unknown) => {
    const res = await fetch(`${base}/api/placement/bots/${botId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, never> };
  };

  it('GET /placement returns placements + role + syncConfigured', async () => {
    const { app, store } = boot({ configured: true });
    store.setBot('worker', { placement: 'cloud-report' });
    const { server, base } = await listen(app);
    try {
      const json = (await (await fetch(`${base}/api/placement`, { headers: { authorization: `Bearer ${OWNER}` } })).json()) as Record<string, never>;
      expect(json).toMatchObject({ role: 'local', syncConfigured: true });
      expect((json.bots as Record<string, unknown>).worker).toMatchObject({ placement: 'cloud-report' });
    } finally { server.close(); }
  });

  it('flip to cloud without a sync target → 409 cloud-not-connected', async () => {
    const { app } = boot({ configured: false });
    const { server, base } = await listen(app);
    try {
      const r = await put(base, 'worker', { placement: 'cloud-only' });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('cloud-not-connected');
    } finally { server.close(); }
  });

  it('flip to cloud with a run in flight → 409 run-in-flight', async () => {
    const { app } = boot({ configured: true, active: true });
    const { server, base } = await listen(app);
    try {
      const r = await put(base, 'worker', { placement: 'cloud-report' });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('run-in-flight');
    } finally { server.close(); }
  });

  it('flip to cloud pushes executorHere=true; flip back pushes false; localOnly toggles independently', async () => {
    const { app, pushes, store } = boot({ configured: true });
    const { server, base } = await listen(app);
    try {
      const up = await put(base, 'worker', { placement: 'cloud-report' });
      expect(up.status).toBe(200);
      expect(pushes[0]).toMatchObject({ botId: 'worker', executorHere: true, placement: 'cloud-report' });
      expect(store.getBot('worker').placement).toBe('cloud-report');
      const down = await put(base, 'worker', { placement: 'local' });
      expect(down.status).toBe(200);
      expect(pushes[1]).toMatchObject({ executorHere: false });
      const lo = await put(base, 'worker', { localOnly: true });
      expect(lo.status).toBe(200);
      expect(store.getBot('worker')).toMatchObject({ placement: 'local', localOnly: true });
    } finally { server.close(); }
  });
});

describe('reporting: quiet hours, failure bypass, digest', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('reporting-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const routine = (reporting?: BotRoutine['reporting']): BotRoutine => ({
    id: 'r1', name: 'Nightly', botId: 'worker', promptTemplate: 'x', enabled: true, createdAt: 1,
    ...(reporting ? { reporting } : {}),
  });
  // 23:30 local — inside a 22:00–07:00 quiet window in any timezone.
  const quietTime = new Date(2026, 0, 15, 23, 30).getTime();
  const morning = new Date(2026, 0, 16, 8, 0).getTime();

  it('inQuietHours handles overnight windows', () => {
    const rep = { mode: 'instant' as const, quietStart: '22:00', quietEnd: '07:00' };
    expect(inQuietHours(rep, new Date(quietTime))).toBe(true);
    expect(inQuietHours(rep, new Date(morning))).toBe(false);
    expect(inQuietHours(undefined, new Date(quietTime))).toBe(false);
  });

  it('instant notice defers during quiet hours, flushes after; failures bypass quiet hours', async () => {
    const notices: unknown[] = [];
    const sync = new SyncHubStore(dir);
    const svc = new ReportingService(dir, { notify: (n) => { notices.push(n); }, syncStore: sync });
    const rep = { mode: 'instant' as const, quietStart: '22:00', quietEnd: '07:00' };
    const deferred = await svc.reportRun({ routine: routine(rep), ok: true, at: quietTime });
    expect(deferred).toEqual({ notified: false, deferred: true });
    expect(notices).toHaveLength(0);
    expect(svc.pendingCount()).toBe(1);
    // The run itself is still recorded as sync activity immediately.
    expect(sync.listActivity('routine-run')).toHaveLength(1);

    const failed = await svc.reportRun({ routine: routine(rep), ok: false, error: 'boom', at: quietTime });
    expect(failed.notified).toBe(true);
    expect(notices).toHaveLength(1);

    expect(await svc.flushPending(quietTime)).toBe(0); // still quiet
    expect(await svc.flushPending(morning)).toBe(1); // flushed at quiet end
    expect(notices).toHaveLength(2);
    expect(svc.pendingCount()).toBe(0);
  });

  it('daily mode sends no instant notice', async () => {
    const notices: unknown[] = [];
    const svc = new ReportingService(dir, { notify: (n) => { notices.push(n); } });
    const out = await svc.reportRun({ routine: routine({ mode: 'daily' }), ok: true, at: morning });
    expect(out.notified).toBe(false);
    expect(notices).toHaveLength(0);
  });

  it('daily digest is created once per day as a sync activity + local record', () => {
    const sync = new SyncHubStore(dir);
    const svc = new ReportingService(dir, { syncStore: sync });
    const digest = svc.maybeCreateDailyDigest({
      date: '2026-01-15',
      runs: [
        { routineId: 'r1', routineName: 'Nightly', status: 'succeeded' },
        { routineId: 'r2', routineName: 'Watch', status: 'failed', error: 'x' },
      ],
      now: morning,
    });
    expect(digest).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(svc.maybeCreateDailyDigest({ date: '2026-01-15', runs: [{ routineId: 'r1', routineName: 'Nightly', status: 'succeeded' }] })).toBeNull();
    const acts = sync.listActivity('daily-digest');
    expect(acts).toHaveLength(1);
    expect(svc.listDigests()).toHaveLength(1);
  });
});
