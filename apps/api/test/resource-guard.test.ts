// SPDX-License-Identifier: Apache-2.0
// Tests for the resource guard + self-monitoring (B3).
//
// Pressure is SIMULATED through the injectable sampler — these tests never
// allocate real memory or stall the loop. Covered:
// - settings: defaults, env overrides, sanitize invariants, save/load
// - graded reaction: soft → audit event only; hard → shedding starts,
//   new optional work is refused with the measured reason, in-flight
//   work is untouched; hysteresis clears shedding only at "ok"
// - monitor-only mode (shed off) and guard-off (true no-op)
// - snapshot shape + /api/health/self + settings routes
// - scheduler integration: the shed gate blocks new scheduled fires and
//   leaves an in-flight run alone

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import {
  NodePressureSampler,
  ResourceGuard,
  buildSelfSnapshot,
  evaluateSample,
  loadResourceGuardSettings,
  sanitizeResourceGuardSettings,
  saveResourceGuardSettings,
  RESOURCE_GUARD_DEFAULTS,
  type PressureSample,
  type ResourceGuardSettings,
} from '../src/resource-guard.js';
import { registerSelfMonitorRoutes } from '../src/resource-guard-routes.js';
import { RoutineScheduler, validateRoutineSchedule } from '../src/routine-schedules.js';
import { RoutineStore } from '../src/bot-routines.js';

const MB = 1024 * 1024;

const TEST_SETTINGS: ResourceGuardSettings = {
  enabled: true,
  shedEnabled: true,
  memorySoftBytes: 100 * MB,
  memoryHardBytes: 200 * MB,
  eventLoopLagSoftMs: 50,
  eventLoopLagHardMs: 200,
  diskSoftFreeBytes: 50 * MB,
  diskHardFreeBytes: 10 * MB,
  sampleIntervalMs: 1_000,
};

function sample(partial: Partial<PressureSample> = {}): PressureSample {
  return {
    at: 1_000_000,
    rssBytes: 10 * MB,
    heapUsedBytes: 5 * MB,
    heapTotalBytes: 20 * MB,
    eventLoopLagMs: 1,
    diskFreeBytes: 500 * MB,
    diskTotalBytes: 10_000 * MB,
    ...partial,
  };
}

/** Scripted sampler: each sampleNow() consumes the next scripted sample. */
function scriptedSampler(samples: PressureSample[]) {
  let i = 0;
  return { sample: () => samples[Math.min(i++, samples.length - 1)] };
}

function auditRecorder() {
  const entries: Array<{ action: string; detail: unknown }> = [];
  return {
    entries,
    audit: (action: string, fields: { actor?: string; detail?: unknown }) => {
      entries.push({ action, detail: fields.detail });
    },
    actions: () => entries.map((e) => e.action),
  };
}

describe('resource guard settings', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rg-settings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults: monitoring on, shedding on, thresholds aligned with Sentinel', () => {
    const s = loadResourceGuardSettings(dir, {});
    expect(s.enabled).toBe(true);
    expect(s.shedEnabled).toBe(true);
    expect(s.memorySoftBytes).toBe(1.5 * 1024 * MB);
    expect(s.memoryHardBytes).toBe(2.5 * 1024 * MB);
    expect(s.diskSoftFreeBytes).toBe(1024 * MB);
    expect(s.diskHardFreeBytes).toBe(200 * MB);
  });

  it('env overrides apply, and persisted settings win over env', () => {
    const fromEnv = loadResourceGuardSettings(dir, {
      KRIYADOT_RESOURCE_GUARD_SHED: '0',
      KRIYADOT_RESOURCE_GUARD_MEM_SOFT_MB: '100',
      KRIYADOT_RESOURCE_GUARD_MEM_HARD_MB: '900',
    });
    expect(fromEnv.shedEnabled).toBe(false);
    expect(fromEnv.memoryHardBytes).toBe(900 * MB);
    saveResourceGuardSettings(dir, { ...fromEnv, shedEnabled: true, memoryHardBytes: 700 * MB });
    const reloaded = loadResourceGuardSettings(dir, { KRIYADOT_RESOURCE_GUARD_MEM_HARD_MB: '900' });
    expect(reloaded.shedEnabled).toBe(true);
    expect(reloaded.memoryHardBytes).toBe(700 * MB);
    const raw = JSON.parse(readFileSync(join(dir, 'resource-guard-settings.json'), 'utf8')) as ResourceGuardSettings;
    expect(raw.memoryHardBytes).toBe(700 * MB);
  });

  it('KRIYADOT_RESOURCE_GUARD=0 disables the guard', () => {
    expect(loadResourceGuardSettings(dir, { KRIYADOT_RESOURCE_GUARD: '0' }).enabled).toBe(false);
  });

  it('sanitize enforces hard > soft and clamps the interval', () => {
    const s = sanitizeResourceGuardSettings({
      memorySoftBytes: 300 * MB,
      memoryHardBytes: 100 * MB, // below soft — must be raised
      eventLoopLagSoftMs: 500,
      eventLoopLagHardMs: 100, // below soft — must be raised
      diskSoftFreeBytes: 40 * MB,
      diskHardFreeBytes: 90 * MB, // above soft floor — must be lowered
      sampleIntervalMs: 5, // below the 1s floor
    });
    expect(s.memoryHardBytes).toBeGreaterThan(s.memorySoftBytes);
    expect(s.eventLoopLagHardMs).toBeGreaterThan(s.eventLoopLagSoftMs);
    expect(s.diskHardFreeBytes).toBeLessThan(s.diskSoftFreeBytes);
    expect(s.sampleIntervalMs).toBe(1_000);
    expect(RESOURCE_GUARD_DEFAULTS.sampleIntervalMs).toBe(30_000);
  });
});

describe('evaluateSample', () => {
  it('grades each signal and takes the worst level', () => {
    expect(evaluateSample(sample(), TEST_SETTINGS).level).toBe('ok');
    expect(evaluateSample(sample({ rssBytes: 150 * MB }), TEST_SETTINGS).level).toBe('soft');
    expect(evaluateSample(sample({ eventLoopLagMs: 250 }), TEST_SETTINGS).level).toBe('hard');
    expect(evaluateSample(sample({ diskFreeBytes: 5 * MB }), TEST_SETTINGS).level).toBe('hard');
    expect(evaluateSample(sample({ diskFreeBytes: 30 * MB }), TEST_SETTINGS).level).toBe('soft');
  });

  it('treats unmeasurable disk as no reading, never as pressure', () => {
    const ev = evaluateSample(sample({ diskFreeBytes: null, diskTotalBytes: null }), TEST_SETTINGS);
    const disk = ev.signals.find((s) => s.signal === 'disk');
    expect(disk?.level).toBe('ok');
    expect(disk?.measured).toBeNull();
  });
});

describe('ResourceGuard state machine', () => {
  it('soft pressure fires an audit event and sheds nothing', () => {
    const rec = auditRecorder();
    const guard = new ResourceGuard({
      settings: TEST_SETTINGS,
      sampler: scriptedSampler([sample({ rssBytes: 150 * MB })]),
      audit: rec.audit,
      log: () => {},
    });
    const ev = guard.sampleNow();
    expect(ev?.level).toBe('soft');
    expect(rec.actions()).toEqual(['resource_guard.soft_pressure']);
    expect(guard.state().shedding).toBe(false);
    expect(guard.checkOptionalWork('routine:x')).toEqual({ allowed: true });
  });

  it('hard pressure sheds: new optional work refused with the measured reason; in-flight work untouched', async () => {
    const rec = auditRecorder();
    const guard = new ResourceGuard({
      settings: TEST_SETTINGS,
      sampler: scriptedSampler([sample({ rssBytes: 500 * MB })]),
      audit: rec.audit,
      log: () => {},
    });
    // An in-flight "run" the guard must never disturb: it holds a promise
    // the guard has no handle to — the assertion is that it completes
    // normally while shedding is active.
    let release!: () => void;
    const inFlight = new Promise<string>((resolve) => {
      release = () => resolve('done');
    });
    let inFlightSettled = false;
    void inFlight.then(() => {
      inFlightSettled = true;
    });

    const ev = guard.sampleNow();
    expect(ev?.level).toBe('hard');
    expect(guard.state().shedding).toBe(true);
    expect(rec.actions()).toContain('resource_guard.shedding_started');
    // The shedding audit carries the measured values.
    const started = rec.entries.find((e) => e.action === 'resource_guard.shedding_started');
    expect(JSON.stringify(started?.detail)).toContain('524288000');

    const decision = guard.checkOptionalWork('routine:abc');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('RSS 500 MB');
    expect(decision.reason).toContain('routine:abc');
    expect(decision.reason).toContain('in flight is not affected');
    expect(rec.actions()).toContain('resource_guard.work_shed');
    expect(guard.state().denialCount).toBe(1);

    // In-flight work completes on its own schedule — never cancelled.
    expect(inFlightSettled).toBe(false);
    release();
    await expect(inFlight).resolves.toBe('done');
    expect(inFlightSettled).toBe(true);
  });

  it('hysteresis: shedding survives a dip to soft and clears only at ok', () => {
    const rec = auditRecorder();
    const guard = new ResourceGuard({
      settings: TEST_SETTINGS,
      sampler: scriptedSampler([
        sample({ rssBytes: 500 * MB, at: 1_000_000 }),
        sample({ rssBytes: 150 * MB, at: 1_030_000 }),
        sample({ rssBytes: 10 * MB, at: 1_060_000 }),
      ]),
      audit: rec.audit,
      log: () => {},
    });
    guard.sampleNow();
    expect(guard.state().shedding).toBe(true);
    guard.sampleNow(); // soft — still shedding
    expect(guard.state().level).toBe('soft');
    expect(guard.state().shedding).toBe(true);
    expect(guard.checkOptionalWork('routine:x').allowed).toBe(false);
    guard.sampleNow(); // ok — clears
    expect(guard.state().shedding).toBe(false);
    expect(guard.checkOptionalWork('routine:x').allowed).toBe(true);
    expect(rec.actions()).toContain('resource_guard.shedding_cleared');
  });

  it('monitor-only mode: hard pressure is audited but nothing is shed', () => {
    const rec = auditRecorder();
    const guard = new ResourceGuard({
      settings: { ...TEST_SETTINGS, shedEnabled: false },
      sampler: scriptedSampler([sample({ rssBytes: 500 * MB })]),
      audit: rec.audit,
      log: () => {},
    });
    guard.sampleNow();
    expect(guard.state().level).toBe('hard');
    expect(guard.state().shedding).toBe(false);
    expect(rec.actions()).toEqual(['resource_guard.hard_pressure']);
    expect(guard.checkOptionalWork('routine:x').allowed).toBe(true);
  });

  it('guard off is a true no-op: no samples, no audit, all work allowed', () => {
    const rec = auditRecorder();
    let sampled = 0;
    const guard = new ResourceGuard({
      settings: { ...TEST_SETTINGS, enabled: false },
      sampler: {
        sample: () => {
          sampled += 1;
          return sample({ rssBytes: 999 * MB });
        },
      },
      audit: rec.audit,
      log: () => {},
    });
    expect(guard.sampleNow()).toBeNull();
    expect(sampled).toBe(0);
    expect(rec.entries).toHaveLength(0);
    expect(guard.checkOptionalWork('routine:x')).toEqual({ allowed: true });
    expect(guard.state().lastSample).toBeNull();
  });

  it('disabling shedding via updateSettings clears an active shed with an audit entry', () => {
    const rec = auditRecorder();
    const guard = new ResourceGuard({
      settings: TEST_SETTINGS,
      sampler: scriptedSampler([sample({ rssBytes: 500 * MB })]),
      audit: rec.audit,
      log: () => {},
    });
    guard.sampleNow();
    expect(guard.state().shedding).toBe(true);
    guard.updateSettings({ ...TEST_SETTINGS, shedEnabled: false });
    expect(guard.state().shedding).toBe(false);
    expect(rec.actions()).toContain('resource_guard.shedding_cleared');
  });

  it('memory trend reports slope and range from sample history', () => {
    const guard = new ResourceGuard({
      settings: TEST_SETTINGS,
      sampler: scriptedSampler([
        sample({ rssBytes: 100 * MB, at: 0 }),
        sample({ rssBytes: 160 * MB, at: 60_000 }),
      ]),
      log: () => {},
    });
    guard.sampleNow();
    guard.sampleNow();
    const trend = guard.memoryTrend();
    expect(trend.samples).toBe(2);
    expect(trend.rssDeltaBytes).toBe(60 * MB);
    expect(trend.rssSlopeBytesPerMinute).toBe(60 * MB);
    expect(trend.rssMinBytes).toBe(100 * MB);
    expect(trend.rssMaxBytes).toBe(160 * MB);
  });
});

describe('NodePressureSampler (smoke)', () => {
  it('samples real process signals with Node builtins only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-sampler-'));
    const sampler = new NodePressureSampler(dir);
    try {
      const s = sampler.sample();
      expect(s.rssBytes).toBeGreaterThan(0);
      expect(s.eventLoopLagMs).toBeGreaterThanOrEqual(0);
      expect(s.diskFreeBytes).not.toBeNull();
      expect(s.diskTotalBytes).not.toBeNull();
    } finally {
      sampler.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('self-monitoring snapshot + routes', () => {
  let dir: string;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl: string;
  let guard: ResourceGuard;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rg-routes-'));
    guard = new ResourceGuard({
      settings: loadResourceGuardSettings(dir, {}),
      // diskFree comfortably above the default 1 GB soft floor, so the
      // only signal in play is the 42 MB RSS.
      sampler: scriptedSampler([sample({ rssBytes: 42 * MB, diskFreeBytes: 5_000 * MB })]),
      log: () => {},
    });
    guard.sampleNow();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerSelfMonitorRoutes(router, {
      guard,
      dataDir: dir,
      counts: () => ({ activeTurns: 2, runningWorkflowRuns: 1, pendingApprovals: 3 }),
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildSelfSnapshot carries uptime, trend, counts and guard state', () => {
    const snap = buildSelfSnapshot({ guard, counts: { activeTurns: 1 }, now: 123 });
    expect(snap.at).toBe(123);
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snap.process.rssBytes).toBe(42 * MB);
    expect(snap.counts.activeTurns).toBe(1);
    expect(snap.guard.enabled).toBe(true);
    expect(snap.memoryTrend.samples).toBe(1);
  });

  it('GET /health/self serves the snapshot', async () => {
    const res = await fetch(`${baseUrl}/health/self`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: { activeTurns: number }; guard: { level: string } };
    expect(body.counts.activeTurns).toBe(2);
    expect(body.guard.level).toBe('ok');
  });

  it('PUT /health/resource-guard persists settings and applies them live', async () => {
    const res = await fetch(`${baseUrl}/health/resource-guard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: ResourceGuardSettings };
    expect(body.settings.enabled).toBe(false);
    expect(guard.currentSettings.enabled).toBe(false);
    expect(loadResourceGuardSettings(dir, {}).enabled).toBe(false);
    // Disabled guard: sampleNow is a no-op again.
    expect(guard.sampleNow()).toBeNull();
  });
});

describe('scheduler shed gate (B3 integration)', () => {
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
  };

  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(gate: { allowed: boolean; reason?: string }) {
    dir = mkdtempSync(join(tmpdir(), 'rg-sched-'));
    const store = new RoutineStore(dir);
    const turns: Array<{ sessionId: string }> = [];
    const runtime = {
      runTurn: vi.fn(async (args: { sessionId: string }) => {
        turns.push({ sessionId: args.sessionId });
      }),
    } as unknown as AgentRuntime;
    const scheduler = new RoutineScheduler({
      routineStore: store,
      agentRuntime: runtime,
      getBots: () => [BOT],
      optionalWorkGate: () => gate,
    });
    const routine = store.create({
      name: 'cron routine',
      botId: 'helper',
      promptTemplate: 'hello {{payload}}',
      schedule: validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '* * * * *', overlap: 'skip' }),
    });
    const t0 = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 30) / 60_000) * 60_000;
    store.setLastFiredAt(routine.id, t0 - 60_000);
    return { store, scheduler, turns, t0 };
  }

  it('shedding refuses to start a due scheduled routine', async () => {
    const { scheduler, turns, t0 } = setup({ allowed: false, reason: 'Resource guard is shedding (test)' });
    await scheduler.tick(t0 + 30_000);
    expect(turns).toHaveLength(0);
    expect(scheduler.inFlightCount()).toBe(0);
  });

  it('an allowing gate lets the same routine fire', async () => {
    const { scheduler, turns, t0 } = setup({ allowed: true });
    await scheduler.tick(t0 + 30_000);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
  });

  it('shedding that begins mid-run never disturbs the in-flight run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rg-sched-'));
    const store = new RoutineStore(dir);
    let release!: () => void;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    const turns: Array<{ sessionId: string }> = [];
    const runtime = {
      runTurn: vi.fn(async (args: { sessionId: string }) => {
        turns.push({ sessionId: args.sessionId });
        await blocker;
      }),
    } as unknown as AgentRuntime;
    let shedding = false;
    const scheduler = new RoutineScheduler({
      routineStore: store,
      agentRuntime: runtime,
      getBots: () => [BOT],
      optionalWorkGate: () => (shedding ? { allowed: false, reason: 'shedding' } : { allowed: true }),
    });
    const routine = store.create({
      name: 'cron routine',
      botId: 'helper',
      promptTemplate: 'hello {{payload}}',
      schedule: validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '* * * * *', overlap: 'queue' }),
    });
    const t0 = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 30) / 60_000) * 60_000;
    store.setLastFiredAt(routine.id, t0 - 60_000);
    await scheduler.tick(t0 + 30_000);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(scheduler.inFlightCount()).toBe(1);
    // Pressure spikes while the run is in flight: the next due occurrence
    // is shed, but the running turn is left completely alone.
    shedding = true;
    store.setLastFiredAt(routine.id, t0);
    await scheduler.tick(t0 + 90_000);
    expect(turns).toHaveLength(1);
    expect(scheduler.inFlightCount()).toBe(1);
    release();
    await vi.waitFor(() => expect(scheduler.inFlightCount()).toBe(0));
  });
});
