// SPDX-License-Identifier: Apache-2.0
// Per-message metadata sidecar (OH-3): additive key/value metadata for
// persisted chat messages, stored OUTSIDE the session store in its own
// SQLite DB (`message-meta.db`) — the same sidecar pattern as message
// reactions (message-reactions.db). The session store's message rows
// stay untouched; this store keys extra fields by (sessionId,
// messageId) so surfaces like cited recall (`memoryUsed`) and automatic
// model routing (`modelRoute`) can ride a persisted assistant message
// without a schema migration.
//
// Values are JSON; keys are namespaced by their producer ('memoryUsed',
// 'modelRoute'). Writes merge per key. Reads never throw on a missing
// row — absent metadata reads as an empty object (callers treat a
// missing key as "field absent", keeping payloads clean).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';

export class MessageMetaStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'message-meta.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_meta (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_message_meta_session
        ON message_meta (session_id, message_id);
    `);
  }

  /** Merge one metadata key onto a message. */
  set(sessionId: string, messageId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO message_meta (session_id, message_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, message_id, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(sessionId, String(messageId), key, JSON.stringify(value ?? null), new Date().toISOString());
  }

  /** All metadata keys for one message ({} when none). */
  get(sessionId: string, messageId: string): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value_json AS valueJson FROM message_meta WHERE session_id = ? AND message_id = ?')
      .all(sessionId, String(messageId)) as unknown as Array<{ key: string; valueJson: string }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.valueJson) as unknown;
      } catch {
        // Corrupt row: skip the key rather than break the read.
      }
    }
    return out;
  }

  /** Metadata for many messages in one session: messageId → meta object. */
  getForSession(sessionId: string, messageIds: string[]): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    if (messageIds.length === 0) return out;
    const wanted = new Set(messageIds.map(String));
    const rows = this.db
      .prepare('SELECT message_id AS messageId, key, value_json AS valueJson FROM message_meta WHERE session_id = ?')
      .all(sessionId) as unknown as Array<{ messageId: string; key: string; valueJson: string }>;
    for (const r of rows) {
      if (!wanted.has(String(r.messageId))) continue;
      const meta = out.get(String(r.messageId)) ?? {};
      try {
        meta[r.key] = JSON.parse(r.valueJson) as unknown;
      } catch {
        continue;
      }
      out.set(String(r.messageId), meta);
    }
    return out;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
