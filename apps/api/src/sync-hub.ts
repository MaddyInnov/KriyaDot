// SPDX-License-Identifier: Apache-2.0
// Sync hub (front-door Part 4): the account-level unified history store.
//
// The sync point is the USER'S OWN instance — never a KriyaDot-operated
// server. This store (<dataDir>/sync-hub.db) holds sessions/messages that
// were pushed from the user's devices plus this instance's own sessions,
// each tagged with its origin ('local' | 'cloud') and origin instance id.
//
// Merge model: sessions are append-only message logs. A message's identity
// is `<originInstanceId>:<sessionId>:<rowId>` (rowIds are per-origin stable
// because a session executes on exactly one side). Merge is insert-or-ignore
// by that key — message content is NEVER updated after first insert.
//
// Change cursor: every inserted/updated row is stamped with a monotonically
// increasing sequence number (persisted in sync_meta). Pull returns all
// rows with seq > since, plus the new cursor.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';

export type SyncOrigin = 'local' | 'cloud';

export interface SyncMessageInput {
  rowId: number;
  role: string;
  content: string;
  ts?: number | string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: unknown;
}

export interface SyncSessionInput {
  sessionId: string;
  botId: string;
  origin?: SyncOrigin | string;
  originInstanceId?: string;
  localOnly?: boolean;
  userId?: string;
  messages?: SyncMessageInput[];
}

export interface SyncBotInput {
  botId?: string;
  id?: string;
  config?: unknown;
  placement?: string;
  executorHere?: boolean;
  [key: string]: unknown;
}

export interface SyncRoutineInput {
  routineId?: string;
  id?: string;
  def?: unknown;
  anchor?: string;
  [key: string]: unknown;
}

export interface SyncActivityInput {
  id?: string;
  kind: string;
  payload?: unknown;
  ts?: number;
}

export interface SyncPushPayload {
  instanceId?: string;
  originInstanceId?: string;
  sessions?: SyncSessionInput[];
  bots?: SyncBotInput[];
  routines?: SyncRoutineInput[];
  activity?: SyncActivityInput[];
}

export interface SyncCounts {
  sessions: number;
  messages: number;
  bots: number;
  routines: number;
  activity: number;
}

function toTs(v: number | string | undefined, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export class SyncHubStore {
  private readonly db: DatabaseSync;
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(path.join(dataDir, 'sync-hub.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_sessions (
        session_key TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        origin_instance TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        user_id TEXT,
        updated_at INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_sessions_seq ON sync_sessions(seq);
      CREATE TABLE IF NOT EXISTS sync_messages (
        msg_key TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        row_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tool_json TEXT,
        seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_messages_session ON sync_messages(session_key, row_id);
      CREATE INDEX IF NOT EXISTS idx_sync_messages_seq ON sync_messages(seq);
      CREATE TABLE IF NOT EXISTS sync_bots (
        bot_id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        placement TEXT,
        executor_here INTEGER,
        updated_at INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_routines (
        routine_id TEXT PRIMARY KEY,
        def_json TEXT NOT NULL,
        anchor TEXT,
        updated_at INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_activity (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Stable per-data-dir instance id, generated exactly once.
    if (!this.getMeta('instanceId')) this.setMeta('instanceId', randomUUID());
  }

  get instanceId(): string {
    return this.getMeta('instanceId') as string;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  get ownerAccountId(): string | undefined {
    return this.getMeta('ownerAccountId');
  }

  setOwnerAccountId(id: string): void {
    if (id) this.setMeta('ownerAccountId', id);
  }

  private nextSeq(): number {
    const cur = Number(this.getMeta('seq') ?? '0') || 0;
    const next = cur + 1;
    this.setMeta('seq', String(next));
    return next;
  }

  cursor(): number {
    return Number(this.getMeta('seq') ?? '0') || 0;
  }

  /** Merge one push payload. Insert-or-ignore for messages (append-only). */
  mergePush(payload: SyncPushPayload, opts?: { defaultOriginInstance?: string }): SyncCounts {
    const counts: SyncCounts = { sessions: 0, messages: 0, bots: 0, routines: 0, activity: 0 };
    const now = Date.now();
    const fallbackInstance =
      opts?.defaultOriginInstance ?? payload.originInstanceId ?? payload.instanceId ?? 'unknown-origin';

    for (const s of payload.sessions ?? []) {
      if (!s || typeof s.sessionId !== 'string' || !s.sessionId) continue;
      const originInstance = typeof s.originInstanceId === 'string' && s.originInstanceId ? s.originInstanceId : fallbackInstance;
      const origin = s.origin === 'cloud' ? 'cloud' : 'local';
      const sessionKey = `${originInstance}:${s.sessionId}`;
      const seq = this.nextSeq();
      const existing = this.db.prepare('SELECT session_key FROM sync_sessions WHERE session_key = ?').get(sessionKey);
      this.db
        .prepare(
          `INSERT INTO sync_sessions (session_key, origin, origin_instance, session_id, bot_id, user_id, updated_at, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET bot_id = excluded.bot_id,
             user_id = COALESCE(excluded.user_id, sync_sessions.user_id),
             origin = excluded.origin, updated_at = excluded.updated_at, seq = excluded.seq`,
        )
        .run(sessionKey, origin, originInstance, s.sessionId, typeof s.botId === 'string' ? s.botId : '', s.userId ?? null, now, seq);
      if (!existing) counts.sessions += 1;
      else counts.sessions += 1; // an upserted session header still counts as accepted
      for (const m of s.messages ?? []) {
        if (!m || typeof m.rowId !== 'number' || typeof m.content !== 'string') continue;
        const msgKey = `${originInstance}:${s.sessionId}:${m.rowId}`;
        const toolJson =
          m.toolName !== undefined || m.toolCallId !== undefined || m.toolCalls !== undefined
            ? JSON.stringify({ toolName: m.toolName, toolCallId: m.toolCallId, toolCalls: m.toolCalls })
            : null;
        const r = this.db
          .prepare(
            `INSERT OR IGNORE INTO sync_messages (msg_key, session_key, row_id, role, content, ts, tool_json, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(msgKey, sessionKey, m.rowId, typeof m.role === 'string' ? m.role : 'user', m.content, toTs(m.ts, now), toolJson, this.nextSeq());
        counts.messages += Number(r.changes);
      }
    }

    for (const b of payload.bots ?? []) {
      const botId = (typeof b?.botId === 'string' && b.botId) || (typeof b?.id === 'string' && b.id) || '';
      if (!botId) continue;
      const config = b.config !== undefined ? b.config : b;
      this.db
        .prepare(
          `INSERT INTO sync_bots (bot_id, config_json, placement, executor_here, updated_at, seq)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id) DO UPDATE SET config_json = excluded.config_json,
             placement = excluded.placement, executor_here = excluded.executor_here,
             updated_at = excluded.updated_at, seq = excluded.seq`,
        )
        .run(
          botId,
          JSON.stringify(config ?? {}),
          typeof b.placement === 'string' ? b.placement : null,
          b.executorHere === undefined ? null : b.executorHere ? 1 : 0,
          now,
          this.nextSeq(),
        );
      counts.bots += 1;
    }

    for (const r of payload.routines ?? []) {
      const routineId = (typeof r?.routineId === 'string' && r.routineId) || (typeof r?.id === 'string' && r.id) || '';
      if (!routineId) continue;
      const def = r.def !== undefined ? r.def : r;
      const anchor = typeof r.anchor === 'string' ? r.anchor : (def as { anchor?: unknown })?.anchor;
      this.db
        .prepare(
          `INSERT INTO sync_routines (routine_id, def_json, anchor, updated_at, seq)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(routine_id) DO UPDATE SET def_json = excluded.def_json,
             anchor = excluded.anchor, updated_at = excluded.updated_at, seq = excluded.seq`,
        )
        .run(routineId, JSON.stringify(def ?? {}), typeof anchor === 'string' ? anchor : null, now, this.nextSeq());
      counts.routines += 1;
    }

    for (const a of payload.activity ?? []) {
      if (!a || typeof a.kind !== 'string' || !a.kind) continue;
      const id = typeof a.id === 'string' && a.id ? a.id : randomUUID();
      const r = this.db
        .prepare('INSERT OR IGNORE INTO sync_activity (id, kind, payload_json, ts, seq) VALUES (?, ?, ?, ?, ?)')
        .run(id, a.kind, JSON.stringify(a.payload ?? {}), toTs(a.ts, now), this.nextSeq());
      counts.activity += Number(r.changes);
    }
    return counts;
  }

  addActivity(kind: string, payload: unknown, ts = Date.now(), id?: string): void {
    this.mergePush({ activity: [{ kind, payload, ts, ...(id ? { id } : {}) }] });
  }

  /** All changes with seq > since, across every table. */
  pull(sinceRaw: unknown): {
    sessions: Array<Record<string, unknown>>;
    bots: Array<Record<string, unknown>>;
    routines: Array<Record<string, unknown>>;
    activity: Array<Record<string, unknown>>;
    cursor: number;
  } {
    const since = Math.max(0, Math.floor(Number(sinceRaw ?? 0)) || 0);
    // Sessions touched after the cursor (header update OR new messages).
    const keys = new Set<string>();
    for (const r of this.db.prepare('SELECT session_key FROM sync_sessions WHERE seq > ?').all(since) as Array<{ session_key: string }>) keys.add(r.session_key);
    for (const r of this.db.prepare('SELECT DISTINCT session_key FROM sync_messages WHERE seq > ?').all(since) as Array<{ session_key: string }>) keys.add(r.session_key);

    const sessions: Array<Record<string, unknown>> = [];
    for (const key of keys) {
      const s = this.db.prepare('SELECT * FROM sync_sessions WHERE session_key = ?').get(key) as
        | { session_id: string; bot_id: string; origin: string; origin_instance: string; user_id: string | null }
        | undefined;
      if (!s) continue;
      const msgs = this.db
        .prepare('SELECT * FROM sync_messages WHERE session_key = ? AND seq > ? ORDER BY row_id ASC')
        .all(key, since) as Array<{ row_id: number; role: string; content: string; ts: number; tool_json: string | null }>;
      sessions.push({
        sessionId: s.session_id,
        botId: s.bot_id,
        origin: s.origin,
        originInstanceId: s.origin_instance,
        ...(s.user_id ? { userId: s.user_id } : {}),
        messages: msgs.map((m) => {
          let tool: Record<string, unknown> = {};
          if (m.tool_json) {
            try { tool = JSON.parse(m.tool_json) as Record<string, unknown>; } catch { tool = {}; }
          }
          return { rowId: m.row_id, role: m.role, content: m.content, ts: m.ts, ...tool };
        }),
      });
    }
    const bots = (this.db.prepare('SELECT * FROM sync_bots WHERE seq > ?').all(since) as Array<{ bot_id: string; config_json: string; placement: string | null; executor_here: number | null }>).map((r) => {
      let config: unknown = {};
      try { config = JSON.parse(r.config_json); } catch { /* keep {} */ }
      return { botId: r.bot_id, config, ...(r.placement ? { placement: r.placement } : {}), ...(r.executor_here !== null ? { executorHere: r.executor_here === 1 } : {}) };
    });
    const routines = (this.db.prepare('SELECT * FROM sync_routines WHERE seq > ?').all(since) as Array<{ routine_id: string; def_json: string; anchor: string | null }>).map((r) => {
      let def: unknown = {};
      try { def = JSON.parse(r.def_json); } catch { /* keep {} */ }
      return { routineId: r.routine_id, def, ...(r.anchor ? { anchor: r.anchor } : {}) };
    });
    const activity = (this.db.prepare('SELECT * FROM sync_activity WHERE seq > ? ORDER BY seq ASC').all(since) as Array<{ id: string; kind: string; payload_json: string; ts: number }>).map((r) => {
      let payload: unknown = {};
      try { payload = JSON.parse(r.payload_json); } catch { /* keep {} */ }
      return { id: r.id, kind: r.kind, payload, ts: r.ts };
    });
    return { sessions, bots, routines, activity, cursor: this.cursor() };
  }

  /** Unified session list from the sync store alone (remote copies). */
  listStoredSessions(): Array<{
    sessionId: string;
    botId: string;
    origin: string;
    originInstanceId: string;
    messageCount: number;
    lastMessageTs: number | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT s.session_id, s.bot_id, s.origin, s.origin_instance,
                COUNT(m.msg_key) AS n, MAX(m.ts) AS last_ts
         FROM sync_sessions s LEFT JOIN sync_messages m ON m.session_key = s.session_key
         GROUP BY s.session_key ORDER BY COALESCE(MAX(m.ts), s.updated_at) DESC`,
      )
      .all() as Array<{ session_id: string; bot_id: string; origin: string; origin_instance: string; n: number; last_ts: number | null }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      botId: r.bot_id,
      origin: r.origin,
      originInstanceId: r.origin_instance,
      messageCount: r.n,
      lastMessageTs: r.last_ts,
    }));
  }

  /**
   * Messages of one stored (synced) session, oldest first. Used by the
   * read-only history view on surfaces that hold a synced copy but not the
   * live session (front-door Part 4: readable, never executable, from the
   * other side).
   */
  listSessionMessages(sessionId: string): Array<{ id: number; role: string; content: string; ts: number }> {
    const rows = this.db
      .prepare(
        `SELECT m.row_id, m.role, m.content, m.ts
         FROM sync_messages m
         JOIN sync_sessions s ON s.session_key = m.session_key
         WHERE s.session_id = ?
         ORDER BY m.ts ASC, m.row_id ASC`,
      )
      .all(sessionId) as Array<{ row_id: number; role: string; content: string; ts: number }>;
    return rows.map((r) => ({ id: r.row_id, role: r.role, content: r.content, ts: r.ts }));
  }

  listActivity(kind?: string, limit = 100): Array<{ id: string; kind: string; payload: unknown; ts: number }> {
    const rows = kind
      ? (this.db.prepare('SELECT * FROM sync_activity WHERE kind = ? ORDER BY ts DESC LIMIT ?').all(kind, limit) as Array<{ id: string; kind: string; payload_json: string; ts: number }>)
      : (this.db.prepare('SELECT * FROM sync_activity ORDER BY ts DESC LIMIT ?').all(limit) as Array<{ id: string; kind: string; payload_json: string; ts: number }>);
    return rows.map((r) => {
      let payload: unknown = {};
      try { payload = JSON.parse(r.payload_json); } catch { /* keep {} */ }
      return { id: r.id, kind: r.kind, payload, ts: r.ts };
    });
  }

  // -- Persistent outbox (failed client pushes stay queued) ------------------

  enqueueOutbox(payload: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sync_outbox (id, payload_json, created_at, attempts) VALUES (?, ?, ?, 0)').run(id, JSON.stringify(payload), Date.now());
    return id;
  }

  listOutbox(): Array<{ id: string; payload: SyncPushPayload; attempts: number }> {
    const rows = this.db.prepare('SELECT * FROM sync_outbox ORDER BY created_at ASC').all() as Array<{ id: string; payload_json: string; attempts: number }>;
    return rows.map((r) => {
      let payload: SyncPushPayload = {};
      try { payload = JSON.parse(r.payload_json) as SyncPushPayload; } catch { /* keep {} */ }
      return { id: r.id, payload, attempts: r.attempts };
    });
  }

  removeOutbox(id: string): void {
    this.db.prepare('DELETE FROM sync_outbox WHERE id = ?').run(id);
  }

  bumpOutbox(id: string): void {
    this.db.prepare('UPDATE sync_outbox SET attempts = attempts + 1 WHERE id = ?').run(id);
  }

  outboxCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number };
    return row.n;
  }
}

// ---------------------------------------------------------------------------
// Link token (sync-hub.json): only the SHA-256 hash is ever stored.
// ---------------------------------------------------------------------------

export interface SyncHubFile {
  linkTokenHash?: string;
  ownerUserId?: string;
  createdAt?: number;
}

export function syncHubFilePath(dataDir: string): string {
  return path.join(dataDir, 'sync-hub.json');
}

export function readSyncHubFile(dataDir: string): SyncHubFile {
  try {
    return JSON.parse(fs.readFileSync(syncHubFilePath(dataDir), 'utf8')) as SyncHubFile;
  } catch {
    return {};
  }
}

export function writeSyncHubFile(dataDir: string, file: SyncHubFile): void {
  mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(syncHubFilePath(dataDir), JSON.stringify(file, null, 2), { mode: 0o600 });
  try { fs.chmodSync(syncHubFilePath(dataDir), 0o600); } catch { /* best effort */ }
}

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint a link token; stores ONLY its hash. Returns the plaintext ONCE. */
export function mintLinkToken(dataDir: string, ownerUserId?: string): string {
  const token = randomBytes(32).toString('base64url');
  writeSyncHubFile(dataDir, {
    linkTokenHash: hashLinkToken(token),
    ...(ownerUserId ? { ownerUserId } : {}),
    createdAt: Date.now(),
  });
  return token;
}

export function revokeLinkToken(dataDir: string): void {
  const file = readSyncHubFile(dataDir);
  delete file.linkTokenHash;
  writeSyncHubFile(dataDir, file);
}

/** Timing-safe check of a presented bearer token against the stored hash. */
export function verifyLinkToken(dataDir: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const stored = readSyncHubFile(dataDir).linkTokenHash;
  if (!stored) return false;
  const a = Buffer.from(hashLinkToken(presented), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function linkTokenOwner(dataDir: string): string | undefined {
  return readSyncHubFile(dataDir).ownerUserId;
}

/**
 * Shared helper for surfaces that accept the sync link token as a service
 * credential (e.g. the instance's universal endpoint serving a proxied turn
 * from the owner's local app). Returns the owner principal identity the
 * token was minted for, or null when the token does not verify.
 */
export function resolveSyncServicePrincipal(
  dataDir: string,
  authorizationHeader: string | undefined,
): { userId: string; email?: string } | null {
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) return null;
  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!verifyLinkToken(dataDir, token)) return null;
  return { userId: linkTokenOwner(dataDir) ?? 'default-user' };
}
