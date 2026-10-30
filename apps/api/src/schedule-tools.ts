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

/** Originating session for in-session scheduling (#88): a valid session id from the tool context, else undefined. */
export function originSessionOf(ctx: { sessionId?: string }): string | undefined {
  const id = typeof ctx.sessionId === 'string' ? ctx.sessionId : '';
  // RoutineStore validates session ids against this shape; anything else
  // keeps the legacy fresh-session behaviour rather than failing create.
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

export interface ScheduleToolsOptions {
  /** Generic long-lived monitors (#91). When set, monitor_start/stop/list tools are added. */
  monitors?: GenericMonitorService;
}

export function createScheduleTools(store: RoutineStore, opts: ScheduleToolsOptions = {}): ToolDefinition[] {
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
        const originSessionId = originSessionOf(ctx);
        const routine = store.create({ name, botId: ctx.botId, promptTemplate: prompt, schedule, ...(originSessionId ? { sessionId: originSessionId } : {}) });
        return { scheduled: true, id: routine.id, name: routine.name, schedule: describeSchedule(schedule), ...(originSessionId ? { originSessionId, firesInto: 'originating session' } : { firesInto: 'fresh routine session' }) };
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
        const originSessionId = originSessionOf(ctx);
        const routine = store.create({
          ...(originSessionId ? { sessionId: originSessionId } : {}),
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

  const tools: ToolDefinition[] = [scheduleTask, listSchedules, cancelSchedule, createMonitor];
  if (opts.monitors) tools.push(...createGenericMonitorTools(opts.monitors));
  return tools;
}

// ---------------------------------------------------------------------------
// Generic monitors (#91): long-lived event streams with batched,
// rate-limited inbox injection.
//
// A monitor watches a COMMAND (spawned; stdout lines are events) or a
// FEED (a URL polled through an injected fetch; a changed body is an
// event). Events accumulate in a per-monitor buffer and are injected as
// ONE digest message per batch interval at most — a noisy stream can
// never flood the session inbox. Process/fetch/timer seams are all
// injectable so tests run with fakes (no real processes or network).
// ---------------------------------------------------------------------------

export interface MonitorEvent { monitorId: string; source: 'command' | 'feed'; text: string; at: number }
export type MonitorDigestSink = (monitorId: string, digest: string, events: MonitorEvent[]) => void | Promise<void>;
/** Runs a command and streams stdout lines. Returns a stop function. */
export type MonitorCommandRunner = (command: string[], emit: (line: string) => void) => { stop: () => void };
export type MonitorFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface MonitorRecord {
  id: string; name: string; kind: 'command' | 'feed'; target: string;
  batchMs: number; startedAt: number; eventsSeen: number; digestsSent: number; running: boolean;
}

interface LiveMonitor extends MonitorRecord {
  stopSource: () => void;
  buffer: MonitorEvent[];
  flushTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastFeedBody?: string;
}

const defaultCommandRunner: MonitorCommandRunner = (command, emit) => {
  // Production path only — tests always inject a fake runner.
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  child.stdout?.on('data', (d: Buffer) => {
    pending += d.toString('utf8');
    let idx: number;
    while ((idx = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, idx).trim(); pending = pending.slice(idx + 1); if (line) emit(line); }
  });
  return { stop: () => { try { child.kill(); } catch { /* already gone */ } } };
};

export class GenericMonitorService {
  private readonly monitors = new Map<string, LiveMonitor>();
  /** Monitor id → session that started it (digests steer back into it). */
  private readonly origins = new Map<string, string>();
  private seq = 0;

  /** Record which session started a monitor (host/tool wiring). */
  bindOrigin(monitorId: string, sessionId: string): void {
    if (sessionId) this.origins.set(monitorId, sessionId);
  }

  /** The session that started a monitor, if bound. */
  originOf(monitorId: string): string | undefined {
    return this.origins.get(monitorId);
  }
  constructor(private readonly deps: {
    onDigest: MonitorDigestSink;
    commandRunner?: MonitorCommandRunner;
    fetchFn?: MonitorFetch;
    /** Hard cap on buffered events per monitor between digests. */
    maxBuffered?: number;
  }) {}

  startCommand(input: { name: string; command: string[]; batchMs?: number }): MonitorRecord {
    if (!Array.isArray(input.command) || input.command.length === 0) throw new Error('monitor command must be a non-empty argv array');
    const rec = this.fresh(input.name, 'command', input.command.join(' '), input.batchMs);
    const runner = this.deps.commandRunner ?? defaultCommandRunner;
    const handle = runner(input.command, (line) => this.push(rec, { text: line }));
    rec.stopSource = handle.stop;
    this.armFlush(rec);
    return this.view(rec);
  }

  startFeed(input: { name: string; url: string; batchMs?: number; pollMs?: number }): MonitorRecord {
    const rec = this.fresh(input.name, 'feed', input.url, input.batchMs);
    const fetchFn: MonitorFetch = this.deps.fetchFn ?? (async (url) => { const r = await fetch(url); return { ok: r.ok, status: r.status, text: () => r.text() }; });
    const poll = async (): Promise<void> => {
      try {
        const res = await fetchFn(input.url);
        if (!res.ok) return;
        const body = (await res.text()).slice(0, 20000);
        if (rec.lastFeedBody !== undefined && body !== rec.lastFeedBody) this.push(rec, { text: body.slice(0, 500) });
        rec.lastFeedBody = body;
      } catch { /* a failed poll is not an event */ }
    };
    void poll();
    rec.pollTimer = setInterval(() => { void poll(); }, Math.max(250, input.pollMs ?? 5000));
    (rec.pollTimer as unknown as { unref?: () => void }).unref?.();
    this.armFlush(rec);
    return this.view(rec);
  }

  private fresh(name: string, kind: LiveMonitor['kind'], target: string, batchMs?: number): LiveMonitor {
    const rec: LiveMonitor = {
      id: `mon_${++this.seq}_${Date.now().toString(36)}`, name: name || 'monitor', kind, target,
      batchMs: Math.max(250, batchMs ?? 5000), startedAt: Date.now(), eventsSeen: 0, digestsSent: 0,
      running: true, stopSource: () => {}, buffer: [], flushTimer: null, pollTimer: null,
    };
    this.monitors.set(rec.id, rec);
    return rec;
  }

  private push(rec: LiveMonitor, e: { text: string }): void {
    if (!rec.running) return;
    rec.eventsSeen += 1;
    rec.buffer.push({ monitorId: rec.id, source: rec.kind, text: e.text.slice(0, 500), at: Date.now() });
    const cap = this.deps.maxBuffered ?? 200;
    if (rec.buffer.length > cap) rec.buffer.splice(0, rec.buffer.length - cap);
  }

  private armFlush(rec: LiveMonitor): void {
    rec.flushTimer = setInterval(() => { void this.flush(rec.id); }, rec.batchMs);
    (rec.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Deliver the buffered events as ONE digest (rate limit: at most one per batch interval, by construction). */
  async flush(id: string): Promise<number> {
    const rec = this.monitors.get(id);
    if (!rec || rec.buffer.length === 0) return 0;
    const events = rec.buffer.splice(0, rec.buffer.length);
    const digest = [`[monitor ${rec.name}] ${events.length} event(s):`, ...events.slice(0, 20).map((e) => `- ${e.text}`), ...(events.length > 20 ? [`… and ${events.length - 20} more`] : [])].join('\n');
    rec.digestsSent += 1;
    await this.deps.onDigest(id, digest, events);
    return events.length;
  }

  stop(id: string): boolean {
    const rec = this.monitors.get(id);
    if (!rec) return false;
    rec.running = false;
    try { rec.stopSource(); } catch { /* ignore */ }
    if (rec.flushTimer) clearInterval(rec.flushTimer);
    if (rec.pollTimer) clearInterval(rec.pollTimer);
    this.monitors.delete(id);
    this.origins.delete(id);
    return true;
  }

  list(): MonitorRecord[] { return [...this.monitors.values()].map((m) => this.view(m)); }
  stopAll(): void { for (const id of [...this.monitors.keys()]) this.stop(id); }
  private view(m: LiveMonitor): MonitorRecord {
    const { id, name, kind, target, batchMs, startedAt, eventsSeen, digestsSent, running } = m;
    return { id, name, kind, target, batchMs, startedAt, eventsSeen, digestsSent, running };
  }
}

export function createGenericMonitorTools(service: GenericMonitorService): ToolDefinition[] {
  return [
    {
      name: 'monitor_start', mutating: true,
      description: 'Start a long-lived monitor over a command (argv array; stdout lines are events) or a feed URL. Events are batched and injected into this session as at most one digest per batch interval.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['command', 'feed'] }, command: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, batchMs: { type: 'number' } }, required: ['name', 'kind'] },
      handler: async (args, ctx) => {
        try {
          if (args.kind === 'command') {
            const rec = service.startCommand({ name: String(args.name), command: (args.command as string[]) ?? [], batchMs: typeof args.batchMs === 'number' ? args.batchMs : undefined });
            if (ctx?.sessionId) service.bindOrigin(rec.id, ctx.sessionId);
            return { monitoring: true, ...rec };
          }
          if (args.kind === 'feed') {
            const rec = service.startFeed({ name: String(args.name), url: String(args.url ?? ''), batchMs: typeof args.batchMs === 'number' ? args.batchMs : undefined });
            if (ctx?.sessionId) service.bindOrigin(rec.id, ctx.sessionId);
            return { monitoring: true, ...rec };
          }
          return { error: 'kind must be "command" or "feed"' };
        } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
      },
    },
    {
      name: 'monitor_stop', mutating: true,
      description: 'Stop a running monitor by id (from monitor_start / monitor_list).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args) => service.stop(String(args.id)) ? { stopped: true, id: String(args.id) } : { error: `no monitor "${String(args.id)}"` },
    },
    {
      name: 'monitor_list',
      description: 'List running monitors with event/digest counts.',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ monitors: service.list() }),
    },
  ];
}
