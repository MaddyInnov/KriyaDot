// SPDX-License-Identifier: Apache-2.0
// PlatformMode: mode cards (radio semantics + privacy sentence),
// managed-not-configured disabling, token-configured usage line,
// quota-exceeded banner, mode switching POST, BYOK key form, and
// managed token save / disconnect (which must not touch BYOK).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformMode } from './platform-mode';
import type { ComposioStatus } from '../../lib/connected-apps';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  status: null as ComposioStatus | null,
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
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
      hoisted.calls.push({
        path,
        method: init?.method,
        body: init?.body as string | undefined,
      });
      if (path === '/api/composio/status') return jr(hoisted.status);
      if (path === '/api/composio/mode') {
        const parsed = JSON.parse((init?.body as string) ?? '{}') as { mode: string };
        if (hoisted.status) {
          hoisted.status = { ...hoisted.status, mode: parsed.mode as ComposioStatus['mode'] };
        }
        return jr({ mode: parsed.mode });
      }
      if (path === '/api/composio/managed-token' && init?.method === 'POST') {
        if (hoisted.status) {
          hoisted.status = {
            ...hoisted.status,
            connected: true,
            managed: {
              ...(hoisted.status.managed ?? { serviceConfigured: true, tokenConfigured: false }),
              serviceConfigured: true,
              plan: 'Pro',
              used: 3,
              quota: 100,
              tokenConfigured: true,
            },
          };
        }
        return jr({ ok: true, plan: 'Pro', quota: 100 });
      }
      if (path === '/api/composio/managed-token' && init?.method === 'DELETE') {
        if (hoisted.status?.managed) {
          hoisted.status = {
            ...hoisted.status,
            managed: { ...hoisted.status.managed, tokenConfigured: false },
          };
        }
        return jr({ ok: true });
      }
      if (path === '/api/composio/connect') return jr({ ok: true });
      return jr({ ok: true });
    },
    getApiBase: () => '',
  };
});

function byokStatus(partial: Partial<ComposioStatus> = {}): ComposioStatus {
  return {
    connected: false,
    mode: 'byok',
    managed: { serviceConfigured: true, tokenConfigured: false },
    ...partial,
  };
}

function managedStatus(partial: Partial<ComposioStatus> = {}): ComposioStatus {
  return {
    connected: true,
    mode: 'managed',
    managed: {
      serviceConfigured: true,
      tokenConfigured: true,
      plan: 'Pro',
      used: 12,
      quota: 100,
    },
    ...partial,
  };
}

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.status = byokStatus();
});

describe('PlatformMode', () => {
  it('mode cards render with radio semantics, active marking, separation note and the privacy sentence', () => {
    render(<PlatformMode status={byokStatus()} />);
    expect(screen.getByRole('radiogroup', { name: /app platform mode/i })).toBeInTheDocument();
    const managedCard = screen.getByTestId('platform-mode-managed');
    const byokCard = screen.getByTestId('platform-mode-byok');
    expect(managedCard).toHaveAttribute('role', 'radio');
    expect(byokCard).toHaveAttribute('role', 'radio');
    expect(byokCard).toHaveAttribute('aria-checked', 'true');
    expect(managedCard).toHaveAttribute('aria-checked', 'false');
    expect(within(byokCard).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/KriyaDot Managed — included with your plan/)).toBeInTheDocument();
    expect(screen.getByText(/Use my own Composio key/)).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Connect apps with a normal sign-in — no Composio account or API key of your own needed\. Usage counts against your plan's managed allowance\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'In Managed mode, app actions pass through a KriyaDot-operated service. Your app sign-ins stay with the providers; the service keeps only usage counts.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your connections in one mode don't carry over to the other — each mode has its own connected accounts.",
      ),
    ).toBeInTheDocument();
  });

  it('managed-not-configured disables the managed choice with its note', () => {
    const status = byokStatus({
      managed: { serviceConfigured: false, tokenConfigured: false },
    });
    render(<PlatformMode status={status} />);
    const managedCard = screen.getByTestId('platform-mode-managed');
    expect(managedCard).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(managedCard).getByText("Managed apps aren't switched on for this instance yet."),
    ).toBeInTheDocument();
    // Clicking the disabled card must not post a mode switch.
    fireEvent.click(managedCard);
    expect(hoisted.calls.some((c) => c.path === '/api/composio/mode')).toBe(false);
  });

  it('configured + no token shows the managed token paste field with its label', () => {
    render(
      <PlatformMode
        status={byokStatus({
          managed: { serviceConfigured: true, tokenConfigured: false },
        })}
      />,
    );
    expect(
      screen.getByLabelText('Managed access token — from your KriyaDot account'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });

  it('token-configured managed state shows Managed is on, plan and the usage line', () => {
    render(<PlatformMode status={managedStatus()} />);
    const managedCard = screen.getByTestId('platform-mode-managed');
    expect(within(managedCard).getByText('Managed is on')).toBeInTheDocument();
    expect(within(managedCard).getByText(/Plan: Pro/)).toBeInTheDocument();
    expect(
      within(managedCard).getByText('12 of 100 managed actions used this month'),
    ).toBeInTheDocument();
    expect(within(managedCard).getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('quota-exceeded banner renders when quotaExceeded is set', () => {
    render(
      <PlatformMode
        status={managedStatus({
          managed: {
            serviceConfigured: true,
            tokenConfigured: true,
            plan: 'Pro',
            used: 100,
            quota: 100,
            quotaExceeded: true,
          },
        })}
      />,
    );
    const banner = screen.getByTestId('managed-quota-banner');
    expect(banner).toHaveTextContent(
      'Your managed allowance is used up for this month — upgrade your plan or switch to your own Composio key.',
    );
  });

  it('quota-exceeded banner also renders from used >= quota without the flag', () => {
    render(
      <PlatformMode
        status={managedStatus({
          managed: {
            serviceConfigured: true,
            tokenConfigured: true,
            used: 50,
            quota: 50,
          },
        })}
      />,
    );
    expect(screen.getByTestId('managed-quota-banner')).toBeInTheDocument();
  });

  it('switching mode posts to /api/composio/mode and refetches status', async () => {
    hoisted.status = byokStatus();
    const onStatusChange = vi.fn();
    render(<PlatformMode status={hoisted.status} onStatusChange={onStatusChange} />);
    fireEvent.click(screen.getByTestId('platform-mode-managed'));
    await waitFor(() =>
      expect(
        hoisted.calls.some((c) => c.path === '/api/composio/mode' && c.method === 'POST'),
      ).toBe(true),
    );
    const modeCall = hoisted.calls.find((c) => c.path === '/api/composio/mode');
    expect(JSON.parse(modeCall?.body ?? '{}')).toEqual({ mode: 'managed' });
    await waitFor(() =>
      expect(hoisted.calls.some((c) => c.path === '/api/composio/status')).toBe(true),
    );
    await waitFor(() => expect(onStatusChange).toHaveBeenCalled());
  });

  it('BYOK panel still renders its key form in byok mode', () => {
    render(<PlatformMode status={byokStatus()} />);
    const byokCard = screen.getByTestId('platform-mode-byok');
    expect(within(byokCard).getByText(/Composio is not connected/)).toBeInTheDocument();
    expect(within(byokCard).getByLabelText('Composio API key')).toBeInTheDocument();
    expect(
      within(byokCard).getByPlaceholderText('paste Composio API key (ak_…)'),
    ).toBeInTheDocument();
    expect(within(byokCard).getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
  });

  it('BYOK connected state shows disconnect in byok mode', () => {
    render(<PlatformMode status={byokStatus({ connected: true })} />);
    const byokCard = screen.getByTestId('platform-mode-byok');
    expect(within(byokCard).getByText('connected')).toBeInTheDocument();
    expect(within(byokCard).getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('saving a managed token posts to /api/composio/managed-token', async () => {
    hoisted.status = managedStatus({
      connected: false,
      managed: { serviceConfigured: true, tokenConfigured: false },
    });
    render(<PlatformMode status={hoisted.status} />);
    fireEvent.change(
      screen.getByLabelText('Managed access token — from your KriyaDot account'),
      { target: { value: 'tok_123' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(
        hoisted.calls.some(
          (c) => c.path === '/api/composio/managed-token' && c.method === 'POST',
        ),
      ).toBe(true),
    );
    const call = hoisted.calls.find((c) => c.path === '/api/composio/managed-token');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ token: 'tok_123' });
  });

  it('managed Disconnect deletes only the managed token, not BYOK', async () => {
    hoisted.status = managedStatus();
    render(<PlatformMode status={hoisted.status} />);
    const managedCard = screen.getByTestId('platform-mode-managed');
    fireEvent.click(within(managedCard).getByRole('button', { name: /disconnect/i }));
    await waitFor(() =>
      expect(
        hoisted.calls.some(
          (c) => c.path === '/api/composio/managed-token' && c.method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(
      hoisted.calls.some((c) => c.path === '/api/composio/connect' && c.method === 'DELETE'),
    ).toBe(false);
  });
});
