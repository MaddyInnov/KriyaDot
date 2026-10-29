// SPDX-License-Identifier: Apache-2.0
// Proactive account watching (W5) — watch-rule data model + persistence.
//
// A watch rule tells the watcher service (watch-watcher.ts) to poll one
// connected Composio app on an interval, triage every new item with a
// cheap helper model against the rule's flag instruction, and surface
// only the items that need the user — as "needs you" inbox entries with
// a push notification. Quiet by default: an item the triage does not
// flag leaves no inbox entry and no push (only an Activity/audit line).
//
// Storage follows the existing store patterns (briefing.ts,
// routine-events.ts): node:sqlite via openDb from @mvp/agent-runtime,
// one database file (<dataDir>/watch.db) holding:
//
//   watch_rules       — the rules themselves (CRUD target)
//   watch_state       — per-rule poll cursor / last-poll / last-error
//   watch_seen_items  — dedupe set: a source item is triaged at most
//                       once, ever, across restarts (pruned after 90d)
//   watch_daily       — per-rule per-day surfaced counts (daily cap)
//   watch_items       — surfaced "needs you" items + their action state
//   watch_runs        — one row per watcher poll (Activity/audit trail)
//
// No credentials live here: a rule references a Composio connected
// account by id only; the API key is resolved inside the Composio
// execution path (routine-events.ts createComposioEventExecutor).

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';
import { assertValidTimeZone, type EventAppId } from './routine-schedules.js';
import { eventDayKey } from './routine-events.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Connected apps a watch rule can watch (Composio toolkit slugs, W2 set). */
export type WatchAppId = EventAppId;

export const WATCH_APP_IDS: readonly WatchAppId[] = ['gmail', 'slack', 'github', 'stripe', 'googlecalendar'];

/**
 * Structured flag kinds. A rule always carries one kind plus a free-text
 * instruction; 'custom' means the instruction is the whole criterion.
 */
export type WatchKind =
  | 'needs-reply'
  | 'payment-failed'
  | 'review-requested'
  | 'meeting-conflict'
  | 'mention'
  | 'custom';

export const WATCH_KINDS: readonly WatchKind[] = [
  'needs-reply',
  'payment-failed',
  'review-requested',
  'meeting-conflict',
  'mention',
  'custom',
];

/** Default human instruction per structured kind (the triage prompt base). */
export const WATCH_KIND_INSTRUCTIONS: Record<Exclude<WatchKind, 'custom'>, string> = {
  'needs-reply': 'Flag items that are waiting on the user for a reply or a decision.',
  'payment-failed': 'Flag failed payments, declined charges, and billing problems that need the user to act.',
  'review-requested': 'Flag items asking the user to review, approve, or give feedback on something.',
  'meeting-conflict': 'Flag calendar items that conflict with each other or need the user to reschedule.',
  mention: 'Flag items that directly mention or address the user and expect a response.',
};

export type WatchItemStatus = 'new' | 'actioned' | 'dismissed';
export type WatchUrgency = 'low' | 'medium' | 'high';

export interface WatchRule {
  id: string;
  /** Display name; derived from app + kind when not supplied. */
  name: string;
  /** Owner bot — the bot that watches and drafts. Default: the Chief. */
  botId: string;
  /** KriyaDot user that owns the connected account. */
  userId: string;
  app: WatchAppId;
  /** Connected Composio account id for `app`. */
  accountId: string;
  kind: WatchKind;
  /** Free-text flag instruction (required for kind 'custom'). */
  instruction: string;
  /** Check interval in minutes: default 240 (4h), clamped 30..1440. */
  intervalMinutes: number;
  enabled: boolean;
  /** Max items surfaced per day (rule timezone): default 10, 1..100. */
  dailyCap: number;
  /** IANA timezone for the daily-cap bucket. Default 'UTC'. */
  timezone: string;
  // Optional per-source scoping (mirrors the W2 event-source fields).
  channelId?: string;
  repo?: string;
  calendarId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WatchRuleState {
  ruleId: string;
  cursorId: string | null;
  cursorTs: number | null;
  lastPollAt: number | null;
  lastSurfacedAt: number | null;
  lastError: string | null;
  /** A previous poll left unseen items behind because the daily cap hit. */
  capBlocked: boolean;
  updatedAt: number;
}

/** A surfaced "needs you" item — one row of the watch inbox. */
export interface WatchItem {
  id: string;
  ruleId: string;
  /** Dedupe id of the source item, unique within the rule. */
  sourceItemId: string;
  app: WatchAppId;
  /** Source item category (EventItem.kind), e.g. "message", "payment_failed". */
  sourceKind: string;
  summary: string;
  /** Small flat field set from the source item (strings only). */
  fields: Record<string, string>;
  urgency: WatchUrgency;
  /** Triage reason this item was surfaced. */
  reason: string;
  /** Triage-suggested next action for the user. */
  suggestedAction: string;
  status: WatchItemStatus;
  /** Draft reply produced by the Draft action (text + optional ref). */
  draftText?: string;
  draftRef?: string;
  /** Source item timestamp (epoch ms), when known. */
  itemTs: number | null;
  surfacedAt: number;
  updatedAt: number;
}

/** One watcher poll, recorded for Activity/audit. */
export interface WatchRun {
  id: number;
  ruleId: string;
  startedAt: number;
  /** Items listed from the source on this poll. */
  listed: number;
  /** New (previously unseen) items triaged on this poll. */
  checked: number;
  /** Items surfaced to the inbox on this poll. */
  surfaced: number;
  /** Older items skipped by the bounded catch-up (marked seen). */
  skippedCatchUp: number;
  /** Items left unseen because the daily cap was reached. */
  capBlocked: number;
  /** 'baseline established' on a rule's first-ever poll. */
  note?: string;
  error?: string;
}

export const WATCH_DEFAULT_INTERVAL_MINUTES = 240;
export const WATCH_MIN_INTERVAL_MINUTES = 30;
export const WATCH_MAX_INTERVAL_MINUTES = 1440;
export const WATCH_DEFAULT_DAILY_CAP = 10;
export const WATCH_MAX_DAILY_CAP = 100;
/** Seen-item retention: ids older than this are pruned (dedupe horizon). */
export const WATCH_SEEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function optString(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return t;
}

function clampInterval(v: unknown): number {
  if (v === undefined || v === null) return WATCH_DEFAULT_INTERVAL_MINUTES;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error('intervalMinutes must be a number of minutes');
  }
  // Clamp, per spec: below the floor polls too hot, above the ceiling is
  // effectively "never" — both are user error, silently corrected.
  return Math.min(WATCH_MAX_INTERVAL_MINUTES, Math.max(WATCH_MIN_INTERVAL_MINUTES, Math.round(v)));
}

function clampDailyCap(v: unknown): number {
  if (v === undefined || v === null) return WATCH_DEFAULT_DAILY_CAP;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error('dailyCap must be a number');
  }
  return Math.min(WATCH_MAX_DAILY_CAP, Math.max(1, Math.round(v)));
}

export interface WatchRuleInput {
  name?: string;
  botId: string;
  userId: string;
  app: WatchAppId;
  accountId: string;
  kind: WatchKind;
  instruction: string;
  intervalMinutes: number;
  enabled: boolean;
  dailyCap: number;
  timezone: string;
  channelId?: string;
  repo?: string;
  calendarId?: string;
}

/**
 * Validate + normalize a watch-rule create body. `defaultBotId` is the
 * caller's Chief (the owner bot when the body names none). Throws a
 * descriptive Error on any problem.
 */
export function validateWatchRuleInput(input: unknown, opts?: { defaultBotId?: string }): WatchRuleInput {
  if (typeof input !== 'object' || input === null) throw new Error('watch rule must be an object');
  const b = input as Record<string, unknown>;

  const app = b.app;
  if (typeof app !== 'string' || !(WATCH_APP_IDS as readonly string[]).includes(app)) {
    throw new Error(`app must be one of: ${WATCH_APP_IDS.join(', ')}`);
  }
  const accountId = b.accountId;
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId.trim())) {
    throw new Error('accountId is required (the connected Composio account id)');
  }
  const kindRaw = b.kind === undefined || b.kind === null ? 'custom' : b.kind;
  if (typeof kindRaw !== 'string' || !(WATCH_KINDS as readonly string[]).includes(kindRaw)) {
    throw new Error(`kind must be one of: ${WATCH_KINDS.join(', ')}`);
  }
  const kind = kindRaw as WatchKind;
  const instruction = optString(b.instruction, 'instruction', 2000) ?? '';
  if (kind === 'custom' && !instruction) {
    throw new Error('instruction is required when kind is "custom" (say what to flag)');
  }
  const botId = optString(b.botId, 'botId', 64) ?? opts?.defaultBotId ?? 'chief';
  if (!ID_RE.test(botId)) throw new Error('botId must match /^[A-Za-z0-9_-]{1,64}$/');
  const userId = optString(b.userId, 'userId', 64) ?? 'default-user';
  if (!ID_RE.test(userId)) throw new Error('userId must match /^[A-Za-z0-9_-]{1,64}$/');
  const timezone = optString(b.timezone, 'timezone', 64) ?? 'UTC';
  assertValidTimeZone(timezone); // throws on unknown zones
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  const out: WatchRuleInput = {
    name: optString(b.name, 'name', 120),
    botId,
    userId,
    app: app as WatchAppId,
    accountId: accountId.trim(),
    kind,
    instruction,
    intervalMinutes: clampInterval(b.intervalMinutes),
    enabled: b.enabled === undefined ? true : b.enabled,
    dailyCap: clampDailyCap(b.dailyCap),
    timezone,
  };
  const channelId = optString(b.channelId, 'channelId', 64);
  if (channelId) out.channelId = channelId;
  const repo = optString(b.repo, 'repo', 200);
  if (repo) {
    if (!REPO_RE.test(repo)) throw new Error('repo must be in "owner/name" form');
    out.repo = repo;
  }
  const calendarId = optString(b.calendarId, 'calendarId', 200);
  if (calendarId) out.calendarId = calendarId;
  if (app === 'slack' && !out.channelId) {
    throw new Error('channelId is required for slack (the channel id to watch)');
  }
  if (app === 'github' && !out.repo) {
    throw new Error('repo is required for github in "owner/name" form');
  }
  return out;
}

/** Validate a PATCH body against the existing rule (merge, then validate). */
export function validateWatchRulePatch(existing: WatchRule, patch: unknown): WatchRuleInput {
  if (typeof patch !== 'object' || patch === null) throw new Error('patch must be an object');
  const p = patch as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    name: existing.name,
    botId: existing.botId,
    userId: existing.userId,
    app: existing.app,
    accountId: existing.accountId,
    kind: existing.kind,
    instruction: existing.instruction,
    intervalMinutes: existing.intervalMinutes,
    enabled: existing.enabled,
    dailyCap: existing.dailyCap,
    timezone: existing.timezone,
    channelId: existing.channelId,
    repo: existing.repo,
    calendarId: existing.calendarId,
  };
  for (const key of Object.keys(merged)) {
    if (p[key] !== undefined) merged[key] = p[key];
  }
  return validateWatchRuleInput(merged, { defaultBotId: existing.botId });
}

/** The effective flag instruction for triage: kind default + free text. */
export function effectiveInstruction(rule: Pick<WatchRule, 'kind' | 'instruction'>): string {
  if (rule.kind === 'custom') return rule.instruction;
  const base = WATCH_KIND_INSTRUCTIONS[rule.kind];
  return rule.instruction ? `${base} Additional instruction from the user: ${rule.instruction}` : base;
}

/** Day key (YYYY-MM-DD) in the rule's timezone — the daily-cap bucket. */
export function watchDayKey(rule: Pick<WatchRule, 'timezone'>, nowMs: number): string {
  return eventDayKey(rule.timezone, nowMs);
}

function defaultName(input: WatchRuleInput): string {
  return `${input.app} watch — ${input.kind}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string;
  name: string;
  bot_id: string;
  user_id: string;
  app: string;
  account_id: string;
  kind: string;
  instruction: string;
  interval_minutes: number;
  enabled: number;
  daily_cap: number;
  timezone: string;
  channel_id: string | null;
  repo: string | null;
  calendar_id: string | null;
  created_at: number;
  updated_at: number;
}

interface StateRow {
  rule_id: string;
  cursor_id: string | null;
  cursor_ts: number | null;
  last_poll_at: number | null;
  last_surfaced_at: number | null;
  last_error: string | null;
  cap_blocked: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  rule_id: string;
  source_item_id: string;
  app: string;
  source_kind: string;
  summary: string;
  fields_json: string;
  urgency: string;
  reason: string;
  suggested_action: string;
  status: string;
  draft_text: string | null;
  draft_ref: string | null;
  item_ts: number | null;
  surfaced_at: number;
  updated_at: number;
}

interface RunRow {
  id: number;
  rule_id: string;
  started_at: number;
  listed: number;
  checked: number;
  surfaced: number;
  skipped_catch_up: number;
  cap_blocked: number;
  note: string | null;
  error: string | null;
}

function rowToRule(r: RuleRow): WatchRule {
  const rule: WatchRule = {
    id: r.id,
    name: r.name,
    botId: r.bot_id,
    userId: r.user_id,
    app: r.app as WatchAppId,
    accountId: r.account_id,
    kind: r.kind as WatchKind,
    instruction: r.instruction,
    intervalMinutes: r.interval_minutes,
    enabled: r.enabled === 1,
    dailyCap: r.daily_cap,
    timezone: r.timezone,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.channel_id) rule.channelId = r.channel_id;
  if (r.repo) rule.repo = r.repo;
  if (r.calendar_id) rule.calendarId = r.calendar_id;
  return rule;
}

function rowToState(r: StateRow): WatchRuleState {
  return {
    ruleId: r.rule_id,
    cursorId: r.cursor_id,
    cursorTs: r.cursor_ts,
    lastPollAt: r.last_poll_at,
    lastSurfacedAt: r.last_surfaced_at,
    lastError: r.last_error,
    capBlocked: r.cap_blocked === 1,
    updatedAt: r.updated_at,
  };
}

function rowToItem(r: ItemRow): WatchItem {
  let fields: Record<string, string> = {};
  try {
    const parsed = JSON.parse(r.fields_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fields = parsed as Record<string, string>;
    }
  } catch {
    fields = {};
  }
  const item: WatchItem = {
    id: r.id,
    ruleId: r.rule_id,
    sourceItemId: r.source_item_id,
    app: r.app as WatchAppId,
    sourceKind: r.source_kind,
    summary: r.summary,
    fields,
    urgency: (['low', 'medium', 'high'].includes(r.urgency) ? r.urgency : 'medium') as WatchUrgency,
    reason: r.reason,
    suggestedAction: r.suggested_action,
    status: r.status as WatchItemStatus,
    itemTs: r.item_ts,
    surfacedAt: r.surfaced_at,
    updatedAt: r.updated_at,
  };
  if (r.draft_text) item.draftText = r.draft_text;
  if (r.draft_ref) item.draftRef = r.draft_ref;
  return item;
}

function rowToRun(r: RunRow): WatchRun {
  const run: WatchRun = {
    id: r.id,
    ruleId: r.rule_id,
    startedAt: r.started_at,
    listed: r.listed,
    checked: r.checked,
    surfaced: r.surfaced,
    skippedCatchUp: r.skipped_catch_up,
    capBlocked: r.cap_blocked,
  };
  if (r.note) run.note = r.note;
  if (r.error) run.error = r.error;
  return run;
}

export class WatchStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'watch.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watch_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        app TEXT NOT NULL,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        interval_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        daily_cap INTEGER NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        channel_id TEXT,
        repo TEXT,
        calendar_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_state (
        rule_id TEXT PRIMARY KEY,
        cursor_id TEXT,
        cursor_ts INTEGER,
        last_poll_at INTEGER,
        last_surfaced_at INTEGER,
        last_error TEXT,
        cap_blocked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_seen_items (
        rule_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (rule_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS watch_daily (
        rule_id TEXT NOT NULL,
        day TEXT NOT NULL,
        surfaced INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (rule_id, day)
      );
      CREATE TABLE IF NOT EXISTS watch_items (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        source_item_id TEXT NOT NULL,
        app TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        fields_json TEXT NOT NULL DEFAULT '{}',
        urgency TEXT NOT NULL DEFAULT 'medium',
        reason TEXT NOT NULL DEFAULT '',
        suggested_action TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        draft_text TEXT,
        draft_ref TEXT,
        item_ts INTEGER,
        surfaced_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (rule_id, source_item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_watch_items_status ON watch_items (status, surfaced_at DESC);
      CREATE TABLE IF NOT EXISTS watch_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        listed INTEGER NOT NULL DEFAULT 0,
        checked INTEGER NOT NULL DEFAULT 0,
        surfaced INTEGER NOT NULL DEFAULT 0,
        skipped_catch_up INTEGER NOT NULL DEFAULT 0,
        cap_blocked INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_watch_runs_rule ON watch_runs (rule_id, started_at DESC);
    `);
  }

  // ---- Rules ---------------------------------------------------------------

  createRule(input: WatchRuleInput, now = Date.now()): WatchRule {
    const rule: WatchRule = {
      id: `wr_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      name: input.name ?? defaultName(input),
      botId: input.botId ?? 'chief',
      userId: input.userId ?? 'default-user',
      app: input.app,
      accountId: input.accountId,
      kind: input.kind,
      instruction: input.instruction,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled,
      dailyCap: input.dailyCap,
      timezone: input.timezone,
      createdAt: now,
      updatedAt: now,
    };
    if (input.channelId) rule.channelId = input.channelId;
    if (input.repo) rule.repo = input.repo;
    if (input.calendarId) rule.calendarId = input.calendarId;
    this.db
      .prepare(
        `INSERT INTO watch_rules
           (id, name, bot_id, user_id, app, account_id, kind, instruction, interval_minutes,
            enabled, daily_cap, timezone, channel_id, repo, calendar_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id, rule.name, rule.botId, rule.userId, rule.app, rule.accountId, rule.kind,
        rule.instruction, rule.intervalMinutes, rule.enabled ? 1 : 0, rule.dailyCap, rule.timezone,
        rule.channelId ?? null, rule.repo ?? null, rule.calendarId ?? null, now, now,
      );
    return rule;
  }

  getRule(id: string): WatchRule | undefined {
    const row = this.db.prepare('SELECT * FROM watch_rules WHERE id = ?').get(id) as unknown as RuleRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  listRules(): WatchRule[] {
    const rows = this.db.prepare('SELECT * FROM watch_rules ORDER BY created_at ASC').all() as unknown as RuleRow[];
    return rows.map(rowToRule);
  }

  updateRule(id: string, input: WatchRuleInput, now = Date.now()): WatchRule | undefined {
    const existing = this.getRule(id);
    if (!existing) return undefined;
    this.db
      .prepare(
        `UPDATE watch_rules SET name = ?, bot_id = ?, user_id = ?, app = ?, account_id = ?,
           kind = ?, instruction = ?, interval_minutes = ?, enabled = ?, daily_cap = ?,
           timezone = ?, channel_id = ?, repo = ?, calendar_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name, input.botId ?? existing.botId, input.userId ?? existing.userId,
        input.app, input.accountId, input.kind, input.instruction, input.intervalMinutes,
        input.enabled ? 1 : 0, input.dailyCap, input.timezone,
        input.channelId ?? null, input.repo ?? null, input.calendarId ?? null, now, id,
      );
    return this.getRule(id);
  }

  setEnabled(id: string, enabled: boolean, now = Date.now()): WatchRule | undefined {
    const r = this.db.prepare('UPDATE watch_rules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now, id);
    return r.changes > 0 ? this.getRule(id) : undefined;
  }

  deleteRule(id: string): boolean {
    const r = this.db.prepare('DELETE FROM watch_rules WHERE id = ?').run(id);
    if (r.changes === 0) return false;
    this.db.prepare('DELETE FROM watch_state WHERE rule_id = ?').run(id);
    this.db.prepare('DELETE FROM watch_seen_items WHERE rule_id = ?').run(id);
    this.db.prepare('DELETE FROM watch_daily WHERE rule_id = ?').run(id);
    this.db.prepare('DELETE FROM watch_items WHERE rule_id = ?').run(id);
    this.db.prepare('DELETE FROM watch_runs WHERE rule_id = ?').run(id);
    return true;
  }

  // ---- Poll state (cursor / seen-set / daily counts) ------------------------

  getState(ruleId: string): WatchRuleState | undefined {
    const row = this.db.prepare('SELECT * FROM watch_state WHERE rule_id = ?').get(ruleId) as unknown as StateRow | undefined;
    return row ? rowToState(row) : undefined;
  }

  upsertState(ruleId: string, patch: Partial<Omit<WatchRuleState, 'ruleId' | 'updatedAt'>>): WatchRuleState {
    const cur = this.getState(ruleId);
    const next: WatchRuleState = {
      ruleId,
      cursorId: patch.cursorId !== undefined ? patch.cursorId : (cur?.cursorId ?? null),
      cursorTs: patch.cursorTs !== undefined ? patch.cursorTs : (cur?.cursorTs ?? null),
      lastPollAt: patch.lastPollAt !== undefined ? patch.lastPollAt : (cur?.lastPollAt ?? null),
      lastSurfacedAt: patch.lastSurfacedAt !== undefined ? patch.lastSurfacedAt : (cur?.lastSurfacedAt ?? null),
      lastError: patch.lastError !== undefined ? patch.lastError : (cur?.lastError ?? null),
      capBlocked: patch.capBlocked !== undefined ? patch.capBlocked : (cur?.capBlocked ?? false),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO watch_state
           (rule_id, cursor_id, cursor_ts, last_poll_at, last_surfaced_at, last_error, cap_blocked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_id) DO UPDATE SET
           cursor_id = excluded.cursor_id, cursor_ts = excluded.cursor_ts,
           last_poll_at = excluded.last_poll_at, last_surfaced_at = excluded.last_surfaced_at,
           last_error = excluded.last_error, cap_blocked = excluded.cap_blocked,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.ruleId, next.cursorId, next.cursorTs, next.lastPollAt,
        next.lastSurfacedAt, next.lastError, next.capBlocked ? 1 : 0, next.updatedAt,
      );
    return next;
  }

  hasSeen(ruleId: string, itemId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM watch_seen_items WHERE rule_id = ? AND item_id = ?')
      .get(ruleId, itemId) as unknown as { x: number } | undefined;
    return row !== undefined;
  }

  markSeen(ruleId: string, itemIds: string[], now = Date.now()): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO watch_seen_items (rule_id, item_id, seen_at) VALUES (?, ?, ?)',
    );
    for (const id of itemIds) stmt.run(ruleId, id, now);
  }

  pruneSeen(ruleId: string, beforeMs: number): number {
    const r = this.db.prepare('DELETE FROM watch_seen_items WHERE rule_id = ? AND seen_at < ?').run(ruleId, beforeMs);
    return Number(r.changes);
  }

  surfacedOn(ruleId: string, day: string): number {
    const row = this.db
      .prepare('SELECT surfaced FROM watch_daily WHERE rule_id = ? AND day = ?')
      .get(ruleId, day) as unknown as { surfaced: number } | undefined;
    return row?.surfaced ?? 0;
  }

  recordSurface(ruleId: string, day: string): number {
    this.db
      .prepare(
        `INSERT INTO watch_daily (rule_id, day, surfaced) VALUES (?, ?, 1)
         ON CONFLICT(rule_id, day) DO UPDATE SET surfaced = surfaced + 1`,
      )
      .run(ruleId, day);
    return this.surfacedOn(ruleId, day);
  }

  /** Boot view: how many rules carry a persisted cursor. */
  countStates(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM watch_state').get() as unknown as { n: number };
    return row.n;
  }

  // ---- Surfaced items --------------------------------------------------------

  /**
   * Insert a surfaced item. Returns undefined when (rule, source item)
   * already surfaced once — a surfaced item never duplicates, and a
   * dismissed one never resurfaces through this path.
   */
  createItem(input: {
    ruleId: string;
    sourceItemId: string;
    app: WatchAppId;
    sourceKind: string;
    summary: string;
    fields: Record<string, string>;
    urgency: WatchUrgency;
    reason: string;
    suggestedAction: string;
    itemTs: number | null;
  }, now = Date.now()): WatchItem | undefined {
    const id = `wi_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO watch_items
           (id, rule_id, source_item_id, app, source_kind, summary, fields_json, urgency,
            reason, suggested_action, status, item_ts, surfaced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      )
      .run(
        id, input.ruleId, input.sourceItemId, input.app, input.sourceKind, input.summary,
        JSON.stringify(input.fields), input.urgency, input.reason, input.suggestedAction,
        input.itemTs, now, now,
      );
    if (r.changes === 0) return undefined;
    return this.getItem(id);
  }

  getItem(id: string): WatchItem | undefined {
    const row = this.db.prepare('SELECT * FROM watch_items WHERE id = ?').get(id) as unknown as ItemRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  getItemBySource(ruleId: string, sourceItemId: string): WatchItem | undefined {
    const row = this.db
      .prepare('SELECT * FROM watch_items WHERE rule_id = ? AND source_item_id = ?')
      .get(ruleId, sourceItemId) as unknown as ItemRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  listItems(filter: { status?: WatchItemStatus; ruleId?: string; limit?: number } = {}): WatchItem[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.ruleId) {
      clauses.push('rule_id = ?');
      params.push(filter.ruleId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM watch_items ${where} ORDER BY surfaced_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as ItemRow[];
    return rows.map(rowToItem);
  }

  updateItem(
    id: string,
    patch: Partial<Pick<WatchItem, 'status' | 'draftText' | 'draftRef'>>,
    now = Date.now(),
  ): WatchItem | undefined {
    const cur = this.getItem(id);
    if (!cur) return undefined;
    this.db
      .prepare('UPDATE watch_items SET status = ?, draft_text = ?, draft_ref = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.status ?? cur.status,
        patch.draftText !== undefined ? patch.draftText : (cur.draftText ?? null),
        patch.draftRef !== undefined ? patch.draftRef : (cur.draftRef ?? null),
        now,
        id,
      );
    return this.getItem(id);
  }

  // ---- Runs (Activity/audit trail) -------------------------------------------

  recordRun(run: Omit<WatchRun, 'id'>): WatchRun {
    const r = this.db
      .prepare(
        `INSERT INTO watch_runs
           (rule_id, started_at, listed, checked, surfaced, skipped_catch_up, cap_blocked, note, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.ruleId, run.startedAt, run.listed, run.checked, run.surfaced,
        run.skippedCatchUp, run.capBlocked, run.note ?? null, run.error ?? null,
      );
    return { ...run, id: Number(r.lastInsertRowid) };
  }

  listRuns(filter: { ruleId?: string; limit?: number } = {}): WatchRun[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const rows = filter.ruleId
      ? (this.db
          .prepare('SELECT * FROM watch_runs WHERE rule_id = ? ORDER BY started_at DESC LIMIT ?')
          .all(filter.ruleId, limit) as unknown as RunRow[])
      : (this.db
          .prepare('SELECT * FROM watch_runs ORDER BY started_at DESC LIMIT ?')
          .all(limit) as unknown as RunRow[]);
    return rows.map(rowToRun);
  }
}
