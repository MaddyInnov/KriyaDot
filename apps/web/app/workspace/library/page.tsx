// SPDX-License-Identifier: Apache-2.0
'use client';

// Single Library surface (C-15) inside Workspace — NOT a new top-level
// destination (nav still has exactly six). Tabs unify artifacts, decks,
// generated media and workspace files over /api/library; the System
// Files tab is FL-11 (metadata-only instance data view). The viewer
// edits markdown artifacts and decks in place (FL-14, saved through
// the owning stores, so artifacts gain a new version) and opens media
// in the C-10 viewer with save/download.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../../../lib/api';
import {
  LIBRARY_TABS, canEditInViewer, filterItems, formatBytes, isViewableMedia, kindLabel,
  type LibraryItem, type SystemFileEntry,
} from '../../../lib/library';
import { MediaViewer } from '../../../components/chat/media-viewer';
import { Markdown } from '../../modules/lib';

async function apiJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await authedFetch(path, init);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

interface DeckDetail { id: string; title: string; slides: Array<{ heading: string; bullets: string[]; layout: string; extra: string[]; notes: string }> }

export default function LibraryPage() {
  const [tab, setTab] = useState<string>('all');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [systemFiles, setSystemFiles] = useState<SystemFileEntry[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const lib = (await apiJson('/api/library')) as { items: LibraryItem[] };
      setItems(lib.items);
      const sys = (await apiJson('/api/library/system-files')) as { files: SystemFileEntry[] };
      setSystemFiles(sys.files);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = async (item: LibraryItem) => {
    setSelected(item); setEditing(false); setArtifactContent(null); setDeck(null);
    try {
      if (item.kind === 'artifact') {
        const a = (await apiJson(`/api/modules/artifacts/${item.ref}`)) as { content: string };
        setArtifactContent(a.content);
      } else if (item.kind === 'deck') {
        const d = (await apiJson(`/api/modules/slides/${item.ref}`)) as DeckDetail;
        setDeck(d);
      } else if (item.kind === 'file') {
        const f = (await apiJson(`/api/files/content?path=${encodeURIComponent(item.ref)}`)) as { content: string };
        setArtifactContent(f.content);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      if (selected.kind === 'artifact') {
        await apiJson(`/api/library/artifacts/${selected.ref}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: editText }),
        });
        setArtifactContent(editText);
      } else if (selected.kind === 'deck' && deck) {
        const slides = editText.split('\n').map((l) => l.replace(/^[-# ]+/, '')).filter(Boolean)
          .map((heading) => ({ layout: 'bullets', heading, bullets: [], extra: [], notes: '' }));
        await apiJson(`/api/library/decks/${selected.ref}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: deck.title, slides }),
        });
        await open(selected);
      }
      setEditing(false);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const shown = filterItems(items, tab, q);

  return (
    <div>
      <h1 className="page-title">Library</h1>
      <p className="page-sub">
        Everything KriyaDot made or holds for you — artifacts, decks, media and files in one place.{' '}
        <Link href="/workspace">Back to Workspace</Link>
      </p>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="tabs" role="tablist" aria-label="Library sections">
        {LIBRARY_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <input className="input mt" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library…" aria-label="Search the library" />

      {tab === 'system' ? (
        <div className="card mt">
          <strong>System Files</strong>
          <p className="small muted">What this KriyaDot instance stores locally. Metadata only — contents stay private to the instance.</p>
          {systemFiles.map((f) => (
            <div className="row-between mt" key={f.name}>
              <span className="mono small">{f.name}</span>
              <span className="small muted">{f.category} · {formatBytes(f.sizeBytes)} · {new Date(f.modifiedAt).toLocaleString()}</span>
            </div>
          ))}
          {systemFiles.length === 0 ? <p className="small muted mt">No system files found.</p> : null}
        </div>
      ) : (
        <div className="grid-2 mt">
          {shown.map((item) => (
            <button className="card" key={item.id} onClick={() => void open(item)} style={{ textAlign: 'left' }}>
              <div className="row-between">
                <span className="chip gray">{kindLabel(item.kind)}</span>
                {item.editable ? <span className="small muted">editable</span> : null}
              </div>
              <strong className="mt">{item.title}</strong>
              {item.preview ? <p className="small muted mt">{item.preview}</p> : null}
              <p className="small muted mt">{formatBytes(item.sizeBytes)}</p>
            </button>
          ))}
          {shown.length === 0 ? <p className="small muted">Nothing here yet.</p> : null}
        </div>
      )}

      {selected && tab !== 'system' ? (
        <div className="card mt">
          <div className="row-between">
            <strong>{selected.title}</strong>
            <span className="row">
              {canEditInViewer(selected) && !editing ? (
                <button className="btn btn-sm" onClick={() => { setEditText(selected.kind === 'deck' ? (deck?.slides.map((s) => s.heading).join('\n') ?? '') : (artifactContent ?? '')); setEditing(true); }}>
                  Edit
                </button>
              ) : null}
              <button className="btn btn-sm" onClick={() => setSelected(null)}>Close</button>
            </span>
          </div>
          {editing ? (
            <div className="mt">
              <textarea className="input" rows={12} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Edit content" />
              <p className="small muted mt">{selected.kind === 'artifact' ? 'Saving creates a new version — history is kept.' : 'One slide heading per line.'}</p>
              <div className="mt">
                <button className="btn btn-sm" disabled={busy} onClick={() => void saveEdit()}>{busy ? 'Saving…' : 'Save'}</button>{' '}
                <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : isViewableMedia(selected) ? (
            <div className="mt">
              <MediaViewer media={{ url: selected.kind === 'file' ? `/api/files/content?path=${encodeURIComponent(selected.ref)}` : selected.preview?.split('·').pop()?.trim() ?? '', mimeType: selected.mimeType, title: selected.title }} />
            </div>
          ) : deck ? (
            <div className="mt">
              {deck.slides.map((s, i) => (
                <div key={i} className="mt"><strong>{s.heading || '(untitled)'}</strong>
                  {s.bullets.map((b, j) => <p className="small" key={j}>• {b}</p>)}
                </div>
              ))}
            </div>
          ) : artifactContent !== null ? (
            <div className="mt"><Markdown src={artifactContent} /></div>
          ) : (
            <p className="small muted mt">Loading…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
