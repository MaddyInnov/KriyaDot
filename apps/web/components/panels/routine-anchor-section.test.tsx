// SPDX-License-Identifier: Apache-2.0
// Routine anchor + reporting: resolved-anchor labels (exact server
// strings), the cloud default with cloud connected, the honest warning
// without cloud, the free-tier caveat, and the save round-trip.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoutineAnchorSection, type AnchorRoutineLike } from './routine-anchor-section';

afterEach(() => cleanup());

const CLOUD_LABEL = 'Runs in your cloud — fires even while your PC is off';
const LOCAL_LABEL = "Runs on this device — only while it's on";

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  syncConfigured: true,
  cloudTier: undefined as string | undefined,
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
          ...(hoisted.cloudTier ? { cloudTier: hoisted.cloudTier } : {}),
          bots: [{ botId: 'coder', placement: 'local', localOnly: false }],
        });
      }
      if (path.startsWith('/api/routines/')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          anchor?: string | null;
          reporting?: unknown;
        };
        // Server-side resolution mirror: automatic + daily + cloud → cloud.
        const anchor =
          body.anchor === 'local' || body.anchor === 'cloud'
            ? body.anchor
            : hoisted.syncConfigured
              ? 'cloud'
              : 'local';
        return jr({
          ok: true,
          routine: {
            id: 'r1',
            anchor,
            anchorWarning: anchor === 'local' && !hoisted.syncConfigured,
            reporting: body.reporting,
          },
        });
      }
      return jr({ error: 'unexpected' }, 404);
    },
  };
});

const dailyRoutine: AnchorRoutineLike = { id: 'r1', botId: 'coder', schedule: { kind: 'daily' } };

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.syncConfigured = true;
  hoisted.cloudTier = undefined;
});

describe('RoutineAnchorSection', () => {
  it('automatic + time-based + cloud connected resolves to the cloud label', async () => {
    render(<RoutineAnchorSection routine={dailyRoutine} />);
    expect(await screen.findByText(CLOUD_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(/only fires while this PC is on/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Automatic (recommended)' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Cloud' })).not.toBeDisabled();
  });

  it('without cloud: local label + honest warning + cloud option disabled', async () => {
    hoisted.syncConfigured = false;
    render(<RoutineAnchorSection routine={dailyRoutine} />);
    expect(await screen.findByText(LOCAL_LABEL)).toBeInTheDocument();
    expect(screen.getByText(/only fires while this PC is on/)).toBeInTheDocument();
    expect(screen.getByText(/Connect your cloud to anchor it in the cloud/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Cloud' })).toBeDisabled();
  });

  it('server-provided anchor + anchorWarning (after save) are authoritative', async () => {
    render(<RoutineAnchorSection routine={{ ...dailyRoutine, anchor: 'local', anchorWarning: true }} />);
    expect(await screen.findByText(LOCAL_LABEL)).toBeInTheDocument();
    expect(screen.getByText(/only fires while this PC is on/)).toBeInTheDocument();
  });

  it('explicit "This device" choice overrides the cloud default', async () => {
    render(<RoutineAnchorSection routine={dailyRoutine} />);
    expect(await screen.findByText(CLOUD_LABEL)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'This device' }));
    expect(await screen.findByText(LOCAL_LABEL)).toBeInTheDocument();
  });

  it('free-tier caveat shows for a free cloud tier with a cloud-anchored time-critical routine', async () => {
    hoisted.cloudTier = 'free';
    render(<RoutineAnchorSection routine={dailyRoutine} />);
    expect(await screen.findByText(CLOUD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(/sleeps when idle/)).toBeInTheDocument();
    expect(screen.getByText(/Lightning Pro removes the sleep restriction/)).toBeInTheDocument();
  });

  it('no free-tier caveat on a paid tier', async () => {
    hoisted.cloudTier = 'pro';
    render(<RoutineAnchorSection routine={dailyRoutine} />);
    expect(await screen.findByText(CLOUD_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(/sleeps when idle/)).not.toBeInTheDocument();
  });

  it('reporting control: segmented modes + quiet hours, saved with the anchor', async () => {
    const onChanged = vi.fn();
    render(<RoutineAnchorSection routine={dailyRoutine} onChanged={onChanged} />);
    expect(await screen.findByText(CLOUD_LABEL)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Daily digest' }));
    fireEvent.change(screen.getByLabelText(/Quiet hours start/), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText(/Quiet hours end/), { target: { value: '07:00' } });
    fireEvent.click(screen.getByRole('button', { name: /Save anchor & reporting/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const patch = hoisted.calls.find((c) => c.path === '/api/routines/r1' && c.method === 'PATCH');
    expect(patch).toBeTruthy();
    const body = JSON.parse(patch?.body ?? '{}') as { anchor: unknown; reporting: Record<string, unknown> };
    expect(body.anchor).toBeNull(); // automatic → server re-resolves
    expect(body.reporting).toEqual({ mode: 'daily', quietStart: '22:00', quietEnd: '07:00' });
    // The saved (server-resolved) anchor label is what the user sees.
    expect(await screen.findByText(CLOUD_LABEL)).toBeInTheDocument();
  });
});
