// SPDX-License-Identifier: Apache-2.0
// Slack-style reply threads on chat messages.
//
//   POST /                          { rootMessageId, rootClientId? } → new thread
//   GET  /                                                   → thread summaries
//   GET  /:threadId                                          → thread messages
//   POST /:threadId/read                                     → mark thread read
//   POST /:threadId/reply           { content } → { threadSessionId }
//
// A "reply thread" is a set of messages anchored to a root message in the
// main chat. Threads are flat (one level — a reply cannot start a thread),
// following Codync's model.
//
// Implementation: creating a thread forks the agent session at the root
// message via branchSession (the same mechanism as chat branching), so the
// thread's agent context starts from everything said up to the root.
// Thread replies are then normal chat turns against the forked session —
// the client sends them via POST /api/chat with sessionId=threadSessionId.
// Nothing said in a thread reaches the main chat's session.
//
// Thread metadata lives in <dataDir>/message-threads.db (separate from the
// agent-runtime session store, so no schema migration is needed there).
//
// Read state (Slack's model): the main chat and each thread are read
// separately. Opening a thread (or replying in it) marks it read. The
// thread summary under a root shows the reply count and unread count.
//
// HOST WIRING (index.ts):
//   import { createMessageThreadsRouter } from './message-threads-routes.js';
//   app.use('/api/chat/:sessionId/message-threads', createMessageThreadsRouter({
//     dataDir: config.dataDir,
//     branchSession: (id, msgId, opts) => agentRuntime.branchSession(id, msgId, opts),
//     listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
//     audit: (action, fields) => governance.audit(action, fields),
//   }));
//
// API CONTRACT NOTES (for the group-chats task):
// - threadId format: `thr_<base36time>_<rand>` (opaque string, not numeric).
// - A thread's messages come from its forked session via listThreadMessages.
// - The reply endpoint returns { threadSessionId }; the client drives the
//   agent turn through the normal POST /api/chat SSE stream. This keeps
//   one code path for turns (approvals, queueing, telemetry all apply).
// - Group chats (next task) can reuse this router by anchoring threads to
//   group-lane messages; the lane concept maps to threadId here.

import express, { type Router } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BranchSessionResult, IdentifiedMessage } from '@mvp/agent-runtime';

import { openDb } from '@mvp/agent-runtime';

export interface MessageThread {
  id: string;
  sessionId: string;
  threadSessionId: string;
  rootMessageId: number;
  rootClientId: string | null;
  createdAt: string;
}

export interface ThreadSummary extends MessageThread {
  replyCount: number;
  lastReplyAt: string | null;
  unread: boolean;
}

export interface MessageThreadsDeps {
  dataDir: string;
  branchSession: (
    sessionId: string,
    fromMessageId: number,
    opts?: { botId?: string },
  ) => BranchSessionResult | Promise<BranchSessionResult>;
  listThreadMessages: (sessionId: string) => IdentifiedMessage[] | Promise<IdentifiedMessage[]>;
  audit: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function newThreadId(): string {
  return `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Persistent reply-thread metadata: <dataDir>/message-threads.db. */
export class MessageThreadStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'message-threads.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        thread_session_id TEXT NOT NULL,
        root_message_id INTEGER NOT NULL,
        root_client_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
      CREATE TABLE IF NOT EXISTS thread_read (
        thread_id TEXT PRIMARY KEY,
        last_read_at TEXT NOT NULL
      );
    `);
  }

  createThread(
    sessionId: string,
    threadSessionId: string,
    rootMessageId: number,
    rootClientId?: string,
  ): MessageThread {
    const id = newThreadId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO threads (thread_id, session_id, thread_session_id, root_message_id, root_client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, threadSessionId, rootMessageId, rootClientId ?? null, createdAt);
    // Creating a thread counts as reading it (the creator just opened it).
    this.db
      .prepare(`INSERT OR REPLACE INTO thread_read (thread_id, last_read_at) VALUES (?, ?)`)
      .run(id, createdAt);
    return {
      id,
      sessionId,
      threadSessionId,
      rootMessageId,
      rootClientId: rootClientId ?? null,
      createdAt,
    };
  }

  getThread(threadId: string): MessageThread | null {
    const row = this.db
      .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
      .get(threadId) as
      | {
          thread_id: string;
          session_id: string;
          thread_session_id: string;
          root_message_id: number;
          root_client_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.thread_id,
      sessionId: row.session_id,
      threadSessionId: row.thread_session_id,
      rootMessageId: row.root_message_id,
      rootClientId: row.root_client_id,
      createdAt: row.created_at,
    };
  }

  /** All threads anchored in a session, newest first. */
  listThreads(sessionId: string): MessageThread[] {
    const rows = this.db
      .prepare(`SELECT * FROM threads WHERE session_id = ? ORDER BY created_at DESC`)
      .all(sessionId) as Array<{
      thread_id: string;
      session_id: string;
      thread_session_id: string;
      root_message_id: number;
      root_client_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.thread_id,
      sessionId: row.session_id,
      threadSessionId: row.thread_session_id,
      rootMessageId: row.root_message_id,
      rootClientId: row.root_client_id,
      createdAt: row.created_at,
    }));
  }

  /** Find the thread anchored to a root message, if any. */
  findByRoot(sessionId: string, rootMessageId: number): MessageThread | null {
    const row = this.db
      .prepare(`SELECT * FROM threads WHERE session_id = ? AND root_message_id = ? LIMIT 1`)
      .get(sessionId, rootMessageId) as
      | {
          thread_id: string;
          session_id: string;
          thread_session_id: string;
          root_message_id: number;
          root_client_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.thread_id,
      sessionId: row.session_id,
      threadSessionId: row.thread_session_id,
      rootMessageId: row.root_message_id,
      rootClientId: row.root_client_id,
      createdAt: row.created_at,
    };
  }

  markRead(threadId: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO thread_read (thread_id, last_read_at) VALUES (?, ?)`)
      .run(threadId, new Date().toISOString());
  }

  lastReadAt(threadId: string): string | null {
    const row = this.db
      .prepare(`SELECT last_read_at FROM thread_read WHERE thread_id = ?`)
      .get(threadId) as { last_read_at: string } | undefined;
    return row?.last_read_at ?? null;
  }

  close(): void {
    this.db.close();
  }
}

export function createMessageThreadsRouter(deps: MessageThreadsDeps): Router {
  const router = express.Router({ mergeParams: true });
  const store = new MessageThreadStore(deps.dataDir);

  const sessionIdOf = (req: express.Request): string => req.params.sessionId as string;

  /** Create a thread anchored to a root message. Forks the session. */
  router.post('/', async (req, res) => {
    const sessionId = sessionIdOf(req);
    const { rootMessageId, rootClientId, botId } = (req.body ?? {}) as {
      rootMessageId?: number;
      rootClientId?: string;
      botId?: string;
    };
    if (typeof rootMessageId !== 'number' || !Number.isInteger(rootMessageId)) {
      res.status(400).json(errorBody('rootMessageId (integer) is required'));
      return;
    }
    // Idempotent: a root already has a thread → return it.
    const existing = store.findByRoot(sessionId, rootMessageId);
    if (existing) {
      res.json({ ok: true, thread: existing, created: false });
      return;
    }
    let result: BranchSessionResult;
    try {
      result = await deps.branchSession(sessionId, rootMessageId, botId ? { botId } : undefined);
    } catch (err) {
      res.status(500).json(errorBody('Failed to fork session for thread', String(err)));
      return;
    }
    if (!result.ok) {
      const status = result.reason === 'thread-not-found' ? 404 : 400;
      res.status(status).json(errorBody(`Cannot create thread: ${result.reason}`));
      return;
    }
    const thread = store.createThread(
      sessionId,
      result.session.id,
      rootMessageId,
      rootClientId,
    );
    deps.audit('message-thread.create', {
      sessionId,
      detail: { threadId: thread.id, rootMessageId, copiedMessages: result.copiedMessages },
    });
    res.status(201).json({ ok: true, thread, created: true });
  });

  /** List thread summaries for a session (counts + unread flags). */
  router.get('/', async (req, res) => {
    const sessionId = sessionIdOf(req);
    const threads = store.listThreads(sessionId);
    const summaries: ThreadSummary[] = [];
    for (const thread of threads) {
      let messages: IdentifiedMessage[] = [];
      try {
        messages = await deps.listThreadMessages(thread.threadSessionId);
      } catch {
        // A missing thread session degrades to an empty summary, not a 500.
      }
      const lastReadAt = store.lastReadAt(thread.id);
      // Replies are messages beyond what the fork copied; approximate by
      // counting messages newer than the thread's creation.
      const replies = messages.filter((m) => m.ts > thread.createdAt);
      const lastReplyAt = replies.length > 0 ? replies[replies.length - 1].ts : null;
      summaries.push({
        ...thread,
        replyCount: replies.length,
        lastReplyAt,
        unread: lastReplyAt !== null && (lastReadAt === null || lastReplyAt > lastReadAt),
      });
    }
    res.json({ ok: true, threads: summaries });
  });

  /** Get a thread's messages (root context lives in the forked session). */
  router.get('/:threadId', async (req, res) => {
    const sessionId = sessionIdOf(req);
    const thread = store.getThread(req.params.threadId as string);
    if (!thread || thread.sessionId !== sessionId) {
      res.status(404).json(errorBody('Thread not found'));
      return;
    }
    let messages: IdentifiedMessage[];
    try {
      messages = await deps.listThreadMessages(thread.threadSessionId);
    } catch (err) {
      res.status(500).json(errorBody('Failed to list thread messages', String(err)));
      return;
    }
    // Tag messages with thread membership for clients.
    const tagged = messages.map((m) => ({
      ...m,
      threadId: thread.id,
      threadRootId: thread.rootClientId,
    }));
    res.json({ ok: true, thread, messages: tagged });
  });

  /** Mark a thread as read. */
  router.post('/:threadId/read', (req, res) => {
    const sessionId = sessionIdOf(req);
    const thread = store.getThread(req.params.threadId as string);
    if (!thread || thread.sessionId !== sessionId) {
      res.status(404).json(errorBody('Thread not found'));
      return;
    }
    store.markRead(thread.id);
    res.json({ ok: true });
  });

  /**
   * Reply in a thread. Validates the thread and returns its forked
   * session id; the client then drives the agent turn through the normal
   * POST /api/chat SSE stream with sessionId=threadSessionId. This keeps
   * a single turn code path (approvals, queueing, telemetry).
   */
  router.post('/:threadId/reply', (req, res) => {
    const sessionId = sessionIdOf(req);
    const thread = store.getThread(req.params.threadId as string);
    if (!thread || thread.sessionId !== sessionId) {
      res.status(404).json(errorBody('Thread not found'));
      return;
    }
    const { content } = (req.body ?? {}) as { content?: string };
    if (typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json(errorBody('content (non-empty string) is required'));
      return;
    }
    // Replying reads the thread.
    store.markRead(thread.id);
    deps.audit('message-thread.reply', {
      sessionId,
      detail: { threadId: thread.id },
    });
    res.json({ ok: true, threadId: thread.id, threadSessionId: thread.threadSessionId });
  });

  return router;
}
