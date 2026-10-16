// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Minimal markdown preview: escape HTML, then handle headings, lists,
 *  code blocks, inline code, bold, italic, and links. Deliberately small —
 *  no new dependencies. */
function renderMarkdown(src: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = src.split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre class="mono"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
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
      out.push(`<h${h[1].length} class="md-h">${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push('<ul class="md-ul">');
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (line.trim()) out.push(`<p class="md-p">${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push(`<pre class="mono"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return out.join('\n') || '<p class="muted">Nothing to preview yet.</p>';
}

export function NotesPanel({ hideHeader = false }: { hideHeader?: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = (await api('/api/notes')) as Note[];
      setNotes(list);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openNote = (n: Note) => {
    setSelectedId(n.id);
    setTitle(n.title);
    setContent(n.content);
    setDirty(false);
    setPreview(false);
  };

  const newNote = () => {
    setSelectedId(null);
    setTitle('');
    setContent('');
    setDirty(true);
    setPreview(false);
  };

  const save = async () => {
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    setSaving(true);
    try {
      if (selectedId) {
        const updated = (await api(`/api/notes/${encodeURIComponent(selectedId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim(), content }),
        })) as Note;
        setNotes((ns) => ns.map((n) => (n.id === updated.id ? updated : n)).sort((a, b) => b.updatedAt - a.updatedAt));
      } else {
        const created = (await api('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim(), content }),
        })) as Note;
        setNotes((ns) => [created, ...ns]);
        setSelectedId(created.id);
      }
      setDirty(false);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId || !window.confirm('Delete this note?')) return;
    try {
      await api(`/api/notes/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      setNotes((ns) => ns.filter((n) => n.id !== selectedId));
      newNote();
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      {!hideHeader && (
        <div className="row-between">
          <div>
            <h1 className="page-title">Notes</h1>
            <p className="page-sub">Your markdown notes. Stored locally on this server, separate from bot memory.</p>
          </div>
          <button className="btn btn-primary" onClick={newNote}>
            + New note
          </button>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="grid-2">
        <div className="card">
          <strong>All notes ({notes.length})</strong>
          {notes.length === 0 ? (
            <p className="small muted">No notes yet — create one to get started.</p>
          ) : (
            <div className="mt">
              {notes.map((n) => (
                <button
                  key={n.id}
                  className={`btn btn-sm${n.id === selectedId ? ' btn-primary' : ''}`}
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }}
                  onClick={() => openNote(n)}
                >
                  <span className="truncate">{n.title}</span>
                  <br />
                  <span className="small muted">updated {fmtTs(n.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="row-between">
            <strong>{selectedId ? 'Edit note' : 'New note'}</strong>
            <div>
              <button className="btn btn-sm" onClick={() => setPreview((p) => !p)} disabled={!selectedId && !dirty}>
                {preview ? 'Edit' : 'Preview'}
              </button>{' '}
              <button className="btn btn-sm" onClick={remove} disabled={!selectedId}>
                Delete
              </button>
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="note-title">
              Title
            </label>
            <input
              id="note-title"
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
            <div className="card" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
          ) : (
            <div className="field">
              <label className="label" htmlFor="note-content">
                Content (markdown)
              </label>
              <textarea
                id="note-content"
                className="textarea"
                rows={16}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                }}
                placeholder="# Heading&#10;&#10;Write markdown here…"
              />
            </div>
          )}
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? 'Saving…' : dirty ? 'Save note' : 'Saved'}
          </button>
        </div>
      </div>
    </div>
  );
}
