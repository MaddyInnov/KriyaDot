// SPDX-License-Identifier: Apache-2.0
// Preference learning loop (OpenDots parity).
//
// Watches user decisions and learns:
// - If a user denies the same tool 3 times, auto-create a deny preference
//   (the agent stops proposing it).
// - "Always allow" (via the approval UI) is already handled by bot policies;
//   this store tracks the deny side and surfaces learned preferences.
//
// Storage: <dataDir>/preferences.db (node:sqlite).

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from '@mvp/agent-runtime';

export interface LearnedPreference {
  id: string;
  botId: string;
  toolName: string;
  /** 'deny' = user consistently rejects this tool; 'allow' = user consistently approves. */
  preference: 'deny' | 'allow';
  /** How many times this pattern was observed. */
  observations: number;
  createdAt: number;
  lastObservedAt: number;
}

interface PreferenceRow {
  id: string;
  bot_id: string;
  tool_name: string;
  preference: string;
  observations: number;
  created_at: number;
  last_observed_at: number;
}

function rowToPreference(r: PreferenceRow): LearnedPreference {
  return {
    id: r.id,
    botId: r.bot_id,
    toolName: r.tool_name,
    preference: r.preference as 'deny' | 'allow',
    observations: r.observations,
    createdAt: r.created_at,
    lastObservedAt: r.last_observed_at,
  };
}

/** Denials needed before auto-learning a deny preference. */
export const DENY_LEARN_THRESHOLD = 3;
/** Approvals needed before auto-learning an allow preference. */
export const ALLOW_LEARN_THRESHOLD = 5;

export class PreferenceStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'preferences.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        preference TEXT NOT NULL,
        observations INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        UNIQUE(bot_id, tool_name, preference)
      );
      CREATE TABLE IF NOT EXISTS decision_log (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decision_log_bot_tool ON decision_log(bot_id, tool_name, created_at DESC);
    `);
  }

  /**
   * Record a user decision on a tool. Returns a learned preference if the
   * threshold was crossed (the caller should surface it to the user).
   */
  recordDecision(botId: string, toolName: string, decision: 'approved' | 'denied'): LearnedPreference | null {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO decision_log (id, bot_id, tool_name, decision, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), botId, toolName, decision, now);

    // Count recent decisions for this tool (last 30 days).
    const since = now - 30 * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare('SELECT decision FROM decision_log WHERE bot_id = ? AND tool_name = ? AND created_at > ?')
      .all(botId, toolName, since) as Array<{ decision: string }>;
    const denied = rows.filter((r) => r.decision === 'denied').length;
    const approved = rows.filter((r) => r.decision === 'approved').length;

    // Check if we already learned this.
    const existing = this.db
      .prepare('SELECT * FROM preferences WHERE bot_id = ? AND tool_name = ?')
      .get(botId, toolName) as unknown as PreferenceRow | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE preferences SET observations = observations + 1, last_observed_at = ? WHERE id = ?')
        .run(now, existing.id);
      return null;
    }

    if (denied >= DENY_LEARN_THRESHOLD && denied > approved * 2) {
      return this.createPreference(botId, toolName, 'deny', denied);
    }
    if (approved >= ALLOW_LEARN_THRESHOLD && approved > denied * 3) {
      return this.createPreference(botId, toolName, 'allow', approved);
    }
    return null;
  }

  private createPreference(botId: string, toolName: string, preference: 'deny' | 'allow', observations: number): LearnedPreference {
    const now = Date.now();
    const pref: LearnedPreference = {
      id: randomUUID(),
      botId,
      toolName,
      preference,
      observations,
      createdAt: now,
      lastObservedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO preferences (id, bot_id, tool_name, preference, observations, created_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(pref.id, botId, toolName, preference, observations, now, now);
    return pref;
  }

  /** Get the learned preference for a tool (if any). */
  getPreference(botId: string, toolName: string): LearnedPreference | undefined {
    const row = this.db
      .prepare('SELECT * FROM preferences WHERE bot_id = ? AND tool_name = ?')
      .get(botId, toolName) as unknown as PreferenceRow | undefined;
    return row ? rowToPreference(row) : undefined;
  }

  list(botId?: string): LearnedPreference[] {
    const rows = (botId
      ? this.db.prepare('SELECT * FROM preferences WHERE bot_id = ? ORDER BY last_observed_at DESC').all(botId)
      : this.db.prepare('SELECT * FROM preferences ORDER BY last_observed_at DESC').all()) as unknown as PreferenceRow[];
    return rows.map(rowToPreference);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM preferences WHERE id = ?').run(id).changes > 0;
  }
}
