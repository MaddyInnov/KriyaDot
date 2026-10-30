// SPDX-License-Identifier: Apache-2.0
// Wave 5 checkout panel (PUR-2/6/7): Link limit rows render from the
// checkout surface, the preference select saves the enum for the
// merchant, and Cancel appears only while the intent is pending.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  PurchaseCheckoutPanel,
  linkLimitRows,
  type CheckoutPreferenceChoice,
  type CheckoutSurfaceView,
} from './purchase-checkout-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  status: 'pending-approval' as string,
  preference: 'no-preference' as CheckoutPreferenceChoice,
}));

vi.mock('../../lib/api', () => {
  const jr = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
  return {
    authedFetch: async (path: string, init?: RequestInit) => {
      hoisted.calls.push({ path, method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (path.endsWith('/checkout')) {
        return jr({
          intent: {
            id: 'pur_1',
            merchantName: 'Example Store',
            checkoutUrl: 'https://shop.example.com/checkout/abc',
            status: hoisted.status,
            currency: 'USD',
            totalCents: 4999,
          },
          stripeLink: {
            enabled: true,
            perPurchaseLimitCents: 10000,
            dailyLimitCents: 8000,
            monthlyLimitCents: null,
            remainingTodayCents: 3001,
            remainingThisMonthCents: null,
            headroomCents: 3001,
            withinLimits: true,
            breach: null,
            summary: 'Stripe Link per-purchase limit: USD 100.00 · remaining today: USD 30.01 · remaining this month: no limit set',
          },
          preference: { preference: hoisted.preference },
          plan: {
            mode: 'browser-takeover',
            requiresUserTakeover: true,
            takeoverReason: 'merchant-saved-card',
            note: 'You prefer to pay Example Store with the card saved at the merchant.',
          },
        } satisfies CheckoutSurfaceView);
      }
      if (path.endsWith('/purchase-preferences')) return jr({ ok: true });
      if (path.endsWith('/cancel')) {
        hoisted.status = 'cancelled';
        return jr({ status: 'cancelled' });
      }
      return jr({ error: 'unexpected' }, 404);
    },
  };
});

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.status = 'pending-approval';
  hoisted.preference = 'no-preference';
});

describe('PurchaseCheckoutPanel', () => {
  it('linkLimitRows formats limits + remaining allowances (null = no limit set)', () => {
    const rows = linkLimitRows({
      intent: { id: 'pur_1', merchantName: 'M', checkoutUrl: 'https://x.example/', status: 'pending-approval', currency: 'USD', totalCents: 1 },
      stripeLink: {
        enabled: true,
        perPurchaseLimitCents: 10000,
        dailyLimitCents: 8000,
        monthlyLimitCents: null,
        remainingTodayCents: 3001,
        remainingThisMonthCents: null,
        headroomCents: 3001,
        withinLimits: true,
        breach: null,
        summary: '',
      },
      preference: null,
      plan: { mode: 'stripe-link', requiresUserTakeover: false, takeoverReason: null, note: '' },
    });
    expect(rows).toContainEqual(['Per-purchase limit', 'USD 100.00']);
    expect(rows).toContainEqual(['Remaining today', 'USD 30.01']);
    expect(rows).toContainEqual(['Remaining this month', 'No limit set']);
  });

  it('renders the Link limits, the plan note, and a Cancel button while pending', async () => {
    render(<PurchaseCheckoutPanel intentId="pur_1" />);
    expect(await screen.findByText('Stripe Link limits')).toBeInTheDocument();
    expect(screen.getAllByText('USD 30.01').length).toBeGreaterThanOrEqual(1); // remaining-today + headroom rows
    expect(screen.getByText(/card saved at the merchant/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this purchase' }));
    await waitFor(() => expect(screen.getByText('cancelled')).toBeInTheDocument());
    expect(hoisted.calls.some((c) => c.path.endsWith('/purchases/pur_1/cancel') && c.method === 'POST')).toBe(true);
  });

  it('saving a preference PUTs only the enum + merchant identity (never payment data)', async () => {
    render(<PurchaseCheckoutPanel intentId="pur_1" />);
    const select = await screen.findByLabelText('Completion preference');
    fireEvent.change(select, { target: { value: 'merchant-saved-card' } });
    await waitFor(() =>
      expect(hoisted.calls.some((c) => c.path.endsWith('/purchase-preferences') && c.method === 'PUT')).toBe(true),
    );
    const put = hoisted.calls.find((c) => c.method === 'PUT')!;
    const body = JSON.parse(put.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      merchantName: 'Example Store',
      checkoutUrl: 'https://shop.example.com/checkout/abc',
      preference: 'merchant-saved-card',
    });
    expect(JSON.stringify(body)).not.toMatch(/(?:\d[ -]?){12,18}\d/);
  });

  it('no Cancel button once the intent is no longer pending', async () => {
    hoisted.status = 'awaiting-user-confirm';
    render(<PurchaseCheckoutPanel intentId="pur_1" profileId="prof-1" personId="user-1" />);
    expect(await screen.findByText('Stripe Link limits')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel this purchase' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take over to pay' })).toBeInTheDocument();
  });
});
