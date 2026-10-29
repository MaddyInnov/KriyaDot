// SPDX-License-Identifier: Apache-2.0
// W6 approval-gated purchasing: intent lifecycle, hard blocks (securities +
// self-transfer + spend caps), ledger recording, executor contracts
// (Stripe Link mock + browser-checkout never pays), and the
// no-sensitive-data invariant. Zero real payments — every executor and
// browser layer here is a mock.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker } from '../src/cost-breakdown.js';
import {
  BrowserCheckoutExecutor,
  MockCheckoutBrowser,
  MockPurchaseExecutor,
  PurchaseIntentStore,
  PurchaseService,
  PurchaseSettingsStore,
  StripeLinkExecutor,
  checkPurchaseSpendCap,
  classifyPurchaseBlock,
  containsCardLike,
  normalizePurchaseInput,
  purchaseApprovalArgs,
  purchaseFingerprint,
} from '../src/purchase.js';
import type { PurchaseIntent, SpendCapConfig } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-purchase-'));
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
  stripe: MockPurchaseExecutor;
  browser: MockPurchaseExecutor;
  approvals: Map<string, 'pending' | 'approved' | 'denied' | 'expired'>;
  auditLog: Array<{ action: string; detail: Record<string, unknown> }>;
  ledgerEvents: PurchaseIntent[];
}

function makeHarness(opts: { caps?: SpendCapConfig } = {}): Harness {
  const store = new PurchaseIntentStore(dbPath());
  const settings = new PurchaseSettingsStore(dbPath());
  const tracker = new CostTracker(dbPath());
  const stripe = new MockPurchaseExecutor('stripe-link');
  const browser = new MockPurchaseExecutor('browser-checkout');
  browser.outcome = { kind: 'awaiting-user-confirm', note: 'Checkout open — finish payment yourself.' };
  const approvals = new Map<string, 'pending' | 'approved' | 'denied' | 'expired'>();
  const auditLog: Harness['auditLog'] = [];
  const ledgerEvents: PurchaseIntent[] = [];
  let approvalSeq = 0;
  const service = new PurchaseService({
    store,
    settings,
    caps: () => opts.caps ?? emptyCaps(),
    spentLookup: (since, until, botId) => tracker.spentCents({ since, until, botId }),
    recordLedger: (intent) => {
      ledgerEvents.push(intent);
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
    raiseApproval: (intent) => {
      const id = `appr_${++approvalSeq}`;
      approvals.set(id, 'pending');
      return id;
    },
    approvalStatus: (id) => approvals.get(id),
    stripeExecutor: stripe,
    browserExecutor: browser,
    audit: (action, detail) => auditLog.push({ action, detail }),
    now: () => now,
  });
  return { service, store, settings, tracker, stripe, browser, approvals, auditLog, ledgerEvents };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyPurchaseBlock — securities', () => {
  const blocked: Array<[string, typeof GOOD]> = [
    ['broker domain (coinbase)', { ...GOOD, merchantName: 'Coinbase', checkoutUrl: 'https://www.coinbase.com/checkout' }],
    ['broker domain (zerodha subdomain)', { ...GOOD, checkoutUrl: 'https://kite.zerodha.com/orders' }],
    ['buy stocks phrasing', { ...GOOD, itemDescription: 'Buy 10 shares of ACME stock' }],
    ['crypto purchase', { ...GOOD, itemDescription: 'Purchase 0.05 Bitcoin' }],
    ['ETF investment', { ...GOOD, itemDescription: 'Invest in an S&P 500 ETF' }],
    ['trading platform phrase', { ...GOOD, itemDescription: 'One year of trading platform premium' }],
    ['brokerage merchant', { ...GOOD, merchantName: 'Acme Brokerage LLC' }],
  ];
  for (const [name, input] of blocked) {
    it(`blocks: ${name}`, () => {
      const b = classifyPurchaseBlock(input);
      expect(b?.category).toBe('securities');
      expect(b?.reason).toMatch(/securities|crypto|broker/i);
    });
  }

  it('allows ordinary retail purchases', () => {
    expect(classifyPurchaseBlock(GOOD)).toBeNull();
    expect(
      classifyPurchaseBlock({ ...GOOD, itemDescription: 'A paperback novel about a stockbroker detective' }),
    ).toBeNull();
    expect(classifyPurchaseBlock({ ...GOOD, itemDescription: 'LEGO trading-card binder (toy)' })).toBeNull();
  });
});

describe('classifyPurchaseBlock — self-transfers', () => {
  const blocked: Array<[string, typeof GOOD]> = [
    ['transfer to my own account', { ...GOOD, itemDescription: 'Transfer $200 to my own account' }],
    ['move money between accounts', { ...GOOD, itemDescription: 'Move money between my accounts' }],
    ['bank transfer to own', { ...GOOD, itemDescription: 'Bank transfer to my own savings' }],
    ['self-transfer keyword', { ...GOOD, itemDescription: 'Self-transfer of rent money' }],
    [
      'Wise self-transfer',
      { ...GOOD, merchantName: 'Wise', itemDescription: 'Send money to my own bank account abroad', checkoutUrl: 'https://wise.com/send' },
    ],
    [
      'PayPal to myself',
      { ...GOOD, merchantName: 'PayPal', itemDescription: 'Transfer balance to myself', checkoutUrl: 'https://www.paypal.com/transfer' },
    ],
  ];
  for (const [name, input] of blocked) {
    it(`blocks: ${name}`, () => {
      expect(classifyPurchaseBlock(input)?.category).toBe('self-transfer');
    });
  }

  it('allows paying a merchant via PayPal checkout for goods', () => {
    expect(
      classifyPurchaseBlock({
        ...GOOD,
        merchantName: 'Example Store (PayPal checkout)',
        itemDescription: 'Wireless headphones',
        checkoutUrl: 'https://shop.example.com/checkout',
      }),
    ).toBeNull();
  });
});

describe('checkPurchaseSpendCap', () => {
  it('blocks when the purchase would exceed the bot cap', () => {
    const caps = emptyCaps();
    caps.bots['scout'] = { dailyCents: 1000, monthlyCents: null };
    const block = checkPurchaseSpendCap({ caps, botId: 'scout', amountCents: 1500, spentLookup: () => 0, now });
    expect(block?.category).toBe('spend-cap');
    expect(block?.reason).toContain('Spend cap reached');
  });
  it('allows under the cap and for other bots', () => {
    const caps = emptyCaps();
    caps.bots['scout'] = { dailyCents: 1000, monthlyCents: null };
    expect(checkPurchaseSpendCap({ caps, botId: 'scout', amountCents: 999, spentLookup: () => 0, now })).toBeNull();
    expect(checkPurchaseSpendCap({ caps, botId: 'coder', amountCents: 5000, spentLookup: () => 0, now })).toBeNull();
  });
});

describe('sensitive-data guards', () => {
  it('detects Luhn-valid card numbers (spaced/dashed/plain) only', () => {
    expect(containsCardLike('card 4242 4242 4242 4242')).toBe(true);
    expect(containsCardLike('4242-4242-4242-4242')).toBe(true);
    expect(containsCardLike('order 1234 5678 9012 3456 total')).toBe(false); // fails Luhn
    expect(containsCardLike('Wireless headphones')).toBe(false);
  });
  it('intent creation rejects inputs carrying card details and persists nothing', async () => {
    const h = makeHarness();
    await expect(
      h.service.createIntent(
        { ...GOOD, itemDescription: 'Pay with card 4242 4242 4242 4242 please' },
        { botId: 'scout', sessionId: 's1' },
      ),
    ).rejects.toThrow(/payment card details/);
    expect(h.store.list()).toHaveLength(0);
    h.store.close(); h.settings.close(); h.tracker.close();
  });
  it('validates amounts, currency and URL', () => {
    expect(() => normalizePurchaseInput({ ...GOOD, amountCents: 0 })).toThrow();
    expect(() => normalizePurchaseInput({ ...GOOD, amountCents: 10.5 })).toThrow();
    expect(() => normalizePurchaseInput({ ...GOOD, currency: 'US' })).toThrow();
    expect(() => normalizePurchaseInput({ ...GOOD, checkoutUrl: 'ftp://x.example/f' })).toThrow();
    expect(() => normalizePurchaseInput({ ...GOOD, checkoutUrl: 'not a url' })).toThrow();
    expect(normalizePurchaseInput({ ...GOOD, currency: 'eur' }).currency).toBe('EUR');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('PurchaseService lifecycle', () => {
  it('create → pending-approval (nothing executed) → approve → executes via mock → completed + ledger entry', async () => {
    const h = makeHarness();
    h.settings.setStripeLinkConfig({ enabled: true, linkRef: 'slink_test_ref' });
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    expect(intent.status).toBe('pending-approval');
    expect(intent.approvalId).toBeTruthy();
    expect(intent.executionMethod).toBe('stripe-link');
    expect(h.stripe.calls).toHaveLength(0); // creating never executes
    expect(h.ledgerEvents).toHaveLength(0);

    const done = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(done.status).toBe('completed');
    expect(done.ledgerRef).toBeTruthy();
    expect(done.providerRef).toBe('mock_provider_ref');
    expect(done.decidedAt).toBe(now);
    expect(done.completedAt).toBe(now);
    expect(h.stripe.calls).toEqual([{ intentId: intent.id, approvalId: intent.approvalId }]);
    // Ledger: exactly one purchase event with the intent id as session.
    const events = h.tracker.listEvents({ botId: 'scout' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature: 'purchase', step: 'checkout', sessionId: intent.id, costCents: 4999 });
    expect(done.ledgerRef).toBe(events[0]!.id);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('browser-checkout path → awaiting-user-confirm → user confirms → completed + ledger', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    expect(intent.executionMethod).toBe('browser-checkout');
    const waiting = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(waiting.status).toBe('awaiting-user-confirm');
    expect(waiting.note).toContain('finish payment yourself');
    expect(h.ledgerEvents).toHaveLength(0); // no ledger until the user confirms
    const done = await h.service.confirmUserCompletion(intent.id, 'completed');
    expect(done.status).toBe('completed');
    expect(done.ledgerRef).toBeTruthy();
    expect(h.tracker.listEvents()).toHaveLength(1);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('deny → terminal, executor never runs, no ledger entry', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const denied = await h.service.handleApprovalDecision(intent.id, 'denied');
    expect(denied.status).toBe('denied');
    expect(h.stripe.calls).toHaveLength(0);
    expect(h.browser.calls).toHaveLength(0);
    expect(h.ledgerEvents).toHaveLength(0);
    // Terminal: a later approve attempt changes nothing.
    const again = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(again.status).toBe('denied');
    expect(h.browser.calls).toHaveLength(0);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('executor failure → failed with sanitized reason, no ledger entry', async () => {
    const h = makeHarness();
    h.browser.outcome = { kind: 'failed', reason: 'merchant site unreachable' };
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const failed = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('unreachable');
    expect(h.ledgerEvents).toHaveLength(0);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('spend-cap block at creation: persisted blocked, no approval raised, no execution', async () => {
    const caps = emptyCaps();
    caps.global.dailyCents = 1000;
    const h = makeHarness({ caps });
    const intent = await h.service.createIntent({ ...GOOD, amountCents: 5000 }, { botId: 'scout', sessionId: 's1' });
    expect(intent.status).toBe('blocked');
    expect(intent.blockReason).toContain('Spend cap reached');
    expect(intent.approvalId).toBeNull();
    expect(h.approvals.size).toBe(0);
    expect(h.auditLog.some((a) => a.action === 'purchase.blocked')).toBe(true);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('completed purchases count toward the cap for the next purchase', async () => {
    const caps = emptyCaps();
    caps.global.dailyCents = 6000;
    const h = makeHarness({ caps });
    const first = await h.service.createIntent({ ...GOOD, amountCents: 4999 }, { botId: 'scout', sessionId: 's1' });
    await h.service.handleApprovalDecision(first.id, 'approved'); // browser path
    await h.service.confirmUserCompletion(first.id, 'completed');
    const second = await h.service.createIntent({ ...GOOD, amountCents: 2000 }, { botId: 'scout', sessionId: 's1' });
    expect(second.status).toBe('blocked'); // 4999 + 2000 > 6000
    expect(second.blockReason).toContain('Spend cap');
    h.store.close(); h.settings.close(); h.tracker.close();
  });
});

describe('hard blocks hold even when approval is forced', () => {
  it('securities intent created via noteToolApprovalMinted is blocked; forced execute stays blocked', async () => {
    const h = makeHarness();
    const intent = await h.service.noteToolApprovalMinted({
      botId: 'scout',
      sessionId: 's1',
      approvalId: 'appr_forced',
      input: { ...GOOD, itemDescription: 'Buy 5 shares of ACME stock', merchantName: 'Coinbase', checkoutUrl: 'https://www.coinbase.com/x' },
    });
    expect(intent.status).toBe('blocked');
    h.approvals.set('appr_forced', 'approved'); // even with an approved card…
    const after = await h.service.executeIntent(intent.id);
    expect(after.status).toBe('blocked');
    expect(h.stripe.calls).toHaveLength(0);
    expect(h.browser.calls).toHaveLength(0);
    expect(h.ledgerEvents).toHaveLength(0);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('self-transfer intent is blocked at creation and raises no spend', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(
      { ...GOOD, itemDescription: 'Transfer $50 to my own account', merchantName: 'Wise', checkoutUrl: 'https://wise.com/send' },
      { botId: 'scout', sessionId: 's1' },
    );
    expect(intent.status).toBe('blocked');
    expect(intent.blockReason).toMatch(/own accounts/);
    const after = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(after.status).toBe('blocked');
    expect(h.browser.calls).toHaveLength(0);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('cap re-check at execution: cap tightened after approval blocks execution', async () => {
    const caps = emptyCaps();
    const h = makeHarness({ caps });
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    caps.global.dailyCents = 100; // user tightens the cap while the card is pending
    const after = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(after.status).toBe('blocked');
    expect(after.blockReason).toContain('Spend cap reached');
    expect(h.browser.calls).toHaveLength(0);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('executeIntent from pending-approval does nothing until the approval is really approved', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const early = await h.service.executeIntent(intent.id); // approval still pending
    expect(early.status).toBe('pending-approval');
    expect(h.browser.calls).toHaveLength(0);
    h.approvals.set(intent.approvalId!, 'approved');
    const done = await h.service.executeIntent(intent.id);
    expect(done.status).toBe('awaiting-user-confirm'); // browser path
    expect(h.browser.calls).toHaveLength(1);
    h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('reconcileIntent syncs denied approvals to terminal denied', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    h.approvals.set(intent.approvalId!, 'denied');
    const synced = await h.service.reconcileIntent(intent.id);
    expect(synced.status).toBe('denied');
    h.store.close(); h.settings.close(); h.tracker.close();
  });
});

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

describe('StripeLinkExecutor', () => {
  it('completes via the mock browser using ONLY the opaque link ref', async () => {
    const store = new PurchaseIntentStore(dbPath());
    const settings = new PurchaseSettingsStore(dbPath());
    settings.setStripeLinkConfig({ enabled: true, linkRef: 'slink_opaque_123' });
    const browser = new MockCheckoutBrowser();
    const executor = new StripeLinkExecutor({ store, settings, browserFor: async () => browser });
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const outcome = await executor.execute({ intentId: intent.id, approvalId: intent.approvalId ?? '' });
    expect(outcome.kind).toBe('completed');
    expect(browser.calls.map((c) => c.method)).toEqual(['goto', 'completeWithStripeLink']);
    expect(browser.linkRefsSeen).toEqual(['slink_opaque_123']);
    expect(browser.payClickCount).toBe(0);
    // The serialized browser interaction carries no card-like data.
    expect(JSON.stringify(browser.calls)).not.toMatch(/4242|card/i);
    store.close(); settings.close(); h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('fails cleanly when Stripe Link is not enabled', async () => {
    const store = new PurchaseIntentStore(dbPath());
    const settings = new PurchaseSettingsStore(dbPath());
    const executor = new StripeLinkExecutor({ store, settings, browserFor: async () => new MockCheckoutBrowser() });
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const outcome = await executor.execute({ intentId: intent.id, approvalId: 'x' });
    expect(outcome).toMatchObject({ kind: 'failed' });
    store.close(); settings.close(); h.store.close(); h.settings.close(); h.tracker.close();
  });

  it('service falls back to browser-checkout when the Stripe path fails', async () => {
    const h = makeHarness();
    h.settings.setStripeLinkConfig({ enabled: true, linkRef: 'slink_x' });
    h.stripe.outcome = { kind: 'failed', reason: 'link session expired' };
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const after = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(after.status).toBe('awaiting-user-confirm');
    expect(after.executionMethod).toBe('browser-checkout');
    expect(h.stripe.calls).toHaveLength(1);
    expect(h.browser.calls).toHaveLength(1);
    h.store.close(); h.settings.close(); h.tracker.close();
  });
});

describe('BrowserCheckoutExecutor', () => {
  it('navigates + fills non-payment details and NEVER invokes the final pay action', async () => {
    const store = new PurchaseIntentStore(dbPath());
    const browser = new MockCheckoutBrowser();
    const executor = new BrowserCheckoutExecutor({ store, browserFor: async () => browser });
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const outcome = await executor.execute({ intentId: intent.id, approvalId: intent.approvalId ?? '' });
    expect(outcome.kind).toBe('awaiting-user-confirm');
    expect(browser.calls.map((c) => c.method)).toEqual(['goto', 'fillNonPaymentDetails']);
    expect(browser.payClickCount).toBe(0);
    expect(browser.calls.some((c) => c.method === 'clickFinalPayButton')).toBe(false);
    store.close(); h.store.close(); h.settings.close(); h.tracker.close();
  });
});

// ---------------------------------------------------------------------------
// Store + views + secrecy
// ---------------------------------------------------------------------------

describe('PurchaseIntentStore', () => {
  it('persists across reopen and enforces the state machine', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    h.store.close();
    const reopened = new PurchaseIntentStore(dbPath());
    expect(reopened.get(intent.id)?.status).toBe('pending-approval');
    expect(() => reopened.transition(intent.id, 'completed')).toThrow(/illegal purchase transition/);
    reopened.close();
    h.settings.close(); h.tracker.close();
  });

  it('looks up by approval id and fingerprint', async () => {
    const h = makeHarness();
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    expect(h.store.getByApprovalId(intent.approvalId!)?.id).toBe(intent.id);
    const fp = purchaseFingerprint('scout', 's1', { ...GOOD, executionMethod: 'browser-checkout' });
    expect(fp).toBe(intent.fingerprint);
    expect(h.store.getByFingerprint(fp)?.id).toBe(intent.id);
    h.store.close(); h.settings.close(); h.tracker.close();
  });
});

describe('no-sensitive-data invariant', () => {
  it('serialized intents, approval args and audit payloads contain no card-like strings', async () => {
    const h = makeHarness();
    h.browser.outcome = { kind: 'failed', reason: 'gateway echoed 4242 4242 4242 4242 back' };
    const intent = await h.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const failed = await h.service.handleApprovalDecision(intent.id, 'approved');
    expect(failed.failureReason).not.toContain('4242');
    expect(failed.failureReason).toContain('[redacted]');
    const blob = JSON.stringify({
      intent: failed,
      args: purchaseApprovalArgs(failed),
      audit: h.auditLog,
    });
    expect(blob).not.toContain('4242424242424242');
    expect(blob).not.toContain('4242 4242');
    // Approval args carry exactly the decision-relevant fields.
    const args = purchaseApprovalArgs(failed);
    expect(args).toMatchObject({
      item: GOOD.itemDescription,
      merchant: GOOD.merchantName,
      amountCents: 4999,
      currency: 'USD',
      totalCents: 4999,
      total: 'USD 49.99',
      checkoutUrl: GOOD.checkoutUrl,
    });
    h.store.close(); h.settings.close(); h.tracker.close();
  });
});
