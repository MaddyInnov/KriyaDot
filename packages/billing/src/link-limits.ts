// SPDX-License-Identifier: Apache-2.0
// PUR-2 — Stripe Link limits / remaining allowances at checkout
// (Muse parity audit §4.13).
//
// The Stripe Link executor could complete an approved purchase, but
// nothing told the user (or the checkout surface) what Link would
// allow: the per-purchase limit, the daily/monthly allowances, how
// much of them is already spent, and how much headroom a given intent
// has. This module is that provider-layer read:
//
//   - Limits live in the SAME purchase_settings table as the Link
//     enabled flag / opaque reference (billing.db), under
//     stripe_link_limit_* keys. Null = no limit configured (reported
//     as null — never a fabricated figure).
//   - Spend comes from the usage ledger via the shared SpendLookup
//     (CostTracker.spentCents), counting COMPLETED purchases only in
//     the sense that the ledger only records completed purchases.
//   - computeStripeLinkLimits is pure given (limits, spentLookup, now)
//     so the checkout surface, the API, and tests all read the same
//     numbers. Nothing here executes, approves, or charges anything.

import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;
import { periodBounds } from './spend-caps.js';
import type { SpendLookup } from './spend-caps.js';
import { containsCardLike } from './purchase.js';

// ---------------------------------------------------------------------------
// Limit configuration
// ---------------------------------------------------------------------------

export interface StripeLinkLimitConfig {
  /** Max minor units for a single Link purchase; null = unconfigured. */
  perPurchaseCents: number | null;
  /** Max minor units of Link purchases per local calendar day. */
  dailyCents: number | null;
  /** Max minor units of Link purchases per local calendar month. */
  monthlyCents: number | null;
}

export const UNLIMITED_LINK_LIMITS: StripeLinkLimitConfig = {
  perPurchaseCents: null,
  dailyCents: null,
  monthlyCents: null,
};

function requireLimitCents(v: unknown, name: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${name} must be a positive integer (minor units) or null`);
  }
  return v;
}

export function normalizeLinkLimitConfig(raw: Partial<StripeLinkLimitConfig>): StripeLinkLimitConfig {
  return {
    perPurchaseCents: requireLimitCents(raw.perPurchaseCents, 'perPurchaseCents'),
    dailyCents: requireLimitCents(raw.dailyCents, 'dailyCents'),
    monthlyCents: requireLimitCents(raw.monthlyCents, 'monthlyCents'),
  };
}

const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS purchase_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const KEY_PER_PURCHASE = 'stripe_link_limit_per_purchase_cents';
const KEY_DAILY = 'stripe_link_limit_daily_cents';
const KEY_MONTHLY = 'stripe_link_limit_monthly_cents';

/**
 * SQLite-backed Stripe Link limit config (billing.db purchase_settings,
 * the same table PurchaseSettingsStore uses — keys are disjoint).
 */
export class StripeLinkLimitStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(SETTINGS_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM purchase_settings WHERE key = ?`).get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private set(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare(`DELETE FROM purchase_settings WHERE key = ?`).run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO purchase_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  getLimits(): StripeLinkLimitConfig {
    const parse = (key: string): number | null => {
      const raw = this.get(key);
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    return {
      perPurchaseCents: parse(KEY_PER_PURCHASE),
      dailyCents: parse(KEY_DAILY),
      monthlyCents: parse(KEY_MONTHLY),
    };
  }

  setLimits(cfg: StripeLinkLimitConfig): StripeLinkLimitConfig {
    const clean = normalizeLinkLimitConfig(cfg);
    this.set(KEY_PER_PURCHASE, clean.perPurchaseCents === null ? null : String(clean.perPurchaseCents));
    this.set(KEY_DAILY, clean.dailyCents === null ? null : String(clean.dailyCents));
    this.set(KEY_MONTHLY, clean.monthlyCents === null ? null : String(clean.monthlyCents));
    return this.getLimits();
  }
}

/** Env seed for limits (founder-set allowances), e.g. for deployments
 *  that configure Link limits without touching the settings UI. */
export function linkLimitsFromEnv(env: Record<string, string | undefined>): StripeLinkLimitConfig {
  const parse = (name: string): number | null => {
    const raw = (env[name] ?? '').trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (minor units)`);
    return n;
  };
  return {
    perPurchaseCents: parse('STRIPE_LINK_LIMIT_PER_PURCHASE_CENTS'),
    dailyCents: parse('STRIPE_LINK_LIMIT_DAILY_CENTS'),
    monthlyCents: parse('STRIPE_LINK_LIMIT_MONTHLY_CENTS'),
  };
}

/** Merge two configs: `over` wins wherever it sets a value. */
export function mergeLinkLimits(
  base: StripeLinkLimitConfig,
  over: Partial<StripeLinkLimitConfig>,
): StripeLinkLimitConfig {
  return {
    perPurchaseCents: over.perPurchaseCents !== undefined ? over.perPurchaseCents : base.perPurchaseCents,
    dailyCents: over.dailyCents !== undefined ? over.dailyCents : base.dailyCents,
    monthlyCents: over.monthlyCents !== undefined ? over.monthlyCents : base.monthlyCents,
  };
}

// ---------------------------------------------------------------------------
// Limits view (what the checkout surface shows)
// ---------------------------------------------------------------------------

export interface StripeLinkLimitsView {
  provider: 'stripe-link';
  /** Mirrors the Link enabled flag so the surface can hide the block. */
  enabled: boolean;
  perPurchaseLimitCents: number | null;
  dailyLimitCents: number | null;
  monthlyLimitCents: number | null;
  spentTodayCents: number;
  spentThisMonthCents: number;
  /** limit − spent for the window; null when that limit is unset. */
  remainingTodayCents: number | null;
  remainingThisMonthCents: number | null;
  /**
   * Smallest applicable headroom for a new purchase right now: the min
   * of the per-purchase limit and the remaining window allowances.
   * Null when nothing is configured.
   */
  headroomCents: number | null;
  /** The intent amount this view was computed for, when one was given. */
  intentAmountCents: number | null;
  /** True when no amount was given, or the amount fits every limit. */
  withinLimits: boolean;
  /** How far the intent amount exceeds the tightest limit (0 when within). */
  exceededByCents: number;
  /** Human line naming the tightest breached limit, or null. */
  breach: string | null;
  checkedAt: number;
}

export function computeStripeLinkLimits(opts: {
  limits: StripeLinkLimitConfig;
  enabled: boolean;
  spentLookup: SpendLookup;
  /** When set, per-bot Link spend is what counts; otherwise global. */
  botId?: string;
  amountCents?: number;
  now?: number;
}): StripeLinkLimitsView {
  const now = opts.now ?? Date.now();
  const limits = normalizeLinkLimitConfig(opts.limits);
  const day = periodBounds('day', now);
  const month = periodBounds('month', now);
  const spentTodayCents = Math.max(0, Math.floor(opts.spentLookup(day.start, day.end, opts.botId)));
  const spentThisMonthCents = Math.max(0, Math.floor(opts.spentLookup(month.start, month.end, opts.botId)));
  const remainingTodayCents = limits.dailyCents === null ? null : Math.max(0, limits.dailyCents - spentTodayCents);
  const remainingThisMonthCents =
    limits.monthlyCents === null ? null : Math.max(0, limits.monthlyCents - spentThisMonthCents);

  const candidates: Array<{ label: string; availableCents: number }> = [];
  if (limits.perPurchaseCents !== null) candidates.push({ label: 'per-purchase', availableCents: limits.perPurchaseCents });
  if (remainingTodayCents !== null) candidates.push({ label: 'daily', availableCents: remainingTodayCents });
  if (remainingThisMonthCents !== null) candidates.push({ label: 'monthly', availableCents: remainingThisMonthCents });

  const headroomCents = candidates.length ? Math.min(...candidates.map((c) => c.availableCents)) : null;
  const amount = opts.amountCents === undefined ? null : Math.max(0, Math.floor(opts.amountCents));
  let withinLimits = true;
  let exceededByCents = 0;
  let breach: string | null = null;
  if (amount !== null && candidates.length) {
    for (const c of candidates) {
      if (amount > c.availableCents) {
        withinLimits = false;
        const over = amount - c.availableCents;
        if (over >= exceededByCents) {
          exceededByCents = over;
          breach = `Exceeds the Stripe Link ${c.label} limit by ${(over / 100).toFixed(2)}`;
        }
      }
    }
  }

  return {
    provider: 'stripe-link',
    enabled: opts.enabled,
    perPurchaseLimitCents: limits.perPurchaseCents,
    dailyLimitCents: limits.dailyCents,
    monthlyLimitCents: limits.monthlyCents,
    spentTodayCents,
    spentThisMonthCents,
    remainingTodayCents,
    remainingThisMonthCents,
    headroomCents,
    intentAmountCents: amount,
    withinLimits,
    exceededByCents,
    breach,
    checkedAt: now,
  };
}

/**
 * The checkout-surface shape for one intent: the limits view plus the
 * one-line summary the UI renders verbatim. The summary contains only
 * amounts and limit figures — no references, no payment data (asserted
 * card-free before it is built).
 */
export function stripeLinkCheckoutSummary(view: StripeLinkLimitsView, currency = 'USD'): string {
  const fmt = (cents: number | null): string => (cents === null ? 'no limit set' : `${currency} ${(cents / 100).toFixed(2)}`);
  const parts = [
    `Stripe Link per-purchase limit: ${fmt(view.perPurchaseLimitCents)}`,
    `remaining today: ${fmt(view.remainingTodayCents)}`,
    `remaining this month: ${fmt(view.remainingThisMonthCents)}`,
  ];
  if (view.intentAmountCents !== null && !view.withinLimits && view.breach) parts.push(view.breach);
  const summary = parts.join(' · ');
  if (containsCardLike(summary)) throw new Error('refusing to build a checkout summary containing card-like data');
  return summary;
}
