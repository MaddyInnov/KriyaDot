// SPDX-License-Identifier: Apache-2.0
// Wave 5 payments (Muse parity audit §4.13):
//   PUR-2 — Stripe Link limits / remaining allowances computed from the
//           provider-layer config + the usage ledger spend lookup.
//   PUR-7 — user-facing cancel for pending intents: state-safe (only
//           pending), idempotent, audited, terminal afterwards.
//   PUR-6 — per-merchant saved-card preference store + checkout plan
//           resolution (takeover preferences never resolve to an
//           automated payment mode; no payment data can be stored).
// Zero real payments — the standard purchase harness with mock
// executors, temp dirs only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker } from '../src/cost-breakdown.js';
import {
  MerchantPreferenceStore,
  MockPurchaseExecutor,
  PurchaseIntentStore,
  PurchaseService,
  PurchaseSettingsStore,
  StripeLinkLimitStore,
  computeStripeLinkLimits,
  linkLimitsFromEnv,
  merchantKeyFor,
  mergeLinkLimits,
  planForIntent,
  resolveCheckoutPlan,
  stripeLinkCheckoutSummary,
} from '../src/index.js';
import type { PurchaseIntent, SpendCapConfig } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-purchase-extras-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = (): string => join(dir, 'billing.db');
const now = Date.now();

const GOOD = {
  itemDescription: 'Wireless headphones — noise cancelling',
  merchantName: 'Example Store',
  amountCents: 4999,
  currency: 'USD',
  checkoutUrl: 'https://shop.example.com/checkout/abc',
};

function emptyCaps(): SpendCapConfig {
  return { global: { dailyCents: null, monthlyCents: null }, bots: {} };
}

interface Harness {
  service: PurchaseService;
  store: PurchaseIntentStore;
  settings: PurchaseSettingsStore;
  tracker: CostTracker;
  browser: MockPurchaseExecutor;
  approvals: Map<string, 'pending' | 'approved' | 'denied' | 'expired'>;
  auditLog: Array<{ action: string; detail: Record<string, unknown> }>;
}

function makeHarness(): Harness {
  const store = new PurchaseIntentStore(dbPath());
  const settings = new PurchaseSettingsStore(dbPath());
  const tracker = new CostTracker(dbPath());
  const browser = new MockPurchaseExecutor('browser-checkout');
  browser.outcome = { kind: 'awaiting-user-confirm', note: 'Checkout open — finish payment yourself.' };
  const approvals = new Map<string, 'pending' | 'approved' | 'denied' | 'expired'>();
  const auditLog: Harness['auditLog'] = [];
  let seq = 0;
  const service = new PurchaseService({
    store,
    settings,
    caps: () => emptyCaps(),
    spentLookup: (since, until, botId) => tracker.spentCents({ since, until, botId }),
    recordLedger: (intent) => {
      const ev = tracker.record({
        feature: 'purchase',
        step: 'checkout',
        inputTokens: 0,
        outputTokens: 0,
        costCents: intent.totalCents,
        botId: intent.botId,
        sessionId: intent.id,
      });
      return ev.id;
    },
    raiseApproval: () => {
      const id = `appr_${++seq}`;
      approvals.set(id, 'pending');
      return id;
    },
    approvalStatus: (id) => approvals.get(id),
    browserExecutor: browser,
    audit: (action, detail) => auditLog.push({ action, detail }),
    now: () => now,
  });
  return { service, store, settings, tracker, browser, approvals, auditLog };
}

function closeHarness(h: Harness): void {
  h.store.close();
  h.settings.close();
  h.tracker.close();
}

// ---------------------------------------------------------------------------
// PUR-7 — cancel
// ---------------------------------------------------------------------------

describe('PUR-7 cancelIntent', () => {
  it('cancels a pending intent: terminal, audited once, executor never runs', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const cancelled = await h.service.cancelIntent(intent.id, 'Changed my mind');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.decidedAt).toBe(now);
    expect(cancelled.note).toBe('Changed my mind');
    expect(h.auditLog.filter((a) => a.action === 'purchase.cancelled')).toHaveLength(1);
    // Even if the governance card is approved afterwards, nothing executes.
    h.approvals.set(intent.approvalId!, 'approved');
    const after = await h.service.executeIntent(intent.id);
    expect(after.status).toBe('cancelled');
    expect(h.browser.calls).toHaveLength(0);
    expect(h.tracker.listEvents()).toHaveLength(0);
    closeHarness(h);
  });

  it('is idempotent: a second cancel returns the intent unchanged, no second audit', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const first = await h.service.cancelIntent(intent.id);
    const second = await h.service.cancelIntent(intent.id, 'a different reason');
    expect(second.status).toBe('cancelled');
    expect(second.note).toBe(first.note);
    expect(h.auditLog.filter((a) => a.action === 'purchase.cancelled')).toHaveLength(1);
    closeHarness(h);
  });

  it('refuses to cancel decided / completed / blocked intents', async () => {
    const h = makeHarness();
    const deniedIntent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    await h.service.handleApprovalDecision(deniedIntent.id, 'denied');
    await expect(h.service.cancelIntent(deniedIntent.id)).rejects.toThrow(/cannot be cancelled from status denied/);

    const completedIntent = await h.service.createIntent({ ...GOOD, itemDescription: 'A book' }, { botId: 'scout', sessionId: 's1' });
    await h.service.handleApprovalDecision(completedIntent.id, 'approved'); // → awaiting-user-confirm
    await expect(h.service.cancelIntent(completedIntent.id)).rejects.toThrow(/cannot be cancelled/);
    await h.service.confirmUserCompletion(completedIntent.id, 'completed');
    await expect(h.service.cancelIntent(completedIntent.id)).rejects.toThrow(/cannot be cancelled from status completed/);

    const blockedIntent = await h.service.createIntent(
      { ...GOOD, itemDescription: 'Transfer $50 to my own account', merchantName: 'Wise', checkoutUrl: 'https://wise.com/send' },
      { botId: 'scout', sessionId: 's1' },
    );
    expect(blockedIntent.status).toBe('blocked');
    await expect(h.service.cancelIntent(blockedIntent.id)).rejects.toThrow(/cannot be cancelled/);
    await expect(h.service.cancelIntent('pur_nope')).rejects.toThrow(/unknown purchase intent/);
    closeHarness(h);
  });

  it('sanitizes a card-carrying cancel reason before persisting it', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const cancelled = await h.service.cancelIntent(intent.id, 'do not charge 4242 4242 4242 4242');
    expect(cancelled.note).not.toContain('4242');
    expect(cancelled.note).toContain('[redacted]');
    closeHarness(h);
  });

  it('reconcilePending leaves cancelled intents alone', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    await h.service.cancelIntent(intent.id);
    h.approvals.set(intent.approvalId!, 'approved');
    await h.service.reconcilePending();
    expect(h.service.getIntent(intent.id)?.status).toBe('cancelled');
    expect(h.browser.calls).toHaveLength(0);
    closeHarness(h);
  });
});

// ---------------------------------------------------------------------------
// PUR-2 — Stripe Link limits
// ---------------------------------------------------------------------------

describe('PUR-2 Stripe Link limits', () => {
  it('store round-trips limits and clears them back to null', () => {
    const store = new StripeLinkLimitStore(dbPath());
    expect(store.getLimits()).toEqual({ perPurchaseCents: null, dailyCents: null, monthlyCents: null });
    store.setLimits({ perPurchaseCents: 20000, dailyCents: 50000, monthlyCents: null });
    expect(store.getLimits()).toEqual({ perPurchaseCents: 20000, dailyCents: 50000, monthlyCents: null });
    store.setLimits({ perPurchaseCents: null, dailyCents: null, monthlyCents: null });
    expect(store.getLimits()).toEqual({ perPurchaseCents: null, dailyCents: null, monthlyCents: null });
    expect(() => store.setLimits({ perPurchaseCents: -5, dailyCents: null, monthlyCents: null })).toThrow(/positive integer/);
    store.close();
  });

  it('limits coexist with the Stripe Link settings in the same table', () => {
    const limits = new StripeLinkLimitStore(dbPath());
    const settings = new PurchaseSettingsStore(dbPath());
    settings.setStripeLinkConfig({ enabled: true, linkRef: 'slink_x' });
    limits.setLimits({ perPurchaseCents: 1000, dailyCents: null, monthlyCents: null });
    expect(settings.getStripeLinkConfig()).toEqual({ enabled: true, linkRef: 'slink_x' });
    expect(limits.getLimits().perPurchaseCents).toBe(1000);
    limits.close();
    settings.close();
  });

  it('computes remaining allowances + headroom from ledger spend', async () => {
    const h = makeHarness();
    // One completed purchase of 4999 lands in the ledger (counts as spent).
    const first = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    await h.service.handleApprovalDecision(first.id, 'approved');
    await h.service.confirmUserCompletion(first.id, 'completed');

    const view = computeStripeLinkLimits({
      limits: { perPurchaseCents: 10000, dailyCents: 8000, monthlyCents: 20000 },
      enabled: true,
      spentLookup: (since, until, botId) => h.tracker.spentCents({ since, until, botId }),
      botId: 'scout',
      amountCents: 2500,
      now,
    });
    expect(view.spentTodayCents).toBe(4999);
    expect(view.remainingTodayCents).toBe(8000 - 4999);
    expect(view.remainingThisMonthCents).toBe(20000 - 4999);
    expect(view.headroomCents).toBe(8000 - 4999); // tightest: daily remaining
    expect(view.withinLimits).toBe(true);
    expect(view.exceededByCents).toBe(0);
    closeHarness(h);
  });

  it('flags an intent that breaches the tightest limit, with the breach line', () => {
    const view = computeStripeLinkLimits({
      limits: { perPurchaseCents: 10000, dailyCents: 8000, monthlyCents: null },
      enabled: true,
      spentLookup: () => 7000,
      amountCents: 2500,
      now,
    });
    expect(view.remainingTodayCents).toBe(1000);
    expect(view.withinLimits).toBe(false);
    expect(view.exceededByCents).toBe(1500);
    expect(view.breach).toContain('daily');
    const summary = stripeLinkCheckoutSummary(view);
    expect(summary).toContain('remaining today: USD 10.00');
    expect(summary).toContain('Exceeds the Stripe Link daily limit');
  });

  it('unset limits report nulls — never fabricated figures', () => {
    const view = computeStripeLinkLimits({
      limits: { perPurchaseCents: null, dailyCents: null, monthlyCents: null },
      enabled: false,
      spentLookup: () => 1234,
      amountCents: 999999,
      now,
    });
    expect(view.headroomCents).toBeNull();
    expect(view.remainingTodayCents).toBeNull();
    expect(view.withinLimits).toBe(true);
    expect(stripeLinkCheckoutSummary(view)).toContain('no limit set');
  });

  it('env limits parse + merge over stored limits', () => {
    const env = linkLimitsFromEnv({ STRIPE_LINK_LIMIT_DAILY_CENTS: '5000' });
    expect(env).toEqual({ perPurchaseCents: null, dailyCents: 5000, monthlyCents: null });
    expect(() => linkLimitsFromEnv({ STRIPE_LINK_LIMIT_DAILY_CENTS: 'abc' })).toThrow(/positive integer/);
    expect(
      mergeLinkLimits({ perPurchaseCents: 100, dailyCents: 200, monthlyCents: null }, { dailyCents: 999 }),
    ).toEqual({ perPurchaseCents: 100, dailyCents: 999, monthlyCents: null });
  });
});

// ---------------------------------------------------------------------------
// PUR-6 — merchant preferences + checkout plans
// ---------------------------------------------------------------------------

describe('PUR-6 merchant preferences', () => {
  it('keys merchants by checkout host, falling back to a name slug', () => {
    expect(merchantKeyFor('Example Store', 'https://www.shop.example.com/checkout')).toBe('host:shop.example.com');
    expect(merchantKeyFor('Example Store')).toBe('name:example-store');
    expect(() => merchantKeyFor('Pay 4242 4242 4242 4242')).toThrow(/payment card details/);
  });

  it('stores, reads, lists and removes preferences — enum only', () => {
    const store = new MerchantPreferenceStore(dbPath());
    const saved = store.set({ merchantName: 'Example Store', checkoutUrl: GOOD.checkoutUrl, preference: 'merchant-saved-card' });
    expect(saved.merchantKey).toBe('host:shop.example.com');
    expect(store.preferenceFor('Example Store', GOOD.checkoutUrl)).toBe('merchant-saved-card');
    expect(store.preferenceFor('Other Shop')).toBe('no-preference');
    expect(store.list()).toHaveLength(1);
    // The persisted record carries no payment-shaped fields at all.
    expect(Object.keys(store.list()[0]!).sort()).toEqual(['merchantKey', 'merchantName', 'preference', 'updatedAt']);
    expect(store.remove('Example Store', GOOD.checkoutUrl)).toBe(true);
    expect(store.remove('Example Store', GOOD.checkoutUrl)).toBe(false);
    expect(() =>
      store.set({ merchantName: 'X', preference: 'card-on-file' as never }),
    ).toThrow(/preference must be one of/);
    store.close();
  });

  it('saved-card and takeover preferences ALWAYS plan a user takeover', () => {
    for (const preference of ['merchant-saved-card', 'user-takeover'] as const) {
      const plan = resolveCheckoutPlan({
        merchantName: 'Example Store',
        checkoutUrl: GOOD.checkoutUrl,
        preference,
        stripeLinkEnabled: true, // even with Link on, takeover wins
      });
      expect(plan.mode).toBe('browser-takeover');
      expect(plan.requiresUserTakeover).toBe(true);
    }
    const savedCard = resolveCheckoutPlan({
      merchantName: 'Example Store',
      checkoutUrl: GOOD.checkoutUrl,
      preference: 'merchant-saved-card',
      stripeLinkEnabled: false,
    });
    expect(savedCard.takeoverReason).toBe('merchant-saved-card');
    expect(savedCard.note).toMatch(/saved card yourself/);
    expect(savedCard.note).toMatch(/never sees or selects it/);
  });

  it('stripe-link preference degrades to takeover when Link is off; defaults follow Link', () => {
    const off = resolveCheckoutPlan({
      merchantName: 'Example Store',
      checkoutUrl: GOOD.checkoutUrl,
      preference: 'stripe-link',
      stripeLinkEnabled: false,
    });
    expect(off).toMatchObject({ mode: 'browser-takeover', takeoverReason: 'stripe-link-unavailable' });
    const on = resolveCheckoutPlan({
      merchantName: 'Example Store',
      checkoutUrl: GOOD.checkoutUrl,
      preference: 'stripe-link',
      stripeLinkEnabled: true,
    });
    expect(on).toMatchObject({ mode: 'stripe-link', requiresUserTakeover: false });
    const dflt = resolveCheckoutPlan({
      merchantName: 'Example Store',
      checkoutUrl: GOOD.checkoutUrl,
      preference: 'no-preference',
      stripeLinkEnabled: true,
    });
    expect(dflt.mode).toBe('stripe-link');
  });

  it('planForIntent composes an intent with its stored preference', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const plan = planForIntent(intent as PurchaseIntent, 'merchant-saved-card', true);
    expect(plan.merchantKey).toBe('host:shop.example.com');
    expect(plan.requiresUserTakeover).toBe(true);
    closeHarness(h);
  });
});
