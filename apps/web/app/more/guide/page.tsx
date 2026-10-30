// SPDX-License-Identifier: Apache-2.0
'use client';

// User Guide (closure addendum ADD-3): task-based walkthroughs under
// the More area — NOT a seventh destination. Article list grouped by
// theme, an article reader with deep-link buttons to the exact
// screens, guide search, a "How do I…?" ask box, and the first-run
// tour (auto-shows once; replayable from here).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../../../lib/api';
import { GuideTour } from '../../../components/guide/tour';

interface DeepLink {
  label: string;
  href: string;
}

interface ArticleSummary {
  id: string;
  title: string;
  theme: string;
  audience: string;
  summary: string;
  relatedCapabilities: string[];
  stepCount: number;
  deepLinks: DeepLink[];
}

interface GuideStep {
  title: string;
  body: string;
  deepLink?: DeepLink;
}

interface GuideArticle extends ArticleSummary {
  steps: GuideStep[];
  keywords: string[];
}

interface AskResult {
  mode: 'llm' | 'fallback';
  answer: string;
  articleIds: string[];
  deepLinks: DeepLink[];
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

export default function GuidePage() {
  const [themes, setThemes] = useState<string[]>([]);
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [selected, setSelected] = useState<GuideArticle | null>(null);
  const [error, setError] = useState('');

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ArticleSummary[] | null>(null);

  const [question, setQuestion] = useState('');
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);

  const [tourKey, setTourKey] = useState(0);

  const openArticle = useCallback(async (id: string) => {
    try {
      const body = (await api(`/api/guide/articles/${encodeURIComponent(id)}`)) as { article: GuideArticle };
      setSelected(body.article);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const body = (await api('/api/guide/articles')) as { themes: string[]; articles: ArticleSummary[] };
        setThemes(body.themes);
        setArticles(body.articles);
        const hash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
        if (hash && body.articles.some((a) => a.id === hash)) void openArticle(hash);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [openArticle]);

  const grouped = useMemo(() => {
    const list = hits ?? articles;
    const order = [...themes];
    for (const a of list) if (!order.includes(a.theme)) order.push(a.theme);
    return order
      .map((theme) => ({ theme, items: list.filter((a) => a.theme === theme) }))
      .filter((g) => g.items.length > 0);
  }, [articles, hits, themes]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    try {
      const body = (await api(`/api/guide/search?q=${encodeURIComponent(q)}`)) as {
        hits: Array<{ article: ArticleSummary; score: number }>;
      };
      setHits(body.hits.map((h) => h.article));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runAsk = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    try {
      const body = (await api('/api/guide/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })) as AskResult & { ok: boolean };
      setAsk(body);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div>
      <div className="row-between">
        <div>
          <h1 className="page-title">User Guide</h1>
          <p className="page-sub">
            Task-based walkthroughs written against the real product — every step names the screen
            and button it means, and the buttons take you straight there.
          </p>
        </div>
        <button className="btn" onClick={() => setTourKey((k) => k + 1)}>
          Replay the tour
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}

      <GuideTour key={tourKey} forceOpen={tourKey > 0} />

      <div className="card mt">
        <strong>How do I…?</strong>
        <p className="small muted mt">
          Ask in plain words. The answer comes from this guide (and, when your instance has a model
          configured, from your Chief working from the same content) with buttons to the exact
          screens.
        </p>
        <div className="mt" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '1 1 320px' }}
            placeholder="e.g. How do I make something run while my PC is off?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runAsk();
            }}
            aria-label="Ask the guide a question"
          />
          <button className="btn btn-primary" onClick={() => void runAsk()} disabled={asking}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
        {ask && (
          <div className="mt" data-testid="guide-ask-result">
            <p className="small muted">
              {ask.mode === 'llm'
                ? 'Answered by your Chief, from the guide content below.'
                : 'Answered directly from the guide content (no model seam configured on this instance).'}
            </p>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
              {ask.answer}
            </div>
            {ask.deepLinks.length > 0 && (
              <div className="mt" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {ask.deepLinks.map((l) => (
                  <Link key={l.href} className="btn btn-sm btn-primary" href={l.href}>
                    {l.label} →
                  </Link>
                ))}
              </div>
            )}
            {ask.articleIds.length > 0 && (
              <div className="mt" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {ask.articleIds.map((id) => (
                  <button key={id} className="btn btn-sm" onClick={() => void openArticle(id)}>
                    Read: {articles.find((a) => a.id === id)?.title ?? id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card mt">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '1 1 320px' }}
            placeholder="Search the guide…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            aria-label="Search the guide"
          />
          <button className="btn" onClick={() => void runSearch()}>
            Search
          </button>
          {hits !== null && (
            <button
              className="btn"
              onClick={() => {
                setHits(null);
                setQuery('');
              }}
            >
              Show all articles
            </button>
          )}
        </div>
        {hits !== null && hits.length === 0 && (
          <p className="small muted mt">No articles match that search — try the “How do I…?” box above.</p>
        )}
      </div>

      {selected ? (
        <div className="card mt" data-testid="guide-article-reader">
          <div className="row-between">
            <strong>{selected.title}</strong>
            <button className="btn btn-sm" onClick={() => setSelected(null)}>
              ← All articles
            </button>
          </div>
          <p className="small muted mt">
            {selected.theme} · For: {selected.audience}
          </p>
          <p className="small">{selected.summary}</p>
          <ol style={{ paddingLeft: 20 }}>
            {selected.steps.map((s, i) => (
              <li key={i} className="small" style={{ marginBottom: 10 }}>
                <strong>{s.title}</strong>
                <br />
                {s.body}
                {s.deepLink && (
                  <>
                    {' '}
                    <Link className="btn btn-sm" href={s.deepLink.href}>
                      {s.deepLink.label} →
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ol>
          <p className="small muted">Covers: {selected.relatedCapabilities.join(', ')}</p>
        </div>
      ) : (
        grouped.map((g) => (
          <div key={g.theme} className="mt">
            <h3>{g.theme}</h3>
            <div className="grid-2">
              {g.items.map((a) => (
                <div className="card" key={a.id}>
                  <div className="row-between">
                    <strong>{a.title}</strong>
                    <span className="small muted">{a.stepCount} steps</span>
                  </div>
                  <p className="small muted mt">{a.summary}</p>
                  <div className="mt">
                    <button className="btn btn-sm" onClick={() => void openArticle(a.id)}>
                      Read walkthrough →
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
