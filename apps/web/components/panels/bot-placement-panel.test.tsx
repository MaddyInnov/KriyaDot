// SPDX-License-Identifier: Apache-2.0
// Bot placement selector: rendering, disabled cloud options without sync,
// the local-only toggle, and the documented 409 conflict handling.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotPlacementPanel } from './bot-placement-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  syncConfigured: true,
  putResponder: null as null | ((body: Record<string, unknown>) => { status: number; body: unknown }),
  record: { botId: 'coder', placement: 'local', localOnly: false } as {
    botId: string;
    placement: string;
    localOnly: boolean;
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
      if (path === '/api/placement') {
        return jr({
          role: 'local',
          syncConfigured: hoisted.syncConfigured,
          bots: [{ ...hoisted.record }],
        });
      }
      if (path.startsWith('/api/placement/bots/')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        if (hoisted.putResponder) {
          const r = hoisted.putResponder(body);
          return jr(r.body, r.status);
        }
        hoisted.record = { ...hoisted.record, ...body } as typeof hoisted.record;
        return jr({ ...hoisted.record });
      }
      return jr({ error: 'unexpected' }, 404);
    },
  };
});

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.syncConfigured = true;
  hoisted.putResponder = null;
  hoisted.record = { botId: 'coder', placement: 'local', localOnly: false };
});

describe('BotPlacementPanel', () => {
  it('renders the three placement options with plain-language consequences + the local-only toggle', async () => {
    render(<BotPlacementPanel botId="coder" botName="Coder" />);
    expect(await screen.findByText('This device (fully local)')).toBeInTheDocument();
    expect(screen.getByText('Cloud, report back')).toBeInTheDocument();
    expect(screen.getByText('Cloud only')).toBeInTheDocument();
    expect(screen.getByText(/Keeps working while this app is closed/)).toBeInTheDocument();
    expect(screen.getByText(/Lives on your cloud instance; this app is a viewer/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Local-only \(never sync this bot's history\)/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /This device/ })).toBeChecked();
  });

  it('disables cloud options when sync is not configured', async () => {
    hoisted.syncConfigured = false;
    render(<BotPlacementPanel botId="coder" botName="Coder" />);
    expect(await screen.findByText('This device (fully local)')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Cloud, report back/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Cloud only/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /This device/ })).not.toBeDisabled();
    expect(screen.getAllByText(/Connect your cloud first/).length).toBeGreaterThan(0);
  });

  it('saves a placement change via PUT and reflects the updated record', async () => {
    render(<BotPlacementPanel botId="coder" botName="Coder" />);
    const cloudOnly = await screen.findByRole('radio', { name: /Cloud only/ });
    fireEvent.click(cloudOnly);
    await waitFor(() => expect(cloudOnly).toBeChecked());
    const put = hoisted.calls.find((c) => c.path === '/api/placement/bots/coder');
    expect(put?.method).toBe('PUT');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ placement: 'cloud-only' });
  });

  it('saves the local-only privacy toggle independently', async () => {
    render(<BotPlacementPanel botId="coder" botName="Coder" />);
    const toggle = await screen.findByLabelText(/Local-only \(never sync this bot's history\)/);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    const put = hoisted.calls.find((c) => c.path === '/api/placement/bots/coder');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ localOnly: true });
  });

  it('409 run-in-flight shows the stop-or-wait message and keeps the old placement', async () => {
    hoisted.putResponder = () => ({ status: 409, body: { error: 'run-in-flight', message: 'a run is active' } });
    render(<BotPlacementPanel botId="coder" botName="Coder" />);
    const cloud = await screen.findByRole('radio', { name: /Cloud, report back/ });
    fireEvent.click(cloud);
    expect(await screen.findByText('Stop the current run or wait for it to finish')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /This device/ })).toBeChecked();
  });

  it('409 cloud-not-connected prompts to connect cloud first', async () => {
    hoisted.putResponder = () => ({ status: 409, body: { error: 'cloud-not-connected', message: 'no sync target' } });
    render(<BotPlacementPanel botId="coder" botName="Coder" />);
    const cloud = await screen.findByRole('radio', { name: /Cloud only/ });
    fireEvent.click(cloud);
    expect(await screen.findByText(/Connect your cloud first/)).toBeInTheDocument();
  });
});
