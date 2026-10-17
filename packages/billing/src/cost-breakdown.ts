// SPDX-License-Identifier: Apache-2.0
// Cost dashboard backend (Laya-inspired, adapted — not copied): per-feature
// and per-pipeline-step token + spend breakdown, plus monthly per-feature
// cap checks with a `capExceeded` signal.
//
// - CostTracker.record(): log one usage event as
//   { feature, step, model, inputTokens, outputTokens, costCents }.
// - CostTracker.breakdown(): aggregate by feature and by step over a
//   day / week / month / custom range.
// - CostTracker.setFeatureCap() / capStatus() / allCapStatuses(): monthly
//   spend caps per feature; capStatus().capExceeded is the dashboard signal.
//
// Money is integer USD cents (same unit as pricing.ts). Periods are local
// calendar day / calendar month, or a rolling 7 days for 'week'.
// Persistence: two tables (`cost_events`, `feature_caps`) in the billing
// database — additive only, the existing `usage_events` table is untouched.

import { randomUUID } from 'node:crypto';

// vitest cannot statically resolve the `node:sqlite` specifier, so load it
// at runtime via the builtin-module API (same trick as meter.ts).
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export interface CostEventInput {
  /** Feature bucket, e.g. 'chat', 'workflows', 'mcp', 'memory-distill'. */
  feature: string;
  /** Pipeline step, e.g. 'provider.chat', 'tool.execute', 'recall'. */
  step: string;
  /** Model id, e.g. 'llama-3.3-70b-versatile'. Optional. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * USD cents. When omitted the tracker estimates from input/output tokens
   * using the default price config (BILLING_* env, same as costOfUsage).
   */
  costCents?: number;
  sessionId?: string;
  botId?: string;
}

export interface CostEvent {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  feature: string;
  step: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export type BreakdownPeriod = 'day' | 'week' | 'month' | 'all';

export interface FeatureSlice {
  feature: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface StepSlice {
  step: string;
  feature: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface CostTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface CostBreakdown {
  period: BreakdownPeriod;
  /** Inclusive lower bound (ms epoch) of the aggregated range. */
  since: number;
  /** Exclusive upper bound (ms epoch) of the aggregated range. */
  until: number;
  byFeature: FeatureSlice[];
  byStep: StepSlice[];
  totals: CostTotals;
}

export interface FeatureCapStatus {
  feature: string;
  /** Monthly cap in USD cents (null when no cap is set). */
  capCents: number | null;
  /** Spent in the calendar month containing the reference time. */
  spentCents: number;
  /** True when a cap is set and spentCents > capCents. */
  capExceeded: boolean;
  periodStart: number;
  periodEnd: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  bot_id TEXT NOT NULL DEFAULT '',
  feature TEXT NOT NULL,
  step TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_events_ts ON cost_events (ts);
CREATE INDEX IF NOT EXISTS idx_cost_events_feature_ts ON cost_events (feature, ts);
CREATE TABLE IF NOT EXISTS feature_caps (
  feature TEXT PRIMARY KEY,
  monthly_cap_cents INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function requireLabel(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 128) {
    throw new Error(`${name} must be a non-empty string (max 128 chars)`);
  }
  return v.trim();
}

function requireNonNegativeInt(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfLocalMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfNextLocalMonth(ts: number): number {
  const d = new Date(startOfLocalMonth(ts));
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

/** Default per-1M-token prices in USD cents (mirrors pricing.ts defaults). */
const DEFAULT_INPUT_PER_1M_CENTS = 30;
const DEFAULT_OUTPUT_PER_1M_CENTS = 60;

function estimateCostCents(inputTokens: number, outputTokens: number): number {
  const env = process.env;
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const inC = Math.round((inputTokens / 1_000_000) * num('BILLING_INPUT_PER_1M_CENTS', DEFAULT_INPUT_PER_1M_CENTS));
  const outC = Math.round((outputTokens / 1_000_000) * num('BILLING_OUTPUT_PER_1M_CENTS', DEFAULT_OUTPUT_PER_1M_CENTS));
  return inC + outC;
}

export class CostTracker {
  private readonly db: DatabaseSyncType;

  /**
   * @param dbPath SQLite file. Callers pass the billing database path
   * (e.g. `<dataDir>/billing.db`); tables are created idempotently.
   */
  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Record one per-feature/per-step usage event. */
  record(input: CostEventInput): CostEvent {
    const feature = requireLabel(input.feature, 'feature');
    const step = requireLabel(input.step, 'step');
    const inputTokens = requireNonNegativeInt(input.inputTokens, 'inputTokens');
    const outputTokens = requireNonNegativeInt(input.outputTokens, 'outputTokens');
    const costCents =
      input.costCents === undefined
        ? estimateCostCents(inputTokens, outputTokens)
        : requireNonNegativeInt(input.costCents, 'costCents');
    const event: CostEvent = {
      id: `ce_${randomUUID()}`,
      ts: Date.now(),
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      botId: typeof input.botId === 'string' ? input.botId : '',
      feature,
      step,
      model: typeof input.model === 'string' && input.model ? input.model : null,
      inputTokens,
      outputTokens,
      costCents,
    };
    this.db
      .prepare(
        `INSERT INTO cost_events
           (id, ts, session_id, bot_id, feature, step, model, input_tokens, output_tokens, cost_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.ts,
        event.sessionId,
        event.botId,
        event.feature,
        event.step,
        event.model,
        event.inputTokens,
        event.outputTokens,
        event.costCents,
      );
    return event;
  }

  /**
   * Aggregate cost events. `period` selects a range ending now
   * (day = local calendar day, week = rolling 7 days, month = local
   * calendar month, all = everything); explicit since/until override it.
   * Optional `feature` narrows to one feature.
   */
  breakdown(
    opts: { period?: BreakdownPeriod; since?: number; until?: number; feature?: string } = {},
  ): CostBreakdown {
    const period = opts.period ?? 'month';
    if (!['day', 'week', 'month', 'all'].includes(period)) {
      throw new Error(`period must be one of day|week|month|all`);
    }
    const now = Date.now();
    let since: number;
    let until = opts.until ?? now + 1;
    if (opts.since !== undefined) {
      since = opts.since;
    } else {
      switch (period) {
        case 'day':
          since = startOfLocalDay(now);
          break;
        case 'week':
          since = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case 'month':
          since = startOfLocalMonth(now);
          break;
        case 'all':
          since = 0;
          break;
      }
    }

    const conds = ['ts >= ?', 'ts < ?'];
    const args: Array<string | number> = [since, until];
    if (opts.feature) {
      conds.push('feature = ?');
      args.push(opts.feature);
    }
    const where = `WHERE ${conds.join(' AND ')}`;

    const byFeature = this.db
      .prepare(
        `SELECT feature,
                COUNT(*) AS events,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_cents), 0) AS cost_cents
         FROM cost_events ${where}
         GROUP BY feature ORDER BY cost_cents DESC`,
      )
      .all(...args) as Array<{
      feature: string;
      events: number;
      input_tokens: number;
      output_tokens: number;
      cost_cents: number;
    }>;

    const byStep = this.db
      .prepare(
        `SELECT step, feature,
                COUNT(*) AS events,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_cents), 0) AS cost_cents
         FROM cost_events ${where}
         GROUP BY step, feature ORDER BY cost_cents DESC`,
      )
      .all(...args) as Array<{
      step: string;
      feature: string;
      events: number;
      input_tokens: number;
      output_tokens: number;
      cost_cents: number;
    }>;

    const totals: CostTotals = { events: 0, inputTokens: 0, outputTokens: 0, costCents: 0 };
    const featureSlices: FeatureSlice[] = byFeature.map((r) => {
      totals.events += r.events;
      totals.inputTokens += r.input_tokens;
      totals.outputTokens += r.output_tokens;
      totals.costCents += r.cost_cents;
      return {
        feature: r.feature,
        events: r.events,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costCents: r.cost_cents,
      };
    });
    const stepSlices: StepSlice[] = byStep.map((r) => ({
      step: r.step,
      feature: r.feature,
      events: r.events,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costCents: r.cost_cents,
    }));

    return { period, since, until, byFeature: featureSlices, byStep: stepSlices, totals };
  }

  /**
   * Append-only usage ledger: raw metered events, newest first. Every
   * costTracker.record() call lands here (timestamp, bot, session, model,
   * tokens in/out, estimated USD cost, feature, step). This is the backing
   * store for the spend-cap enforcer and the CSV export.
   */
  listEvents(
    opts: { since?: number; until?: number; botId?: string; limit?: number } = {},
  ): CostEvent[] {
    const conds: string[] = [];
    const args: Array<string | number> = [];
    if (opts.since !== undefined) {
      conds.push('ts >= ?');
      args.push(opts.since);
    }
    if (opts.until !== undefined) {
      conds.push('ts < ?');
      args.push(opts.until);
    }
    if (opts.botId) {
      conds.push('bot_id = ?');
      args.push(opts.botId);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = opts.limit === undefined ? 500 : Math.max(1, Math.min(5000, Math.floor(opts.limit)));
    const rows = this.db
      .prepare(
        `SELECT id, ts, session_id, bot_id, feature, step, model,
                input_tokens, output_tokens, cost_cents
         FROM cost_events ${where}
         ORDER BY ts DESC, rowid DESC LIMIT ?`,
      )
      .all(...args, limit) as Array<{
      id: string;
      ts: number;
      session_id: string;
      bot_id: string;
      feature: string;
      step: string;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      cost_cents: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      sessionId: r.session_id,
      botId: r.bot_id,
      feature: r.feature,
      step: r.step,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costCents: r.cost_cents,
    }));
  }

  /**
   * Total spend (USD cents) in a window — the read path the spend-cap
   * enforcer uses. `botId` narrows to one bot; omit for account-wide.
   */
  spentCents(opts: { since: number; until: number; botId?: string }): number {
    const conds = ['ts >= ?', 'ts < ?'];
    const args: Array<string | number> = [opts.since, opts.until];
    if (opts.botId) {
      conds.push('bot_id = ?');
      args.push(opts.botId);
    }
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_cents), 0) AS spent FROM cost_events WHERE ${conds.join(' AND ')}`)
      .get(...args) as unknown as { spent: number };
    return row.spent;
  }
  setFeatureCap(feature: string, monthlyCapCents: number): void {
    const f = requireLabel(feature, 'feature');
    const cap = requireNonNegativeInt(monthlyCapCents, 'monthlyCapCents');
    this.db
      .prepare(
        `INSERT INTO feature_caps (feature, monthly_cap_cents, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET monthly_cap_cents = excluded.monthly_cap_cents, updated_at = excluded.updated_at`,
      )
      .run(f, cap, Date.now());
  }

  getFeatureCap(feature: string): number | undefined {
    const row = this.db
      .prepare(`SELECT monthly_cap_cents FROM feature_caps WHERE feature = ?`)
      .get(feature) as unknown as { monthly_cap_cents: number } | undefined;
    return row?.monthly_cap_cents;
  }

  listFeatureCaps(): Array<{ feature: string; monthlyCapCents: number }> {
    const rows = this.db
      .prepare(`SELECT feature, monthly_cap_cents FROM feature_caps ORDER BY feature ASC`)
      .all() as unknown as Array<{ feature: string; monthly_cap_cents: number }>;
    return rows.map((r) => ({ feature: r.feature, monthlyCapCents: r.monthly_cap_cents }));
  }

  /**
   * Monthly cap status for one feature: spend in the calendar month
   * containing `refTs` (default now) vs the cap. `capExceeded` is the
   * dashboard signal — true only when a cap is set AND spend exceeds it.
   */
  capStatus(feature: string, refTs: number = Date.now()): FeatureCapStatus {
    const f = requireLabel(feature, 'feature');
    const periodStart = startOfLocalMonth(refTs);
    const periodEnd = startOfNextLocalMonth(refTs);
    const capCents = this.getFeatureCap(f) ?? null;
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_cents), 0) AS spent
         FROM cost_events WHERE feature = ? AND ts >= ? AND ts < ?`,
      )
      .get(f, periodStart, periodEnd) as unknown as { spent: number };
    const spentCents = row.spent;
    return {
      feature: f,
      capCents,
      spentCents,
      capExceeded: capCents !== null && spentCents > capCents,
      periodStart,
      periodEnd,
    };
  }

  /** Cap statuses for every feature that has a cap set. */
  allCapStatuses(refTs: number = Date.now()): FeatureCapStatus[] {
    return this.listFeatureCaps().map((c) => this.capStatus(c.feature, refTs));
  }
}
