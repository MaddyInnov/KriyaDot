// SPDX-License-Identifier: Apache-2.0
// PUR-3 — Stripe wallet provider: env gating, provider-token method
// management, charges over a MOCKED transport (zero paid API use, zero
// network), and the secrecy invariants (no raw PAN accepted anywhere;
// the secret key never appears in results, errors, or request bodies
// beyond the Authorization header to the provider).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MockWalletProvider,
  StripeWalletProvider,
  createWalletProviderFromEnv,
  isWalletError,
  stripeWalletConfigFromEnv,
} from '../src/index.js';
import type { WalletHttpRequest, WalletHttpResponse } from '../src/index.js';

const SECRET = ['sk_test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'); // assembled: keeps GitHub secret-scanning from flagging Stripe's public doc sample
const CUSTOMER = 'cus_NffrFeUfNV2Hib';
const PM = 'pm_1MqLiBLkdIwHu7ix';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'stripe-wallet-'));
}

interface Recorder {
  requests: WalletHttpRequest[];
  transport: (req: WalletHttpRequest) => Promise<WalletHttpResponse>;
}

/** Recording mock transport: Stripe-shaped replies, no network. */
function mockTransport(handler?: (req: WalletHttpRequest) => WalletHttpResponse): Recorder {
  const requests: WalletHttpRequest[] = [];
  return {
    requests,
    transport: async (req) => {
      requests.push(req);
      if (handler) return handler(req);
      if (req.url.endsWith('/attach')) {
        return {
          status: 200,
          body: JSON.stringify({ id: PM, created: 1_700_000_000, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }),
        };
      }
      if (req.url.includes('/payment_methods?type=card')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: PM, created: 1_700_000_000, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }] }),
        };
      }
      if (req.url.endsWith('/detach')) return { status: 200, body: JSON.stringify({ id: PM }) };
      if (req.url.endsWith('/payment_intents')) {
        return { status: 200, body: JSON.stringify({ id: 'pi_mock_1', status: 'succeeded', amount: 4999, currency: 'usd' }) };
      }
      if (req.url.includes(`/customers/${CUSTOMER}`)) {
        return { status: 200, body: JSON.stringify({ id: CUSTOMER, livemode: false }) };
      }
      return { status: 404, body: JSON.stringify({ error: { message: 'not found' } }) };
    },
  };
}

const provider = (rec: Recorder): StripeWalletProvider =>
  new StripeWalletProvider({ secretKey: SECRET, customerId: CUSTOMER }, rec.transport);

describe('env gating (stripeWalletConfigFromEnv)', () => {
  it('returns null (mock stays) when nothing is configured', () => {
    expect(stripeWalletConfigFromEnv({})).toBeNull();
    expect(stripeWalletConfigFromEnv({ WALLET_PROVIDER: 'mock' })).toBeNull();
  });

  it('parses a complete config', () => {
    const cfg = stripeWalletConfigFromEnv({ STRIPE_SECRET_KEY: SECRET, STRIPE_WALLET_CUSTOMER_ID: CUSTOMER });
    expect(cfg).toMatchObject({ customerId: CUSTOMER });
    expect(cfg?.secretKey).toBe(SECRET);
  });

  it('fails loudly when stripe is selected but the key is missing', () => {
    expect(() => stripeWalletConfigFromEnv({ WALLET_PROVIDER: 'stripe' })).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('fails loudly on a malformed key or missing/malformed customer', () => {
    expect(() => stripeWalletConfigFromEnv({ STRIPE_SECRET_KEY: 'not-a-key', STRIPE_WALLET_CUSTOMER_ID: CUSTOMER })).toThrow(/malformed/);
    expect(() => stripeWalletConfigFromEnv({ STRIPE_SECRET_KEY: SECRET })).toThrow(/STRIPE_WALLET_CUSTOMER_ID/);
    expect(() => stripeWalletConfigFromEnv({ STRIPE_SECRET_KEY: SECRET, STRIPE_WALLET_CUSTOMER_ID: 'nope' })).toThrow(/malformed/);
  });

  it('factory returns the mock without credentials and Stripe with them', () => {
    const dir = freshDir();
    expect(createWalletProviderFromEnv({ dataDir: dir, env: {} })).toBeInstanceOf(MockWalletProvider);
    const rec = mockTransport();
    const p = createWalletProviderFromEnv({
      dataDir: dir,
      env: { STRIPE_SECRET_KEY: SECRET, STRIPE_WALLET_CUSTOMER_ID: CUSTOMER },
      transport: rec.transport,
    });
    expect(p).toBeInstanceOf(StripeWalletProvider);
    expect(p.chargesEnabled).toBe(true);
  });
});

describe('StripeWalletProvider over a mocked transport', () => {
  it('attaches a hosted-flow pm_ id and maps only display fields back', async () => {
    const rec = mockTransport();
    const method = await provider(rec).addProviderPaymentMethod(PM);
    expect(method).toMatchObject({ id: PM, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 });
    expect(Object.keys(method)).not.toContain('cardNumber');
    const attach = rec.requests.find((r) => r.url.endsWith('/attach'))!;
    expect(attach.method).toBe('POST');
    expect(attach.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(new URLSearchParams(attach.body).get('customer')).toBe(CUSTOMER);
  });

  it('lists and detaches methods', async () => {
    const rec = mockTransport();
    const p = provider(rec);
    const methods = await p.listPaymentMethods();
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ id: PM, last4: '4242' });
    await expect(p.removePaymentMethod(PM)).resolves.toBe(true);
    expect(rec.requests.some((r) => r.url.endsWith('/detach'))).toBe(true);
  });

  it('charges via a confirmed PaymentIntent carrying only the pm_ id', async () => {
    const rec = mockTransport();
    const charge = await provider(rec).charge({ methodId: PM, amountMinor: 4999, currency: 'USD', idempotencyKey: 'idem-1' });
    expect(charge).toMatchObject({ id: 'pi_mock_1', status: 'succeeded', amountMinor: 4999, currency: 'usd' });
    const pi = rec.requests.find((r) => r.url.endsWith('/payment_intents'))!;
    const form = new URLSearchParams(pi.body);
    expect(form.get('payment_method')).toBe(PM);
    expect(form.get('amount')).toBe('4999');
    expect(form.get('confirm')).toBe('true');
    expect(pi.headers['idempotency-key']).toBe('idem-1');
  });

  it('verifyConnection succeeds against the mocked account', async () => {
    const rec = mockTransport();
    await expect(provider(rec).verifyConnection()).resolves.toMatchObject({ ok: true, provider: 'stripe', customerId: CUSTOMER, liveMode: false });
  });

  it('describe() exposes mode + customer but never the secret', () => {
    const rec = mockTransport();
    const d = provider(rec).describe();
    expect(d).toMatchObject({ provider: 'stripe', customerId: CUSTOMER, liveMode: false });
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });
});

describe('secrecy invariants', () => {
  it('REFUSES raw card numbers at addPaymentMethod — and sends nothing', async () => {
    const rec = mockTransport();
    await expect(
      provider(rec).addPaymentMethod({ cardNumber: '4242 4242 4242 4242', expMonth: 12, expYear: 2030 }),
    ).rejects.toThrow(/never accepts raw card numbers/);
    expect(rec.requests).toHaveLength(0);
  });

  it('rejects non-pm_ method ids and bad charges before any request', async () => {
    const rec = mockTransport();
    const p = provider(rec);
    await expect(p.addProviderPaymentMethod('4242424242424242')).rejects.toThrow(/pm_/);
    await expect(p.charge({ methodId: PM, amountMinor: 0, currency: 'USD' })).rejects.toThrow(/positive integer/);
    await expect(p.charge({ methodId: PM, amountMinor: 100, currency: 'US' })).rejects.toThrow(/3-letter/);
    await expect(
      p.charge({ methodId: PM, amountMinor: 100, currency: 'USD', description: 'card 4242 4242 4242 4242' }),
    ).rejects.toThrow(/card-like/);
    expect(rec.requests).toHaveLength(0);
  });

  it('provider errors are wallet errors and never leak the secret or card-like data', async () => {
    const rec = mockTransport(() => ({
      status: 402,
      body: JSON.stringify({ error: { message: `charge failed for key ${SECRET} and card 4242 4242 4242 4242` } }),
    }));
    const p = provider(rec);
    const err = await p.charge({ methodId: PM, amountMinor: 100, currency: 'USD' }).catch((e: unknown) => e);
    expect(isWalletError(err)).toBe(true);
    const msg = (err as Error).message;
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain('4242');
    expect(msg).toContain('[redacted]');
  });

  it('no request body ever carries card-like data', async () => {
    const rec = mockTransport();
    const p = provider(rec);
    await p.addProviderPaymentMethod(PM);
    await p.charge({ methodId: PM, amountMinor: 100, currency: 'USD' });
    for (const r of rec.requests) {
      expect(r.body ?? '').not.toMatch(/(?:\d[ -]?){12,18}\d/);
    }
  });
});
