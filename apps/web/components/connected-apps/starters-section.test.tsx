// SPDX-License-Identifier: Apache-2.0
// StartersSection: eyebrow trigger label above the title (never sharing
// a row with it), one Create action per card, and client-side category
// filtering (API category + slug fallback) that a highlight resets.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StartersSection } from './starters-section';
import type { StarterRecipe, WebBot } from '../../lib/connected-apps';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  starters: [] as unknown[],
  calls: [] as Array<{ path: string; method?: string }>,
}));

vi.mock('../../lib/api', () => {
  const jr = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => body,
    }) as Response;
  return {
    authedFetch: async (path: string, init?: RequestInit) => {
      hoisted.calls.push({ path, method: init?.method });
      if (path.startsWith('/api/automation-starters') && init?.method === 'POST') {
        return jr({ ok: true, routineId: 'r1', name: 'Created routine', enabled: false });
      }
      if (path.startsWith('/api/automation-starters')) return jr({ starters: hoisted.starters });
      return jr({ ok: true });
    },
    getApiBase: () => '',
  };
});

function recipe(partial: Partial<StarterRecipe> & { id: string; name: string }): StarterRecipe {
  return {
    description: 'A ready-made routine',
    requiredApps: [],
    triggerKind: 'manual',
    ready: true,
    missing: [],
    ...partial,
  };
}

const bots: WebBot[] = [{ id: 'bot1', name: 'Alpha' }];

const gmailNote = recipe({
  id: 'gmail-note',
  name: 'Important Gmail → workspace note',
  triggerKind: 'event',
  requiredApps: ['gmail'],
});
const canvaPost = recipe({
  id: 'canva-post',
  name: 'Canva design → scheduled Instagram post with a long title that wraps',
  triggerKind: 'schedule',
  requiredApps: ['canva', 'instagram'],
});
const stripeReport = recipe({
  id: 'stripe-report',
  name: 'Weekly Stripe revenue report',
  triggerKind: 'schedule',
  requiredApps: ['stripe'],
  category: 'business',
});

beforeEach(() => {
  hoisted.starters = [gmailNote, canvaPost, stripeReport];
  hoisted.calls.length = 0;
});

describe('StartersSection', () => {
  it('renders the trigger label as an eyebrow above the title, not sharing its row', async () => {
    render(<StartersSection bots={bots} />);
    const card = await screen.findByTestId('starter-gmail-note');
    const eyebrow = card.querySelector('.ca-starter-eyebrow');
    expect(eyebrow).not.toBeNull();
    expect(eyebrow).toHaveTextContent('Runs when…');
    const title = card.querySelector('.ca-starter-title');
    expect(title).not.toBeNull();
    expect(title).toHaveTextContent('Important Gmail → workspace note');
    // The title never shares a .row-between with the trigger chip.
    expect(card.querySelector('.row-between')).toBeNull();
    // Eyebrow comes before the title in document order.
    expect(
      (eyebrow as HTMLElement).compareDocumentPosition(title as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the schedule eyebrow and one Create button per card', async () => {
    render(<StartersSection bots={bots} />);
    const card = await screen.findByTestId('starter-canva-post');
    expect(card.querySelector('.ca-starter-eyebrow')).toHaveTextContent('On a schedule');
    expect(screen.getAllByRole('button', { name: 'Create (disabled)' })).toHaveLength(3);
  });

  it('category chips filter cards client-side, using the slug fallback', async () => {
    render(<StartersSection bots={bots} />);
    expect(await screen.findByTestId('starter-gmail-note')).toBeInTheDocument();
    // gmail-note has no API category — the slug fallback puts it in Communication.
    fireEvent.click(screen.getByRole('button', { name: 'Content & social' }));
    await waitFor(() => expect(screen.queryByTestId('starter-gmail-note')).not.toBeInTheDocument());
    expect(screen.getByTestId('starter-canva-post')).toBeInTheDocument();
    expect(screen.queryByTestId('starter-stripe-report')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Business' }));
    await waitFor(() => expect(screen.queryByTestId('starter-canva-post')).not.toBeInTheDocument());
    expect(screen.getByTestId('starter-stripe-report')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(screen.getByTestId('starter-gmail-note')).toBeInTheDocument());
  });

  it('highlightApp filters to that app and resets the category filter to All', async () => {
    const { rerender } = render(<StartersSection bots={bots} />);
    expect(await screen.findByTestId('starter-gmail-note')).toBeInTheDocument();
    // Hide the Gmail recipe behind the Business category first.
    fireEvent.click(screen.getByRole('button', { name: 'Business' }));
    await waitFor(() => expect(screen.queryByTestId('starter-gmail-note')).not.toBeInTheDocument());
    // A highlight for gmail must bring it back (category reset to All).
    rerender(<StartersSection bots={bots} highlightApp="gmail" />);
    await waitFor(() => expect(screen.getByTestId('starter-gmail-note')).toBeInTheDocument());
    expect(screen.queryByTestId('starter-stripe-report')).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Filter automations by category' });
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('dependency chips render per required app with ready state', async () => {
    render(<StartersSection bots={bots} />);
    const card = await screen.findByTestId('starter-canva-post');
    expect(within(card).getByText('canva — ready')).toBeInTheDocument();
    expect(within(card).getByText('instagram — ready')).toBeInTheDocument();
  });
});
