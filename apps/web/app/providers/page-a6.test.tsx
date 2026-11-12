// SPDX-License-Identifier: Apache-2.0
// A6: the bridge card's account list — labels, machine-default /
// your-default / sign-in chips, Add account, per-account sign-in,
// rename, set-default, and remove with explicit config-dir copy.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProviderInfo } from '../../lib/api';

const getProviders = vi.fn(async (): Promise<ProviderInfo[]> => PROVIDERS);
const createBridgeAccount = vi.fn(async () => ({
  ok: true,
  account: { accountId: 'work-login', bridgeId: 'claude', label: 'Work Login', configDir: '/data/bridge-accounts/claude/work-login', machineDefault: false, createdByUs: true, isUserDefault: false, signedIn: false, credentialsPath: '/x' },
}));
const renameBridgeAccount = vi.fn(async () => ({ ok: true, account: {} }));
const setBridgeAccountDefault = vi.fn(async () => ({ ok: true, userDefault: 'work-login' }));
const removeBridgeAccount = vi.fn(async () => ({
  ok: true, removed: 'work-login', configDir: '/data/bridge-accounts/claude/work-login', configDirDeleted: false, configDirNote: 'Removed; dir NOT deleted.',
}));
const startCliLogin = vi.fn(async () => ({ ok: true, loginId: 'l1', url: 'https://example.com/login', accountId: 'play-login' }));

vi.mock('../../lib/api', () => ({
  cancelCliLogin: vi.fn(async () => ({ ok: true })),
  clearBridgeCliPath: vi.fn(async () => ({ ok: true, cliPath: '' })),
  connectBridge: vi.fn(async () => ({ ok: true })),
  createBridgeAccount: (...a: unknown[]) => createBridgeAccount(...(a as [])),
  disconnectBridge: vi.fn(async () => ({ ok: true })),
  getCliAuthStatus: vi.fn(async () => ({ ok: true, clis: [] })),
  getModelsCatalogInfo: vi.fn(async () => null),
  getProviders: (...a: unknown[]) => getProviders(...(a as [])),
  pollCliLogin: vi.fn(async () => ({ ok: true, status: 'waiting' })),
  recheckBridgeAccount: vi.fn(async () => ({ ok: true, accountId: 'default', cleared: false, utilisationPercent: null, resetAt: null, cooldown: null })),
  refreshModelsCatalog: vi.fn(async () => null),
  removeBridgeAccount: (...a: unknown[]) => removeBridgeAccount(...(a as [])),
  removeProviderKey: vi.fn(async () => ({ ok: true })),
  renameBridgeAccount: (...a: unknown[]) => renameBridgeAccount(...(a as [])),
  saveProviderKey: vi.fn(async () => ({ ok: true })),
  setBridgeAccountDefault: (...a: unknown[]) => setBridgeAccountDefault(...(a as [])),
  setBridgeCliPath: vi.fn(async () => ({ ok: true, cliPath: '' })),
  startCliLogin: (...a: unknown[]) => startCliLogin(...(a as [])),
  submitCliLoginCode: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../components/channels/channels-panel', () => ({ ChannelsPanel: () => null }));
vi.mock('../../components/key-suggestion-card', () => ({ KeySuggestionCard: () => null }));

import ProvidersPage from './page';

function bridgeProvider(): ProviderInfo {
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
    bridgeAccounts: [
      {
        accountId: 'default',
        label: 'Machine default',
        machineDefault: true,
        isUserDefault: false,
        configDir: null,
        signedIn: true,
        createdByUs: false,
        usage: { utilisationPercent: null, resetAt: null, source: 'cli-status' },
        cooldown: null,
      },
      {
        accountId: 'work-login',
        label: 'Work Login',
        machineDefault: false,
        isUserDefault: true,
        configDir: '/data/bridge-accounts/claude/work-login',
        signedIn: true,
        createdByUs: true,
        usage: { utilisationPercent: 30, resetAt: null, source: 'cli-status' },
        cooldown: null,
      },
      {
        accountId: 'play-login',
        label: 'Play Login',
        machineDefault: false,
        isUserDefault: false,
        configDir: '/data/bridge-accounts/claude/play-login',
        signedIn: false,
        createdByUs: true,
        usage: { utilisationPercent: null, resetAt: null, source: 'cli-status' },
        cooldown: { family: 'rate_limit', reason: 'limit', until: null },
      },
    ],
  } as ProviderInfo;
}

let PROVIDERS: ProviderInfo[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  PROVIDERS = [bridgeProvider()];
  getProviders.mockImplementation(async () => PROVIDERS);
});

afterEach(() => cleanup());

describe('A6 bridge account list', () => {
  it('renders labels + chips: machine default, your default, per-account sign-in state', async () => {
    render(<ProvidersPage />);
    expect(await screen.findByText('Work Login')).toBeInTheDocument();
    expect(screen.getByText('Play Login')).toBeInTheDocument();
    expect(screen.getByText('machine default')).toBeInTheDocument();
    expect(screen.getByText('your default')).toBeInTheDocument();
    expect(screen.getAllByText('signed in').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('not signed in')).toBeInTheDocument();
    // The machine default account offers no Remove/Rename (unremovable).
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(2);
  });

  it('Add account calls the API with bridge + label', async () => {
    render(<ProvidersPage />);
    const input = await screen.findByLabelText(/Add another Claude Code account/);
    fireEvent.change(input, { target: { value: 'Side Project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => {
      expect(createBridgeAccount).toHaveBeenCalledWith('claude', 'Side Project');
    });
  });

  it('per-account sign-in opens the modal scoped to that account', async () => {
    render(<ProvidersPage />);
    await screen.findByText('Play Login');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to this account' }));
    await waitFor(() => {
      expect(startCliLogin).toHaveBeenCalledWith('claude', 'play-login');
    });
    expect(await screen.findByText(/saved under the “Play Login” account only/)).toBeInTheDocument();
  });

  it('set-default and rename call the API for that account', async () => {
    render(<ProvidersPage />);
    await screen.findByText('Play Login');
    // Buttons: machine-default account first, then Play (Work is already the default).
    fireEvent.click(screen.getAllByRole('button', { name: 'Set as my default' })[1]!);
    await waitFor(() => {
      expect(setBridgeAccountDefault).toHaveBeenCalledWith('claude', 'play-login');
    });
    // Rename the Play account inline.
    const renameButtons = screen.getAllByRole('button', { name: 'Rename' });
    fireEvent.click(renameButtons[1]!);
    const labelInput = await screen.findByLabelText('Account label');
    fireEvent.change(labelInput, { target: { value: 'Play (new)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    await waitFor(() => {
      expect(renameBridgeAccount).toHaveBeenCalledWith('claude', 'play-login', 'Play (new)');
    });
  });

  it('remove shows explicit copy about what happens to the config dir, and only deletes it when opted in', async () => {
    render(<ProvidersPage />);
    await screen.findByText('Work Login');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(await screen.findByText(/directories you supplied\s+yourself are never deleted/)).toBeInTheDocument();
    // Default: keep the dir.
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }));
    await waitFor(() => {
      expect(removeBridgeAccount).toHaveBeenCalledWith('claude', 'work-login', false);
    });
  });
});
