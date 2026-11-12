// SPDX-License-Identifier: Apache-2.0
'use client';

// Parked-ideas notebook (B6) — a quiet notebook, not a dashboard.
// Ideas parked here are inert: nothing in this panel (or anywhere) runs
// them. The single bridge to work is the explicit "Action this idea"
// button, which creates a normal task and links it back. When such a
// task completes, the idea grows an outcome slot so past ideas visibly
// show whether they paid off.

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

export interface ParkedIdea {
  id: string;
  title: string;
  body: string;
  source: 'manual' | 'chat';
  state: 'parked' | 'actioned' | 'archived';
  createdAt: number;
  updatedAt: number;
  taskId?: string;
  actionedAt?: number;
  outcome?: { text: string; completedAt: number; taskId: string };
  outcomePending?: boolean;
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function IdeasPanel({ hideHeader = false }: { hideHeader?: boolean }) {
  const [ideas, setIdeas] = useState<ParkedIdea[]>([]);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [outcomeDrafts, setOutcomeDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const rows = (await api('/api/parked-ideas')) as ParkedIdea[];
      setIdeas(rows);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const replace = (updated: ParkedIdea) =>
    setIdeas((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));

  const park = async () => {
    if (!title.trim()) {
      setError('An idea needs a title.');
      return;
    }
    try {
      const created = (await api('/api/parked-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: body.trim() || undefined, source: 'manual' }),
      })) as ParkedIdea;
      setIdeas((rows) => [created, ...rows]);
      setTitle('');
      setBody('');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const action = async (idea: ParkedIdea) => {
    try {
      const result = (await api(`/api/parked-ideas/${encodeURIComponent(idea.id)}/action`, {
        method: 'POST',
      })) as { idea: ParkedIdea; task: { id: string } };
      replace(result.idea);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void refresh();
    }
  };

  const setState = async (idea: ParkedIdea, state: 'parked' | 'archived') => {
    try {
      const updated = (await api(`/api/parked-ideas/${encodeURIComponent(idea.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      })) as ParkedIdea;
      replace(updated);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (idea: ParkedIdea) => {
    try {
      await api(`/api/parked-ideas/${encodeURIComponent(idea.id)}`, { method: 'DELETE' });
      setIdeas((rows) => rows.filter((r) => r.id !== idea.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveOutcome = async (idea: ParkedIdea) => {
    const text = (outcomeDrafts[idea.id] ?? '').trim();
    if (!text) {
      setError('Write the outcome first — even "went nowhere" counts.');
      return;
    }
    try {
      const updated = (await api(`/api/parked-ideas/${encodeURIComponent(idea.id)}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })) as ParkedIdea;
      replace(updated);
      setOutcomeDrafts((d) => ({ ...d, [idea.id]: '' }));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      {!hideHeader && (
        <>
          <h1 className="page-title">Ideas</h1>
          <p className="page-sub">
            A notebook for ideas you are not working on yet. Nothing here runs on its own — an idea
            becomes work only when you action it.
          </p>
        </>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="field">
          <label className="label" htmlFor="idea-title">
            Park an idea
          </label>
          <input
            id="idea-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Idea title"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void park();
            }}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="idea-body">
            Notes (optional)
          </label>
          <input
            id="idea-body"
            className="input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Why it might matter, context, links…"
          />
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => void park()}>
          Park idea
        </button>
      </div>

      <div className="mt">
        {ideas.length === 0 ? (
          <p className="small muted">No parked ideas yet. Park one above, or ask a bot to park an idea from chat.</p>
        ) : (
          ideas.map((idea) => (
            <div key={idea.id} className="card" style={{ marginTop: 8 }}>
              <div className="row-between">
                <div>
                  <strong>{idea.title}</strong>{' '}
                  <span className="chip">{idea.state}</span>{' '}
                  <span className="chip">{idea.source === 'chat' ? 'from chat' : 'manual'}</span>
                  <div className="small muted">Parked {fmtDay(idea.createdAt)}</div>
                </div>
                <div>
                  {idea.state === 'parked' && (
                    <button className="btn btn-sm btn-primary" onClick={() => void action(idea)}>
                      Action this idea
                    </button>
                  )}{' '}
                  {idea.state === 'parked' && (
                    <button className="btn btn-sm" onClick={() => void setState(idea, 'archived')}>
                      Archive
                    </button>
                  )}
                  {idea.state === 'archived' && (
                    <button className="btn btn-sm" onClick={() => void setState(idea, 'parked')}>
                      Unarchive
                    </button>
                  )}{' '}
                  <button className="btn btn-sm" onClick={() => void remove(idea)}>
                    Delete
                  </button>
                </div>
              </div>
              {idea.body && <p className="small">{idea.body}</p>}
              {idea.state === 'actioned' && idea.taskId && (
                <p className="small muted">
                  Actioned as a task (<a href="/tasks">see Tasks</a>).
                </p>
              )}
              {idea.outcome && !idea.outcomePending && (
                <p className="small">
                  <strong>Outcome:</strong> {idea.outcome.text}{' '}
                  <span className="muted">(task finished {fmtDay(idea.outcome.completedAt)})</span>
                </p>
              )}
              {idea.outcomePending && (
                <div className="field">
                  <label className="label" htmlFor={`outcome-${idea.id}`}>
                    The task finished — how did this idea turn out?
                  </label>
                  <div className="row-between">
                    <input
                      id={`outcome-${idea.id}`}
                      className="input"
                      style={{ flex: 1, marginRight: 8 }}
                      value={outcomeDrafts[idea.id] ?? ''}
                      onChange={(e) => setOutcomeDrafts((d) => ({ ...d, [idea.id]: e.target.value }))}
                      placeholder="Paid off? Went nowhere? What happened?"
                    />
                    <button className="btn btn-sm btn-primary" onClick={() => void saveOutcome(idea)}>
                      Save outcome
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
