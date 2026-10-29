// SPDX-License-Identifier: Apache-2.0
// W12d AutostartPanel: renders the server-reported state and PUTs the
// toggle to /api/autostart.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AutostartPanel } from './autostart-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  enabled: false,
}));

vi.mock('../../lib/kriyadot-api', () => {
  const jr = (body: unknown, ok = true): Response =>
    ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: async () => body }) as Response;
  const status = () => ({
    enabled: hoisted.enabled,
    platform: 'linux',
    entryPath: '/home/u/.config/autostart/kriyadot.desktop',
    execPath: '/opt/kriyadot/KriyaDot',
    stale: false,
    supported: true,
  });
  return {
    kriyadotFetch: async (path: string, init?: RequestInit) => {
      hoisted.calls.push({ path, method: init?.method, body: init?.body as string | undefined });
      if (init?.method === 'PUT') {
        hoisted.enabled = (JSON.parse((init.body as string) ?? '{}') as { enabled: boolean }).enabled;
      }
      return jr({ ok: true, status: status() });
    },
  };
});

describe('AutostartPanel (W12d)', () => {
  it('shows "Open KriyaDot at login" unchecked, then PUTs enabled:true on toggle', async () => {
    hoisted.calls.length = 0;
    hoisted.enabled = false;
    render(<AutostartPanel />);
    const box = await screen.findByRole('checkbox', { name: /open kriyadot at login/i });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/autostart entry/i)).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    const put = hoisted.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/autostart');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ enabled: true });
  });
});
