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

/** CA-4 retention policy: keep the newest 100 checkpoints per session and
 * drop anything older than 30 days (Claude Code's published policy). */
export const MAX_CHECKPOINTS_PER_SESSION = 100;
export const MAX_CHECKPOINT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CheckpointFilePreview {
  path: string;
  /** Bytes of the snapshotted content; 0 when the file did not exist. */
  size: number;
  existed: boolean;
}

export interface CheckpointPreview {
  id: string;
  sessionId: string;
  createdAt: number;
  label: string;
  historyLength: number;
  files: CheckpointFilePreview[];
  totalBytes: number;
}

export interface SessionFileDiff {
  path: string;
  /** 'created' | 'modified' | 'deleted' relative to the first snapshot. */
  status: 'created' | 'modified' | 'deleted';
  added: number;
  removed: number;
  /** Number of checkpoints that touched this file. */
  touches: number;
}

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
    // Keep only the latest MAX_CHECKPOINTS_PER_SESSION per session (CA-4).
    this.db
      .prepare(
        `DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (
           SELECT id FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(cp.sessionId, cp.sessionId, MAX_CHECKPOINTS_PER_SESSION);
    return cp;
  }

  /**
   * CA-4 retention sweep: drop checkpoints older than 30 days (all
   * sessions) and trim every session to its newest 100. Returns how many
   * rows were removed. `now` is injectable for tests.
   */
  runRetention(now: number = Date.now()): { removedExpired: number; removedOverflow: number } {
    const cutoff = now - MAX_CHECKPOINT_AGE_MS;
    const expired = this.db.prepare('DELETE FROM checkpoints WHERE created_at < ?').run(cutoff);
    const sessions = this.db
      .prepare('SELECT DISTINCT session_id AS sessionId FROM checkpoints')
      .all() as unknown as Array<{ sessionId: string }>;
    let overflow = 0;
    for (const { sessionId } of sessions) {
      const res = this.db
        .prepare(
          `DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (
             SELECT id FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
           )`,
        )
        .run(sessionId, sessionId, MAX_CHECKPOINTS_PER_SESSION);
      overflow += Number(res.changes);
    }
    return { removedExpired: Number(expired.changes), removedOverflow: overflow };
  }

  /** Lightweight preview for one checkpoint: file list + sizes (no contents). */
  preview(id: string): CheckpointPreview | undefined {
    const cp = this.get(id);
    if (!cp) return undefined;
    return previewCheckpoint(cp);
  }

  /** Every checkpoint for a session, oldest first (diff aggregation input). */
  listChronological(sessionId: string, limit = 500): Checkpoint[] {
    const rows = this.db
      .prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(sessionId, limit) as unknown as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  /** One file's snapshotted content from a checkpoint (per-file restore). */
  fileContent(id: string, path: string): { found: boolean; content: string | null } {
    const cp = this.get(id);
    if (!cp || !(path in cp.files)) return { found: false, content: null };
    return { found: true, content: cp.files[path] ?? null };
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

/** CA-4: module-level retention entry point (host scheduler seam). */
export function runCheckpointRetention(store: CheckpointStore, now: number = Date.now()): { removedExpired: number; removedOverflow: number } {
  return store.runRetention(now);
}

/** Preview shape for one checkpoint: paths + byte sizes, never contents. */
export function previewCheckpoint(cp: Checkpoint): CheckpointPreview {
  const files: CheckpointFilePreview[] = Object.entries(cp.files)
    .map(([path, content]) => ({
      path,
      size: content === null ? 0 : Buffer.byteLength(content, 'utf-8'),
      existed: content !== null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    id: cp.id,
    sessionId: cp.sessionId,
    createdAt: cp.createdAt,
    label: cp.label,
    historyLength: cp.historyLength,
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
  };
}

/**
 * Line-level +/- counts between two texts via an LCS over lines.
 * Falls back to a multiset count for very large inputs so a pathological
 * file can never make the review surface hang.
 */
export function diffLineCounts(before: string | null, after: string | null): { added: number; removed: number } {
  const a = before === null ? [] : before === '' ? [] : before.split('\n');
  const b = after === null ? [] : after === '' ? [] : after.split('\n');
  if (a.length * b.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const n = counts.get(line) ?? 0;
      if (n > 0) {
        common += 1;
        counts.set(line, n - 1);
      }
    }
    return { added: b.length - common, removed: a.length - common };
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { added: b.length - common, removed: a.length - common };
}

/**
 * CA-30: aggregate a session's checkpoint snapshots into a per-file review
 * list. For each file, the earliest snapshot is the "before" and the
 * current on-disk content (via `readCurrent`, null = gone) is the "after".
 * Files whose current content matches the first snapshot are omitted.
 */
export function aggregateSessionDiff(
  checkpoints: Checkpoint[],
  readCurrent: (path: string) => string | null,
): SessionFileDiff[] {
  const firstBefore = new Map<string, string | null>();
  const touches = new Map<string, number>();
  const ordered = [...checkpoints].sort((x, y) => x.createdAt - y.createdAt);
  for (const cp of ordered) {
    for (const [path, content] of Object.entries(cp.files)) {
      if (!firstBefore.has(path)) firstBefore.set(path, content);
      touches.set(path, (touches.get(path) ?? 0) + 1);
    }
  }
  const out: SessionFileDiff[] = [];
  for (const [path, before] of firstBefore) {
    const after = readCurrent(path);
    if (after === before) continue;
    const { added, removed } = diffLineCounts(before, after);
    const status: SessionFileDiff['status'] = before === null ? 'created' : after === null ? 'deleted' : 'modified';
    out.push({ path, status, added, removed, touches: touches.get(path) ?? 1 });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
