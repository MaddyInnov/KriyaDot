// SPDX-License-Identifier: Apache-2.0
// Computer-use setup panel (ADD-5): renders the foreground truth up
// front, the honest OS-check states, the self-test results, and gates
// the Enable button on a passing self-test.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ComputerUseSetupPanel from './computer-use-setup-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({ state: 'fresh' as 'fresh' | 'ready' | 'enabled', posts: [] as string[] }));

vi.mock('../../lib/api', () => {
  const jr = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
    }) as Response;
  const view = () => ({
    ok: true,
    status: hoisted.state === 'fresh' ? 'in-progress' : hoisted.state === 'ready' ? 'ready-to-enable' : 'enabled',
    enabled: hoisted.state === 'enabled',
    explainer: {
      headline: 'Let your agent use this computer',
      foregroundTruth:
        'Real control uses YOUR mouse cursor, in the foreground, on the screen you are looking at. There is no background mode for real mouse control.',
      approvalNote: 'Setup does not give the agent standing permission to do anything.',
      permissionNote: 'Your operating system may ask you to grant accessibility permissions.',
    },
    platform: {
      platform: 'darwin',
      checks: [
        {
          id: 'accessibility',
          label: 'Accessibility — lets the agent click, type and press keys',
          requirement: 'grant-required',
          status: 'unknown',
          autoDetectable: false,
          instructions: 'Open System Settings → Privacy & Security → Accessibility and allow the app.',
        },
      ],
    },
    ...(hoisted.state !== 'fresh'
      ? { selfTest: { ok: true, at: 123, steps: [{ id: 'screenshot', ok: true, detail: 'captured a 1920×1080 screenshot' }] } }
      : {}),
    adapter: { kind: hoisted.state === 'enabled' ? 'real' : 'setup-required', real: hoisted.state === 'enabled', reason: 'test reason' },
    approvalNote: 'Setup does not give the agent standing permission to do anything. Every click still asks for your approval first.',
  });
  return {
    authedFetch: async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        hoisted.posts.push(path);
        if (path.endsWith('/self-test')) hoisted.state = 'ready';
        if (path.endsWith('/enable')) hoisted.state = 'enabled';
        return jr(view());
      }
      return jr(view());
    },
  };
});

describe('computer-use setup panel', () => {
  beforeEach(() => {
    hoisted.state = 'fresh';
    hoisted.posts = [];
  });

  it('states the foreground truth and the no-standing-allow note before anything else', async () => {
    render(<ComputerUseSetupPanel />);
    expect(await screen.findByText(/YOUR mouse cursor, in the foreground/)).toBeInTheDocument();
    expect(screen.getByText(/no background mode for real mouse control/i)).toBeInTheDocument();
    expect(screen.getByText(/standing permission/)).toBeInTheDocument();
  });

  it('reports a macOS grant check honestly as not-readable, with the Settings path', async () => {
    render(<ComputerUseSetupPanel />);
    expect(await screen.findByText(/Accessibility — lets the agent click/)).toBeInTheDocument();
    expect(screen.getByText(/cannot read the grant state — the self-test below is the proof/)).toBeInTheDocument();
    expect(screen.getByText(/System Settings → Privacy & Security → Accessibility/)).toBeInTheDocument();
  });

  it('gates Enable on a passing self-test, then enables', async () => {
    render(<ComputerUseSetupPanel />);
    const enableBtn = await screen.findByRole('button', { name: /Enable real control/ });
    expect(enableBtn).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Run the self-test/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Enable real control/ })).not.toBeDisabled());
    expect(screen.getByText(/captured a 1920×1080 screenshot/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Enable real control/ }));
    expect(await screen.findByText(/Real control is on/)).toBeInTheDocument();
    expect(hoisted.posts).toContain('/api/computer-use-setup/enable');
  });
});
