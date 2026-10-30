// SPDX-License-Identifier: Apache-2.0
// Settings → Cloud sync & website: status display, manual sync target,
// link-token minting (shown once), and the website link form.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudSyncPanel } from './cloud-sync-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  linked: false,
}));

vi.mock('../../lib/octomind-api', () => ({
  cloudStatus: async () => {
    throw new Error('cloud layer absent');
  },
}));

vi.mock('../../lib/kriyadot-api', () => {
  const jr = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
    }) as Response;
  return {
    kriyadotFetch: async (path: string, init?: RequestInit) => {
      hoisted.calls.push({ path, method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (path === '/api/sync/status') {
        return jr({
          configured: true,
          instanceUrl: 'https://studio.example.com',
          lastPushAt: '2026-10-30T10:00:00.000Z',
          pendingOutbox: 2,
        });
      }
      if (path === '/api/frontdoor/status') {
        return jr(
          hoisted.linked
            ? { linked: true, frontdoorUrl: 'https://kriyadot.example.com', accountId: 'acct-1', workspaceId: 'ws-1' }
            : { linked: false },
        );
      }
      if (path === '/api/sync/target') return jr({ ok: true });
      if (path === '/api/sync/link-token') return jr({ token: 'tok-shown-once-123' });
      if (path === '/api/frontdoor/link') {
        hoisted.linked = true;
        return jr({ linked: true, frontdoorUrl: 'https://kriyadot.example.com', accountId: 'acct-1', workspaceId: 'ws-1' });
      }
      return jr({ error: 'unexpected' }, 404);
    },
  };
});

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.linked = false;
});

describe('CloudSyncPanel', () => {
  it('shows sync status: instance URL, last push, pending outbox', async () => {
    render(<CloudSyncPanel />);
    expect(await screen.findByText('https://studio.example.com')).toBeInTheDocument();
    expect(screen.getByText(/Pending outbox: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Last push:/)).toBeInTheDocument();
  });

  it('saves a manual sync target (instance URL + link token)', async () => {
    render(<CloudSyncPanel />);
    const url = await screen.findByLabelText('Instance URL');
    fireEvent.change(url, { target: { value: 'https://my-instance.example.com' } });
    fireEvent.change(screen.getByLabelText('Link token'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sync target' }));
    await waitFor(() =>
      expect(hoisted.calls.some((c) => c.path === '/api/sync/target' && c.method === 'POST')).toBe(true),
    );
    const call = hoisted.calls.find((c) => c.path === '/api/sync/target');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      instanceUrl: 'https://my-instance.example.com',
      linkToken: 'secret-token',
    });
    expect(await screen.findByText(/Sync target saved/)).toBeInTheDocument();
  });

  it('mints a link token and shows it once', async () => {
    render(<CloudSyncPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mint link token' }));
    expect(await screen.findByText('tok-shown-once-123')).toBeInTheDocument();
    expect(screen.getByText(/Link token \(shown once\):/)).toBeInTheDocument();
  });

  it('links this instance to the website account with frontdoor URL + code + instance URL', async () => {
    render(<CloudSyncPanel />);
    fireEvent.change(await screen.findByLabelText(/Website \(front door\) URL/), {
      target: { value: 'https://kriyadot.example.com' },
    });
    fireEvent.change(screen.getByLabelText(/Link code from the website/), { target: { value: 'CODE42' } });
    fireEvent.change(screen.getByLabelText(/This instance's public URL/), {
      target: { value: 'https://studio.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link this instance' }));
    await waitFor(() =>
      expect(hoisted.calls.some((c) => c.path === '/api/frontdoor/link' && c.method === 'POST')).toBe(true),
    );
    const call = hoisted.calls.find((c) => c.path === '/api/frontdoor/link');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      frontdoorUrl: 'https://kriyadot.example.com',
      code: 'CODE42',
      instanceUrl: 'https://studio.example.com',
    });
    expect(await screen.findByText(/Linked to/)).toBeInTheDocument();
    expect(screen.getByText('acct-1')).toBeInTheDocument();
  });
});
