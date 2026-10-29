// SPDX-License-Identifier: Apache-2.0
// W6 approval-gated purchasing — API integration tests:
//   - governance policy: request_purchase is require-approval (simulate)
//   - adapter observer links the gateway card to a persisted intent
//     (exactly one card per purchase; pending intents visible pre-decision)
//   - approve → executes via MOCK browser/Stripe Link; deny → terminal
//   - hard blocks hold even with an approved card; bypass (handler runs
//     while the card is still pending) executes NOTHING
//   - HTTP routes: list / create / decide / confirm-completion / settings
//   - always-allow persistence refuses request_purchase
//   - secrecy: no card-like strings and no Stripe Link reference in tool
//     results, approval args, intents, or audit entries
// Zero real payments — MockCheckoutBrowser + mock OS layer only.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { CostTracker, MockCheckoutBrowser, SpendCapStore } from '@mvp/billing';
import { MockOSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import type { BotConfig, ToolContext } from '@mvp/agent-runtime';
import { GovernanceAdapter } from '../src/governance-adapter.js';
import {
  OsCheckoutBrowser,
  createPurchaseWiring,
  createRequestPurchaseTool,
  purchasePolicyRules,
  registerPurchaseRoutes,
  type PurchaseWiring,
} from '../src/purchases.js';
import { rememberAllowedTool } from '../src/bot-policies.js';
import { SecureVault } from '@mvp/vault';

const GOOD_ARGS = {
  itemDescription: 'Wireless headphones — noise cancelling',
  merchantName: 'Example Store',
  amountCents: 4999,
  currency: 'USD',
  checkoutUrl: 'https://shop.example.com/checkout/abc',
};
const CTX: ToolContext = { sessionId: 's1', botId: 'scout' };

interface Rig {
  dir: string;
  governance: GovernanceGateway;
  adapter: GovernanceAdapter;
  wiring: PurchaseWiring;
  browser: MockCheckoutBrowser;
  tracker: CostTracker;
}

function makeRig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'mvp-purchases-'));
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
  const adapter = new GovernanceAdapter(governance, {
    globalPolicy: policy,
    approvalObserver: wiring.onApprovalMinted,
  });
  return { dir, governance, adapter, wiring, browser, tracker };
}

async function waitForIntent(rig: Rig): Promise<void> {
  await vi.waitFor(
    () => {
      expect(rig.wiring.service.listIntents()).toHaveLength(1);
    },
    { timeout: 3000, interval: 10 },
  );
}

describe('purchase policy', () => {
  it('request_purchase simulates as require-approval via its own rule', async () => {
    const rig = makeRig();
    const sim = await rig.governance.simulate('request_purchase', GOOD_ARGS);
    expect(sim.effect).toBe('require-approval');
    expect(sim.matchedRuleId).toBe('request-purchase-approval');
    expect(sim.wouldCreateApproval).toBe(true);
    rig.governance.close();
  });

  it('"always allow" persistence refuses request_purchase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-purchases-allow-'));
    const bots = [{ id: 'scout', name: 'Scout' } as BotConfig];
    expect(() => rememberAllowedTool(dir, bots, 'scout', 'request_purchase')).toThrow(/always-allow/);
    // A benign tool can still be remembered (the block is purchase-specific).
    expect(() => rememberAllowedTool(dir, bots, 'scout', 'web_search')).not.toThrow();
  });
});

describe('gateway card ↔ intent linkage (adapter observer)', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });
  afterEach(() => {
    rig.governance.close();
    rig.tracker.close();
  });

  it('evaluation mints ONE approval and a pending intent linked to it; nothing executes', async () => {
    const res = await rig.adapter.evaluate({ id: 'c1', name: 'request_purchase', args: GOOD_ARGS }, CTX);
    expect(res.decision).toBe('require-approval');
    expect(res.approvalId).toBeTruthy();
    await waitForIntent(rig);
    const intent = rig.wiring.service.listIntents()[0]!;
    expect(intent.status).toBe('pending-approval');
    const realApproval = rig.governance.listApprovals('pending')[0]!;
    expect(intent.approvalId).toBe(realApproval.id);
    expect(realApproval.toolName).toBe('request_purchase');
    // The card snapshots the tool args: item, merchant, amount, currency
    // and link are all on it (total == amount for single-item intents;
    // the purchases UI renders the formatted total).
    expect(realApproval.args).toMatchObject({
      itemDescription: GOOD_ARGS.itemDescription,
      merchantName: GOOD_ARGS.merchantName,
      amountCents: 4999,
      currency: 'USD',
      checkoutUrl: GOOD_ARGS.checkoutUrl,
    });
    expect(rig.browser.calls).toHaveLength(0);
    expect(rig.tracker.listEvents()).toHaveLength(0);
  });

  it('approve (inbox path) → browser checkout → awaiting-user-confirm → user confirms → completed + ledger', async () => {
    await rig.adapter.evaluate({ id: 'c1', name: 'request_purchase', args: GOOD_ARGS }, CTX);
    await waitForIntent(rig);
    const intent = rig.wiring.service.listIntents()[0]!;
    rig.governance.decide(intent.approvalId!, 'approved');
    const settled = await rig.wiring.service.handleApprovalDecisionByApprovalId(intent.approvalId!, 'approved');
    expect(settled?.status).toBe('awaiting-user-confirm');
    expect(rig.browser.calls.map((c) => c.method)).toEqual(['goto', 'fillNonPaymentDetails']);
    expect(rig.browser.payClickCount).toBe(0);
    const done = await rig.wiring.service.confirmUserCompletion(intent.id, 'completed');
    expect(done.status).toBe('completed');
    expect(done.ledgerRef).toBeTruthy();
    const events = rig.tracker.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature: 'purchase', sessionId: intent.id, costCents: 4999 });
  });

  it('tool handler claims the approved intent and executes exactly once', async () => {
    await rig.adapter.evaluate({ id: 'c1', name: 'request_purchase', args: GOOD_ARGS }, CTX);
    await waitForIntent(rig);
    const intent = rig.wiring.service.listIntents()[0]!;
    rig.governance.decide(intent.approvalId!, 'approved');
    const tool = createRequestPurchaseTool(rig.wiring.service);
    const result = (await tool.handler({ ...GOOD_ARGS }, CTX)) as Record<string, unknown>;
    expect(result).toMatchObject({ intentId: intent.id, status: 'awaiting-user-confirm' });
    expect(rig.browser.calls.filter((c) => c.method === 'goto')).toHaveLength(1);
    // A duplicate handler call does not re-execute.
    const again = (await tool.handler({ ...GOOD_ARGS }, CTX)) as Record<string, unknown>;
    expect(again.status).toBe('awaiting-user-confirm');
    expect(rig.browser.calls.filter((c) => c.method === 'goto')).toHaveLength(1);
  });

  it('bypass safety: handler running while the card is still pending executes NOTHING', async () => {
    await rig.adapter.evaluate({ id: 'c1', name: 'request_purchase', args: GOOD_ARGS }, CTX);
    await waitForIntent(rig);
    const tool = createRequestPurchaseTool(rig.wiring.service);
    const result = (await tool.handler({ ...GOOD_ARGS }, CTX)) as Record<string, unknown>;
    expect(result.status).toBe('pending-approval');
    expect(rig.browser.calls).toHaveLength(0);
    expect(rig.tracker.listEvents()).toHaveLength(0);
  });

  it('deny → intent terminal denied; handler afterwards executes nothing', async () => {
    await rig.adapter.evaluate({ id: 'c1', name: 'request_purchase', args: GOOD_ARGS }, CTX);
    await waitForIntent(rig);
    const intent = rig.wiring.service.listIntents()[0]!;
    rig.governance.decide(intent.approvalId!, 'denied');
    const settled = await rig.wiring.service.handleApprovalDecisionByApprovalId(intent.approvalId!, 'denied');
    expect(settled?.status).toBe('denied');
    const tool = createRequestPurchaseTool(rig.wiring.service);
    const result = (await tool.handler({ ...GOOD_ARGS }, CTX)) as Record<string, unknown>;
    expect(result.status).toBe('denied');
    expect(rig.browser.calls).toHaveLength(0);
  });

  it('hard block: crypto intent with an APPROVED card still never executes', async () => {
    const args = {
      itemDescription: 'Buy 0.05 Bitcoin',
      merchantName: 'Coinbase',
      amountCents: 10000,
      currency: 'USD',
      checkoutUrl: 'https://www.coinbase.com/checkout',
    };
    await rig.adapter.evaluate({ id: 'c1', name: 'request_purchase', args }, CTX);
    await waitForIntent(rig);
    const intent = rig.wiring.service.listIntents()[0]!;
    expect(intent.status).toBe('blocked');
    expect(intent.blockReason).toMatch(/securities|crypto/i);
    rig.governance.decide(intent.approvalId!, 'approved');
    const settled = await rig.wiring.service.handleApprovalDecisionByApprovalId(intent.approvalId!, 'approved');
    expect(settled?.status).toBe('blocked');
    expect(rig.browser.calls).toHaveLength(0);
    expect(rig.tracker.listEvents()).toHaveLength(0);
  });

  it('direct tool invocation (no gateway) creates a pending intent + its own card and stops', async () => {
    const tool = createRequestPurchaseTool(rig.wiring.service);
    const result = (await tool.handler({ ...GOOD_ARGS }, CTX)) as Record<string, unknown>;
    expect(result.status).toBe('pending-approval');
    const intent = rig.wiring.service.listIntents()[0]!;
    expect(intent.approvalId).toBeTruthy();
    expect(rig.governance.getApproval(intent.approvalId!)?.toolName).toBe('request_purchase');
    expect(rig.browser.calls).toHaveLength(0);
  });
});

describe('OsCheckoutBrowser invariants', () => {
  it('never confirms payment and cannot drive Stripe Link on the OS layer', async () => {
    const os = new MockOSScreenLayer();
    const browser = new OsCheckoutBrowser(os);
    await expect(browser.clickFinalPayButton()).rejects.toThrow(/never confirms/);
    await expect(browser.completeWithStripeLink('slink_x')).rejects.toThrow(/not available/);
    await browser.goto('https://shop.example.com/checkout');
    expect(os.callsOf('type').some((c) => c.text === 'https://shop.example.com/checkout')).toBe(true);
    // The link reference is never typed into the page.
    expect(JSON.stringify(os.calls)).not.toContain('slink_x');
  });
});

describe('purchase HTTP routes', () => {
  let rig: Rig;
  let baseUrl: string;
  let server: ReturnType<typeof import('node:http').createServer> | null = null;

  beforeEach(async () => {
    rig = makeRig();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerPurchaseRoutes(router, {
      service: rig.wiring.service,
      settings: rig.wiring.settings,
      decideApproval: (id, d) => rig.governance.decide(id, d),
    });
    app.use('/api/billing', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as never;
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/billing`;
  });

  afterEach(async () => {
    rig.governance.close();
    rig.tracker.close();
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> & Array<Record<string, unknown>> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as never };
  }

  it('create → list → decide(approved) → awaiting → confirm-completion → completed', async () => {
    const created = await api('POST', '/purchases', { botId: 'scout', ...GOOD_ARGS });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'pending-approval', merchantName: 'Example Store', totalCents: 4999 });
    const id = created.json.id as string;

    const list = await api('GET', '/purchases');
    expect(Array.isArray(list.json)).toBe(true);
    expect(list.json).toHaveLength(1);

    const decided = await api('POST', `/purchases/${id}/decide`, { decision: 'approved' });
    expect(decided.json).toMatchObject({ status: 'awaiting-user-confirm' });
    expect(rig.browser.payClickCount).toBe(0);
    // The governance card was decided too (single source of truth).
    const intent = rig.wiring.service.getIntent(id)!;
    expect(rig.governance.getApproval(intent.approvalId!)?.status).toBe('approved');

    const confirmed = await api('POST', `/purchases/${id}/confirm-completion`, { outcome: 'completed' });
    expect(confirmed.json).toMatchObject({ status: 'completed' });
    expect(confirmed.json.ledgerRef).toBeTruthy();
    expect(rig.tracker.listEvents()).toHaveLength(1);
  });

  it('decide(denied) is terminal and validates input', async () => {
    const created = await api('POST', '/purchases', { botId: 'scout', ...GOOD_ARGS });
    const id = created.json.id as string;
    expect((await api('POST', `/purchases/${id}/decide`, { decision: 'maybe' })).status).toBe(400);
    const denied = await api('POST', `/purchases/${id}/decide`, { decision: 'denied' });
    expect(denied.json).toMatchObject({ status: 'denied' });
    expect(rig.browser.calls).toHaveLength(0);
    expect((await api('GET', '/purchases/nope')).status).toBe(404);
  });

  it('blocked purchases are created as blocked over HTTP too', async () => {
    const created = await api('POST', '/purchases', {
      botId: 'scout',
      itemDescription: 'Transfer $50 to my own account',
      merchantName: 'Wise',
      amountCents: 5000,
      currency: 'USD',
      checkoutUrl: 'https://wise.com/send',
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'blocked' });
    expect(String(created.json.blockReason)).toMatch(/own accounts/);
  });

  it('Stripe Link settings: enable → vault-held opaque ref → Stripe path completes over HTTP', async () => {
    const before = await api('GET', '/purchases/settings');
    expect(before.json).toMatchObject({ stripeLinkEnabled: false, stripeLinkConfigured: false });

    const put = await api('PUT', '/purchases/settings', { stripeLinkEnabled: true });
    expect(put.json.stripeLinkEnabled).toBe(true);
    expect(put.json.stripeLinkConfigured).toBe(true);
    const ref = put.json.stripeLinkRef as string;
    expect(ref).toMatch(/^slink_/);
    // The reference is vault-held (server-side only).
    const vault = new SecureVault(rig.dir, 'default-user', 'test-read');
    expect(vault.get('stripe-link-ref')?.value).toBe(ref);

    const created = await api('POST', '/purchases', { botId: 'scout', ...GOOD_ARGS });
    const id = created.json.id as string;
    expect(created.json.executionMethod).toBe('stripe-link');
    const decided = await api('POST', `/purchases/${id}/decide`, { decision: 'approved' });
    expect(decided.json).toMatchObject({ status: 'completed', executionMethod: 'stripe-link' });
    expect(decided.json.providerRef).toBeTruthy();
    expect(rig.browser.linkRefsSeen).toEqual([ref]);
    expect(rig.browser.payClickCount).toBe(0);
    expect(rig.tracker.listEvents()).toHaveLength(1);
    // The link reference never leaks into the intent view or tool-facing data.
    expect(JSON.stringify(decided.json)).not.toContain(ref);
  });

  it('secrecy scan: no card-like strings anywhere in responses, approvals, or audit', async () => {
    await api('PUT', '/purchases/settings', { stripeLinkEnabled: true });
    const created = await api('POST', '/purchases', { botId: 'scout', ...GOOD_ARGS });
    const id = created.json.id as string;
    await api('POST', `/purchases/${id}/decide`, { decision: 'approved' });
    const blob = JSON.stringify({
      created: created.json,
      approvals: rig.governance.listApprovals(),
      audit: rig.governance.listAudit(100),
      intents: rig.wiring.service.listIntents(),
      browserCalls: rig.browser.calls,
    });
    expect(blob).not.toMatch(/4242|5555|3782/);
    // Luhn scan over STRING values only (epoch timestamps are numbers and
    // would false-positive a raw digit scan — they are not card data).
    const strings = collectStrings({
      created: created.json,
      approvals: rig.governance.listApprovals(),
      audit: rig.governance.listAudit(100),
      intents: rig.wiring.service.listIntents(),
      browserCalls: rig.browser.calls,
    });
    for (const s of strings) {
      expect(containsCardPattern(s)).toBe(false);
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
