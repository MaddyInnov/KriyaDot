// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Memory finishes panel (Muse parity audit §4.4: MEM-4/5/6/7/9).
 *
 * One search box over memory + main chat + channel side chats (MEM-4);
 * click a memory result to open its explain view — provenance,
 * superseded-by chain, confidence (MEM-5). Below: maintained people &
 * group pages ordered by closeness (MEM-9), the guided paste-import
 * (prompt-out / markdown-in, MEM-6) and the ZIP chat-export intake
 * (MEM-7). Talks to the memory-goals finishes router mounted at
 * /api/memory-goals (see the Wave-5 wiring note).
 */

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

const BASE = '/api/memory-goals';

interface MergedResult {
  kind: 'memory' | 'chat' | 'side-chat';
  id: string;
  title: string;
  excerpt: string;
  score: number;
}
interface Explanation {
  atom: { id: string; fact: string };
  provenance: { sourceTurn: string; quote: string | null; quoteSource: string | null; grounding: string | null; evidenceLinks: string[]; category: string; tier: string };
  confidence: { value: number; label: string };
  supersededByChain: Array<{ id: string; fact: string }>;
  supersedesChain: Array<{ id: string; fact: string }>;
  conflicts: Array<{ id: string; status: string }>;
}
interface PersonPage {
  name: string; kind: string; summary: string; closeness: number;
  facts: Array<{ atomId: string; fact: string }>;
  history: Array<{ at: number; kind: string; text: string }>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

export function MemoryFinishesPanel({ botId }: { botId: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MergedResult[]>([]);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [pages, setPages] = useState<PersonPage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [paste, setPaste] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const loadPages = useCallback(async () => {
    try {
      const res = await api<{ pages: PersonPage[] }>(`${BASE}/people-pages`);
      setPages(res.pages);
    } catch { /* router may not be mounted yet */ }
  }, []);

  useEffect(() => { void loadPages(); }, [loadPages]);

  const search = async () => {
    setError('');
    try {
      const res = await api<{ results: MergedResult[] }>(`${BASE}/search?q=${encodeURIComponent(query)}&botId=${encodeURIComponent(botId)}`);
      setResults(res.results);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const explain = async (atomId: string) => {
    try {
      const res = await api<{ explanation: Explanation }>(`${BASE}/memory/${encodeURIComponent(botId)}/${encodeURIComponent(atomId)}/explain`);
      setExplanation(res.explanation);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const getPrompt = async () => {
    const res = await api<{ prompt: string }>(`${BASE}/memory-import/prompt`);
    setPrompt(res.prompt);
  };

  const doPasteImport = async () => {
    const res = await api<{ parsed: number; storedAtomIds: string[] }>(`${BASE}/memory-import/paste`, {
      method: 'POST', body: JSON.stringify({ botId, markdown: paste }),
    });
    setNotice(`Imported ${res.storedAtomIds.length} new memories (${res.parsed} facts parsed).`);
    setPaste('');
  };

  const doZipImport = async (file: File) => {
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const res = await api<{ conversations: number; storedAtomIds: string[] }>(`${BASE}/memory-import/zip`, {
      method: 'POST', body: JSON.stringify({ botId, data: btoa(binary) }),
    });
    setNotice(`ZIP import: ${res.conversations} conversations summarised into ${res.storedAtomIds.length} memories.`);
  };

  const refreshPages = async () => {
    await api(`${BASE}/people-pages/refresh`, { method: 'POST', body: JSON.stringify({ botId }) });
    await loadPages();
  };

  return (
    <div className="card">
      <h3>Memory search, people &amp; import</h3>
      {error && <div className="error">{error}</div>}
      {notice && <div className="small">{notice}</div>}

      <div className="row-between">
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memory + chats + side chats…" aria-label="Unified memory search" />
        <button className="btn btn-sm" disabled={query.trim().length < 2} onClick={() => void search()}>Search</button>
      </div>
      {results.map((r) => (
        <div key={`${r.kind}-${r.id}`} className="small mt">
          <span className="badge">{r.kind === 'memory' ? '🧠 memory' : r.kind === 'chat' ? '💬 chat' : '📱 side chat'}</span>{' '}
          {r.kind === 'memory'
            ? <button className="linklike" onClick={() => void explain(r.id)}>{r.excerpt}</button>
            : <span>{r.excerpt}</span>}
        </div>
      ))}

      {explanation && (
        <div className="mt">
          <h4>Why do I remember this?</h4>
          <p className="small">{explanation.atom.fact}</p>
          <p className="small muted">
            Confidence: {Math.round(explanation.confidence.value * 100)}% ({explanation.confidence.label}) ·
            Source: {explanation.provenance.sourceTurn} · Category: {explanation.provenance.category} · Tier: {explanation.provenance.tier}
            {explanation.provenance.grounding ? ` · Grounding: ${explanation.provenance.grounding}` : ''}
          </p>
          {explanation.provenance.quote && (
            <p className="small">Verbatim quote: “{explanation.provenance.quote}” (from {explanation.provenance.quoteSource})</p>
          )}
          {explanation.supersededByChain.length > 0 && (
            <p className="small">Replaced by: {explanation.supersededByChain.map((a) => a.fact).join(' → ')}</p>
          )}
          {explanation.supersedesChain.length > 0 && (
            <p className="small">Replaced: {explanation.supersedesChain.map((a) => a.fact).join(' → ')}</p>
          )}
          {explanation.conflicts.length > 0 && (
            <p className="small">Conflicts: {explanation.conflicts.map((c) => `${c.id} (${c.status})`).join(', ')}</p>
          )}
          <button className="btn btn-sm" onClick={() => setExplanation(null)}>Close explain view</button>
        </div>
      )}

      <h4>People &amp; groups</h4>
      <button className="btn btn-sm" onClick={() => void refreshPages()}>Refresh pages from memory</button>
      {pages.map((p) => (
        <details key={p.name}>
          <summary className="small">{p.kind === 'group' ? '👥' : '👤'} {p.name} — closeness {p.closeness}</summary>
          <p className="small muted">{p.summary}</p>
          {p.facts.map((f) => <div key={f.atomId} className="small">• {f.fact}</div>)}
          {p.history.map((h, i) => (
            <div key={i} className="small muted">{new Date(h.at).toLocaleDateString()} [{h.kind}] {h.text}</div>
          ))}
        </details>
      ))}

      <h4>Import memory from another assistant</h4>
      <button className="btn btn-sm" onClick={() => void getPrompt()}>Show the export prompt</button>
      {prompt && <pre className="small pre-wrap">{prompt}</pre>}
      <textarea className="input" value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} placeholder="Paste the markdown answer here…" aria-label="Paste memory markdown" />
      <button className="btn btn-sm" disabled={!paste.trim()} onClick={() => void doPasteImport()}>Import pasted memory</button>
      <div className="mt">
        <label className="small">
          …or import a chat-export ZIP:{' '}
          <input type="file" accept=".zip" onChange={(e) => { const f = e.target.files?.[0]; if (f) void doZipImport(f); }} />
        </label>
      </div>
    </div>
  );
}
