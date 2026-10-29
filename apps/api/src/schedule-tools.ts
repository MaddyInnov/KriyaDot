// SPDX-License-Identifier: Apache-2.0

/**
 * In-session schedule + monitor tools (Octomind parity, Tier 3).
 *
 * Bots create their own future work mid-conversation instead of asking
 * the user to open the Routines UI:
 *   schedule_task    — one-shot (in N minutes / at an ISO time),
 *                      interval, cron, or IDLE ("when I've been quiet
 *                      for X minutes") schedules on the routines engine.
 *   list_schedules   — this bot's routines with human descriptions.
 *   cancel_schedule  — remove one of this bot's routines (id or name).
 *   create_monitor   — an interval routine whose prompt is a check:
 *                      stay quiet when healthy, escalate to the user /
 *                      team inbox when the condition trips.
 *
 * Everything lands in the same RoutineStore the UI manages, so
 * agent-created schedules are visible, editable, and cancellable in
 * the Routines surface — no shadow state.
 */

import type { ToolDefinition } from '@mvp/agent-runtime';
import type { RoutineStore } from './bot-routines.js';
import { describeSchedule, type RoutineSchedule } from './routine-schedules.js';

const scheduleParam = {
  type: 'object',
  description:
    'When to run. kind "in_minutes": once, N minutes from now. "at": once at an ISO 8601 datetime. "interval": every N minutes. "cron": 5-field cron expression. "idle": once after the bot has been inactive for N minutes (re-arms on new activity).',
  properties: {
    kind: { type: 'string', enum: ['in_minutes', 'at', 'interval', 'cron', 'idle'] },
    minutes: { type: 'number', description: 'For in_minutes / interval / idle' },
    at: { type: 'string', description: 'ISO 8601 datetime, for kind "at"' },
    cron: { type: 'string', description: '5-field cron expression, for kind "cron"' },
    timezone: { type: 'string', description: 'IANA timezone (default UTC)' },
  },
  required: ['kind'],
  additionalProperties: false,
} as const;

type WhenArg = {
  kind?: string;
  minutes?: number;
  at?: string;
  cron?: string;
  timezone?: string;
};

function toRoutineSchedule(when: WhenArg): RoutineSchedule | { error: string } {
  const timezone = typeof when.timezone === 'string' && when.timezone ? when.timezone : 'UTC';
  const base = { timezone, enabled: true, overlap: 'skip' as const };
  switch (when.kind) {
    case 'in_minutes': {
      const minutes = Number(when.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 30) {
        return { error: 'in_minutes needs "minutes" between 1 and 43200' };
      }
      return { ...base, kind: 'once', runAt: new Date(Date.now() + minutes * 60_000).toISOString() };
    }
    case 'at': {
      if (typeof when.at !== 'string' || Number.isNaN(Date.parse(when.at))) {
        return { error: 'at needs "at" as an ISO 8601 datetime' };
      }
      return { ...base, kind: 'once', runAt: when.at };
    }
    case 'interval': {
      const minutes = Number(when.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
        return { error: 'interval needs integer "minutes" between 1 and 10080' };
      }
      return { ...base, kind: 'interval', everyMinutes: minutes };
    }
    case 'cron': {
      if (typeof when.cron !== 'string' || when.cron.trim().split(/\s+/).length !== 5) {
        return { error: 'cron needs a 5-field cron expression' };
      }
      return { ...base, kind: 'cron', expression: when.cron.trim() };
    }
    case 'idle': {
      const minutes = Number(when.minutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080) {
        return { error: 'idle needs integer "minutes" between 5 and 10080' };
      }
      return { ...base, kind: 'idle', afterMinutes: minutes };
    }
    default:
      return { error: `unknown when.kind "${String(when.kind)}"` };
  }
}

export function createScheduleTools(store: RoutineStore): ToolDefinition[] {
  const scheduleTask: ToolDefinition = {
    name: 'schedule_task',
    description:
      'Schedule future work for YOURSELF on the routines engine: a one-shot reminder/follow-up (in_minutes or at), a repeating job (interval or cron), or an idle trigger that fires after you have been inactive. The task runs as a fresh turn with the given prompt. Visible and cancellable in the Routines UI.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short schedule name' },
        prompt: { type: 'string', description: 'The instruction your future turn will execute' },
        when: scheduleParam,
      },
      required: ['name', 'prompt', 'when'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!name || !prompt) return { error: 'name and prompt are required' };
      const schedule = toRoutineSchedule((args.when ?? {}) as WhenArg);
      if ('error' in schedule) return schedule;
      try {
        const routine = store.create({ name, botId: ctx.botId, promptTemplate: prompt, schedule });
        return { scheduled: true, id: routine.id, name: routine.name, schedule: describeSchedule(schedule) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const listSchedules: ToolDefinition = {
    name: 'list_schedules',
    description: 'List your own scheduled tasks / routines (id, name, when, enabled).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => ({
      schedules: store
        .list()
        .filter((r) => r.botId === ctx.botId)
        .map((r) => ({
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          when: r.schedule ? describeSchedule(r.schedule) : 'manual/webhook only',
        })),
    }),
  };

  const cancelSchedule: ToolDefinition = {
    name: 'cancel_schedule',
    description: 'Cancel one of your scheduled tasks by id or exact name.',
    parameters: {
      type: 'object',
      properties: { idOrName: { type: 'string' } },
      required: ['idOrName'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx) => {
      const needle = typeof args.idOrName === 'string' ? args.idOrName.trim() : '';
      const mine = store.list().filter((r) => r.botId === ctx.botId);
      const found = mine.find((r) => r.id === needle) ?? mine.find((r) => r.name === needle);
      if (!found) return { error: `no schedule of yours matches "${needle}"` };
      store.remove(found.id);
      return { cancelled: true, id: found.id, name: found.name };
    },
  };

  const createMonitor: ToolDefinition = {
    name: 'create_monitor',
    description:
      'Create a recurring monitor: every N minutes a turn runs your check instruction. The monitor stays silent while things are healthy and escalates (message the user / post to the team inbox) only when the check trips. Use for watch-a-price, watch-a-service, watch-a-folder style tasks.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        check: { type: 'string', description: 'What to check and the exact trip condition' },
        everyMinutes: { type: 'number' },
      },
      required: ['name', 'check', 'everyMinutes'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const check = typeof args.check === 'string' ? args.check.trim() : '';
      const every = Number(args.everyMinutes);
      if (!name || !check) return { error: 'name and check are required' };
      if (!Number.isInteger(every) || every < 5 || every > 10080) {
        return { error: 'everyMinutes must be an integer between 5 and 10080' };
      }
      const promptTemplate = [
        `MONITOR CHECK (${name}): ${check}`,
        'If the condition is NOT tripped, reply with exactly "OK" and do nothing else.',
        'If the condition IS tripped, escalate: summarize what changed with concrete values, and notify the user (and the team inbox if this is a team bot). Do not repeat an escalation you already sent for the same unchanged state.',
      ].join('\n');
      try {
        const routine = store.create({
          name: `Monitor: ${name}`.slice(0, 120),
          botId: ctx.botId,
          promptTemplate,
          schedule: { kind: 'interval', everyMinutes: every, timezone: 'UTC', enabled: true, overlap: 'skip' },
        });
        return { monitoring: true, id: routine.id, name: routine.name, everyMinutes: every };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return [scheduleTask, listSchedules, cancelSchedule, createMonitor];
}
