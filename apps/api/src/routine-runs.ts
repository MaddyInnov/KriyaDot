// SPDX-License-Identifier: Apache-2.0
// Routine run lifecycle — OpenMausBot parity P0 #7.
//
// Scheduling (routine-schedules.ts) fires routine turns; this module gives
// every fire a durable run record in <dataDir>/routine-runs.db
// (node:sqlite):
//
//   queued -> running -> succeeded | failed | cancelled
//                        missed   (schedule tick passed while overlap=skip,
//                                  or the occurrence fell inside server
//                                  downtime)
//
// - RoutineRunStore: run records + per-routine consecutive-failure streaks.
// - RoutineRunExecutor: runs one routine turn with bookkeeping (queued ->
//   running -> terminal), output-excerpt capture, token usage, and real
//   cancellation via AbortSignal (runTurn honors opts.signal).
// - reconcileRunning(): boot recovery — runs stuck in queued/running when
//   the server died are marked failed ("server restarted").
//
// Triggers: 'schedule' | 'webhook' | 'manual'. The executor is shared by
// the scheduler, the webhook ingress router, and the public-hook delivery
// worker so every path leaves the same records.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import { classifyProviderError } from '@mvp/agent-runtime';
import type { BotRoutine } from './bot-routines.js';

import { openDb as openSqliteDb } from '@mvp/agent-runtime';

export type RunTrigger = 'schedule' | 'webhook' | 'manual' | 'event';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'missed' | 'cancelled';

/** Terminal statuses — no further transitions allowed. */
const TERMINAL: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'missed', 'cancelled']);

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  trigger: RunTrigger;
  /** The scheduled occurrence this run is for (schedule/catch-up/retry), else null. */
  scheduledFor: number | null;
  startedAt: number | null;
  endedAt: number | null;
  status: RunStatus;
  /** First ~2000 chars of the turn's streamed reply text. */
  outputExcerpt: string | null;
  error: string | null;
  tokens: number | null;
  costUsd: number | null;
  createdAt: number;
  /** Item 4c: true when an automatic retry recovered this run. */
  recovered?: boolean;
  /** Total attempts made (1 = no retry). */
  attempts?: number;
}

export interface FailureStreak {
  consecutiveFailures: number;
  lastFailedAt: number | null;
}

interface RunRow {
  id: string;
  routine_id: string;
  routine_name: string;
  trigger: string;
  scheduled_for: number | null;
  started_at: number | null;
  ended_at: number | null;
  status: string;
  output_excerpt: string | null;
  error: string | null;
  tokens: number | null;
  cost_usd: number | null;
  created_at: number;
  recovered: number | null;
  attempts: number | null;
}

function rowToRun(r: RunRow): RoutineRun {
  return {
    id: r.id,
    routineId: r.routine_id,
    routineName: r.routine_name,
    trigger: r.trigger as RunTrigger,
    scheduledFor: r.scheduled_for,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status as RunStatus,
    outputExcerpt: r.output_excerpt,
    error: r.error,
    tokens: r.tokens,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    recovered: r.recovered === 1 ? true : undefined,
    attempts: r.attempts ?? undefined,
  };
}

function openDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = openSqliteDb(join(dataDir, 'routine-runs.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      routine_name TEXT NOT NULL,
      trigger TEXT NOT NULL,
      scheduled_for INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      status TEXT NOT NULL,
      output_excerpt TEXT,
      error TEXT,
      tokens INTEGER,
      cost_usd REAL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_routine_runs_status ON routine_runs(status);
    CREATE TABLE IF NOT EXISTS routine_run_meta (
      routine_id TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failed_at INTEGER
    );
  `);
  const runCols = db.prepare('PRAGMA table_info(routine_runs)').all() as unknown as Array<{ name: string }>;
  if (!runCols.some((c) => c.name === 'recovered')) db.exec('ALTER TABLE routine_runs ADD COLUMN recovered INTEGER');
  if (!runCols.some((c) => c.name === 'attempts')) db.exec('ALTER TABLE routine_runs ADD COLUMN attempts INTEGER');
  return db;
}

export class RoutineRunStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  /** Create a run record in 'queued' status. */
  createRun(input: {
    routineId: string;
    routineName: string;
    trigger: RunTrigger;
    scheduledFor?: number | null;
  }): RoutineRun {
    const now = Date.now();
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.routineId,
      routineName: input.routineName,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor ?? null,
      startedAt: null,
      endedAt: null,
      status: 'queued',
      outputExcerpt: null,
      error: null,
      tokens: null,
      costUsd: null,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO routine_runs
           (id, routine_id, routine_name, trigger, scheduled_for, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(run.id, run.routineId, run.routineName, run.trigger, run.scheduledFor, run.createdAt);
    return run;
  }

  /** Directly record a missed occurrence (no turn ever ran). */
  markMissed(
    routineId: string,
    routineName: string,
    scheduledFor: number,
    note?: string,
    trigger: RunTrigger = 'schedule',
  ): RoutineRun {
    const now = Date.now();
    const run: RoutineRun = {
      id: randomUUID(),
      routineId,
      routineName,
      trigger,
      scheduledFor,
      startedAt: null,
      endedAt: now,
      status: 'missed',
      outputExcerpt: null,
      error: note ?? 'scheduled occurrence was skipped',
      tokens: null,
      costUsd: null,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO routine_runs
           (id, routine_id, routine_name, trigger, scheduled_for, status, error, ended_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'missed', ?, ?, ?)`,
      )
      .run(run.id, run.routineId, run.routineName, run.trigger, run.scheduledFor, run.error, run.endedAt, run.createdAt);
    return run;
  }

  /** queued -> running. Returns undefined when the run isn't queued. */
  startRun(id: string): RoutineRun | undefined {
    const run = this.get(id);
    if (!run || run.status !== 'queued') return undefined;
    const now = Date.now();
    this.db
      .prepare(`UPDATE routine_runs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(now, id);
    return this.get(id);
  }

  /**
   * running/queued -> terminal. Updates the failure streak:
   * succeeded resets it, failed increments it, cancelled leaves it alone
   * (a user cancel is not a failure). Throws on an already-terminal run.
   */
  finishRun(
    id: string,
    result: {
      status: 'succeeded' | 'failed' | 'cancelled';
      outputExcerpt?: string | null;
      error?: string | null;
      tokens?: number | null;
      costUsd?: number | null;
      recovered?: boolean;
      attempts?: number;
    },
  ): { run: RoutineRun; consecutiveFailures: number } | undefined {
    const run = this.get(id);
    if (!run) return undefined;
    if (TERMINAL.has(run.status)) {
      throw new Error(`run ${id} is already ${run.status}`);
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE routine_runs
         SET status = ?, output_excerpt = ?, error = ?, tokens = ?, cost_usd = ?, ended_at = ?, recovered = ?, attempts = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.outputExcerpt ?? null,
        result.error ?? null,
        result.tokens ?? null,
        result.costUsd ?? null,
        now,
        result.recovered ? 1 : 0,
        result.attempts ?? 1,
        id,
      );
    let consecutiveFailures = this.getStreak(run.routineId).consecutiveFailures;
    if (result.status === 'failed') {
      consecutiveFailures += 1;
      this.db
        .prepare(
          `INSERT INTO routine_run_meta (routine_id, consecutive_failures, last_failed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(routine_id) DO UPDATE SET consecutive_failures = ?, last_failed_at = ?`,
        )
        .run(run.routineId, consecutiveFailures, now, consecutiveFailures, now);
    } else if (result.status === 'succeeded') {
      consecutiveFailures = 0;
      this.db
        .prepare(
          `INSERT INTO routine_run_meta (routine_id, consecutive_failures, last_failed_at)
           VALUES (?, 0, NULL)
           ON CONFLICT(routine_id) DO UPDATE SET consecutive_failures = 0, last_failed_at = NULL`,
        )
        .run(run.routineId);
    }
    return { run: this.get(id) as RoutineRun, consecutiveFailures };
  }

  /** queued/running -> cancelled (user action). Returns false when already terminal. */
  cancelRun(id: string): boolean {
    const run = this.get(id);
    if (!run || TERMINAL.has(run.status)) return false;
    this.db
      .prepare(`UPDATE routine_runs SET status = 'cancelled', error = 'cancelled by user', ended_at = ? WHERE id = ?`)
      .run(Date.now(), id);
    return true;
  }

  get(id: string): RoutineRun | undefined {
    const row = this.db.prepare(`SELECT * FROM routine_runs WHERE id = ?`).get(id) as unknown as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listByRoutine(routineId: string, limit = 20, offset = 0): RoutineRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(routineId, Math.max(1, limit), Math.max(0, offset)) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Runs stuck in a non-terminal state (crash-recovery sweep reads these
   * BEFORE reconcileRunning() marks them failed).
   */
  listStuckRuns(): RoutineRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM routine_runs WHERE status IN ('queued', 'running') ORDER BY created_at ASC`)
      .all() as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  countByRoutine(routineId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ?`)
      .get(routineId) as unknown as { n: number };
    return row.n;
  }

  getStreak(routineId: string): FailureStreak {
    const row = this.db
      .prepare(`SELECT consecutive_failures, last_failed_at FROM routine_run_meta WHERE routine_id = ?`)
      .get(routineId) as unknown as { consecutive_failures: number; last_failed_at: number | null } | undefined;
    return {
      consecutiveFailures: row?.consecutive_failures ?? 0,
      lastFailedAt: row?.last_failed_at ?? null,
    };
  }

  /**
   * Boot recovery: any run still queued/running when the server died is
   * marked failed ("server restarted"). Streaks are intentionally left
   * alone — an interruption is not a routine failure.
   */
  reconcileRunning(): number {
    const r = this.db
      .prepare(
        `UPDATE routine_runs
         SET status = 'failed', error = 'server restarted while the run was in progress', ended_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(Date.now());
    return Number(r.changes);
  }

  /** Most recent succeeded run's report summary (output excerpt), for previous-run memory (item 4d). */
  lastSuccessfulSummary(routineId: string): string | null {
    const rows = this.listByRoutine(routineId, 20);
    const hit = rows.find((r) => r.status === 'succeeded' && r.outputExcerpt);
    return hit?.outputExcerpt ?? null;
  }

  /** Cascade when a routine is deleted. */
  deleteByRoutine(routineId: string): void {
    this.db.prepare(`DELETE FROM routine_runs WHERE routine_id = ?`).run(routineId);
    this.db.prepare(`DELETE FROM routine_run_meta WHERE routine_id = ?`).run(routineId);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface RunSettledResult {
  runId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  error?: string | null;
  tokens?: number | null;
  recovered?: boolean;
  attempts?: number;
}

export interface ExecuteRoutineRunOptions {
  routine: BotRoutine;
  trigger: RunTrigger;
  /** Scheduled occurrence this run is for (schedule/catch-up/retry). */
  scheduledFor?: number | null;
  /** Rendered prompt. When omitted, rendered from the routine's template. */
  message?: string;
  /** Payload for default template rendering ({{payload}}/{{body}}). */
  payload?: unknown;
  sessionId?: string;
  /** External abort (e.g. HTTP disconnect). Linked to the run's controller. */
  signal?: AbortSignal;
  /** Called exactly once when the run reaches a terminal status. Never throws into the executor. */
  onSettled?: (result: RunSettledResult) => void;
}

export interface RoutineRunExecutorDeps {
  runStore: RoutineRunStore;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /** Template rendering; default is {{payload}}/{{body}} substitution. */
  renderPrompt?: (template: string, body: unknown) => string;
  /**
   * Routine-as-goal (OpenMausBot parity P1 #11): when a routine has
   * `goalMode` set, firing it calls this hook instead of running a single
   * agent turn. The hook starts a bounded multi-turn group goal pursuing
   * the routine's objective and resolves with the goal id. Unset →
   * goal-mode routines fall back to a normal single turn (with a warning).
   */
  startGroupGoal?: (args: {
    routine: BotRoutine;
    prompt: string;
  }) => Promise<string>;
  /**
   * Limit-reset (W1): called when a run fails with a hard provider usage
   * limit, so the host can arm a resume at the provider's reset time
   * (routines whose schedule kind is 'limit-reset'). Never throws into
   * the executor.
   */
  onLimitBlocked?: (args: { routine: BotRoutine; error: unknown }) => void;
}

const OUTPUT_EXCERPT_LIMIT = 2000;

function defaultRenderPrompt(template: string, body: unknown): string {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return template.split('{{payload}}').join(payload).split('{{body}}').join(payload);
}

/**
 * Runs routine turns with run-record bookkeeping. Shared by the scheduler,
 * the webhook ingress router, and the public-hook delivery worker so every
 * trigger path leaves the same records.
 */
export class RoutineRunExecutor {
  private readonly active = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly deps: RoutineRunExecutorDeps) {}

  /**
   * Start a run in the background and return its id immediately.
   * The turn must not block webhook/scheduler callers.
   */
  async execute(opts: ExecuteRoutineRunOptions): Promise<string> {
    const bot = this.deps.getBots().find((b) => b.id === opts.routine.botId);
    if (!bot) throw new Error(`Unknown bot "${opts.routine.botId}"`);
    const run = this.deps.runStore.createRun({
      routineId: opts.routine.id,
      routineName: opts.routine.name,
      trigger: opts.trigger,
      scheduledFor: opts.scheduledFor ?? null,
    });
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.active.set(run.id, controller);
    void this.runInBackground(run.id, opts, bot, controller.signal);
    return run.id;
  }

  /** Like execute(), but awaits the turn's completion. */
  async executeWait(opts: ExecuteRoutineRunOptions): Promise<RunSettledResult> {
    return new Promise<RunSettledResult>((resolve, reject) => {
      this.execute({ ...opts, onSettled: resolve }).then(
        () => {},
        (err) => reject(err),
      );
    });
  }

  /**
   * Cancel a run. A queued run is marked cancelled immediately; a running
   * run's turn is aborted (the runtime stops at the next checkpoint) and
   * marked cancelled when it settles. Returns false for unknown or
   * already-terminal runs.
   */
  cancel(runId: string): boolean {
    const run = this.deps.runStore.get(runId);
    if (!run || TERMINAL.has(run.status)) return false;
    if (run.status === 'queued') {
      this.active.delete(runId);
      return this.deps.runStore.cancelRun(runId);
    }
    this.cancelled.add(runId);
    this.active.get(runId)?.abort();
    return true;
  }

  /** True while the run's turn is in flight. */
  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private async runInBackground(
    runId: string,
    opts: ExecuteRoutineRunOptions,
    bot: BotConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.deps.runStore;
    const render = this.deps.renderPrompt ?? defaultRenderPrompt;
    store.startRun(runId);
    let excerpt = '';
    let tokens: number | null = null;
    const settle = (result: Omit<RunSettledResult, 'runId'>): void => {
      try {
        store.finishRun(runId, { ...result, outputExcerpt: excerpt || null });
      } catch (err) {
        console.error(`[routine-runs] failed to finish run ${runId}:`, err instanceof Error ? err.message : err);
      } finally {
        this.active.delete(runId);
        this.cancelled.delete(runId);
      }
      try {
        opts.onSettled?.({ runId, ...result });
      } catch (err) {
        console.error('[routine-runs] onSettled threw:', err instanceof Error ? err.message : err);
      }
    };
    // Routine-as-goal (OpenMausBot parity P1 #11): a goal-mode routine
    // pursues its objective as a bounded multi-turn group goal instead of
    // a single agent turn. The routine run record stays as the audit trail
    // pointing at the goal.
    if (opts.routine.goalMode === true) {
      try {
        const message = opts.message ?? render(opts.routine.promptTemplate, opts.payload ?? {});
        if (!this.deps.startGroupGoal) {
          console.warn(
            `[routine-runs] routine "${opts.routine.id}" has goalMode but no group-goal hook; running a single turn instead`,
          );
        } else {
          const goalId = await this.deps.startGroupGoal({ routine: opts.routine, prompt: message });
          excerpt = `Group goal ${goalId} started.`;
          settle({ status: 'succeeded' });
          return;
        }
      } catch (err) {
        settle({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    // Previous-run memory (item 4d): inject the last succeeded run's
    // report summary. Default on for recurring routines; per-routine
    // usePreviousRunSummary overrides.
    const recurring = Boolean(opts.routine.schedule && opts.routine.schedule.kind !== 'once' && opts.routine.schedule.kind !== 'startup');
    const includePrev = opts.routine.usePreviousRunSummary ?? recurring;
    let baseMessage = opts.message ?? render(opts.routine.promptTemplate, opts.payload ?? {});
    if (includePrev) {
      try { const prev = store.lastSuccessfulSummary(opts.routine.id); if (prev) baseMessage += `\n\n[Previous run report summary]\n${prev}`; } catch { /* memory must never break a run */ }
    }
    // Per-routine timeout (item 4b) + automatic retry once (item 4c).
    const maxAttempts = opts.routine.autoRetry === false ? 1 : 2;
    const timeoutMs = opts.routine.timeoutMs && opts.routine.timeoutMs > 0 ? opts.routine.timeoutMs : undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      excerpt = ''; tokens = null;
      let timedOut = false;
      let attemptSignal = signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs) {
        const ctl = new AbortController();
        if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true });
        timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
        attemptSignal = ctl.signal;
      }
      try {
        const usage = await this.deps.agentRuntime.runTurn({
          bot,
          message: baseMessage,
          sessionId: opts.sessionId ?? opts.routine.sessionId ?? `routine_${opts.routine.id}`,
          taskType: 'chat',
          signal: attemptSignal,
          onEvent: (ev) => {
            if (ev.type === 'token' && typeof ev.content === 'string' && excerpt.length < OUTPUT_EXCERPT_LIMIT) {
              excerpt += ev.content;
            } else if (ev.type === 'done') {
              tokens = ev.usage.totalTokens;
            }
          },
        });
        tokens ??= usage?.totalTokens ?? null;
        if (timer) clearTimeout(timer);
        if (this.cancelled.has(runId)) { settle({ status: 'cancelled', error: 'cancelled by user', attempts: attempt }); return; }
        if (timedOut) throw new Error(`routine run timed out after ${timeoutMs}ms`);
        if (signal.aborted) { settle({ status: 'cancelled', error: 'cancelled by user', attempts: attempt }); return; }
        settle({ status: 'succeeded', tokens, recovered: attempt > 1 ? true : undefined, attempts: attempt });
        return;
      } catch (err) {
        if (timer) clearTimeout(timer);
        if (this.cancelled.has(runId)) { settle({ status: 'cancelled', error: 'cancelled by user', attempts: attempt }); return; }
        if (attempt < maxAttempts && !signal.aborted) continue; // automatic retry, once
        try {
          if (this.deps.onLimitBlocked && classifyProviderError(err).isLimit) {
            this.deps.onLimitBlocked({ routine: opts.routine, error: err });
          }
        } catch (hookErr) {
          console.error('[routine-runs] onLimitBlocked threw:', hookErr instanceof Error ? hookErr.message : hookErr);
        }
        settle({ status: 'failed', error: err instanceof Error ? err.message : String(err), tokens, attempts: attempt });
        return;
      }
    }
  }
}
