// SPDX-License-Identifier: Apache-2.0
// Connected-app event triggers (W2) — polling engine for `event` routine
// schedules (see routine-schedules.ts EventSchedule).
//
// A routine with an event schedule fires when a new item appears in a
// connected Composio app: a Gmail message matching a filter, a Slack
// channel message, a GitHub repo event (issue / PR / push), a Stripe
// payment event, or a calendar event starting within a window.
//
// Execution path: polling reuses the exact server-side Composio execution
// path as the composio_call agent tool (composio-tools.ts) — the API key
// is resolved from the encrypted vault (getComposioApiKey), the account
// is resolved via resolveAccount (composio-accounts.ts), the per-bot
// enablement gate (readComposioEnables) is enforced, and the action runs
// through ComposioClient.executeTool. There is no parallel client and no
// credential ever leaves that closure.
//
// Dedupe / catch-up / caps:
//   - Every listed item id is recorded in a persistent seen-set
//     (<dataDir>/routine-event-triggers.db); an item fires at most once,
//     ever, across restarts (seen rows are pruned only after 90 days).
//   - The first poll for a trigger only baselines the cursor (existing
//     items are marked seen, nothing fires).
//   - The first poll after boot (or after a daily-cap block) is a
//     catch-up poll: at most MAX_EVENT_CATCH_UP_FIRES most-recent missed
//     items fire; older ones are marked seen and the skipped count is
//     noted in a 'missed' run record.
//   - A per-trigger daily cap (schedule.dailyCap, in the schedule's
//     timezone) stops firing until the next day; un-fired items stay
//     unseen and are picked up by the next day's catch-up poll.
//   - Filters are applied AT SOURCE where the Composio action supports
//     it (the Gmail search query is composed from from/subject/query;
//     Slack/GitHub/Stripe/Calendar list calls carry their scoping
//     arguments), and re-checked immediately on receipt before any bot
//     turn runs.
//
// Fires go through the existing RoutineRunExecutor with trigger 'event',
// so event runs appear in the same run history, with the triggering
// item's summary (subject/sender, PR title, … — never full bodies, never
// credentials) in the run payload that renders the routine's prompt.

import type { DatabaseSync } from 'node:sqlite';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import type { BotRoutine, RoutineStore } from './bot-routines.js';
import type { RoutineRunExecutor, RoutineRunStore } from './routine-runs.js';
import {
  zonedParts,
  type EventAppId,
  type EventSchedule,
} from './routine-schedules.js';
import type { ComposioClient } from './composio.js';
import {
  composioEntityId,
  fetchComposioClient,
  getComposioApiKey,
  readComposioEnables,
} from './composio.js';
import { resolveAccount } from './composio-accounts.js';

/** Bounded catch-up: at most this many missed items fire per catch-up poll. */
export const MAX_EVENT_CATCH_UP_FIRES = 5;
/** Seen-item retention: ids older than this are pruned (dedupe horizon). */
export const EVENT_SEEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Items requested per list call. */
const LIST_LIMIT = 25;
const SUMMARY_LIMIT = 200;

// ---------------------------------------------------------------------------
// Normalized event item
// ---------------------------------------------------------------------------

export interface EventItem {
  /** Stable dedupe id, unique within the source (e.g. "issue:42:opened"). */
  id: string;
  /** Item timestamp (epoch ms) — creation/update time as reported. */
  ts: number;
  /** Event category within the source, e.g. "issues", "payment_succeeded". */
  kind: string;
  /** One-line human summary for the run context (no full bodies). */
  summary: string;
  /** Small flat field set for the prompt payload (strings only). */
  fields: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Composio execution (shared with the composio_call agent tool path)
// ---------------------------------------------------------------------------

/**
 * The slice of the server-side Composio execution path the poller needs.
 * The production implementation (createComposioEventExecutor) mirrors
 * composio-tools.ts exactly; tests inject a mock so no network happens.
 */
export interface ComposioEventExecutor {
  executeTool(input: {
    userId: string;
    botId: string;
    accountId: string;
    toolSlug: string;
    args: Record<string, unknown>;
  }): Promise<unknown>;
}

export function createComposioEventExecutor(deps: {
  dataDir: string;
  client?: ComposioClient;
}): ComposioEventExecutor {
  const client = deps.client ?? fetchComposioClient;
  return {
    async executeTool(input) {
      const apiKey = getComposioApiKey(deps.dataDir, input.userId);
      if (!apiKey) {
        throw new Error('Composio is not connected — connect an API key in Accounts first.');
      }
      const account = await resolveAccount(deps.dataDir, input.userId, client, apiKey, input.accountId);
      if (!account) throw new Error(`unknown Composio account "${input.accountId}"`);
      // Per-bot enablement gate — same defense-in-depth as composio_call:
      // a routine's bot can only poll accounts whose app it has enabled.
      const enabled = readComposioEnables(deps.dataDir, input.userId)[input.botId]?.[account.toolkitSlug] === true;
      if (!enabled) {
        throw new Error(`app "${account.toolkitSlug}" is not enabled for bot "${input.botId}"`);
      }
      const result = await client.executeTool(apiKey, {
        toolSlug: input.toolSlug,
        connectedAccountId: input.accountId,
        // Accounts are linked under the Composio entity id (composio-accounts.ts).
        userId: composioEntityId(input.userId),
        args: input.args,
      });
      if (!result.successful) {
        throw new Error(`Composio action "${input.toolSlug}" failed: ${(result.error ?? 'unknown error').slice(0, 300)}`);
      }
      return result.data;
    },
  };
}

// ---------------------------------------------------------------------------
// Source definitions: list calls (filter at source) + normalization
// ---------------------------------------------------------------------------

interface SourceCall {
  toolSlug: string;
  args: Record<string, unknown>;
  /** Which event category this call feeds (github fans out per type). */
  category: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.floor(v * 1000) : Math.floor(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() && Number.isFinite(n)) return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

/** Collect item objects from the varied list-result shapes Composio returns. */
function collectItems(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map(rec).filter((r) => Object.keys(r).length > 0);
  const d = rec(data);
  for (const k of keys) {
    if (Array.isArray(d[k])) return (d[k] as unknown[]).map(rec);
  }
  // One nesting level: { data: { messages: [...] } } and friends.
  for (const v of Object.values(d)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = rec(v);
      for (const k of keys) {
        if (Array.isArray(inner[k])) return (inner[k] as unknown[]).map(rec);
      }
    }
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
      return (v as unknown[]).map(rec);
    }
  }
  return [];
}

function truncate(s: string, n = SUMMARY_LIMIT): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Build the list calls for a schedule. Filters are pushed into the call. */
export function sourceCalls(schedule: EventSchedule, now: number): SourceCall[] {
  switch (schedule.app) {
    case 'gmail': {
      // At-source filter: compose a Gmail search query from the fields.
      const parts: string[] = [];
      if (schedule.from) parts.push(`from:${schedule.from}`);
      if (schedule.subjectContains) parts.push(`subject:${schedule.subjectContains}`);
      if (schedule.query) parts.push(schedule.query);
      const args: Record<string, unknown> = { max_results: LIST_LIMIT };
      if (parts.length > 0) args.query = parts.join(' ');
      return [{ toolSlug: 'GMAIL_FETCH_EMAILS', args, category: 'message' }];
    }
    case 'slack':
      return [{
        toolSlug: 'SLACK_FETCH_CONVERSATION_HISTORY',
        args: { channel_id: schedule.channelId, limit: LIST_LIMIT },
        category: 'message',
      }];
    case 'github': {
      const [owner, repo] = (schedule.repo ?? '').split('/');
      const calls: SourceCall[] = [];
      const types = schedule.eventTypes ?? ['issues', 'pull_request', 'push'];
      if (types.includes('issues')) {
        calls.push({
          toolSlug: 'GITHUB_LIST_ISSUES',
          args: { owner, repo, state: 'open', sort: 'created', direction: 'desc', per_page: LIST_LIMIT },
          category: 'issues',
        });
      }
      if (types.includes('pull_request')) {
        calls.push({
          toolSlug: 'GITHUB_LIST_PULL_REQUESTS',
          args: { owner, repo, state: 'all', sort: 'updated', direction: 'desc', per_page: LIST_LIMIT },
          category: 'pull_request',
        });
      }
      if (types.includes('push')) {
        calls.push({
          toolSlug: 'GITHUB_LIST_COMMITS',
          args: { owner, repo, per_page: LIST_LIMIT },
          category: 'push',
        });
      }
      return calls;
    }
    case 'stripe':
      return [{ toolSlug: 'STRIPE_LIST_EVENTS', args: { limit: LIST_LIMIT }, category: 'payment' }];
    case 'googlecalendar': {
      const windowMs = (schedule.windowMinutes ?? 120) * 60_000;
      return [{
        toolSlug: 'GOOGLECALENDAR_EVENTS_LIST',
        args: {
          calendarId: schedule.calendarId ?? 'primary',
          timeMin: new Date(now).toISOString(),
          timeMax: new Date(now + windowMs).toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: LIST_LIMIT,
        },
        category: 'event',
      }];
    }
  }
}

function normalizeGmail(raw: Record<string, unknown>): EventItem | null {
  const id = str(raw.messageId ?? raw.message_id ?? raw.id);
  if (!id) return null;
  const sender = str(raw.sender ?? raw.from ?? raw.from_email);
  const subject = str(raw.subject);
  const ts = parseTs(raw.messageTimestamp ?? raw.timestamp ?? raw.date ?? raw.internalDate);
  return {
    id,
    ts,
    kind: 'message',
    summary: truncate(`Email from ${sender || 'unknown sender'}: ${subject || '(no subject)'}`),
    fields: { sender, subject },
  };
}

function gmailMatches(item: EventItem, raw: Record<string, unknown>, s: EventSchedule): boolean {
  // The at-source query already filtered; re-check the fields we can see
  // so a loose provider response can never fire an off-filter turn.
  const sender = str(raw.sender ?? raw.from ?? raw.from_email).toLowerCase();
  const subject = str(raw.subject).toLowerCase();
  if (s.from && sender && !sender.includes(s.from.toLowerCase())) return false;
  if (s.subjectContains && subject && !subject.includes(s.subjectContains.toLowerCase())) return false;
  void item;
  return true;
}

function normalizeSlack(raw: Record<string, unknown>, s: EventSchedule): EventItem | null {
  const tsRaw = str(raw.ts ?? raw.timestamp);
  const id = tsRaw || str(raw.client_msg_id ?? raw.id);
  if (!id) return null;
  const text = str(raw.text);
  if (s.keyword && !text.toLowerCase().includes(s.keyword.toLowerCase())) return null;
  const user = str(raw.user ?? raw.username);
  return {
    id,
    ts: parseTs(tsRaw || raw.timestamp),
    kind: 'message',
    summary: truncate(`Slack message in ${s.channelId}: ${text || '(no text)'}`),
    fields: { channelId: s.channelId ?? '', user, text: truncate(text, 120) },
  };
}

function normalizeGithub(raw: Record<string, unknown>, category: string, s: EventSchedule): EventItem[] {
  const repo = s.repo ?? '';
  if (category === 'issues') {
    if (raw.pull_request) return []; // the issues list interleaves PRs
    const n = str(raw.number ?? raw.id);
    if (!n) return [];
    return [{
      id: `issue:${n}:opened`,
      ts: parseTs(raw.created_at),
      kind: 'issues',
      summary: truncate(`GitHub issue #${n} opened on ${repo}: ${str(raw.title)}`),
      fields: { repo, number: n, title: str(raw.title), state: str(raw.state) },
    }];
  }
  if (category === 'pull_request') {
    const n = str(raw.number ?? raw.id);
    if (!n) return [];
    const out: EventItem[] = [{
      id: `pr:${n}:opened`,
      ts: parseTs(raw.created_at),
      kind: 'pull_request',
      summary: truncate(`GitHub PR #${n} opened on ${repo}: ${str(raw.title)}`),
      fields: { repo, number: n, title: str(raw.title), state: str(raw.state) },
    }];
    const mergedAt = raw.merged_at;
    if (mergedAt) {
      out.push({
        id: `pr:${n}:merged`,
        ts: parseTs(mergedAt),
        kind: 'pull_request',
        summary: truncate(`GitHub PR #${n} merged on ${repo}: ${str(raw.title)}`),
        fields: { repo, number: n, title: str(raw.title), state: 'merged' },
      });
    }
    return out;
  }
  // push: a new commit on the repo stands in for a push event.
  const sha = str(rec(raw.commit).sha ?? raw.sha ?? raw.id);
  if (!sha) return [];
  const commit = rec(raw.commit);
  const msg = str(commit.message);
  const authorDate = str(rec(commit.author).date ?? rec(commit.committer).date);
  return [{
    id: `commit:${sha}`,
    ts: parseTs(authorDate || raw.timestamp),
    kind: 'push',
    summary: truncate(`GitHub push to ${repo}: ${msg.split('\n')[0] || sha.slice(0, 7)}`),
    fields: { repo, sha: sha.slice(0, 12) },
  }];
}

function stripeKind(type: string): 'payment_succeeded' | 'payment_failed' | null {
  if (type === 'payment_intent.succeeded' || type === 'charge.succeeded') return 'payment_succeeded';
  if (type === 'payment_intent.payment_failed' || type === 'charge.failed') return 'payment_failed';
  return null;
}

function normalizeStripe(raw: Record<string, unknown>, s: EventSchedule): EventItem | null {
  const id = str(raw.id);
  const type = str(raw.type);
  if (!id || !type) return null;
  const kind = stripeKind(type);
  if (!kind) return null;
  const wanted = s.stripeEventTypes ?? ['payment_succeeded', 'payment_failed'];
  if (!wanted.includes(kind)) return null;
  const obj = rec(rec(raw.data).object);
  const amount = obj.amount != null ? str(obj.amount) : '';
  const currency = str(obj.currency);
  return {
    id,
    ts: parseTs(raw.created),
    kind,
    summary: truncate(`Stripe ${type}${amount ? `: ${amount}${currency ? ` ${currency}` : ''}` : ''} (${id})`),
    fields: { type, ...(amount ? { amount } : {}), ...(currency ? { currency } : {}) },
  };
}

function normalizeCalendar(raw: Record<string, unknown>): EventItem | null {
  const id = str(raw.id);
  if (!id) return null;
  const start = rec(raw.start);
  const startStr = str(start.dateTime ?? start.date ?? raw.start);
  const updated = str(raw.updated ?? raw.created);
  // Dedupe per version: an update to the same event is a new fire.
  const versioned = `${id}:${updated || startStr}`;
  const title = str(raw.summary ?? raw.title);
  return {
    id: versioned,
    ts: parseTs(updated || raw.created || startStr),
    kind: 'event',
    summary: truncate(`Calendar event: ${title || '(untitled)'} at ${startStr}`),
    fields: { title, start: startStr, status: str(raw.status) },
  };
}

/** Normalize one list-call result into filtered event items. */
export function normalizeItems(
  schedule: EventSchedule,
  call: SourceCall,
  data: unknown,
): EventItem[] {
  const keysByApp: Record<EventAppId, string[]> = {
    gmail: ['messages', 'items', 'results'],
    slack: ['messages', 'items', 'results'],
    github: ['items', 'results'],
    stripe: ['data', 'items', 'events', 'results'],
    googlecalendar: ['items', 'events', 'results'],
  };
  const raws = collectItems(data, keysByApp[schedule.app]);
  const out: EventItem[] = [];
  for (const raw of raws) {
    if (schedule.app === 'gmail') {
      const item = normalizeGmail(raw);
      if (item && gmailMatches(item, raw, schedule)) out.push(item);
    } else if (schedule.app === 'slack') {
      const item = normalizeSlack(raw, schedule);
      if (item) out.push(item);
    } else if (schedule.app === 'github') {
      out.push(...normalizeGithub(raw, call.category, schedule));
    } else if (schedule.app === 'stripe') {
      const item = normalizeStripe(raw, schedule);
      if (item) out.push(item);
    } else if (schedule.app === 'googlecalendar') {
      const item = normalizeCalendar(raw);
      if (item) out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistent state: cursors, seen-set, daily fire counts (SQLite)
// ---------------------------------------------------------------------------

export interface EventTriggerState {
  routineId: string;
  /** Newest item id folded into the cursor (display/status). */
  cursorId: string | null;
  cursorTs: number | null;
  lastPollAt: number | null;
  lastFiredAt: number | null;
  lastError: string | null;
  /** A previous poll left unseen items behind because the daily cap hit. */
  capBlocked: boolean;
  updatedAt: number;
}

interface StateRow {
  routine_id: string;
  cursor_id: string | null;
  cursor_ts: number | null;
  last_poll_at: number | null;
  last_fired_at: number | null;
  last_error: string | null;
  cap_blocked: number;
  updated_at: number;
}

function openEventDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = openSqliteDb(join(dataDir, 'routine-event-triggers.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_trigger_state (
      routine_id TEXT PRIMARY KEY,
      cursor_id TEXT,
      cursor_ts INTEGER,
      last_poll_at INTEGER,
      last_fired_at INTEGER,
      last_error TEXT,
      cap_blocked INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_seen_items (
      routine_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (routine_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS event_daily_counts (
      routine_id TEXT NOT NULL,
      day TEXT NOT NULL,
      fires INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (routine_id, day)
    );
  `);
  return db;
}

export class EventTriggerStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openEventDb(dataDir);
  }

  getState(routineId: string): EventTriggerState | undefined {
    const row = this.db
      .prepare('SELECT * FROM event_trigger_state WHERE routine_id = ?')
      .get(routineId) as unknown as StateRow | undefined;
    if (!row) return undefined;
    return {
      routineId: row.routine_id,
      cursorId: row.cursor_id,
      cursorTs: row.cursor_ts,
      lastPollAt: row.last_poll_at,
      lastFiredAt: row.last_fired_at,
      lastError: row.last_error,
      capBlocked: row.cap_blocked === 1,
      updatedAt: row.updated_at,
    };
  }

  /** Insert-or-merge a state row; only defined fields are overwritten. */
  upsertState(routineId: string, patch: Partial<Omit<EventTriggerState, 'routineId' | 'updatedAt'>>): EventTriggerState {
    const cur = this.getState(routineId);
    const next: EventTriggerState = {
      routineId,
      cursorId: patch.cursorId !== undefined ? patch.cursorId : (cur?.cursorId ?? null),
      cursorTs: patch.cursorTs !== undefined ? patch.cursorTs : (cur?.cursorTs ?? null),
      lastPollAt: patch.lastPollAt !== undefined ? patch.lastPollAt : (cur?.lastPollAt ?? null),
      lastFiredAt: patch.lastFiredAt !== undefined ? patch.lastFiredAt : (cur?.lastFiredAt ?? null),
      lastError: patch.lastError !== undefined ? patch.lastError : (cur?.lastError ?? null),
      capBlocked: patch.capBlocked !== undefined ? patch.capBlocked : (cur?.capBlocked ?? false),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO event_trigger_state
           (routine_id, cursor_id, cursor_ts, last_poll_at, last_fired_at, last_error, cap_blocked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(routine_id) DO UPDATE SET
           cursor_id = excluded.cursor_id, cursor_ts = excluded.cursor_ts,
           last_poll_at = excluded.last_poll_at, last_fired_at = excluded.last_fired_at,
           last_error = excluded.last_error, cap_blocked = excluded.cap_blocked,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.routineId, next.cursorId, next.cursorTs, next.lastPollAt,
        next.lastFiredAt, next.lastError, next.capBlocked ? 1 : 0, next.updatedAt,
      );
    return next;
  }

  hasSeen(routineId: string, itemId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM event_seen_items WHERE routine_id = ? AND item_id = ?')
      .get(routineId, itemId) as unknown as { x: number } | undefined;
    return row !== undefined;
  }

  markSeen(routineId: string, itemIds: string[], now = Date.now()): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO event_seen_items (routine_id, item_id, seen_at) VALUES (?, ?, ?)',
    );
    for (const id of itemIds) stmt.run(routineId, id, now);
  }

  pruneSeen(routineId: string, beforeMs: number): number {
    const r = this.db
      .prepare('DELETE FROM event_seen_items WHERE routine_id = ? AND seen_at < ?')
      .run(routineId, beforeMs);
    return Number(r.changes);
  }

  firesOn(routineId: string, day: string): number {
    const row = this.db
      .prepare('SELECT fires FROM event_daily_counts WHERE routine_id = ? AND day = ?')
      .get(routineId, day) as unknown as { fires: number } | undefined;
    return row?.fires ?? 0;
  }

  recordFire(routineId: string, day: string): number {
    this.db
      .prepare(
        `INSERT INTO event_daily_counts (routine_id, day, fires) VALUES (?, ?, 1)
         ON CONFLICT(routine_id, day) DO UPDATE SET fires = fires + 1`,
      )
      .run(routineId, day);
    return this.firesOn(routineId, day);
  }

  deleteByRoutine(routineId: string): void {
    this.db.prepare('DELETE FROM event_trigger_state WHERE routine_id = ?').run(routineId);
    this.db.prepare('DELETE FROM event_seen_items WHERE routine_id = ?').run(routineId);
    this.db.prepare('DELETE FROM event_daily_counts WHERE routine_id = ?').run(routineId);
  }

  /** Boot view: how many triggers carry a persisted cursor. */
  countStates(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM event_trigger_state').get() as unknown as { n: number };
    return row.n;
  }
}

/** Day key (YYYY-MM-DD) in the schedule's timezone — the daily-cap bucket. */
export function eventDayKey(timezone: string, nowMs: number): string {
  const p = zonedParts(timezone, nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// ---------------------------------------------------------------------------
// Polling engine
// ---------------------------------------------------------------------------

export interface EventPollResult {
  routineId: string;
  polled: boolean;
  /** Why nothing was polled/fired, when applicable. */
  reason?: string;
  listed: number;
  matched: number;
  /** Run ids created by this poll. */
  firedRunIds: string[];
  /** Older missed items skipped by the bounded catch-up (marked seen). */
  skippedCatchUp: number;
  /** Items left unseen because the daily cap was reached. */
  capBlocked: number;
  error?: string;
}

export interface EventTriggerPollerDeps {
  routineStore: RoutineStore;
  eventStore: EventTriggerStore;
  /** Server-side Composio execution (see createComposioEventExecutor). */
  executor: ComposioEventExecutor;
  /** Routine run executor — fires go through the existing run history. */
  runExecutor?: RoutineRunExecutor;
  /** Run store for 'missed' records (catch-up skips, overlap skips). */
  runStore?: RoutineRunStore;
  /** Direct-turn fallback when no runExecutor is wired (legacy path). */
  agentRuntime?: AgentRuntime;
  getBots?: () => BotConfig[];
  renderPrompt?: (template: string, body: unknown) => string;
  /** Clock override for tests. */
  now?: () => number;
  /** Called after a poll that fired at least one run (observability). */
  onFire?: (routine: BotRoutine, result: EventPollResult) => void;
  /** Global pause gate (W14d): while paused, polls skip entirely. */
  isPaused?: () => boolean;
}

function defaultRenderPrompt(template: string, body: unknown): string {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return template.split('{{payload}}').join(payload).split('{{body}}').join(payload);
}

export class EventTriggerPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly inFlight = new Set<string>();
  /** Routines already polled by this process (boot catch-up detection). */
  private readonly polledThisBoot = new Set<string>();

  constructor(private readonly deps: EventTriggerPollerDeps) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollDue().catch((err) =>
        console.error('[event-triggers] poll failed:', err instanceof Error ? err.message : err),
      );
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
    setTimeout(() => void this.pollDue().catch(() => {}), 3_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Boot reconciliation: cursors and seen-sets are durable, so there is
   * nothing to rebuild — the first pollDue() of the process runs in
   * catch-up mode for every trigger with a persisted cursor, firing the
   * bounded set of items missed while down. Returns the cursor count.
   */
  reconcileOnBoot(): { cursors: number } {
    return { cursors: this.deps.eventStore.countStates() };
  }

  /** Poll every event routine whose poll interval has elapsed. */
  async pollDue(nowMs?: number): Promise<EventPollResult[]> {
    if (this.deps.isPaused?.()) return []; // W14d global pause: skip polls
    if (this.polling) return [];
    this.polling = true;
    try {
      const now = nowMs ?? this.deps.now?.() ?? Date.now();
      const out: EventPollResult[] = [];
      for (const routine of this.deps.routineStore.list()) {
        const schedule = routine.schedule;
        if (!routine.enabled || !schedule || schedule.kind !== 'event' || !schedule.enabled) continue;
        const state = this.deps.eventStore.getState(routine.id);
        const dueAt = (state?.lastPollAt ?? 0) + schedule.pollMinutes * 60_000;
        if (state && now < dueAt) continue;
        out.push(await this.pollRoutine(routine, now));
      }
      return out;
    } finally {
      this.polling = false;
    }
  }

  /** Poll one routine now (its schedule must be an enabled event schedule). */
  async pollRoutine(routine: BotRoutine, nowMs?: number): Promise<EventPollResult> {
    const now = nowMs ?? this.deps.now?.() ?? Date.now();
    const base: EventPollResult = {
      routineId: routine.id, polled: false, listed: 0, matched: 0,
      firedRunIds: [], skippedCatchUp: 0, capBlocked: 0,
    };
    const schedule = routine.schedule;
    if (!schedule || schedule.kind !== 'event') return { ...base, reason: 'not an event schedule' };
    if (!routine.enabled || !schedule.enabled) return { ...base, reason: 'routine or schedule disabled' };

    const store = this.deps.eventStore;
    const prior = store.getState(routine.id);
    const firstEverPoll = prior === undefined;
    // Catch-up mode: first poll of this process for an existing trigger,
    // or a previous poll left a daily-cap backlog behind.
    const catchUpMode = !firstEverPoll && (!this.polledThisBoot.has(routine.id) || prior.capBlocked);
    this.polledThisBoot.add(routine.id);
    store.pruneSeen(routine.id, now - EVENT_SEEN_RETENTION_MS);

    let items: EventItem[] = [];
    try {
      const userId = schedule.userId ?? 'default-user';
      for (const call of sourceCalls(schedule, now)) {
        const data = await this.deps.executor.executeTool({
          userId,
          botId: routine.botId,
          accountId: schedule.accountId,
          toolSlug: call.toolSlug,
          args: call.args,
        });
        items.push(...normalizeItems(schedule, call, data));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Record the failure and back off until the next interval — a
      // broken account must not hot-loop the poller.
      store.upsertState(routine.id, { lastPollAt: now, lastError: message.slice(0, 300) });
      return { ...base, polled: true, error: message };
    }

    base.polled = true;
    base.listed = items.length;
    // Dedupe within the batch and order oldest → newest for firing.
    const byId = new Map<string, EventItem>();
    for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
    items = [...byId.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    base.matched = items.length;

    // Advance the cursor to the newest listed item (even when nothing
    // fires — the cursor is the "listed up to here" watermark).
    const newest = items.length > 0 ? items[items.length - 1] : undefined;
    const cursorPatch: Partial<EventTriggerState> = { lastPollAt: now, lastError: null };
    if (newest) {
      cursorPatch.cursorId = newest.id;
      cursorPatch.cursorTs = newest.ts || now;
    }

    if (firstEverPoll) {
      // Baseline: existing items are history, not events. Mark them seen
      // so only items arriving after the trigger was created can fire.
      store.markSeen(routine.id, items.map((i) => i.id), now);
      store.upsertState(routine.id, cursorPatch);
      return { ...base, reason: 'baseline established' };
    }

    const unseen = items.filter((i) => !store.hasSeen(routine.id, i.id));
    if (unseen.length === 0) {
      store.upsertState(routine.id, { ...cursorPatch, capBlocked: false });
      return base;
    }

    // Daily cap (schedule timezone) bounds today's fires.
    const day = eventDayKey(schedule.timezone, now);
    const alreadyFired = store.firesOn(routine.id, day);
    let remainingCap = Math.max(0, schedule.dailyCap - alreadyFired);

    // Bounded catch-up: keep the most recent items, skip the older ones.
    let toFire = unseen;
    let skipped = 0;
    if (catchUpMode && unseen.length > MAX_EVENT_CATCH_UP_FIRES) {
      skipped = unseen.length - MAX_EVENT_CATCH_UP_FIRES;
      toFire = unseen.slice(skipped);
      store.markSeen(routine.id, unseen.slice(0, skipped).map((i) => i.id), now);
      base.skippedCatchUp = skipped;
      try {
        this.deps.runStore?.markMissed(
          routine.id,
          routine.name,
          now,
          `event catch-up cap: skipped ${skipped} older ${schedule.app} item(s); fired the ${MAX_EVENT_CATCH_UP_FIRES} most recent`,
          'event',
        );
      } catch (err) {
        console.error('[event-triggers] failed to record catch-up skip:', err instanceof Error ? err.message : err);
      }
    }

    let capBlockedCount = 0;
    let lastFiredAt: number | undefined;
    for (const item of toFire) {
      if (remainingCap <= 0) {
        // Cap reached: the item stays unseen and fires via tomorrow's
        // catch-up poll (capBlocked marks the backlog).
        capBlockedCount += 1;
        continue;
      }
      if (schedule.overlap === 'skip' && this.inFlight.has(routine.id)) {
        // Consistent with the time-grid scheduler: a skip is recorded as
        // a missed run and the item is consumed (never re-fires).
        store.markSeen(routine.id, [item.id], now);
        try {
          this.deps.runStore?.markMissed(
            routine.id, routine.name, now,
            `event item skipped: previous run still in flight (overlap: skip) — ${item.summary}`,
            'event',
          );
        } catch { /* best-effort */ }
        continue;
      }
      // Mark seen BEFORE firing: at-most-once delivery, even if the
      // process dies mid-fire (the run record is the audit trail).
      store.markSeen(routine.id, [item.id], now);
      try {
        const runId = await this.fire(routine, schedule, item, {
          catchUp: catchUpMode,
          skippedCatchUp: skipped,
        });
        if (runId) base.firedRunIds.push(runId);
        store.recordFire(routine.id, day);
        remainingCap -= 1;
        lastFiredAt = now;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.upsertState(routine.id, { ...cursorPatch, lastError: message.slice(0, 300) });
        return { ...base, error: message };
      }
    }
    base.capBlocked = capBlockedCount;
    store.upsertState(routine.id, {
      ...cursorPatch,
      capBlocked: capBlockedCount > 0,
      ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
    });
    if (base.firedRunIds.length > 0) {
      try {
        this.deps.onFire?.(routine, base);
      } catch (err) {
        console.error('[event-triggers] onFire threw:', err instanceof Error ? err.message : err);
      }
    }
    return base;
  }

  /** Fire one event item as a routine run via the existing executor. */
  private async fire(
    routine: BotRoutine,
    schedule: EventSchedule,
    item: EventItem,
    opts: { catchUp: boolean; skippedCatchUp: number },
  ): Promise<string | null> {
    const payload = {
      source: 'event',
      routineId: routine.id,
      routineName: routine.name,
      app: schedule.app,
      accountId: schedule.accountId,
      item: {
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        at: item.ts ? new Date(item.ts).toISOString() : undefined,
        ...item.fields,
      },
      ...(opts.catchUp ? { catchUp: true } : {}),
      ...(opts.skippedCatchUp > 0 ? { skippedCatchUp: opts.skippedCatchUp } : {}),
    };
    this.inFlight.add(routine.id);
    if (this.deps.runExecutor) {
      return this.deps.runExecutor.execute({
        routine,
        trigger: 'event',
        scheduledFor: item.ts || null,
        payload,
        sessionId: routine.sessionId ?? `routine_${routine.id}`,
        onSettled: () => this.inFlight.delete(routine.id),
      });
    }
    // Legacy path (no run executor wired): run the turn directly.
    try {
      const bot = this.deps.getBots?.().find((b) => b.id === routine.botId);
      if (!bot || !this.deps.agentRuntime) {
        this.inFlight.delete(routine.id);
        return null;
      }
      const render = this.deps.renderPrompt ?? defaultRenderPrompt;
      const message = render(routine.promptTemplate, payload);
      void this.deps.agentRuntime
        .runTurn({
          bot,
          message,
          sessionId: routine.sessionId ?? `routine_${routine.id}`,
          taskType: 'chat',
          onEvent: () => {},
        })
        .catch(() => {})
        .finally(() => this.inFlight.delete(routine.id));
      return null;
    } catch {
      this.inFlight.delete(routine.id);
      return null;
    }
  }
}
