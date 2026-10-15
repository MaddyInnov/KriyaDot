// SPDX-License-Identifier: Apache-2.0
// Vault + wallet + connected-accounts API (Phase 4, Workstream C).
//
// Mount at /api by the integrator, e.g.:
//   import { registerVaultRoutes } from './vault.js';
//   const apiRouter = express.Router();
//   registerVaultRoutes(apiRouter, deps);
//   app.use('/api', apiRouter);
//
// Routes (router mounted at /api):
//   GET    /vault              → SecretMeta[] (values are NEVER listed)
//   POST   /vault              → { name, value, description?, tier? } → SecretMeta (201)
//   GET    /vault/:name        → Secret (the only read that returns a value)
//   PUT    /vault/:name        → { value?, description?, tier? } → SecretMeta
// Secrets carry a privacy tier (default local-only); `tier` optionally
// overrides it (metadata|cloud-ok|local-only).
//   DELETE /vault/:name        → { ok: true }
//   GET    /wallet             → { provider, chargesEnabled, methods }
//   GET    /wallet/methods     → PaymentMethod[]
//   POST   /wallet/methods     → { cardNumber, expMonth, expYear, holderName? } (201)
//   DELETE /wallet/methods/:id → { ok: true }
//   POST   /wallet/charge      → 400: the mock provider never charges
//   GET    /accounts/summary   → OAuth statuses + vault/wallet counts
//
// The vault is per-user: the caller is `x-user-id` (fallback
// 'default-user'), namespaced so users sharing a data dir never see each
// other's secrets. Secret values never appear in logs, errors, or audit
// detail — only names.

import express from 'express';
import type { Request, Response } from 'express';
import { MockWalletProvider, SecureVault, isVaultError, isWalletError } from '@mvp/vault';
import { isPrivacyTier } from '@mvp/governance';
import type { PrivacyTier } from '@mvp/governance';
import { getOAuthStatus } from './oauth.js';
import type { RouteDeps } from './routes.js';

type VaultDeps = Pick<RouteDeps, 'config' | 'governance'>;

/**
 * Optional tier override from a request body; undefined = keep the
 * write-time default. Returns { ok: false } (after sending a 400) for an
 * invalid tier so callers stay flat.
 */
function tierParam(v: unknown, res: Response): { ok: true; tier: PrivacyTier | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, tier: undefined };
  if (!isPrivacyTier(v)) {
    res.status(400).json(errorBody('tier must be one of metadata|cloud-ok|local-only'));
    return { ok: false };
  }
  return { ok: true, tier: v };
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function callerOf(req: Request): string {
  const header = req.header('x-user-id');
  return typeof header === 'string' && header.length > 0 ? header : 'default-user';
}

export function registerVaultRoutes(router: express.Router, deps: VaultDeps): void {
  const { config, governance } = deps;

  const vaultOf = (req: Request): SecureVault =>
    new SecureVault(config.dataDir, callerOf(req), callerOf(req));
  const walletOf = (req: Request): MockWalletProvider =>
    new MockWalletProvider(config.dataDir, callerOf(req));

  function vaultStatus(err: unknown): number {
    return isVaultError(err) ? 400 : 500;
  }

  // -- vault ----------------------------------------------------------

  const vaultRouter = express.Router();

  vaultRouter.get('/', (req: Request, res: Response) => {
    try {
      res.json(vaultOf(req).list());
    } catch (err) {
      res
        .status(vaultStatus(err))
        .json(errorBody('Failed to list secrets', err instanceof Error ? err.message : String(err)));
    }
  });

  vaultRouter.post('/', (req: Request, res: Response) => {
    const tp = tierParam((req.body as { tier?: unknown } | undefined)?.tier, res);
    if (!tp.ok) return;
    try {
      const body = (req.body ?? {}) as { name?: unknown; value?: unknown; description?: unknown };
      const meta = vaultOf(req).create(
        body.name,
        body.value,
        typeof body.description === 'string' ? body.description : undefined,
        { tier: tp.tier },
      );
      governance.audit('vault.secret_created', {
        actor: callerOf(req),
        toolName: 'vault',
        detail: { name: meta.name },
      });
      res.status(201).json(meta);
    } catch (err) {
      res
        .status(vaultStatus(err))
        .json(errorBody('Failed to store secret', err instanceof Error ? err.message : String(err)));
    }
  });

  vaultRouter.get('/:name', (req: Request, res: Response) => {
    try {
      const secret = vaultOf(req).get(req.params.name);
      if (!secret) {
        res.status(404).json(errorBody(`unknown secret: ${req.params.name}`));
        return;
      }
      res.json(secret);
    } catch (err) {
      res
        .status(vaultStatus(err))
        .json(errorBody('Failed to read secret', err instanceof Error ? err.message : String(err)));
    }
  });

  vaultRouter.put('/:name', (req: Request, res: Response) => {
    const tp = tierParam((req.body as { tier?: unknown } | undefined)?.tier, res);
    if (!tp.ok) return;
    try {
      const body = (req.body ?? {}) as { value?: unknown; description?: unknown };
      const meta = vaultOf(req).update(
        req.params.name,
        body.value === undefined ? undefined : body.value,
        body.description === undefined
          ? undefined
          : typeof body.description === 'string'
            ? body.description
            : undefined,
        { tier: tp.tier },
      );
      governance.audit('vault.secret_updated', {
        actor: callerOf(req),
        toolName: 'vault',
        detail: { name: meta.name },
      });
      res.json(meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(message.startsWith('unknown secret') ? 404 : vaultStatus(err))
        .json(errorBody('Failed to update secret', message));
    }
  });

  vaultRouter.delete('/:name', (req: Request, res: Response) => {
    try {
      const removed = vaultOf(req).delete(req.params.name);
      if (!removed) {
        res.status(404).json(errorBody(`unknown secret: ${req.params.name}`));
        return;
      }
      governance.audit('vault.secret_deleted', {
        actor: callerOf(req),
        toolName: 'vault',
        detail: { name: req.params.name },
      });
      res.json({ ok: true });
    } catch (err) {
      res
        .status(vaultStatus(err))
        .json(errorBody('Failed to delete secret', err instanceof Error ? err.message : String(err)));
    }
  });

  router.use('/vault', vaultRouter);

  // -- wallet (mock only) ---------------------------------------------

  const walletRouter = express.Router();

  walletRouter.get('/', (req: Request, res: Response) => {
    const wallet = walletOf(req);
    res.json({
      provider: wallet.id,
      mock: true,
      chargesEnabled: wallet.chargesEnabled,
      methods: wallet.listPaymentMethods(),
    });
  });

  walletRouter.get('/methods', (req: Request, res: Response) => {
    res.json(walletOf(req).listPaymentMethods());
  });

  walletRouter.post('/methods', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        cardNumber?: unknown;
        expMonth?: unknown;
        expYear?: unknown;
        holderName?: unknown;
      };
      const method = walletOf(req).addPaymentMethod({
        cardNumber: String(body.cardNumber ?? ''),
        expMonth: Number(body.expMonth),
        expYear: Number(body.expYear),
        holderName: typeof body.holderName === 'string' ? body.holderName : undefined,
      });
      governance.audit('wallet.method_added', {
        actor: callerOf(req),
        toolName: 'wallet',
        detail: { brand: method.brand, last4: method.last4 },
      });
      res.status(201).json(method);
    } catch (err) {
      res
        .status(isWalletError(err) ? 400 : 500)
        .json(errorBody('Failed to add payment method', err instanceof Error ? err.message : String(err)));
    }
  });

  walletRouter.delete('/methods/:id', (req: Request, res: Response) => {
    const removed = walletOf(req).removePaymentMethod(req.params.id);
    if (!removed) {
      res.status(404).json(errorBody(`unknown payment method: ${req.params.id}`));
      return;
    }
    governance.audit('wallet.method_removed', {
      actor: callerOf(req),
      toolName: 'wallet',
      detail: { methodId: req.params.id },
    });
    res.json({ ok: true });
  });

  // The mock never charges: this endpoint exists so a mistaken charge call
  // gets a loud refusal instead of a silent no-op.
  walletRouter.post('/charge', (_req: Request, res: Response) => {
    res.status(400).json(
      errorBody(
        'The mock wallet provider never processes real charges. ' +
          'Connect a real payment provider to charge.',
      ),
    );
  });

  router.use('/wallet', walletRouter);

  // -- connected-accounts summary page API ----------------------------
  // Built on the existing OAuth framework (oauth.ts): statuses never carry
  // tokens, and vault/wallet are counts only — nothing sensitive leaves.

  const accountsRouter = express.Router();

  accountsRouter.get('/summary', (req: Request, res: Response) => {
    try {
      const wallet = walletOf(req);
      res.json({
        oauth: getOAuthStatus(config.dataDir),
        vault: { secretCount: vaultOf(req).list().length },
        wallet: {
          provider: wallet.id,
          mock: true,
          chargesEnabled: wallet.chargesEnabled,
          methodCount: wallet.listPaymentMethods().length,
        },
      });
    } catch (err) {
      res
        .status(500)
        .json(errorBody('Failed to build accounts summary', err instanceof Error ? err.message : String(err)));
    }
  });

  router.use('/accounts', accountsRouter);
}
