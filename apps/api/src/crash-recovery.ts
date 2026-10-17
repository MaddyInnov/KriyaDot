// SPDX-License-Identifier: Apache-2.0
// Automatic crash recovery (OpenMausBot parity).
//
// When the API server restarts, in-flight agent work is orphaned: the
// process is gone, but the database still says "running". The boot-time
// reconciliation sweep (reconcileOnBoot, called from index.ts) finds those
// records, marks them `interrupted (server restart)`, and files an orphan
// entry per item so the UI can offer one-click resume:
//
//   GET  /api/recovery/orphans              → pending orphan entries
//   POST /api/recovery/orphans/:id/resume   → kind-specific resume
//   POST /api/recovery/orphans/:id/dismiss  → drop the entry
//
// Resume semantics per kind:
// - chat-turn: the orphan carries the last user message; resume returns it
//   so the UI's Resume button re-sends it through the normal chat pipeline.
// - team-run: re-starts the team run with the same task (via the host-wired
//   retryTeamRun, which hits the new POST /api/teams/:id/runs/:runId/retry).
// - group-goal: interrupted goals are parked as 'blocked' so the EXISTING
//   POST /api/group-goals/:id/resume endpoint restarts them — resume here
//   just returns that URL.
// - routine-run: reconcileRunning() already failed them; resume returns the
//   existing POST /api/routines/:id/runs/:runId/retry URL.
//
// Chat turns are tracked by TurnTracker: the chat route calls beginTurn when
// a turn starts and endTurn when it settles. Rows left behind by a restart
// are the orphaned turns. The tracker is tiny and synchronous — tracking
// must never break chat.

import express, { type Router } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';

export const INTERRUPTED_NOTE = 'interrupted (server restart)';

// ---------------------------------------------------------------------------
// TurnTracker: in-flight chat turns
// ---------------------------------------------------------------------------

export interface ActiveTurn {
  sessionId: string;
  botId: string;
  /** The user message that started the turn (for resume). */
  message: string;
  startedAt: number;
}

export class TurnTracker {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'active-turns.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_turns (
        session_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        message TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);
  }

  beginTurn(turn: ActiveTurn): void {
    try {
      this.db
        .prepare(
          `INSERT INTO active_turns (session_id, bot_id, message, started_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET bot_id = excluded.bot_id, message = excluded.message, started_at = excluded.started_at`,
        )
        .run(turn.sessionId, turn.botId, turn.message.slice(0, 8000), turn.startedAt);
    } catch {
      // tracking must never break chat
    }
  }

  endTurn(sessionId: string): void {
    try {
      this.db.prepare('DELETE FROM active_turns WHERE session_id = ?').run(sessionId);
    } catch {
      // ignore
    }
  }

  listActive(): ActiveTurn[] {
    try {
      return this.db
        .prepare(
          'SELECT session_id AS sessionId, bot_id AS botId, message, started_at AS startedAt FROM active_turns ORDER BY started_at ASC',
        )
        .all() as unknown as ActiveTurn[];
    } catch {
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Orphan ledger
// ---------------------------------------------------------------------------

export type OrphanKind = 'chat-turn' | 'team-run' | 'group-goal' | 'routine-run';

export interface OrphanEntry {
  id: string;
  kind: OrphanKind;
  /** The interrupted record's id (run id, goal id, session id). */
  refId: string;
  label: string;
  /** Kind-specific resume context (JSON). */
  context: Record<string, unknown>;
  interruptedAt: number;
  resolvedAt: number | null;
}

export class OrphanLedger {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'crash-orphans.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orphans (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        label TEXT NOT NULL,
        context_json TEXT NOT NULL,
        interrupted_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_orphans_pending ON orphans (resolved_at, interrupted_at DESC);
    `);
  }

  file(input: { kind: OrphanKind; refId: string; label: string; context?: Record<string, unknown> }): OrphanEntry {
    const entry: OrphanEntry = {
      id: randomUUID(),
      kind: input.kind,
      refId: input.refId,
      label: input.label,
      context: input.context ?? {},
      interruptedAt: Date.now(),
      resolvedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO orphans (id, kind, ref_id, label, context_json, interrupted_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(entry.id, entry.kind, entry.refId, entry.label, JSON.stringify(entry.context), entry.interruptedAt, null);
    return entry;
  }

  listPending(): OrphanEntry[] {
    const rows = this.db
      .prepare(
        'SELECT id, kind, ref_id AS refId, label, context_json AS contextJson, interrupted_at AS interruptedAt, resolved_at AS resolvedAt FROM orphans WHERE resolved_at IS NULL ORDER BY interrupted_at DESC',
      )
      .all() as Array<Omit<OrphanEntry, 'context'> & { contextJson: string }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as OrphanKind,
      refId: r.refId,
      label: r.label,
      context: (() => {
        try {
          return JSON.parse(r.contextJson) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
      interruptedAt: r.interruptedAt,
      resolvedAt: r.resolvedAt,
    }));
  }

  get(id: string): OrphanEntry | undefined {
    return this.listPending().find((o) => o.id === id);
  }

  resolve(id: string): boolean {
    const r = this.db.prepare('UPDATE orphans SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(Date.now(), id);
    return r.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Boot-time reconciliation sweep
// ---------------------------------------------------------------------------

export interface StuckRoutineRun {
  id: string;
  routineId: string;
  routineName: string;
}

export interface ReconcileDeps {
  dataDir: string;
  /** Stuck routine runs (queried BEFORE reconcileRunning marks them). */
  listStuckRoutineRuns: () => StuckRoutineRun[];
  reconcileRoutineRuns: () => number;
  /** All team runs still marked running: { runId, teamId, teamName, task }. */
  listRunningTeamRuns: () => Array<{ runId: string; teamId: string; teamName: string; task: string }>;
  markTeamRunInterrupted: (runId: string) => void;
  /** Group goals still marked running. */
  listRunningGroupGoals: () => Array<{ goalId: string; title: string }>;
  markGroupGoalInterrupted: (goalId: string) => void;
  turnTracker: TurnTracker;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export interface ReconcileSummary {
  at: number;
  orphans: OrphanEntry[];
  counts: Record<OrphanKind, number>;
}

/**
 * Boot-time sweep: find every in-flight record left behind by the restart,
 * mark it interrupted, and file an orphan entry per item. Safe to run on
 * every boot (idempotent — only non-terminal records match).
 */
export function reconcileOnBoot(deps: ReconcileDeps): ReconcileSummary {
  const ledger = new OrphanLedger(deps.dataDir);
  const orphans: OrphanEntry[] = [];
  try {
    // Routine runs: query the stuck ones first, then mark them failed.
    const stuck = deps.listStuckRoutineRuns();
    deps.reconcileRoutineRuns();
    for (const r of stuck) {
      orphans.push(
        ledger.file({
          kind: 'routine-run',
          refId: r.id,
          label: `Routine "${r.routineName}" ${INTERRUPTED_NOTE}`,
          context: { routineId: r.routineId, retryUrl: `/api/routines/${r.routineId}/runs/${r.id}/retry` },
        }),
      );
    }
    // Team runs.
    for (const t of deps.listRunningTeamRuns()) {
      try {
        deps.markTeamRunInterrupted(t.runId);
      } catch {
        // keep filing the orphan even if marking failed
      }
      orphans.push(
        ledger.file({
          kind: 'team-run',
          refId: t.runId,
          label: `Team run "${t.teamName}" ${INTERRUPTED_NOTE}`,
          context: { teamId: t.teamId, task: t.task, retryUrl: `/api/teams/${t.teamId}/runs/${t.runId}/retry` },
        }),
      );
    }
    // Group goals: park as blocked → existing resume endpoint restarts them.
    for (const g of deps.listRunningGroupGoals()) {
      try {
        deps.markGroupGoalInterrupted(g.goalId);
      } catch {
        // keep filing
      }
      orphans.push(
        ledger.file({
          kind: 'group-goal',
          refId: g.goalId,
          label: `Group goal "${g.title}" ${INTERRUPTED_NOTE}`,
          context: { goalId: g.goalId, resumeUrl: `/api/group-goals/${g.goalId}/resume` },
        }),
      );
    }
    // Chat turns: rows the dead process left in the tracker.
    for (const t of deps.turnTracker.listActive()) {
      orphans.push(
        ledger.file({
          kind: 'chat-turn',
          refId: t.sessionId,
          label: `Chat turn in "${t.sessionId.slice(0, 12)}…" ${INTERRUPTED_NOTE}`,
          context: { sessionId: t.sessionId, botId: t.botId, message: t.message },
        }),
      );
      deps.turnTracker.endTurn(t.sessionId);
    }
  } finally {
    ledger.close();
  }
  const counts: Record<OrphanKind, number> = { 'chat-turn': 0, 'team-run': 0, 'group-goal': 0, 'routine-run': 0 };
  for (const o of orphans) counts[o.kind] += 1;
  deps.audit('recovery.reconciled', { actor: 'system', detail: { counts, total: orphans.length } });
  return { at: Date.now(), orphans, counts };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface CrashRecoveryRouterDeps {
  dataDir: string;
  /**
   * Restart an interrupted team run with the same task. Wired by the host
   * to the teams machinery (POST /api/teams/:id/runs/:runId/retry).
   */
  retryTeamRun: (teamId: string, runId: string) => Promise<{ ok: boolean; newRunId?: string; error?: string }>;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function createCrashRecoveryRouter(deps: CrashRecoveryRouterDeps): Router {
  const router = express.Router();

  router.get('/orphans', (_req, res) => {
    const ledger = new OrphanLedger(deps.dataDir);
    try {
      res.json({ ok: true, orphans: ledger.listPending() });
    } finally {
      ledger.close();
    }
  });

  router.post('/orphans/:id/resume', async (req, res) => {
    const ledger = new OrphanLedger(deps.dataDir);
    try {
      const orphan = ledger.get(req.params.id);
      if (!orphan) {
        res.status(404).json(errorBody('Unknown or dismissed orphan'));
        return;
      }
      if (orphan.kind === 'chat-turn') {
        // The UI's Resume button re-sends the last user message through the
        // normal chat pipeline — the server just hands back the context.
        ledger.resolve(orphan.id);
        deps.audit('recovery.resumed', { actor: 'api', detail: { kind: orphan.kind, refId: orphan.refId } });
        res.json({
          ok: true,
          kind: orphan.kind,
          sessionId: orphan.context.sessionId,
          botId: orphan.context.botId,
          message: orphan.context.message,
          note: 'Re-send this message through POST /api/chat to resume the turn.',
        });
        return;
      }
      if (orphan.kind === 'team-run') {
        const teamId = String(orphan.context.teamId ?? '');
        const result = await deps.retryTeamRun(teamId, orphan.refId);
        if (!result.ok) {
          res.status(502).json(errorBody('Could not restart the team run', result.error));
          return;
        }
        ledger.resolve(orphan.id);
        deps.audit('recovery.resumed', { actor: 'api', detail: { kind: orphan.kind, refId: orphan.refId, newRunId: result.newRunId } });
        res.json({ ok: true, kind: orphan.kind, newRunId: result.newRunId });
        return;
      }
      // group-goal + routine-run: the existing resume/retry endpoints own
      // the restart; hand the URL back and resolve the orphan.
      const url = typeof orphan.context.resumeUrl === 'string' ? orphan.context.resumeUrl : typeof orphan.context.retryUrl === 'string' ? orphan.context.retryUrl : undefined;
      ledger.resolve(orphan.id);
      deps.audit('recovery.resumed', { actor: 'api', detail: { kind: orphan.kind, refId: orphan.refId } });
      res.json({ ok: true, kind: orphan.kind, resumeUrl: url });
    } finally {
      ledger.close();
    }
  });

  router.post('/orphans/:id/dismiss', (req, res) => {
    const ledger = new OrphanLedger(deps.dataDir);
    try {
      if (!ledger.resolve(req.params.id)) {
        res.status(404).json(errorBody('Unknown or dismissed orphan'));
        return;
      }
      deps.audit('recovery.dismissed', { actor: 'api', detail: { orphanId: req.params.id } });
      res.json({ ok: true, dismissed: req.params.id });
    } finally {
      ledger.close();
    }
  });

  return router;
}
