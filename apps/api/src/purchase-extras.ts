// SPDX-License-Identifier: Apache-2.0
// Wave 5 — Payments extras (Muse parity audit §4.13): the
// register-style HTTP surface for PUR-2 / PUR-3 / PUR-6 / PUR-7.
//
// Mount on the SAME billing router as registerPurchaseRoutes
// (routes.ts, next to the existing purchase routes — see the wave-5
// WIRING note). Paths (router mounted at /api/billing):
//
//   GET    /purchases/:id/checkout        PUR-2 + PUR-6 checkout surface:
//                                         intent + Stripe Link limits /
//                                         remaining allowances + the
//                                         merchant's completion plan.
//   GET    /purchases/link-limits         PUR-2 limit config (read)
//   PUT    /purchases/link-limits         PUR-2 limit config (write)
//   POST   /purchases/:id/cancel          PUR-7 user-facing cancel for a
//                                         pending intent (idempotent).
//   GET    /purchase-preferences          PUR-6 per-merchant preferences
//   PUT    /purchase-preferences          PUR-6 set one merchant's
//                                         preference (enum only — a
//                                         preference can never carry
//                                         payment data)
//   DELETE /purchase-preferences          PUR-6 clear one merchant's
//   POST   /purchases/:id/takeover        PUR-6 explicit takeover: places
//                                         the browser hold via the BR-9
//                                         takeover manager so the user
//                                         completes payment personally
//                                         (e.g. with a merchant-saved
//                                         card the bot must never see).
//   GET    /wallet-provider               PUR-3 which wallet provider is
//                                         live (env-gated), display-safe
//   POST   /wallet-provider/verify        PUR-3 one-call connection check
//   GET    /wallet-provider/methods       PUR-3 provider methods list
//   POST   /wallet-provider/methods       PUR-3 attach a pm_… method id
//                                         minted by the hosted flow
//   DELETE /wallet-provider/methods/:id   PUR-3 detach a method
//
// Safety contract (inherited, never weakened): purchases stay
// approval-gated (no route here approves or executes anything); cancel
// only touches pending intents; no card numbers or card-like data are
// accepted, stored, logged, or returned by any route here.

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { join } from 'node:path';
import {
  MerchantPreferenceStore,
  PurchaseService,
  StripeLinkLimitStore,
  computeStripeLinkLimits,
  isCheckoutCompletionPreference,
  merchantKeyFor,
  planForIntent,
  purchaseIntentView,
  stripeLinkCheckoutSummary,
} from '@mvp/billing';
import type {
  CheckoutPlan,
  MerchantCheckoutPreference,
  PurchaseIntent,
  PurchaseSettingsProvider,
  SpendLookup,
  StripeLinkLimitConfig,
  StripeLinkLimitsView,
} from '@mvp/billing';
import {
  createWalletProviderFromEnv,
  isNetworkWalletProvider,
  isWalletError,
  listWalletMethods,
  removeWalletMethod,
} from '@mvp/vault';
import type { AnyWalletProvider, WalletHttpTransport } from '@mvp/vault';
import type { BrowserTakeoverManager, TakeoverSession } from './browser-takeover.js';

export interface PurchaseExtrasDeps {
  service: PurchaseService;
  settings: PurchaseSettingsProvider;
  /** Host data dir — billing.db under it holds limits + preferences. */
  dataDir: string;
  /** Ledger-backed spend lookup (CostTracker.spentCents adapter). */
  spentLookup: SpendLookup;
  /** BR-9 takeover manager (browser-suite). Without it, the takeover
   *  route answers 501 — the plan/preference surface still works. */
  takeoverManager?: BrowserTakeoverManager;
  /** Store overrides (tests). Default: opened on <dataDir>/billing.db. */
  limitStore?: StripeLinkLimitStore;
  preferenceStore?: MerchantPreferenceStore;
  /** Wallet provider override (tests) / env + transport for PUR-3. */
  walletProvider?: AnyWalletProvider;
  walletEnv?: Record<string, string | undefined>;
  walletTransport?: WalletHttpTransport;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  now?: () => number;
}

export interface CheckoutSurface {
  intent: PurchaseIntent;
  stripeLink: StripeLinkLimitsView & { summary: string };
  preference: MerchantCheckoutPreference | null;
  plan: CheckoutPlan;
}

/** Assemble the checkout surface for one intent (pure read — no writes). */
export function assembleCheckoutSurface(
  intent: PurchaseIntent,
  deps: {
    stripeLinkEnabled: boolean;
    limits: StripeLinkLimitConfig;
    spentLookup: SpendLookup;
    preference: MerchantCheckoutPreference | undefined;
    now?: number;
  },
): CheckoutSurface {
  const view = computeStripeLinkLimits({
    limits: deps.limits,
    enabled: deps.stripeLinkEnabled,
    spentLookup: deps.spentLookup,
    botId: intent.botId,
    amountCents: intent.totalCents,
    now: deps.now,
  });
  const preference = deps.preference?.preference ?? 'no-preference';
  return {
    intent: purchaseIntentView(intent),
    stripeLink: { ...view, summary: stripeLinkCheckoutSummary(view, intent.currency) },
    preference: deps.preference ?? null,
    plan: planForIntent(intent, preference, deps.stripeLinkEnabled),
  };
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function registerPurchaseExtrasRoutes(router: Router, deps: PurchaseExtrasDeps): void {
  const dbPath = join(deps.dataDir, 'billing.db');
  const limitStore = deps.limitStore ?? new StripeLinkLimitStore(dbPath);
  const preferenceStore = deps.preferenceStore ?? new MerchantPreferenceStore(dbPath);
  const now = deps.now ?? (() => Date.now());

  const walletProvider = (): AnyWalletProvider =>
    deps.walletProvider ??
    createWalletProviderFromEnv({
      dataDir: deps.dataDir,
      env: deps.walletEnv ?? process.env,
      transport: deps.walletTransport,
    });

  const audit = (action: string, detail: Record<string, unknown>): void => {
    try {
      deps.audit?.(action, { detail });
    } catch {
      // Audit must never break the payments surface.
    }
  };

  // -- PUR-2: Stripe Link limits --------------------------------------

  router.get('/purchases/link-limits', (req: Request, res: Response) => {
    try {
      const cfg = deps.settings.getStripeLinkConfig();
      const amountRaw = typeof req.query.amountCents === 'string' ? Number(req.query.amountCents) : undefined;
      const view = computeStripeLinkLimits({
        limits: limitStore.getLimits(),
        enabled: cfg.enabled,
        spentLookup: deps.spentLookup,
        botId: typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : undefined,
        amountCents: Number.isFinite(amountRaw) ? amountRaw : undefined,
        now: now(),
      });
      res.json({ ...view, summary: stripeLinkCheckoutSummary(view) });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to read Stripe Link limits') });
    }
  });

  router.put('/purchases/link-limits', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const clean = limitStore.setLimits({
        perPurchaseCents: (body.perPurchaseCents ?? null) as number | null,
        dailyCents: (body.dailyCents ?? null) as number | null,
        monthlyCents: (body.monthlyCents ?? null) as number | null,
      });
      audit('purchase.link_limits_updated', { ...clean });
      res.json(clean);
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'invalid Stripe Link limits') });
    }
  });

  // -- PUR-2 + PUR-6: checkout surface for one intent ------------------

  router.get('/purchases/:id/checkout', async (req: Request, res: Response) => {
    try {
      const intent = await deps.service.reconcileIntent(req.params.id).catch(() => deps.service.getIntent(req.params.id));
      if (!intent) {
        res.status(404).json({ error: `unknown purchase intent: ${req.params.id}` });
        return;
      }
      const cfg = deps.settings.getStripeLinkConfig();
      const surface = assembleCheckoutSurface(intent, {
        stripeLinkEnabled: cfg.enabled,
        limits: limitStore.getLimits(),
        spentLookup: deps.spentLookup,
        preference: preferenceStore.get(intent.merchantName, intent.checkoutUrl),
        now: now(),
      });
      res.json(surface);
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to build checkout surface') });
    }
  });

  // -- PUR-7: cancel a pending intent ----------------------------------

  router.post('/purchases/:id/cancel', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { reason?: unknown };
      const updated = await deps.service.cancelIntent(
        req.params.id,
        typeof body.reason === 'string' ? body.reason : undefined,
      );
      res.json(purchaseIntentView(updated));
    } catch (err) {
      const msg = errMessage(err, 'failed to cancel purchase');
      res.status(msg.startsWith('unknown purchase') ? 404 : 409).json({ error: msg });
    }
  });

  // -- PUR-6: merchant-saved-card / takeover preferences ----------------

  router.get('/purchase-preferences', (_req: Request, res: Response) => {
    res.json(preferenceStore.list());
  });

  router.put('/purchase-preferences', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.merchantName !== 'string' || !body.merchantName.trim()) {
        res.status(400).json({ error: 'body "merchantName" must be a non-empty string' });
        return;
      }
      if (!isCheckoutCompletionPreference(body.preference)) {
        res.status(400).json({
          error: 'body "preference" must be one of: no-preference, merchant-saved-card, user-takeover, stripe-link',
        });
        return;
      }
      const saved = preferenceStore.set({
        merchantName: body.merchantName,
        checkoutUrl: typeof body.checkoutUrl === 'string' ? body.checkoutUrl : undefined,
        preference: body.preference,
      });
      audit('purchase.merchant_preference_updated', {
        merchantKey: saved.merchantKey,
        preference: saved.preference,
      });
      res.json(saved);
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'failed to save merchant preference') });
    }
  });

  router.delete('/purchase-preferences', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merchantName =
        typeof body.merchantName === 'string'
          ? body.merchantName
          : typeof req.query.merchantName === 'string'
            ? req.query.merchantName
            : '';
      if (!merchantName.trim()) {
        res.status(400).json({ error: 'merchantName is required (body or query)' });
        return;
      }
      const checkoutUrl =
        typeof body.checkoutUrl === 'string'
          ? body.checkoutUrl
          : typeof req.query.checkoutUrl === 'string'
            ? req.query.checkoutUrl
            : undefined;
      const removed = preferenceStore.remove(merchantName, checkoutUrl);
      if (!removed) {
        res.status(404).json({ error: `no saved preference for merchant: ${merchantName}` });
        return;
      }
      audit('purchase.merchant_preference_removed', { merchantKey: merchantKeyFor(merchantName, checkoutUrl) });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'failed to remove merchant preference') });
    }
  });

  // -- PUR-6: explicit takeover for an open checkout --------------------

  router.post('/purchases/:id/takeover', async (req: Request, res: Response) => {
    try {
      if (!deps.takeoverManager) {
        res.status(501).json({
          error: 'browser takeover is not wired on this host — the checkout plan and preference are still available via GET /purchases/:id/checkout',
        });
        return;
      }
      const intent = deps.service.getIntent(req.params.id);
      if (!intent) {
        res.status(404).json({ error: `unknown purchase intent: ${req.params.id}` });
        return;
      }
      if (intent.status !== 'awaiting-user-confirm') {
        res.status(409).json({
          error: `takeover is only available while a checkout is open awaiting the user (intent is ${intent.status}) — approve the purchase first so the checkout opens, then take over to finish payment personally`,
        });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
      const personId = typeof body.personId === 'string' ? body.personId.trim() : '';
      if (!profileId || !personId) {
        res.status(400).json({ error: 'body "profileId" and "personId" are required' });
        return;
      }
      const cfg = deps.settings.getStripeLinkConfig();
      const plan = planForIntent(
        intent,
        preferenceStore.preferenceFor(intent.merchantName, intent.checkoutUrl),
        cfg.enabled,
      );
      const session: TakeoverSession = deps.takeoverManager.takeOverNow({
        profileId,
        personId,
        ...(typeof body.personName === 'string' ? { personName: body.personName } : {}),
        reason:
          plan.takeoverReason === 'merchant-saved-card'
            ? `Complete payment for purchase ${intent.id} at ${intent.merchantName} with your merchant-saved card`
            : `Complete payment for purchase ${intent.id} at ${intent.merchantName} personally`,
      });
      audit('purchase.takeover_started', {
        intentId: intent.id,
        merchantKey: plan.merchantKey,
        takeoverReason: plan.takeoverReason,
        sessionId: session.id,
      });
      res.status(201).json({ ok: true, plan, session });
    } catch (err) {
      res.status(409).json({ error: errMessage(err, 'failed to start takeover') });
    }
  });

  // -- PUR-3: real wallet provider (env-gated) ---------------------------

  router.get('/wallet-provider', async (_req: Request, res: Response) => {
    try {
      const provider = walletProvider();
      if (isNetworkWalletProvider(provider)) {
        const stripe = provider as unknown as { describe(): Record<string, unknown> };
        res.json({
          provider: provider.id,
          configured: true,
          chargesEnabled: provider.chargesEnabled,
          // Honest flag: flips only after POST /wallet-provider/verify
          // succeeds against the live account (see WIRING note).
          liveVerified: false,
          ...(typeof stripe.describe === 'function' ? stripe.describe() : {}),
        });
        return;
      }
      res.json({
        provider: provider.id,
        configured: false,
        chargesEnabled: provider.chargesEnabled,
        liveVerified: false,
        note: 'Mock wallet — set WALLET_PROVIDER=stripe with STRIPE_SECRET_KEY + STRIPE_WALLET_CUSTOMER_ID to enable the real provider.',
      });
    } catch (err) {
      res.status(isWalletError(err) ? 400 : 500).json({ error: errMessage(err, 'wallet provider is misconfigured') });
    }
  });

  router.post('/wallet-provider/verify', async (_req: Request, res: Response) => {
    try {
      const provider = walletProvider();
      if (!isNetworkWalletProvider(provider)) {
        res.status(400).json({ error: 'the mock wallet has no live connection to verify — configure the Stripe wallet provider first' });
        return;
      }
      const stripe = provider as unknown as {
        verifyConnection(): Promise<{ ok: true; provider: string; customerId: string; liveMode: boolean }>;
      };
      const result = await stripe.verifyConnection();
      audit('wallet.provider_verified', { provider: result.provider, liveMode: result.liveMode });
      res.json({ ...result, liveVerified: true });
    } catch (err) {
      res.status(isWalletError(err) ? 400 : 500).json({ error: errMessage(err, 'wallet provider verification failed') });
    }
  });

  router.get('/wallet-provider/methods', async (_req: Request, res: Response) => {
    try {
      res.json(await listWalletMethods(walletProvider()));
    } catch (err) {
      res.status(isWalletError(err) ? 400 : 500).json({ error: errMessage(err, 'failed to list wallet methods') });
    }
  });

  router.post('/wallet-provider/methods', async (req: Request, res: Response) => {
    try {
      const provider = walletProvider();
      if (!isNetworkWalletProvider(provider)) {
        res.status(400).json({
          error: 'the mock wallet stores methods locally via /api/wallet/methods — provider methods can only be attached when the real wallet provider is configured',
        });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.providerMethodId !== 'string') {
        res.status(400).json({
          error: 'body "providerMethodId" must be the opaque pm_… id minted by the Stripe hosted/Link flow — raw card data is never accepted',
        });
        return;
      }
      const stripe = provider as unknown as {
        addProviderPaymentMethod(id: string): Promise<unknown>;
      };
      const method = (await stripe.addProviderPaymentMethod(body.providerMethodId)) as {
        brand: string;
        last4: string;
      };
      audit('wallet.provider_method_added', { brand: method.brand, last4: method.last4 });
      res.status(201).json(method);
    } catch (err) {
      res.status(isWalletError(err) ? 400 : 500).json({ error: errMessage(err, 'failed to add wallet method') });
    }
  });

  router.delete('/wallet-provider/methods/:id', async (req: Request, res: Response) => {
    try {
      const removed = await removeWalletMethod(walletProvider(), req.params.id);
      if (!removed) {
        res.status(404).json({ error: `unknown payment method: ${req.params.id}` });
        return;
      }
      audit('wallet.provider_method_removed', { methodId: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      res.status(isWalletError(err) ? 400 : 500).json({ error: errMessage(err, 'failed to remove wallet method') });
    }
  });
}

/** Standalone router factory (mount at /api/billing). */
export function createPurchaseExtrasRouter(deps: PurchaseExtrasDeps): Router {
  const router = express.Router();
  registerPurchaseExtrasRoutes(router, deps);
  return router;
}
