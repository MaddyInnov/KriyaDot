// SPDX-License-Identifier: Apache-2.0
// PUR-6 — Merchant-saved-card preference + explicit takeover path
// (Muse parity audit §4.13).
//
// Many merchants keep the user's card on file ("saved at merchant").
// When a checkout offers that, the right completion is NOT for the bot
// to supply a method — it is for the user to take over the browser and
// pick their merchant-saved card personally. This module makes that a
// first-class, per-merchant preference plus the plan the checkout flow
// follows:
//
//   preference 'merchant-saved-card' → plan: browser takeover; the bot
//     opens checkout, fills non-payment details, stops before pay, and
//     the user selects their merchant-saved card themselves.
//   preference 'user-takeover'       → plan: browser takeover (same
//     handoff, user's general choice for this merchant).
//   preference 'stripe-link'         → plan: Stripe Link when enabled,
//     otherwise browser takeover.
//   preference 'no-preference'       → platform default (Link when
//     enabled, otherwise browser takeover).
//
// SECRECY: a preference stores ONLY the merchant identity and the enum
// choice. There is no field that could hold a card number, a saved-card
// id, or any payment detail, and merchant text carrying card-like data
// is rejected at write time (containsCardLike). The bot never sees,
// types, or selects the saved card — the takeover IS the mechanism.

import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;
import { containsCardLike } from './purchase.js';
import type { PurchaseIntent } from './purchase.js';

export type CheckoutCompletionPreference =
  | 'no-preference'
  | 'merchant-saved-card'
  | 'user-takeover'
  | 'stripe-link';

export const CHECKOUT_COMPLETION_PREFERENCES: readonly CheckoutCompletionPreference[] = [
  'no-preference',
  'merchant-saved-card',
  'user-takeover',
  'stripe-link',
];

export function isCheckoutCompletionPreference(v: unknown): v is CheckoutCompletionPreference {
  return typeof v === 'string' && (CHECKOUT_COMPLETION_PREFERENCES as readonly string[]).includes(v);
}

export interface MerchantCheckoutPreference {
  /** Stable merchant key: checkout host when known, else a name slug. */
  merchantKey: string;
  merchantName: string;
  preference: CheckoutCompletionPreference;
  updatedAt: number;
}

/** Derive the stable per-merchant key (host wins — names vary, hosts don't). */
export function merchantKeyFor(merchantName: string, checkoutUrl?: string): string {
  if (typeof merchantName !== 'string' || !merchantName.trim()) {
    throw new Error('merchantName must be a non-empty string');
  }
  if (containsCardLike(merchantName)) {
    throw new Error('merchantName appears to contain payment card details — preferences never store payment data');
  }
  if (checkoutUrl) {
    try {
      const host = new URL(checkoutUrl).hostname.toLowerCase().replace(/^www\./, '');
      if (host) return `host:${host}`;
    } catch {
      // fall through to the name slug
    }
  }
  const slug = merchantName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) throw new Error('merchantName must contain at least one letter or digit');
  return `name:${slug}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_checkout_preferences (
  merchant_key TEXT PRIMARY KEY,
  merchant_name TEXT NOT NULL,
  preference TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface PrefRow {
  merchant_key: string;
  merchant_name: string;
  preference: string;
  updated_at: number;
}

function rowToPreference(r: PrefRow): MerchantCheckoutPreference {
  return {
    merchantKey: r.merchant_key,
    merchantName: r.merchant_name,
    preference: isCheckoutCompletionPreference(r.preference) ? r.preference : 'no-preference',
    updatedAt: r.updated_at,
  };
}

/** SQLite-backed per-merchant checkout preferences (billing.db). */
export class MerchantPreferenceStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  set(input: {
    merchantName: string;
    checkoutUrl?: string;
    preference: CheckoutCompletionPreference;
  }): MerchantCheckoutPreference {
    if (!isCheckoutCompletionPreference(input.preference)) {
      throw new Error(`preference must be one of: ${CHECKOUT_COMPLETION_PREFERENCES.join(', ')}`);
    }
    const merchantName = input.merchantName.trim().slice(0, 200);
    const key = merchantKeyFor(merchantName, input.checkoutUrl);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO merchant_checkout_preferences (merchant_key, merchant_name, preference, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(merchant_key) DO UPDATE SET merchant_name = excluded.merchant_name,
           preference = excluded.preference, updated_at = excluded.updated_at`,
      )
      .run(key, merchantName, input.preference, now);
    return { merchantKey: key, merchantName, preference: input.preference, updatedAt: now };
  }

  get(merchantName: string, checkoutUrl?: string): MerchantCheckoutPreference | undefined {
    const key = merchantKeyFor(merchantName, checkoutUrl);
    const row = this.db
      .prepare(`SELECT * FROM merchant_checkout_preferences WHERE merchant_key = ?`)
      .get(key) as unknown as PrefRow | undefined;
    return row ? rowToPreference(row) : undefined;
  }

  /** The effective preference for a merchant ('no-preference' when unset). */
  preferenceFor(merchantName: string, checkoutUrl?: string): CheckoutCompletionPreference {
    return this.get(merchantName, checkoutUrl)?.preference ?? 'no-preference';
  }

  list(): MerchantCheckoutPreference[] {
    const rows = this.db
      .prepare(`SELECT * FROM merchant_checkout_preferences ORDER BY merchant_name ASC`)
      .all() as unknown as PrefRow[];
    return rows.map(rowToPreference);
  }

  remove(merchantName: string, checkoutUrl?: string): boolean {
    const key = merchantKeyFor(merchantName, checkoutUrl);
    const info = this.db.prepare(`DELETE FROM merchant_checkout_preferences WHERE merchant_key = ?`).run(key);
    return Number(info.changes) > 0;
  }
}

// ---------------------------------------------------------------------------
// Checkout plan — how an intent for this merchant completes
// ---------------------------------------------------------------------------

export type CheckoutPlanMode = 'stripe-link' | 'browser-takeover';

export interface CheckoutPlan {
  merchantKey: string;
  preference: CheckoutCompletionPreference;
  mode: CheckoutPlanMode;
  /** True when a person must take over the browser to finish payment. */
  requiresUserTakeover: boolean;
  /** Why takeover is required (set iff requiresUserTakeover). */
  takeoverReason: 'merchant-saved-card' | 'user-takeover' | 'stripe-link-unavailable' | null;
  /** User-facing instruction for the completion step. */
  note: string;
}

/**
 * Resolve the completion plan for an intent from the merchant's stored
 * preference + whether Stripe Link is enabled. Pure and total: every
 * preference maps to exactly one plan, and the two takeover preferences
 * NEVER resolve to an automated payment mode.
 */
export function resolveCheckoutPlan(input: {
  merchantName: string;
  checkoutUrl: string;
  preference: CheckoutCompletionPreference;
  stripeLinkEnabled: boolean;
}): CheckoutPlan {
  const merchantKey = merchantKeyFor(input.merchantName, input.checkoutUrl);
  const base = { merchantKey, preference: input.preference };
  switch (input.preference) {
    case 'merchant-saved-card':
      return {
        ...base,
        mode: 'browser-takeover',
        requiresUserTakeover: true,
        takeoverReason: 'merchant-saved-card',
        note: `You prefer to pay ${input.merchantName} with the card saved at the merchant. The bot opens checkout and stops before the pay step — take over the browser and select your saved card yourself. The bot never sees or selects it.`,
      };
    case 'user-takeover':
      return {
        ...base,
        mode: 'browser-takeover',
        requiresUserTakeover: true,
        takeoverReason: 'user-takeover',
        note: `You prefer to complete ${input.merchantName} checkouts yourself. The bot opens checkout and stops before the pay step — take over the browser to finish payment personally.`,
      };
    case 'stripe-link':
      return input.stripeLinkEnabled
        ? {
            ...base,
            mode: 'stripe-link',
            requiresUserTakeover: false,
            takeoverReason: null,
            note: 'This purchase can complete via Stripe Link after approval.',
          }
        : {
            ...base,
            mode: 'browser-takeover',
            requiresUserTakeover: true,
            takeoverReason: 'stripe-link-unavailable',
            note: 'Stripe Link is your preference for this merchant but is not enabled, so the bot opens checkout and stops before the pay step for you to finish personally.',
          };
    case 'no-preference':
    default:
      return input.stripeLinkEnabled
        ? {
            ...base,
            mode: 'stripe-link',
            requiresUserTakeover: false,
            takeoverReason: null,
            note: 'No saved preference for this merchant — Stripe Link can complete this purchase after approval.',
          }
        : {
            ...base,
            mode: 'browser-takeover',
            requiresUserTakeover: true,
            takeoverReason: 'user-takeover',
            note: 'No saved preference for this merchant and Stripe Link is off — the bot opens checkout and stops before the pay step for you to finish personally.',
          };
  }
}

/** Plan for a persisted intent + the merchant's stored preference. */
export function planForIntent(
  intent: Pick<PurchaseIntent, 'merchantName' | 'checkoutUrl'>,
  preference: CheckoutCompletionPreference,
  stripeLinkEnabled: boolean,
): CheckoutPlan {
  return resolveCheckoutPlan({
    merchantName: intent.merchantName,
    checkoutUrl: intent.checkoutUrl,
    preference,
    stripeLinkEnabled,
  });
}
