// SPDX-License-Identifier: Apache-2.0
// Brokered identities panel: honest-protection copy (value, not usage),
// connect flow (token goes to the API helper, never rendered back),
// standing grants list with scope + revoke, grant creation with scope.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BrokerIdentitiesPanel from './broker-identities-panel';

afterEach(() => cleanup());

const state = vi.hoisted(() => ({
  connected: false,
  grants: [] as Array<Record<string, unknown>>,
  connectCalls: [] as string[],
  addCalls: [] as Array<Record<string, unknown>>,
  revokeCalls: [] as string[],
}));

vi.mock('../../lib/api', () => ({
  getBrokerIdentities: async () => [
    { identity: 'github', host: 'api.github.com', connected: state.connected },
  ],
  getBrokerGrants: async () => state.grants,
  getBots: async () => [
    { id: 'scout', name: 'Scout' },
    { id: 'coder', name: 'Coder' },
  ],
  connectBrokerGitHub: async (token: string) => {
    state.connectCalls.push(token);
    state.connected = true;
  },
  disconnectBrokerGitHub: async () => {
    state.connected = false;
  },
  addBrokerGrant: async (body: Record<string, unknown>) => {
    state.addCalls.push(body);
    const grant = {
      id: `g${state.grants.length + 1}`,
      identity: 'github',
      actionClass: body.actionClass as string,
      scope: (body.scope as string) ?? 'all',
      createdAt: Date.now(),
      createdVia: 'settings',
    };
    state.grants = [...state.grants, grant];
    return grant;
  },
  revokeBrokerGrant: async (id: string) => {
    state.revokeCalls.push(id);
    state.grants = state.grants.filter((g) => g.id !== id);
  },
}));

describe('BrokerIdentitiesPanel', () => {
  it('states the honest scope: protects the credential value, not the usage', async () => {
    state.connected = false;
    state.grants = [];
    render(<BrokerIdentitiesPanel />);
    expect(await screen.findByText(/protects the\s+credential/i)).toBeInTheDocument();
    expect(screen.getByText(/not how it is used/i)).toBeInTheDocument();
    expect(screen.getByText(/journal is your control over usage/i)).toBeInTheDocument();
    expect(screen.getByText(/api\.github\.com/)).toBeInTheDocument();
  });

  it('connect flow sends the pasted token to the API and never renders it back', async () => {
    state.connected = false;
    state.connectCalls = [];
    render(<BrokerIdentitiesPanel />);
    const input = await screen.findByLabelText('GitHub personal access token');
    fireEvent.change(input, { target: { value: 'ghp_test_paste_value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await waitFor(() => expect(state.connectCalls).toEqual(['ghp_test_paste_value']));
    expect(await screen.findByText('connected', { selector: 'span.chip' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('ghp_test_paste_value')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('ghp_test_paste_value');
  });

  it('renders standing grants with scope and revokes them', async () => {
    state.connected = true;
    state.grants = [
      {
        id: 'g1',
        identity: 'github',
        actionClass: 'write',
        scope: 'coder',
        createdAt: Date.now(),
        createdVia: 'settings',
      },
    ];
    state.revokeCalls = [];
    render(<BrokerIdentitiesPanel />);
    expect(await screen.findByText('write actions')).toBeInTheDocument();
    expect(screen.getByText('Coder only', { selector: 'span.chip' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(state.revokeCalls).toEqual(['g1']));
  });

  it('creates a standing grant with the chosen scope', async () => {
    state.connected = true;
    state.grants = [];
    state.addCalls = [];
    render(<BrokerIdentitiesPanel />);
    fireEvent.change(await screen.findByLabelText('Standing grant scope'), {
      target: { value: 'scout' },
    });
    fireEvent.click(screen.getByRole('button', { name: /\+ Grant read actions/ }));
    await waitFor(() => expect(state.addCalls).toHaveLength(1));
    expect(state.addCalls[0]).toEqual({ identity: 'github', actionClass: 'read', scope: 'scout' });
  });
});
