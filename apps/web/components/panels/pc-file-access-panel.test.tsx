// SPDX-License-Identifier: Apache-2.0
// PC file access panel: grants list with scope + revoke, quick-pick
// special folders resolved server-side, custom-path grant, scope select.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PcFileAccessPanel from './pc-file-access-panel';

afterEach(() => cleanup());

const state = vi.hoisted(() => ({
  grants: [] as Array<Record<string, unknown>>,
  addCalls: [] as Array<Record<string, unknown>>,
  revokeCalls: [] as string[],
}));

vi.mock('../../lib/api', () => ({
  getPcGrants: async () => state.grants,
  getPcSpecialFolders: async () => [
    { name: 'desktop', path: 'C:\\Users\\ash\\Desktop', exists: true },
    { name: 'documents', path: 'C:\\Users\\ash\\Documents', exists: true },
    { name: 'downloads', path: 'C:\\Users\\ash\\Downloads', exists: false },
    { name: 'home', path: 'C:\\Users\\ash', exists: true },
  ],
  getBots: async () => [
    { id: 'scout', name: 'Scout' },
    { id: 'coder', name: 'Coder' },
  ],
  addPcGrant: async (body: Record<string, unknown>) => {
    state.addCalls.push(body);
    const grant = {
      id: `g${state.grants.length + 1}`,
      path: (body.path as string) ?? 'C:\\Users\\ash\\Desktop',
      scope: (body.scope as string) ?? 'all',
      readOnly: true,
      createdAt: Date.now(),
      createdVia: 'settings',
    };
    state.grants = [...state.grants, grant];
    return grant;
  },
  revokePcGrant: async (id: string) => {
    state.revokeCalls.push(id);
    state.grants = state.grants.filter((g) => g.id !== id);
  },
}));

describe('PcFileAccessPanel', () => {
  it('explains read-only + user-only granting and renders existing grants with scope', async () => {
    state.grants = [
      {
        id: 'g1',
        path: 'C:\\Users\\ash\\Desktop',
        scope: 'scout',
        readOnly: true,
        createdAt: Date.now(),
        createdVia: 'approval',
      },
    ];
    render(<PcFileAccessPanel />);
    expect(await screen.findByText('C:\\Users\\ash\\Desktop')).toBeInTheDocument();
    expect(screen.getByText('Scout only', { selector: 'span.chip' })).toBeInTheDocument();
    expect(screen.getByText('via approval card')).toBeInTheDocument();
    expect(screen.getByText(/read-only/i, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(/a bot can never\s+grant itself access/i)).toBeInTheDocument();
  });

  it('quick-pick grants the server-resolved special folder with the chosen scope', async () => {
    state.grants = [];
    state.addCalls = [];
    render(<PcFileAccessPanel />);
    const desktopBtn = await screen.findByRole('button', { name: /\+ Desktop/ });
    fireEvent.change(screen.getByLabelText('Grant scope'), { target: { value: 'coder' } });
    fireEvent.click(desktopBtn);
    await waitFor(() => expect(state.addCalls).toHaveLength(1));
    expect(state.addCalls[0]).toEqual({ specialFolder: 'desktop', scope: 'coder' });
  });

  it('custom path grant + revoke round-trip', async () => {
    state.grants = [];
    state.revokeCalls = [];
    render(<PcFileAccessPanel />);
    const input = await screen.findByLabelText('Custom folder path');
    fireEvent.change(input, { target: { value: 'D:\\Projects' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant folder' }));
    expect(await screen.findByText('D:\\Projects')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(state.revokeCalls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('D:\\Projects')).not.toBeInTheDocument());
  });

  it('disables quick-pick for a special folder that does not exist on this PC', async () => {
    state.grants = [];
    render(<PcFileAccessPanel />);
    const downloadsBtn = await screen.findByRole('button', { name: /\+ Downloads/ });
    expect(downloadsBtn).toBeDisabled();
  });
});
