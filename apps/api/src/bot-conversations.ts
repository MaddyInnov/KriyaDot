// SPDX-License-Identifier: Apache-2.0
// Bot-to-bot conversation sheets — data model.
//
// Read-only pair history: for any bot pair (A, B), the chronological list of
// ask_bot / message_bot exchanges between them (Codync: botConversation).
//
// Storage: <dataDir>/bot-conversations.db (SQLite, node:sqlite). Separate DB
// so no schema migration is needed elsewhere.
//
// Exchange ids: bex_<base36time>_<rand> (opaque strings, like group ids).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BotExchange } from '@mvp/agent-runtime';
import { parseProvenanceNote, serializeProvenanceNote } from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export type { BotExchange };

export function newExchangeId(): string {
  return `bex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const EXCHANGE_ID_RE = /^bex_[a-z0-9]+_[a-z0-9]+$/;

/** Canonical pair key — order-independent so (A,B) === (B,A). */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('⇄');
}

/** Persistent bot-to-bot exchanges: <dataDir>/bot-conversations.db. */
export class BotConversationStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'bot-conversations.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_exchanges (
        exchange_id TEXT PRIMARY KEY,
        source_bot_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        pair_key TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        reply TEXT,
        status TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bot_exchanges_pair ON bot_exchanges(pair_key, created_at);
    `);
    // P1 #13: provenance column for existing databases.
    try {
      this.db.exec('ALTER TABLE bot_exchanges ADD COLUMN provenance_json TEXT');
    } catch {
      // Column already exists — safe to ignore.
    }
  }

  record(exchange: Omit<BotExchange, 'id' | 'createdAt'>): BotExchange {
    const id = newExchangeId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO bot_exchanges
           (exchange_id, source_bot_id, target_bot_id, pair_key, type, text, reply, status, detail, created_at, completed_at, provenance_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        exchange.sourceBotId,
        exchange.targetBotId,
        pairKey(exchange.sourceBotId, exchange.targetBotId),
        exchange.type,
        exchange.text,
        exchange.reply ?? null,
        exchange.status,
        exchange.detail ?? null,
        createdAt,
        exchange.completedAt ?? null,
        exchange.provenance ? serializeProvenanceNote(exchange.provenance) : null,
      );
    return { ...exchange, id, createdAt };
  }

  update(id: string, updates: Partial<BotExchange>): boolean {
    const fields: string[] = [];
    const values: Array<string | number | bigint | Buffer | null> = [];
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.reply !== undefined) {
      fields.push('reply = ?');
      values.push(updates.reply);
    }
    if (updates.detail !== undefined) {
      fields.push('detail = ?');
      values.push(updates.detail);
    }
    if (updates.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completedAt);
    }
    if (fields.length === 0) return false;
    values.push(id);
    const result = this.db
      .prepare(`UPDATE bot_exchanges SET ${fields.join(', ')} WHERE exchange_id = ?`)
      .run(...values);
    return result.changes > 0;
  }

  get(id: string): BotExchange | null {
    if (!EXCHANGE_ID_RE.test(id)) return null;
    const row = this.db.prepare(`SELECT * FROM bot_exchanges WHERE exchange_id = ?`).get(id) as unknown as
      | Row
      | undefined;
    return row ? rowToExchange(row) : null;
  }

  /**
   * Pair history, oldest first (Codync: newest 200, oldest first).
   * Direction is per-exchange (source → target).
   */
  listPair(botId: string, otherBotId: string, limit = 200): BotExchange[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bot_exchanges WHERE pair_key = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(pairKey(botId, otherBotId), limit) as unknown as Row[];
    return rows.map(rowToExchange);
  }

  /** All peers a bot has exchanged with (for a peer list UI). */
  listPeers(botId: string): Array<{ peerId: string; exchangeCount: number; lastAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT
           CASE WHEN source_bot_id = ? THEN target_bot_id ELSE source_bot_id END AS peer_id,
           COUNT(*) AS n,
           MAX(created_at) AS last_at
         FROM bot_exchanges
         WHERE source_bot_id = ? OR target_bot_id = ?
         GROUP BY peer_id
         ORDER BY last_at DESC`,
      )
      .all(botId, botId, botId) as Array<{ peer_id: string; n: number; last_at: string }>;
    return rows.map((r) => ({ peerId: r.peer_id, exchangeCount: r.n, lastAt: r.last_at }));
  }

  close(): void {
    this.db.close();
  }
}

interface Row {
  exchange_id: string;
  source_bot_id: string;
  target_bot_id: string;
  type: 'ask' | 'message';
  text: string;
  reply: string | null;
  status: 'pending' | 'completed' | 'failed';
  detail: string | null;
  created_at: string;
  completed_at: string | null;
  provenance_json: string | null;
}

function rowToExchange(row: Row): BotExchange {
  let provenance: BotExchange['provenance'];
  if (row.provenance_json) {
    try {
      provenance = parseProvenanceNote(JSON.parse(row.provenance_json));
    } catch {
      provenance = undefined;
    }
  }
  return {
    id: row.exchange_id,
    sourceBotId: row.source_bot_id,
    targetBotId: row.target_bot_id,
    type: row.type,
    text: row.text,
    reply: row.reply ?? undefined,
    status: row.status,
    detail: row.detail ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    provenance,
  };
}
