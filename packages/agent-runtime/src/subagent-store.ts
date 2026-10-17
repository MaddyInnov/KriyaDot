// SPDX-License-Identifier: Apache-2.0

import type { TokenUsage } from './types.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
// (Same trick as sessions.ts — keep both in sync.)
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export type SubagentStatus = 'running' | 'done' | 'failed';

export interface SubagentRecord {
  id: string;
  /** The child subagent's own session id (used for depth walks). */
  sessionId: string;
  /** The session the delegate call originated from. */
  parentSessionId: string;
  parentBotId: string;
  task: string;
  status: SubagentStatus;
  createdAt: string;
  finishedAt: string | null;
  /** Serialized TokenUsage once finished, null while running. */
  usageJson: string | null;
}

interface SubagentRow {
  id: string;
  session_id: string;
  parent_session_id: string;
  parent_bot_id: string;
  task: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  usage_json: string | null;
}

function newId(): string {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowToRecord(row: SubagentRow): SubagentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    parentBotId: row.parent_bot_id,
    task: row.task,
    status: row.status as SubagentStatus,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    usageJson: row.usage_json,
  };
}

/** Hard cap on ancestor-walk iterations in getDepth (corrupt cycles fail closed). */
const MAX_DEPTH_WALK = 100;

/**
 * SQLite-backed parent/child subagent tracking. Lives in its own file,
 * `<dataDir>/subagents.db`, so subagent bookkeeping never contends with the
 * session or governance databases.
 *
 * Records one row per spawned subagent: who spawned it (parentSessionId +
 * parentBotId), what it was asked to do (task), and its lifecycle
 * (running → done | failed). The child's own sessionId is stored so
 * getDepth() can walk the parent chain and enforce nesting limits.
 */
export class SubagentStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        parent_bot_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        usage_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents (parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents (session_id);
    `);
  }

  /** Insert a new `running` record for a subagent that is about to spawn. */
  spawnChild(input: {
    sessionId: string;
    parentSessionId: string;
    parentBotId: string;
    task: string;
  }): SubagentRecord {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO subagents
           (id, session_id, parent_session_id, parent_bot_id, task, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.parentSessionId,
        input.parentBotId,
        input.task,
        new Date().toISOString(),
      );
    const rec = this.get(id);
    if (!rec) throw new Error('SubagentStore.spawnChild: failed to read back inserted record');
    return rec;
  }

  /** Mark a subagent finished. Terminal: only `running` rows may transition. */
  finish(id: string, status: 'done' | 'failed', usage?: TokenUsage): void {
    const info = this.db
      .prepare(
        `UPDATE subagents SET status = ?, finished_at = ?, usage_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        status,
        new Date().toISOString(),
        usage ? JSON.stringify(usage) : null,
        id,
      );
    if (info.changes === 0) {
      throw new Error(`SubagentStore.finish: no running subagent with id "${id}"`);
    }
  }

  get(id: string): SubagentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM subagents WHERE id = ?')
      .get(id) as SubagentRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getBySessionId(sessionId: string): SubagentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM subagents WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as SubagentRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  listByParent(parentSessionId: string): SubagentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM subagents WHERE parent_session_id = ? ORDER BY created_at ASC')
      .all(parentSessionId) as unknown as SubagentRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Nesting depth of a session: 0 for a normal (non-subagent) session,
   * 1 for a subagent spawned directly from one, 2 for a sub-subagent, …
   * Walks parent_session_id links; a cycle or absurd chain fails closed at
   * MAX_DEPTH_WALK by treating the session as maximally deep (blocked).
   */
  getDepth(sessionId: string): number {
    let depth = 0;
    let current: string | undefined = sessionId;
    let hops = 0;
    while (current && hops < MAX_DEPTH_WALK) {
      const rec = this.getBySessionId(current);
      if (!rec) break;
      depth += 1;
      current = rec.parentSessionId;
      hops += 1;
    }
    if (hops >= MAX_DEPTH_WALK) return MAX_DEPTH_WALK;
    return depth;
  }

  close(): void {
    this.db.close();
  }
}
