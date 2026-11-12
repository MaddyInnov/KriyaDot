// SPDX-License-Identifier: Apache-2.0
// TasksPanel (A5): mission tasks show their pipeline stage + chain
// blockers on the EXISTING Tasks board (no second board).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { TasksPanel } from './tasks-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  tasks: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../lib/api', () => ({
  authedFetch: async (path: string) =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => (path === '/api/tasks' ? hoisted.tasks : []),
      text: async () => '',
    }) as Response,
}));

describe('TasksPanel mission surface (A5)', () => {
  it('shows the mission stage chip and blocker names for a mission task', async () => {
    hoisted.tasks = [
      {
        id: 'a',
        title: 'Base task',
        dueAt: null,
        done: true,
        createdAt: 1,
        updatedAt: 1,
        missionStage: 'landed',
      },
      {
        id: 'b',
        title: 'Follow-up task',
        dueAt: null,
        done: false,
        createdAt: 2,
        updatedAt: 2,
        blockedBy: ['a'],
        missionStage: 'working',
      },
    ];
    render(<TasksPanel hideHeader />);
    // Default filter is "open", so the landed (done) task is hidden but
    // still resolves as the blocker name for the follow-up.
    await waitFor(() => expect(screen.getByText('Follow-up task')).toBeInTheDocument());
    expect(screen.getByText(/mission: working/)).toBeInTheDocument();
    expect(screen.getByText(/blocked by Base task/)).toBeInTheDocument();
  });

  it('renders plain tasks without mission chrome', async () => {
    hoisted.tasks = [
      { id: 'x', title: 'Plain task', dueAt: null, done: false, createdAt: 1, updatedAt: 1 },
    ];
    render(<TasksPanel hideHeader />);
    await waitFor(() => expect(screen.getByText('Plain task')).toBeInTheDocument());
    expect(screen.queryByText(/mission:/)).not.toBeInTheDocument();
  });
});
