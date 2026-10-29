// SPDX-License-Identifier: Apache-2.0
// W12a "Set me up" panel: sentence → proposal card → approve creates;
// discard creates nothing (no apply call).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotSetupPanel } from './bot-setup-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string }>,
}));

vi.mock('../../lib/kriyadot-api', () => {
  // Self-contained factory (vitest hoists vi.mock above module consts).
  const jr = (body: unknown, ok = true): Response =>
    ({ ok, status: ok ? 200 : 400, statusText: ok ? 'OK' : 'Bad', json: async () => body }) as Response;
  const proposal = {
    id: 'inbox-pilot',
    name: 'Inbox Pilot',
    description: 'Watches Gmail and drafts replies.',
    systemPrompt: 'You are Inbox Pilot.',
    provider: 'groq',
    model: 'gpt-oss-20b',
    tools: ['gmail_read', 'web_search'],
    skills: [],
    mcpServers: ['gmail'],
    routines: [{ name: 'Morning inbox draft', promptTemplate: 'Draft replies.', schedule: { kind: 'daily' } }],
    sourceSentence: 'watch my gmail',
    droppedTools: ['teleport'],
    droppedMcpServers: [],
  };
  return {
    kriyadotFetch: async (path: string, init?: RequestInit) => {
      hoisted.calls.push({ path, method: init?.method });
      if (path === '/api/bots/setup/propose') return jr({ ok: true, proposal });
      if (path === '/api/bots/setup/apply') {
        return jr({
          ok: true,
          bot: { id: 'inbox-pilot', name: 'Inbox Pilot' },
          routines: [{ id: 'r1', name: 'Morning inbox draft' }],
          skippedRoutines: [],
        });
      }
      return jr({ ok: false, error: 'unexpected' }, false);
    },
  };
});

function mockFetch() {
  hoisted.calls.length = 0;
  return hoisted.calls;
}

describe('BotSetupPanel (W12a)', () => {
  it('proposes, shows ONE approval card, and creates only on approve', async () => {
    const calls = mockFetch();
    const onCreated = vi.fn();
    render(<BotSetupPanel onCreated={onCreated} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/describe your bot/i), {
      target: { value: 'I need a bot that watches my Gmail and drafts replies every morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: /draft my bot/i }));
    // Approval card shows the full proposal, incl. dropped invalid tools.
    expect(await screen.findByText('Inbox Pilot')).toBeInTheDocument();
    expect(screen.getByText('Morning inbox draft')).toBeInTheDocument();
    expect(screen.getByText(/teleport/)).toBeInTheDocument();
    // Not created yet:
    expect(calls.filter((c) => c.path === '/api/bots/setup/apply')).toHaveLength(0);
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /approve — create/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.path === '/api/bots/setup/apply')).toHaveLength(1);
    expect(await screen.findByText(/✅ Created/)).toBeInTheDocument();
  });

  it('discard creates nothing (no apply call ever)', async () => {
    const calls = mockFetch();
    const onCancel = vi.fn();
    render(<BotSetupPanel onCreated={() => undefined} onCancel={onCancel} />);
    fireEvent.change(screen.getByLabelText(/describe your bot/i), {
      target: { value: 'a gmail bot' },
    });
    fireEvent.click(screen.getByRole('button', { name: /draft my bot/i }));
    expect(await screen.findByText('Inbox Pilot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /discard — create nothing/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(calls.filter((c) => c.path === '/api/bots/setup/apply')).toHaveLength(0);
  });
});
