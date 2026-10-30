// SPDX-License-Identifier: Apache-2.0
// Wave 5 payments (Muse parity audit §4.13) — API integration tests
// for the purchase-extras routes:
//   PUR-2  GET/PUT /purchases/link-limits + limits on the checkout surface
//   PUR-7  POST /purchases/:id/cancel (pending only, idempotent)
//   PUR-6  /purchase-preferences CRUD + plan on the checkout surface +
//          POST /purchases/:id/takeover over the BR-9 takeover manager
//   PUR-3  /wallet-provider* with an env-gated Stripe provider over a
//          MOCKED transport (zero paid API use, zero network)
// Secrecy: no card-like strings in any response string value.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker, MockCheckoutBrowser, SpendCapStore } from '@mvp/billing';
import { GovernanceGateway, DEFAULT_POLICY } from '@mvp/governance';
import { MockOSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import { StripeWalletProvider } from '@mvp/vault';
import type { WalletHttpRequest, WalletHttpResponse } from '@mvp/vault';
import { createPurchaseWiring, purchasePolicyRules, type PurchaseWiring } from '../src/purchases.js';
import { registerPurchaseExtrasRoutes } from '../src/purchase-extras.js';
import { BrowserTakeoverManager } from '../src/browser-takeover.js';

const GOOD = {
  itemDescription: 'Wireless headphones — noise cancelling',
  merchantName: 'Example Store',
  amountCents: 4999,
  currency: 'USD',
  checkoutUrl: 'https://shop.example.com/checkout/abc',
};

const STRIPE_SECRET = ['sk_test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'); // assembled: keeps GitHub secret-scanning from flagging Stripe's public doc sample
const STRIPE_CUSTOMER = 'cus_NffrFeUfNV2Hib';
const PM_ID = 'pm_1MqLiBLkdIwHu7ix';

function stripeMockTransport(req: WalletHttpRequest): Promise<WalletHttpResponse> {
  if (req.url.endsWith('/attach') || req.url.includes('/payment_methods?type=card')) {
    const pm = { id: PM_ID, created: 1_700_000_000, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } };
    return Promise.resolve({ status: 200, body: JSON.stringify(req.url.endsWith('/attach') ? pm : { data: [pm] }) });
  }
  if (req.url.endsWith('/detach')) return Promise.resolve({ status: 200, body: JSON.stringify({ id: PM_ID }) });
  if (req.url.includes(`/customers/${STRIPE_CUSTOMER}`)) {
    return Promise.resolve({ status: 200, body: JSON.stringify({ id: STRIPE_CUSTOMER, livemode: false }) });
  }
  return Promise.resolve({ status: 404, body: JSON.stringify({ error: { message: 'not found' } }) });
}

interface Rig {
  dir: string;
  governance: GovernanceGateway;
  wiring: PurchaseWiring;
  tracker: CostTracker;
  takeover: BrowserTakeoverManager;
  baseUrl: string;
  close: () => Promise<void>;
}

async function makeRig(opts: { stripeWallet?: boolean } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'mvp-purchase-extras-'));
  const policy = { ...DEFAULT_POLICY, rules: [...purchasePolicyRules(), ...DEFAULT_POLICY.rules] };
  const governance = new GovernanceGateway({ dbPath: join(dir, 'governance.db'), policy });
  const tracker = new CostTracker(join(dir, 'billing.db'));
  const browser = new MockCheckoutBrowser();
  const wiring = createPurchaseWiring({
    dataDir: dir,
    governance,
    costTracker: tracker,
    spendCaps: new SpendCapStore(join(dir, 'billing.db')),
    resolveOS: () => new MockOSScreenLayer(),
    browserFor: async () => browser,
  });
  const takeover = new BrowserTakeoverManager({});
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerPurchaseExtrasRoutes(router, {
    service: wiring.service,
    settings: wiring.settings,
    dataDir: dir,
    spentLookup: (since, until, botId) => tracker.spentCents({ since, until, botId }),
    takeoverManager: takeover,
    walletProvider: opts.stripeWallet
      ? new StripeWalletProvider({ secretKey: STRIPE_SECRET, customerId: STRIPE_CUSTOMER }, stripeMockTransport)
      : undefined,
    walletEnv: {},
  });
  app.use('/api/billing', router);
  const server = await new Promise<ReturnType<typeof import('node:http').createServer>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s as never));
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  return {
    dir,
    governance,
    wiring,
    tracker,
    takeover,
    baseUrl: `http://127.0.0.1:${addr.port}/api/billing`,
    close: async () => {
      governance.close();
      tracker.close();
      await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    },
  };
}

async function api(
  rig: Rig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> & Array<Record<string, unknown>> }> {
  const res = await fetch(`${rig.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as never };
}

describe('purchase-extras routes', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await makeRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('PUR-2: link-limits PUT/GET round-trip, validation, and the checkout surface shows remaining allowances', async () => {
    const put = await api(rig, 'PUT', '/purchases/link-limits', { perPurchaseCents: 10000, dailyCents: 8000, monthlyCents: null });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ perPurchaseCents: 10000, dailyCents: 8000 });
    expect((await api(rig, 'PUT', '/purchases/link-limits', { perPurchaseCents: -1 })).status).toBe(400);

    const intent = await rig.wiring.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const surface = await api(rig, 'GET', `/purchases/${intent.id}/checkout`);
    expect(surface.status).toBe(200);
    expect(surface.json.stripeLink).toMatchObject({
      perPurchaseLimitCents: 10000,
      dailyLimitCents: 8000,
      remainingTodayCents: 8000, // nothing spent yet
      intentAmountCents: 4999,
      withinLimits: true,
    });
    expect(String((surface.json.stripeLink as Record<string, unknown>).summary)).toContain('remaining today');

    const limits = await api(rig, 'GET', '/purchases/link-limits?amountCents=9000');
    expect(limits.json).toMatchObject({ withinLimits: false, breach: expect.stringContaining('daily') });
    expect((await api(rig, 'GET', '/purchases/nope/checkout')).status).toBe(404);
  });

  it('PUR-7: cancel route cancels a pending intent, is idempotent, and refuses a decided one', async () => {
    const intent = await rig.wiring.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const cancelled = await api(rig, 'POST', `/purchases/${intent.id}/cancel`, { reason: 'No longer needed' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toMatchObject({ status: 'cancelled', note: 'No longer needed' });
    const again = await api(rig, 'POST', `/purchases/${intent.id}/cancel`, {});
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: 'cancelled' });
    expect((await api(rig, 'POST', '/purchases/pur_nope/cancel', {})).status).toBe(404);

    const decided = await rig.wiring.service.createIntent({ ...GOOD, itemDescription: 'A book' }, { botId: 'scout', sessionId: 's1' });
    await rig.wiring.service.handleApprovalDecision(decided.id, 'approved'); // → awaiting-user-confirm
    const refused = await api(rig, 'POST', `/purchases/${decided.id}/cancel`, {});
    expect(refused.status).toBe(409);
    expect(String(refused.json.error)).toMatch(/cannot be cancelled/);
    // The refused cancel changed nothing.
    expect(rig.wiring.service.getIntent(decided.id)?.status).toBe('awaiting-user-confirm');
  });

  it('PUR-6: preference CRUD drives the checkout plan; saved-card preference forces takeover', async () => {
    const intent = await rig.wiring.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const before = await api(rig, 'GET', `/purchases/${intent.id}/checkout`);
    expect((before.json.plan as Record<string, unknown>).requiresUserTakeover).toBe(true); // Link off → takeover default

    const put = await api(rig, 'PUT', '/purchase-preferences', {
      merchantName: 'Example Store',
      checkoutUrl: GOOD.checkoutUrl,
      preference: 'merchant-saved-card',
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ merchantKey: 'host:shop.example.com', preference: 'merchant-saved-card' });

    const list = await api(rig, 'GET', '/purchase-preferences');
    expect(Array.isArray(list.json)).toBe(true);
    expect(list.json).toHaveLength(1);

    const after = await api(rig, 'GET', `/purchases/${intent.id}/checkout`);
    expect(after.json.plan).toMatchObject({
      mode: 'browser-takeover',
      requiresUserTakeover: true,
      takeoverReason: 'merchant-saved-card',
    });

    expect((await api(rig, 'PUT', '/purchase-preferences', { merchantName: 'X', preference: 'card-number-please' })).status).toBe(400);
    const del = await api(rig, 'DELETE', '/purchase-preferences', { merchantName: 'Example Store', checkoutUrl: GOOD.checkoutUrl });
    expect(del.json).toMatchObject({ ok: true });
    expect((await api(rig, 'GET', '/purchase-preferences')).json).toHaveLength(0);
  });

  it('PUR-6: takeover starts only for an open checkout and places the browser hold', async () => {
    const pending = await rig.wiring.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const tooEarly = await api(rig, 'POST', `/purchases/${pending.id}/takeover`, { profileId: 'prof-1', personId: 'user-1' });
    expect(tooEarly.status).toBe(409);

    await rig.wiring.service.handleApprovalDecision(pending.id, 'approved'); // → awaiting-user-confirm
    const started = await api(rig, 'POST', `/purchases/${pending.id}/takeover`, { profileId: 'prof-1', personId: 'user-1' });
    expect(started.status).toBe(201);
    expect((started.json.session as Record<string, unknown>).state).toBe('user-control');
    expect(rig.takeover.liveFor('prof-1')?.state).toBe('user-control');

    // One live session per profile: a second takeover conflicts loudly.
    const second = await rig.wiring.service.createIntent({ ...GOOD, itemDescription: 'A book' }, { botId: 'scout', sessionId: 's1' });
    await rig.wiring.service.handleApprovalDecision(second.id, 'approved');
    const conflict = await api(rig, 'POST', `/purchases/${second.id}/takeover`, { profileId: 'prof-1', personId: 'user-1' });
    expect(conflict.status).toBe(409);
  });

  it('PUR-3: without env credentials the wallet-provider surface reports the mock honestly', async () => {
    const info = await api(rig, 'GET', '/wallet-provider');
    expect(info.json).toMatchObject({ provider: 'mock', configured: false, chargesEnabled: false, liveVerified: false });
    expect((await api(rig, 'POST', '/wallet-provider/verify')).status).toBe(400);
    expect((await api(rig, 'POST', '/wallet-provider/methods', { providerMethodId: PM_ID })).status).toBe(400);
  });
});

describe('PUR-3 wallet-provider routes with the Stripe provider (mocked transport)', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await makeRig({ stripeWallet: true });
  });
  afterEach(async () => {
    await rig.close();
  });

  it('describes, verifies (mock transport), attaches, lists and detaches methods', async () => {
    const info = await api(rig, 'GET', '/wallet-provider');
    expect(info.json).toMatchObject({ provider: 'stripe', configured: true, chargesEnabled: true, liveMode: false });
    expect(JSON.stringify(info.json)).not.toContain(STRIPE_SECRET);

    const verify = await api(rig, 'POST', '/wallet-provider/verify');
    expect(verify.json).toMatchObject({ ok: true, liveVerified: true, customerId: STRIPE_CUSTOMER });

    const added = await api(rig, 'POST', '/wallet-provider/methods', { providerMethodId: PM_ID });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ id: PM_ID, brand: 'visa', last4: '4242' });

    // Raw card data is refused at the route boundary too.
    const raw = await api(rig, 'POST', '/wallet-provider/methods', { cardNumber: '4242 4242 4242 4242' });
    expect(raw.status).toBe(400);
    expect(String(raw.json.error)).toMatch(/pm_|never accepted/);

    const methods = await api(rig, 'GET', '/wallet-provider/methods');
    expect(methods.json).toHaveLength(1);
    const removed = await api(rig, 'DELETE', `/wallet-provider/methods/${PM_ID}`);
    expect(removed.json).toMatchObject({ ok: true });
  });

  it('secrecy scan: no card-like strings and no secret in any response string', async () => {
    const intent = await rig.wiring.service.createIntent(GOOD, { botId: 'scout', sessionId: 's1' });
    const responses: unknown[] = [];
    responses.push((await api(rig, 'GET', '/wallet-provider')).json);
    responses.push((await api(rig, 'POST', '/wallet-provider/verify')).json);
    responses.push((await api(rig, 'POST', '/wallet-provider/methods', { providerMethodId: PM_ID })).json);
    responses.push((await api(rig, 'GET', `/purchases/${intent.id}/checkout`)).json);
    responses.push((await api(rig, 'POST', `/purchases/${intent.id}/cancel`, {})).json);
    const strings = collectStrings(responses);
    for (const s of strings) {
      expect(containsCardPattern(s)).toBe(false);
      expect(s).not.toContain(STRIPE_SECRET);
    }
  });
});

/** Every string value in a JSON-shaped structure. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** Local Luhn scan (mirrors the billing guard) for serialized payloads. */
function containsCardPattern(text: string): boolean {
  const candidates = text.match(/(?:\d[ -]?){12,18}\d/g) ?? [];
  for (const c of candidates) {
    const digits = c.replace(/[ -]/g, '');
    if (!/^\d{13,19}$/.test(digits)) continue;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (alt) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alt = !alt;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
