// SPDX-License-Identifier: Apache-2.0
// Limit-reset resumes (W1) — persistent pending resumes for work blocked
// by a provider usage limit.
//
// When a turn or routine is blocked by a hard limit, a resume can be
// scheduled for the provider's reset time (from the error's reset /
// retry-after signal, else a configurable default backoff — see
// computeResumeAtMs in @mvp/agent-runtime). Resumes live in
// <dataDir>/limit-reset-resumes.db (node:sqlite) so they survive restart;
// on boot the scheduler reconciles them: still-pending resumes stay
// pending, due ones fire, and ones left in 'firing' by a crash return to
// 'pending' so they are not lost.
//
// Lifecycle: pending -> firing -> fired | cancelled. A resume fires the
// owning routine's turn (via the routine run executor, trigger
// 'schedule'); standalone resumes (no routine) record a bot + message so
// a host callback can run the turn.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';

export type LimitResetResumeStatus = 'pending' | 'firing' | 'fired' | 'cancelled';

export interface LimitResetResume {
  id: string;
  /** Owning routine, when the blocked work was a routine. */
  routineId?: string;
  /** Bot whose work was blocked. */
  botId: string;
  /** Provider that hit the limit. */
  providerId: string;
  /** Prompt/message to re-run on resume (routine resumes re-render the template instead). */
  message?: string;
  /** Epoch ms when the resume should fire (provider reset time). */
  resumeAt: number;
  /** Why it was scheduled (error summary — never carries credentials). */
  reason: string;
  status: LimitResetResumeStatus;
  createdAt: number;
  firedAt?: number;
}

interface ResumeRow {
  id: string;
  routine_id: string | null;
  bot_id: string;
  provider_id: string;
  message: string | null;
  resume_at: number;
  reason: string;
  status: string;
  created_at: number;
  fired_at: number | null;
}

function rowToResume(r: ResumeRow): LimitResetResume {
  return {
    id: r.id,
    routineId: r.routine_id ?? undefined,
    botId: r.bot_id,
    providerId: r.provider_id,
    message: r.message ?? undefined,
    resumeAt: r.resume_at,
    reason: r.reason,
    status: r.status as LimitResetResumeStatus,
    createdAt: r.created_at,
    firedAt: r.fired_at ?? undefined,
  };
}

function openDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = openSqliteDb(join(dataDir, 'limit-reset-resumes.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS limit_reset_resumes (
      id TEXT PRIMARY KEY,
      routine_id TEXT,
      bot_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      message TEXT,
      resume_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      fired_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_limit_resumes_status ON limit_reset_resumes(status, resume_at);
    CREATE INDEX IF NOT EXISTS idx_limit_resumes_routine ON limit_reset_resumes(routine_id);
  `);
  return db;
}

export class LimitResetResumeStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  schedule(input: {
    routineId?: string;
    botId: string;
    providerId: string;
    message?: string;
    resumeAt: number;
    reason: string;
  }): LimitResetResume {
    if (!Number.isFinite(input.resumeAt)) throw new Error('resumeAt must be a finite epoch-ms time');
    const resume: LimitResetResume = {
      id: randomUUID(),
      routineId: input.routineId,
      botId: input.botId,
      providerId: input.providerId,
      message: input.message,
      resumeAt: Math.floor(input.resumeAt),
      reason: String(input.reason ?? '').slice(0, 500),
      status: 'pending',
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO limit_reset_resumes (id, routine_id, bot_id, provider_id, message, resume_at, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        resume.id,
        resume.routineId ?? null,
        resume.botId,
        resume.providerId,
        resume.message ?? null,
        resume.resumeAt,
        resume.reason,
        resume.createdAt,
      );
    return resume;
  }

  get(id: string): LimitResetResume | undefined {
    const row = this.db.prepare('SELECT * FROM limit_reset_resumes WHERE id = ?').get(id) as unknown as ResumeRow | undefined;
    return row ? rowToResume(row) : undefined;
  }

  list(status?: LimitResetResumeStatus): LimitResetResume[] {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM limit_reset_resumes WHERE status = ? ORDER BY resume_at ASC').all(status)
        : this.db.prepare('SELECT * FROM limit_reset_resumes ORDER BY resume_at ASC').all()
    ) as unknown as ResumeRow[];
    return rows.map(rowToResume);
  }

  listByRoutine(routineId: string): LimitResetResume[] {
    const rows = this.db
      .prepare('SELECT * FROM limit_reset_resumes WHERE routine_id = ? ORDER BY resume_at ASC')
      .all(routineId) as unknown as ResumeRow[];
    return rows.map(rowToResume);
  }

  /** Pending resumes due at or before `nowMs`, oldest first. */
  duePending(nowMs: number): LimitResetResume[] {
    const rows = this.db
      .prepare(`SELECT * FROM limit_reset_resumes WHERE status = 'pending' AND resume_at <= ? ORDER BY resume_at ASC`)
      .all(nowMs) as unknown as ResumeRow[];
    return rows.map(rowToResume);
  }

  /** Atomically claim a pending resume for firing (pending -> firing). */
  claim(id: string): boolean {
    const r = this.db
      .prepare(`UPDATE limit_reset_resumes SET status = 'firing' WHERE id = ? AND status = 'pending'`)
      .run(id);
    return r.changes > 0;
  }

  markFired(id: string): void {
    this.db
      .prepare(`UPDATE limit_reset_resumes SET status = 'fired', fired_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  /** Return a claimed resume to pending (firing failed before it ran). */
  release(id: string): void {
    this.db
      .prepare(`UPDATE limit_reset_resumes SET status = 'pending' WHERE id = ? AND status = 'firing'`)
      .run(id);
  }

  cancel(id: string): boolean {
    const r = this.db
      .prepare(`UPDATE limit_reset_resumes SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'firing')`)
      .run(id);
    return r.changes > 0;
  }

  deleteByRoutine(routineId: string): void {
    this.db.prepare('DELETE FROM limit_reset_resumes WHERE routine_id = ?').run(routineId);
  }

  /**
   * Boot reconciliation: resumes left in 'firing' by a crash return to
   * 'pending' so the next tick fires them. Returns how many were recovered
   * plus how many pending resumes are already due.
   */
  reconcileOnBoot(nowMs = Date.now()): { recovered: number; due: number } {
    const r = this.db
      .prepare(`UPDATE limit_reset_resumes SET status = 'pending' WHERE status = 'firing'`)
      .run();
    return { recovered: Number(r.changes), due: this.duePending(nowMs).length };
  }
}
