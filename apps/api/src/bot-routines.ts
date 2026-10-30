// SPDX-License-Identifier: Apache-2.0
// Bot routines — named, bot-bound tasks that can be fired on demand,
// on a timezone-aware schedule (once/daily/cron/interval, see
// routine-schedules.ts), or via webhook.
//
// A routine is a bot + prompt template (+ optional fixed session). Unlike
// thread schedules (cron) and workflows (multi-step graphs), a routine is
// one agent turn triggered externally — the workstream-C ingress for that
// is a signed webhook (see webhooks.ts createRoutineWebhookRouter), while
// scheduled firing is handled by RoutineScheduler (routine-schedules.ts).
//
// HTTP (mounted at /api/routines by the host):
//   POST   /                        → { name, botId, promptTemplate, sessionId?, schedule? }
//   GET    /                        → list routines (each with nextRunAt)
//   GET    /:id                     → one routine (+ nextRunAt)
//   PATCH  /:id                     → { name?, botId?, promptTemplate?, sessionId?, schedule?|null, goalMode?, enabled? }
//   DELETE /:id                     → delete routine (+ its webhook triggers)
//   GET    /:id/next-runs?n=5       → upcoming scheduled run times
//   POST   /:id/schedule/enable     → enable the schedule
//   POST   /:id/schedule/disable    → disable the schedule
//   POST   /:id/triggers            → create webhook trigger → { trigger incl. secret (shown once) }
//   GET    /:id/triggers            → list triggers (secrets redacted)
//   DELETE /:id/triggers/:triggerId → revoke trigger
//
// Storage: <dataDir>/bot-routines.db (node:sqlite, same pattern as the
// workflow TriggerStore and thread schedules).

import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Request, type Response, type Router } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  computeLimitResetResumeAt,
  nextRuns,
  validateRoutineSchedule,
  type EventSchedule,
  type RoutineSchedule,
} from './routine-schedules.js';
import type { LimitResetResumeStore } from './limit-reset-resumes.js';
import { composioCallerOf } from './composio.js';
import { readAccountCache } from './composio-accounts.js';
import { eventDayKey, type EventTriggerStore } from './routine-events.js';

import { openDb as openSqliteDb } from '@mvp/agent-runtime';

export interface BotRoutine {
  id: string;
  name: string;
  botId: string;
  /**
   * Prompt template for the routine's turn. `{{payload}}` (alias `{{body}}`)
   * is replaced with the webhook request body (JSON) at fire time.
   */
  promptTemplate: string;
  /** Fixed session id; defaults to `routine_<id>` when unset. */
  sessionId?: string;
  /**
   * Optional timezone-aware schedule (OpenMausBot parity). Null/undefined
   * means webhook/manual firing only.
   */
  schedule?: RoutineSchedule | null;
  /** Last scheduled-fire watermark (UTC ms), maintained by RoutineScheduler. */
  lastFiredAt?: number;
  /**
   * Routine-as-goal (OpenMausBot parity P1 #11): when true, firing the
   * routine starts a bounded multi-turn group goal pursuing the routine's
   * objective (coordinator auto-selected, chief preferred) instead of a
   * single agent turn. The goal runs in the background and is visible
   * under Teams → Group goals.
   */
  goalMode?: boolean;
  /** Per-routine run timeout in ms (item 4b). Unset = no timeout. */
  timeoutMs?: number;
  /** Automatic retry once on failure (item 4c). Default true. */
  autoRetry?: boolean;
  /** Inject previous run's summary into the next run (item 4d). Default: on for recurring. */
  usePreviousRunSummary?: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface RoutineWebhookTrigger {
  id: string;
  routineId: string;
  /** Hex secret, returned once at creation; compared timing-safe on ingress. */
  secret: string;
  enabled: boolean;
  createdAt: number;
}

/** Trigger as exposed over the API: the secret is never listed. */
export type RoutineWebhookTriggerPublic = Omit<RoutineWebhookTrigger, 'secret'>;

interface RoutineRow {
  id: string;
  name: string;
  bot_id: string;
  prompt_template: string;
  session_id: string | null;
  schedule: string | null;
  last_fired_at: number | null;
  goal_mode: number | null;
  enabled: number;
  created_at: number;
  timeout_ms: number | null;
  auto_retry: number | null;
  use_prev_summary: number | null;
}

interface TriggerRow {
  id: string;
  routine_id: string;
  secret: string;
  enabled: number;
  created_at: number;
}

function rowToRoutine(r: RoutineRow): BotRoutine {
  let schedule: RoutineSchedule | null = null;
  if (r.schedule) {
    try {
      schedule = validateRoutineSchedule(JSON.parse(r.schedule));
    } catch {
      // A schedule that no longer validates (e.g. edited by hand) is
      // treated as absent rather than breaking the whole row.
      schedule = null;
    }
  }
  return {
    id: r.id,
    name: r.name,
    botId: r.bot_id,
    promptTemplate: r.prompt_template,
    sessionId: r.session_id ?? undefined,
    schedule,
    lastFiredAt: r.last_fired_at ?? undefined,
    goalMode: r.goal_mode === 1 ? true : undefined,
    timeoutMs: r.timeout_ms ?? undefined,
    autoRetry: r.auto_retry === null || r.auto_retry === undefined ? undefined : r.auto_retry === 1,
    usePreviousRunSummary: r.use_prev_summary === null || r.use_prev_summary === undefined ? undefined : r.use_prev_summary === 1,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

function rowToTrigger(r: TriggerRow): RoutineWebhookTrigger {
  return {
    id: r.id,
    routineId: r.routine_id,
    secret: r.secret,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export function publicTrigger(t: RoutineWebhookTrigger): RoutineWebhookTriggerPublic {
  const { secret: _secret, ...rest } = t;
  void _secret;
  return rest;
}

function openDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = openSqliteDb(join(dataDir, 'bot-routines.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      session_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routine_webhook_triggers (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_triggers_routine ON routine_webhook_triggers(routine_id);
  `);
  // Migration: per-routine public webhook secret (Codync parity: every
  // routine has a public URL + key). Backfilled lazily on first use.
  const cols = db.prepare('PRAGMA table_info(bot_routines)').all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'webhook_secret')) {
    db.exec('ALTER TABLE bot_routines ADD COLUMN webhook_secret TEXT');
  }
  // Migration: timezone-aware schedules (OpenMausBot parity) + the
  // scheduler's last-fired watermark.
  if (!cols.some((c) => c.name === 'schedule')) {
    db.exec('ALTER TABLE bot_routines ADD COLUMN schedule TEXT');
  }
  if (!cols.some((c) => c.name === 'last_fired_at')) {
    db.exec('ALTER TABLE bot_routines ADD COLUMN last_fired_at INTEGER');
  }
  // Migration: routine-as-goal (OpenMausBot parity P1 #11). Firing a
  // goal-mode routine starts a group goal instead of a single turn.
  if (!cols.some((c) => c.name === 'goal_mode')) {
    db.exec('ALTER TABLE bot_routines ADD COLUMN goal_mode INTEGER');
  }
  if (!cols.some((c) => c.name === 'timeout_ms')) db.exec('ALTER TABLE bot_routines ADD COLUMN timeout_ms INTEGER');
  if (!cols.some((c) => c.name === 'auto_retry')) db.exec('ALTER TABLE bot_routines ADD COLUMN auto_retry INTEGER');
  if (!cols.some((c) => c.name === 'use_prev_summary')) db.exec('ALTER TABLE bot_routines ADD COLUMN use_prev_summary INTEGER');
  return db;
}

function validSessionId(v: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(v);
}

export class RoutineStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  create(input: {
    name: string;
    botId: string;
    promptTemplate: string;
    sessionId?: string;
    schedule?: RoutineSchedule | null;
    goalMode?: boolean;
    timeoutMs?: number;
    autoRetry?: boolean;
    usePreviousRunSummary?: boolean;
  }): BotRoutine {
    const name = input.name.trim().slice(0, 120);
    if (!name) throw new Error('name is required');
    const promptTemplate = input.promptTemplate.trim();
    if (!promptTemplate || promptTemplate.length > 4000) {
      throw new Error('promptTemplate is required (max 4000 chars)');
    }
    if (input.sessionId !== undefined && !validSessionId(input.sessionId)) {
      throw new Error('sessionId must match /^[a-zA-Z0-9_-]{1,128}$/');
    }
    const schedule =
      input.schedule === undefined || input.schedule === null
        ? null
        : validateRoutineSchedule(input.schedule);
    const routine: BotRoutine = {
      id: randomUUID(),
      name,
      botId: input.botId,
      promptTemplate,
      sessionId: input.sessionId,
      schedule,
      goalMode: input.goalMode === true ? true : undefined,
      timeoutMs: input.timeoutMs && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : undefined,
      autoRetry: input.autoRetry,
      usePreviousRunSummary: input.usePreviousRunSummary,
      enabled: true,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO bot_routines (id, name, bot_id, prompt_template, session_id, schedule, goal_mode, enabled, created_at, webhook_secret, timeout_ms, auto_retry, use_prev_summary) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
      )
      .run(
        routine.id,
        routine.name,
        routine.botId,
        routine.promptTemplate,
        routine.sessionId ?? null,
        schedule ? JSON.stringify(schedule) : null,
        routine.goalMode === true ? 1 : null,
        routine.createdAt,
        randomBytes(32).toString('hex'),
        routine.timeoutMs ?? null,
        routine.autoRetry === undefined ? null : routine.autoRetry ? 1 : 0,
        routine.usePreviousRunSummary === undefined ? null : routine.usePreviousRunSummary ? 1 : 0,
      );
    return routine;
  }

  get(id: string): BotRoutine | undefined {
    const row = this.db.prepare('SELECT * FROM bot_routines WHERE id = ?').get(id) as unknown as RoutineRow | undefined;
    return row ? rowToRoutine(row) : undefined;
  }

  list(): BotRoutine[] {
    const rows = this.db.prepare('SELECT * FROM bot_routines ORDER BY created_at DESC').all() as unknown as RoutineRow[];
    return rows.map(rowToRoutine);
  }

  update(
    id: string,
    patch: {
      name?: string;
      botId?: string;
      promptTemplate?: string;
      sessionId?: string | null;
      schedule?: RoutineSchedule | null;
      goalMode?: boolean;
      enabled?: boolean;
      timeoutMs?: number | null;
      autoRetry?: boolean;
      usePreviousRunSummary?: boolean;
    },
  ): BotRoutine | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: BotRoutine = { ...cur };
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 120);
      if (!name) throw new Error('name must not be empty');
      next.name = name;
    }
    if (patch.botId !== undefined) next.botId = patch.botId;
    if (patch.promptTemplate !== undefined) {
      const t = patch.promptTemplate.trim();
      if (!t || t.length > 4000) throw new Error('promptTemplate is required (max 4000 chars)');
      next.promptTemplate = t;
    }
    if (patch.sessionId !== undefined) {
      if (patch.sessionId !== null && !validSessionId(patch.sessionId)) {
        throw new Error('sessionId must match /^[a-zA-Z0-9_-]{1,128}$/');
      }
      next.sessionId = patch.sessionId ?? undefined;
    }
    if (patch.schedule !== undefined) {
      next.schedule = patch.schedule === null ? null : validateRoutineSchedule(patch.schedule);
      // A (re-)set schedule starts its watermark now: no backfill of
      // occurrences that "would have" fired before the schedule existed.
      next.lastFiredAt = Date.now();
    }
    if (patch.goalMode !== undefined) next.goalMode = patch.goalMode === true ? true : undefined;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs && patch.timeoutMs > 0 ? Math.floor(patch.timeoutMs) : undefined;
    if (patch.autoRetry !== undefined) next.autoRetry = patch.autoRetry;
    if (patch.usePreviousRunSummary !== undefined) next.usePreviousRunSummary = patch.usePreviousRunSummary;
    this.db
      .prepare(
        'UPDATE bot_routines SET name = ?, bot_id = ?, prompt_template = ?, session_id = ?, schedule = ?, last_fired_at = ?, goal_mode = ?, enabled = ?, timeout_ms = ?, auto_retry = ?, use_prev_summary = ? WHERE id = ?',
      )
      .run(
        next.name,
        next.botId,
        next.promptTemplate,
        next.sessionId ?? null,
        next.schedule ? JSON.stringify(next.schedule) : null,
        next.lastFiredAt ?? null,
        next.goalMode === true ? 1 : null,
        next.enabled ? 1 : 0,
        next.timeoutMs ?? null,
        next.autoRetry === undefined ? null : next.autoRetry ? 1 : 0,
        next.usePreviousRunSummary === undefined ? null : next.usePreviousRunSummary ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    this.db.prepare('DELETE FROM routine_webhook_triggers WHERE routine_id = ?').run(id);
    const r = this.db.prepare('DELETE FROM bot_routines WHERE id = ?').run(id);
    return r.changes > 0;
  }

  /**
   * Per-routine public webhook secret (32 random bytes, hex). Generated at
   * creation for new routines; backfilled lazily for older ones via
   * ensureWebhookSecret(). Never exposed in list/get — use the dedicated
   * reveal/regenerate endpoints.
   */
  getWebhookSecret(id: string): string | undefined {
    const row = this.db.prepare('SELECT webhook_secret FROM bot_routines WHERE id = ?').get(id) as unknown as
      | { webhook_secret: string | null }
      | undefined;
    return row?.webhook_secret ?? undefined;
  }

  setWebhookSecret(id: string, secret: string): void {
    this.db.prepare('UPDATE bot_routines SET webhook_secret = ? WHERE id = ?').run(secret, id);
  }

  ensureWebhookSecret(id: string): string {
    const existing = this.getWebhookSecret(id);
    if (existing) return existing;
    const secret = randomBytes(32).toString('hex');
    this.setWebhookSecret(id, secret);
    return secret;
  }

  regenerateWebhookSecret(id: string): string {
    const secret = randomBytes(32).toString('hex');
    this.setWebhookSecret(id, secret);
    return secret;
  }

  // --- Scheduling -----------------------------------------------------------

  /** Replace (or clear, with null) the routine's schedule. Watermark resets to now. */
  setSchedule(id: string, schedule: RoutineSchedule | null): BotRoutine | undefined {
    return this.update(id, { schedule });
  }

  /** Toggle just the schedule's enabled flag without touching the schedule itself. */
  setScheduleEnabled(id: string, enabled: boolean): BotRoutine | undefined {
    const cur = this.get(id);
    if (!cur || !cur.schedule) return cur ?? undefined;
    const schedule: RoutineSchedule = { ...cur.schedule, enabled };
    this.db.prepare('UPDATE bot_routines SET schedule = ? WHERE id = ?').run(JSON.stringify(schedule), id);
    return this.get(id);
  }

  /** Scheduler watermark: last UTC ms the scheduler scanned up to. */
  getLastFiredAt(id: string): number | undefined {
    const row = this.db.prepare('SELECT last_fired_at FROM bot_routines WHERE id = ?').get(id) as unknown as
      | { last_fired_at: number | null }
      | undefined;
    return row?.last_fired_at ?? undefined;
  }

  setLastFiredAt(id: string, ms: number): void {
    this.db.prepare('UPDATE bot_routines SET last_fired_at = ? WHERE id = ?').run(ms, id);
  }
}

export class RoutineWebhookTriggerStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  /** Create a trigger; the secret is returned once — store it on the sender side. */
  create(routineId: string): RoutineWebhookTrigger {
    const trigger: RoutineWebhookTrigger = {
      id: randomUUID(),
      routineId,
      secret: randomBytes(32).toString('hex'),
      enabled: true,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO routine_webhook_triggers (id, routine_id, secret, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(trigger.id, trigger.routineId, trigger.secret, trigger.createdAt);
    return trigger;
  }

  get(id: string): RoutineWebhookTrigger | undefined {
    const row = this.db.prepare('SELECT * FROM routine_webhook_triggers WHERE id = ?').get(id) as unknown as TriggerRow | undefined;
    return row ? rowToTrigger(row) : undefined;
  }

  listByRoutine(routineId: string): RoutineWebhookTrigger[] {
    const rows = this.db
      .prepare('SELECT * FROM routine_webhook_triggers WHERE routine_id = ? ORDER BY created_at DESC')
      .all(routineId) as unknown as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  setEnabled(id: string, enabled: boolean): RoutineWebhookTrigger | undefined {
    this.db.prepare('UPDATE routine_webhook_triggers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  revoke(id: string): boolean {
    const r = this.db.prepare('DELETE FROM routine_webhook_triggers WHERE id = ?').run(id);
    return r.changes > 0;
  }
}

export interface RoutineRouteDeps {
  dataDir: string;
  getBots: () => BotConfig[];
  /** Delivery-queue store for the public hook ingress (routine-hooks.ts). */
  hookStore: import('./routine-hooks.js').RoutineHookStore;
  /** Base URLs for building the public/local hook URLs shown in the UI. */
  getBaseUrls: () => { publicBaseUrl?: string; localPort: number };
  /** Run-record store (routine-runs.ts). When set, deleting a routine also deletes its run history. */
  runStore?: import('./routine-runs.js').RoutineRunStore;
  /** Limit-reset resume store (W1). When set, limit-reset resume routes are enabled. */
  resumeStore?: LimitResetResumeStore;
  /** Event-trigger state store (W2). When set, event status is exposed and routine deletion cascades to cursors. */
  eventStore?: EventTriggerStore;
  /**
   * Event-schedule account checker (W2): returns an error message when
   * the schedule's connected account is not usable, null when it is.
   * Defaults to the local Composio account cache (toolkit must match).
   */
  eventAccountChecker?: (args: {
    accountId: string;
    app: EventSchedule['app'];
    userId: string;
    botId: string;
  }) => string | null;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Attach `nextRunAt` (UTC ms of the next scheduled occurrence, or null)
 * for routines with an enabled schedule. Never throws — a schedule that
 * fails to compute (shouldn't happen post-validation) yields null.
 */
function withNextRun(routine: BotRoutine): BotRoutine & { nextRunAt: number | null } {
  let nextRunAt: number | null = null;
  if (routine.enabled && routine.schedule?.enabled) {
    try {
      const runs = nextRuns(routine.schedule, 1);
      nextRunAt = runs.length > 0 ? runs[0].at : null;
    } catch {
      nextRunAt = null;
    }
  }
  return { ...routine, nextRunAt };
}

/**
 * Register bot-routine management routes. Mount the returned router at
 * `/api/routines`, e.g.:
 *
 *   const routinesRouter = express.Router();
 *   const { routineStore, triggerStore } = registerRoutineRoutes(routinesRouter, { dataDir, getBots });
 *   router.use('/routines', routinesRouter);
 *
 * The returned stores are shared with the webhook ingress router
 * (createRoutineWebhookRouter in webhooks.ts) — construct both from the
 * same factory call so triggers created here are honored there.
 */
export function registerRoutineRoutes(
  router: Router,
  deps: RoutineRouteDeps,
): { routineStore: RoutineStore; triggerStore: RoutineWebhookTriggerStore } {
  const routineStore = new RoutineStore(deps.dataDir);
  const triggerStore = new RoutineWebhookTriggerStore(deps.dataDir);

  /**
   * Event-schedule gate (W2): when the effective schedule is an `event`
   * schedule, its connected account must exist for the schedule's app.
   * Returns an error message (→ 400) or null. Structural problems are
   * reported by validateRoutineSchedule inside the store; this adds the
   * account-existence check the store cannot do.
   */
  const checkEventSchedule = (
    req: Request,
    rawSchedule: unknown,
    botId: string,
  ): string | null => {
    if (typeof rawSchedule !== 'object' || rawSchedule === null) return null;
    if ((rawSchedule as { kind?: unknown }).kind !== 'event') return null;
    let schedule: RoutineSchedule;
    try {
      schedule = validateRoutineSchedule(rawSchedule);
    } catch (err) {
      return err instanceof Error ? err.message : 'invalid event schedule';
    }
    if (schedule.kind !== 'event') return null;
    // Identity (OPEN-1): the verified principal scopes the account-cache
    // lookup; the 'default-user' fallback only preserves the pre-fix local
    // namespace for contexts with no credential at all (this is a read-only
    // validation lookup — it grants nothing).
    const userId = schedule.userId ?? composioCallerOf(req, { dataDir: deps.dataDir }) ?? 'default-user';
    if (deps.eventAccountChecker) {
      return deps.eventAccountChecker({ accountId: schedule.accountId, app: schedule.app, userId, botId });
    }
    const record = readAccountCache(deps.dataDir, userId)[schedule.accountId];
    if (!record) {
      return `unknown connected account "${schedule.accountId}" — connect it in Accounts → Composio first`;
    }
    if (record.toolkitSlug !== schedule.app) {
      return `connected account "${schedule.accountId}" is a ${record.toolkitSlug} account, not ${schedule.app}`;
    }
    return null;
  };

  const requireRoutine = (res: Response, id: string): BotRoutine | undefined => {
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid routine id'));
      return undefined;
    }
    const routine = routineStore.get(id);
    if (!routine) {
      res.status(404).json(errorBody(`Unknown routine "${id}"`));
      return undefined;
    }
    return routine;
  };

  router.post('/', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      botId?: unknown;
      promptTemplate?: unknown;
      sessionId?: unknown;
      schedule?: unknown;
      goalMode?: unknown;
    };
    const botId = typeof body.botId === 'string' ? body.botId : '';
    if (!deps.getBots().some((b) => b.id === botId)) {
      res.status(400).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    const eventError = checkEventSchedule(req, body.schedule, botId);
    if (eventError) {
      res.status(400).json(errorBody(eventError));
      return;
    }
    try {
      const routine = routineStore.create({
        name: typeof body.name === 'string' ? body.name : '',
        botId,
        promptTemplate: typeof body.promptTemplate === 'string' ? body.promptTemplate : '',
        sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined,
        schedule:
          body.schedule === null || body.schedule === undefined
            ? null
            : (body.schedule as RoutineSchedule),
        goalMode: body.goalMode === true,
        timeoutMs: typeof (body as {timeoutMs?: unknown}).timeoutMs === 'number' ? (body as {timeoutMs: number}).timeoutMs : undefined,
        autoRetry: typeof (body as {autoRetry?: unknown}).autoRetry === 'boolean' ? (body as {autoRetry: boolean}).autoRetry : undefined,
        usePreviousRunSummary: typeof (body as {usePreviousRunSummary?: unknown}).usePreviousRunSummary === 'boolean' ? (body as {usePreviousRunSummary: boolean}).usePreviousRunSummary : undefined,
      });
      res.status(201).json({ ok: true, routine: withNextRun(routine) });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to create routine'));
    }
  });

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, routines: routineStore.list().map(withNextRun) });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, routine: withNextRun(routine) });
  });

  router.patch('/:id', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const body = (req.body ?? {}) as {
      name?: unknown;
      botId?: unknown;
      promptTemplate?: unknown;
      sessionId?: unknown;
      schedule?: unknown;
      goalMode?: unknown;
      enabled?: unknown;
    };
    if (body.botId !== undefined && !deps.getBots().some((b) => b.id === body.botId)) {
      res.status(400).json(errorBody(`Unknown bot "${String(body.botId)}"`));
      return;
    }
    // Only a newly-set schedule is account-checked here; unrelated
    // patches (rename, enable toggle) must not fail because an account
    // cache aged out — the poller re-validates at fire time regardless.
    const eventError =
      body.schedule === undefined || body.schedule === null
        ? null
        : checkEventSchedule(
            req,
            body.schedule,
            typeof body.botId === 'string' ? body.botId : routine.botId,
          );
    if (eventError) {
      res.status(400).json(errorBody(eventError));
      return;
    }
    try {
      const updated = routineStore.update(routine.id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        botId: typeof body.botId === 'string' ? body.botId : undefined,
        promptTemplate: typeof body.promptTemplate === 'string' ? body.promptTemplate : undefined,
        sessionId:
          body.sessionId === null
            ? null
            : typeof body.sessionId === 'string' && body.sessionId
              ? body.sessionId
              : undefined,
        schedule:
          body.schedule === null
            ? null
            : body.schedule === undefined
              ? undefined
              : (body.schedule as RoutineSchedule),
        goalMode: typeof body.goalMode === 'boolean' ? body.goalMode : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        timeoutMs: typeof (body as {timeoutMs?: unknown}).timeoutMs === 'number' ? (body as {timeoutMs: number}).timeoutMs : (body as {timeoutMs?: unknown}).timeoutMs === null ? null : undefined,
        autoRetry: typeof (body as {autoRetry?: unknown}).autoRetry === 'boolean' ? (body as {autoRetry: boolean}).autoRetry : undefined,
        usePreviousRunSummary: typeof (body as {usePreviousRunSummary?: unknown}).usePreviousRunSummary === 'boolean' ? (body as {usePreviousRunSummary: boolean}).usePreviousRunSummary : undefined,
      });
      res.json({ ok: true, routine: updated ? withNextRun(updated) : updated });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to update routine'));
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid routine id'));
      return;
    }
    if (!routineStore.remove(id)) {
      res.status(404).json(errorBody(`Unknown routine "${id}"`));
      return;
    }
    // Cascade: the routine's run history goes with it.
    try {
      deps.runStore?.deleteByRoutine(id);
      deps.resumeStore?.deleteByRoutine(id);
      deps.eventStore?.deleteByRoutine(id);
    } catch (err) {
      console.error('[routines] failed to delete run history:', err instanceof Error ? err.message : err);
    }
    res.json({ ok: true, deleted: id });
  });

  // --- Scheduling (OpenMausBot parity) ------------------------------------
  // Timezone-aware schedules on routines: once / daily / cron / interval.

  router.get('/:id/next-runs', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    if (!routine.schedule) {
      res.status(400).json(errorBody('Routine has no schedule'));
      return;
    }
    const n = Math.max(1, Math.min(100, Number(req.query.n) || 5));
    try {
      const runs = nextRuns(routine.schedule, n);
      res.json({ ok: true, routineId: routine.id, schedule: routine.schedule, runs });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to compute next runs'));
    }
  });

  router.post('/:id/schedule/enable', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    if (!routine.schedule) {
      res.status(400).json(errorBody('Routine has no schedule'));
      return;
    }
    const updated = routineStore.setScheduleEnabled(routine.id, true);
    res.json({ ok: true, routine: updated ? withNextRun(updated) : updated });
  });

  router.post('/:id/schedule/disable', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    if (!routine.schedule) {
      res.status(400).json(errorBody('Routine has no schedule'));
      return;
    }
    const updated = routineStore.setScheduleEnabled(routine.id, false);
    res.json({ ok: true, routine: updated ? withNextRun(updated) : updated });
  });

  // --- Limit-reset resumes (W1) -------------------------------------------
  // A routine blocked by a provider usage limit can be scheduled to resume
  // at the provider's reset time. The resume is persisted (survives
  // restart) and fired by RoutineScheduler; see limit-reset-resumes.ts.

  router.post('/:id/limit-reset', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    if (!deps.resumeStore) {
      res.status(501).json(errorBody('Limit-reset resumes are not enabled on this server'));
      return;
    }
    const body = (req.body ?? {}) as {
      providerId?: unknown;
      errorMessage?: unknown;
      resetAt?: unknown;
      retryAfterMs?: unknown;
      defaultBackoffMinutes?: unknown;
    };
    const providerId =
      typeof body.providerId === 'string' && body.providerId.trim()
        ? body.providerId.trim().slice(0, 128)
        : routine.schedule?.kind === 'limit-reset'
          ? (routine.schedule.providerId ?? 'unknown')
          : 'unknown';
    // Rebuild a classifiable error shape from the reported limit failure.
    const synthetic = Object.assign(
      new Error(
        typeof body.errorMessage === 'string' && body.errorMessage.trim()
          ? body.errorMessage.trim().slice(0, 500)
          : 'usage limit reached',
      ),
      {
        status: 429,
        ...(typeof body.resetAt === 'string' ? { resetAt: body.resetAt } : {}),
        ...(typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)
          ? { retryAfterMs: body.retryAfterMs }
          : {}),
      },
    );
    const defaultBackoffMinutes =
      typeof body.defaultBackoffMinutes === 'number' && Number.isFinite(body.defaultBackoffMinutes)
        ? body.defaultBackoffMinutes
        : routine.schedule?.kind === 'limit-reset'
          ? routine.schedule.defaultBackoffMinutes
          : undefined;
    const resumeAt = computeLimitResetResumeAt(synthetic, { providerId, defaultBackoffMinutes });
    try {
      const resume = deps.resumeStore.schedule({
        routineId: routine.id,
        botId: routine.botId,
        providerId,
        resumeAt,
        reason: synthetic.message,
      });
      // Mirror onto a limit-reset schedule so next-run display agrees.
      if (routine.schedule?.kind === 'limit-reset') {
        try {
          routineStore.setSchedule(routine.id, {
            ...routine.schedule,
            resumeAt: new Date(resumeAt).toISOString(),
          });
        } catch {
          // Display mirror only; the resume store is authoritative.
        }
      }
      res.status(201).json({ ok: true, resume });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to schedule limit-reset resume'));
    }
  });

  router.get('/:id/limit-resets', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    if (!deps.resumeStore) {
      res.status(501).json(errorBody('Limit-reset resumes are not enabled on this server'));
      return;
    }
    res.json({ ok: true, resumes: deps.resumeStore.listByRoutine(routine.id) });
  });

  router.delete('/:id/limit-resets/:resumeId', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    if (!deps.resumeStore) {
      res.status(501).json(errorBody('Limit-reset resumes are not enabled on this server'));
      return;
    }
    const resumeId = req.params.resumeId;
    if (!validId(resumeId)) {
      res.status(400).json(errorBody('Invalid resume id'));
      return;
    }
    const resume = deps.resumeStore.get(resumeId);
    if (!resume || resume.routineId !== routine.id) {
      res.status(404).json(errorBody(`Unknown resume "${resumeId}" for this routine`));
      return;
    }
    const cancelled = deps.resumeStore.cancel(resumeId);
    res.json({ ok: true, cancelled });
  });

  // --- Connected-app event triggers (W2) ----------------------------------
  // Status for an event schedule: persisted cursor, last poll/fire times,
  // last poll error, and today's fire count against the daily cap. The
  // polling engine itself lives in routine-events.ts.

  router.get('/:id/event-trigger', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const schedule = routine.schedule;
    if (!schedule || schedule.kind !== 'event') {
      res.status(400).json(errorBody('Routine has no event trigger'));
      return;
    }
    const state = deps.eventStore?.getState(routine.id);
    const today = eventDayKey(schedule.timezone, Date.now());
    const firesToday = deps.eventStore?.firesOn(routine.id, today) ?? 0;
    res.json({
      ok: true,
      routineId: routine.id,
      schedule,
      status: state
        ? {
            cursorId: state.cursorId,
            cursorTs: state.cursorTs,
            lastPollAt: state.lastPollAt,
            lastFiredAt: state.lastFiredAt,
            lastError: state.lastError,
            capBlocked: state.capBlocked,
            firesToday,
            dailyCap: schedule.dailyCap,
          }
        : {
            cursorId: null,
            cursorTs: null,
            lastPollAt: null,
            lastFiredAt: null,
            lastError: null,
            capBlocked: false,
            firesToday,
            dailyCap: schedule.dailyCap,
          },
    });
  });

  router.post('/:id/triggers', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const trigger = triggerStore.create(routine.id);
    res.status(201).json({ ok: true, trigger });
  });

  router.get('/:id/triggers', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, triggers: triggerStore.listByRoutine(routine.id).map(publicTrigger) });
  });

  router.delete('/:id/triggers/:triggerId', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const triggerId = req.params.triggerId;
    if (!validId(triggerId)) {
      res.status(400).json(errorBody('Invalid trigger id'));
      return;
    }
    const trigger = triggerStore.get(triggerId);
    if (!trigger || trigger.routineId !== routine.id) {
      res.status(404).json(errorBody(`Unknown trigger "${triggerId}" for this routine`));
      return;
    }
    triggerStore.revoke(triggerId);
    res.json({ ok: true, revoked: triggerId });
  });

  // --- Public webhook hook (Codync parity) ---------------------------------
  // Every routine has a public URL + secret: POST /api/hooks/:id/:secret.
  // The secret itself is never returned by GET — use reveal/regenerate.

  const hookInfo = (routine: BotRoutine, opts?: { includeSecret: boolean }) => {
    const base = deps.getBaseUrls();
    const secret = routineStore.ensureWebhookSecret(routine.id);
    const path = `/api/hooks/${routine.id}/${secret}`;
    const publicUrl = base.publicBaseUrl ? `${base.publicBaseUrl}${path}` : null;
    const local = `http://127.0.0.1:${base.localPort}${path}`;
    const deliveries = deps.hookStore.listByRoutine(routine.id, 1);
    const info: Record<string, unknown> = {
      routineId: routine.id,
      url: publicUrl,
      localUrl: local,
      hasSecret: true,
      // "connected" only after a real delivery arrived (Codync contract).
      connected: deliveries.some((d) => d.status === 'done'),
      queueDepth: deps.hookStore.countPending(),
    };
    if (opts?.includeSecret) {
      info.secret = secret;
    } else {
      // Never leak the secret in the info endpoint — redact it from the
      // URLs; use /hook/reveal for an explicit one-time display.
      if (typeof info.url === 'string') info.url = (info.url as string).replace(secret, '<secret>');
      info.localUrl = (info.localUrl as string).replace(secret, '<secret>');
    }
    return info;
  };

  router.get('/:id/hook', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, hook: hookInfo(routine) });
  });

  router.post('/:id/hook/reveal', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, hook: hookInfo(routine, { includeSecret: true }) });
  });

  router.post('/:id/hook/regenerate', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    routineStore.regenerateWebhookSecret(routine.id);
    res.json({ ok: true, hook: hookInfo(routine, { includeSecret: true }) });
  });

  router.get('/:id/deliveries', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const deliveries = deps.hookStore.listByRoutine(routine.id, limit).map((d) => ({
      id: d.id,
      eventType: d.eventType,
      status: d.status,
      attempts: d.attempts,
      error: d.error,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));
    res.json({ ok: true, deliveries });
  });

  return { routineStore, triggerStore };
}
