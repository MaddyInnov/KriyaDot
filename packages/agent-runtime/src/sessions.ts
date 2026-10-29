// SPDX-License-Identifier: Apache-2.0

import type { ChatMessage, RichMessage, ToolCall } from './types.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export interface SessionRecord {
  id: string;
  botId: string;
  createdAt: string;
  /**
   * Multiplayer layer (W7): the person who owns this private 1:1 chat.
   * Absent/null on pre-W7 rows — those belong to the default user.
   *
   * TRUST MODEL (honest): KriyaDot is a local-first app. A "person
   * context" (the `x-person-id` header / `personId` param the UI sends)
   * is a UI-level identity selector, NOT cryptographic authentication —
   * anyone with local API access can present any person id. Ownership
   * filtering keeps teammates' private chats out of each other's lists
   * in normal use; it is not a security boundary against a local
   * attacker. (Tenancy orgs/roles govern hosted multi-tenant use.)
   */
  ownerPersonId?: string;
}

/** Person id that owns pre-W7 / unowned private chats: the default user. */
export const DEFAULT_CHAT_OWNER_PERSON_ID = 'you';

/** A chat session (thread) summary for thread pickers and the CLI. */
export interface SessionSummary extends SessionRecord {
  /** Total messages stored in the session. */
  messageCount: number;
  /** ISO timestamp of the newest message, or null when the session is empty. */
  lastMessageTs: string | null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
}

function newId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A single chat message with its stable storage id (SQLite rowid). */
export interface IdentifiedMessage {
  id: number;
  role: ChatMessage['role'];
  content: string;
  ts: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /**
   * Reply-thread membership (Slack-style threads). Null/undefined for main
   * chat messages. threadId is the opaque thread id (`thr_…`); threadRootId
   * is the client-side id of the root message the thread is anchored to.
   * Populated by the message-threads API, not stored in the session DB.
   */
  threadId?: string | null;
  threadRootId?: string | null;
}

/** A single full-text search hit over chat messages. */
export interface MessageSearchHit {
  messageId: number;
  sessionId: string;
  botId: string;
  role: ChatMessage['role'];
  ts: string;
  /**
   * Snippet around the match. Matched terms are wrapped in
   * \u0001..\u0002 markers so callers can highlight without HTML injection.
   */
  snippet: string;
  /** FTS5 rank (lower = better). */
  rank: number;
}

export interface MessageSearchOptions {
  botId?: string;
  sessionId?: string;
  limit?: number;
}

/**
 * Build a safe FTS5 MATCH expression from a raw user query: an implicit
 * AND of double-quoted terms, with all FTS5 syntax characters stripped.
 * Returns undefined when the query has no searchable terms.
 */
function buildMatchExpression(query: string): string | undefined {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 64))
    .filter((t) => t.length > 0)
    .slice(0, 10);
  if (terms.length === 0) return undefined;
  return terms.map((t) => `"${t}"`).join(' ');
}

/** Result of {@link SessionStore.branchSession}. */
export type BranchSessionResult =
  | { ok: true; session: SessionRecord; copiedMessages: number }
  | { ok: false; reason: 'thread-not-found' | 'message-not-found' };

/** Default cap on messages returned by getMessages() without compaction. */
export const DEFAULT_HISTORY_LIMIT = 100;
/** Env var consulted when no explicit historyLimit is passed to the constructor. */
export const HISTORY_LIMIT_ENV_VAR = 'SESSION_HISTORY_LIMIT';

/**
 * Hard floor of most-recent messages always kept verbatim by compaction.
 * Never shrinks: even a historyLimit below 100 keeps 100 here.
 */
export const COMPACTION_KEEP_FLOOR = 100;
/** Default trigger: compact when total messages exceed keepN + this. */
export const DEFAULT_COMPACT_THRESHOLD = 140;

/**
 * Summarizer hook for auto-compaction. The host provides the implementation
 * (suggested: a cheap model via createProvider, e.g. a small Groq model,
 * with the summary capped at ~800 tokens). It receives the messages to
 * summarize — oldest first — and returns the summary text.
 */
export type SessionSummarizer = (messages: ChatMessage[]) => Promise<string>;

export interface SessionStoreOptions {
  /**
   * Max messages returned by getMessages(); older messages are dropped from
   * the result (the DB rows are kept). Must be a positive integer.
   * Precedence: constructor option > SESSION_HISTORY_LIMIT env var > 100.
   * Only applies when no summarizer is configured.
   */
  historyLimit?: number;
  /**
   * Summarizer hook. When set, blind truncation is replaced by
   * summarization auto-compaction (see getMessages).
   */
  summarizer?: SessionSummarizer;
  /**
   * Compaction triggers when total messages exceed keepN + compactThreshold
   * (default 140), where keepN is the verbatim floor. Must be a positive
   * integer.
   */
  compactThreshold?: number;
  /**
   * Adaptive compression (Octomind parity): instead of a fixed message
   * count, the fold depth is COMPUTED from measured growth — the
   * verbatim tail is sized by estimated tokens against
   * `contextBudgetTokens`, so a session of short messages keeps more
   * verbatim history than a session of huge tool outputs. Default off
   * (fixed-count behavior unchanged).
   */
  adaptiveCompaction?: boolean;
  /** Token budget for the adaptive tail + summary (default 60_000). */
  contextBudgetTokens?: number;
  /**
   * Background folds (Octomind parity): when a fold is due and a prior
   * summary exists, getMessages returns the current view immediately
   * and folds in the background; the next read sees the extended
   * summary. The first fold for a session is always synchronous (there
   * is no summary to serve yet). Default off.
   */
  backgroundCompaction?: boolean;
}

/** One archived (lossless) compacted range, dereferenceable via recall. */
export interface CompactionArchiveEntry {
  id: string;
  sessionId: string;
  fromId: number;
  toId: number;
  messageCount: number;
  summary: string;
  createdAt: string;
}

/** Rough token estimate (≈4 chars/token) for one stored message row. */
function estimateRowTokens(row: MessageRow): number {
  let chars = row.content.length + (row.tool_calls?.length ?? 0);
  return Math.ceil(chars / 4) + 8;
}

function parsePositiveInt(raw: string | number | undefined): number | undefined {
  const n = typeof raw === 'number' ? raw : raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined;
}

function mapRow(row: MessageRow): RichMessage {
  const msg: RichMessage = {
    role: row.role as ChatMessage['role'],
    content: row.content,
  };
  if (row.tool_name) msg.toolName = row.tool_name;
  if (row.tool_call_id) msg.toolCallId = row.tool_call_id;
  if (row.tool_calls) {
    try {
      msg.toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
    } catch {
      // corrupted column: drop it rather than failing the whole history
    }
  }
  return msg;
}

/**
 * SQLite-backed session + message store (node:sqlite, no native deps).
 * Assistant tool calls are persisted in a JSON column so history can be
 * re-serialized for providers; the public ChatMessage contract is unchanged.
 *
 * Two history modes:
 * - Without a summarizer: getMessages() returns at most `historyLimit`
 *   most recent messages (default 100), dropping older ones from the result
 *   with a console warning (legacy blind truncation).
 * - With a summarizer: when total messages exceed keepN + compactThreshold
 *   (defaults 100 + 140), everything EXCEPT the last keepN messages is
 *   summarized once via the injected summarizer and returned as a single
 *   leading system message; the last keepN messages stay verbatim. The
 *   keep floor never shrinks. Compaction is idempotent: an already-compacted
 *   range is never re-summarized (watermark in the `compactions` table +
 *   in-memory cache); newly appended messages are summarized incrementally
 *   and appended to the cached summary.
 */
export class SessionStore {
  private readonly db: DatabaseSyncType;
  private readonly historyLimit: number;
  private readonly summarizer?: SessionSummarizer;
  private readonly compactThreshold: number;
  private readonly adaptiveCompaction: boolean;
  private readonly contextBudgetTokens: number;
  private readonly backgroundCompaction: boolean;
  /** sessionId → { summary, upToId }: already-compacted watermark cache. */
  private readonly compactionCache = new Map<string, { summary: string; upToId: number }>();
  /** Sessions with a background fold currently in flight. */
  private readonly foldsInFlight = new Set<string>();

  constructor(dbPath: string, opts: SessionStoreOptions = {}) {
    this.db = openDb(dbPath);
    this.historyLimit =
      parsePositiveInt(opts.historyLimit) ??
      parsePositiveInt(process.env[HISTORY_LIMIT_ENV_VAR]) ??
      DEFAULT_HISTORY_LIMIT;
    this.summarizer = opts.summarizer;
    this.compactThreshold = parsePositiveInt(opts.compactThreshold) ?? DEFAULT_COMPACT_THRESHOLD;
    this.adaptiveCompaction = opts.adaptiveCompaction === true;
    this.contextBudgetTokens = parsePositiveInt(opts.contextBudgetTokens) ?? 60_000;
    this.backgroundCompaction = opts.backgroundCompaction === true;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`);
    // W7 migration: private-chat owner person (nullable; null = default user).
    try {
      this.db.exec('ALTER TABLE sessions ADD COLUMN owner_person_id TEXT');
    } catch {
      // Column already exists.
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id);
      CREATE TABLE IF NOT EXISTS compactions (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        up_to_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compaction_archive (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        messages_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_archive_session ON compaction_archive (session_id, from_id);
      CREATE TABLE IF NOT EXISTS session_worktrees (
        session_id TEXT PRIMARY KEY,
        worktree_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Full-text search (OpenMausBot parity): FTS5 index over message
    // content, maintained incrementally by triggers so search stays fresh
    // on every insert/delete (branch copies, rewinds, new messages).
    // NOTE: the FTS5 'delete' pseudo-command is broken in this runtime's
    // SQLite build (SQL logic error), so the triggers use a plain
    // DELETE ... WHERE rowid = ... instead — equivalent for this table.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, tokenize='porter');
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.id;
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.id;
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    // Self-healing sync on every open: index rows missing from FTS (e.g.
    // written before the FTS table existed, or while an older trigger
    // revision was in place) and drop stale FTS rows with no message.
    // Triggers keep it fresh after this.
    this.db
      .prepare(
        'INSERT INTO messages_fts(rowid, content) SELECT m.id, m.content FROM messages m WHERE NOT EXISTS (SELECT 1 FROM messages_fts f WHERE f.rowid = m.id)',
      )
      .run();
    this.db.prepare('DELETE FROM messages_fts WHERE rowid NOT IN (SELECT id FROM messages)').run();
  }

  createSession(botId: string, opts: { ownerPersonId?: string } = {}): string {
    const id = newId();
    this.db
      .prepare('INSERT INTO sessions (id, bot_id, created_at, owner_person_id) VALUES (?, ?, ?, ?)')
      .run(id, botId, new Date().toISOString(), opts.ownerPersonId ?? null);
    return id;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, bot_id AS botId, created_at AS createdAt, owner_person_id AS ownerPersonId FROM sessions WHERE id = ?',
      )
      .get(id) as
      | { id: string; botId: string; createdAt: string; ownerPersonId: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      botId: row.botId,
      createdAt: row.createdAt,
      ...(row.ownerPersonId ? { ownerPersonId: row.ownerPersonId } : {}),
    };
  }

  /**
   * W7: set (or clear, with null) a session's owner person. Used when a
   * chat is created through a person-scoped surface after the session row
   * already exists (client-generated session ids). Returns false when the
   * session is unknown.
   */
  setSessionOwner(sessionId: string, ownerPersonId: string | null): boolean {
    const res = this.db
      .prepare('UPDATE sessions SET owner_person_id = ? WHERE id = ?')
      .run(ownerPersonId, sessionId);
    return res.changes > 0;
  }

  /** W7: the effective owner of a session (null owner = default user). */
  sessionOwnerPersonId(sessionId: string): string | undefined {
    const s = this.getSession(sessionId);
    if (!s) return undefined;
    return s.ownerPersonId ?? DEFAULT_CHAT_OWNER_PERSON_ID;
  }

  /**
   * List chat sessions (threads), most recently active first. Used by the
   * `GET /api/chat/threads` endpoint and the headless CLI (`kriyadot threads
   * list`). Each summary carries message counts and the last-message
   * timestamp so clients can render a useful thread picker without
   * fetching every thread's messages.
   */
  listSessions(
    opts: { botId?: string; limit?: number; ownerPersonId?: string } = {},
  ): SessionSummary[] {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
    const botId = typeof opts.botId === 'string' && opts.botId.trim() ? opts.botId.trim() : null;
    // W7 private-chat filtering: when an owner person is given, only that
    // person's chats are listed. Legacy rows (owner NULL) belong to the
    // default user, so they match only the default person's listing.
    const owner = typeof opts.ownerPersonId === 'string' && opts.ownerPersonId.trim()
      ? opts.ownerPersonId.trim()
      : null;
    const ownerClause = owner === null
      ? ''
      : owner === DEFAULT_CHAT_OWNER_PERSON_ID
        ? ' AND (s.owner_person_id = ? OR s.owner_person_id IS NULL)'
        : ' AND s.owner_person_id = ?';
    const params: Array<string | number | null> = [botId, botId];
    if (owner !== null) params.push(owner);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT s.id AS id, s.bot_id AS botId, s.created_at AS createdAt,
                s.owner_person_id AS ownerPersonId,
                COUNT(m.id) AS messageCount,
                MAX(m.ts) AS lastMessageTs
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE (? IS NULL OR s.bot_id = ?)${ownerClause}
         GROUP BY s.id
         ORDER BY COALESCE(MAX(m.ts), s.created_at) DESC, MAX(m.id) DESC, s.created_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
      id: string;
      botId: string;
      createdAt: string;
      ownerPersonId: string | null;
      messageCount: number;
      lastMessageTs: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      botId: r.botId,
      createdAt: r.createdAt,
      ...(r.ownerPersonId ? { ownerPersonId: r.ownerPersonId } : {}),
      messageCount: r.messageCount,
      lastMessageTs: r.lastMessageTs,
    }));
  }

  /**
   * Rewind: truncate a session's history to the first `keepCount` messages
   * (by insertion order). Used by checkpoints/rewind to restore the
   * conversation to an earlier point. Returns the number of messages removed.
   */
  rewindHistory(sessionId: string, keepCount: number): number {
    const ids = (
      this.db
        .prepare('SELECT rowid AS id FROM messages WHERE session_id = ? ORDER BY rowid ASC')
        .all(sessionId) as Array<{ id: number }>
    ).map((r) => r.id);
    if (keepCount >= ids.length) return 0;
    const toDelete = ids.slice(keepCount);
    const placeholders = toDelete.map(() => '?').join(',');
    const result = this.db.prepare(`DELETE FROM messages WHERE rowid IN (${placeholders})`).run(...toDelete);
    return Number(result.changes);
  }

  appendMessage(sessionId: string, msg: ChatMessage): void {
    const rich = msg as RichMessage;
    const toolCalls: ToolCall[] | undefined = rich.toolCalls;
    this.db
      .prepare(
        'INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_calls, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sessionId,
        msg.role,
        msg.content,
        msg.toolName ?? null,
        msg.toolCallId ?? null,
        toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
        new Date().toISOString(),
      );
  }

  private readCompaction(sessionId: string): { summary: string; upToId: number } | undefined {
    const row = this.db
      .prepare('SELECT summary, up_to_id AS upToId FROM compactions WHERE session_id = ?')
      .get(sessionId) as { summary: string; upToId: number } | undefined;
    if (row) this.compactionCache.set(sessionId, row);
    return row;
  }

  private writeCompaction(sessionId: string, summary: string, upToId: number): void {
    this.db
      .prepare(
        `INSERT INTO compactions (session_id, summary, up_to_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, up_to_id = excluded.up_to_id, updated_at = excluded.updated_at`,
      )
      .run(sessionId, summary, upToId, new Date().toISOString());
    this.compactionCache.set(sessionId, { summary, upToId });
  }

  private allRows(sessionId: string): MessageRow[] {
    return this.db
      .prepare(
        'SELECT id, role, content, tool_name, tool_call_id, tool_calls FROM messages WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId) as unknown as MessageRow[];
  }

  /**
   * Decide the verbatim tail and the range to fold, or null when no
   * fold is due. Fixed mode: fold when total > keepN + threshold.
   * Adaptive mode: the tail is sized by estimated tokens against the
   * context budget (at least 20 messages, at most keepN), and a fold is
   * due when the context exceeds the budget (with a minimum chunk) or
   * the count backstop trips.
   */
  private planCompaction(
    rows: MessageRow[],
    keepN: number,
  ): { compactRange: MessageRow[]; kept: MessageRow[] } | null {
    if (!this.adaptiveCompaction) {
      if (rows.length <= keepN + this.compactThreshold) return null;
      return { compactRange: rows.slice(0, rows.length - keepN), kept: rows.slice(-keepN) };
    }
    const totalTokens = rows.reduce((sum, r) => sum + estimateRowTokens(r), 0);
    let keep = 0;
    let tailTokens = 0;
    const tailBudget = Math.floor(this.contextBudgetTokens * 0.7);
    for (let i = rows.length - 1; i >= 0; i--) {
      tailTokens += estimateRowTokens(rows[i]!);
      keep += 1;
      // Floor of 8 verbatim messages (the most recent exchanges are
      // never folded); beyond it the token budget rules.
      if (keep >= 8 && tailTokens >= tailBudget) break;
      if (keep >= keepN) break;
    }
    keep = Math.min(keep, rows.length);
    const foldCount = rows.length - keep;
    const countBackstop = rows.length > keepN + this.compactThreshold;
    if (foldCount <= 0) return null;
    if (!countBackstop && !(totalTokens > this.contextBudgetTokens && foldCount >= 10)) return null;
    return { compactRange: rows.slice(0, foldCount), kept: rows.slice(foldCount) };
  }

  /** Archive a raw range losslessly BEFORE it folds into the summary. */
  private archiveRange(sessionId: string, range: MessageRow[], summary: string): string {
    const fromId = range[0]!.id;
    const toId = range[range.length - 1]!.id;
    const id = `arc-${sessionId.slice(0, 12)}-${fromId}-${toId}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO compaction_archive (id, session_id, from_id, to_id, message_count, messages_json, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, fromId, toId, range.length, JSON.stringify(range.map(mapRow)), summary, new Date().toISOString());
    return id;
  }

  /** List a session's lossless compaction archives (oldest first). */
  /**
   * Last message activity for a bot across all its sessions (UTC ms),
   * or undefined when the bot has no messages. Powers idle triggers.
   */
  lastActivityForBot(botId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(m.ts) AS last_ts FROM messages m
         JOIN sessions s ON s.id = m.session_id WHERE s.bot_id = ?`,
      )
      .get(botId) as { last_ts: string | null } | undefined;
    if (!row?.last_ts) return undefined;
    const ms = Date.parse(row.last_ts);
    return Number.isFinite(ms) ? ms : undefined;
  }

  listArchives(sessionId: string): CompactionArchiveEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, from_id AS fromId, to_id AS toId, summary, created_at AS createdAt,
                message_count AS messageCount
         FROM compaction_archive WHERE session_id = ? ORDER BY from_id ASC`,
      )
      .all(sessionId) as unknown as CompactionArchiveEntry[];
    return rows;
  }

  /** Derefence one archive: the original messages, verbatim. */
  readArchive(archiveId: string): { entry: CompactionArchiveEntry; messages: RichMessage[] } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, from_id AS fromId, to_id AS toId, summary, created_at AS createdAt, messages_json AS messagesJson
         FROM compaction_archive WHERE id = ?`,
      )
      .get(archiveId) as (CompactionArchiveEntry & { messagesJson: string }) | undefined;
    if (!row) return undefined;
    let messages: RichMessage[] = [];
    try {
      messages = JSON.parse(row.messagesJson) as RichMessage[];
    } catch {
      messages = [];
    }
    return {
      entry: { ...row, messageCount: messages.length },
      messages,
    };
  }

  private compactionHeader(sessionId: string, summary: string, compactedCount: number, keptCount: number): ChatMessage {
    const archives = this.summarizer ? this.listArchives(sessionId) : [];
    const archiveNote =
      archives.length > 0
        ? `\n[lossless archive: the original messages are preserved — recall them with the ` +
          `recall_compacted_context tool using an archive id: ${archives.map((a) => a.id).join(', ')}]`
        : '';
    return {
      role: 'system',
      content:
        `[compacted summary — ${compactedCount} older message(s) summarized; ` +
        `the last ${keptCount} message(s) follow verbatim]${archiveNote}\n${summary}`,
    };
  }

  /**
   * Fold the planned range: archive it losslessly, summarize only the
   * messages past the watermark, and extend the stored summary.
   * Idempotent — a range already covered by the watermark reuses the
   * cached summary without calling the summarizer or re-archiving.
   */
  private async foldRange(
    sessionId: string,
    compactRange: MessageRow[],
  ): Promise<{ summary: string; upToId: number }> {
    const lastCompactId = compactRange[compactRange.length - 1]!.id;
    const cached = this.compactionCache.get(sessionId) ?? this.readCompaction(sessionId);
    if (cached && cached.upToId >= lastCompactId) return cached;
    const fresh = compactRange.filter((r) => r.id > (cached?.upToId ?? -1));
    const chunk = await this.summarizer!(fresh.map(mapRow));
    if (fresh.length > 0) this.archiveRange(sessionId, fresh, chunk);
    const summary = cached ? `${cached.summary}\n\n${chunk}` : chunk;
    this.writeCompaction(sessionId, summary, lastCompactId);
    return { summary, upToId: lastCompactId };
  }

  /**
   * Force a compaction fold for a session now (e.g. a /compact command
   * or a background janitor). Returns true when a fold actually ran.
   */
  async compactNow(sessionId: string): Promise<boolean> {
    if (!this.summarizer) return false;
    const rows = this.allRows(sessionId);
    const keepN = Math.max(this.historyLimit, COMPACTION_KEEP_FLOOR);
    const plan = this.planCompaction(rows, keepN);
    if (!plan) return false;
    const before = (this.compactionCache.get(sessionId) ?? this.readCompaction(sessionId))?.upToId ?? -1;
    const after = await this.foldRange(sessionId, plan.compactRange);
    return after.upToId > before;
  }

  private startBackgroundFold(sessionId: string, rows: MessageRow[], keepN: number): void {
    if (this.foldsInFlight.has(sessionId)) return;
    const plan = this.planCompaction(rows, keepN);
    if (!plan) return;
    this.foldsInFlight.add(sessionId);
    void this.foldRange(sessionId, plan.compactRange)
      .catch(() => undefined)
      .finally(() => {
        this.foldsInFlight.delete(sessionId);
      });
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const rows = this.allRows(sessionId);

    const keepN = Math.max(this.historyLimit, COMPACTION_KEEP_FLOOR);
    if (!this.summarizer) {
      // Legacy blind-truncation rolling window (unchanged behaviour).
      const mapped = rows.map(mapRow);
      if (mapped.length > this.historyLimit) {
        const dropped = mapped.length - this.historyLimit;
        console.warn(
          `[sessions] session ${sessionId}: history truncated, dropped ${dropped} of ${mapped.length} messages (limit ${this.historyLimit})`,
        );
        return mapped.slice(-this.historyLimit);
      }
      return mapped;
    }

    const plan = this.planCompaction(rows, keepN);
    if (!plan) {
      const mapped = rows.map(mapRow);
      if (mapped.length > this.historyLimit) {
        const dropped = mapped.length - this.historyLimit;
        console.warn(
          `[sessions] session ${sessionId}: history truncated, dropped ${dropped} of ${mapped.length} messages (limit ${this.historyLimit})`,
        );
        return mapped.slice(-this.historyLimit);
      }
      return mapped;
    }

    // Background folds: with a prior summary in hand, serve the current
    // view (stale summary + verbatim tail past its watermark) and fold
    // in the background; the first fold is always synchronous.
    if (this.backgroundCompaction) {
      const cached = this.compactionCache.get(sessionId) ?? this.readCompaction(sessionId);
      if (cached) {
        this.startBackgroundFold(sessionId, rows, keepN);
        const kept = rows.filter((r) => r.id > cached.upToId).slice(-keepN);
        const compactedCount = rows.length - kept.length;
        return [this.compactionHeader(sessionId, cached.summary, compactedCount, kept.length), ...kept.map(mapRow)];
      }
    }

    const { summary } = await this.foldRange(sessionId, plan.compactRange);
    return [
      this.compactionHeader(sessionId, summary, plan.compactRange.length, plan.kept.length),
      ...plan.kept.map(mapRow),
    ];
  }

  /**
   * Raw message rows for a session in insertion order, with stable ids.
   * Unlike getMessages(), this never compacts or truncates — it is the
   * verbatim log used by chat-thread branching.
   */
  listThreadMessages(sessionId: string): IdentifiedMessage[] {
    const rows = this.db
      .prepare(
        'SELECT id, role, content, tool_name, tool_call_id, tool_calls, ts FROM messages WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId) as unknown as Array<MessageRow & { ts: string }>;
    return rows.map((row) => {
      const msg: IdentifiedMessage = {
        id: row.id,
        role: row.role as ChatMessage['role'],
        content: row.content,
        ts: row.ts,
      };
      if (row.tool_name) msg.toolName = row.tool_name;
      if (row.tool_call_id) msg.toolCallId = row.tool_call_id;
      if (row.tool_calls) {
        try {
          msg.toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
        } catch {
          // corrupted column: drop it rather than failing the whole history
        }
      }
      return msg;
    });
  }

  /**
   * Branch a chat thread: create a new session for the same bot and copy
   * the source session's history up to and including `fromMessageId`
   * (a message id from {@link listThreadMessages}).
   *
   * Thread existence: a session row counts, but so does a bare message log —
   * client-generated session ids (e.g. web chat conversation ids) have
   * messages without a session row. In that case a session row is backfilled
   * (using `botId` when given) so the thread is addressable afterwards.
   * Returns `{ ok: false, reason }` instead of throwing for 404 mapping.
   */
  branchSession(sessionId: string, fromMessageId: number, botId?: string): BranchSessionResult {
    let session = this.getSession(sessionId);
    if (!session) {
      const hasMessages =
        (this.db.prepare('SELECT 1 FROM messages WHERE session_id = ? LIMIT 1').get(sessionId) as unknown) !==
        undefined;
      if (!hasMessages) return { ok: false, reason: 'thread-not-found' };
      this.db
        .prepare('INSERT INTO sessions (id, bot_id, created_at) VALUES (?, ?, ?)')
        .run(sessionId, botId ?? '', new Date().toISOString());
      session = this.getSession(sessionId);
      if (!session) return { ok: false, reason: 'thread-not-found' };
    }
    const messageExists =
      (this.db
        .prepare('SELECT 1 FROM messages WHERE session_id = ? AND id = ? LIMIT 1')
        .get(sessionId, fromMessageId) as unknown) !== undefined;
    if (!messageExists) return { ok: false, reason: 'message-not-found' };

    const newSessionId = this.createSession(session.botId, {
      ownerPersonId: session.ownerPersonId,
    });
    const copied = this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_calls, ts)
         SELECT ?, role, content, tool_name, tool_call_id, tool_calls, ts
         FROM messages WHERE session_id = ? AND id <= ? ORDER BY id ASC`,
      )
      .run(newSessionId, sessionId, fromMessageId);
    const newSession = this.getSession(newSessionId);
    if (!newSession) return { ok: false, reason: 'thread-not-found' };
    return { ok: true, session: newSession, copiedMessages: Number(copied.changes) };
  }

  /**
   * Duplicate a session: new session for the same bot with the FULL history
   * copied (unlike branchSession, which copies up to a message). Returns
   * the new session id, or undefined when the source is unknown.
   */
  duplicateSession(sessionId: string): string | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const newId = this.createSession(session.botId, { ownerPersonId: session.ownerPersonId });
    this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_calls, ts)
         SELECT ?, role, content, tool_name, tool_call_id, tool_calls, ts
         FROM messages WHERE session_id = ? ORDER BY id ASC`,
      )
      .run(newId, sessionId);
    // Copy the compaction summary so the duplicate keeps its context window.
    this.db
      .prepare(
        `INSERT INTO compactions (session_id, summary, up_to_id, updated_at)
         SELECT ?, summary, up_to_id, updated_at FROM compactions WHERE session_id = ?`,
      )
      .run(newId, sessionId);
    return newId;
  }

  /**
   * Delete a session and all its messages, compactions, worktree links, and
   * FTS rows (the FTS delete trigger keeps the index consistent). Returns
   * true when a session was deleted.
   */
  deleteSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM compactions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM session_worktrees WHERE session_id = ?').run(sessionId);
    const res = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return res.changes > 0;
  }

  /**
   * Full-text search over all chat messages (FTS5, porter stemming).
   * Results carry a snippet with \u0001..\u0002 match markers, ordered by
   * rank (best first). Never throws on hostile input: queries with no
   * searchable terms return [].
   */
  searchMessages(query: string, opts: MessageSearchOptions = {}): MessageSearchHit[] {
    const match = buildMatchExpression(query);
    if (!match) return [];
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
    const conditions: string[] = [];
    const params: Array<string | number | null> = [match];
    if (opts.sessionId) {
      conditions.push('m.session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.botId) {
      conditions.push('s.bot_id = ?');
      params.push(opts.botId);
    }
    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT m.id AS messageId, m.session_id AS sessionId,
                COALESCE(s.bot_id, '') AS botId, m.role AS role, m.ts AS ts,
                snippet(messages_fts, 0, char(1), char(2), ' … ', 12) AS snippet,
                messages_fts.rank AS rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         LEFT JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ?
         ${where}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      messageId: number;
      sessionId: string;
      botId: string;
      role: string;
      ts: string;
      snippet: string;
      rank: number;
    }>;
    return rows.map((r) => ({
      messageId: r.messageId,
      sessionId: r.sessionId,
      botId: r.botId,
      role: r.role as ChatMessage['role'],
      ts: r.ts,
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  /**
   * Rebuild the FTS index from scratch (e.g. after an upgrade or if the
   * index is suspected stale). Returns the number of messages indexed.
   */
  rebuildSearchIndex(): number {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM messages_fts');
      this.db.prepare('INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages').run();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure; rethrow the original error
      }
      throw err;
    }
    return (this.db.prepare('SELECT COUNT(*) AS c FROM messages_fts').get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Bind a coding session to a git worktree (see worktrees.ts). The host
   * switches the session's workspace by passing a WorkspaceSource resolver
   * to the coding tools:
   *   (ctx) => store.getWorktree(ctx.sessionId) ?? defaultWorkspaceDir
   * Attaching to an unknown session is allowed (row is written by session
   * id); binding is a label, not a foreign key.
   */
  attachWorktree(sessionId: string, worktreePath: string): void {
    this.db
      .prepare(
        `INSERT INTO session_worktrees (session_id, worktree_path, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET worktree_path = excluded.worktree_path, created_at = excluded.created_at`,
      )
      .run(sessionId, worktreePath, new Date().toISOString());
  }

  /** Worktree path bound to a session, or undefined. */
  getWorktree(sessionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT worktree_path AS worktreePath FROM session_worktrees WHERE session_id = ?')
      .get(sessionId) as { worktreePath: string } | undefined;
    return row?.worktreePath;
  }

  /** Unbind a session's worktree (does not delete the worktree itself). */
  detachWorktree(sessionId: string): void {
    this.db.prepare('DELETE FROM session_worktrees WHERE session_id = ?').run(sessionId);
  }
}
