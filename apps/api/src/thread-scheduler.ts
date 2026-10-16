// SPDX-License-Identifier: Apache-2.0
// Thread automations — Codex-style "wake this conversation on a schedule".
//
// Two schedule kinds:
//   - 'bot-turn' (default): at the scheduled time, run an agent turn on
//     the session with the wake prompt; the session's history provides the
//     conversation context. The user sees the agent's scheduled check-in
//     when they open the thread.
//   - 'workflow': at the scheduled time, start a workflow run with the
//     configured input (cron → workflow, the routines→workflows link).
//
// Storage: <dataDir>/thread-schedules.db (own file, same node:sqlite
// pattern as the workflow TriggerStore). The kind/workflow_id/workflow_input
// columns are added idempotently for databases created before they existed.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export type ThreadScheduleKind = 'bot-turn' | 'workflow';

export interface ThreadSchedule {
  id: string;
  botId: string;
  sessionId: string;
  /** 5-field cron expression. */
  cron: string;
  /** The wake prompt sent as the scheduled message (bot-turn schedules). */
  prompt: string;
  /** 'bot-turn' wakes a chat thread; 'workflow' starts a workflow run. */
  kind: ThreadScheduleKind;
  /** Required when kind === 'workflow'. */
  workflowId?: string;
  /** JSON input for the workflow run (kind === 'workflow'). */
  workflowInput?: unknown;
  enabled: boolean;
  createdAt: number;
  lastFiredMinute?: string;
}

interface ThreadScheduleRow {
  id: string;
  bot_id: string;
  session_id: string;
  cron: string;
  prompt: string;
  kind: string | null;
  workflow_id: string | null;
  workflow_input: string | null;
  enabled: number;
  created_at: number;
  last_fired_minute: string | null;
}

function rowToSchedule(r: ThreadScheduleRow): ThreadSchedule {
  const s: ThreadSchedule = {
    id: r.id,
    botId: r.bot_id,
    sessionId: r.session_id,
    cron: r.cron,
    prompt: r.prompt,
    kind: r.kind === 'workflow' ? 'workflow' : 'bot-turn',
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastFiredMinute: r.last_fired_minute ?? undefined,
  };
  if (r.workflow_id) s.workflowId = r.workflow_id;
  if (r.workflow_input !== null && r.workflow_input !== undefined) {
    try {
      s.workflowInput = JSON.parse(r.workflow_input) as unknown;
    } catch {
      s.workflowInput = r.workflow_input;
    }
  }
  return s;
}

const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

export function validateCron(expr: string): void {
  if (!CRON_RE.test(expr.trim())) {
    throw new Error('cron must be a 5-field expression: "minute hour dom month dow"');
  }
}

function cronMatches(expr: string, d: Date): boolean {
  const m = CRON_RE.exec(expr.trim());
  if (!m) return false;
  const [, minute, hour, dom, month, dow] = m;
  const match = (field: string, value: number): boolean => {
    if (field === '*') return true;
    return field.split(',').some((part) => {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const s = Number(step);
        if (range === '*') return value % s === 0;
        return false;
      }
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        return value >= a && value <= b;
      }
      return Number(part) === value;
    });
  };
  return (
    match(minute, d.getMinutes()) &&
    match(hour, d.getHours()) &&
    match(dom, d.getDate()) &&
    match(month, d.getMonth() + 1) &&
    match(dow, d.getDay())
  );
}

export class ThreadScheduleStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'thread-schedules.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_schedules (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_fired_minute TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_thread_schedules_enabled ON thread_schedules(enabled);
    `);
    // Idempotent migration for the routines→workflows link (kind +
    // workflow target columns on pre-existing databases).
    this.ensureColumn('kind', "TEXT NOT NULL DEFAULT 'bot-turn'");
    this.ensureColumn('workflow_id', 'TEXT');
    this.ensureColumn('workflow_input', 'TEXT');
  }

  private ensureColumn(name: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(thread_schedules)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === name)) {
      this.db.exec(`ALTER TABLE thread_schedules ADD COLUMN ${name} ${ddl}`);
    }
  }

  create(input: {
    botId: string;
    sessionId: string;
    cron: string;
    prompt: string;
    kind?: ThreadScheduleKind;
    workflowId?: string;
    /** JSON input for the workflow run (object or JSON string). */
    workflowInput?: unknown;
  }): ThreadSchedule {
    validateCron(input.cron);
    const kind: ThreadScheduleKind = input.kind === 'workflow' ? 'workflow' : 'bot-turn';
    if (kind === 'workflow') {
      const workflowId = typeof input.workflowId === 'string' ? input.workflowId.trim() : '';
      if (!workflowId) throw new Error('workflowId is required for workflow schedules.');
    } else {
      if (!input.prompt.trim() || input.prompt.length > 4000) {
        throw new Error('prompt is required (max 4000 chars).');
      }
    }
    const s: ThreadSchedule = {
      id: randomUUID(),
      botId: input.botId,
      sessionId: input.sessionId,
      cron: input.cron.trim(),
      prompt: input.prompt.trim(),
      kind,
      enabled: true,
      createdAt: Date.now(),
    };
    if (kind === 'workflow') {
      s.workflowId = (input.workflowId as string).trim();
      if (input.workflowInput !== undefined) s.workflowInput = input.workflowInput;
    }
    this.db
      .prepare(
        'INSERT INTO thread_schedules (id, bot_id, session_id, cron, prompt, kind, workflow_id, workflow_input, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
      )
      .run(
        s.id,
        s.botId,
        s.sessionId,
        s.cron,
        s.prompt,
        s.kind,
        s.workflowId ?? null,
        s.workflowInput === undefined ? null : JSON.stringify(s.workflowInput),
        s.createdAt,
      );
    return s;
  }

  list(): ThreadSchedule[] {
    const rows = this.db.prepare('SELECT * FROM thread_schedules ORDER BY created_at DESC').all() as unknown as ThreadScheduleRow[];
    return rows.map(rowToSchedule);
  }

  get(id: string): ThreadSchedule | undefined {
    const row = this.db.prepare('SELECT * FROM thread_schedules WHERE id = ?').get(id) as unknown as ThreadScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  setEnabled(id: string, enabled: boolean): ThreadSchedule | undefined {
    this.db.prepare('UPDATE thread_schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    const r = this.db.prepare('DELETE FROM thread_schedules WHERE id = ?').run(id);
    return r.changes > 0;
  }

  markFired(id: string, minuteKey: string): void {
    this.db.prepare('UPDATE thread_schedules SET last_fired_minute = ? WHERE id = ?').run(minuteKey, id);
  }

  due(now: Date): ThreadSchedule[] {
    return this.list().filter(
      (s) => s.enabled && cronMatches(s.cron, now) && s.lastFiredMinute !== minuteKey(now),
    );
  }
}

function minuteKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

export interface ThreadSchedulerDeps {
  store: ThreadScheduleStore;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /** Called after a scheduled turn completes (e.g. to notify). */
  onWake?: (info: { schedule: ThreadSchedule; ok: boolean; error?: string }) => void;
  /**
   * Resolve a persistent E2B sandbox ID for a session (Dot environments).
   * When the session belongs to a Dot with a live environment, its turns
   * run `run_command` inside that sandbox.
   */
  getPersistentSandboxId?: (sessionId: string) => string | undefined;
  /**
   * Start a workflow run (routines→workflows link). When set, schedules
   * with kind 'workflow' start `schedule.workflowId` with
   * `schedule.workflowInput` instead of waking a chat thread. Unset →
   * workflow schedules fail with a clear error via onWake.
   */
  startWorkflow?: (workflowId: string, input: unknown) => Promise<{ id: string }>;
}

/**
 * Ticks every minute; for each due schedule, either runs an agent turn on
 * the session with the wake prompt ('bot-turn') or starts a workflow run
 * ('workflow'). The session's stored history gives the agent its
 * conversation context on wake turns.
 */
export class ThreadScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: ThreadSchedulerDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Fire once shortly after boot so a schedule due during downtime fires.
    setTimeout(() => void this.tick(), 5_000);
  }

  /**
   * Fire a 'workflow'-kind schedule: start the configured workflow run.
   * Reports through onWake like wake turns do.
   */
  private async fireWorkflowSchedule(s: ThreadSchedule): Promise<void> {
    if (!this.deps.startWorkflow) {
      this.deps.onWake?.({
        schedule: s,
        ok: false,
        error: 'Workflow schedules need a startWorkflow hook (not wired).',
      });
      return;
    }
    if (!s.workflowId) {
      this.deps.onWake?.({ schedule: s, ok: false, error: 'Workflow schedule has no workflowId.' });
      return;
    }
    try {
      const run = await this.deps.startWorkflow(s.workflowId, s.workflowInput ?? {});
      this.deps.onWake?.({ schedule: s, ok: true, error: undefined });
      void run;
    } catch (err) {
      this.deps.onWake?.({
        schedule: s,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const key = minuteKey(now);
      for (const s of this.deps.store.due(now)) {
        this.deps.store.markFired(s.id, key);
        if (s.kind === 'workflow') {
          await this.fireWorkflowSchedule(s);
          continue;
        }
        const bot = this.deps.getBots().find((b) => b.id === s.botId);
        if (!bot) {
          this.deps.onWake?.({ schedule: s, ok: false, error: `Unknown bot "${s.botId}"` });
          continue;
        }
        try {
          await this.deps.agentRuntime.runTurn({
            bot,
            message: s.prompt,
            sessionId: s.sessionId,
            persistentSandboxId: this.deps.getPersistentSandboxId?.(s.sessionId),
            // P1 #13: scheduled wakes are routine-origin — untrusted until
            // the human says otherwise; approvals go to the human.
            provenance: {
              origin: 'routine',
              relayPath: [`schedule:${s.id}`],
              relayNames: [`scheduled wake ${s.id}`],
              timestamp: new Date().toISOString(),
            },
            onEvent: () => {},
          });
          this.deps.onWake?.({ schedule: s, ok: true });
        } catch (err) {
          this.deps.onWake?.({
            schedule: s,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
