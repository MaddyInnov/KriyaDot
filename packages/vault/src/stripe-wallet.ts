// SPDX-License-Identifier: Apache-2.0
// PUR-3 — Real wallet provider behind the wallet abstraction
// (Muse parity audit §4.13).
//
// Until now the wallet was mock-only: MockWalletProvider stores
// last4/brand/expiry locally and refuses every charge. This module is
// the REAL provider adapter: it talks to Stripe's API over an injected
// HTTP transport and satisfies the same wallet contract (methods list /
// add / remove, plus a charge), with these hard rules:
//
//   - ENV-GATED. The provider exists only when the founder supplies
//     credentials in the environment (STRIPE_SECRET_KEY +
//     STRIPE_WALLET_CUSTOMER_ID, or WALLET_PROVIDER=stripe to force the
//     selection and fail loudly when they are missing). Without them,
//     createWalletProviderFromEnv returns the mock — behaviour is
//     unchanged for everyone who has not opted in.
//   - NO RAW CARD DATA, EVER. A network provider must never receive a
//     PAN from this process (PCI scope + the platform secrecy rules).
//     addPaymentMethod (the raw-card entry point of the sync wallet
//     interface) therefore REFUSES on this provider. Methods are added
//     with addProviderPaymentMethod: the caller passes an opaque Stripe
//     payment-method id (`pm_…`) minted by Stripe's own hosted/Link/JS
//     flow in the user's browser, and this adapter only attaches,
//     lists, detaches and charges that id. Card brand/last4/expiry in
//     results come from Stripe's response — they are never stored
//     locally; Stripe is the source of truth.
//   - THE SECRET NEVER LEAVES THE PROCESS except as the Authorization
//     header to api.stripe.com. It is never logged, returned, or put in
//     an error message (provider errors are sanitized + truncated).
//   - This is the USER WALLET for purchases. Platform subscription
//     billing (packages/billing's BillingProvider) stays mock
//     end-to-end by design and is untouched by this module.
//
// A network provider is inherently async, so it implements
// NetworkWalletProvider (the WalletProvider contract with Promise
// returns). The `*WalletMethod(s)` normalizers below give callers one
// awaitable surface over both the sync mock and this async provider.
//
// LIVE VERIFICATION STATUS: the live step (a real charge / attach
// against a founder Stripe account) is UNVERIFIED — no founder
// credentials were available when this was built. Everything here is
// verified against a mocked transport in tests, and verifyConnection()
// is the one-call live check to run once credentials exist.

import { MockWalletProvider } from './wallet.js';
import type { PaymentMethod, PaymentMethodInput, WalletProvider } from './wallet.js';

const WALLET_ERROR = '__wallet_error__';

function stripeWalletError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = WALLET_ERROR;
  return err;
}

// ---------------------------------------------------------------------------
// Transport (injected — tests substitute a recording mock; zero paid use)
// ---------------------------------------------------------------------------

export interface WalletHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** application/x-www-form-urlencoded body for POSTs. */
  body?: string;
}

export interface WalletHttpResponse {
  status: number;
  body: string;
}

export type WalletHttpTransport = (req: WalletHttpRequest) => Promise<WalletHttpResponse>;

/** Default transport over global fetch (Node 18+). Used only live. */
export const fetchWalletTransport: WalletHttpTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  return { status: res.status, body: await res.text() };
};

// ---------------------------------------------------------------------------
// Config / env gating
// ---------------------------------------------------------------------------

export interface StripeWalletConfig {
  /** Stripe secret key (sk_test_… / sk_live_…). Server-side only. */
  secretKey: string;
  /** Stripe customer id (cus_…) the wallet methods belong to. */
  customerId: string;
  /** API base; overridable for tests / Stripe-compatible gateways. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.stripe.com/v1';

function looksLikeSecretKey(v: string): boolean {
  return /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(v);
}

/**
 * Read the Stripe wallet config from an env map.
 *  - Returns null when Stripe is not selected and no key is present
 *    (the wallet stays mock).
 *  - Throws a wallet error when Stripe IS selected
 *    (WALLET_PROVIDER=stripe, or a key is present) but the config is
 *    incomplete or malformed — a half-configured real-money provider
 *    must fail loudly, never silently fall back to the mock.
 */
export function stripeWalletConfigFromEnv(
  env: Record<string, string | undefined>,
): StripeWalletConfig | null {
  const selected = (env.WALLET_PROVIDER ?? '').trim().toLowerCase() === 'stripe';
  const secretKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  const customerId = (env.STRIPE_WALLET_CUSTOMER_ID ?? '').trim();
  if (!selected && !secretKey) return null;
  if (!secretKey) {
    throw stripeWalletError(
      'WALLET_PROVIDER=stripe but STRIPE_SECRET_KEY is not set — refusing to start a real wallet provider without its credential.',
    );
  }
  if (!looksLikeSecretKey(secretKey)) {
    throw stripeWalletError(
      'STRIPE_SECRET_KEY is malformed (expected an sk_test_/sk_live_ key) — refusing to use it.',
    );
  }
  if (!customerId) {
    throw stripeWalletError(
      'Stripe wallet provider needs STRIPE_WALLET_CUSTOMER_ID (the cus_… id the saved methods belong to).',
    );
  }
  if (!/^cus_[A-Za-z0-9]{6,}$/.test(customerId)) {
    throw stripeWalletError('STRIPE_WALLET_CUSTOMER_ID is malformed (expected a cus_… id).');
  }
  const baseUrl = (env.STRIPE_API_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  return { secretKey, customerId, baseUrl };
}

// ---------------------------------------------------------------------------
// Async wallet contract + charge result
// ---------------------------------------------------------------------------

export interface WalletChargeInput {
  methodId: string;
  /** Integer minor units of `currency`. */
  amountMinor: number;
  currency: string;
  idempotencyKey?: string;
  /** Short, card-data-free description (digit sequences are rejected). */
  description?: string;
}

export interface WalletChargeResult {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
}

/** The WalletProvider contract, Promise-based, for network providers. */
export interface NetworkWalletProvider {
  readonly id: string;
  readonly chargesEnabled: boolean;
  addPaymentMethod(input: PaymentMethodInput): Promise<PaymentMethod>;
  listPaymentMethods(): Promise<PaymentMethod[]>;
  removePaymentMethod(id: string): Promise<boolean>;
  charge(input: WalletChargeInput): Promise<WalletChargeResult>;
}

export type AnyWalletProvider = WalletProvider | NetworkWalletProvider;

/** Awaitable normalizers: one surface over the sync mock + async real. */
export async function listWalletMethods(p: AnyWalletProvider): Promise<PaymentMethod[]> {
  return p.listPaymentMethods();
}
export async function removeWalletMethod(p: AnyWalletProvider, id: string): Promise<boolean> {
  return p.removePaymentMethod(id);
}

// ---------------------------------------------------------------------------
// Stripe provider
// ---------------------------------------------------------------------------

interface StripeCardShape {
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
}

interface StripePaymentMethodShape {
  id?: string;
  created?: number;
  card?: StripeCardShape;
}

function toPaymentMethod(pm: StripePaymentMethodShape): PaymentMethod {
  return {
    id: String(pm.id ?? ''),
    brand: String(pm.card?.brand ?? 'unknown'),
    // Provider-returned display fields only — never a full number.
    last4: String(pm.card?.last4 ?? '????').slice(-4),
    expMonth: Number(pm.card?.exp_month ?? 0),
    expYear: Number(pm.card?.exp_year ?? 0),
    createdAt: typeof pm.created === 'number' ? pm.created * 1000 : Date.now(),
  };
}

function requireProviderMethodId(id: unknown): string {
  if (typeof id !== 'string' || !/^pm_[A-Za-z0-9]{6,}$/.test(id)) {
    throw stripeWalletError('payment method id must be an opaque Stripe pm_… id from the hosted/Link flow');
  }
  return id;
}

export class StripeWalletProvider implements NetworkWalletProvider {
  readonly id = 'stripe';
  readonly chargesEnabled = true;

  private readonly baseUrl: string;

  constructor(
    private readonly config: StripeWalletConfig,
    private readonly transport: WalletHttpTransport = fetchWalletTransport,
  ) {
    if (!looksLikeSecretKey(config.secretKey)) throw stripeWalletError('Stripe secret key is malformed');
    if (!/^cus_[A-Za-z0-9]{6,}$/.test(config.customerId)) throw stripeWalletError('Stripe customer id is malformed');
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /** Display-safe summary: provider + customer id + mode, never the key. */
  describe(): { provider: string; customerId: string; liveMode: boolean; chargesEnabled: boolean } {
    return {
      provider: this.id,
      customerId: this.config.customerId,
      liveMode: this.config.secretKey.includes('_live_'),
      chargesEnabled: this.chargesEnabled,
    };
  }

  private sanitize(text: string): string {
    // Strip anything resembling the credential or a card number from a
    // provider error before it can reach a caller, log, or audit entry.
    return text
      .split(this.config.secretKey).join('[redacted]')
      .replace(/(?:\d[ -]?){12,18}\d/g, '[redacted]')
      .slice(0, 300);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    let res: WalletHttpResponse;
    try {
      res = await this.transport({
        method,
        url: `${this.baseUrl}${path}`,
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
      });
    } catch (err) {
      throw stripeWalletError(
        `Stripe wallet request failed before a response: ${this.sanitize(err instanceof Error ? err.message : String(err))}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw stripeWalletError(`Stripe wallet request returned a non-JSON response (HTTP ${res.status})`);
    }
    if (res.status < 200 || res.status >= 300) {
      const msg =
        (parsed as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      throw stripeWalletError(`Stripe wallet request failed: ${this.sanitize(String(msg))}`);
    }
    return parsed as T;
  }

  /**
   * The sync interface's raw-card entry point. REFUSED here by design:
   * this process never takes a PAN for a network provider. Use
   * addProviderPaymentMethod with the pm_… id from Stripe's hosted flow.
   */
  async addPaymentMethod(_input: PaymentMethodInput): Promise<PaymentMethod> {
    throw stripeWalletError(
      'The Stripe wallet provider never accepts raw card numbers. Collect the method in Stripe Link / Stripe.js (hosted) and pass its pm_… id to addProviderPaymentMethod.',
    );
  }

  /** Attach a hosted-flow payment method (pm_…) to the wallet customer. */
  async addProviderPaymentMethod(providerMethodId: string): Promise<PaymentMethod> {
    const id = requireProviderMethodId(providerMethodId);
    const pm = await this.call<StripePaymentMethodShape>(
      'POST',
      `/payment_methods/${encodeURIComponent(id)}/attach`,
      { customer: this.config.customerId },
    );
    return toPaymentMethod(pm);
  }

  async listPaymentMethods(): Promise<PaymentMethod[]> {
    const page = await this.call<{ data?: StripePaymentMethodShape[] }>(
      'GET',
      `/customers/${encodeURIComponent(this.config.customerId)}/payment_methods?type=card&limit=100`,
    );
    return (page.data ?? []).map(toPaymentMethod);
  }

  async removePaymentMethod(id: string): Promise<boolean> {
    const mid = requireProviderMethodId(id);
    await this.call<StripePaymentMethodShape>(
      'POST',
      `/payment_methods/${encodeURIComponent(mid)}/detach`,
      {},
    );
    return true;
  }

  /**
   * Charge a saved method via a confirmed PaymentIntent. Amount is
   * integer minor units; the method id is the only payment reference
   * that ever crosses the wire from this process.
   */
  async charge(input: WalletChargeInput): Promise<WalletChargeResult> {
    const methodId = requireProviderMethodId(input.methodId);
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw stripeWalletError('charge amountMinor must be a positive integer (minor units)');
    }
    const currency = String(input.currency ?? '').trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) throw stripeWalletError('charge currency must be a 3-letter ISO code');
    if (input.description !== undefined && /(?:\d[ -]?){12,18}\d/.test(input.description)) {
      throw stripeWalletError('charge description must not contain card-like data');
    }
    const pi = await this.call<{ id?: string; status?: string; amount?: number; currency?: string }>(
      'POST',
      '/payment_intents',
      {
        amount: String(input.amountMinor),
        currency,
        customer: this.config.customerId,
        payment_method: methodId,
        confirm: 'true',
        ...(input.description ? { description: input.description.slice(0, 200) } : {}),
      },
      input.idempotencyKey,
    );
    return {
      id: String(pi.id ?? ''),
      status: String(pi.status ?? 'unknown'),
      amountMinor: Number(pi.amount ?? input.amountMinor),
      currency: String(pi.currency ?? currency),
    };
  }

  /**
   * One-call live check (mock-verified in tests; run once with founder
   * credentials to verify the live step): the configured customer must
   * be retrievable with the configured key.
   */
  async verifyConnection(): Promise<{ ok: true; provider: string; customerId: string; liveMode: boolean }> {
    const customer = await this.call<{ id?: string; livemode?: boolean }>(
      'GET',
      `/customers/${encodeURIComponent(this.config.customerId)}`,
    );
    if (customer.id !== this.config.customerId) {
      throw stripeWalletError('Stripe wallet verification failed: customer lookup returned a different id');
    }
    return {
      ok: true,
      provider: this.id,
      customerId: this.config.customerId,
      liveMode: customer.livemode === true,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Pick the wallet provider from the environment: the real Stripe
 * provider when founder credentials are configured, otherwise the
 * mock. Platform billing is deliberately NOT involved in this choice.
 */
export function createWalletProviderFromEnv(opts: {
  dataDir: string;
  namespace?: string;
  env?: Record<string, string | undefined>;
  transport?: WalletHttpTransport;
}): AnyWalletProvider {
  const config = stripeWalletConfigFromEnv(opts.env ?? process.env);
  if (!config) return new MockWalletProvider(opts.dataDir, opts.namespace ?? 'default');
  return new StripeWalletProvider(config, opts.transport ?? fetchWalletTransport);
}

/** True when `p` is the real (network, charge-capable) provider. */
export function isNetworkWalletProvider(p: AnyWalletProvider): p is NetworkWalletProvider {
  return typeof (p as NetworkWalletProvider).charge === 'function' && p.id !== 'mock';
}
