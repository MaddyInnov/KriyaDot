// SPDX-License-Identifier: Apache-2.0
// A1: bridge account rows in the Providers page — usage gauge or the
// honest "usage unknown", cooldown chip, and the manual Re-check action.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProviderInfo } from '../../lib/api';

const getProviders = vi.fn(async (): Promise<ProviderInfo[]> => PROVIDERS);
const recheckBridgeAccount = vi.fn(async () => ({
  ok: true, accountId: 'default', cleared: true, utilisationPercent: null, resetAt: null, cooldown: null,
}));

vi.mock('../../lib/api', () => ({
  cancelCliLogin: vi.fn(async () => ({ ok: true })),
  clearBridgeCliPath: vi.fn(async () => ({ ok: true, cliPath: '' })),
  connectBridge: vi.fn(async () => ({ ok: true })),
  disconnectBridge: vi.fn(async () => ({ ok: true })),
  getCliAuthStatus: vi.fn(async () => ({ ok: true, clis: [] })),
  getModelsCatalogInfo: vi.fn(async () => null),
  getProviders: (...a: unknown[]) => getProviders(...(a as [])),
  pollCliLogin: vi.fn(async () => ({ ok: true, status: 'waiting' })),
  recheckBridgeAccount: (...a: unknown[]) => recheckBridgeAccount(...(a as [])),
  refreshModelsCatalog: vi.fn(async () => null),
  removeProviderKey: vi.fn(async () => ({ ok: true })),
  saveProviderKey: vi.fn(async () => ({ ok: true })),
  setBridgeCliPath: vi.fn(async () => ({ ok: true, cliPath: '' })),
  startCliLogin: vi.fn(async () => ({ ok: true, loginId: 'l1', url: 'https://example.com' })),
  submitCliLoginCode: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../components/channels/channels-panel', () => ({ ChannelsPanel: () => null }));
vi.mock('../../components/key-suggestion-card', () => ({ KeySuggestionCard: () => null }));

import ProvidersPage from './page';

function bridgeProvider(partial: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: 'claude-subscription',
    name: 'Claude (subscription)',
    api: 'anthropic',
    configured: true,
    models: [{ id: 'sonnet', name: 'Sonnet' }],
    rateLimit: null,
    bridge: 'claude',
    detected: true,
    connected: true,
    ...partial,
  } as ProviderInfo;
}

let PROVIDERS: ProviderInfo[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  getProviders.mockImplementation(async () => PROVIDERS);
});

afterEach(() => cleanup());

describe('A1 bridge account rows', () => {
  it('renders "usage unknown" when the CLI exposes no figure (null, never 0%)', async () => {
    PROVIDERS = [
      bridgeProvider({
        bridgeAccounts: [
          { accountId: 'default', usage: { utilisationPercent: null, resetAt: null, source: 'cli-status' }, cooldown: null },
        ],
      }),
    ];
    render(<ProvidersPage />);
    expect(await screen.findByText(/usage unknown/)).toBeInTheDocument();
    expect(screen.queryByText(/0% used/)).toBeNull();
  });

  it('renders the gauge % and the exhausted chip; Re-check calls the API for that account', async () => {
    PROVIDERS = [
      bridgeProvider({
        bridgeAccounts: [
          {
            accountId: 'default',
            usage: { utilisationPercent: 82, resetAt: null, source: 'cli-status' },
            cooldown: { family: 'exhausted', reason: 'plan/credits exhausted', until: null },
          },
        ],
      }),
    ];
    render(<ProvidersPage />);
    expect(await screen.findByText(/82% used/)).toBeInTheDocument();
    expect(screen.getByText(/exhausted — top up or re-check/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    await waitFor(() => {
      expect(recheckBridgeAccount).toHaveBeenCalledWith('claude', 'default');
    });
  });
});
