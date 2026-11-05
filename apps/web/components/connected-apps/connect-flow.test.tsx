// SPDX-License-Identifier: Apache-2.0
// ConnectFlow (W4): link creation opens the sign-in, polling detects the
// new account, bot checkboxes start NONE checked, and Apply posts toggles
// only for the bots the user actually checked.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectFlow } from './connect-flow';
import type { ConnectedAppEntry } from '../../lib/connected-apps';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

const hoisted = vi.hoisted(() => ({
  accountAppears: false,
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  toggles: [] as Array<{ appId: string; botId: string; enabled: boolean }>,
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
      hoisted.calls.push({ path, method: init?.method, body: init?.body as string | undefined });
      if (path === '/api/composio/accounts/link') {
        return jr({ redirectUrl: 'https://provider.example/auth' });
      }
      if (path === '/api/composio/accounts') {
        return jr({
          connected: true,
          accounts: hoisted.accountAppears
            ? [{ id: 'new1', toolkitSlug: 'canva', status: 'ACTIVE' }]
            : [],
        });
      }
      const toggleMatch = /^\/api\/composio\/apps\/(.+)$/.exec(path);
      if (toggleMatch && init?.method === 'POST') {
        const parsed = JSON.parse((init.body as string) ?? '{}') as { botId: string; enabled: boolean };
        hoisted.toggles.push({ appId: toggleMatch[1], botId: parsed.botId, enabled: parsed.enabled });
        return jr({ ok: true });
      }
      return jr({ ok: true });
    },
    getApiBase: () => '',
  };
});

const canva: ConnectedAppEntry = {
  id: 'canva',
  name: 'Canva',
  category: 'design-media',
  source: 'composio',
  connectionType: 'OAuth via Composio',
  status: 'available',
  accounts: [],
  enabledBotIds: [],
  capabilities: ['create designs'],
  starterTasks: [{ label: 'Make a poster', prompt: 'Make a poster in Canva' }],
  composioSlug: 'canva',
};
const bots = [
  { id: 'bot1', name: 'Alpha' },
  { id: 'bot2', name: 'Beta' },
];

beforeEach(() => {
  hoisted.accountAppears = false;
  hoisted.calls.length = 0;
  hoisted.toggles.length = 0;
  pushMock.mockClear();
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

describe('ConnectFlow', () => {
  it('creates a link with the label, opens sign-in, and polling success reaches bot selection with NONE pre-checked', async () => {
    render(<ConnectFlow app={canva} bots={bots} onDone={() => undefined} onAutomate={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/account label/i), { target: { value: 'work account' } });
    fireEvent.click(screen.getByRole('button', { name: /create connect link/i }));

    await waitFor(() => expect(window.open).toHaveBeenCalledWith('https://provider.example/auth', '_blank', 'noopener'));
    const linkCall = hoisted.calls.find((c) => c.path === '/api/composio/accounts/link');
    expect(JSON.parse(linkCall?.body ?? '{}')).toEqual({ toolkitSlug: 'canva', label: 'work account' });
    expect(await screen.findByText(/waiting for you to finish signing in/i)).toBeInTheDocument();

    // The account appears at Composio; the next poll tick advances the flow.
    hoisted.accountAppears = true;
    expect(await screen.findByText(/choose which bots may use this account/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByLabelText('Allow Alpha to use Canva')).not.toBeChecked();
    expect(screen.getByLabelText('Allow Beta to use Canva')).not.toBeChecked();
    // Nothing was enabled for anyone before an explicit Apply:
    expect(hoisted.toggles).toHaveLength(0);
  });

  it('Apply posts toggles only for checked bots, then offers Try it', async () => {
    hoisted.accountAppears = false;
    render(<ConnectFlow app={canva} bots={bots} onDone={() => undefined} onAutomate={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /create connect link/i }));
    expect(await screen.findByText(/waiting for you to finish signing in/i)).toBeInTheDocument();
    hoisted.accountAppears = true;
    expect(await screen.findByText(/choose which bots/i, {}, { timeout: 5000 })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Allow Beta to use Canva'));
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => expect(hoisted.toggles).toHaveLength(1));
    expect(hoisted.toggles).toEqual([{ appId: 'canva', botId: 'bot2', enabled: true }]);

    expect(await screen.findByText(/all set/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try it/i }));
    expect(sessionStorage.getItem('mvp:chat-prefill')).toBe('Make a poster in Canva');
    expect(pushMock).toHaveBeenCalledWith('/');
  });

  it('Cancel at the first step calls onDone and creates no link', async () => {
    const onDone = vi.fn();
    render(<ConnectFlow app={canva} bots={bots} onDone={onDone} onAutomate={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(hoisted.calls.some((c) => c.path === '/api/composio/accounts/link')).toBe(false);
  });
});
