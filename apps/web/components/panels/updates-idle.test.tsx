// SPDX-License-Identifier: Apache-2.0
// W12c: the Updates panel exposes the "Apply updates when idle" toggle
// (default OFF) and PUTs applyWhenIdle to /api/updates/settings.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdatesPanel } from './updates-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  applyWhenIdle: false,
}));

vi.mock('../../lib/kriyadot-api', () => {
  const jr = (body: unknown, ok = true): Response =>
    ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: async () => body }) as Response;
  const statusBody = {
    state: 'idle',
    currentVersion: '0.1.0',
    latest: null,
    asset: null,
    downloadedBytes: 0,
    totalBytes: 0,
    progress: 0,
    lastCheckedAt: null,
    lastError: null,
    previousInstaller: null,
    platform: 'linux',
    arch: 'x64',
  };
  const settingsBody = () => ({
    autoCheck: true,
    checkIntervalHours: 24,
    applyWhenIdle: hoisted.applyWhenIdle,
  });
  return {
    kriyadotFetch: async (path: string, init?: RequestInit) => {
      hoisted.calls.push({ path, method: init?.method, body: init?.body as string | undefined });
      if (path === '/api/updates/status') return jr({ ok: true, status: statusBody });
      if (path === '/api/updates/settings' && init?.method === 'PUT') {
        const patch = JSON.parse((init.body as string) ?? '{}') as { applyWhenIdle?: boolean };
        if (typeof patch.applyWhenIdle === 'boolean') hoisted.applyWhenIdle = patch.applyWhenIdle;
        return jr({ ok: true, settings: settingsBody() });
      }
      if (path === '/api/updates/settings') return jr({ ok: true, settings: settingsBody() });
      return jr({ ok: false, error: 'unexpected' }, false);
    },
  };
});

describe('UpdatesPanel — apply when idle (W12c)', () => {
  it('renders the toggle OFF by default and saves applyWhenIdle:true when checked', async () => {
    hoisted.calls.length = 0;
    hoisted.applyWhenIdle = false;
    render(<UpdatesPanel />);
    const box = await screen.findByRole('checkbox', { name: /apply updates when idle/i });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    const put = hoisted.calls.find((c) => c.path === '/api/updates/settings' && c.method === 'PUT');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ applyWhenIdle: true });
    // The exact-behaviour explainer appears once enabled.
    expect(await screen.findByText(/10\s+minutes, KriyaDot downloads it/i)).toBeInTheDocument();
  });
});
