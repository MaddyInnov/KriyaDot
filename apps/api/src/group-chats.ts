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
import type { ProvenanceNote } from '@mvp/agent-runtime';
import { parseProvenanceNote, serializeProvenanceNote } from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export interface GroupChat {
  id: string;
  name: string;
  description: string | null;
  memberBotIds: string[];
  createdAt: string;
}

export type GroupMessageAuthor = 'user' | 'bot' | 'system';

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
  /**
   * Provenance note (P1 #13) — set on bot messages: origin + relay path,
   * shown in the room as a "via …" chip with an untrusted-origin badge.
   */
  provenance?: ProvenanceNote;
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

/** Per-room robustness overrides. Null fields fall back to global defaults. */
export interface RoomSettingsRow {
  groupId: string;
  turnTimeoutMin: number | null;
  maxPostsPerMemberPerTurn: number | null;
  postsPerMinute: number | null;
  duplicateRepeatLimit: number | null;
  maxHeld: number | null;
  holdState: 'active' | 'held' | 'halted';
}

/** A recorded member-turn failure, retryable via the API. */
export interface RoomFailure {
  id: string;
  groupId: string;
  botId: string;
  botName: string;
  round: number;
  prompt: string;
  userText: string;
  error: string;
  createdAt: string;
  retried: boolean;
  resolvedMessageId: string | null;
}

export function newRoomFailureId(): string {
  return `rfail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const HOLD_STATES = new Set(['active', 'held', 'halted']);

export function validHoldState(s: unknown): s is 'active' | 'held' | 'halted' {
  return typeof s === 'string' && HOLD_STATES.has(s);
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
    // P1 #13: provenance column for existing databases.
    try {
      this.db.exec('ALTER TABLE group_messages ADD COLUMN provenance_json TEXT');
    } catch {
      // Column already exists — safe to ignore.
    }
    this.db.exec(`
      -- Room robustness (OpenMausBot parity): per-room settings + hold state.
      CREATE TABLE IF NOT EXISTS room_settings (
        group_id TEXT PRIMARY KEY,
        turn_timeout_min INTEGER,
        max_posts_per_member_per_turn INTEGER,
        posts_per_minute INTEGER,
        duplicate_repeat_limit INTEGER,
        max_held INTEGER,
        hold_state TEXT NOT NULL DEFAULT 'active',
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
      );
      -- Failed member turns, for retry (room robustness).
      CREATE TABLE IF NOT EXISTS room_failures (
        failure_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        round INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        user_text TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retried INTEGER NOT NULL DEFAULT 0,
        resolved_message_id TEXT,
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_room_failures_group ON room_failures(group_id, created_at);
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
    this.db.prepare(`DELETE FROM room_settings WHERE group_id = ?`).run(groupId);
    this.db.prepare(`DELETE FROM room_failures WHERE group_id = ?`).run(groupId);
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
    provenance?: ProvenanceNote,
  ): GroupMessage {
    const id = newGroupMessageId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO group_messages (message_id, group_id, author_type, author_bot_id, text, thread_id, created_at, provenance_json)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        groupId,
        authorType,
        authorBotId ?? null,
        text,
        createdAt,
        provenance ? serializeProvenanceNote(provenance) : null,
      );
    return {
      id,
      groupId,
      authorType,
      authorBotId: authorBotId ?? null,
      text,
      threadId: null,
      createdAt,
      provenance,
    };
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
      provenance_json: string | null;
    }>;
    return rows.map((row) => {
      let provenance: ProvenanceNote | undefined;
      if (row.provenance_json) {
        try {
          provenance = parseProvenanceNote(JSON.parse(row.provenance_json));
        } catch {
          provenance = undefined;
        }
      }
      return {
        id: row.message_id,
        groupId: row.group_id,
        authorType: row.author_type,
        authorBotId: row.author_bot_id,
        text: row.text,
        threadId: row.thread_id,
        createdAt: row.created_at,
        provenance,
      };
    });
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

  // ---- Room robustness ----------------------------------------------------

  /** Raw settings row (nulls = use global default). Creates the row lazily. */
  getRoomSettingsRow(groupId: string): RoomSettingsRow {
    let row = this.db
      .prepare(`SELECT * FROM room_settings WHERE group_id = ?`)
      .get(groupId) as
      | {
          group_id: string;
          turn_timeout_min: number | null;
          max_posts_per_member_per_turn: number | null;
          posts_per_minute: number | null;
          duplicate_repeat_limit: number | null;
          max_held: number | null;
          hold_state: string;
        }
      | undefined;
    if (!row) {
      this.db
        .prepare(`INSERT INTO room_settings (group_id, hold_state) VALUES (?, 'active')`)
        .run(groupId);
      row = {
        group_id: groupId,
        turn_timeout_min: null,
        max_posts_per_member_per_turn: null,
        posts_per_minute: null,
        duplicate_repeat_limit: null,
        max_held: null,
        hold_state: 'active',
      };
    }
    return {
      groupId: row.group_id,
      turnTimeoutMin: row.turn_timeout_min,
      maxPostsPerMemberPerTurn: row.max_posts_per_member_per_turn,
      postsPerMinute: row.posts_per_minute,
      duplicateRepeatLimit: row.duplicate_repeat_limit,
      maxHeld: row.max_held,
      holdState: validHoldState(row.hold_state) ? row.hold_state : 'active',
    };
  }

  /** Partial update of per-room robustness settings. Unknown keys ignored. */
  saveRoomSettings(
    groupId: string,
    patch: Partial<{
      turnTimeoutMin: number;
      maxPostsPerMemberPerTurn: number;
      postsPerMinute: number;
      duplicateRepeatLimit: number;
      maxHeld: number;
    }>,
  ): RoomSettingsRow {
    this.getRoomSettingsRow(groupId); // ensure row exists
    const cols: Array<[string, number]> = [];
    const put = (col: string, v: number | null | undefined): void => {
      if (v !== undefined && v !== null) cols.push([col, v]);
    };
    put('turn_timeout_min', patch.turnTimeoutMin);
    put('max_posts_per_member_per_turn', patch.maxPostsPerMemberPerTurn);
    put('posts_per_minute', patch.postsPerMinute);
    put('duplicate_repeat_limit', patch.duplicateRepeatLimit);
    put('max_held', patch.maxHeld);
    for (const [col, val] of cols) {
      this.db.prepare(`UPDATE room_settings SET ${col} = ? WHERE group_id = ?`).run(val, groupId);
    }
    return this.getRoomSettingsRow(groupId);
  }

  /** Reset per-room overrides back to global defaults (keeps hold state). */
  clearRoomSettings(groupId: string): RoomSettingsRow {
    this.getRoomSettingsRow(groupId);
    this.db
      .prepare(
        `UPDATE room_settings
         SET turn_timeout_min = NULL, max_posts_per_member_per_turn = NULL,
             posts_per_minute = NULL, duplicate_repeat_limit = NULL, max_held = NULL
         WHERE group_id = ?`,
      )
      .run(groupId);
    return this.getRoomSettingsRow(groupId);
  }

  setHoldState(groupId: string, state: 'active' | 'held' | 'halted'): void {
    this.getRoomSettingsRow(groupId);
    this.db.prepare(`UPDATE room_settings SET hold_state = ? WHERE group_id = ?`).run(state, groupId);
  }

  /** Persist a system notice into the room transcript (timeouts, breaker, holds). */
  addSystemMessage(groupId: string, text: string): GroupMessage {
    return this.addMessage(groupId, 'system', text, null);
  }

  recordRoomFailure(args: {
    groupId: string;
    botId: string;
    botName: string;
    round: number;
    prompt: string;
    userText: string;
    error: string;
  }): RoomFailure {
    const id = newRoomFailureId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO room_failures
           (failure_id, group_id, bot_id, bot_name, round, prompt, user_text, error, created_at, retried, resolved_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      )
      .run(id, args.groupId, args.botId, args.botName, args.round, args.prompt, args.userText, args.error, createdAt);
    return {
      id,
      groupId: args.groupId,
      botId: args.botId,
      botName: args.botName,
      round: args.round,
      prompt: args.prompt,
      userText: args.userText,
      error: args.error,
      createdAt,
      retried: false,
      resolvedMessageId: null,
    };
  }

  listRoomFailures(groupId: string, limit = 50): RoomFailure[] {
    const rows = this.db
      .prepare(`SELECT * FROM room_failures WHERE group_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(groupId, limit) as Array<{
      failure_id: string;
      group_id: string;
      bot_id: string;
      bot_name: string;
      round: number;
      prompt: string;
      user_text: string;
      error: string;
      created_at: string;
      retried: number;
      resolved_message_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.failure_id,
      groupId: r.group_id,
      botId: r.bot_id,
      botName: r.bot_name,
      round: r.round,
      prompt: r.prompt,
      userText: r.user_text,
      error: r.error,
      createdAt: r.created_at,
      retried: r.retried === 1,
      resolvedMessageId: r.resolved_message_id,
    }));
  }

  getRoomFailure(failureId: string): RoomFailure | null {
    const r = this.db.prepare(`SELECT * FROM room_failures WHERE failure_id = ?`).get(failureId) as
      | {
          failure_id: string;
          group_id: string;
          bot_id: string;
          bot_name: string;
          round: number;
          prompt: string;
          user_text: string;
          error: string;
          created_at: string;
          retried: number;
          resolved_message_id: string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.failure_id,
      groupId: r.group_id,
      botId: r.bot_id,
      botName: r.bot_name,
      round: r.round,
      prompt: r.prompt,
      userText: r.user_text,
      error: r.error,
      createdAt: r.created_at,
      retried: r.retried === 1,
      resolvedMessageId: r.resolved_message_id,
    };
  }

  markRoomFailureRetried(failureId: string, resolvedMessageId: string): boolean {
    const result = this.db
      .prepare(`UPDATE room_failures SET retried = 1, resolved_message_id = ? WHERE failure_id = ?`)
      .run(resolvedMessageId, failureId);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
