// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, Markdown } from '../lib';
import { authedFetch } from '../../../lib/api';

interface KbDocument {
  id: string;
  corpusId: string | null;
  title: string;
  fileName: string;
  mimeType: string;
  charCount: number;
  chunkCount: number;
  createdAt: number;
}

interface KbCorpus {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

interface KbChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  corpusId: string | null;
  idx: number;
  text: string;
  page: number | null;
  score: number;
}

const ACCEPT = '.pdf,.md,.markdown,.txt,.html,.htm';

export default function KbPage() {
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [corpora, setCorpora] = useState<KbCorpus[]>([]);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [corpusFilter, setCorpusFilter] = useState<string>('');
  const [newCorpus, setNewCorpus] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KbChunk[] | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        api(`${MODULES_BASE}/kb/documents`) as Promise<KbDocument[]>,
        api(`${MODULES_BASE}/kb/corpora`) as Promise<KbCorpus[]>,
      ]);
      setDocs(d);
      setCorpora(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Load on mount.
  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const qs = new URLSearchParams({
        fileName: file.name,
        title: uploadName.trim() || file.name,
        mimeType: file.type || 'application/octet-stream',
        ...(corpusFilter ? { corpusId: corpusFilter } : {}),
      });
      const res = await authedFetch(`${MODULES_BASE}/kb/documents?${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `upload failed (${res.status})`);
      }
      setUploadName('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeDoc = async (id: string) => {
    if (!confirm('Delete this document and all its chunks?')) return;
    await api(`${MODULES_BASE}/kb/documents/${id}`, { method: 'DELETE' });
    await load();
  };

  const createCorpus = async () => {
    if (!newCorpus.trim()) return;
    await api(`${MODULES_BASE}/kb/corpora`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newCorpus.trim() }),
    });
    setNewCorpus('');
    await load();
  };

  const runQuery = async (withAnswer: boolean) => {
    if (!query.trim()) return;
    setAnswering(withAnswer);
    setError('');
    try {
      if (withAnswer) {
        const r = (await api(`${MODULES_BASE}/kb/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: query.trim(),
            corpusIds: corpusFilter ? [corpusFilter] : undefined,
          }),
        })) as { answer: string; chunks: KbChunk[] };
        setAnswer(r.answer);
        setResults(r.chunks);
      } else {
        const r = (await api(`${MODULES_BASE}/kb/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: query.trim(),
            topK: 8,
            corpusIds: corpusFilter ? [corpusFilter] : undefined,
          }),
        })) as { chunks: KbChunk[] };
        setAnswer(null);
        setResults(r.chunks);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnswering(false);
    }
  };

  const visibleDocs = corpusFilter ? docs.filter((d) => d.corpusId === corpusFilter) : docs;

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        sub="RAG over your documents — local embeddings, cited answers. Zero API keys."
      />
      <ErrorBox error={error} />

      <section className="card">
        <h3>Upload document</h3>
        <p className="muted small">PDF, Markdown, text, or HTML — up to 50MB. Text is extracted locally; file bytes are never stored.</p>
        <div className="row">
          <input
            className="input"
            placeholder="Title (optional — defaults to file name)"
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value)}
          />
          <select className="select" value={corpusFilter} onChange={(e) => setCorpusFilter(e.target.value)} title="Corpus">
            <option value="">No corpus</option>
            {corpora.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Uploading…' : 'Choose file'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Ask your documents</h3>
        <div className="row">
          <input
            className="input"
            placeholder="What do your documents say about…?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runQuery(true);
              else if (e.key === 'Enter') void runQuery(false);
            }}
          />
          <button className="btn" disabled={answering || !query.trim()} onClick={() => void runQuery(false)}>
            Search
          </button>
          <button className="btn primary" disabled={answering || !query.trim()} onClick={() => void runQuery(true)}>
            {answering ? 'Thinking…' : 'Answer with citations'}
          </button>
        </div>
        <p className="muted small">Enter = search chunks · ⌘/Ctrl+Enter = synthesized answer with [n] citations.</p>

        {answer && (
          <div className="card" style={{ marginTop: 12 }}>
            <Markdown src={answer} />
          </div>
        )}

        {results && (
          <div style={{ marginTop: 12 }}>
            {results.length === 0 ? (
              <EmptyState text="No relevant chunks found." />
            ) : (
              results.map((c, i) => (
                <div key={c.chunkId} className="card" style={{ marginBottom: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>[{i + 1}] {c.documentTitle}</strong>
                    <span className="muted small">score {c.score.toFixed(3)}</span>
                  </div>
                  <p className="small">{c.text.slice(0, 500)}{c.text.length > 500 ? '…' : ''}</p>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Documents ({visibleDocs.length})</h3>
          <div className="row">
            <input
              className="input"
              placeholder="New corpus name"
              value={newCorpus}
              onChange={(e) => setNewCorpus(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            <button className="btn small" onClick={() => void createCorpus()}>+ Corpus</button>
          </div>
        </div>
        {corpora.length > 0 && (
          <div className="row" style={{ marginBottom: 8 }}>
            <button className={`btn small${!corpusFilter ? ' primary' : ''}`} onClick={() => setCorpusFilter('')}>All</button>
            {corpora.map((c) => (
              <button
                key={c.id}
                className={`btn small${corpusFilter === c.id ? ' primary' : ''}`}
                onClick={() => setCorpusFilter(corpusFilter === c.id ? '' : c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        {visibleDocs.length === 0 ? (
          <EmptyState text="No documents yet — upload one above." />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Title</th><th>File</th><th>Chunks</th><th>Chars</th><th>Added</th><th></th></tr>
            </thead>
            <tbody>
              {visibleDocs.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}</td>
                  <td className="muted small">{d.fileName}</td>
                  <td>{d.chunkCount}</td>
                  <td>{d.charCount.toLocaleString()}</td>
                  <td className="muted small">{fmtTs(d.createdAt)}</td>
                  <td>
                    <button className="btn small" onClick={() => void removeDoc(d.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
