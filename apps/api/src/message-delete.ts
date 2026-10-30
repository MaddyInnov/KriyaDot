// SPDX-License-Identifier: Apache-2.0
// Per-message delete for the user's OWN messages (Muse parity §4.5 C-9).
//
// Ownership is enforced SERVER-SIDE: a message is deletable only when
// its stored role is 'user' AND the session belongs to the requesting
// principal (when the host supplies an owner resolver). Assistant,
// tool and system messages can never be deleted through this route —
// the check reads the stored message, never a client claim.
//
// Deletion is a durable tombstone (<dataDir>/chat-message-deletions.db)
// applied by every read path the host wires through
// filterDeletedMessages(); when the host also supplies a hardDelete
// seam (SessionStore row removal) it runs too. The tombstone alone is
// sufficient: filtered messages disappear from thread logs, exports
// and shares even if the underlying row still exists.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Router } from 'express';
import { openDb, type IdentifiedMessage } from '@mvp/agent-runtime';

export interface DeletableCheck {
  ok: boolean;
  reason?: 'not-found' | 'not-own-message' | 'not-owner';
}

/** Pure ownership rule (C-9): only role==='user' messages are the user's own. */
export function checkDeletable(
  message: IdentifiedMessage | null,
  opts?: { sessionOwnerId?: string | null; requesterId?: string | null },
): DeletableCheck {
  if (!message) return { ok: false, reason: 'not-found' };
  if (message.role !== 'user') return { ok: false, reason: 'not-own-message' };
  if (opts?.sessionOwnerId != null && opts?.requesterId != null && opts.sessionOwnerId !== opts.requesterId) {
    return { ok: false, reason: 'not-owner' };
  }
  return { ok: true };
}

export class MessageDeletionStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'chat-message-deletions.db'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_deletions (
      session_id TEXT NOT NULL, message_id INTEGER NOT NULL, deleted_by TEXT NOT NULL,
      deleted_at TEXT NOT NULL, PRIMARY KEY (session_id, message_id));`);
  }
  mark(sessionId: string, messageId: number, deletedBy: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO message_deletions (session_id, message_id, deleted_by, deleted_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, messageId, deletedBy, new Date().toISOString());
  }
  isDeleted(sessionId: string, messageId: number): boolean {
    return this.db.prepare(`SELECT 1 FROM message_deletions WHERE session_id = ? AND message_id = ?`).get(sessionId, messageId) !== undefined;
  }
  deletedIds(sessionId: string): Set<number> {
    const rows = this.db.prepare(`SELECT message_id AS id FROM message_deletions WHERE session_id = ?`).all(sessionId) as unknown as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }
  close(): void { this.db.close(); }
}

/** Drop tombstoned messages from a thread log (host applies on read paths). */
export function filterDeletedMessages<T extends { id: number }>(store: MessageDeletionStore, sessionId: string, messages: T[]): T[] {
  const gone = store.deletedIds(sessionId);
  if (gone.size === 0) return messages;
  return messages.filter((m) => !gone.has(m.id));
}

export interface MessageDeleteDeps {
  store: MessageDeletionStore;
  listThreadMessages: (sessionId: string) => IdentifiedMessage[];
  /** Optional: the session's owner person id (OPEN-1 principal in the host). */
  sessionOwnerId?: (sessionId: string) => string | null | undefined;
  /** Optional: verified requester id for this request. */
  requesterId?: (req: express.Request) => string | null | undefined;
  /** Optional hard-delete seam (SessionStore row removal) run after tombstoning. */
  hardDelete?: (sessionId: string, messageId: number) => boolean;
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

export function createMessageDeleteRouter(deps: MessageDeleteDeps): Router {
  const router = express.Router({ mergeParams: true });
  router.delete('/sessions/:sessionId/messages/:messageId', (req, res) => {
    const messageId = Number(req.params.messageId);
    if (!Number.isFinite(messageId)) { res.status(400).json({ ok: false, error: 'messageId must be numeric' }); return; }
    const message = deps.listThreadMessages(req.params.sessionId).find((m) => m.id === messageId) ?? null;
    const check = checkDeletable(message, {
      sessionOwnerId: deps.sessionOwnerId?.(req.params.sessionId),
      requesterId: deps.requesterId?.(req),
    });
    if (!check.ok) {
      const status = check.reason === 'not-found' ? 404 : 403;
      const error = check.reason === 'not-found' ? 'message not found'
        : check.reason === 'not-owner' ? 'this conversation belongs to another user'
        : 'only your own messages can be deleted';
      res.status(status).json({ ok: false, error, reason: check.reason });
      return;
    }
    if (deps.store.isDeleted(req.params.sessionId, messageId)) {
      res.json({ ok: true, alreadyDeleted: true });
      return;
    }
    const by = deps.requesterId?.(req) ?? 'user';
    deps.store.mark(req.params.sessionId, messageId, by);
    const hardDeleted = deps.hardDelete ? deps.hardDelete(req.params.sessionId, messageId) : false;
    deps.audit?.('chat.message_delete', { detail: { sessionId: req.params.sessionId, messageId, hardDeleted } });
    res.json({ ok: true, deleted: true, hardDeleted });
  });
  return router;
}
