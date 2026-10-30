// SPDX-License-Identifier: Apache-2.0
// BR-11 — One-checkout-per-window discipline in the browser runner
// (Muse parity audit §4.11).
//
// A browser window must never run two checkouts at once: parallel
// checkouts in one window are how duplicate orders, crossed carts and
// double charges happen. This guard is the discipline:
//
//   - A checkout takes a LEASE on its window (windowId — the runner's
//     id for one browser window/tab group within a profile) before it
//     navigates to a checkout page, and holds it until the checkout
//     completes, is abandoned, or the lease expires.
//   - acquire() while another lease is live REFUSES with the holder's
//     identity — no queueing, no silent preemption: the second
//     checkout fails loudly and the caller decides what to do.
//   - Leases expire (default 10 min, heartbeat-renewable) so a crashed
//     checkout cannot lock a window forever; expiry is audited.
//   - runExclusive() is the runner-shaped wrapper: acquire → run →
//     release in a finally, whatever the checkout does.
//
// This composes with purchases.ts rather than replacing it: the
// purchase flow keeps its own approval + stop-before-pay rules; the
// lease key can carry the purchase intent id so the two records line
// up. The guard itself moves no money and clicks nothing.
//
// In-memory, like the hold registry: leases are runtime discipline,
// not records. Lease history is kept briefly for debugging.

import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';

export interface CheckoutLease {
  id: string;
  /** Runner's window identifier (one browser window / tab group). */
  windowId: string;
  profileId: string;
  /** Purchase intent / checkout identifier from purchases.ts, when any. */
  checkoutId?: string;
  merchant?: string;
  acquiredBy: string;
  acquiredAt: number;
  expiresAt: number;
  releasedAt?: number;
  releaseReason?: 'completed' | 'abandoned' | 'expired' | 'forced';
}

export class CheckoutBusyError extends Error {
  readonly lease: CheckoutLease;
  constructor(lease: CheckoutLease) {
    super(
      `window "${lease.windowId}" is already running a checkout` +
        (lease.merchant ? ` (${lease.merchant})` : '') +
        (lease.checkoutId ? ` [${lease.checkoutId}]` : '') +
        ` since ${new Date(lease.acquiredAt).toISOString()} — one checkout per window; finish or abandon it first`,
    );
    this.name = 'CheckoutBusyError';
    this.lease = lease;
  }
}

export const DEFAULT_CHECKOUT_LEASE_TTL_MS = 10 * 60 * 1000;
const MAX_HISTORY = 100;

export class CheckoutWindowGuard {
  private readonly nowFn: () => number;
  private readonly audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  private readonly leases = new Map<string, CheckoutLease>(); // by windowId (live only)
  private readonly byId = new Map<string, CheckoutLease>();
  private readonly history: CheckoutLease[] = [];

  constructor(deps: {
    now?: () => number;
    audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  } = {}) {
    this.nowFn = deps.now ?? (() => Date.now());
    this.audit = deps.audit;
  }

  /** Expire stale leases. Returns the leases that expired. */
  sweepExpired(): CheckoutLease[] {
    const now = this.nowFn();
    const expired: CheckoutLease[] = [];
    for (const lease of [...this.leases.values()]) {
      if (now >= lease.expiresAt) {
        this.finish(lease, 'expired');
        expired.push(lease);
        this.audit?.('browser.checkout_lease_expired', {
          detail: { leaseId: lease.id, windowId: lease.windowId, checkoutId: lease.checkoutId },
        });
      }
    }
    return expired;
  }

  private finish(lease: CheckoutLease, reason: NonNullable<CheckoutLease['releaseReason']>): void {
    lease.releasedAt = this.nowFn();
    lease.releaseReason = reason;
    this.leases.delete(lease.windowId);
    this.history.unshift(lease);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
  }

  /**
   * Take the window's checkout lease. Throws CheckoutBusyError when a
   * different checkout already holds it. Re-acquiring with the SAME
   * checkoutId is an idempotent heartbeat-style refresh.
   */
  acquire(input: {
    windowId: string;
    profileId: string;
    checkoutId?: string;
    merchant?: string;
    acquiredBy?: string;
    ttlMs?: number;
  }): CheckoutLease {
    if (!input.windowId) throw new Error('windowId is required');
    if (!input.profileId) throw new Error('profileId is required');
    this.sweepExpired();
    const existing = this.leases.get(input.windowId);
    if (existing) {
      if (input.checkoutId && existing.checkoutId === input.checkoutId) {
        existing.expiresAt = this.nowFn() + (input.ttlMs ?? DEFAULT_CHECKOUT_LEASE_TTL_MS);
        return existing;
      }
      throw new CheckoutBusyError(existing);
    }
    const now = this.nowFn();
    const lease: CheckoutLease = {
      id: randomUUID(),
      windowId: input.windowId,
      profileId: input.profileId,
      checkoutId: input.checkoutId,
      merchant: input.merchant,
      acquiredBy: (input.acquiredBy ?? '').slice(0, 100),
      acquiredAt: now,
      expiresAt: now + (input.ttlMs ?? DEFAULT_CHECKOUT_LEASE_TTL_MS),
    };
    this.leases.set(lease.windowId, lease);
    this.byId.set(lease.id, lease);
    this.audit?.('browser.checkout_lease_acquired', {
      actor: lease.acquiredBy || undefined,
      detail: { leaseId: lease.id, windowId: lease.windowId, profileId: lease.profileId, checkoutId: lease.checkoutId, merchant: lease.merchant },
    });
    return lease;
  }

  /** Renew a live lease (long checkouts heartbeat instead of expiring). */
  heartbeat(leaseId: string, ttlMs = DEFAULT_CHECKOUT_LEASE_TTL_MS): CheckoutLease {
    const lease = this.mustLive(leaseId);
    lease.expiresAt = this.nowFn() + ttlMs;
    return lease;
  }

  release(leaseId: string, reason: 'completed' | 'abandoned' | 'forced' = 'completed'): CheckoutLease {
    const lease = this.mustLive(leaseId);
    this.finish(lease, reason);
    this.audit?.('browser.checkout_lease_released', {
      detail: { leaseId: lease.id, windowId: lease.windowId, checkoutId: lease.checkoutId, reason },
    });
    return lease;
  }

  /** The live lease on a window, if any (the gate's peek — no acquire). */
  activeFor(windowId: string): CheckoutLease | undefined {
    this.sweepExpired();
    return this.leases.get(windowId);
  }

  listLive(): CheckoutLease[] {
    this.sweepExpired();
    return [...this.leases.values()];
  }

  listHistory(limit = 50): CheckoutLease[] {
    return this.history.slice(0, limit);
  }

  private mustLive(leaseId: string): CheckoutLease {
    this.sweepExpired();
    const lease = this.byId.get(leaseId);
    if (!lease || lease.releasedAt) throw new Error(`no live checkout lease: ${leaseId}`);
    return lease;
  }

  /**
   * The runner discipline: hold the window's lease for exactly the
   * duration of `fn`. Release reason is 'completed' when fn resolves,
   * 'abandoned' when it throws (the error still propagates).
   */
  async runExclusive<T>(
    input: { windowId: string; profileId: string; checkoutId?: string; merchant?: string; acquiredBy?: string; ttlMs?: number },
    fn: (lease: CheckoutLease) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquire(input);
    try {
      const out = await fn(lease);
      this.release(lease.id, 'completed');
      return out;
    } catch (err) {
      try {
        this.release(lease.id, 'abandoned');
      } catch {
        // Lease already expired/released — the original error wins.
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Routes — mount under /api/browser (paths are /checkout-leases…)
// ---------------------------------------------------------------------------

export function registerBrowserCheckoutRoutes(router: Router, deps: { guard: CheckoutWindowGuard }): void {
  const { guard } = deps;

  router.get('/checkout-leases', (_req, res) => {
    res.json({ ok: true, live: guard.listLive(), history: guard.listHistory(20) });
  });

  router.post('/checkout-leases', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const lease = guard.acquire({
        windowId: typeof body.windowId === 'string' ? body.windowId : '',
        profileId: typeof body.profileId === 'string' ? body.profileId : '',
        checkoutId: typeof body.checkoutId === 'string' ? body.checkoutId : undefined,
        merchant: typeof body.merchant === 'string' ? body.merchant : undefined,
        acquiredBy: typeof body.acquiredBy === 'string' ? body.acquiredBy : undefined,
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
      });
      res.status(201).json({ ok: true, lease });
    } catch (err) {
      res.status(err instanceof CheckoutBusyError ? 409 : 400).json({
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof CheckoutBusyError ? { holder: err.lease } : {}),
      });
    }
  });

  router.post('/checkout-leases/:id/heartbeat', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json({ ok: true, lease: guard.heartbeat(req.params.id, typeof body.ttlMs === 'number' ? body.ttlMs : undefined) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/checkout-leases/:id/release', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const reason = body.reason === 'abandoned' || body.reason === 'forced' ? body.reason : 'completed';
      res.json({ ok: true, lease: guard.release(req.params.id, reason) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function createBrowserCheckoutRouter(deps: { guard: CheckoutWindowGuard }): Router {
  const router = express.Router();
  registerBrowserCheckoutRoutes(router, deps);
  return router;
}
