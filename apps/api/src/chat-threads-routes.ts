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
//     listThreads: (opts) => agentRuntime.sessionStore.listSessions(opts),
//     branchSession: (id, msgId, opts) => agentRuntime.branchSession(id, msgId, opts),
//     listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BranchSessionResult, IdentifiedMessage } from '@mvp/agent-runtime';

import { openDb } from '@mvp/agent-runtime';

export interface ChatThreadsDeps {
  dataDir: string;
  /**
   * List chat sessions (threads), most recently active first. Required:
   * powers GET / (the thread picker used by the web UI branch picker and
   * the headless CLI's `kriyadot threads list`).
   */
  listThreads: (opts?: {
    botId?: string;
    limit?: number;
    /** W7: restrict to one person's private chats (owner filter). */
    ownerPersonId?: string;
  }) => Array<{
    id: string;
    botId: string;
    createdAt: string;
    messageCount: number;
    lastMessageTs: string | null;
    ownerPersonId?: string;
  }> | Promise<
    Array<{
      id: string;
      botId: string;
      createdAt: string;
      messageCount: number;
      lastMessageTs: string | null;
      ownerPersonId?: string;
    }>
  >;
  /**
   * W7 (optional): resolve the person context for a list request
   * (x-person-id header / ?personId=). When it returns a person id, the
   * thread list is filtered to that person's private chats. When the dep
   * is absent, listing behaves exactly as before (all threads).
   */
  resolvePersonId?: (req: express.Request) => string | undefined;
  /** Branch implementation — AgentRuntime.branchSession in production. */
  branchSession: (
    sessionId: string,
    fromMessageId: number,
    opts?: { botId?: string },
  ) => BranchSessionResult | Promise<BranchSessionResult>;
  /** Verbatim message log — AgentRuntime.listThreadMessages in production. */
  listThreadMessages: (sessionId: string) => IdentifiedMessage[] | Promise<IdentifiedMessage[]>;
  /**
   * Duplicate a session (full history copy). SessionStore.duplicateSession
   * in production.
   */
  duplicateThread: (sessionId: string) => string | undefined | Promise<string | undefined>;
  /**
   * Delete a session and its messages. SessionStore.deleteSession in
   * production.
   */
  deleteThread: (sessionId: string) => boolean | Promise<boolean>;
  audit: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
  /**
   * Called after a thread is deleted (session + titles + flags removed).
   * The host wires this to agentRuntime.clearSessionCircuitState so the
   * deleted session's circuit-breaker state can't leak.
   */
  onThreadDeleted?: (threadId: string) => void;
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

/** Per-conversation management flags (bot context-menu: pin, unread, hide). */
export interface ThreadFlags {
  pinned: boolean;
  unread: boolean;
  hidden: boolean;
}

const EMPTY_FLAGS: ThreadFlags = { pinned: false, unread: false, hidden: false };

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

/** Persistent thread titles: <dataDir>/chat-threads.db. */
export class ThreadTitleStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'chat-threads.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_titles (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        branched_from TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_flags (
        thread_id TEXT PRIMARY KEY,
        pinned INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
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

  /** Management flags for one thread (all false when never set). */
  getFlags(threadId: string): ThreadFlags {
    const row = this.db
      .prepare('SELECT pinned, unread, hidden FROM thread_flags WHERE thread_id = ?')
      .get(threadId) as { pinned: number; unread: number; hidden: number } | undefined;
    if (!row) return { ...EMPTY_FLAGS };
    return { pinned: row.pinned === 1, unread: row.unread === 1, hidden: row.hidden === 1 };
  }

  /** Set any subset of flags; returns the merged flags. */
  setFlags(threadId: string, patch: Partial<ThreadFlags>): ThreadFlags {
    const current = this.getFlags(threadId);
    const next: ThreadFlags = {
      pinned: patch.pinned ?? current.pinned,
      unread: patch.unread ?? current.unread,
      hidden: patch.hidden ?? current.hidden,
    };
    this.db
      .prepare(
        `INSERT INTO thread_flags (thread_id, pinned, unread, hidden, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET pinned = excluded.pinned, unread = excluded.unread, hidden = excluded.hidden, updated_at = excluded.updated_at`,
      )
      .run(threadId, next.pinned ? 1 : 0, next.unread ? 1 : 0, next.hidden ? 1 : 0, Date.now());
    return next;
  }

  /** Drop a thread's title + flags (used on thread delete). */
  deleteThread(threadId: string): void {
    this.db.prepare('DELETE FROM thread_titles WHERE thread_id = ?').run(threadId);
    this.db.prepare('DELETE FROM thread_flags WHERE thread_id = ?').run(threadId);
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
   * Thread list: every chat session, most recently active first, with the
   * stored title (when the thread was ever titled or branched) and
   * management flags merged in. Pinned threads sort first. Hidden threads
   * are excluded unless ?includeHidden=1.
   * Used by the web branch picker and the headless CLI (`kriyadot threads list`).
   */
  router.get('/', async (req, res) => {
    const botId = typeof req.query.botId === 'string' && req.query.botId.trim() ? req.query.botId.trim() : undefined;
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isSafeInteger(rawLimit) ? rawLimit : undefined;
    const includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
    // W7: person-scoped listing — only that person's private chats.
    const ownerPersonId = deps.resolvePersonId?.(req);
    try {
      const sessions = await deps.listThreads({
        ...(botId ? { botId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(ownerPersonId ? { ownerPersonId } : {}),
      });
      const threads = sessions
        .map((s) => ({
          id: s.id,
          botId: s.botId,
          title: titles.getTitle(s.id) ?? null,
          flags: titles.getFlags(s.id),
          createdAt: s.createdAt,
          messageCount: s.messageCount,
          lastMessageTs: s.lastMessageTs,
          ...(s.ownerPersonId ? { ownerPersonId: s.ownerPersonId } : {}),
        }))
        .filter((t) => includeHidden || !t.flags.hidden)
        .sort((a, b) => Number(b.flags.pinned) - Number(a.flags.pinned));
      res.json({ ok: true, threads });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list threads', err instanceof Error ? err.message : String(err)));
    }
  });

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

  /**
   * Management flags (bot context-menu): pin/unpin, mark unread/read,
   * hide/unhide. PATCH /:threadId/flags { pinned?, unread?, hidden? }.
   */
  router.patch('/:threadId/flags', async (req, res) => {
    const threadId = req.params.threadId;
    if (!threadId || threadId.length > 256) {
      res.status(400).json(errorBody('threadId is required'));
      return;
    }
    const body = (req.body ?? {}) as { pinned?: unknown; unread?: unknown; hidden?: unknown };
    const patch: Partial<ThreadFlags> = {};
    for (const key of ['pinned', 'unread', 'hidden'] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') {
        res.status(400).json(errorBody(`"${key}" must be a boolean`));
        return;
      }
      patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json(errorBody('Provide at least one of: pinned, unread, hidden'));
      return;
    }
    const messages = await deps.listThreadMessages(threadId);
    if (messages.length === 0) {
      res.status(404).json(errorBody(`Unknown thread "${threadId}"`));
      return;
    }
    const flags = titles.setFlags(threadId, patch);
    deps.audit('chat.thread_flags', { actor: 'api', sessionId: threadId, detail: { flags } });
    res.json({ ok: true, threadId, flags });
  });

  /**
   * Duplicate a thread: new session for the same bot with the full history
   * copied. Titled "Copy of <original>".
   */
  router.post('/:threadId/duplicate', async (req, res) => {
    const threadId = req.params.threadId;
    if (!threadId || threadId.length > 256) {
      res.status(400).json(errorBody('threadId is required'));
      return;
    }
    const newId = await deps.duplicateThread(threadId);
    if (!newId) {
      res.status(404).json(errorBody(`Unknown thread "${threadId}"`));
      return;
    }
    const originalTitle = titles.getTitle(threadId) ?? threadId;
    const newTitle = `Copy of ${originalTitle}`.slice(0, 120);
    titles.setTitle(newId, newTitle, threadId);
    deps.audit('chat.thread_duplicate', {
      actor: 'api',
      sessionId: newId,
      detail: { fromThreadId: threadId },
    });
    res.status(201).json({ ok: true, thread: { id: newId, title: newTitle, branchedFrom: threadId } });
  });

  /**
   * Delete a thread: removes the session + messages, titles, and flags.
   * Also clears the session's circuit-breaker state (via onThreadDeleted).
   */
  router.delete('/:threadId', async (req, res) => {
    const threadId = req.params.threadId;
    if (!threadId || threadId.length > 256) {
      res.status(400).json(errorBody('threadId is required'));
      return;
    }
    const deleted = await deps.deleteThread(threadId);
    if (!deleted) {
      res.status(404).json(errorBody(`Unknown thread "${threadId}"`));
      return;
    }
    titles.deleteThread(threadId);
    try {
      deps.onThreadDeleted?.(threadId);
    } catch {
      // circuit-state cleanup must never break deletion
    }
    deps.audit('chat.thread_delete', { actor: 'api', sessionId: threadId });
    res.json({ ok: true, deleted: threadId });
  });

  return router;
}
