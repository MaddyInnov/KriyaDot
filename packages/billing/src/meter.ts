// SPDX-License-Identifier: Apache-2.0
// Usage metering: tokens per session/bot (from agent-runtime usage),
// workflow runs, and sandbox minutes. SQLite-backed, own file
// `<dbPath>` (callers pass e.g. `<dataDir>/billing.db`).

// vitest cannot statically resolve the `node:sqlite` specifier, so load it
// at runtime via the builtin-module API (same trick as agent-runtime stores).
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export type UsageKind = 'tokens' | 'workflow' | 'sandbox';

export interface TokenUsageInput {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageEvent {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  kind: UsageKind;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** workflow_id for workflow runs. */
  workflowId: string | null;
  /** Billed sandbox minutes (fractional ok) for sandbox events. */
  minutes: number;
}

export interface UsageSummary {
  sessions: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  workflowRuns: number;
  sandboxMinutes: number;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function requireNonNegativeInt(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export class UsageMeter {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        workflow_id TEXT,
        minutes REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events (session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage_events (bot_id);
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Record a chat completion's token usage for a session/bot. */
  recordTokens(sessionId: string, botId: string, usage: TokenUsageInput): UsageEvent {
    return this.insert({
      sessionId,
      botId,
      kind: 'tokens',
      promptTokens: requireNonNegativeInt(usage.promptTokens, 'promptTokens'),
      completionTokens: requireNonNegativeInt(usage.completionTokens, 'completionTokens'),
      totalTokens: requireNonNegativeInt(usage.totalTokens, 'totalTokens'),
      workflowId: null,
      minutes: 0,
    });
  }

  /** Record one completed workflow run. */
  recordWorkflowRun(runId: string, workflowId: string, botId = ''): UsageEvent {
    return this.insert({
      sessionId: runId,
      botId,
      kind: 'workflow',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      workflowId,
      minutes: 0,
    });
  }

  /** Record billed sandbox minutes for a session. */
  recordSandboxMinutes(sessionId: string, botId: string, minutes: number): UsageEvent {
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('minutes must be a non-negative number');
    return this.insert({
      sessionId,
      botId,
      kind: 'sandbox',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      workflowId: null,
      minutes,
    });
  }

  private insert(e: Omit<UsageEvent, 'id' | 'ts'>): UsageEvent {
    const event: UsageEvent = { ...e, id: newId('ue'), ts: Date.now() };
    this.db
      .prepare(
        `INSERT INTO usage_events
           (id, ts, session_id, bot_id, kind, prompt_tokens, completion_tokens,
            total_tokens, workflow_id, minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.ts,
        event.sessionId,
        event.botId,
        event.kind,
        event.promptTokens,
        event.completionTokens,
        event.totalTokens,
        event.workflowId,
        event.minutes,
      );
    return event;
  }

  list(opts: { sessionId?: string; botId?: string; since?: number; limit?: number } = {}): UsageEvent[] {
    const conds: string[] = [];
    const args: Array<string | number | null> = [];
    if (opts.sessionId) {
      conds.push('session_id = ?');
      args.push(opts.sessionId);
    }
    if (opts.botId) {
      conds.push('bot_id = ?');
      args.push(opts.botId);
    }
    if (opts.since !== undefined) {
      conds.push('ts >= ?');
      args.push(opts.since);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows = this.db
      .prepare(`SELECT * FROM usage_events ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  summary(opts: { botId?: string; since?: number } = {}): UsageSummary {
    const conds: string[] = [];
    const args: Array<string | number | null> = [];
    if (opts.botId) {
      conds.push('bot_id = ?');
      args.push(opts.botId);
    }
    if (opts.since !== undefined) {
      conds.push('ts >= ?');
      args.push(opts.since);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS sessions,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(CASE WHEN kind = 'workflow' THEN 1 ELSE 0 END), 0) AS workflow_runs,
                COALESCE(SUM(minutes), 0) AS sandbox_minutes
         FROM usage_events ${where}`,
      )
      .get(...args) as {
      sessions: number;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      workflow_runs: number;
      sandbox_minutes: number;
    };
    return {
      sessions: row.sessions,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      workflowRuns: row.workflow_runs,
      sandboxMinutes: row.sandbox_minutes,
    };
  }
}

function rowToEvent(r: Record<string, unknown>): UsageEvent {
  return {
    id: r.id as string,
    ts: r.ts as number,
    sessionId: r.session_id as string,
    botId: r.bot_id as string,
    kind: r.kind as UsageKind,
    promptTokens: r.prompt_tokens as number,
    completionTokens: r.completion_tokens as number,
    totalTokens: r.total_tokens as number,
    workflowId: (r.workflow_id as string | null) ?? null,
    minutes: r.minutes as number,
  };
}
