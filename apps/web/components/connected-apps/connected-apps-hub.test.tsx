// SPDX-License-Identifier: Apache-2.0
// ConnectedAppsHub (W4): platform setup card, honest per-status actions,
// search/category filtering, connected manage panel, WhatsApp modes.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConnectedAppsHub } from './connected-apps-hub';
import type { ConnectedAppEntry } from '../../lib/connected-apps';

afterEach(() => cleanup());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const hoisted = vi.hoisted(() => ({
  aggregate: null as unknown,
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
      if (path === '/api/connected-apps') return jr(hoisted.aggregate);
      if (path === '/api/bots') return jr([{ id: 'bot1', name: 'Alpha' }, { id: 'bot2', name: 'Beta' }]);
      if (path === '/api/mcp/servers') return jr([]);
      if (path.startsWith('/api/connected-apps/starters')) return jr({ starters: [] });
      if (path === '/api/composio/accounts') return jr({ connected: true, accounts: [] });
      if (path === '/api/composio/connect') return jr({ ok: true });
      return jr({ ok: true });
    },
    getApiBase: () => '',
  };
});

function app(partial: Partial<ConnectedAppEntry> & { id: string; name: string }): ConnectedAppEntry {
  return {
    category: 'productivity',
    source: 'composio',
    connectionType: 'OAuth via Composio',
    status: 'available',
    accounts: [],
    enabledBotIds: [],
    capabilities: [],
    starterTasks: [],
    ...partial,
  };
}

const canvaSetup = app({
  id: 'canva',
  name: 'Canva',
  category: 'design-media',
  featured: true,
  status: 'needs_platform_setup',
  description: 'Design anything',
  capabilities: ['create designs'],
  composioSlug: 'canva',
});
const gmailConnected = app({
  id: 'gmail',
  name: 'Gmail',
  category: 'messaging',
  status: 'connected',
  capabilities: ['read email', 'send email', 'search email', 'label email'],
  accounts: [{ id: 'acc1', label: 'work Gmail', status: 'ACTIVE' }],
  composioSlug: 'gmail',
  starterTasks: [{ label: 'Summarize my inbox', prompt: 'Summarize my Gmail inbox' }],
});

function setAggregate(platformConfigured: boolean, apps: ConnectedAppEntry[]) {
  hoisted.aggregate = { platform: { configured: platformConfigured }, apps, generatedAt: 1 };
  hoisted.calls.length = 0;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/accounts');
});

describe('ConnectedAppsHub', () => {
  it('platform-not-configured renders ONE setup card + featured apps in needs-setup state', async () => {
    setAggregate(false, [canvaSetup, gmailConnected]);
    render(<ConnectedAppsHub />);
    expect(await screen.findByText('Connect the app platform once')).toBeInTheDocument();
    expect(screen.getByText(/one Composio key unlocks/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Composio API key')).toBeInTheDocument();
    const card = await screen.findByTestId('app-card-canva');
    expect(within(card).getByText('Needs platform setup')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /set up platform/i })).toBeInTheDocument();
    // Exactly one setup card, even though the aggregate also has other apps.
    expect(screen.getAllByText('Connect the app platform once')).toHaveLength(1);
  });

  it('connecting the platform posts the key and refetches', async () => {
    setAggregate(false, [canvaSetup]);
    render(<ConnectedAppsHub />);
    fireEvent.change(await screen.findByLabelText('Composio API key'), {
      target: { value: 'ak_test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() =>
      expect(
        hoisted.calls.some((c) => c.path === '/api/composio/connect' && c.method === 'POST'),
      ).toBe(true),
    );
  });

  it('not_in_catalog renders an honest disabled state (no fake connect)', async () => {
    setAggregate(true, [
      app({ id: 'figma', name: 'Figma', category: 'design-media', status: 'not_in_catalog', composioSlug: 'figma' }),
    ]);
    render(<ConnectedAppsHub />);
    expect(screen.queryByText('Connect the app platform once')).not.toBeInTheDocument();
    const card = await screen.findByTestId('app-card-figma');
    const btn = within(card).getByRole('button', { name: /not in your composio workspace/i });
    expect(btn).toBeDisabled();
    expect(within(card).queryByRole('button', { name: /^connect$/i })).not.toBeInTheDocument();
  });

  it('connected card shows the account label and Manage expands accounts + bot toggles', async () => {
    setAggregate(true, [gmailConnected]);
    render(<ConnectedAppsHub />);
    const card = await screen.findByTestId('app-card-gmail');
    expect(within(card).getByText('work Gmail')).toBeInTheDocument();
    expect(within(card).getByText('+1 more')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /manage/i }));
    expect(await within(card).findByText(/bots that may use gmail/i)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    const toggle = within(card).getByLabelText('Enable Gmail for Alpha');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        hoisted.calls.some(
          (c) => c.path === '/api/composio/apps/gmail' && c.method === 'POST',
        ),
      ).toBe(true),
    );
  });

  it('search filters cards by name/capability', async () => {
    setAggregate(true, [canvaSetup, gmailConnected]);
    render(<ConnectedAppsHub />);
    expect(await screen.findByTestId('app-card-canva')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search apps'), { target: { value: 'send email' } });
    await waitFor(() => expect(screen.queryByTestId('app-card-canva')).not.toBeInTheDocument());
    expect(screen.getByTestId('app-card-gmail')).toBeInTheDocument();
  });

  it('category chip filters cards', async () => {
    setAggregate(true, [canvaSetup, gmailConnected]);
    render(<ConnectedAppsHub />);
    expect(await screen.findByTestId('app-card-gmail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Design & Media' }));
    await waitFor(() => expect(screen.queryByTestId('app-card-gmail')).not.toBeInTheDocument());
    expect(screen.getByTestId('app-card-canva')).toBeInTheDocument();
  });

  it('WhatsApp modes render as three distinct rows with the notes text', async () => {
    setAggregate(true, [
      app({
        id: 'whatsapp',
        name: 'WhatsApp',
        category: 'messaging',
        featured: true,
        status: 'available',
        notes: 'Business API is for a registered business number; your personal number works through the messaging channel or the desktop app instead.',
        modes: [
          { id: 'business-api', label: 'Business API', detail: 'Official API for a business number', status: 'available' },
          { id: 'messaging-channel', label: 'Messaging channel', detail: 'Chat through your linked messaging channel', status: 'connected' },
          { id: 'desktop', label: 'Desktop on this computer', detail: 'WhatsApp Desktop app on this machine', status: 'on_this_computer' },
        ],
      }),
    ]);
    render(<ConnectedAppsHub />);
    const card = await screen.findByTestId('app-card-whatsapp');
    expect(within(card).getByTestId('mode-business-api')).toHaveTextContent('Business API');
    expect(within(card).getByTestId('mode-messaging-channel')).toHaveTextContent('Messaging channel');
    expect(within(card).getByTestId('mode-desktop')).toHaveTextContent('Desktop on this computer');
    expect(within(card).getByText(/Business API is for a registered business number/)).toBeInTheDocument();
    // Distinct statuses per mode, never conflated:
    expect(within(card).getByTestId('mode-business-api')).toHaveTextContent('Available');
    expect(within(card).getByTestId('mode-messaging-channel')).toHaveTextContent('Connected');
    expect(within(card).getByTestId('mode-desktop')).toHaveTextContent('On this computer');
  });

  it('local app reports its installed version and offers Open', async () => {
    setAggregate(true, [
      app({
        id: 'blender',
        name: 'Blender',
        category: 'local',
        source: 'local',
        connectionType: 'Installed app',
        status: 'on_this_computer',
        local: { installed: true, version: '4.2.0' },
      }),
    ]);
    render(<ConnectedAppsHub />);
    const card = await screen.findByTestId('app-card-blender');
    expect(within(card).getByText(/Installed v4\.2\.0/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Open Blender' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /run a script/i })).toBeInTheDocument();
  });
});
