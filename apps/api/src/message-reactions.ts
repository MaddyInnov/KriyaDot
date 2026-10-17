// SPDX-License-Identifier: Apache-2.0
// Message reactions (Codync parity): emoji reactions on chat messages.
//
// Storage: separate SQLite DB (`message-reactions.db`) using node:sqlite —
// no migration needed on the session store. Reactions are keyed by
// (sessionId, messageId).
//
// Rules (matching Codync):
// - Max 8 reactions per message; oldest evicted when exceeding.
// - Toggle semantics: reacting with the same emoji twice removes it.
// - Reacted messages are exempt from auto-mark-as-unread.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from '@mvp/agent-runtime';

export interface MessageReaction {
  emoji: string;
  userId: string;
  createdAt: string;
}

/** Max reactions stored per message (oldest evicted first). */
export const MAX_REACTIONS_PER_MESSAGE = 8;

/** Common emoji picker options for the web client. */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export class MessageReactionStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'message-reactions.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id, emoji, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions (session_id, message_id, created_at);
    `);
  }

  /** List reactions for a message, oldest first. */
  list(sessionId: string, messageId: string): MessageReaction[] {
    const rows = this.db
      .prepare(
        `SELECT emoji, user_id AS userId, created_at AS createdAt
         FROM reactions WHERE session_id = ? AND message_id = ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId, messageId) as unknown as MessageReaction[];
    return rows;
  }

  /** List reactions for multiple messages in one query. Returns map messageId → reactions. */
  listForMessages(sessionId: string, messageIds: string[]): Map<string, MessageReaction[]> {
    const out = new Map<string, MessageReaction[]>();
    if (messageIds.length === 0) return out;
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT message_id AS messageId, emoji, user_id AS userId, created_at AS createdAt
         FROM reactions WHERE session_id = ? AND message_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(sessionId, ...messageIds) as unknown as Array<MessageReaction & { messageId: string }>;
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      list.push({ emoji: r.emoji, userId: r.userId, createdAt: r.createdAt });
      out.set(r.messageId, list);
    }
    return out;
  }

  /**
   * Toggle a reaction. If the user already reacted with this emoji, remove
   * it; otherwise add it (evicting oldest if at cap). Returns the updated
   * reaction list and whether the reaction was added (true) or removed.
   */
  toggle(sessionId: string, messageId: string, emoji: string, userId: string): { reactions: MessageReaction[]; added: boolean } {
    if (!emoji || typeof emoji !== 'string' || [...emoji].length > 8) {
      throw new Error('invalid emoji');
    }
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId is required');
    }
    const existing = this.db
      .prepare(
        `SELECT 1 FROM reactions WHERE session_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
      )
      .get(sessionId, messageId, emoji, userId);
    if (existing) {
      this.db
        .prepare(
          `DELETE FROM reactions WHERE session_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
        )
        .run(sessionId, messageId, emoji, userId);
      return { reactions: this.list(sessionId, messageId), added: false };
    }
    // Enforce cap: evict oldest until under limit.
    const count = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM reactions WHERE session_id = ? AND message_id = ?`)
        .get(sessionId, messageId) as { n: number }
    ).n;
    if (count >= MAX_REACTIONS_PER_MESSAGE) {
      const toEvict = count - MAX_REACTIONS_PER_MESSAGE + 1;
      this.db
        .prepare(
          `DELETE FROM reactions WHERE rowid IN (
             SELECT rowid FROM reactions
             WHERE session_id = ? AND message_id = ?
             ORDER BY created_at ASC LIMIT ?
           )`,
        )
        .run(sessionId, messageId, toEvict);
    }
    this.db
      .prepare(
        `INSERT INTO reactions (session_id, message_id, emoji, user_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, messageId, emoji, userId, new Date().toISOString());
    return { reactions: this.list(sessionId, messageId), added: true };
  }

  /** Remove all reactions for a message (e.g. on message delete). */
  clearMessage(sessionId: string, messageId: string): void {
    this.db.prepare(`DELETE FROM reactions WHERE session_id = ? AND message_id = ?`).run(sessionId, messageId);
  }

  close(): void {
    this.db.close();
  }
}
