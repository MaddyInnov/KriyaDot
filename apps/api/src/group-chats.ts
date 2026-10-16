// SPDX-License-Identifier: Apache-2.0
// Group chats (multi-bot rooms) — data model.
//
// A group is a roster row holding several bots + the user. It has a
// transcript but no agent, folder or harness of its own (Codync's model:
// host/src/store/model.rs `kind: "group"`).
//
//   GroupChat    { id, name, description, memberBotIds[], createdAt }
//   GroupMessage { id, groupId, authorType: 'user'|'bot', authorBotId, text,
//                  threadId (nullable — per-message threads reuse the
//                  message-threads infra), createdAt }
//
// Storage: <dataDir>/group-chats.db (SQLite, node:sqlite). Separate from
// the agent-runtime session store so no schema migration is needed there.
//
// ID formats:
//   group:   grp_<base36time>_<rand>
//   message: gmsg_<base36time>_<rand>  (opaque strings, like thread ids)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export interface GroupChat {
  id: string;
  name: string;
  description: string | null;
  memberBotIds: string[];
  createdAt: string;
}

export type GroupMessageAuthor = 'user' | 'bot';

export interface GroupMessage {
  id: string;
  groupId: string;
  authorType: GroupMessageAuthor;
  /** Bot id when authorType === 'bot'; null for the user. */
  authorBotId: string | null;
  text: string;
  /** Thread id when this message has a reply thread (message-threads infra). */
  threadId: string | null;
  createdAt: string;
}

export function newGroupId(): string {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newGroupMessageId(): string {
  return `gmsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const GROUP_ID_RE = /^grp_[a-z0-9]+_[a-z0-9]+$/;
const MAX_NAME_LEN = 80;
const MAX_MEMBERS = 20;

export function validGroupName(name: unknown): name is string {
  return (
    typeof name === 'string' && name.trim().length > 0 && name.trim().length <= MAX_NAME_LEN
  );
}

export function validBotIdList(ids: unknown): ids is string[] {
  return (
    Array.isArray(ids) &&
    ids.length >= 1 &&
    ids.length <= MAX_MEMBERS &&
    ids.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)) &&
    new Set(ids).size === ids.length // distinct
  );
}

/** Persistent group chats + messages: <dataDir>/group-chats.db. */
export class GroupChatStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'group-chats.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        member_bot_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_messages (
        message_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        author_type TEXT NOT NULL,
        author_bot_id TEXT,
        text TEXT NOT NULL,
        thread_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, created_at);
    `);
  }

  createGroup(name: string, memberBotIds: string[], description?: string): GroupChat {
    const id = newGroupId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO groups (group_id, name, description, member_bot_ids, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name.trim(), description?.trim() || null, JSON.stringify(memberBotIds), createdAt);
    return { id, name: name.trim(), description: description?.trim() || null, memberBotIds, createdAt };
  }

  getGroup(groupId: string): GroupChat | null {
    const row = this.db.prepare(`SELECT * FROM groups WHERE group_id = ?`).get(groupId) as
      | { group_id: string; name: string; description: string | null; member_bot_ids: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.group_id,
      name: row.name,
      description: row.description,
      memberBotIds: JSON.parse(row.member_bot_ids) as string[],
      createdAt: row.created_at,
    };
  }

  listGroups(): GroupChat[] {
    const rows = this.db.prepare(`SELECT * FROM groups ORDER BY created_at DESC`).all() as Array<{
      group_id: string;
      name: string;
      description: string | null;
      member_bot_ids: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.group_id,
      name: row.name,
      description: row.description,
      memberBotIds: JSON.parse(row.member_bot_ids) as string[],
      createdAt: row.created_at,
    }));
  }

  updateGroup(
    groupId: string,
    updates: { name?: string; description?: string | null; memberBotIds?: string[] },
  ): GroupChat | null {
    const existing = this.getGroup(groupId);
    if (!existing) return null;
    const name = updates.name !== undefined ? updates.name.trim() : existing.name;
    const description =
      updates.description !== undefined ? updates.description?.trim() || null : existing.description;
    const memberBotIds = updates.memberBotIds ?? existing.memberBotIds;
    this.db
      .prepare(`UPDATE groups SET name = ?, description = ?, member_bot_ids = ? WHERE group_id = ?`)
      .run(name, description, JSON.stringify(memberBotIds), groupId);
    return { ...existing, name, description, memberBotIds };
  }

  deleteGroup(groupId: string): boolean {
    const result = this.db.prepare(`DELETE FROM groups WHERE group_id = ?`).run(groupId);
    this.db.prepare(`DELETE FROM group_messages WHERE group_id = ?`).run(groupId);
    return result.changes > 0;
  }

  /** Find a group whose member set exactly matches (dedupe on create). */
  findByMembers(memberBotIds: string[]): GroupChat | null {
    const sorted = [...memberBotIds].sort();
    for (const group of this.listGroups()) {
      const gSorted = [...group.memberBotIds].sort();
      if (gSorted.length === sorted.length && gSorted.every((id, i) => id === sorted[i])) {
        return group;
      }
    }
    return null;
  }

  addMessage(
    groupId: string,
    authorType: GroupMessageAuthor,
    text: string,
    authorBotId?: string | null,
  ): GroupMessage {
    const id = newGroupMessageId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO group_messages (message_id, group_id, author_type, author_bot_id, text, thread_id, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, groupId, authorType, authorBotId ?? null, text, createdAt);
    return { id, groupId, authorType, authorBotId: authorBotId ?? null, text, threadId: null, createdAt };
  }

  listMessages(groupId: string, limit = 200): GroupMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM group_messages WHERE group_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(groupId, limit) as Array<{
      message_id: string;
      group_id: string;
      author_type: GroupMessageAuthor;
      author_bot_id: string | null;
      text: string;
      thread_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.message_id,
      groupId: row.group_id,
      authorType: row.author_type,
      authorBotId: row.author_bot_id,
      text: row.text,
      threadId: row.thread_id,
      createdAt: row.created_at,
    }));
  }

  /** Link a reply thread to a group message (message-threads infra). */
  setMessageThread(messageId: string, threadId: string): boolean {
    const result = this.db
      .prepare(`UPDATE group_messages SET thread_id = ? WHERE message_id = ?`)
      .run(threadId, messageId);
    return result.changes > 0;
  }

  getMessage(messageId: string): GroupMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM group_messages WHERE message_id = ?`)
      .get(messageId) as
      | {
          message_id: string;
          group_id: string;
          author_type: GroupMessageAuthor;
          author_bot_id: string | null;
          text: string;
          thread_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.message_id,
      groupId: row.group_id,
      authorType: row.author_type,
      authorBotId: row.author_bot_id,
      text: row.text,
      threadId: row.thread_id,
      createdAt: row.created_at,
    };
  }

  /** Remove references to a deleted bot from all groups. Returns affected group ids. */
  removeBotFromGroups(botId: string): string[] {
    const affected: string[] = [];
    for (const group of this.listGroups()) {
      if (group.memberBotIds.includes(botId)) {
        const remaining = group.memberBotIds.filter((id) => id !== botId);
        if (remaining.length === 0) {
          // A group with no members is deleted (Codync: groups need ≥1 member).
          this.deleteGroup(group.id);
        } else {
          this.updateGroup(group.id, { memberBotIds: remaining });
        }
        affected.push(group.id);
      }
    }
    return affected;
  }

  isValidGroupId(id: string): boolean {
    return GROUP_ID_RE.test(id);
  }

  close(): void {
    this.db.close();
  }
}
