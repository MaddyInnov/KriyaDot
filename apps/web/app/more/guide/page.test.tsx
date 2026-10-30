// SPDX-License-Identifier: Apache-2.0
// User Guide page (ADD-3): renders the grouped article list from the
// guide API, opens the article reader, and renders "How do I…?"
// answers with their deep-link buttons.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GuidePage from './page';

afterEach(() => cleanup());
beforeEach(() => {
  localStorage.clear();
  // Keep the first-run tour out of these assertions (it is tested in
  // components/guide/tour.test.tsx); the page still mounts it.
  localStorage.setItem('kriyadot:guide-tour-seen', '1');
});

const ARTICLES = [
  {
    id: 'first-setup',
    title: 'First setup: from install to your first answer',
    theme: 'Getting started',
    audience: 'Anyone opening KriyaDot for the first time',
    summary: 'Works out of the box with a keyless free lane.',
    relatedCapabilities: ['universal-chat'],
    stepCount: 1,
    deepLinks: [{ label: 'Open Universal Chat', href: '/' }],
  },
  {
    id: 'workflows',
    title: 'Workflows: reusable multi-step automations',
    theme: 'Automation',
    audience: 'Anyone repeating the same multi-step job',
    summary: 'Saved, repeatable sequences of steps.',
    relatedCapabilities: ['workflows'],
    stepCount: 1,
    deepLinks: [{ label: 'Open Workflows', href: '/workflows' }],
  },
];

vi.mock('../../../lib/api', () => ({
  authedFetch: async (path: string, init?: RequestInit) => {
    const jr = (body: unknown, status = 200): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as Response;
    if (path === '/api/guide/articles') {
      return jr({ ok: true, themes: ['Getting started', 'Automation'], articles: ARTICLES });
    }
    if (path === '/api/guide/articles/workflows') {
      return jr({
        ok: true,
        article: {
          ...ARTICLES[1],
          keywords: ['workflow'],
          steps: [
            {
              title: 'Browse what exists on the Workflows page',
              body: 'Workflows lists every registered definition.',
              deepLink: { label: 'Open Workflows', href: '/workflows' },
            },
          ],
        },
      });
    }
    if (path.startsWith('/api/guide/search')) {
      return jr({ ok: true, query: 'workflow', hits: [{ article: ARTICLES[1], score: 9 }] });
    }
    if (path === '/api/guide/ask' && init?.method === 'POST') {
      return jr({
        ok: true,
        mode: 'fallback',
        answer: 'Start with "Workflows: reusable multi-step automations".',
        articleIds: ['workflows'],
        deepLinks: [{ label: 'Open Workflows', href: '/workflows' }],
      });
    }
    return jr({ error: `unmocked ${path}` }, 404);
  },
}));

describe('guide page', () => {
  it('renders articles grouped by theme', async () => {
    render(<GuidePage />);
    expect(await screen.findByText('Getting started')).toBeInTheDocument();
    expect(screen.getByText('Automation')).toBeInTheDocument();
    expect(screen.getByText(/First setup: from install/)).toBeInTheDocument();
    expect(screen.getByText(/Workflows: reusable multi-step/)).toBeInTheDocument();
  });

  it('opens the article reader with steps and deep-link buttons', async () => {
    render(<GuidePage />);
    const buttons = await screen.findAllByText('Read walkthrough →');
    fireEvent.click(buttons[1]);
    expect(await screen.findByTestId('guide-article-reader')).toBeInTheDocument();
    expect(screen.getByText('Browse what exists on the Workflows page')).toBeInTheDocument();
    const link = screen.getByText('Open Workflows →').closest('a');
    expect(link?.getAttribute('href')).toBe('/workflows');
  });

  it('renders the "How do I…?" fallback answer with deep links', async () => {
    render(<GuidePage />);
    const input = screen.getByLabelText('Ask the guide a question');
    fireEvent.change(input, { target: { value: 'How do I make a workflow?' } });
    fireEvent.click(screen.getByText('Ask'));
    expect(await screen.findByTestId('guide-ask-result')).toBeInTheDocument();
    expect(screen.getByText(/Answered directly from the guide content/)).toBeInTheDocument();
    const link = screen.getByText('Open Workflows →').closest('a');
    expect(link?.getAttribute('href')).toBe('/workflows');
    await waitFor(() => expect(screen.getByText(/Read: Workflows/)).toBeInTheDocument());
  });
});
