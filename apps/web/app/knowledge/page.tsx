// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';
import { GraphView, type GraphNode, type GraphEdge } from '../../components/knowledge/graph-view';
import { QuickSwitcher } from '../../components/knowledge/quick-switcher';
import { EntityTrace } from '../../components/knowledge/entity-trace';

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

const api = (path: string, init?: RequestInit): Promise<any> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json();
  });

/** Minimal markdown preview (same approach as notes-panel). */
function renderMarkdown(src: string, openNote: (title: string) => void): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Wiki-links → clickable spans (handled via data attributes + delegation).
  const withWiki = esc(src).replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) =>
      `<a href="#" data-wiki="${esc(target.trim())}" class="wiki-link">${esc((alias ?? target).trim())}</a>`,
  );
  const inline = (s: string): string =>
    s
      .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|\s)(#[A-Za-z0-9][A-Za-z0-9_-]*)/g, '$1<span class="tag-pill">$2</span>');
  const lines = withWiki.split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre class="mono"><code>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    out.push(line.trim() ? `<p>${inline(line)}</p>` : '');
  }
  if (inList) out.push('</ul>');
  void openNote;
  return out.join('\n');
}

export default function KnowledgePage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [backlinks, setBacklinks] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // [[ autocomplete state
  const [acOpen, setAcOpen] = useState(false);
  const [acQuery, setAcQuery] = useState('');
  const [acCursor, setAcCursor] = useState(0);
  const [acAnchor, setAcAnchor] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const [n, t, g] = await Promise.all([
        api('/api/notes'),
        api('/api/notes/tags'),
        api('/api/notes/graph'),
      ]);
      setNotes(n);
      setTags(t.tags ?? {});
      setGraph(g);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Global Cmd+K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcherOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectNote = useCallback(
    async (id: string) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      setSelectedId(id);
      setTitle(note.title);
      setContent(note.content);
      setDirty(false);
      setPreview(false);
      try {
        setBacklinks(await api(`/api/notes/${id}/backlinks`));
      } catch {
        setBacklinks([]);
      }
    },
    [notes],
  );

  const openByTitle = useCallback(
    (targetTitle: string) => {
      const found = notes.find(
        (n) => n.title.trim().toLowerCase() === targetTitle.trim().toLowerCase(),
      );
      if (found) selectNote(found.id);
    },
    [notes, selectNote],
  );

  const save = async (): Promise<void> => {
    if (!dirty) return;
    setSaving(true);
    try {
      if (selectedId) {
        await api(`/api/notes/${selectedId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, content }),
        });
      } else {
        const created: Note = await api('/api/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: title || 'Untitled', content }),
        });
        setSelectedId(created.id);
      }
      setDirty(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const newNote = (): void => {
    setSelectedId(null);
    setTitle('');
    setContent('');
    setDirty(false);
    setPreview(false);
    setBacklinks([]);
  };

  const openDaily = async (): Promise<void> => {
    try {
      const note: Note = await api('/api/notes/daily', { method: 'POST' });
      await load();
      selectNote(note.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (): Promise<void> => {
    if (!selectedId || !confirm('Delete this note?')) return;
    try {
      await api(`/api/notes/${selectedId}`, { method: 'DELETE' });
      newNote();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- [[ autocomplete -------------------------------------------------
  const acMatches = (() => {
    const q = acQuery.toLowerCase();
    const scored = notes
      .filter((n) => n.id !== selectedId)
      .map((n) => ({
        n,
        score: q === '' ? 1 : n.title.toLowerCase().startsWith(q) ? 3 : n.title.toLowerCase().includes(q) ? 2 : 0,
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.n.title.localeCompare(b.n.title));
    return scored.slice(0, 8).map((s) => s.n);
  })();

  const onContentChange = (value: string, caret: number): void => {
    setContent(value);
    setDirty(true);
    // Detect [[query right before the caret.
    const before = value.slice(0, caret);
    const m = /\[\[([^\][\n]*)$/.exec(before);
    if (m) {
      setAcOpen(true);
      setAcQuery(m[1]);
      setAcCursor(0);
      setAcAnchor(caret - m[1].length);
    } else {
      setAcOpen(false);
      setAcAnchor(null);
    }
  };

  const applyAc = (noteTitle: string, createIfMissing: boolean): void => {
    if (acAnchor === null) return;
    const before = content.slice(0, acAnchor - 2); // drop the [[
    const after = content.slice(textareaRef.current?.selectionStart ?? content.length);
    const next = `${before}[[${noteTitle}]]${after}`;
    setContent(next);
    setDirty(true);
    setAcOpen(false);
    setAcAnchor(null);
    if (createIfMissing) {
      api('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: noteTitle, content: '' }),
      })
        .then(() => load())
        .catch(() => {});
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // ---- filtering -------------------------------------------------------
  const filtered = notes.filter((n) => {
    if (activeTag) {
      const ids = tags[activeTag] ?? [];
      if (!ids.includes(n.id)) return false;
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
    }
    return true;
  });

  const tagList = Object.entries(tags).sort((a, b) => b[1].length - a[1].length);

  const previewHtml = renderMarkdown(content, openByTitle);

  return (
    <div className="page">
      <div className="row-between">
        <div>
          <h1 className="page-title">Knowledge</h1>
          <p className="page-sub">
            Obsidian-style notes: <code className="mono">[[wiki-links]]</code>, backlinks, tags, graph, daily notes.
            Press <kbd>Ctrl/⌘ K</kbd> to jump.
          </p>
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => setView(view === 'list' ? 'graph' : 'list')}>
            {view === 'list' ? '🕸 Graph view' : '📝 List view'}
          </button>
          <button className="btn btn-sm" onClick={openDaily}>
            📅 Daily note
          </button>
          <button className="btn btn-sm btn-primary" onClick={newNote}>
            + New note
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {view === 'graph' ? (
        <div className="card mt">
          <GraphView
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={selectedId}
            onSelect={(id) => {
              selectNote(id);
              setView('list');
            }}
          />
        </div>
      ) : (
        <div className="grid-knowledge mt">
          {/* Sidebar */}
          <div className="card">
            <div className="field">
              <input
                className="input"
                placeholder="Search notes…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {tagList.length > 0 && (
              <div className="tag-row">
                {tagList.map(([tag, ids]) => (
                  <button
                    key={tag}
                    className={`tag-pill${activeTag === tag ? ' active' : ''}`}
                    onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                    title={`${ids.length} note${ids.length === 1 ? '' : 's'}`}
                  >
                    #{tag} <span className="muted">{ids.length}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt">
              {filtered.length === 0 && (
                <p className="small muted">No notes match.</p>
              )}
              {filtered.map((n) => (
                <button
                  key={n.id}
                  className={`btn btn-sm note-row${n.id === selectedId ? ' btn-primary' : ''}`}
                  onClick={() => selectNote(n.id)}
                >
                  <span className="truncate">{n.title}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Editor */}
          <div className="card">
            <div className="row-between">
              <h2 className="card-title">{selectedId ? 'Edit note' : 'New note'}</h2>
              <div className="row">
                <button className="btn btn-sm" onClick={() => setPreview((p) => !p)}>
                  {preview ? '✏️ Edit' : '👁 Preview'}
                </button>
                <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || saving}>
                  {saving ? 'Saving…' : '💾 Save'}
                </button>
                <button className="btn btn-sm" onClick={remove} disabled={!selectedId}>
                  🗑
                </button>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="k-title">Title</label>
              <input
                id="k-title"
                className="input"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
                placeholder="Note title"
              />
            </div>
            {preview ? (
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
                onClick={(e) => {
                  const el = (e.target as HTMLElement).closest('[data-wiki]');
                  if (el) {
                    e.preventDefault();
                    openByTitle(el.getAttribute('data-wiki') ?? '');
                  }
                }}
              />
            ) : (
              <div className="field ac-wrap">
                <label className="label" htmlFor="k-content">
                  Content <span className="muted small">(markdown, [[links]], #tags)</span>
                </label>
                <textarea
                  id="k-content"
                  ref={textareaRef}
                  className="input mono"
                  rows={18}
                  value={content}
                  onChange={(e) => onContentChange(e.target.value, e.target.selectionStart ?? 0)}
                  onKeyDown={(e) => {
                    if (acOpen) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setAcCursor((c) => Math.min(c + 1, acMatches.length - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setAcCursor((c) => Math.max(c - 1, 0));
                      } else if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault();
                        const pick = acMatches[acCursor];
                        if (pick) applyAc(pick.title, false);
                        else if (acQuery.trim()) applyAc(acQuery.trim(), true);
                      } else if (e.key === 'Escape') {
                        setAcOpen(false);
                      }
                    }
                  }}
                  placeholder="Write markdown… type [[ to link another note"
                />
                {acOpen && (
                  <div className="ac-dropdown card">
                    {acMatches.map((n, i) => (
                      <button
                        key={n.id}
                        className={`qs-item${i === acCursor ? ' active' : ''}`}
                        onMouseEnter={() => setAcCursor(i)}
                        onClick={() => applyAc(n.title, false)}
                      >
                        <span className="truncate">{n.title}</span>
                      </button>
                    ))}
                    {acQuery.trim() &&
                      !acMatches.some(
                        (n) => n.title.toLowerCase() === acQuery.trim().toLowerCase(),
                      ) && (
                        <button
                          className="qs-item qs-create"
                          onClick={() => applyAc(acQuery.trim(), true)}
                        >
                          <span className="truncate">+ Create “{acQuery.trim()}”</span>
                        </button>
                      )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Backlinks */}
          <div className="card">
            <h2 className="card-title">🔗 Linked mentions</h2>
            <p className="small muted">Notes linking to this one.</p>
            <div className="mt">
              {backlinks.length === 0 && (
                <p className="small muted">No backlinks yet.</p>
              )}
              {backlinks.map((b) => (
                <button
                  key={b.id}
                  className="btn btn-sm note-row"
                  onClick={() => selectNote(b.id)}
                >
                  <span className="truncate">{b.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <QuickSwitcher
        open={switcherOpen}
        notes={notes}
        onClose={() => setSwitcherOpen(false)}
        onSelect={selectNote}
        onCreate={async (t) => {
          const created: Note = await api('/api/notes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: t, content: '' }),
          });
          await load();
          selectNote(created.id);
        }}
      />

      {/* Entity tracing (lite): cross-source entity search over the knowledge base + memory */}
      <EntityTrace />
    </div>
  );
}
