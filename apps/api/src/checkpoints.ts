// SPDX-License-Identifier: Apache-2.0
// Checkpoints / rewind — Claude Code's Esc+Esc safety net.
//
// Before every file-mutating tool call (write_file, edit_file), the runtime
// snapshots the file's current content. A checkpoint captures:
//   - the file snapshots for one turn (path → content before the edit)
//   - the conversation length (for conversation rewind)
// Restore modes: 'code' (restore files only), 'conversation' (truncate
// history only), 'both'.
//
// Storage: <dataDir>/checkpoints.db (node:sqlite).

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from '@mvp/agent-runtime';

export type RestoreMode = 'code' | 'conversation' | 'both';

export interface Checkpoint {
  id: string;
  sessionId: string;
  createdAt: number;
  /** path → content BEFORE the edit (null = file did not exist). */
  files: Record<string, string | null>;
  /** Number of messages in session history when the checkpoint was taken. */
  historyLength: number;
  /** Human-readable label (e.g. "before edit_file src/app.ts"). */
  label: string;
}

interface CheckpointRow {
  id: string;
  session_id: string;
  created_at: number;
  files_json: string;
  history_length: number;
  label: string;
}

function rowToCheckpoint(r: CheckpointRow): Checkpoint {
  return {
    id: r.id,
    sessionId: r.session_id,
    createdAt: r.created_at,
    files: JSON.parse(r.files_json) as Record<string, string | null>,
    historyLength: r.history_length,
    label: r.label,
  };
}

export class CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'checkpoints.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        files_json TEXT NOT NULL,
        history_length INTEGER NOT NULL,
        label TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at DESC);
    `);
  }

  create(input: {
    sessionId: string;
    files: Record<string, string | null>;
    historyLength: number;
    label: string;
  }): Checkpoint {
    const cp: Checkpoint = {
      id: randomUUID(),
      sessionId: input.sessionId,
      createdAt: Date.now(),
      files: input.files,
      historyLength: input.historyLength,
      label: input.label,
    };
    this.db
      .prepare(
        'INSERT INTO checkpoints (id, session_id, created_at, files_json, history_length, label) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(cp.id, cp.sessionId, cp.createdAt, JSON.stringify(cp.files), cp.historyLength, cp.label);
    // Keep only the latest 50 per session.
    this.db
      .prepare(
        `DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (
           SELECT id FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 50
         )`,
      )
      .run(cp.sessionId, cp.sessionId);
    return cp;
  }

  list(sessionId: string, limit = 20): Checkpoint[] {
    const rows = this.db
      .prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit) as unknown as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  get(id: string): Checkpoint | undefined {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as unknown as
      | CheckpointRow
      | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }
}
