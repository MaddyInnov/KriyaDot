// SPDX-License-Identifier: Apache-2.0
// SCH-13 — Explicit job self-pause on durable blocks.
//
// A scheduled job that keeps failing the same way should stop hammering
// the world and say why. This layer sits on the routine store + run
// records that already exist:
//
//   - After each settled run, `evaluateAfterRun(routineId)` looks at the
//     run store's failure streak and the latest run's error.
//   - DURABLE blocks pause immediately (first occurrence): the error
//     looks like a missing/rejected credential, a missing config value,
//     or a permanently-gone target — retrying cannot fix those.
//   - TRANSIENT failures pause after `failureThreshold` consecutive
//     failures (default 3).
//   - Pausing = RoutineStore.update(id, { enabled: false }) PLUS a pause
//     record in this module's own store carrying the reason, the failure
//     count, the last error, and the next run the schedule WOULD have
//     fired (nextRuns from routine-schedules.ts) so the schedule UI can
//     show "paused — would have run at …".
//   - Resume is explicit: POST /routine-pauses/:routineId/resume (or
//     `resume()`) re-enables the routine and closes the pause record.
//     A success after resume clears the streak through the run store's
//     own bookkeeping; nothing auto-resumes.
//
// Wire-in: RoutineRunExecutor accepts an onSettled callback per run —
// pass `createSelfPauseSettler(policy)` (or call evaluateAfterRun from
// any settle path). The wiring note lists the exact call site.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Router, type Request, type Response } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { RoutineStore, type BotRoutine } from './bot-routines.js';
import { RoutineRunStore, type RunSettledResult } from './routine-runs.js';
import { nextRuns } from './routine-schedules.js';
import { LifecycleAuditLog } from './lifecycle-approval.js';

export const DEFAULT_SELF_PAUSE_THRESHOLD = 3;

/**
 * Error shapes that mean "a human must fix something before this can
 * ever succeed" — credential/auth/config/target-gone classes.
 */
const DURABLE_ERROR_PATTERNS: { pattern: RegExp; kind: string }[] = [
  { pattern: /missing credential|credential.*(missing|not found|required)|no credential/i, kind: 'missing-credential' },
  { pattern: /invalid[_ ]?api[_ ]?key|api key.*(invalid|revoked)|unauthori[sz]ed|\b401\b|\b403\b.*(credential|token|key)/i, kind: 'credential-rejected' },
  { pattern: /oauth|refresh token/i, kind: 'credential-rejected' },
  { pattern: /not configured|missing config|config.*required|env(ironment)? variable.*\b(missing|not set|unset)\b/i, kind: 'missing-config' },
  { pattern: /bot not found|routine not found|channel not found|target not found|\b404\b.*not found/i, kind: 'target-gone' },
];

export type SelfPauseReasonKind = 'durable-block' | 'repeated-failure';

export interface RoutinePauseRecord {
  id: string;
  routineId: string;
  routineName: string;
  reasonKind: SelfPauseReasonKind;
  /** Durable-block class (e.g. 'missing-credential') when reasonKind is durable-block. */
  blockKind?: string;
  reason: string;
  consecutiveFailures: number;
  lastError?: string;
  pausedAt: number;
  /** When the schedule would have fired next, had it not paused (ms epoch). */
  nextRunAt?: number;
  resumedAt?: number;
  resumedBy?: string;
}

/** Classify an error message as a durable block; null when transient/unknown. */
export function classifyDurableBlock(error: string | null | undefined): string | null {
  if (!error) return null;
  for (const { pattern, kind } of DURABLE_ERROR_PATTERNS) {
    if (pattern.test(error)) return kind;
  }
  return null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS routine_pauses (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    routine_name TEXT NOT NULL,
    reason_kind TEXT NOT NULL,
    block_kind TEXT,
    reason TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL,
    last_error TEXT,
    paused_at INTEGER NOT NULL,
    next_run_at INTEGER,
    resumed_at INTEGER,
    resumed_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_routine_pauses_active ON routine_pauses(routine_id, resumed_at);
`;

interface PauseRow {
  id: string;
  routine_id: string;
  routine_name: string;
  reason_kind: string;
  block_kind: string | null;
  reason: string;
  consecutive_failures: number;
  last_error: string | null;
  paused_at: number;
  next_run_at: number | null;
  resumed_at: number | null;
  resumed_by: string | null;
}

function rowToPause(row: PauseRow): RoutinePauseRecord {
  return {
    id: row.id,
    routineId: row.routine_id,
    routineName: row.routine_name,
    reasonKind: row.reason_kind as SelfPauseReasonKind,
    ...(row.block_kind ? { blockKind: row.block_kind } : {}),
    reason: row.reason,
    consecutiveFailures: row.consecutive_failures,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    pausedAt: row.paused_at,
    ...(row.next_run_at != null ? { nextRunAt: row.next_run_at } : {}),
    ...(row.resumed_at != null ? { resumedAt: row.resumed_at } : {}),
    ...(row.resumed_by ? { resumedBy: row.resumed_by } : {}),
  };
}

export interface RoutineSelfPauseDeps {
  routines: RoutineStore;
  runs: RoutineRunStore;
  auditLog?: LifecycleAuditLog;
  failureThreshold?: number;
  now?: () => number;
}

export class RoutineSelfPausePolicy {
  private readonly db: DatabaseSync;
  private readonly routines: RoutineStore;
  private readonly runs: RoutineRunStore;
  private readonly auditLog?: LifecycleAuditLog;
  private readonly threshold: number;
  private readonly nowFn: () => number;

  constructor(dataDir: string, deps: RoutineSelfPauseDeps) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openSqliteDb(join(dataDir, 'routine-pauses.db'));
    this.db.exec(SCHEMA);
    this.routines = deps.routines;
    this.runs = deps.runs;
    this.auditLog = deps.auditLog;
    this.threshold = Math.max(1, Math.floor(deps.failureThreshold ?? DEFAULT_SELF_PAUSE_THRESHOLD));
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /** The open (not-yet-resumed) pause for a routine, if any. */
  activePause(routineId: string): RoutinePauseRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM routine_pauses WHERE routine_id = ? AND resumed_at IS NULL ORDER BY paused_at DESC LIMIT 1')
      .get(routineId) as unknown as PauseRow | undefined;
    return row ? rowToPause(row) : undefined;
  }

  /** All open pauses (the schedule UI's "paused jobs" list). */
  listActive(): RoutinePauseRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM routine_pauses WHERE resumed_at IS NULL ORDER BY paused_at DESC')
      .all() as unknown as PauseRow[];
    return rows.map(rowToPause);
  }

  listHistory(routineId?: string): RoutinePauseRecord[] {
    const rows = (
      routineId
        ? this.db.prepare('SELECT * FROM routine_pauses WHERE routine_id = ? ORDER BY paused_at DESC').all(routineId)
        : this.db.prepare('SELECT * FROM routine_pauses ORDER BY paused_at DESC').all()
    ) as unknown as PauseRow[];
    return rows.map(rowToPause);
  }

  /**
   * Evaluate a routine after its latest run settled. Returns the pause
   * record when THIS evaluation paused the job; undefined otherwise.
   * Idempotent: an already-paused routine is not re-paused.
   */
  evaluateAfterRun(routineId: string): RoutinePauseRecord | undefined {
    const routine = this.routines.get(routineId);
    if (!routine || !routine.enabled) return undefined;
    if (this.activePause(routineId)) return undefined;

    const streak = this.runs.getStreak(routineId);
    if (streak.consecutiveFailures === 0) return undefined;

    const latest = this.runs.listByRoutine(routineId, 1)[0];
    const lastError = latest?.status === 'failed' ? (latest.error ?? undefined) : undefined;
    const blockKind = classifyDurableBlock(lastError);

    let reasonKind: SelfPauseReasonKind | undefined;
    let reason: string | undefined;
    if (blockKind) {
      reasonKind = 'durable-block';
      reason = `Paused itself: durable block (${blockKind}) — a human must fix this before the job can succeed. Last error: ${lastError}`;
    } else if (streak.consecutiveFailures >= this.threshold) {
      reasonKind = 'repeated-failure';
      reason = `Paused itself after ${streak.consecutiveFailures} consecutive failed runs (threshold ${this.threshold}). Last error: ${lastError ?? 'unknown'}`;
    }
    if (!reasonKind || !reason) return undefined;

    return this.pause(routine, { reasonKind, blockKind: blockKind ?? undefined, reason, consecutiveFailures: streak.consecutiveFailures, lastError });
  }

  /** Pause a routine now, recording the reason. No-op when already paused/disabled. */
  pause(
    routine: BotRoutine,
    input: {
      reasonKind: SelfPauseReasonKind;
      blockKind?: string;
      reason: string;
      consecutiveFailures: number;
      lastError?: string;
    },
  ): RoutinePauseRecord | undefined {
    if (this.activePause(routine.id)) return undefined;
    this.routines.update(routine.id, { enabled: false });
    let nextRunAt: number | undefined;
    if (routine.schedule) {
      try {
        nextRunAt = nextRuns(routine.schedule, 1, this.nowFn())[0]?.at;
      } catch {
        nextRunAt = undefined; // unparseable schedule — pause still stands
      }
    }
    const record: RoutinePauseRecord = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      reasonKind: input.reasonKind,
      ...(input.blockKind ? { blockKind: input.blockKind } : {}),
      reason: input.reason,
      consecutiveFailures: input.consecutiveFailures,
      ...(input.lastError ? { lastError: input.lastError } : {}),
      pausedAt: this.nowFn(),
      ...(nextRunAt != null ? { nextRunAt } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO routine_pauses (id, routine_id, routine_name, reason_kind, block_kind, reason, consecutive_failures, last_error, paused_at, next_run_at, resumed_at, resumed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        record.id,
        record.routineId,
        record.routineName,
        record.reasonKind,
        record.blockKind ?? null,
        record.reason,
        record.consecutiveFailures,
        record.lastError ?? null,
        record.pausedAt,
        record.nextRunAt ?? null,
      );
    this.auditLog?.record('routine.self_paused', 'scheduler', {
      routineId: record.routineId,
      reasonKind: record.reasonKind,
      blockKind: record.blockKind,
      consecutiveFailures: record.consecutiveFailures,
      nextRunAt: record.nextRunAt,
    });
    return record;
  }

  /** Explicit resume: re-enable the routine and close its open pause. */
  resume(routineId: string, actor = 'api'): RoutinePauseRecord | undefined {
    const open = this.activePause(routineId);
    if (!open) return undefined;
    this.routines.update(routineId, { enabled: true });
    this.db
      .prepare('UPDATE routine_pauses SET resumed_at = ?, resumed_by = ? WHERE id = ?')
      .run(this.nowFn(), actor, open.id);
    this.auditLog?.record('routine.self_pause_resumed', actor, { routineId, pauseId: open.id });
    return { ...open, resumedAt: this.nowFn(), resumedBy: actor };
  }
}

/**
 * An onSettled callback for RoutineRunExecutor runs: feed it the routine
 * id resolver and it evaluates self-pause after every settled run.
 */
export function createSelfPauseSettler(
  policy: RoutineSelfPausePolicy,
  routineIdForRun: (runId: string) => string | undefined,
  runs: RoutineRunStore,
): (result: RunSettledResult) => void {
  return (result) => {
    try {
      const routineId = routineIdForRun(result.runId) ?? runs.get(result.runId)?.routineId;
      if (routineId) policy.evaluateAfterRun(routineId);
    } catch {
      // A self-pause bookkeeping failure must never break run settling.
    }
  };
}

// ---------------------------------------------------------------------------
// Routes — register-style: mount at /api (paths are /routine-pauses).
// This is the data the schedule UI renders next to a paused job: reason +
// would-have-been next run.
// ---------------------------------------------------------------------------

export function createRoutineSelfPauseRouter(deps: { policy: RoutineSelfPausePolicy }): Router {
  const router = Router();

  router.get('/routine-pauses', (_req: Request, res: Response) => {
    res.json({ ok: true, pauses: deps.policy.listActive() });
  });

  router.get('/routine-pauses/history', (req: Request, res: Response) => {
    const routineId = typeof req.query['routineId'] === 'string' ? req.query['routineId'] : undefined;
    res.json({ ok: true, pauses: deps.policy.listHistory(routineId) });
  });

  router.post('/routine-pauses/:routineId/resume', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { actor?: unknown };
    const resumed = deps.policy.resume(
      req.params.routineId,
      typeof body.actor === 'string' ? body.actor : undefined,
    );
    if (!resumed) {
      res.status(404).json({ error: 'no active self-pause for this routine' });
      return;
    }
    res.json({ ok: true, pause: resumed });
  });

  return router;
}
