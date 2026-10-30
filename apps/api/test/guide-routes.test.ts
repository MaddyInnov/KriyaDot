// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import express from 'express';
import { GUIDE_ARTICLES } from '../src/guide-content.js';
import { createGuideRouter, answerGuideQuestion } from '../src/guide-routes.js';

function makeApp(deps?: Parameters<typeof createGuideRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api', createGuideRouter(deps));
  return app;
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

const REQUIRED_IDS = [
  'first-setup',
  'universal-chat-routing',
  'creating-bots',
  'workflows',
  'connecting-lightning-cloud',
  'placement-and-anchors',
  'reporting',
  'approvals-and-safety',
  'marketplace-store-installs',
  'sync-across-devices',
  'permissions-pane',
  'feed',
  'computer-use',
];

describe('guide content', () => {
  it('covers every ADD-3 required topic', () => {
    const ids = GUIDE_ARTICLES.map((a) => a.id);
    for (const id of REQUIRED_IDS) expect(ids).toContain(id);
  });

  it('every article is well-formed: steps, audience, capability ids, real routes', () => {
    for (const a of GUIDE_ARTICLES) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.audience.length).toBeGreaterThan(0);
      expect(a.steps.length).toBeGreaterThanOrEqual(3);
      expect(a.relatedCapabilities.length).toBeGreaterThan(0);
      for (const s of a.steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.body.length).toBeGreaterThan(0);
        if (s.deepLink) expect(s.deepLink.href.startsWith('/')).toBe(true);
      }
    }
  });
});

describe('guide routes', () => {
  it('GET /guide/articles lists summaries grouped by theme', async () => {
    const { server, base } = await listen(makeApp());
    try {
      const res = await fetch(`${base}/api/guide/articles`);
      const body = (await res.json()) as {
        ok: boolean;
        themes: string[];
        articles: Array<{ id: string; stepCount: number; steps?: unknown }>;
      };
      expect(body.ok).toBe(true);
      expect(body.articles.length).toBe(GUIDE_ARTICLES.length);
      expect(body.themes).toContain('Getting started');
      const first = body.articles.find((a) => a.id === 'first-setup');
      expect(first?.stepCount).toBeGreaterThanOrEqual(3);
      expect(first?.steps).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('GET /guide/articles/:id returns the full article; unknown id 404s', async () => {
    const { server, base } = await listen(makeApp());
    try {
      const res = await fetch(`${base}/api/guide/articles/placement-and-anchors`);
      const body = (await res.json()) as { ok: boolean; article: { steps: unknown[] } };
      expect(body.ok).toBe(true);
      expect(body.article.steps.length).toBeGreaterThanOrEqual(3);

      const missing = await fetch(`${base}/api/guide/articles/nope`);
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('GET /guide/search ranks the anchor article for a PC-off question and 400s without q', async () => {
    const { server, base } = await listen(makeApp());
    try {
      const res = await fetch(`${base}/api/guide/search?q=${encodeURIComponent('run while my PC is off')}`);
      const body = (await res.json()) as { ok: boolean; hits: Array<{ article: { id: string }; score: number }> };
      expect(body.ok).toBe(true);
      expect(body.hits.length).toBeGreaterThan(0);
      expect(body.hits[0].article.id).toBe('placement-and-anchors');
      expect(body.hits[0].score).toBeGreaterThan(0);

      const bad = await fetch(`${base}/api/guide/search`);
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('POST /guide/ask without an LLM seam returns the labelled fallback with deep links', async () => {
    const { server, base } = await listen(makeApp());
    try {
      const res = await fetch(`${base}/api/guide/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'How do I make a workflow?' }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        mode: string;
        answer: string;
        articleIds: string[];
        deepLinks: Array<{ href: string }>;
      };
      expect(body.ok).toBe(true);
      expect(body.mode).toBe('fallback');
      expect(body.articleIds).toContain('workflows');
      expect(body.answer).toContain('Workflows');
      expect(body.deepLinks.some((l) => l.href === '/workflows')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('POST /guide/ask validates the question', async () => {
    const { server, base } = await listen(makeApp());
    try {
      const res = await fetch(`${base}/api/guide/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('answerGuideQuestion', () => {
  it('uses the injected LLM seam when one is provided', async () => {
    const result = await answerGuideQuestion(
      { askLlm: async (prompt) => (prompt.includes('Question:') ? 'Seam answer.' : 'bad prompt') },
      'How do I approve a tool call?',
    );
    expect(result.mode).toBe('llm');
    expect(result.answer).toBe('Seam answer.');
    expect(result.articleIds).toContain('approvals-and-safety');
  });

  it('falls back honestly when the LLM seam throws', async () => {
    const result = await answerGuideQuestion(
      {
        askLlm: async () => {
          throw new Error('no model configured');
        },
      },
      'How do I approve a tool call?',
    );
    expect(result.mode).toBe('fallback');
    expect(result.answer).toContain('Approvals');
  });

  it('includes matching capability entries when the optional dep exists', async () => {
    const result = await answerGuideQuestion(
      {
        getCapabilities: () => [
          { id: 'workflows', name: 'Workflows', description: 'Reusable multi-step automations.' },
          { id: 'unrelated-thing', name: 'Unrelated', description: 'Nothing to do with this.' },
        ],
      },
      'How do I make a workflow?',
    );
    expect(result.mode).toBe('fallback');
    expect(result.capabilities.map((c) => c.id)).toContain('workflows');
    expect(result.answer).toContain('Related capabilities');
  });

  it('survives a throwing capability dep (parallel registry absent/broken)', async () => {
    const result = await answerGuideQuestion(
      {
        getCapabilities: () => {
          throw new Error('registry not built yet');
        },
      },
      'How do I sync across devices?',
    );
    expect(result.articleIds).toContain('sync-across-devices');
    expect(result.capabilities).toEqual([]);
  });

  it('answers an unmatched question with guidance, not invention', async () => {
    const result = await answerGuideQuestion({}, 'How do I bake a sourdough loaf?');
    expect(result.mode).toBe('fallback');
    expect(result.answer).toContain('could not find');
  });
});
