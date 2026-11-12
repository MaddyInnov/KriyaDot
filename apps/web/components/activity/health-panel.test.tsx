// SPDX-License-Identifier: Apache-2.0
// HealthPanel self-monitoring section (B3): renders the resource guard
// snapshot from GET /api/health/self, shows the shedding banner with the
// guard's reason while shedding, and sends guard toggles as
// PUT /api/health/resource-guard. The API surface is mocked in-memory.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SelfMonitorSection, type SelfSnapshot } from './health-panel';

afterEach(() => cleanup());

const MB = 1024 * 1024;

const hoisted = vi.hoisted(() => ({
  snapshot: null as unknown as SelfSnapshot,
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
}));

function makeSnapshot(overrides: Partial<SelfSnapshot> = {}): SelfSnapshot {
  return {
    at: Date.now(),
    uptimeSeconds: 3661,
    process: { pid: 1234, rssBytes: 512 * MB, heapUsedBytes: 128 * MB, heapTotalBytes: 256 * MB },
    eventLoopLagMs: 3.2,
    memoryTrend: { samples: 12, rssSlopeBytesPerMinute: 2 * MB, rssMinBytes: 400 * MB, rssMaxBytes: 520 * MB },
    counts: { activeTurns: 1, runningWorkflowRuns: 2, pendingApprovals: 0 },
    guard: {
      enabled: true,
      shedEnabled: true,
      level: 'ok',
      shedding: false,
      denialCount: 0,
      lastDenial: null,
      settings: { memorySoftBytes: 1536 * MB, memoryHardBytes: 2560 * MB },
    },
    ...overrides,
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
      hoisted.calls.push({ path, method: init?.method, body: init?.body as string | undefined });
      const method = init?.method ?? 'GET';
      if (path === '/api/health/self' && method === 'GET') return jr(hoisted.snapshot);
      if (path === '/api/health/resource-guard' && method === 'PUT') {
        const body = JSON.parse(init?.body as string) as { enabled?: boolean; shedEnabled?: boolean };
        hoisted.snapshot = makeSnapshot({
          guard: {
            ...hoisted.snapshot.guard,
            enabled: body.enabled ?? hoisted.snapshot.guard.enabled,
            shedEnabled: body.shedEnabled ?? hoisted.snapshot.guard.shedEnabled,
          },
        });
        return jr({ ok: true });
      }
      return jr({ error: `unmocked ${method} ${path}` }, false, 500);
    },
  };
});

describe('SelfMonitorSection (B3)', () => {
  beforeEach(() => {
    hoisted.calls = [];
    hoisted.snapshot = makeSnapshot();
  });

  it('renders uptime, memory, lag, counts and guard state from the snapshot', async () => {
    render(<SelfMonitorSection />);
    expect(await screen.findByText(/Self-monitoring — this process/)).toBeInTheDocument();
    expect(screen.getByText(/RSS 512 MB/)).toBeInTheDocument();
    expect(screen.getByText(/3\.2 ms/)).toBeInTheDocument();
    expect(screen.getByText(/pressure ok/)).toBeInTheDocument();
    expect(screen.getByText(/Active turns/)).toBeInTheDocument();
  });

  it('shows the shedding banner with the guard reason while shedding', async () => {
    hoisted.snapshot = makeSnapshot({
      guard: {
        ...makeSnapshot().guard,
        level: 'hard',
        shedding: true,
        denialCount: 4,
        lastDenial: {
          at: Date.now(),
          kind: 'routine:abc',
          reason: 'Resource guard is shedding new optional work (routine:abc): RSS 2600 MB.',
        },
      },
    });
    render(<SelfMonitorSection />);
    expect(await screen.findByText(/work already running is untouched/)).toBeInTheDocument();
    expect(screen.getByText(/RSS 2600 MB/)).toBeInTheDocument();
    expect(screen.getByText(/Refused starts so far: 4/)).toBeInTheDocument();
  });

  it('guard toggle sends the full settings with the flipped flag', async () => {
    render(<SelfMonitorSection />);
    const btn = await screen.findByRole('button', { name: 'Turn guard off' });
    fireEvent.click(btn);
    await waitFor(() => {
      const put = hoisted.calls.find((c) => c.path === '/api/health/resource-guard' && c.method === 'PUT');
      expect(put).toBeDefined();
      expect(JSON.parse(put!.body!).enabled).toBe(false);
    });
    expect(await screen.findByRole('button', { name: 'Turn guard on' })).toBeInTheDocument();
  });
});
