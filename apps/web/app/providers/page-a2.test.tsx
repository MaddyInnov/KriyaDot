// SPDX-License-Identifier: Apache-2.0
// A2: the five new manifest bridges appear as bridge cards on the
// Providers page through the SAME data path as the original three —
// the page renders whatever bridge rows the API returns (labels and
// account rows included); nothing about the new bridges is hardcoded
// into a separate UI list.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProviderInfo } from '../../lib/api';

const getProviders = vi.fn(async (): Promise<ProviderInfo[]> => PROVIDERS);

vi.mock('../../lib/api', () => ({
  cancelCliLogin: vi.fn(async () => ({ ok: true })),
  clearBridgeCliPath: vi.fn(async () => ({ ok: true, cliPath: '' })),
  connectBridge: vi.fn(async () => ({ ok: true })),
  createBridgeAccount: vi.fn(async () => ({ ok: true, account: {} })),
  disconnectBridge: vi.fn(async () => ({ ok: true })),
  getCliAuthStatus: vi.fn(async () => ({ ok: true, clis: [] })),
  getModelsCatalogInfo: vi.fn(async () => null),
  getProviders: (...a: unknown[]) => getProviders(...(a as [])),
  pollCliLogin: vi.fn(async () => ({ ok: true, status: 'waiting' })),
  recheckBridgeAccount: vi.fn(async () => ({ ok: true, accountId: 'default', cleared: false, utilisationPercent: null, resetAt: null, cooldown: null })),
  refreshModelsCatalog: vi.fn(async () => null),
  removeBridgeAccount: vi.fn(async () => ({ ok: true, configDirNote: '' })),
  removeProviderKey: vi.fn(async () => ({ ok: true })),
  renameBridgeAccount: vi.fn(async () => ({ ok: true, account: {} })),
  saveProviderKey: vi.fn(async () => ({ ok: true })),
  setBridgeAccountDefault: vi.fn(async () => ({ ok: true, userDefault: 'default' })),
  setBridgeCliPath: vi.fn(async () => ({ ok: true, cliPath: '' })),
  startCliLogin: vi.fn(async () => ({ ok: true, loginId: 'l1', url: 'https://example.com/login' })),
  submitCliLoginCode: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../components/channels/channels-panel', () => ({ ChannelsPanel: () => null }));
vi.mock('../../components/key-suggestion-card', () => ({ KeySuggestionCard: () => null }));

import ProvidersPage from './page';

function bridgeProvider(id: string, name: string, bridge: ProviderInfo['bridge'], model: string): ProviderInfo {
  return {
    id,
    name,
    api: 'openai-compatible',
    configured: false,
    models: [{ id: model, name: model }],
    rateLimit: null,
    bridge,
    detected: true,
    connected: false,
    bridgeAccounts: [
      {
        accountId: 'default',
        label: 'Machine default',
        machineDefault: true,
        isUserDefault: true,
        configDir: null,
        signedIn: false,
        createdByUs: false,
        usage: { utilisationPercent: null, resetAt: null, source: 'no-surface' },
        cooldown: null,
      },
    ],
  } as ProviderInfo;
}

let PROVIDERS: ProviderInfo[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  PROVIDERS = [
    bridgeProvider('grok-subscription', 'Grok subscription (Grok CLI login)', 'grok', 'grok-4.7'),
    bridgeProvider('pi-subscription', 'Pi subscription (Pi coding agent login)', 'pi', 'default'),
    bridgeProvider('hermes-subscription', 'Hermes subscription (Hermes Agent login)', 'hermes', 'hermes-default'),
  ];
  getProviders.mockImplementation(async () => PROVIDERS);
});

afterEach(() => cleanup());

describe('A2 bridge cards from data', () => {
  it('renders a card per new bridge with its label, models and account row', async () => {
    render(<ProvidersPage />);
    expect(await screen.findByText('Grok subscription (Grok CLI login)')).toBeInTheDocument();
    expect(screen.getByText('Pi subscription (Pi coding agent login)')).toBeInTheDocument();
    expect(screen.getByText('Hermes subscription (Hermes Agent login)')).toBeInTheDocument();
    // Per-bridge connect buttons use the per-bridge CLI label.
    expect(screen.getByRole('button', { name: 'Connect Grok CLI login' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Pi login' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Hermes Agent login' })).toBeInTheDocument();
    // Account rows render for each card (machine default × 3), with the
    // honest usage-unknown line (null gauge, never a fabricated 0%).
    expect(screen.getAllByText('machine default')).toHaveLength(3);
    expect(screen.getAllByText(/Usage: usage unknown/)).toHaveLength(3);
    expect(screen.queryByText(/0% used/)).not.toBeInTheDocument();
    // Add-account affordance is present per card, labelled per bridge.
    expect(screen.getByLabelText(/Add another Grok CLI account/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Add another Pi account/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Add another Hermes Agent account/)).toBeInTheDocument();
  });
});
