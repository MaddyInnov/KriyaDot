// SPDX-License-Identifier: Apache-2.0
// Billing HTTP API. Mounted by the integrator (routes.ts), e.g.:
//
//   import { registerBillingRoutes } from './billing.js';
//   const billingRouter = express.Router();
//   registerBillingRoutes(billingRouter, {
//     dataDir: config.dataDir,
//     meter: new UsageMeter(join(config.dataDir, 'billing.db')),
//     ledger: new BillingLedger(join(config.dataDir, 'billing.db')),
//     provider: new MockBillingProvider(), // mock only in the MVP
//   });
//   app.use('/api/billing', billingRouter);
//
// Routes (router mounted at /api/billing):
//   GET    /usage                 → UsageSummary (?botId=, ?since=)
//   GET    /usage/events          → UsageEvent[] (?sessionId=, ?botId=, ?since=, ?limit=)
//   POST   /usage                 → record one usage event
//   GET    /usage/cost            → { summary, priceConfig, costCents }
//   GET    /usage/breakdown       → CostBreakdown (?period=day|week|month|all, ?feature=, ?since=, ?until=)
//   POST   /usage/cost-events     → record a per-feature/per-step cost event (201)
//   GET    /usage/caps            → FeatureCapStatus[] (monthly per-feature caps)
//   PUT    /usage/caps/:feature   → { monthlyCapCents } → FeatureCapStatus
//   GET    /ledger                → LedgerInvoice[] (?customerId=, ?limit=)
//   GET    /ledger/:id            → LedgerInvoice
//   POST   /customers             → { email, name? } → BillingCustomer (mock)
//   GET    /customers/:id         → BillingCustomer
//   POST   /invoices              → { customerId, lines } → draft invoice
//   GET    /invoices/:id          → BillingInvoice
//   POST   /invoices/:id/finalize → → open
//   POST   /invoices/:id/pay      → mock settlement → paid (also records + mirrors in ledger)
//   POST   /invoices/:id/void     → void
//   POST   /payment-intents       → { customerId, amountCents, currency? }
//   GET    /payment-intents/:id   → PaymentIntent
//   POST   /payment-intents/:id/confirm → mock confirm → succeeded
//   POST   /payment-intents/:id/cancel  → canceled
//
// Money is mocked end-to-end (MockBillingProvider). No real charges.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { BillingLedger, costOfUsage, resolvePriceConfig, UsageMeter, CostTracker } from '@mvp/billing';
import type { BillingProvider, TokenUsageInput, UsageKind, BreakdownPeriod } from '@mvp/billing';
import { MockBillingProvider } from '@mvp/billing';

export interface BillingDeps {
  dataDir: string;
  meter: UsageMeter;
  ledger: BillingLedger;
  provider: BillingProvider;
  /** Per-feature/per-step cost tracking for the cost dashboard. */
  costTracker: CostTracker;
}

const VALID_USAGE_KINDS: ReadonlySet<string> = new Set(['tokens', 'workflow', 'sandbox']);

function numQuery(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function registerBillingRoutes(router: Router, deps: BillingDeps): void {
  const { meter, ledger, provider, costTracker } = deps;

  // ---- Usage metering ------------------------------------------------------

  router.get('/usage', (req: Request, res: Response) => {
    try {
      const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
      res.json(meter.summary({ botId, since: numQuery(req.query.since) }));
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to read usage') });
    }
  });

  router.get('/usage/events', (req: Request, res: Response) => {
    try {
      res.json(
        meter.list({
          sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
          botId: typeof req.query.botId === 'string' ? req.query.botId : undefined,
          since: numQuery(req.query.since),
          limit: numQuery(req.query.limit),
        }),
      );
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list usage events') });
    }
  });

  router.post('/usage', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        kind?: unknown;
        sessionId?: unknown;
        botId?: unknown;
        usage?: unknown;
        workflowId?: unknown;
        runId?: unknown;
        minutes?: unknown;
      };
      if (typeof body.kind !== 'string' || !VALID_USAGE_KINDS.has(body.kind)) {
        res.status(400).json({ error: 'body "kind" must be tokens|workflow|sandbox' });
        return;
      }
      const kind = body.kind as UsageKind;
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const botId = typeof body.botId === 'string' ? body.botId : '';
      let event;
      if (kind === 'tokens') {
        if (!sessionId || !botId) {
          res.status(400).json({ error: '"sessionId" and "botId" are required for tokens events' });
          return;
        }
        const u = body.usage as TokenUsageInput | undefined;
        if (!u || typeof u.promptTokens !== 'number') {
          res.status(400).json({ error: 'body "usage" { promptTokens, completionTokens, totalTokens } is required' });
          return;
        }
        event = meter.recordTokens(sessionId, botId, u);
      } else if (kind === 'workflow') {
        if (typeof body.workflowId !== 'string' || !body.workflowId) {
          res.status(400).json({ error: 'body "workflowId" is required for workflow events' });
          return;
        }
        event = meter.recordWorkflowRun(
          typeof body.runId === 'string' && body.runId ? body.runId : `run_${Date.now()}`,
          body.workflowId,
          botId,
        );
      } else {
        if (!sessionId || !botId) {
          res.status(400).json({ error: '"sessionId" and "botId" are required for sandbox events' });
          return;
        }
        if (typeof body.minutes !== 'number' || !Number.isFinite(body.minutes) || body.minutes < 0) {
          res.status(400).json({ error: 'body "minutes" must be a non-negative number' });
          return;
        }
        event = meter.recordSandboxMinutes(sessionId, botId, body.minutes);
      }
      res.status(201).json(event);
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to record usage') });
    }
  });

  router.get('/usage/cost', (_req: Request, res: Response) => {
    try {
      const summary = meter.summary();
      const priceConfig = resolvePriceConfig();
      res.json({ summary, priceConfig, costCents: costOfUsage(summary, priceConfig) });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to compute usage cost') });
    }
  });

  // ---- Cost dashboard: per-feature/per-step breakdown + feature caps ------
  // GET  /usage/breakdown?period=month&feature=&since=&until=
  //        → { period, since, until, byFeature[], byStep[], totals }
  // POST /usage/cost-events
  //        → { feature, step, model?, inputTokens, outputTokens, costCents?, sessionId?, botId? }
  // GET  /usage/caps            → FeatureCapStatus[] (capExceeded is the dashboard signal)
  // PUT  /usage/caps/:feature   → { monthlyCapCents } → FeatureCapStatus

  const VALID_PERIODS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'all']);

  router.get('/usage/breakdown', (req: Request, res: Response) => {
    try {
      const periodRaw = typeof req.query.period === 'string' ? req.query.period : 'month';
      if (!VALID_PERIODS.has(periodRaw)) {
        res.status(400).json({ error: 'query "period" must be one of day|week|month|all' });
        return;
      }
      res.json(
        costTracker.breakdown({
          period: periodRaw as BreakdownPeriod,
          feature: typeof req.query.feature === 'string' ? req.query.feature : undefined,
          since: numQuery(req.query.since),
          until: numQuery(req.query.until),
        }),
      );
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to compute cost breakdown') });
    }
  });

  router.post('/usage/cost-events', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        feature?: unknown;
        step?: unknown;
        model?: unknown;
        inputTokens?: unknown;
        outputTokens?: unknown;
        costCents?: unknown;
        sessionId?: unknown;
        botId?: unknown;
      };
      const event = costTracker.record({
        feature: body.feature as string,
        step: body.step as string,
        model: typeof body.model === 'string' ? body.model : undefined,
        inputTokens: body.inputTokens as number,
        outputTokens: body.outputTokens as number,
        costCents: body.costCents === undefined ? undefined : (body.costCents as number),
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        botId: typeof body.botId === 'string' ? body.botId : undefined,
      });
      res.status(201).json(event);
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'invalid cost event') });
    }
  });

  router.get('/usage/caps', (_req: Request, res: Response) => {
    try {
      res.json(costTracker.allCapStatuses());
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to read feature caps') });
    }
  });

  router.put('/usage/caps/:feature', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { monthlyCapCents?: unknown };
      if (typeof body.monthlyCapCents !== 'number') {
        res.status(400).json({ error: 'body "monthlyCapCents" must be a number (USD cents)' });
        return;
      }
      costTracker.setFeatureCap(req.params.feature, body.monthlyCapCents);
      res.json(costTracker.capStatus(req.params.feature));
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'invalid feature cap') });
    }
  });

  // ---- Billing ledger ------------------------------------------------------

  router.get('/ledger', (req: Request, res: Response) => {
    try {
      res.json(
        ledger.listInvoices({
          customerId: typeof req.query.customerId === 'string' ? req.query.customerId : undefined,
          limit: numQuery(req.query.limit),
        }),
      );
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list invoices') });
    }
  });

  router.get('/ledger/:id', (req: Request, res: Response) => {
    const inv = ledger.getInvoice(req.params.id);
    if (!inv) {
      res.status(404).json({ error: `unknown ledger invoice: ${req.params.id}` });
      return;
    }
    res.json(inv);
  });

  // ---- Customers / invoices / payment intents (mock provider) --------------

  router.post('/customers', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { email?: unknown; name?: unknown; metadata?: unknown };
      const customer = await provider.createCustomer({
        email: body.email as string,
        name: typeof body.name === 'string' ? body.name : undefined,
        metadata: (body.metadata ?? undefined) as Record<string, string> | undefined,
      });
      res.status(201).json(customer);
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to create customer') });
    }
  });

  router.get('/customers/:id', async (req: Request, res: Response) => {
    const customer = await provider.getCustomer(req.params.id);
    if (!customer) {
      res.status(404).json({ error: `unknown customer: ${req.params.id}` });
      return;
    }
    res.json(customer);
  });

  router.post('/invoices', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { customerId?: unknown; lines?: unknown };
      const invoice = await provider.createInvoice({
        customerId: body.customerId as string,
        lines: body.lines as Array<{ description: string; amountCents: number; quantity?: number }>,
      });
      ledger.recordInvoice(invoice, invoice.id);
      res.status(201).json(invoice);
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to create invoice') });
    }
  });

  router.get('/invoices/:id', async (req: Request, res: Response) => {
    const invoice = await provider.getInvoice(req.params.id);
    if (!invoice) {
      res.status(404).json({ error: `unknown invoice: ${req.params.id}` });
      return;
    }
    res.json(invoice);
  });

  router.post('/invoices/:id/finalize', async (req: Request, res: Response) => {
    try {
      const invoice = await provider.finalizeInvoice(req.params.id);
      ledger.updateStatus(invoice.id, 'open', { finalizedAt: invoice.finalizedAt ?? Date.now() });
      res.json(invoice);
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to finalize invoice') });
    }
  });

  router.post('/invoices/:id/pay', async (req: Request, res: Response) => {
    try {
      const invoice = await provider.markInvoicePaid(req.params.id);
      ledger.updateStatus(invoice.id, 'paid', { paidAt: invoice.paidAt ?? Date.now() });
      res.json({ ...invoice, mock: true, note: 'mock settlement — no real money moved' });
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to pay invoice') });
    }
  });

  router.post('/invoices/:id/void', async (req: Request, res: Response) => {
    try {
      const invoice = await provider.voidInvoice(req.params.id);
      ledger.updateStatus(invoice.id, 'void');
      res.json(invoice);
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to void invoice') });
    }
  });

  router.post('/payment-intents', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { customerId?: unknown; amountCents?: unknown; currency?: unknown };
      const pi = await provider.createPaymentIntent({
        customerId: body.customerId as string,
        amountCents: body.amountCents as number,
        currency: typeof body.currency === 'string' ? body.currency : undefined,
      });
      res.status(201).json(pi);
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to create payment intent') });
    }
  });

  router.get('/payment-intents/:id', async (req: Request, res: Response) => {
    const pi = await provider.getPaymentIntent(req.params.id);
    if (!pi) {
      res.status(404).json({ error: `unknown payment intent: ${req.params.id}` });
      return;
    }
    res.json(pi);
  });

  router.post('/payment-intents/:id/confirm', async (req: Request, res: Response) => {
    try {
      const pi = await provider.confirmPaymentIntent(req.params.id);
      res.json({ ...pi, mock: true, note: 'mock confirmation — no real money moved' });
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to confirm payment intent') });
    }
  });

  router.post('/payment-intents/:id/cancel', async (req: Request, res: Response) => {
    try {
      res.json(await provider.cancelPaymentIntent(req.params.id));
    } catch (err) {
      res.status(isBadRequest(err) ? 400 : 500).json({ error: errMessage(err, 'failed to cancel payment intent') });
    }
  });
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Heuristic: validation errors from the mock provider are client errors. */
function isBadRequest(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /must be|unknown customer|needs at least|not a draft|not open|already paid|cannot be/.test(err.message);
}

// Re-export the package classes the integrator needs to construct deps.
export { BillingLedger, MockBillingProvider, UsageMeter, costOfUsage, resolvePriceConfig };
