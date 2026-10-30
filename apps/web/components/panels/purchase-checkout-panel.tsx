// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Wave 5 — Checkout surface panel (Muse parity audit §4.13):
 * PUR-2 Stripe Link limits/remaining allowances, PUR-6 merchant
 * completion preference + explicit takeover, PUR-7 cancel for a
 * pending purchase.
 *
 * Renders over the purchase-extras API (mounted at /api/billing):
 *   GET  /purchases/:id/checkout   → intent + Link limits + plan
 *   PUT  /purchase-preferences     → save this merchant's preference
 *   POST /purchases/:id/cancel     → cancel a pending intent
 *   POST /purchases/:id/takeover   → hand the open checkout to the user
 *
 * The panel holds NO payment data and no control that could supply
 * any: the preference is an enum, takeover hands the browser to the
 * person, and cancel only appears while the intent is pending.
 * Coordinator mounts this panel in the Usage → Purchases section
 * (see the wave-5 WIRING note).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

export type CheckoutPreferenceChoice =
  | 'no-preference'
  | 'merchant-saved-card'
  | 'user-takeover'
  | 'stripe-link';

export interface CheckoutSurfaceView {
  intent: {
    id: string;
    merchantName: string;
    checkoutUrl: string;
    status: string;
    currency: string;
    totalCents: number;
  };
  stripeLink: {
    enabled: boolean;
    perPurchaseLimitCents: number | null;
    dailyLimitCents: number | null;
    monthlyLimitCents: number | null;
    remainingTodayCents: number | null;
    remainingThisMonthCents: number | null;
    headroomCents: number | null;
    withinLimits: boolean;
    breach: string | null;
    summary: string;
  };
  preference: { preference: CheckoutPreferenceChoice } | null;
  plan: {
    mode: string;
    requiresUserTakeover: boolean;
    takeoverReason: string | null;
    note: string;
  };
}

const PREFERENCE_OPTIONS: Array<{ value: CheckoutPreferenceChoice; label: string }> = [
  { value: 'no-preference', label: 'No preference (platform default)' },
  { value: 'merchant-saved-card', label: 'Pay with the card saved at this merchant (I take over)' },
  { value: 'user-takeover', label: 'I always complete this merchant myself (takeover)' },
  { value: 'stripe-link', label: 'Pay with Stripe Link when available' },
];

function fmtMoney(cents: number | null, currency: string): string {
  return cents === null ? 'No limit set' : `${currency} ${(cents / 100).toFixed(2)}`;
}

/** The PUR-2 limit rows, as [label, value] pairs (pure — unit-tested). */
export function linkLimitRows(surface: CheckoutSurfaceView): Array<[string, string]> {
  const { stripeLink: l, intent } = surface;
  return [
    ['Per-purchase limit', fmtMoney(l.perPurchaseLimitCents, intent.currency)],
    ['Remaining today', fmtMoney(l.remainingTodayCents, intent.currency)],
    ['Remaining this month', fmtMoney(l.remainingThisMonthCents, intent.currency)],
    ['Headroom for a new purchase', fmtMoney(l.headroomCents, intent.currency)],
  ];
}

export function PurchaseCheckoutPanel({
  intentId,
  profileId,
  personId,
}: {
  intentId: string;
  /** Browser profile to hand over on takeover (bot's profile id). */
  profileId?: string;
  personId?: string;
}) {
  const [surface, setSurface] = useState<CheckoutSurfaceView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await authedFetch(`/api/billing/purchases/${encodeURIComponent(intentId)}/checkout`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSurface((await res.json()) as CheckoutSurfaceView);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [intentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await authedFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  if (!surface) {
    return (
      <div className="purchase-checkout-panel">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading checkout…</p>}
      </div>
    );
  }

  const { intent, stripeLink, plan } = surface;
  const preference = surface.preference?.preference ?? 'no-preference';

  return (
    <div className="purchase-checkout-panel">
      {error && <p className="error">{error}</p>}

      <h3>Stripe Link limits</h3>
      {stripeLink.enabled ? (
        <>
          <table className="usage-table">
            <tbody>
              {linkLimitRows(surface).map(([label, value]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{stripeLink.summary}</p>
          {!stripeLink.withinLimits && stripeLink.breach && <p className="error small">{stripeLink.breach}</p>}
        </>
      ) : (
        <p className="muted small">Stripe Link is off — enable it in Purchases settings to see its limits here.</p>
      )}

      <h3>How this purchase completes</h3>
      <p className="small">{plan.note}</p>
      <label>
        Completion preference for {intent.merchantName}:{' '}
        <select
          aria-label="Completion preference"
          value={preference}
          disabled={busy === 'preference'}
          onChange={(e) =>
            void act('preference', async () => {
              const res = await authedFetch('/api/billing/purchase-preferences', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  merchantName: intent.merchantName,
                  checkoutUrl: intent.checkoutUrl,
                  preference: e.target.value,
                }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
            })
          }
        >
          {PREFERENCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        A saved-card preference never shares your card with the bot: you take over the browser and pick the
        merchant-saved card yourself.
      </p>

      <div className="approval-actions">
        {intent.status === 'pending-approval' && (
          <button
            className="btn btn-danger btn-sm"
            disabled={busy === 'cancel'}
            onClick={() =>
              void act('cancel', async () => {
                await post(`/api/billing/purchases/${encodeURIComponent(intentId)}/cancel`, {});
              })
            }
          >
            Cancel this purchase
          </button>
        )}
        {intent.status === 'cancelled' && <span className="chip red">cancelled</span>}
        {intent.status === 'awaiting-user-confirm' && plan.requiresUserTakeover && profileId && personId && (
          <button
            className="btn btn-primary btn-sm"
            disabled={busy === 'takeover'}
            onClick={() =>
              void act('takeover', async () => {
                await post(`/api/billing/purchases/${encodeURIComponent(intentId)}/takeover`, { profileId, personId });
              })
            }
          >
            Take over to pay
          </button>
        )}
      </div>
    </div>
  );
}
