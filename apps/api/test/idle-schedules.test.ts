// SPDX-License-Identifier: Apache-2.0
// Tier 3: idle-trigger schedules + in-session schedule/monitor tools.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, BotConfig, ToolContext } from '@mvp/agent-runtime';
import { RoutineStore } from '../src/bot-routines.js';
import {
  RoutineScheduler,
  describeSchedule,
  nextRuns,
  validateRoutineSchedule,
} from '../src/routine-schedules.js';
import { createScheduleTools } from '../src/schedule-tools.js';

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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-idle-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('idle schedule validation + description', () => {
  it('validates afterMinutes bounds', () => {
    const ok = validateRoutineSchedule({ kind: 'idle', afterMinutes: 30, timezone: 'UTC' });
    expect(ok.kind).toBe('idle');
    expect(describeSchedule(ok)).toContain('30m of bot inactivity');
    expect(nextRuns(ok, 5, Date.now())).toEqual([]);
    expect(() => validateRoutineSchedule({ kind: 'idle', afterMinutes: 2, timezone: 'UTC' })).toThrow(
      /afterMinutes/,
    );
  });
});

describe('RoutineScheduler idle firing', () => {
  it('fires once per idle period and re-arms on new activity', async () => {
    const store = new RoutineStore(dir);
    const routine = store.create({
      name: 'Idle check-in',
      botId: BOT.id,
      promptTemplate: 'Check in with the user.',
      schedule: { kind: 'idle', afterMinutes: 30, timezone: 'UTC', enabled: true, overlap: 'skip' },
    });
    let activity = Date.now() - 10 * 60_000; // active 10 minutes ago
    const turns: string[] = [];
    const runtime = {
      runTurn: vi.fn(async (args: { message: string }) => {
        turns.push(args.message);
      }),
    } as unknown as AgentRuntime;
    const scheduler = new RoutineScheduler({
      routineStore: store,
      agentRuntime: runtime,
      getBots: () => [BOT],
      now: () => activity + 10 * 60_000,
      lastBotActivityAt: () => activity,
    });
    const t0 = activity + 10 * 60_000;
    await scheduler.tick(t0); // arms the watermark (first sight)
    await scheduler.tick(t0 + 15 * 60_000); // idle 25m < 30m → no fire
    expect(turns).toHaveLength(0);
    await scheduler.tick(t0 + 25 * 60_000); // idle 35m → fire
    expect(turns).toHaveLength(1);
    await scheduler.tick(t0 + 60 * 60_000); // still idle, same period → no refire
    expect(turns).toHaveLength(1);
    // New activity re-arms.
    activity = t0 + 61 * 60_000;
    await scheduler.tick(activity + 31 * 60_000);
    expect(turns).toHaveLength(2);
    expect(store.get(routine.id)).toBeDefined();
  });

  it('never fires for a bot with no recorded activity', async () => {
    const store = new RoutineStore(dir);
    store.create({
      name: 'Idle',
      botId: BOT.id,
      promptTemplate: 'Ping.',
      schedule: { kind: 'idle', afterMinutes: 5, timezone: 'UTC', enabled: true, overlap: 'skip' },
    });
    const runtime = { runTurn: vi.fn(async () => undefined) } as unknown as AgentRuntime;
    const scheduler = new RoutineScheduler({
      routineStore: store,
      agentRuntime: runtime,
      getBots: () => [BOT],
      lastBotActivityAt: () => undefined,
    });
    await scheduler.tick(Date.now() + 60 * 60_000);
    expect(runtime.runTurn).not.toHaveBeenCalled();
  });
});

describe('in-session schedule tools', () => {
  const ctx = { sessionId: 's1', botId: BOT.id } as ToolContext;

  it('schedule_task creates routines for each when-kind; list + cancel work', async () => {
    const store = new RoutineStore(dir);
    const tools = Object.fromEntries(createScheduleTools(store).map((t) => [t.name, t]));
    const once = (await tools.schedule_task!.handler(
      { name: 'Follow up', prompt: 'Ask about the proposal', when: { kind: 'in_minutes', minutes: 45 } },
      ctx,
    )) as { scheduled?: boolean; id?: string };
    expect(once.scheduled).toBe(true);
    const idle = (await tools.schedule_task!.handler(
      { name: 'Quiet nudge', prompt: 'Nudge', when: { kind: 'idle', minutes: 60 } },
      ctx,
    )) as { scheduled?: boolean };
    expect(idle.scheduled).toBe(true);
    const bad = (await tools.schedule_task!.handler(
      { name: 'Bad', prompt: 'x', when: { kind: 'idle', minutes: 1 } },
      ctx,
    )) as { error?: string };
    expect(bad.error).toContain('idle');

    const list = (await tools.list_schedules!.handler({}, ctx)) as {
      schedules: Array<{ name: string; when: string }>;
    };
    expect(list.schedules).toHaveLength(2);
    expect(list.schedules.some((s) => s.when.includes('inactivity'))).toBe(true);

    const cancelled = (await tools.cancel_schedule!.handler({ idOrName: 'Follow up' }, ctx)) as {
      cancelled?: boolean;
    };
    expect(cancelled.cancelled).toBe(true);
    const after = (await tools.list_schedules!.handler({}, ctx)) as { schedules: unknown[] };
    expect(after.schedules).toHaveLength(1);
  });

  it('create_monitor wraps the check in an escalation prompt', async () => {
    const store = new RoutineStore(dir);
    const tools = Object.fromEntries(createScheduleTools(store).map((t) => [t.name, t]));
    const res = (await tools.create_monitor!.handler(
      { name: 'Deploy watch', check: 'the deploy status page shows FAILED', everyMinutes: 15 },
      ctx,
    )) as { monitoring?: boolean; id?: string };
    expect(res.monitoring).toBe(true);
    const routine = store.get(res.id!);
    expect(routine?.name).toBe('Monitor: Deploy watch');
    expect(routine?.promptTemplate).toContain('MONITOR CHECK');
    expect(routine?.promptTemplate).toContain('escalate');
    expect(routine?.schedule?.kind).toBe('interval');
  });

  it('bots cannot cancel another bot\'s schedules', async () => {
    const store = new RoutineStore(dir);
    store.create({ name: 'Theirs', botId: 'other-bot', promptTemplate: 'x' });
    const tools = Object.fromEntries(createScheduleTools(store).map((t) => [t.name, t]));
    const res = (await tools.cancel_schedule!.handler({ idOrName: 'Theirs' }, ctx)) as {
      error?: string;
    };
    expect(res.error).toContain('no schedule of yours');
  });
});
