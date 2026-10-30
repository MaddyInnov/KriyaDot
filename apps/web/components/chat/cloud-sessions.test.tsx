// SPDX-License-Identifier: Apache-2.0
// Unified history: cloud-origin sessions carry a Cloud badge and open
// READ-ONLY (notice instead of a composer + "Continue in cloud").
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudSessionsPanel } from './cloud-sessions';

afterEach(() => cleanup());

vi.mock('../../lib/kriyadot-api', () => {
  const jr = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
    }) as Response;
  return {
    kriyadotFetch: async (path: string) => {
      if (path === '/api/sync/history') {
        return jr({
          sessions: [
            {
              sessionId: 'cloud-sess-1',
              botId: 'researcher',
              origin: 'cloud',
              readOnly: true,
              messageCount: 2,
              lastMessageTs: '2026-10-30T01:01:00.000Z',
            },
            {
              sessionId: 'local-sess-1',
              botId: 'coder',
              origin: 'local',
              readOnly: false,
              messageCount: 5,
              lastMessageTs: '2026-10-30T02:00:00.000Z',
            },
          ],
        });
      }
      if (path === '/api/sync/sessions/cloud-sess-1/messages') {
        return jr({
          ok: true,
          sessionId: 'cloud-sess-1',
          messages: [
            { id: 1, role: 'user', content: 'Summarize the overnight run', ts: '2026-10-30T01:00:00.000Z' },
            { id: 2, role: 'assistant', content: 'Done — all three reports are ready.', ts: '2026-10-30T01:01:00.000Z' },
          ],
        });
      }
      if (path === '/api/sync/status') {
        return jr({ configured: true, instanceUrl: 'https://studio.example.com', pendingOutbox: 0 });
      }
      return jr({ error: 'unexpected' }, 404);
    },
  };
});

describe('CloudSessionsPanel', () => {
  it('lists cloud-origin sessions with a Cloud badge (local sessions stay in the local list)', async () => {
    render(<CloudSessionsPanel />);
    const item = await screen.findByRole('button', { name: /researcher/ });
    expect(item).toBeInTheDocument();
    expect(screen.getByText('☁️ Cloud')).toBeInTheDocument();
    // The local-origin session is not duplicated into the cloud list.
    expect(screen.queryByRole('button', { name: /coder/ })).not.toBeInTheDocument();
  });

  it('opens a cloud session read-only: messages visible, no composer, notice + Continue in cloud', async () => {
    render(<CloudSessionsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /researcher/ }));
    expect(await screen.findByText('Summarize the overnight run')).toBeInTheDocument();
    expect(screen.getByText('Done — all three reports are ready.')).toBeInTheDocument();
    expect(
      screen.getByText("This chat lives in your cloud — history is read-only here"),
    ).toBeInTheDocument();
    const cont = screen.getByRole('link', { name: /Continue in cloud/ });
    expect(cont).toHaveAttribute('href', 'https://studio.example.com');
    // Read-only means read-only: no text composer anywhere in the panel.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
