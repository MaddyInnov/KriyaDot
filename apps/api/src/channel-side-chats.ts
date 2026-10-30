// SPDX-License-Identifier: Apache-2.0
// Durable provider side chats (Muse parity §4.6: CH-1 / CH-5 / CH-6 / CH-9).
//
// Muse's model: a connected messaging app is the transport for ONE
// personal side chat with your agent. KriyaDot's channels were bot-platform
// endpoints with only a capped in-memory inbound log — no durable, titled
// side-chat object at all. This store is that object:
//
//   CH-1  One-transcript mirroring rule: exactly ONE side chat exists per
//         (providerId, externalChatId). Every mirrored message is stored
//         exactly once — provider message ids are UNIQUE in the store, so
//         webhook retries / redeliveries dedupe instead of duplicating.
//         There is no second copy: the main chat never receives these
//         messages, and this store is the single transcript.
//   CH-5  The side chat is durable (SQLite), titled by provider —
//         "WhatsApp · <contact or number>" — and its history lives here,
//         separate from the main chat history.
//   CH-6  Inbound messages keep their typed attachment and their quote:
//         a quoted provider id is resolved to the mirrored message it
//         refers to (quotedMessageId) when that message is in the
//         transcript; the raw provider id is always preserved.
//   CH-9  Reaction state is kept on the mirrored message (emoji + actor),
//         which the routes layer bridges to/from the in-app reaction store.
//
// Storage: <dataDir>/channel-side-chats.db (SQLite, node:sqlite) — its own
// DB so no migration is needed elsewhere.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';
import type { WhatsAppAttachment } from './whatsapp-cloud.js';

export type SideChatDirection = 'in' | 'out';
export type SideChatMessageKind =
  | 'text'
  | 'image'
  | 'document'
  | 'video'
  | 'audio'
  | 'voice'
  | 'sticker'
  | 'location'
  | 'card'
  | 'approval'
  | 'system';

export interface SideChat {
  id: string;
  providerId: string;
  /** Provider-side chat identifier (WhatsApp: the counterparty number). */
  externalChatId: string;
  /** Durable title, e.g. "WhatsApp · Asha Rao". */
  title: string;
  contactName?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SideChatReaction {
  emoji: string;
  actor: string;
  at: string;
}

export interface SideChatMessage {
  id: string;
  sideChatId: string;
  direction: SideChatDirection;
  kind: SideChatMessageKind;
  /** Provider message id (wamid etc.) — unique per side chat (CH-1 dedupe). */
  providerMessageId?: string;
  text?: string;
  attachment?: WhatsAppAttachment;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** In-app id of the mirrored message this one quotes (CH-6), when resolved. */
  quotedMessageId?: string;
  /** Raw provider id of the quoted message (always preserved). */
  quotedProviderMessageId?: string;
  /** Reactions currently on this message (CH-9 mirror state). */
  reactions: SideChatReaction[];
  createdAt: string;
}

export function sideChatIdFor(providerId: string, externalChatId: string): string {
  // Deterministic: one (provider, chat) pair can only ever map to one id.
  const slug = `${providerId}:${externalChatId}`.replace(/[^a-zA-Z0-9:_+.-]+/g, '_');
  return `sidechat_${slug}`;
}

export function sideChatTitle(providerId: string, externalChatId: string, contactName?: string): string {
  const label =
    providerId === 'whatsapp'
      ? 'WhatsApp'
      : providerId.charAt(0).toUpperCase() + providerId.slice(1);
  return `${label} · ${contactName?.trim() || externalChatId}`;
}

export interface MirrorInboundInput {
  providerId: string;
  externalChatId: string;
  providerMessageId?: string;
  direction: SideChatDirection;
  kind: SideChatMessageKind;
  text?: string;
  attachment?: WhatsAppAttachment;
  location?: SideChatMessage['location'];
  quotedProviderMessageId?: string;
  contactName?: string;
  atMs?: number;
}

interface ChatRow {
  id: string;
  provider_id: string;
  external_chat_id: string;
  title: string;
  contact_name: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface MsgRow {
  id: string;
  side_chat_id: string;
  direction: SideChatDirection;
  kind: SideChatMessageKind;
  provider_message_id: string | null;
  text: string | null;
  attachment_json: string | null;
  location_json: string | null;
  quoted_message_id: string | null;
  quoted_provider_message_id: string | null;
  reactions_json: string | null;
  created_at: string;
}

function rowToChat(r: ChatRow): SideChat {
  return {
    id: r.id,
    providerId: r.provider_id,
    externalChatId: r.external_chat_id,
    title: r.title,
    ...(r.contact_name ? { contactName: r.contact_name } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
  };
}

function rowToMessage(r: MsgRow): SideChatMessage {
  return {
    id: r.id,
    sideChatId: r.side_chat_id,
    direction: r.direction,
    kind: r.kind,
    ...(r.provider_message_id ? { providerMessageId: r.provider_message_id } : {}),
    ...(r.text !== null ? { text: r.text } : {}),
    ...(r.attachment_json ? { attachment: JSON.parse(r.attachment_json) as WhatsAppAttachment } : {}),
    ...(r.location_json ? { location: JSON.parse(r.location_json) as SideChatMessage['location'] } : {}),
    ...(r.quoted_message_id ? { quotedMessageId: r.quoted_message_id } : {}),
    ...(r.quoted_provider_message_id ? { quotedProviderMessageId: r.quoted_provider_message_id } : {}),
    reactions: r.reactions_json ? (JSON.parse(r.reactions_json) as SideChatReaction[]) : [],
    createdAt: r.created_at,
  };
}

let seq = 0;
function newMessageId(): string {
  seq += 1;
  return `scm_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ChannelSideChatStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'channel-side-chats.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS side_chats (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        contact_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(provider_id, external_chat_id)
      );
      CREATE TABLE IF NOT EXISTS side_chat_messages (
        id TEXT PRIMARY KEY,
        side_chat_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider_message_id TEXT,
        text TEXT,
        attachment_json TEXT,
        location_json TEXT,
        quoted_message_id TEXT,
        quoted_provider_message_id TEXT,
        reactions_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_provider_msg
        ON side_chat_messages(side_chat_id, provider_message_id)
        WHERE provider_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_scm_chat_time ON side_chat_messages(side_chat_id, created_at);
    `);
  }

  /** Get-or-create the ONE side chat for a (provider, external chat) pair. */
  ensureChat(providerId: string, externalChatId: string, contactName?: string): SideChat {
    const id = sideChatIdFor(providerId, externalChatId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO side_chats (id, provider_id, external_chat_id, title, contact_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, external_chat_id) DO NOTHING`,
      )
      .run(id, providerId, externalChatId, sideChatTitle(providerId, externalChatId, contactName), contactName ?? null, now, now);
    if (contactName) {
      // A later contact name refines the title once; never blanks it out.
      this.db
        .prepare(`UPDATE side_chats SET contact_name = ?, title = ? WHERE id = ? AND (contact_name IS NULL OR contact_name = '')`)
        .run(contactName, sideChatTitle(providerId, externalChatId, contactName), id);
    }
    return this.getChat(id)!;
  }

  getChat(id: string): SideChat | null {
    const row = this.db.prepare(`SELECT * FROM side_chats WHERE id = ?`).get(id) as unknown as ChatRow | undefined;
    return row ? rowToChat(row) : null;
  }

  getChatByExternal(providerId: string, externalChatId: string): SideChat | null {
    const row = this.db
      .prepare(`SELECT * FROM side_chats WHERE provider_id = ? AND external_chat_id = ?`)
      .get(providerId, externalChatId) as unknown as ChatRow | undefined;
    return row ? rowToChat(row) : null;
  }

  listChats(providerId?: string): SideChat[] {
    const rows = (providerId
      ? this.db.prepare(`SELECT * FROM side_chats WHERE provider_id = ? ORDER BY updated_at DESC`).all(providerId)
      : this.db.prepare(`SELECT * FROM side_chats ORDER BY updated_at DESC`).all()) as unknown as ChatRow[];
    return rows.map(rowToChat);
  }

  /**
   * Mirror one message into the transcript. Returns the stored message and
   * whether it was newly inserted — a redelivery with the same provider
   * message id returns the EXISTING row with inserted=false (CH-1).
   */
  mirrorMessage(input: MirrorInboundInput): { message: SideChatMessage; inserted: boolean; chat: SideChat } {
    const chat = this.ensureChat(input.providerId, input.externalChatId, input.contactName);
    if (input.providerMessageId) {
      const existing = this.db
        .prepare(`SELECT * FROM side_chat_messages WHERE side_chat_id = ? AND provider_message_id = ?`)
        .get(chat.id, input.providerMessageId) as unknown as MsgRow | undefined;
      if (existing) return { message: rowToMessage(existing), inserted: false, chat };
    }
    // CH-6: resolve the quote against the transcript when possible.
    let quotedMessageId: string | undefined;
    if (input.quotedProviderMessageId) {
      const quoted = this.db
        .prepare(`SELECT id FROM side_chat_messages WHERE side_chat_id = ? AND provider_message_id = ?`)
        .get(chat.id, input.quotedProviderMessageId) as unknown as { id: string } | undefined;
      quotedMessageId = quoted?.id;
    }
    const id = newMessageId();
    const createdAt = new Date(input.atMs ?? Date.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO side_chat_messages
           (id, side_chat_id, direction, kind, provider_message_id, text, attachment_json, location_json,
            quoted_message_id, quoted_provider_message_id, reactions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
      )
      .run(
        id,
        chat.id,
        input.direction,
        input.kind,
        input.providerMessageId ?? null,
        input.text ?? null,
        input.attachment ? JSON.stringify(input.attachment) : null,
        input.location ? JSON.stringify(input.location) : null,
        quotedMessageId ?? null,
        input.quotedProviderMessageId ?? null,
        createdAt,
      );
    this.db
      .prepare(`UPDATE side_chats SET updated_at = ?, message_count = message_count + 1 WHERE id = ?`)
      .run(createdAt, chat.id);
    const row = this.db.prepare(`SELECT * FROM side_chat_messages WHERE id = ?`).get(id) as unknown as MsgRow;
    return { message: rowToMessage(row), inserted: true, chat: this.getChat(chat.id)! };
  }

  listMessages(sideChatId: string, limit = 200): SideChatMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM side_chat_messages WHERE side_chat_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(sideChatId, limit) as unknown as MsgRow[];
    return rows.map(rowToMessage);
  }

  getMessageByProviderId(sideChatId: string, providerMessageId: string): SideChatMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM side_chat_messages WHERE side_chat_id = ? AND provider_message_id = ?`)
      .get(sideChatId, providerMessageId) as unknown as MsgRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getMessage(id: string): SideChatMessage | null {
    const row = this.db.prepare(`SELECT * FROM side_chat_messages WHERE id = ?`).get(id) as unknown as MsgRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  /**
   * Set/replace one actor's reaction on a mirrored message (CH-9 state).
   * An empty emoji removes that actor's reaction. Returns the updated
   * message, or null when the target message is not in the transcript.
   */
  applyReaction(sideChatId: string, targetProviderMessageId: string, emoji: string, actor: string): SideChatMessage | null {
    const target = this.getMessageByProviderId(sideChatId, targetProviderMessageId);
    if (!target) return null;
    const next = target.reactions.filter((r) => r.actor !== actor);
    if (emoji) next.push({ emoji, actor, at: new Date().toISOString() });
    this.db
      .prepare(`UPDATE side_chat_messages SET reactions_json = ? WHERE id = ?`)
      .run(JSON.stringify(next), target.id);
    return this.getMessage(target.id);
  }

  close(): void {
    this.db.close();
  }
}
