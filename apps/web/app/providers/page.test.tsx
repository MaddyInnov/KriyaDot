// SPDX-License-Identifier: Apache-2.0
// Providers page API-keys picker (2026-11-09 redesign): 42 full cards
// became a searchable compact list — name + key status only — and
// selecting a provider opens its existing configuration form in a
// dialog. Covers: list rendering + configured-first order, search
// filtering by name/id, select-to-open, and the save flow through the
// dialog.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProviderInfo } from '../../lib/api';

const saveProviderKey = vi.fn(async () => ({ ok: true }));
const getProviders = vi.fn(async (): Promise<ProviderInfo[]> => PROVIDERS);
const getCliAuthStatus = vi.fn(async () => ({ ok: true, clis: [] }));
const getModelsCatalogInfo = vi.fn(async () => null);

vi.mock('../../lib/api', () => ({
  cancelCliLogin: vi.fn(async () => ({ ok: true })),
  connectBridge: vi.fn(async () => ({ ok: true })),
  disconnectBridge: vi.fn(async () => ({ ok: true })),
  getCliAuthStatus: (...a: unknown[]) => getCliAuthStatus(...(a as [])),
  getModelsCatalogInfo: (...a: unknown[]) => getModelsCatalogInfo(...(a as [])),
  getProviders: (...a: unknown[]) => getProviders(...(a as [])),
  pollCliLogin: vi.fn(async () => ({ ok: true, status: 'waiting' })),
  refreshModelsCatalog: vi.fn(async () => null),
  removeProviderKey: vi.fn(async () => ({ ok: true })),
  saveProviderKey: (...a: unknown[]) => saveProviderKey(...(a as [])),
  startCliLogin: vi.fn(async () => ({ ok: true, loginId: 'l1', url: 'https://example.com' })),
  submitCliLoginCode: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../components/channels/channels-panel', () => ({ ChannelsPanel: () => null }));
vi.mock('../../components/key-suggestion-card', () => ({ KeySuggestionCard: () => null }));

import ProvidersPage from './page';

function provider(partial: Partial<ProviderInfo> & { id: string; name: string }): ProviderInfo {
  return {
    api: 'openai-compatible',
    configured: false,
    models: [{ id: 'm-1', name: 'Model 1' }],
    rateLimit: null,
    ...partial,
  } as ProviderInfo;
}

const PROVIDERS: ProviderInfo[] = [
  provider({ id: 'ai21', name: 'AI21 Labs', models: [{ id: 'jamba-large', name: 'Jamba Large' }] }),
  provider({ id: 'groq', name: 'Groq', configured: true, models: [{ id: 'gpt-oss-120b', name: 'GPT-OSS 120B' }] }),
  provider({ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] }),
];

beforeEach(() => {
  vi.clearAllMocks();
  getProviders.mockResolvedValue(PROVIDERS);
});

afterEach(() => cleanup());

describe('API keys picker', () => {
  it('renders a compact list (name + key status), configured first, with NO config fields inline', async () => {
    render(<ProvidersPage />);
    const list = await screen.findByTestId('provider-picker-list');
    expect(list).toHaveTextContent('AI21 Labs');
    expect(list).toHaveTextContent('Groq');
    expect(list).toHaveTextContent('key set');
    expect(list).toHaveTextContent('no key');
    // Configured (Groq) sorts before unconfigured providers.
    const text = list.textContent ?? '';
    expect(text.indexOf('Groq')).toBeLessThan(text.indexOf('AI21 Labs'));
    // No key inputs anywhere until a provider is selected.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText('API key')).toBeNull();
  });

  it('search filters by name and by id', async () => {
    render(<ProvidersPage />);
    await screen.findByTestId('provider-picker-list');
    const search = screen.getByLabelText('Search providers');
    fireEvent.change(search, { target: { value: 'ai21' } });
    expect(screen.getByText('AI21 Labs')).toBeInTheDocument();
    expect(screen.queryByText('Groq')).toBeNull();
    fireEvent.change(search, { target: { value: 'openai' } });
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.queryByText('AI21 Labs')).toBeNull();
    fireEvent.change(search, { target: { value: 'zzz-no-match' } });
    expect(screen.getByText(/No providers match/)).toBeInTheDocument();
  });

  it('selecting a provider opens its config dialog; Save calls saveProviderKey and closes', async () => {
    render(<ProvidersPage />);
    await screen.findByTestId('provider-picker-list');
    fireEvent.click(screen.getByText('AI21 Labs'));
    const dialog = await screen.findByRole('dialog', { name: /Configure AI21 Labs/ });
    expect(dialog).toHaveTextContent('Models: jamba-large');
    const keyInput = screen.getByLabelText('API key');
    fireEvent.change(keyInput, { target: { value: 'ai21-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveProviderKey).toHaveBeenCalledWith(
      'ai21', 'ai21-secret-key', undefined, undefined, undefined,
    ));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
