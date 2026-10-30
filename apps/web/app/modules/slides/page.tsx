// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { MODULES_BASE, api, PageHeader, ErrorBox, EmptyState } from '../lib';
import { authedFetch } from '../../../lib/api';

interface Slide {
  id: string;
  layout: 'title' | 'bullets' | 'two-column' | 'image';
  heading: string;
  bullets: string[];
  extra: string[];
  notes: string;
}

interface SlideDeck {
  id: string;
  title: string;
  slides: Slide[];
  createdAt: number;
  updatedAt: number;
}

const LAYOUTS = ['title', 'bullets', 'two-column', 'image'] as const;

function blankSlide(): Slide {
  return { id: '', layout: 'bullets', heading: '', bullets: [''], extra: [], notes: '' };
}

export default function SlidesPage() {
  const [decks, setDecks] = useState<SlideDeck[]>([]);
  const [selected, setSelected] = useState<SlideDeck | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const load = useCallback(async () => {
    try {
      const d = (await api(`${MODULES_BASE}/slides`)) as SlideDeck[];
      setDecks(d);
      if (selected) {
        const fresh = d.find((x) => x.id === selected.id);
        if (fresh) setSelected(fresh);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, []);

  const createDeck = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const d = (await api(`${MODULES_BASE}/slides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), slides: [] }),
      })) as SlideDeck;
      setNewTitle('');
      setDecks((prev) => [d, ...prev]);
      setSelected(d);
      setActiveIdx(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveDeck = async (deck: SlideDeck) => {
    setBusy(true);
    try {
      const d = (await api(`${MODULES_BASE}/slides/${deck.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: deck.title, slides: deck.slides }),
      })) as SlideDeck;
      setSelected(d);
      setDecks((prev) => prev.map((x) => (x.id === d.id ? d : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteDeck = async (id: string) => {
    if (!confirm('Delete this deck?')) return;
    await api(`${MODULES_BASE}/slides/${id}`, { method: 'DELETE' });
    setDecks((prev) => prev.filter((x) => x.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const exportDeck = async (format: 'html' | 'markdown' | 'pptx') => {
    if (!selected) return;
    const slug = selected.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    if (format === 'pptx') {
      // Binary download — the JSON `api()` helper cannot carry it.
      const res = await authedFetch(`${MODULES_BASE}/slides/${selected.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const res = (await api(`${MODULES_BASE}/slides/${selected.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format }),
    })) as { format: string; content: string };
    const blob = new Blob([res.content], { type: format === 'html' ? 'text/html' : 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}.${format === 'html' ? 'html' : 'md'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateSlide = (idx: number, patch: Partial<Slide>) => {
    if (!selected) return;
    const slides = selected.slides.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    setSelected({ ...selected, slides });
  };

  const addSlide = () => {
    if (!selected) return;
    setSelected({ ...selected, slides: [...selected.slides, blankSlide()] });
    setActiveIdx(selected.slides.length);
  };

  const removeSlide = (idx: number) => {
    if (!selected) return;
    setSelected({ ...selected, slides: selected.slides.filter((_, i) => i !== idx) });
    setActiveIdx(Math.max(0, idx - 1));
  };

  const moveSlide = (idx: number, dir: -1 | 1) => {
    if (!selected) return;
    const j = idx + dir;
    if (j < 0 || j >= selected.slides.length) return;
    const slides = [...selected.slides];
    [slides[idx], slides[j]] = [slides[j], slides[idx]];
    setSelected({ ...selected, slides });
    setActiveIdx(j);
  };

  const active = selected?.slides[activeIdx] ?? null;

  return (
    <div>
      <PageHeader title="Slides" sub="Build and export presentation decks" />
      {error && <ErrorBox error={error} />}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="row">
          <input
            className="input"
            placeholder="New deck title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createDeck()}
          />
          <button className="btn primary" onClick={createDeck} disabled={busy || !newTitle.trim()}>
            New deck
          </button>
        </div>
      </div>

      {decks.length === 0 ? (
        <EmptyState text="No decks yet. Create a deck above, or ask the agent to build one with create_slides." />
      ) : (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div className="card" style={{ minWidth: '220px' }}>
            <h3>Decks</h3>
            {decks.map((d) => (
              <div
                key={d.id}
                className={`deck-item${selected?.id === d.id ? ' active' : ''}`}
                onClick={() => {
                  setSelected(d);
                  setActiveIdx(0);
                  setPreview(false);
                }}
              >
                <strong>{d.title}</strong>
                <span className="muted small">{d.slides.length} slides</span>
              </div>
            ))}
          </div>

          {selected && (
            <div className="card" style={{ flex: 1 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <input
                  className="input"
                  value={selected.title}
                  onChange={(e) => setSelected({ ...selected, title: e.target.value })}
                  style={{ fontSize: '1.2rem', fontWeight: 600 }}
                />
                <div className="row">
                  <button className="btn small" onClick={() => setPreview(!preview)}>
                    {preview ? 'Edit' : 'Preview'}
                  </button>
                  <button className="btn small" onClick={() => exportDeck('html')}>
                    Export HTML
                  </button>
                  <button className="btn small" onClick={() => exportDeck('markdown')}>
                    Export MD
                  </button>
                  <button className="btn small" onClick={() => exportDeck('pptx')}>
                    Export PPTX
                  </button>
                  <button className="btn small" onClick={() => saveDeck(selected)} disabled={busy}>
                    Save
                  </button>
                  <button className="btn small danger" onClick={() => deleteDeck(selected.id)}>
                    Delete
                  </button>
                </div>
              </div>

              {preview ? (
                <div className="slide-preview">
                  {selected.slides.length === 0 && <p className="muted">No slides yet.</p>}
                  {selected.slides.map((s, i) => (
                    <div key={s.id || i} className="slide-card">
                      <div className="muted small">
                        {i + 1} · {s.layout}
                      </div>
                      <h2>{s.heading || '(untitled)'}</h2>
                      <ul>
                        {s.bullets.filter(Boolean).map((b, j) => (
                          <li key={j}>{b}</li>
                        ))}
                      </ul>
                      {s.layout === 'two-column' && s.extra.length > 0 && (
                        <ul>
                          {s.extra.filter(Boolean).map((b, j) => (
                            <li key={j}>{b}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="row" style={{ margin: '0.75rem 0' }}>
                    {selected.slides.map((s, i) => (
                      <button
                        key={s.id || i}
                        className={`btn small${i === activeIdx ? ' primary' : ''}`}
                        onClick={() => setActiveIdx(i)}
                        title={s.heading || `Slide ${i + 1}`}
                      >
                        {i + 1}
                      </button>
                    ))}
                    <button className="btn small" onClick={addSlide}>
                      + Add slide
                    </button>
                  </div>

                  {active ? (
                    <div className="slide-editor">
                      <div className="row">
                        <select
                          className="select"
                          value={active.layout}
                          onChange={(e) => updateSlide(activeIdx, { layout: e.target.value as Slide['layout'] })}
                        >
                          {LAYOUTS.map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                        <button className="btn small" onClick={() => moveSlide(activeIdx, -1)}>
                          ←
                        </button>
                        <button className="btn small" onClick={() => moveSlide(activeIdx, 1)}>
                          →
                        </button>
                        <button className="btn small danger" onClick={() => removeSlide(activeIdx)}>
                          Remove
                        </button>
                      </div>
                      <input
                        className="input"
                        placeholder="Heading"
                        value={active.heading}
                        onChange={(e) => updateSlide(activeIdx, { heading: e.target.value })}
                      />
                      <label className="muted small">Bullets (one per line)</label>
                      <textarea
                        className="input"
                        rows={4}
                        value={active.bullets.join('\n')}
                        onChange={(e) => updateSlide(activeIdx, { bullets: e.target.value.split('\n') })}
                      />
                      {active.layout === 'two-column' && (
                        <>
                          <label className="muted small">Right column (one per line)</label>
                          <textarea
                            className="input"
                            rows={3}
                            value={active.extra.join('\n')}
                            onChange={(e) => updateSlide(activeIdx, { extra: e.target.value.split('\n') })}
                          />
                        </>
                      )}
                      {active.layout === 'image' && (
                        <>
                          <label className="muted small">Image URL</label>
                          <input
                            className="input"
                            value={active.extra[0] ?? ''}
                            onChange={(e) => updateSlide(activeIdx, { extra: [e.target.value] })}
                          />
                        </>
                      )}
                      <label className="muted small">Speaker notes</label>
                      <textarea
                        className="input"
                        rows={2}
                        value={active.notes}
                        onChange={(e) => updateSlide(activeIdx, { notes: e.target.value })}
                      />
                    </div>
                  ) : (
                    <p className="muted">Add a slide to get started.</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
