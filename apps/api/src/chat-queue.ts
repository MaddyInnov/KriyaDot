// SPDX-License-Identifier: Apache-2.0
// Queue-at-boundary steering — Claude Code-style message queue.
//
// When a turn is in-flight on a session and the user sends another message
// with `queueMode: 'queue'`, the message is persisted here instead of
// aborting the current turn. When the turn completes, the route drains the
// queue FIFO on the same SSE stream. Survives restarts (SQLite).
//
// Storage: <dataDir>/chat-queue.db (node:sqlite).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from '@mvp/agent-runtime';

export type QueuedMessageStatus = 'queued' | 'started';

/**
 * L6: per-session queue bounds. A runaway client (or a stuck turn) must not
 * grow one session's queue without limit, and a queued message obeys the
 * same size bound as a direct /chat message (L5).
 */
export const MAX_QUEUE_DEPTH_PER_SESSION = 50;
export const MAX_QUEUED_MESSAGE_CHARS = 200_000;

/** Error from enqueue() carrying the HTTP status the route should return. */
export class ChatQueueError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ChatQueueError';
  }
}

export interface QueuedMessage {
  id: string;
  sessionId: string;
  botId: string;
  message: string;
  /**
   * Co-driving (#173): the writer who sent this message when several
   * writers share one live session, and whether it was sent as a
   * co-driver message (drained as that writer's own turn, attributed
   * to them) rather than an anonymous queue entry. Absent on rows
   * written before co-driving existed.
   */
  writerId?: string;
  codrive?: boolean;
  provider?: string;
  model?: string;
  taskType?: 'code' | 'chat' | 'reasoning' | 'simple-qa';
  autoApprove?: boolean;
  planMode?: boolean;
  maxBudgetUsd?: number;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  status: QueuedMessageStatus;
  createdAt: number;
}

export interface EnqueueInput {
  sessionId: string;
  botId: string;
  message: string;
  /** Co-driving writer attribution (#173); see QueuedMessage. */
  writerId?: string;
  codrive?: boolean;
  provider?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  fileIds?: string[];
  taskType?: 'code' | 'chat' | 'reasoning' | 'simple-qa';
  autoApprove?: boolean;
  planMode?: boolean;
  maxBudgetUsd?: number;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

interface QueueRow {
  id: string;
  session_id: string;
  bot_id: string;
  message: string;
  provider: string | null;
  model: string | null;
  task_type: string | null;
  auto_approve: number;
  plan_mode: number;
  max_budget_usd: number | null;
  sandbox_mode: string | null;
  status: string;
  created_at: number;
  writer_id: string | null;
  codrive: number | null;
}

function rowToQueued(r: QueueRow): QueuedMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    botId: r.bot_id,
    message: r.message,
    provider: r.provider ?? undefined,
    model: r.model ?? undefined,
    taskType: (r.task_type as QueuedMessage['taskType']) ?? undefined,
    autoApprove: r.auto_approve === 1 || undefined,
    planMode: r.plan_mode === 1 || undefined,
    maxBudgetUsd: r.max_budget_usd ?? undefined,
    sandboxMode: (r.sandbox_mode as QueuedMessage['sandboxMode']) ?? undefined,
    status: r.status as QueuedMessageStatus,
    createdAt: r.created_at,
    writerId: r.writer_id ?? undefined,
    codrive: r.codrive === 1 || undefined,
  };
}

export class ChatQueueStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'chat-queue.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        message TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        task_type TEXT,
        auto_approve INTEGER NOT NULL DEFAULT 0,
        plan_mode INTEGER NOT NULL DEFAULT 0,
        max_budget_usd REAL,
        sandbox_mode TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL,
        writer_id TEXT,
        codrive INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chat_queue_session ON chat_queue (session_id, status, created_at);
    `);
    // Co-driving columns (#173) for databases created before they
    // existed: additive migration, ignored when already present.
    for (const ddl of [
      `ALTER TABLE chat_queue ADD COLUMN writer_id TEXT`,
      `ALTER TABLE chat_queue ADD COLUMN codrive INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Column already exists — nothing to migrate.
      }
    }
  }

  /** Enqueue a message. Returns the id and 1-based position in the session queue. */
  enqueue(input: EnqueueInput): { id: string; position: number } {
    if (input.message.length > MAX_QUEUED_MESSAGE_CHARS) {
      throw new ChatQueueError(`message exceeds ${MAX_QUEUED_MESSAGE_CHARS} characters`, 400);
    }
    if (this.countForSession(input.sessionId) >= MAX_QUEUE_DEPTH_PER_SESSION) {
      throw new ChatQueueError(
        `session queue is full (${MAX_QUEUE_DEPTH_PER_SESSION} pending messages)`,
        429,
      );
    }
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO chat_queue
         (id, session_id, bot_id, message, provider, model, task_type, auto_approve, plan_mode, max_budget_usd, sandbox_mode, status, created_at, writer_id, codrive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.botId,
        input.message,
        input.provider ?? null,
        input.model ?? null,
        input.taskType ?? null,
        input.autoApprove ? 1 : 0,
        input.planMode ? 1 : 0,
        input.maxBudgetUsd ?? null,
        input.sandboxMode ?? null,
        now,
        input.writerId ?? null,
        input.codrive ? 1 : 0,
      );
    const position = this.countForSession(input.sessionId);
    return { id, position };
  }

  /** Next queued (FIFO) message for a session, or undefined. */
  nextForSession(sessionId: string): QueuedMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM chat_queue WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1`,
      )
      .get(sessionId) as unknown as QueueRow | undefined;
    return row ? rowToQueued(row) : undefined;
  }

  /** Mark a message as started (dequeues it from the pending list). */
  markStarted(id: string): void {
    this.db.prepare(`UPDATE chat_queue SET status = 'started' WHERE id = ?`).run(id);
  }

  /** Remove a queued message. Returns true if it existed. */
  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM chat_queue WHERE id = ?`).run(id).changes > 0;
  }

  /** List queued messages, optionally filtered by session. */
  list(sessionId?: string): QueuedMessage[] {
    const rows = sessionId
      ? (this.db
          .prepare(`SELECT * FROM chat_queue WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC`)
          .all(sessionId) as unknown as QueueRow[])
      : (this.db
          .prepare(`SELECT * FROM chat_queue WHERE status = 'queued' ORDER BY created_at ASC`)
          .all() as unknown as QueueRow[]);
    return rows.map(rowToQueued);
  }

  /** Count of queued messages for a session (for position reporting). */
  countForSession(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM chat_queue WHERE session_id = ? AND status = 'queued'`)
      .get(sessionId) as unknown as { n: number };
    return row.n;
  }

  /** Distinct co-driving writers with queued messages on a session (#173). */
  writersForSession(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT writer_id FROM chat_queue WHERE session_id = ? AND status = 'queued' AND writer_id IS NOT NULL ORDER BY writer_id ASC`,
      )
      .all(sessionId) as unknown as Array<{ writer_id: string }>;
    return rows.map((r) => r.writer_id);
  }

  /** Reset stale 'started' rows to 'queued' (e.g. from a crashed turn) on boot. */
  resetStarted(): void {
    this.db.prepare(`UPDATE chat_queue SET status = 'queued' WHERE status = 'started'`).run();
  }
}
