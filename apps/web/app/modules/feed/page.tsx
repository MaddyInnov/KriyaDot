// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, Markdown, useModuleData } from '../lib';

interface FeedBrief {
  brief: string;
  updatedAt: number;
}

interface FeedSource {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

interface FeedPost {
  id: string;
  title: string;
  body: string;
  sourceNote: string | null;
  dismissed: boolean;
  createdAt: number;
  sources?: FeedSource[];
  seed?: boolean;
  seen?: boolean;
  actionable?: boolean;
  deadlineAt?: number | null;
}

interface DiscussPayload {
  prompt: string;
  contextRef: string;
}

export default function FeedPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [usefulness, setUsefulness] = useState(false);
  const loadPosts = useCallback(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (usefulness) params.set('order', 'usefulness');
    const qs = params.toString();
    return api(`${MODULES_BASE}/feed/posts${qs ? `?${qs}` : ''}`) as Promise<FeedPost[]>;
  }, [query, usefulness]);
  const { data: posts, error, refresh } = useModuleData(loadPosts);
  const [brief, setBrief] = useState('');
  const [briefLoaded, setBriefLoaded] = useState(false);
  const [briefMsg, setBriefMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [reacted, setReacted] = useState<Record<string, string>>({});

  const loadBrief = useCallback(async () => {
    try {
      const b = (await api(`${MODULES_BASE}/feed/brief`)) as FeedBrief;
      setBrief(b.brief ?? '');
      setBriefLoaded(true);
    } catch {
      setBriefLoaded(true);
    }
  }, []);
  useEffect(() => {
    void loadBrief();
  }, [loadBrief]);

  const saveBrief = async () => {
    setBusy(true);
    try {
      const saved = (await api(`${MODULES_BASE}/feed/brief`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief }),
      })) as FeedBrief & { generated?: number };
      setBriefMsg(
        saved.generated && saved.generated > 0
          ? `Brief saved — ${saved.generated} fresh post${saved.generated === 1 ? '' : 's'} generated.`
          : 'Brief saved.',
      );
      refresh();
    } catch (err) {
      setBriefMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    try {
      await api(`${MODULES_BASE}/feed/posts/generate`, { method: 'POST' });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (id: string) => {
    await api(`${MODULES_BASE}/feed/posts/${id}/dismiss`, { method: 'POST' });
    refresh();
  };

  const react = async (id: string, reaction: 'like' | 'dislike') => {
    await api(`${MODULES_BASE}/feed/posts/${id}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction }),
    });
    setReacted((r) => ({ ...r, [id]: reaction }));
  };

  const discuss = async (id: string) => {
    const payload = (await api(`${MODULES_BASE}/feed/posts/${id}/discuss`, { method: 'POST' })) as DiscussPayload;
    try {
      sessionStorage.setItem('mvp:chat-prefill', payload.prompt);
      sessionStorage.setItem('mvp:chat-context-ref', payload.contextRef);
    } catch {
      // sessionStorage unavailable — navigation still happens.
    }
    router.push('/');
  };

  const visible = (posts ?? []).filter((p) => !p.dismissed);

  return (
    <div>
      <PageHeader
        title="Feed"
        sub="Your proactive feed: a stored brief plus background-generated posts."
        onRefresh={refresh}
      />
      <ErrorBox error={error} />

      <div className="card">
        <strong>Your brief</strong>
        <p className="small muted">What should the feed watch for? The generator uses this to pick posts.</p>
        <textarea
          className="input mt"
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={briefLoaded ? 'e.g. AI agent frameworks, TypeScript, indie hacking…' : 'Loading…'}
        />
        <div className="row-between mt">
          <span className="small muted">{briefMsg}</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void saveBrief()}>
            Save brief
          </button>
        </div>
      </div>

      <div className="row-between mt">
        <strong>{visible.length} posts</strong>
        <button className="btn btn-sm" disabled={busy} onClick={() => void generate()}>
          Generate posts
        </button>
      </div>

      <div className="row-between mt">
        <input
          className="input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search past posts…"
          aria-label="Search past posts"
        />
        <label className="small">
          <input type="checkbox" checked={usefulness} onChange={(e) => setUsefulness(e.target.checked)} /> Most
          useful first
        </label>
      </div>

      <div className="grid-2 mt">
        {visible.map((p) => (
          <div className="card" key={p.id}>
            <div className="row-between">
              <strong>{p.title}</strong>
              <span className="small muted">{fmtTs(p.createdAt)}</span>
            </div>
            {p.seed && <p className="small muted">Starter post</p>}
            <div className="mt small">
              <Markdown src={p.body} />
            </div>
            {p.sourceNote && <p className="small muted mt">Source: {p.sourceNote}</p>}
            {p.sources && p.sources.length > 0 && (
              <div className="mt small">
                {p.sources.map((s) => (
                  <div key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title || s.url}
                    </a>{' '}
                    <span className="muted">({s.source})</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt">
              <button
                className="btn btn-sm"
                disabled={reacted[p.id] === 'like'}
                onClick={() => void react(p.id, 'like')}
              >
                {reacted[p.id] === 'like' ? 'Liked' : 'Like'}
              </button>{' '}
              <button
                className="btn btn-sm"
                disabled={reacted[p.id] === 'dislike'}
                onClick={() => void react(p.id, 'dislike')}
              >
                {reacted[p.id] === 'dislike' ? 'Disliked' : 'Dislike'}
              </button>{' '}
              <button className="btn btn-sm" onClick={() => void discuss(p.id)}>
                Discuss
              </button>{' '}
              <button className="btn btn-sm" onClick={() => void dismiss(p.id)}>
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
      {visible.length === 0 && <EmptyState text="No posts yet. Save a brief, then hit Generate posts." />}
    </div>
  );
}
