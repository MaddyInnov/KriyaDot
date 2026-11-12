// SPDX-License-Identifier: Apache-2.0
// FleetPanel (A15): renders the registry from GET /api/fleet — machine
// names, liveness (including a stale/offline peer that stays listed),
// capability chips and self-reported counts; the advertise button posts
// to /api/fleet/advertise. The API surface is mocked in-memory.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FleetPanel, type FleetResponse } from './fleet-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  fleet: null as unknown as FleetResponse,
  calls: [] as Array<{ path: string; method?: string }>,
}));

function makeFleet(): FleetResponse {
  return {
    ok: true,
    thresholds: { staleAfterMs: 45_000, offlineAfterMs: 120_000 },
    machines: [
      {
        instanceId: 'kd_self',
        displayName: 'Studio PC',
        platform: 'linux',
        version: '0.1.0',
        capabilities: { bridges: ['claude'], sandboxBackend: null, gitAvailable: true },
        heartbeatAt: Date.now(),
        activeMissions: 1,
        activeRuns: 0,
        liveness: 'online',
        isSelf: true,
        lastSeenAt: Date.now(),
      },
      {
        instanceId: 'kd_peer',
        displayName: 'Laptop',
        platform: 'darwin',
        version: '0.1.0',
        capabilities: { bridges: [], sandboxBackend: 'landlock', gitAvailable: false },
        heartbeatAt: Date.now() - 200_000,
        activeMissions: 0,
        activeRuns: 0,
        liveness: 'offline',
        isSelf: false,
        lastSeenAt: Date.now() - 200_000,
      },
    ],
  };
}

vi.mock('../../lib/api', () => {
  const jr = (body: unknown, ok = true, status = 200): Response =>
    ({
      ok,
      status,
      statusText: ok ? 'OK' : 'ERR',
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }) as Response;
  return {
    authedFetch: async (path: string, init?: RequestInit) => {
      hoisted.calls.push({ path, method: init?.method });
      const method = init?.method ?? 'GET';
      if (path === '/api/fleet' && method === 'GET') return jr(hoisted.fleet);
      if (path === '/api/fleet/advertise' && method === 'POST') return jr({ ok: true, results: [] });
      return jr({ error: `unmocked ${method} ${path}` }, false, 500);
    },
  };
});

describe('FleetPanel (A15)', () => {
  beforeEach(() => {
    hoisted.calls = [];
    hoisted.fleet = makeFleet();
  });

  it('renders self + peer with liveness, platform, counts and capability chips', async () => {
    render(<FleetPanel />);
    expect(await screen.findByText(/Studio PC/)).toBeInTheDocument();
    expect(screen.getByText(/\(this machine\)/)).toBeInTheDocument();
    expect(screen.getByText(/Laptop/)).toBeInTheDocument();
    // The offline peer stays listed, labelled offline — never dropped.
    expect(screen.getByTestId('fleet-machine-kd_peer')).toHaveTextContent(/○ offline/);
    expect(screen.getByText(/1 active mission\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/sandbox: landlock/)).toBeInTheDocument();
    expect(screen.getByText(/no git/)).toBeInTheDocument();
  });

  it('advertise button posts to /api/fleet/advertise and reloads', async () => {
    render(<FleetPanel />);
    const btn = await screen.findByRole('button', { name: 'Advertise this machine now' });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(hoisted.calls.some((c) => c.path === '/api/fleet/advertise' && c.method === 'POST')).toBe(true);
    });
  });
});
