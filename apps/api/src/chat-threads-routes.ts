// SPDX-License-Identifier: Apache-2.0
// Chat thread branching.
//
//   POST /:threadId/branch   { fromMessageId, title?, botId? } → new thread
//   GET  /:threadId/messages → verbatim message log with stable ids
//
// A "thread" is a chat session in the agent-runtime SessionStore. Branching
// creates a new session for the same bot and copies the source thread's
// history up to and including `fromMessageId` (a message id from
// GET /:threadId/messages), so the user can explore an alternate line of
// questioning from any point in a conversation without losing the original.
//
// Thread titles live in <dataDir>/chat-threads.db (the sessions table has
// no title column). Branches are titled "Branch of <original>" unless the
// caller passes an explicit `title`.
//
// HOST WIRING (index.ts — this module is not mounted by itself):
//   import { createChatThreadsRouter } from './chat-threads-routes.js';
//   app.use('/api/chat/threads', createChatThreadsRouter({
//     dataDir: config.dataDir,
//     branchSession: (id, msgId, opts) => agentRuntime.branchSession(id, msgId, opts),
//     listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BranchSessionResult, IdentifiedMessage } from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export interface ChatThreadsDeps {
  dataDir: string;
  /** Branch implementation — AgentRuntime.branchSession in production. */
  branchSession: (
    sessionId: string,
    fromMessageId: number,
    opts?: { botId?: string },
  ) => BranchSessionResult | Promise<BranchSessionResult>;
  /** Verbatim message log — AgentRuntime.listThreadMessages in production. */
  listThreadMessages: (sessionId: string) => IdentifiedMessage[] | Promise<IdentifiedMessage[]>;
  audit: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
  /**
   * Shared title store (optional). When omitted the router creates its own
   * against dataDir. Pass a shared instance when another router (e.g.
   * message search) needs the same titles.
   */
  titles?: ThreadTitleStore;
}

/** One thread's branch metadata. */
export interface ThreadInfo {
  threadId: string;
  title: string;
  branchedFrom: string | null;
  createdAt: number;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

/** Persistent thread titles: <dataDir>/chat-threads.db. */
export class ThreadTitleStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'chat-threads.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_titles (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        branched_from TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  getTitle(threadId: string): string | undefined {
    const row = this.db
      .prepare('SELECT title FROM thread_titles WHERE thread_id = ?')
      .get(threadId) as { title: string } | undefined;
    return row?.title;
  }

  /** Branch metadata for one thread (undefined when never titled/branched). */
  getThread(threadId: string): ThreadInfo | undefined {
    const row = this.db
      .prepare('SELECT thread_id AS threadId, title, branched_from AS branchedFrom, created_at AS createdAt FROM thread_titles WHERE thread_id = ?')
      .get(threadId) as ThreadInfo | undefined;
    return row ?? undefined;
  }

  /** Direct children: threads branched straight from `threadId`. */
  getChildren(threadId: string): ThreadInfo[] {
    return this.db
      .prepare(
        'SELECT thread_id AS threadId, title, branched_from AS branchedFrom, created_at AS createdAt FROM thread_titles WHERE branched_from = ? ORDER BY created_at ASC',
      )
      .all(threadId) as unknown as ThreadInfo[];
  }

  setTitle(threadId: string, title: string, branchedFrom?: string): void {
    this.db
      .prepare(
        `INSERT INTO thread_titles (thread_id, title, branched_from, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, branched_from = excluded.branched_from`,
      )
      .run(threadId, title, branchedFrom ?? null, Date.now());
  }

  close(): void {
    this.db.close();
  }
}

export interface BranchRequestBody {
  fromMessageId?: unknown;
  title?: unknown;
  botId?: unknown;
}

function parseMessageId(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : undefined;
}

export function createChatThreadsRouter(deps: ChatThreadsDeps): Router {
  const router = express.Router();
  const titles = deps.titles ?? new ThreadTitleStore(deps.dataDir);

  /**
   * Branch family: the root thread plus every descendant branch, with
   * version numbers for the UI picker (root = v1, branches ordered by
   * creation time). Lets the client switch between versions of a thread.
   */
  router.get('/:threadId/branches', async (req, res) => {
    const threadId = req.params.threadId;
    if (!threadId || threadId.length > 256) {
      res.status(400).json(errorBody('threadId is required'));
      return;
    }
    // Walk up to the root (cycle-guarded: titles form a DAG in practice).
    const seen = new Set<string>();
    let rootId = threadId;
    for (;;) {
      if (seen.has(rootId)) break;
      seen.add(rootId);
      const info = titles.getThread(rootId);
      if (!info?.branchedFrom) break;
      rootId = info.branchedFrom;
    }
    // BFS down from the root collecting every descendant.
    const family = new Map<string, ThreadInfo>();
    const rootInfo: ThreadInfo = titles.getThread(rootId) ?? {
      threadId: rootId,
      title: rootId,
      branchedFrom: null,
      createdAt: 0,
    };
    family.set(rootId, rootInfo);
    const queue = [rootId];
    const visited = new Set([rootId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of titles.getChildren(current)) {
        if (visited.has(child.threadId)) continue;
        visited.add(child.threadId);
        family.set(child.threadId, child);
        queue.push(child.threadId);
      }
    }
    // The requested thread itself always appears, even if it was never
    // titled (e.g. a plain conversation with no branches yet).
    if (!family.has(threadId)) {
      family.set(threadId, titles.getThread(threadId) ?? { threadId, title: threadId, branchedFrom: null, createdAt: 0 });
    }
    const ordered = [...family.values()].sort((a, b) => a.createdAt - b.createdAt);
    const threads = ordered.map((t, i) => ({
      id: t.threadId,
      title: t.title,
      branchedFrom: t.branchedFrom,
      createdAt: t.createdAt,
      version: i + 1,
      isRoot: t.threadId === rootId,
    }));
    res.json({ ok: true, root: rootId, threads });
  });

  /** Verbatim message log with the stable ids POST /:threadId/branch expects. */
  router.get('/:threadId/messages', async (req, res) => {
    const threadId = req.params.threadId;
    if (!threadId || threadId.length > 256) {
      res.status(400).json(errorBody('threadId is required'));
      return;
    }
    const messages = await deps.listThreadMessages(threadId);
    if (messages.length === 0) {
      res.status(404).json(errorBody(`Unknown thread "${threadId}"`));
      return;
    }
    res.json({ ok: true, threadId, messages });
  });

  /**
   * Branch a thread: new session for the same bot, history copied up to and
   * including `fromMessageId`. 404s when the thread or message is unknown.
   */
  router.post('/:threadId/branch', async (req, res) => {
    const threadId = req.params.threadId;
    if (!threadId || threadId.length > 256) {
      res.status(400).json(errorBody('threadId is required'));
      return;
    }
    const body = (req.body ?? {}) as BranchRequestBody;
    const fromMessageId = parseMessageId(body.fromMessageId);
    if (fromMessageId === undefined) {
      res
        .status(400)
        .json(errorBody('fromMessageId is required (a positive integer message id from GET /:threadId/messages)'));
      return;
    }
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : undefined;
    const botId = typeof body.botId === 'string' && body.botId.trim() ? body.botId.trim() : undefined;

    const result = await deps.branchSession(threadId, fromMessageId, botId ? { botId } : undefined);
    if (!result.ok) {
      if (result.reason === 'thread-not-found') {
        res.status(404).json(errorBody(`Unknown thread "${threadId}"`));
      } else {
        res.status(404).json(errorBody(`Unknown message ${fromMessageId} in thread "${threadId}"`));
      }
      return;
    }

    const originalTitle = titles.getTitle(threadId);
    const newTitle = title ?? `Branch of ${originalTitle ?? threadId}`;
    titles.setTitle(result.session.id, newTitle, threadId);

    deps.audit('chat.thread_branch', {
      actor: 'api',
      sessionId: result.session.id,
      detail: {
        fromThreadId: threadId,
        fromMessageId,
        copiedMessages: result.copiedMessages,
        botId: result.session.botId,
      },
    });

    res.json({
      ok: true,
      thread: {
        id: result.session.id,
        title: newTitle,
        botId: result.session.botId,
        branchedFrom: threadId,
        fromMessageId,
        copiedMessages: result.copiedMessages,
        createdAt: result.session.createdAt,
      },
    });
  });

  return router;
}
