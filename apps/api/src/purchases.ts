// SPDX-License-Identifier: Apache-2.0
// Approval-gated purchasing (W6): API wiring for @mvp/billing's
// PurchaseService — the `request_purchase` agent tool, its governance
// policy, the Stripe Link / browser-checkout executors over the bot's own
// browser surface, the vault-held Stripe Link reference, and the
// /api/billing/purchases HTTP routes.
//
// Safety contract (never weakened):
//   - Creating an intent NEVER executes anything. Execution happens only
//     after a human approves the intent's governance card (the card the
//     gateway mints for the `request_purchase` call IS the purchase card —
//     the GovernanceAdapter observer below links the intent to it, so
//     there is exactly one card per purchase).
//   - `request_purchase` is require-approval ALWAYS: the policy rule below
//     is prepended to the global policy, the tool is treated as privileged
//     by the learned-preference layer and by "always allow" persistence
//     (both refuse it), and PurchaseService.executeIntent additionally
//     refuses to run from 'pending-approval' unless the linked governance
//     approval is genuinely 'approved' — so bypass / auto-approve runtime
//     modes cannot execute a purchase without a human decision.
//   - Payment details never enter this module: the Stripe Link reference
//     is an opaque id stored in the Secure Vault (secret name
//     'stripe-link-ref'); executors receive only intent id + approval id.
//   - The browser-checkout path never confirms payment: the OS adapter's
//     clickFinalPayButton throws, and BrowserCheckoutExecutor never calls
//     it — the user finishes checkout personally.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { OSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import {
  BrowserCheckoutExecutor,
  CostTracker,
  PurchaseIntentStore,
  PurchaseService,
  PurchaseSettingsStore,
  SpendCapStore,
  StripeLinkExecutor,
  PURCHASE_TOOL_NAME,
  normalizePurchaseInput,
  purchaseApprovalArgs,
  purchaseFingerprint,
  purchaseIntentView,
} from '@mvp/billing';
import type {
  CheckoutBrowser,
  CreatePurchaseInput,
  PurchaseIntent,
  PurchaseSettingsProvider,
} from '@mvp/billing';
import type { GovernanceGateway } from '@mvp/governance';
import { SecureVault } from '@mvp/vault';

/** Vault secret holding ONLY the opaque Stripe Link reference id. */
export const STRIPE_LINK_REF_SECRET = 'stripe-link-ref';

// ---------------------------------------------------------------------------
// Governance policy
// ---------------------------------------------------------------------------

export function purchasePolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'request-purchase-approval',
      toolPattern: `^${PURCHASE_TOOL_NAME}$`,
      effect: 'require-approval',
      reason:
        'Purchases always need individual human approval — every request_purchase raises its own approval card and there is no always-allow for purchases',
    },
  ];
}

// ---------------------------------------------------------------------------
// Checkout browser over the bot's OS/computer surface
// ---------------------------------------------------------------------------

/**
 * Production CheckoutBrowser adapter over a bot's OSScreenLayer (its
 * per-bot, persistent-profile browser/computer surface). Navigation and
 * non-payment filling are keyboard-driven best-effort (the OS layer is
 * coordinate-based); the invariants that matter are structural:
 *   - completeWithStripeLink NEVER types the link reference anywhere —
 *     with a coordinate OS layer there is no reliable way to drive Stripe
 *     Link's hosted UI, so it throws and PurchaseService falls back to the
 *     browser-checkout handoff (user pays personally). Page-level drivers
 *     can implement it for real behind the same interface.
 *   - clickFinalPayButton throws unconditionally: no code path in the
 *     browser-checkout flow may confirm a payment.
 */
export class OsCheckoutBrowser implements CheckoutBrowser {
  constructor(private readonly os: OSScreenLayer) {}

  async goto(url: string): Promise<void> {
    await this.os.keyChord(['ctrl'], 'l');
    await this.os.type(url);
    await this.os.key('Enter');
  }

  async fillNonPaymentDetails(details: { itemDescription: string; merchantName: string; quantity: number }): Promise<void> {
    // Best-effort keyboard flow: merchant checkouts typically autofocus
    // their first field (quantity / variant / note). Type the item into
    // the focused field, Tab onward, and set the quantity. Payment fields
    // are never touched — the intent carries no payment data to type.
    await this.os.type(details.itemDescription.slice(0, 200));
    await this.os.key('Tab');
    await this.os.type(String(details.quantity));
  }

  async completeWithStripeLink(_linkRef: string): Promise<{ providerRef: string }> {
    throw new Error(
      'Stripe Link completion is not available on the coordinate OS browser layer; falling back to browser checkout for manual payment.',
    );
  }

  async clickFinalPayButton(): Promise<void> {
    throw new Error('refused: the browser-checkout path never confirms a payment — the user pays personally');
  }

  async currentUrl(): Promise<string> {
    return 'browser-checkout';
  }
}

// ---------------------------------------------------------------------------
// Settings provider: billing.db flag + vault-held opaque reference
// ---------------------------------------------------------------------------

/**
 * Stripe Link settings: the enabled flag lives in the billing settings
 * store; the opaque Link reference lives in the Secure Vault (written when
 * the user enables Stripe Link; read server-side only, at execution time).
 * Neither value is a payment credential.
 */
export class VaultPurchaseSettings implements PurchaseSettingsProvider {
  constructor(
    private readonly store: PurchaseSettingsStore,
    private readonly dataDir: string,
  ) {}

  private vault(): SecureVault {
    return new SecureVault(this.dataDir, 'default-user', 'purchases');
  }

  getStripeLinkConfig(): { enabled: boolean; linkRef: string | null } {
    const base = this.store.getStripeLinkConfig();
    if (!base.enabled) return { enabled: false, linkRef: null };
    let linkRef = base.linkRef;
    try {
      linkRef = this.vault().get(STRIPE_LINK_REF_SECRET)?.value ?? linkRef;
    } catch {
      // Vault unreadable → fall back to the settings-store reference.
    }
    return { enabled: true, linkRef };
  }

  setStripeLinkConfig(cfg: { enabled: boolean; linkRef: string | null }): void {
    this.store.setStripeLinkConfig(cfg);
    if (cfg.enabled && cfg.linkRef) {
      try {
        const vault = this.vault();
        if (vault.get(STRIPE_LINK_REF_SECRET)) vault.update(STRIPE_LINK_REF_SECRET, cfg.linkRef);
        else vault.create(STRIPE_LINK_REF_SECRET, cfg.linkRef, 'Opaque Stripe Link reference id for approval-gated purchases (not a payment credential)');
      } catch {
        // The settings store copy remains authoritative as a fallback.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export interface PurchaseWiringDeps {
  dataDir: string;
  governance: GovernanceGateway;
  /** Cost ledger (shared billing.db CostTracker) for caps + recording. */
  costTracker: CostTracker;
  /** Spend-cap config store (shared billing.db). */
  spendCaps: SpendCapStore;
  /** Resolve the calling bot's OS/browser surface per execution. */
  resolveOS: (botId: string) => OSScreenLayer | Promise<OSScreenLayer>;
  /** Checkout-browser factory override (tests inject MockCheckoutBrowser). */
  browserFor?: (botId: string) => Promise<CheckoutBrowser>;
}

export interface PurchaseWiring {
  service: PurchaseService;
  store: PurchaseIntentStore;
  settings: VaultPurchaseSettings;
  /** GovernanceAdapter observer: link a minted tool approval to an intent. */
  onApprovalMinted: (info: {
    toolName: string;
    args: Record<string, unknown>;
    botId: string;
    sessionId: string;
    realApprovalId: string;
  }) => void;
}

export function toolArgsToPurchaseInput(args: Record<string, unknown>): CreatePurchaseInput {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
  return {
    itemDescription: str(args['itemDescription'] ?? args['item']),
    merchantName: str(args['merchantName'] ?? args['merchant']),
    amountCents: num(args['amountCents']),
    currency: str(args['currency']) || 'USD',
    checkoutUrl: str(args['checkoutUrl'] ?? args['url']),
    executionMethod:
      args['executionMethod'] === 'stripe-link' || args['executionMethod'] === 'browser-checkout'
        ? args['executionMethod']
        : undefined,
  };
}

export function createPurchaseWiring(deps: PurchaseWiringDeps): PurchaseWiring {
  const dbPath = join(deps.dataDir, 'billing.db');
  const store = new PurchaseIntentStore(dbPath);
  const settings = new VaultPurchaseSettings(new PurchaseSettingsStore(dbPath), deps.dataDir);
  const browserFor =
    deps.browserFor ??
    (async (botId: string): Promise<CheckoutBrowser> =>
      new OsCheckoutBrowser(await deps.resolveOS(botId)));
  const stripeExecutor = new StripeLinkExecutor({ store, settings, browserFor });
  const browserExecutor = new BrowserCheckoutExecutor({ store, browserFor });

  const service = new PurchaseService({
    store,
    settings,
    caps: () => deps.spendCaps.getConfig(),
    spentLookup: (since, until, botId) => deps.costTracker.spentCents({ since, until, botId }),
    recordLedger: (intent) =>
      deps.costTracker.record({
        feature: 'purchase',
        step: 'checkout',
        inputTokens: 0,
        outputTokens: 0,
        costCents: intent.totalCents,
        botId: intent.botId,
        sessionId: intent.id,
      }).id,
    raiseApproval: (intent) =>
      deps.governance.requestApproval(
        PURCHASE_TOOL_NAME,
        purchaseApprovalArgs(intent),
        { sessionId: intent.sessionId || 'purchases', botId: intent.botId, actor: intent.botId },
        { provenance: 'purchase-intent' },
      ),
    approvalStatus: (approvalId) => deps.governance.getApproval(approvalId)?.status,
    stripeExecutor,
    browserExecutor,
    audit: (action, detail) => {
      try {
        deps.governance.audit(action, { actor: 'purchase-service', detail });
      } catch {
        // Audit must never break purchasing.
      }
    },
  });

  const onApprovalMinted: PurchaseWiring['onApprovalMinted'] = (info) => {
    if (info.toolName !== PURCHASE_TOOL_NAME) return;
    try {
      const input = toolArgsToPurchaseInput(info.args);
      // Fire-and-forget with its own error swallow: intent registration
      // must never break governance evaluation. Validation errors simply
      // mean no intent is linked (the tool handler will surface them).
      void service
        .noteToolApprovalMinted({
          botId: info.botId,
          sessionId: info.sessionId,
          approvalId: info.realApprovalId,
          input,
        })
        .catch(() => undefined);
    } catch {
      // Invalid purchase args — no intent; the handler reports the error.
    }
  };

  return { service, store, settings, onApprovalMinted };
}

// ---------------------------------------------------------------------------
// Agent tool: request_purchase
// ---------------------------------------------------------------------------

export interface PurchaseToolDeps {
  registry: Map<string, ToolDefinition>;
  service: PurchaseService;
}

function intentSummary(intent: PurchaseIntent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    intentId: intent.id,
    status: intent.status,
    item: intent.itemDescription,
    merchant: intent.merchantName,
    amountCents: intent.amountCents,
    currency: intent.currency,
    totalCents: intent.totalCents,
    executionMethod: intent.executionMethod,
  };
  switch (intent.status) {
    case 'pending-approval':
      base.message =
        'Purchase request recorded and waiting for the user to approve it in the approvals inbox. Nothing has been charged and nothing will execute until the user approves this exact purchase.';
      break;
    case 'blocked':
      base.message = `This purchase is blocked and will not be executed: ${intent.blockReason ?? 'blocked by policy'}`;
      base.blockReason = intent.blockReason;
      break;
    case 'denied':
      base.message = 'The user denied this purchase. It will not be executed.';
      break;
    case 'cancelled':
      base.message = 'The user cancelled this purchase while it was still pending. It will not be executed.';
      break;
    case 'completed':
      base.message = 'Purchase completed after user approval.';
      base.ledgerRef = intent.ledgerRef;
      break;
    case 'awaiting-user-confirm':
      base.message =
        'The checkout is open in your browser, filled with the non-payment details, stopped BEFORE the pay step. The user must complete (or abandon) the payment personally.';
      base.note = intent.note;
      break;
    case 'failed':
      base.message = `Purchase execution failed: ${intent.failureReason ?? 'unknown error'}`;
      break;
    default:
      base.message = `Purchase is ${intent.status}.`;
  }
  return base;
}

export function createRequestPurchaseTool(service: PurchaseService): ToolDefinition {
  return {
    name: PURCHASE_TOOL_NAME,
    mutating: true,
    description: [
      'Request approval to buy something for the user. This NEVER charges',
      'anything by itself: it records a purchase intent and raises an',
      'approval card showing the item, merchant, amount and link. Only if',
      'the user approves that exact purchase does execution run (Stripe',
      'Link when enabled, otherwise a browser checkout that stops BEFORE',
      'the pay step for the user to finish personally). Securities/crypto',
      'trading and transfers between the user\'s own accounts are hard-',
      'blocked, as are purchases over the spend caps.',
      '',
      'Args:',
      '- itemDescription (string, required): what is being bought.',
      '- merchantName (string, required): seller / merchant name.',
      '- amountCents (number, required): price in integer minor units (e.g. 4999 = 49.99).',
      '- currency (string, optional): 3-letter ISO code, default USD.',
      '- checkoutUrl (string, required): product/checkout URL (http/https).',
      '- executionMethod (string, optional): stripe-link | browser-checkout.',
      '',
      'NEVER include card numbers or payment details in any argument —',
      'payment details stay in Stripe Link / the user\'s browser and are',
      'never visible to you. Returns the intent status; pending-approval',
      'means stop and wait for the user.',
      'Requires individual human approval for every purchase (governance policy).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        itemDescription: { type: 'string', description: 'What is being bought' },
        merchantName: { type: 'string', description: 'Seller / merchant name' },
        amountCents: { type: 'number', description: 'Price in integer minor units (cents)' },
        currency: { type: 'string', description: '3-letter ISO currency code (default USD)' },
        checkoutUrl: { type: 'string', description: 'Product or checkout URL' },
        executionMethod: { type: 'string', enum: ['stripe-link', 'browser-checkout'] },
      },
      required: ['itemDescription', 'merchantName', 'amountCents', 'checkoutUrl'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const input = toolArgsToPurchaseInput(args);
      const normalized = normalizePurchaseInput(input); // throws on invalid/card-carrying args
      const fingerprint = purchaseFingerprint(ctx.botId, ctx.sessionId, normalized);
      const existing = service.getByFingerprint(fingerprint);
      if (existing) {
        // The governance approval for this call already minted the intent
        // (see onApprovalMinted). If the human approved it, claim +
        // execute now; otherwise report the live status — crucially, a
        // still-pending approval executes NOTHING (bypass-safe).
        const settled = await service.executeIntent(existing.id);
        return intentSummary(settled);
      }
      // No pre-minted intent (direct invocation outside the gateway):
      // create one + raise its approval card, then stop. Execution only
      // ever follows a human approval decision.
      const intent = await service.createIntent(input, { botId: ctx.botId, sessionId: ctx.sessionId });
      return intentSummary(intent);
    },
  };
}

/** Register request_purchase into a tool registry (skips on collision). */
export function registerPurchaseTools(deps: PurchaseToolDeps): void {
  const tool = createRequestPurchaseTool(deps.service);
  if (!deps.registry.has(tool.name)) {
    deps.registry.set(tool.name, tool);
  }
}

// ---------------------------------------------------------------------------
// HTTP routes (mounted on the billing router at /api/billing)
// ---------------------------------------------------------------------------

export interface PurchaseRouteDeps {
  service: PurchaseService;
  settings: VaultPurchaseSettings;
  /** Decide the linked governance approval (routes.ts/index wiring). */
  decideApproval: (approvalId: string, decision: 'approved' | 'denied') => void;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function registerPurchaseRoutes(router: Router, deps: PurchaseRouteDeps): void {
  const { service, settings } = deps;

  // GET /purchases?botId=&status=&limit= — intent list (billing area UI).
  router.get('/purchases', async (req: Request, res: Response) => {
    try {
      await service.reconcilePending();
      const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
      const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      res.json(
        service
          .listIntents({
            botId: typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : undefined,
            status: statusRaw as PurchaseIntent['status'] | undefined,
            limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          })
          .map(purchaseIntentView),
      );
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list purchases') });
    }
  });

  router.get('/purchases/settings', (_req: Request, res: Response) => {
    const cfg = settings.getStripeLinkConfig();
    res.json({ stripeLinkEnabled: cfg.enabled, stripeLinkConfigured: Boolean(cfg.linkRef), stripeLinkRef: cfg.linkRef });
  });

  // PUT /purchases/settings { stripeLinkEnabled } — enabling generates the
  // opaque reference (vault-held); the reference is an id, not a credential.
  router.put('/purchases/settings', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { stripeLinkEnabled?: unknown };
      if (typeof body.stripeLinkEnabled !== 'boolean') {
        res.status(400).json({ error: 'body "stripeLinkEnabled" must be a boolean' });
        return;
      }
      const current = settings.getStripeLinkConfig();
      const linkRef = current.linkRef ?? (body.stripeLinkEnabled ? `slink_${randomUUID()}` : null);
      settings.setStripeLinkConfig({ enabled: body.stripeLinkEnabled, linkRef });
      const cfg = settings.getStripeLinkConfig();
      res.json({ stripeLinkEnabled: cfg.enabled, stripeLinkConfigured: Boolean(cfg.linkRef), stripeLinkRef: cfg.linkRef });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to update purchase settings') });
    }
  });

  // POST /purchases — create an intent manually (same flow as the tool:
  // pending + approval card, or blocked). Never executes.
  router.post('/purchases', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const botId = typeof body.botId === 'string' && body.botId.trim() ? body.botId.trim() : 'manual';
      const intent = await service.createIntent(toolArgsToPurchaseInput(body), {
        botId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : 'purchases-ui',
      });
      res.status(201).json(purchaseIntentView(intent));
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'invalid purchase intent') });
    }
  });

  router.get('/purchases/:id', async (req: Request, res: Response) => {
    try {
      const intent = await service.reconcileIntent(req.params.id).catch(() => service.getIntent(req.params.id));
      if (!intent) {
        res.status(404).json({ error: `unknown purchase intent: ${req.params.id}` });
        return;
      }
      res.json(purchaseIntentView(intent));
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to read purchase') });
    }
  });

  // POST /purchases/:id/decide { decision } — the purchases-area action;
  // decides the linked governance approval AND the intent (the approvals
  // inbox POST /api/approvals/:id path lands in the same service method).
  router.post('/purchases/:id/decide', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { decision?: unknown };
      if (body.decision !== 'approved' && body.decision !== 'denied') {
        res.status(400).json({ error: 'body "decision" must be "approved" or "denied"' });
        return;
      }
      const intent = service.getIntent(req.params.id);
      if (!intent) {
        res.status(404).json({ error: `unknown purchase intent: ${req.params.id}` });
        return;
      }
      if (intent.approvalId) {
        try {
          deps.decideApproval(intent.approvalId, body.decision);
        } catch {
          // Already decided (e.g. via the approvals inbox) — the service
          // decision below is authoritative for the intent.
        }
      }
      const updated = await service.handleApprovalDecision(intent.id, body.decision);
      res.json(purchaseIntentView(updated));
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to decide purchase') });
    }
  });

  // POST /purchases/:id/confirm-completion { outcome } — the user reports
  // the result of a browser-checkout handoff they finished personally.
  router.post('/purchases/:id/confirm-completion', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { outcome?: unknown; note?: unknown };
      if (body.outcome !== 'completed' && body.outcome !== 'failed') {
        res.status(400).json({ error: 'body "outcome" must be "completed" or "failed"' });
        return;
      }
      const updated = await service.confirmUserCompletion(
        req.params.id,
        body.outcome,
        typeof body.note === 'string' ? body.note : undefined,
      );
      res.json(purchaseIntentView(updated));
    } catch (err) {
      const msg = errMessage(err, 'failed to confirm purchase');
      res.status(msg.startsWith('unknown purchase') ? 404 : 400).json({ error: msg });
    }
  });
}
