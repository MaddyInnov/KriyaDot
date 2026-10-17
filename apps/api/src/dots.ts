// SPDX-License-Identifier: Apache-2.0
// Dots — always-on background agents (OpenAI Dots / OpenDots pattern).
//
// A Dot is a persistent agent with a *responsibility* (not a one-off prompt).
// It wakes on its schedule, works with its session's conversation context,
// and reports back. This is the foundation: persistent records + scheduled
// wakes + report-back. The full vision (own persistent environment, voice
// calls, channel mentions) builds on this.
//
// Storage: <dataDir>/dots.db (node:sqlite).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from '@mvp/agent-runtime';

export interface Dot {
  id: string;
  name: string;
  /** The Dot's ongoing responsibility (e.g. "watch the repo for broken tests"). */
  responsibility: string;
  /** Detailed instructions for how to carry out the responsibility. */
  instructions: string;
  botId: string;
  /** Session the Dot works in (holds its memory/context). */
  sessionId: string;
  /** 5-field cron for wake schedule. */
  cron: string;
  enabled: boolean;
  createdAt: number;
  lastWakeAt?: number;
  /** Backing thread-schedule id (the wake mechanism). */
  threadScheduleId?: string;
  /** Persistent E2B sandbox ID — the Dot's "own computer". */
  environmentId?: string;
}

interface DotRow {
  id: string;
  name: string;
  responsibility: string;
  instructions: string;
  bot_id: string;
  session_id: string;
  cron: string;
  enabled: number;
  created_at: number;
  last_wake_at: number | null;
  thread_schedule_id: string | null;
  environment_id: string | null;
}

function rowToDot(r: DotRow): Dot {
  return {
    id: r.id,
    name: r.name,
    responsibility: r.responsibility,
    instructions: r.instructions,
    botId: r.bot_id,
    sessionId: r.session_id,
    cron: r.cron,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastWakeAt: r.last_wake_at ?? undefined,
    threadScheduleId: r.thread_schedule_id ?? undefined,
    environmentId: r.environment_id ?? undefined,
  };
}

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

export class DotStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'dots.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        responsibility TEXT NOT NULL,
        instructions TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_wake_at INTEGER,
        thread_schedule_id TEXT,
        environment_id TEXT
      );
    `);
    // Migration for DBs created before environment_id existed.
    try {
      this.db.exec('ALTER TABLE dots ADD COLUMN environment_id TEXT');
    } catch {
      // Column already exists.
    }
  }

  /** Link a backing thread schedule (the wake mechanism). */
  setThreadScheduleId(id: string, scheduleId: string): void {
    this.db.prepare('UPDATE dots SET thread_schedule_id = ? WHERE id = ?').run(scheduleId, id);
  }

  /** Set the Dot's persistent environment (E2B sandbox ID). */
  setEnvironmentId(id: string, sandboxId: string): void {
    this.db.prepare('UPDATE dots SET environment_id = ? WHERE id = ?').run(sandboxId, id);
  }

  /** Clear the Dot's persistent environment (after stop/expiry). */
  clearEnvironmentId(id: string): void {
    this.db.prepare('UPDATE dots SET environment_id = NULL WHERE id = ?').run(id);
  }

  /** Find a Dot by its working session ID (for routing wakes to its sandbox). */
  getBySessionId(sessionId: string): Dot | undefined {
    const row = this.db.prepare('SELECT * FROM dots WHERE session_id = ?').get(sessionId) as unknown as DotRow | undefined;
    return row ? rowToDot(row) : undefined;
  }

  create(input: {
    name: string;
    responsibility: string;
    instructions: string;
    botId: string;
    sessionId: string;
    cron: string;
  }): Dot {
    if (!NAME_RE.test(input.name)) {
      throw new Error('name must be 1-32 chars: lowercase letters, digits, hyphens.');
    }
    if (!input.responsibility.trim() || input.responsibility.length > 2000) {
      throw new Error('responsibility is required (max 2000 chars).');
    }
    if (!CRON_RE.test(input.cron.trim())) {
      throw new Error('cron must be a 5-field expression.');
    }
    const dot: Dot = {
      id: randomUUID(),
      name: input.name,
      responsibility: input.responsibility.trim(),
      instructions: (input.instructions ?? '').slice(0, 8000),
      botId: input.botId,
      sessionId: input.sessionId.trim() || `dot_${input.name}_${Date.now().toString(36)}`,
      cron: input.cron.trim(),
      enabled: true,
      createdAt: Date.now(),
    };
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, name, responsibility, instructions, bot_id, session_id, cron, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
        )
        .run(dot.id, dot.name, dot.responsibility, dot.instructions, dot.botId, dot.sessionId, dot.cron, dot.createdAt);
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new Error(`A Dot named "${input.name}" already exists.`);
      throw err;
    }
    return dot;
  }

  list(): Dot[] {
    const rows = this.db.prepare('SELECT * FROM dots ORDER BY created_at DESC').all() as unknown as DotRow[];
    return rows.map(rowToDot);
  }

  get(id: string): Dot | undefined {
    const row = this.db.prepare('SELECT * FROM dots WHERE id = ?').get(id) as unknown as DotRow | undefined;
    return row ? rowToDot(row) : undefined;
  }

  setEnabled(id: string, enabled: boolean): Dot | undefined {
    this.db.prepare('UPDATE dots SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM dots WHERE id = ?').run(id).changes > 0;
  }

  markWoke(id: string): void {
    this.db.prepare('UPDATE dots SET last_wake_at = ? WHERE id = ?').run(Date.now(), id);
  }
}

/** Build the wake prompt for a Dot's scheduled check-in. */
export function dotWakePrompt(dot: Dot): string {
  return [
    `[Scheduled check-in for Dot "${dot.name}"]`,
    `Your ongoing responsibility: ${dot.responsibility}`,
    dot.instructions ? `Instructions: ${dot.instructions}` : '',
    'Review the conversation history for context. Do the work your responsibility requires. When done, summarize what you did and what needs a human decision.',
  ]
    .filter(Boolean)
    .join('\n');
}
