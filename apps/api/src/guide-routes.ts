// SPDX-License-Identifier: Apache-2.0
/**
 * In-app User Guide — API routes (closure addendum ADD-3).
 *
 * Register-style router; the host mounts it under /api, so the public
 * paths are:
 *
 *   GET  /api/guide/articles        → { ok, themes, articles: [summary…] }
 *   GET  /api/guide/articles/:id    → { ok, article } | 404
 *   GET  /api/guide/search?q=       → { ok, query, hits: [{ article, score }] }
 *   POST /api/guide/ask { question } → { ok, mode, answer, articleIds, deepLinks }
 *
 * "How do I…?" answering: when the host injects `askLlm`, the top
 * matching guide articles (+ matching ADD-2 capability entries, when
 * the host supplies them) are handed to that seam and its text becomes
 * the answer. The seam is the muse-modules runTurn pattern — the host
 * wraps its agent runtime the same way muse-modules.ts wraps runTurn
 * for feed/meeting generation:
 *
 *   createGuideRouter({
 *     askLlm: async (prompt) => { let out=''; await runtime.runTurn({ bot, message: prompt, sessionId, onEvent: e => { if (e.type==='token') out+=e.content; } }); return out; },
 *     getCapabilities: () => registryEntries(), // optional, ADD-2
 *   })
 *
 * FALLBACK (honest, labelled): with no LLM seam injected — or if the
 * seam throws — `mode` is 'fallback' and the answer is composed
 * deterministically from the top-matching articles (summary + step
 * titles) with their deep links. It never pretends to be a model
 * answer. `getCapabilities` is an OPTIONAL dependency: GET
 * /api/capabilities is built by a parallel worker, so this module
 * never imports it; the host passes a reader if one exists, and all
 * capability code paths are defensive (absent/throwing → ignored).
 */

import express, { type Router } from 'express';
import {
  GUIDE_ARTICLES,
  GUIDE_THEMES,
  articleDeepLinks,
  getGuideArticle,
  searchGuide,
  tokenize,
  type GuideArticle,
  type GuideDeepLink,
} from './guide-content.js';

/** One ADD-2 capability-registry entry, as the guide needs it. */
export interface GuideCapabilityEntry {
  id: string;
  name: string;
  description?: string;
  whenToUse?: string;
  deepLink?: GuideDeepLink;
}

export interface GuideRoutesDeps {
  /**
   * Host LLM seam (muse-modules runTurn pattern): prompt in, answer
   * text out. Absent → the deterministic fallback answers instead.
   */
  askLlm?: (prompt: string) => Promise<string>;
  /** Optional ADD-2 registry reader. Absent/throwing is fine. */
  getCapabilities?: () => Promise<GuideCapabilityEntry[]> | GuideCapabilityEntry[];
}

export interface GuideAskResult {
  /** 'llm' when the injected seam answered, 'fallback' otherwise. */
  mode: 'llm' | 'fallback';
  answer: string;
  articleIds: string[];
  deepLinks: GuideDeepLink[];
  capabilities: GuideCapabilityEntry[];
}

/** Article shape for list/search responses: everything but full steps. */
function summarize(article: GuideArticle) {
  return {
    id: article.id,
    title: article.title,
    theme: article.theme,
    audience: article.audience,
    summary: article.summary,
    relatedCapabilities: article.relatedCapabilities,
    stepCount: article.steps.length,
    deepLinks: articleDeepLinks(article),
  };
}

async function safeCapabilities(deps: GuideRoutesDeps): Promise<GuideCapabilityEntry[]> {
  if (!deps.getCapabilities) return [];
  try {
    const entries = await deps.getCapabilities();
    return Array.isArray(entries) ? entries.filter((e) => e && typeof e.id === 'string') : [];
  } catch {
    return [];
  }
}

/** Token-overlap match of capability entries against the question. */
export function matchCapabilities(entries: GuideCapabilityEntry[], question: string, limit = 5): GuideCapabilityEntry[] {
  const terms = tokenize(question);
  if (terms.length === 0) return [];
  return entries
    .map((entry) => {
      const hay = `${entry.id} ${entry.name} ${entry.description ?? ''} ${entry.whenToUse ?? ''}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.entry);
}

function fallbackAnswer(question: string, hits: ReturnType<typeof searchGuide>, caps: GuideCapabilityEntry[]): string {
  if (hits.length === 0 && caps.length === 0) {
    return [
      `I could not find a guide article matching "${question}".`,
      'Try the Guide search with different words, or browse the articles — the closest starting points are usually "First setup" and "Universal Chat: how routing decides who answers".',
    ].join('\n\n');
  }
  const parts: string[] = [];
  const top = hits[0];
  if (top) {
    parts.push(`Start with "${top.article.title}": ${top.article.summary}`);
    parts.push(
      ['The steps are:', ...top.article.steps.map((s, i) => `${i + 1}. ${s.title}`)].join('\n'),
    );
    const more = hits.slice(1, 3).map((h) => h.article.title);
    if (more.length) parts.push(`Also relevant: ${more.map((t) => `"${t}"`).join(', ')}.`);
  }
  if (caps.length) {
    parts.push(
      [
        'Related capabilities in KriyaDot:',
        ...caps.map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''}`),
      ].join('\n'),
    );
  }
  parts.push('Use the buttons below to open the exact screen each step names.');
  return parts.join('\n\n');
}

function buildAskPrompt(question: string, hits: ReturnType<typeof searchGuide>, caps: GuideCapabilityEntry[]): string {
  const articleText = hits
    .map(({ article }) =>
      [
        `## ${article.title} (id: ${article.id})`,
        article.summary,
        ...article.steps.map(
          (s, i) => `${i + 1}. ${s.title} — ${s.body}${s.deepLink ? ` [screen: ${s.deepLink.label} → ${s.deepLink.href}]` : ''}`,
        ),
      ].join('\n'),
    )
    .join('\n\n');
  const capText = caps.length
    ? `\n\nRelevant product capabilities:\n${caps
        .map((c) => `- ${c.name} (${c.id})${c.description ? `: ${c.description}` : ''}${c.whenToUse ? ` Use when: ${c.whenToUse}` : ''}`)
        .join('\n')}`
    : '';
  return [
    'You are the KriyaDot in-app guide assistant. Answer the user\'s "how do I" question using ONLY the guide content and capabilities below. Name the exact screens and buttons the guide names. Be concise, plain, and step-by-step. If the content does not cover the question, say so plainly and point at the closest article instead of inventing steps.',
    '',
    `Question: ${question}`,
    '',
    'Guide content:',
    articleText || '(no guide article matched)',
    capText,
  ].join('\n');
}

/** The "How do I…?" brain, exported for tests and host reuse. */
export async function answerGuideQuestion(
  deps: GuideRoutesDeps,
  question: string,
): Promise<GuideAskResult> {
  const hits = searchGuide(question, 3);
  const allCaps = await safeCapabilities(deps);
  const caps = matchCapabilities(allCaps, question);
  // Capabilities an article names also count, even on weak text match.
  // Registry ids look like `feature:<slug>` while articles name the
  // bare slug — match on either form.
  const articleCapIds = new Set(hits.flatMap((h) => h.article.relatedCapabilities));
  for (const entry of allCaps) {
    const slug = entry.id.includes(':') ? entry.id.slice(entry.id.lastIndexOf(':') + 1) : entry.id;
    if ((articleCapIds.has(entry.id) || articleCapIds.has(slug)) && !caps.some((c) => c.id === entry.id)) {
      caps.push(entry);
    }
  }

  const articleIds = hits.map((h) => h.article.id);
  const deepLinks: GuideDeepLink[] = [];
  const seen = new Set<string>();
  const pushLink = (link: GuideDeepLink | undefined) => {
    if (link && !seen.has(link.href)) {
      seen.add(link.href);
      deepLinks.push(link);
    }
  };
  for (const hit of hits) for (const link of articleDeepLinks(hit.article)) pushLink(link);
  for (const cap of caps) pushLink(cap.deepLink);

  if (deps.askLlm) {
    try {
      const text = (await deps.askLlm(buildAskPrompt(question, hits, caps))).trim();
      if (text) {
        return { mode: 'llm', answer: text, articleIds, deepLinks, capabilities: caps };
      }
    } catch {
      // Seam failed — fall through to the honest fallback below.
    }
  }
  return {
    mode: 'fallback',
    answer: fallbackAnswer(question, hits, caps),
    articleIds,
    deepLinks,
    capabilities: caps,
  };
}

export function createGuideRouter(deps: GuideRoutesDeps = {}): Router {
  const router = express.Router();

  router.get('/guide/articles', (_req, res) => {
    res.json({ ok: true, themes: GUIDE_THEMES, articles: GUIDE_ARTICLES.map(summarize) });
  });

  router.get('/guide/articles/:id', (req, res) => {
    const article = getGuideArticle(req.params.id);
    if (!article) {
      res.status(404).json({ error: `unknown guide article: ${req.params.id}` });
      return;
    }
    res.json({ ok: true, article });
  });

  router.get('/guide/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q.trim()) {
      res.status(400).json({ error: 'q (string) is required' });
      return;
    }
    const hits = searchGuide(q).map((h) => ({ article: summarize(h.article), score: h.score }));
    res.json({ ok: true, query: q, hits });
  });

  router.post('/guide/ask', async (req, res) => {
    const body = (req.body ?? {}) as { question?: unknown };
    if (typeof body.question !== 'string' || !body.question.trim()) {
      res.status(400).json({ error: 'question (string) is required' });
      return;
    }
    try {
      const result = await answerGuideQuestion(deps, body.question.trim());
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
