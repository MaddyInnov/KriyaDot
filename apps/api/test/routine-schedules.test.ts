// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/routine-schedules.ts: cron parsing/validation,
// timezone-aware next-run computation (incl. DST edges), schedule
// validation, and the RoutineScheduler engine (mocked clock + runtime).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import {
  RoutineScheduler,
  assertValidTimeZone,
  cronMatchesZone,
  describeSchedule,
  nextRuns,
  occurrencesBetween,
  parseCron,
  parseIsoWithOffset,
  validateRoutineSchedule,
  wallToUtcMs,
  zonedParts,
} from '../src/routine-schedules.js';
import { RoutineStore } from '../src/bot-routines.js';

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

function fakeRuntime() {
  const turns: Array<{ bot: BotConfig; message: string; sessionId: string }> = [];
  const runtime = {
    runTurn: vi.fn(async (args: { bot: BotConfig; message: string; sessionId: string }) => {
      turns.push({ bot: args.bot, message: args.message, sessionId: args.sessionId });
    }),
  } as unknown as AgentRuntime;
  return { runtime, turns };
}

describe('timezone helpers', () => {
  it('rejects unknown timezones', () => {
    expect(() => assertValidTimeZone('Mars/Olympus')).toThrow(/unknown timezone/);
    expect(() => assertValidTimeZone('')).toThrow(/required/);
    expect(() => assertValidTimeZone('Asia/Kolkata')).not.toThrow();
  });

  it('converts wall clock to UTC in Asia/Kolkata', () => {
    // 09:00 IST (+05:30) == 03:30 UTC
    const at = wallToUtcMs('Asia/Kolkata', { year: 2026, month: 10, day: 17, hour: 9, minute: 0 });
    expect(at).toBe(Date.UTC(2026, 9, 17, 3, 30, 0));
  });

  it('returns null for a nonexistent DST-gap time', () => {
    // America/New_York springs forward 2026-03-08 02:00 -> 03:00; 02:30 never exists.
    expect(wallToUtcMs('America/New_York', { year: 2026, month: 3, day: 8, hour: 2, minute: 30 })).toBeNull();
  });

  it('resolves ambiguous fall-back times deterministically', () => {
    // 2026-11-01 01:30 occurs twice in New York; must pick one consistently.
    const a = wallToUtcMs('America/New_York', { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    const b = wallToUtcMs('America/New_York', { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    // And it must be a real 01:30 wall reading either way.
    const p = zonedParts('America/New_York', a as number);
    expect(p.hour).toBe(1);
    expect(p.minute).toBe(30);
  });
});

describe('parseIsoWithOffset', () => {
  it('parses Z and numeric offsets', () => {
    expect(parseIsoWithOffset('2026-10-17T09:00:00Z')).toBe(Date.UTC(2026, 9, 17, 9, 0, 0));
    expect(parseIsoWithOffset('2026-10-17T09:00:00+05:30')).toBe(Date.UTC(2026, 9, 17, 3, 30, 0));
    expect(parseIsoWithOffset('2026-10-17T09:00:00-04:00')).toBe(Date.UTC(2026, 9, 17, 13, 0, 0));
  });

  it('rejects impossible dates and garbage', () => {
    expect(() => parseIsoWithOffset('2026-02-30T09:00:00Z')).toThrow(/impossible/);
    expect(() => parseIsoWithOffset('not-a-date')).toThrow(/invalid datetime/);
    expect(() => parseIsoWithOffset('2026-10-17T09:00')).toThrow(/invalid datetime/); // no offset
  });
});

describe('parseCron', () => {
  it('accepts standard expressions', () => {
    expect(() => parseCron('0 9 * * 1-5')).not.toThrow();
    expect(() => parseCron('*/15 9-17 * * *')).not.toThrow();
    expect(() => parseCron('30 2 29 2 *')).not.toThrow(); // Feb 29: leap years exist
    expect(() => parseCron('0 0 * * 0')).not.toThrow();
    expect(() => parseCron('0 0 * * 7')).not.toThrow(); // 7 == Sunday
    expect(() => parseCron('0 9 * JAN Mon')).not.toThrow(); // names
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('0 9 * *')).toThrow(/5-field/);
    expect(() => parseCron('* * * * * *')).toThrow(/5-field/);
    expect(() => parseCron('61 9 * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 25 * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 9 * * * ')).not.toThrow(); // trailing space ok
    expect(() => parseCron('0 9 * * FOO')).toThrow(/invalid day-of-week/);
  });

  it('rejects impossible calendar dates', () => {
    expect(() => parseCron('0 9 30 2 *')).toThrow(/impossible date/); // Feb 30
    expect(() => parseCron('0 9 31 4 *')).toThrow(/impossible date/); // Apr 31
    expect(() => parseCron('0 9 31 2,4 *')).toThrow(/impossible date/);
  });

  it('uses OR semantics for dom/dow', () => {
    const parsed = parseCron('0 9 15 * 3'); // 15th of month OR Wednesday
    // 2026-10-15 is a Thursday and the 15th -> dom matches
    expect(cronMatchesZone(parsed, zonedParts('UTC', Date.UTC(2026, 9, 15, 9, 0)))).toBe(true);
    // 2026-10-21 is a Wednesday, not the 15th -> dow matches
    expect(cronMatchesZone(parsed, zonedParts('UTC', Date.UTC(2026, 9, 21, 9, 0)))).toBe(true);
    // 2026-10-16: neither
    expect(cronMatchesZone(parsed, zonedParts('UTC', Date.UTC(2026, 9, 16, 9, 0)))).toBe(false);
  });

  it('treats a starred dom as dow-decides', () => {
    const parsed = parseCron('0 9 * * 1'); // Mondays
    expect(cronMatchesZone(parsed, zonedParts('UTC', Date.UTC(2026, 9, 19, 9, 0)))).toBe(true); // Monday
    expect(cronMatchesZone(parsed, zonedParts('UTC', Date.UTC(2026, 9, 20, 9, 0)))).toBe(false); // Tuesday
  });
});

describe('validateRoutineSchedule', () => {
  it('validates each kind and applies defaults', () => {
    const once = validateRoutineSchedule({ kind: 'once', timezone: 'Asia/Kolkata', runAt: '2026-10-20T09:00+05:30' });
    expect(once.kind).toBe('once');
    expect(once.enabled).toBe(true);
    expect(once.overlap).toBe('skip');

    const daily = validateRoutineSchedule({ kind: 'daily', timezone: 'UTC', time: '09:00', weekdays: [1, 3, 5] });
    expect(daily).toMatchObject({ kind: 'daily', time: '09:00', weekdays: [1, 3, 5] });

    const cron = validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '0 9 * * *' });
    expect(cron).toMatchObject({ kind: 'cron', expression: '0 9 * * *' });

    const interval = validateRoutineSchedule({ kind: 'interval', timezone: 'UTC', everyMinutes: 30 });
    expect(interval).toMatchObject({ kind: 'interval', everyMinutes: 30 });
  });

  it('rejects bad inputs', () => {
    expect(() => validateRoutineSchedule({ kind: 'daily', timezone: 'UTC', time: '9:00' })).toThrow(/HH:mm/);
    expect(() => validateRoutineSchedule({ kind: 'daily', timezone: 'UTC', time: '25:00' })).toThrow(/HH:mm/);
    expect(() => validateRoutineSchedule({ kind: 'daily', timezone: 'UTC', time: '09:00', weekdays: [] })).toThrow(/weekdays/);
    expect(() => validateRoutineSchedule({ kind: 'daily', timezone: 'UTC', time: '09:00', weekdays: [7] })).toThrow(/weekdays/);
    expect(() => validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '0 9 30 2 *' })).toThrow(/impossible/);
    expect(() => validateRoutineSchedule({ kind: 'interval', timezone: 'UTC', everyMinutes: 0 })).toThrow(/1\.\.10080/);
    expect(() => validateRoutineSchedule({ kind: 'interval', timezone: 'UTC', everyMinutes: 15, windowStart: '09:00' })).toThrow(/both/);
    expect(() => validateRoutineSchedule({ kind: 'once', timezone: 'Nope/Zone', runAt: '2026-10-20T09:00+05:30' })).toThrow(/unknown timezone/);
    expect(() => validateRoutineSchedule({ kind: 'once', timezone: 'UTC', runAt: '2026-10-20 09:00' })).toThrow(/ISO 8601/);
    expect(() => validateRoutineSchedule({ kind: 'bogus', timezone: 'UTC' })).toThrow(/one of/);
    expect(() => validateRoutineSchedule(null)).toThrow(/must be an object/);
  });

  it('rejects a once runAt in the DST gap', () => {
    expect(() =>
      validateRoutineSchedule({ kind: 'once', timezone: 'America/New_York', runAt: '2026-03-08T02:30' }),
    ).toThrow(/does not exist/);
  });
});

describe('nextRuns', () => {
  const FROM = Date.UTC(2026, 9, 16, 12, 0, 0); // Fri 2026-10-16 12:00 UTC

  it('once: returns the instant when future, empty when past', () => {
    const s = validateRoutineSchedule({ kind: 'once', timezone: 'UTC', runAt: '2026-10-17T09:00:00Z' });
    const runs = nextRuns(s, 5, FROM);
    expect(runs).toHaveLength(1);
    expect(runs[0].at).toBe(Date.UTC(2026, 9, 17, 9, 0, 0));
    const past = validateRoutineSchedule({ kind: 'once', timezone: 'UTC', runAt: '2026-10-15T09:00:00Z' });
    expect(nextRuns(past, 5, FROM)).toHaveLength(0);
  });

  it('once: interprets wall-clock runAt in the schedule timezone', () => {
    const s = validateRoutineSchedule({ kind: 'once', timezone: 'Asia/Kolkata', runAt: '2026-10-17T09:00' });
    const runs = nextRuns(s, 5, FROM);
    expect(runs[0].at).toBe(Date.UTC(2026, 9, 17, 3, 30, 0));
    expect(runs[0].label).toContain('Asia/Kolkata');
  });

  it('daily: next Mon/Wed/Fri 09:00 Asia/Kolkata from Fri noon UTC', () => {
    const s = validateRoutineSchedule({
      kind: 'daily', timezone: 'Asia/Kolkata', time: '09:00', weekdays: [1, 3, 5],
    });
    const runs = nextRuns(s, 3, FROM);
    // FROM is Fri 17:30 IST; next is Fri 09:00 IST? No — 09:00 IST today already
    // passed (17:30 > 09:00), so next is Mon 2026-10-19 09:00 IST.
    expect(runs).toHaveLength(3);
    expect(runs[0].at).toBe(Date.UTC(2026, 9, 19, 3, 30, 0));
    expect(runs[1].at).toBe(Date.UTC(2026, 9, 21, 3, 30, 0));
    expect(runs[2].at).toBe(Date.UTC(2026, 9, 23, 3, 30, 0));
  });

  it('daily: skips the DST-gap day', () => {
    const s = validateRoutineSchedule({ kind: 'daily', timezone: 'America/New_York', time: '02:30' });
    // From 2026-03-07 00:00 EST: 03-07 02:30 EST exists, 03-08 02:30 does not
    // (spring-forward gap), 03-09 02:30 EDT does.
    const runs = nextRuns(s, 3, Date.UTC(2026, 2, 7, 5, 0, 0));
    expect(runs).toHaveLength(3);
    const labels = runs.map((r) => r.label);
    expect(labels[0]).toContain('2026-03-07 02:30');
    expect(labels[1]).toContain('2026-03-09 02:30'); // 03-08 skipped
    expect(labels[2]).toContain('2026-03-10 02:30');
  });

  it('cron: basic matching in a zone', () => {
    const s = validateRoutineSchedule({ kind: 'cron', timezone: 'Asia/Kolkata', expression: '0 9 * * *' });
    const runs = nextRuns(s, 2, FROM);
    expect(runs).toHaveLength(2);
    // Next 09:00 IST after Fri 17:30 IST is Sat 09:00 IST = 03:30 UTC.
    expect(runs[0].at).toBe(Date.UTC(2026, 9, 17, 3, 30, 0));
    expect(runs[1].at).toBe(Date.UTC(2026, 9, 18, 3, 30, 0));
  });

  it('cron: fires exactly once across a fall-back overlap', () => {
    const s = validateRoutineSchedule({ kind: 'cron', timezone: 'America/New_York', expression: '30 1 * * *' });
    // 01:30 occurs twice on 2026-11-01; the schedule must yield one occurrence that day.
    const runs = nextRuns(s, 3, Date.UTC(2026, 9, 31, 12, 0, 0));
    const nov1 = runs.filter((r) => r.label.startsWith('2026-11-01 01:30'));
    expect(nov1).toHaveLength(1);
  });

  it('interval: every 30m from anchor within a window', () => {
    const s = validateRoutineSchedule({
      kind: 'interval', timezone: 'UTC', everyMinutes: 30,
      anchorTime: '09:00', windowStart: '09:00', windowEnd: '10:00',
    });
    const runs = nextRuns(s, 5, Date.UTC(2026, 9, 16, 8, 0, 0));
    expect(runs.map((r) => r.at)).toEqual([
      Date.UTC(2026, 9, 16, 9, 0, 0),
      Date.UTC(2026, 9, 16, 9, 30, 0),
      // 10:00 is excluded (window end is exclusive); next day 09:00.
      Date.UTC(2026, 9, 17, 9, 0, 0),
      Date.UTC(2026, 9, 17, 9, 30, 0),
      Date.UTC(2026, 9, 18, 9, 0, 0),
    ]);
  });

  it('interval: respects endsAt and weekday filter', () => {
    const s = validateRoutineSchedule({
      kind: 'interval', timezone: 'UTC', everyMinutes: 60,
      weekdays: [1], // Mondays only; 2026-10-19 is a Monday
      endsAt: '2026-10-20T00:00:00Z',
    });
    const runs = nextRuns(s, 100, Date.UTC(2026, 9, 16, 12, 0, 0));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThanOrEqual(24);
    for (const r of runs) {
      expect(new Date(r.at).getUTCDay()).toBe(1);
      expect(r.at).toBeLessThanOrEqual(Date.UTC(2026, 9, 20, 0, 0, 0));
    }
  });

  it('interval: overnight windows wrap midnight', () => {
    const s = validateRoutineSchedule({
      kind: 'interval', timezone: 'UTC', everyMinutes: 120,
      windowStart: '22:00', windowEnd: '02:00',
    });
    const runs = nextRuns(s, 4, Date.UTC(2026, 9, 16, 12, 0, 0));
    // Grid is anchored at 00:00 UTC, so occurrences at 22:00 and 00:00.
    expect(runs.map((r) => r.at)).toEqual([
      Date.UTC(2026, 9, 16, 22, 0, 0),
      Date.UTC(2026, 9, 17, 0, 0, 0),
      Date.UTC(2026, 9, 17, 22, 0, 0),
      Date.UTC(2026, 9, 18, 0, 0, 0),
    ]);
  });

  it('occurrencesBetween returns the occurrences inside a window', () => {
    const s = validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '0 * * * *' });
    const occ = occurrencesBetween(s, Date.UTC(2026, 9, 16, 12, 10), Date.UTC(2026, 9, 16, 14, 5));
    expect(occ.map((r) => r.at)).toEqual([
      Date.UTC(2026, 9, 16, 13, 0, 0),
      Date.UTC(2026, 9, 16, 14, 0, 0),
    ]);
  });

  it('describeSchedule produces human-readable summaries', () => {
    expect(describeSchedule(validateRoutineSchedule({ kind: 'daily', timezone: 'UTC', time: '09:00' }))).toContain('daily at 09:00');
    expect(describeSchedule(validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '0 9 * * *' }))).toContain('cron "0 9 * * *"');
  });
});

describe('RoutineScheduler', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'mvp-routine-sched-'));
    const store = new RoutineStore(dir);
    const { runtime, turns } = fakeRuntime();
    const fires: Array<{ routineId: string; ok: boolean; skipped?: boolean; error?: string }> = [];
    const scheduler = new RoutineScheduler({
      routineStore: store,
      agentRuntime: runtime,
      getBots: () => [BOT],
      onFire: (info) => fires.push({ routineId: info.routine.id, ok: info.ok, skipped: info.skipped, error: info.error }),
    });
    return { store, runtime, turns, fires, scheduler };
  }

  function addCronRoutine(store: RoutineStore, expression: string, overlap: 'skip' | 'queue' = 'skip') {
    return store.create({
      name: 'cron routine',
      botId: 'helper',
      promptTemplate: 'hello {{payload}}',
      schedule: validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression, overlap }),
    });
  }

  it('fires a due schedule and does not double-fire', async () => {
    const { store, scheduler, turns, fires } = setup();
    const routine = addCronRoutine(store, '* * * * *');
    // Watermark to a minute boundary in the past; the '*' cron is due every minute.
    const t0 = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 30) / 60_000) * 60_000;
    store.setLastFiredAt(routine.id, t0 - 60_000);
    await scheduler.tick(t0 + 30_000);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].sessionId).toBe(`routine_${routine.id}`);
    expect(turns[0].message).toContain('"source":"schedule"');
    await vi.waitFor(() => expect(fires).toHaveLength(1));
    expect(fires[0]).toMatchObject({ routineId: routine.id, ok: true });
    // Second tick over the same window: no double fire.
    await scheduler.tick(t0 + 45_000);
    expect(turns).toHaveLength(1);
  });

  it('does not backfill missed runs on boot', async () => {
    const { store, scheduler, turns } = setup();
    addCronRoutine(store, '* * * * *');
    // No watermark yet: first tick only watermarks, fires nothing.
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 0, 30));
    expect(turns).toHaveLength(0);
    // Next tick fires only occurrences after the watermark.
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 1, 30));
    expect(turns).toHaveLength(1);
  });

  it('skip overlap policy skips while a run is in flight', async () => {
    const { store, turns, fires } = setup();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const runtime = {
      runTurn: vi.fn(async (args: { sessionId: string }) => {
        turns.push({ bot: BOT, message: 'x', sessionId: args.sessionId });
        await gate;
      }),
    } as unknown as AgentRuntime;
    const scheduler = new RoutineScheduler({
      routineStore: store, agentRuntime: runtime, getBots: () => [BOT],
      onFire: (info) => fires.push({ routineId: info.routine.id, ok: info.ok, skipped: info.skipped }),
    });
    const routine = addCronRoutine(store, '* * * * *', 'skip');
    const t0 = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 30) / 60_000) * 60_000;
    store.setLastFiredAt(routine.id, t0 - 60_000);
    await scheduler.tick(t0 + 30_000); // starts run, blocks on gate (fire is non-blocking)
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(scheduler.inFlightCount()).toBe(1);
    // While in flight, another due occurrence is skipped, not queued.
    store.setLastFiredAt(routine.id, t0);
    await scheduler.tick(t0 + 90_000);
    expect(turns).toHaveLength(1);
    expect(fires.some((f) => f.skipped)).toBe(true);
    release();
    await vi.waitFor(() => expect(scheduler.inFlightCount()).toBe(0));
  });

  it('queue overlap policy fires even while a run is in flight', async () => {
    const { store, turns } = setup();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let calls = 0;
    const runtime = {
      runTurn: vi.fn(async (args: { sessionId: string }) => {
        calls += 1;
        turns.push({ bot: BOT, message: 'x', sessionId: args.sessionId });
        if (calls === 1) await gate;
      }),
    } as unknown as AgentRuntime;
    const scheduler = new RoutineScheduler({
      routineStore: store, agentRuntime: runtime, getBots: () => [BOT],
    });
    const routine = addCronRoutine(store, '* * * * *', 'queue');
    const t0 = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 30) / 60_000) * 60_000;
    store.setLastFiredAt(routine.id, t0 - 60_000);
    await scheduler.tick(t0 + 30_000);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    store.setLastFiredAt(routine.id, t0);
    await scheduler.tick(t0 + 90_000);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    release();
    await vi.waitFor(() => expect(scheduler.inFlightCount()).toBe(0));
    expect(turns).toHaveLength(2);
  });

  it('a disabled schedule never fires', async () => {
    const { store, scheduler, turns } = setup();
    const routine = store.create({
      name: 'disabled',
      botId: 'helper',
      promptTemplate: 'hi',
      schedule: validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '* * * * *', enabled: false }),
    });
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 11, 59, 0));
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 5, 0));
    expect(turns).toHaveLength(0);
  });

  it('a routine without a schedule never fires', async () => {
    const { store, scheduler, turns } = setup();
    store.create({ name: 'plain', botId: 'helper', promptTemplate: 'hi' });
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 5, 0));
    expect(turns).toHaveLength(0);
  });

  it('reports unknown bot as a failed fire', async () => {
    const { store, scheduler, turns, fires } = setup();
    const routine = store.create({
      name: 'ghost',
      botId: 'no-such-bot',
      promptTemplate: 'hi',
      schedule: validateRoutineSchedule({ kind: 'cron', timezone: 'UTC', expression: '* * * * *' }),
    });
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 11, 59, 0));
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 1, 30));
    expect(turns).toHaveLength(0);
    expect(fires[0].ok).toBe(false);
    expect(fires[0].error).toContain('Unknown bot');
  });

  it('once schedules fire exactly once', async () => {
    const { store, scheduler, turns } = setup();
    const routine = store.create({
      name: 'once',
      botId: 'helper',
      promptTemplate: 'hi',
      schedule: validateRoutineSchedule({ kind: 'once', timezone: 'UTC', runAt: '2026-10-16T12:02:00Z' }),
    });
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 12, 0, 0));
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 3, 0));
    expect(turns).toHaveLength(1);
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 10, 0));
    expect(turns).toHaveLength(1);
  });

  it('runTurn failures are reported via onFire and do not wedge the watermark', async () => {
    const { store, fires } = setup();
    const runtime = {
      runTurn: vi.fn(async () => { throw new Error('boom'); }),
    } as unknown as AgentRuntime;
    const scheduler = new RoutineScheduler({
      routineStore: store, agentRuntime: runtime, getBots: () => [BOT],
      onFire: (info) => fires.push({ routineId: info.routine.id, ok: info.ok, error: info.error }),
    });
    const routine = addCronRoutine(store, '* * * * *');
    store.setLastFiredAt(routine.id, Date.UTC(2026, 9, 16, 12, 0, 30));
    await scheduler.tick(Date.UTC(2026, 9, 16, 12, 1, 30));
    await vi.waitFor(() => expect(fires).toHaveLength(1));
    expect(fires[0].ok).toBe(false);
    expect(fires[0].error).toBe('boom');
    // Watermark advanced: the next tick does not retry the failed window.
    const before = store.getLastFiredAt(routine.id) as number;
    expect(before).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 16, 12, 1, 30));
  });
});
