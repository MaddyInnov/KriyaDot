// SPDX-License-Identifier: Apache-2.0
// Spend-cap configuration + enforcement for LLM spend (OpenMausBot parity).
//
// Two cap scopes, each with a daily and a monthly cap (USD cents, integer):
//   - global: account-wide spend across all bots
//   - bot:    per-bot spend
//
// Unset = unlimited. Caps are calendar-local (day = local calendar day,
// month = local calendar month), matching the cost dashboard's conventions.
//
// Enforcement is a hard stop, not advisory: the API builds a per-turn gate
// from this store plus the CostTracker ledger (the append-only record of
// every metered event), and the agent runtime consults that gate BEFORE
// every provider.chat call. When a call would push spend over a cap, the
// turn is blocked with a clear "spend cap reached" message and the user is
// push-notified.
//
// Persistence: one `spend_caps` table in the billing database — additive
// only, existing tables untouched.

import { randomUUID } from 'node:crypto';

// vitest cannot statically resolve the `node:sqlite` specifier, so load it
// at runtime via the builtin-module API (same trick as cost-breakdown.ts).
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export type SpendCapPeriod = 'day' | 'month';
export type SpendCapScope = 'global' | 'bot';

export interface BotSpendCaps {
  dailyCents: number | null;
  monthlyCents: number | null;
}

export interface SpendCapConfig {
  global: { dailyCents: number | null; monthlyCents: number | null };
  bots: Record<string, BotSpendCaps>;
}

export interface SpendCapViolation {
  scope: SpendCapScope;
  /** Bot id for bot-scoped caps, null for global. */
  botId: string | null;
  period: SpendCapPeriod;
  capCents: number;
  /** Spend already recorded in the period (USD cents, ledger actuals). */
  spentCents: number;
  /** Inclusive lower bound (ms epoch) of the period. */
  periodStart: number;
  /** Exclusive upper bound (ms epoch) of the period. */
  periodEnd: number;
}

export interface SpendCapStatus {
  scope: SpendCapScope;
  botId: string | null;
  period: SpendCapPeriod;
  /** Null when no cap is set for this scope+period. */
  capCents: number | null;
  spentCents: number;
  exceeded: boolean;
  periodStart: number;
  periodEnd: number;
}

export interface SpendCheckResult {
  allowed: boolean;
  violations: SpendCapViolation[];
}

/** Spend lookup the caller injects (usually CostTracker.spentCents). */
export type SpendLookup = (since: number, until: number, botId?: string) => number;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_caps (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL,
  cap_cents INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id, period)
);
`;

const VALID_SCOPES: ReadonlySet<string> = new Set(['global', 'bot']);
const VALID_PERIODS: ReadonlySet<string> = new Set(['day', 'month']);

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfLocalMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfNextLocalMonth(ts: number): number {
  const d = new Date(startOfLocalMonth(ts));
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

/** [inclusive start, exclusive end] of the cap period containing ts. */
export function periodBounds(period: SpendCapPeriod, ts: number): { start: number; end: number } {
  if (period === 'day') {
    const start = startOfLocalDay(ts);
    return { start, end: start + 24 * 60 * 60 * 1000 };
  }
  return { start: startOfLocalMonth(ts), end: startOfNextLocalMonth(ts) };
}

function requireScope(v: unknown): SpendCapScope {
  if (v !== 'global' && v !== 'bot') throw new Error(`scope must be 'global' or 'bot'`);
  return v;
}

function requirePeriod(v: unknown): SpendCapPeriod {
  if (v !== 'day' && v !== 'month') throw new Error(`period must be 'day' or 'month'`);
  return v;
}

function requireCapCents(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${name} must be a non-negative integer (USD cents)`);
  }
  return v;
}

function requireBotId(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 128) {
    throw new Error('botId must be a non-empty string (max 128 chars)');
  }
  return v.trim();
}

export class SpendCapStore {
  private readonly db: DatabaseSyncType;

  /**
   * @param dbPath SQLite file. Callers pass the billing database path
   * (e.g. `<dataDir>/billing.db`); the table is created idempotently.
   */
  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Set a cap. `capCents === null` removes the cap (back to unlimited).
   * For scope 'global', scopeId is ignored; for 'bot' it is required.
   */
  setCap(scope: SpendCapScope, scopeId: string | undefined, period: SpendCapPeriod, capCents: number | null): void {
    const s = requireScope(scope);
    const p = requirePeriod(period);
    const id = s === 'bot' ? requireBotId(scopeId) : '';
    if (capCents === null || capCents === undefined) {
      this.db
        .prepare(`DELETE FROM spend_caps WHERE scope = ? AND scope_id = ? AND period = ?`)
        .run(s, id, p);
      return;
    }
    const cents = requireCapCents(capCents, 'capCents');
    this.db
      .prepare(
        `INSERT INTO spend_caps (scope, scope_id, period, cap_cents, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_id, period)
         DO UPDATE SET cap_cents = excluded.cap_cents, updated_at = excluded.updated_at`,
      )
      .run(s, id, p, cents, Date.now());
  }

  /** Remove every cap for one bot (e.g. when the bot is deleted). */
  clearBotCaps(botId: string): void {
    const id = requireBotId(botId);
    this.db.prepare(`DELETE FROM spend_caps WHERE scope = 'bot' AND scope_id = ?`).run(id);
  }

  /** Full cap configuration (nulls = unlimited). */
  getConfig(): SpendCapConfig {
    const rows = this.db
      .prepare(`SELECT scope, scope_id, period, cap_cents FROM spend_caps`)
      .all() as unknown as Array<{ scope: string; scope_id: string; period: string; cap_cents: number }>;
    const config: SpendCapConfig = {
      global: { dailyCents: null, monthlyCents: null },
      bots: {},
    };
    for (const r of rows) {
      if (!VALID_SCOPES.has(r.scope) || !VALID_PERIODS.has(r.period)) continue;
      const field = r.period === 'day' ? 'dailyCents' : 'monthlyCents';
      if (r.scope === 'global') {
        config.global[field] = r.cap_cents;
      } else {
        const botId = r.scope_id;
        if (!botId) continue;
        config.bots[botId] ??= { dailyCents: null, monthlyCents: null };
        config.bots[botId][field] = r.cap_cents;
      }
    }
    return config;
  }
}

/**
 * Pure enforcement check. A call is blocked when
 * `spentCents + estimatedAdditionalCents > capCents` for any applicable
 * cap (global day/month + this bot's day/month). All four windows are
 * reported so the user sees exactly which caps tripped.
 */
export function checkSpendCaps(opts: {
  caps: SpendCapConfig;
  botId: string;
  /** Estimated cost of the upcoming provider call, USD cents. */
  estimatedAdditionalCents: number;
  spentLookup: SpendLookup;
  now?: number;
}): SpendCheckResult {
  const { caps, botId, spentLookup } = opts;
  const now = opts.now ?? Date.now();
  const additional = Math.max(0, Math.floor(opts.estimatedAdditionalCents));
  const violations: SpendCapViolation[] = [];

  const checkOne = (
    scope: SpendCapScope,
    scopeBotId: string | null,
    period: SpendCapPeriod,
    capCents: number | null,
  ): void => {
    if (capCents === null) return;
    const { start, end } = periodBounds(period, now);
    const spentCents = Math.max(0, Math.floor(spentLookup(start, end, scope === 'bot' ? botId : undefined)));
    if (spentCents + additional > capCents) {
      violations.push({ scope, botId: scopeBotId, period, capCents, spentCents, periodStart: start, periodEnd: end });
    }
  };

  checkOne('global', null, 'day', caps.global.dailyCents);
  checkOne('global', null, 'month', caps.global.monthlyCents);
  const botCaps = caps.bots[botId];
  if (botCaps) {
    checkOne('bot', botId, 'day', botCaps.dailyCents);
    checkOne('bot', botId, 'month', botCaps.monthlyCents);
  }
  return { allowed: violations.length === 0, violations };
}

/**
 * Dashboard statuses: one row per scope+period that has a cap set, plus
 * current spend in the window. Used for the progress bars in the UI.
 */
export function spendCapStatuses(opts: {
  caps: SpendCapConfig;
  spentLookup: SpendLookup;
  now?: number;
}): SpendCapStatus[] {
  const { caps, spentLookup } = opts;
  const now = opts.now ?? Date.now();
  const statuses: SpendCapStatus[] = [];
  const one = (scope: SpendCapScope, botId: string | null, period: SpendCapPeriod, capCents: number | null): void => {
    if (capCents === null) return;
    const { start, end } = periodBounds(period, now);
    const spentCents = Math.max(0, Math.floor(spentLookup(start, end, scope === 'bot' ? (botId ?? undefined) : undefined)));
    statuses.push({
      scope,
      botId,
      period,
      capCents,
      spentCents,
      exceeded: spentCents >= capCents,
      periodStart: start,
      periodEnd: end,
    });
  };
  one('global', null, 'day', caps.global.dailyCents);
  one('global', null, 'month', caps.global.monthlyCents);
  for (const [botId, c] of Object.entries(caps.bots)) {
    one('bot', botId, 'day', c.dailyCents);
    one('bot', botId, 'month', c.monthlyCents);
  }
  return statuses;
}

/** Human-readable one-liner for a check result, used in the block message. */
export function formatSpendCapMessage(result: SpendCheckResult): string {
  const fmtUsd = (cents: number): string => `$${(cents / 100).toFixed(4)}`;
  const parts = result.violations.map((v) => {
    const who = v.scope === 'global' ? 'Global' : `Bot "${v.botId}"`;
    const per = v.period === 'day' ? 'daily' : 'monthly';
    return `${who} ${per} spend cap: ${fmtUsd(v.spentCents)} spent of ${fmtUsd(v.capCents)} cap`;
  });
  return `Spend cap reached: ${parts.join('; ')}. The call was blocked before any cost was incurred. Raise the cap in Usage & costs → Spend caps, or wait for the next ${result.violations[0]?.period === 'day' ? 'day' : 'month'}.`;
}

/** Unique id helper (kept for symmetry with cost-breakdown's event ids). */
export function newSpendCapId(): string {
  return `sc_${randomUUID()}`;
}
