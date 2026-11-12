// SPDX-License-Identifier: Apache-2.0
// IdeasPanel (B6): the parked-ideas notebook section — lists ideas,
// parks new ones, actions one into a task, and shows / collects
// outcomes. The /api/parked-ideas surface is mocked in-memory.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IdeasPanel, type ParkedIdea } from './ideas-panel';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  ideas: [] as ParkedIdea[],
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
  seq: 0,
}));

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
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      if (path === '/api/parked-ideas' && method === 'GET') return jr(hoisted.ideas);
      if (path === '/api/parked-ideas' && method === 'POST') {
        const idea: ParkedIdea = {
          id: `idea-${++hoisted.seq}`,
          title: String(body.title),
          body: typeof body.body === 'string' ? body.body : '',
          source: 'manual',
          state: 'parked',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        hoisted.ideas = [idea, ...hoisted.ideas];
        return jr(idea, true, 201);
      }
      const actionMatch = path.match(/^\/api\/parked-ideas\/(.+)\/action$/);
      if (actionMatch && method === 'POST') {
        const idea = hoisted.ideas.find((i) => i.id === actionMatch[1]);
        if (!idea) return jr({ error: 'unknown' }, false, 404);
        const updated: ParkedIdea = { ...idea, state: 'actioned', taskId: `task-${idea.id}`, actionedAt: Date.now() };
        hoisted.ideas = hoisted.ideas.map((i) => (i.id === idea.id ? updated : i));
        return jr({ idea: updated, task: { id: updated.taskId } }, true, 201);
      }
      const outcomeMatch = path.match(/^\/api\/parked-ideas\/(.+)\/outcome$/);
      if (outcomeMatch && method === 'POST') {
        const idea = hoisted.ideas.find((i) => i.id === outcomeMatch[1]);
        if (!idea) return jr({ error: 'unknown' }, false, 404);
        const updated: ParkedIdea = {
          ...idea,
          outcomePending: false,
          outcome: { text: String(body.text), completedAt: Date.now(), taskId: idea.taskId ?? '' },
        };
        hoisted.ideas = hoisted.ideas.map((i) => (i.id === idea.id ? updated : i));
        return jr(updated);
      }
      return jr({ error: `unmocked ${method} ${path}` }, false, 500);
    },
  };
});

function seed(idea: Partial<ParkedIdea> & { title: string }): ParkedIdea {
  return {
    id: `seed-${++hoisted.seq}`,
    body: '',
    source: 'manual',
    state: 'parked',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...idea,
  };
}

describe('IdeasPanel (B6)', () => {
  beforeEach(() => {
    hoisted.ideas = [];
    hoisted.calls = [];
    hoisted.seq = 0;
  });

  it('lists parked ideas with state/source chips and the quiet notebook copy', async () => {
    hoisted.ideas = [seed({ title: 'Rooftop garden', source: 'chat' }), seed({ title: 'Old sketch' })];
    render(<IdeasPanel hideHeader />);
    expect(await screen.findByText('Rooftop garden')).toBeInTheDocument();
    expect(screen.getByText('Old sketch')).toBeInTheDocument();
    expect(screen.getByText('from chat')).toBeInTheDocument();
    expect(screen.getAllByText('parked').length).toBeGreaterThan(0);
  });

  it('parks a new idea from the form', async () => {
    render(<IdeasPanel hideHeader />);
    fireEvent.change(await screen.findByLabelText(/park an idea/i), { target: { value: 'Weekend hackathon' } });
    fireEvent.click(screen.getByRole('button', { name: /park idea/i }));
    expect(await screen.findByText('Weekend hackathon')).toBeInTheDocument();
    const post = hoisted.calls.find((c) => c.path === '/api/parked-ideas' && c.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({ title: 'Weekend hackathon', source: 'manual' });
  });

  it('"Action this idea" posts the action and shows the task link state', async () => {
    hoisted.ideas = [seed({ title: 'Ship the zine' })];
    render(<IdeasPanel hideHeader />);
    fireEvent.click(await screen.findByRole('button', { name: /action this idea/i }));
    expect(await screen.findByText(/actioned as a task/i)).toBeInTheDocument();
    const call = hoisted.calls.find((c) => c.path.endsWith('/action'));
    expect(call?.method).toBe('POST');
    // The action button is gone once actioned — no double-action path in the UI.
    expect(screen.queryByRole('button', { name: /action this idea/i })).toBeNull();
  });

  it('shows a recorded outcome on the idea', async () => {
    hoisted.ideas = [
      seed({
        title: 'Newsletter idea',
        state: 'actioned',
        taskId: 'task-1',
        outcome: { text: 'Grew to 200 subscribers', completedAt: Date.now(), taskId: 'task-1' },
      }),
    ];
    render(<IdeasPanel hideHeader />);
    expect(await screen.findByText(/grew to 200 subscribers/i)).toBeInTheDocument();
    expect(screen.getByText(/outcome:/i)).toBeInTheDocument();
  });

  it('prompts for and saves the outcome when the task finished without one', async () => {
    hoisted.ideas = [
      seed({ title: 'Pop-up stall', state: 'actioned', taskId: 'task-2', outcomePending: true,
        outcome: { text: '', completedAt: Date.now(), taskId: 'task-2' } }),
    ];
    render(<IdeasPanel hideHeader />);
    const input = await screen.findByLabelText(/how did this idea turn out/i);
    fireEvent.change(input, { target: { value: 'Sold out by noon' } });
    fireEvent.click(screen.getByRole('button', { name: /save outcome/i }));
    await waitFor(() => expect(screen.getByText(/sold out by noon/i)).toBeInTheDocument());
    const call = hoisted.calls.find((c) => c.path.endsWith('/outcome'));
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ text: 'Sold out by noon' });
  });
});
