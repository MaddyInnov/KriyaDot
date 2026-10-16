// SPDX-License-Identifier: Apache-2.0
// Message search box + branch version picker for Chat (OpenMausBot parity
// P1 #16/#17). Both live inside the Chat destination — no new top-level nav.
//
// - MessageSearchBox: full-text search across chat sessions with snippet
//   highlights; picking a result jumps to that message in its conversation.
// - BranchPicker: version switcher (v1, v2, …) for the active thread's
//   branch family; switching loads that version's conversation.

'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  getChatThreadBranches,
  searchMessages,
  type ChatThreadVersion,
  type MessageSearchResult,
} from '../../lib/api';

/** Render a search snippet, turning \u0001..\u0002 markers into <mark>. */
export function HighlightedSnippet({ snippet }: { snippet: string }) {
  const parts: React.ReactNode[] = [];
  // Snippet match markers: \x01 opens a match, \x02 closes it.
  const re = new RegExp('\x01(.*?)\x02', 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) parts.push(<span key={k++}>{snippet.slice(last, m.index)}</span>);
    parts.push(
      <mark key={k++} className="search-mark">
        {m[1]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push(<span key={k++}>{snippet.slice(last)}</span>);
  return <>{parts}</>;
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function MessageSearchBox({
  botId,
  botName,
  onJump,
}: {
  /** Scope the search to this bot ('' = all bots). */
  botId: string;
  botName: (id: string) => string;
  /** Jump to a message: (result) => void. The parent switches conversation + scrolls. */
  onJump: (r: MessageSearchResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const run = async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    setError('');
    try {
      const res = await searchMessages(trimmed, { ...(botId ? { botId } : {}), limit: 20 });
      setResults(res.results ?? []);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const onChange = (v: string) => {
    setQ(v);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(v), 300);
  };

  return (
    <div className="search-wrap" ref={boxRef}>
      <input
        className="input search-input"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter') {
            if (timer.current) clearTimeout(timer.current);
            void run(q);
            setOpen(true);
          }
        }}
        placeholder="🔍 Search messages…"
        aria-label="Search messages"
        title="Full-text search across chat sessions (at least 2 characters)"
      />
      {open && (q.trim().length >= 2 || error) && (
        <>
          <div className="pop-scrim search-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="search-pop" role="dialog" aria-label="Message search results">
            {searching && <div className="small muted search-status">Searching…</div>}
            {error && <div className="small search-error">Search failed: {error}</div>}
            {!searching && !error && searched && results.length === 0 && (
              <div className="small muted search-status">No messages match.</div>
            )}
            {results.map((r) => (
              <button
                key={`${r.sessionId}:${r.messageId}`}
                type="button"
                className="search-hit"
                onClick={() => {
                  setOpen(false);
                  onJump(r);
                }}
                title={`Jump to message in ${r.title ?? 'chat'}`}
              >
                <div className="search-hit-head">
                  <span className="search-hit-bot">{r.botId ? botName(r.botId) : 'bot'}</span>
                  <span className="search-hit-title">{r.title ?? 'Chat'}</span>
                  <span className="search-hit-role">{r.role}</span>
                  <span className="search-hit-ts">{fmtTs(r.ts)}</span>
                </div>
                <div className="search-hit-snippet">
                  <HighlightedSnippet snippet={r.snippet} />
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function BranchPicker({
  threadId,
  onSwitch,
  disabled,
}: {
  /** Active conversation/thread id (doubles as the backend session id). */
  threadId: string;
  /** Switch to another version of the thread. */
  onSwitch: (threadId: string) => void;
  disabled?: boolean;
}) {
  const [versions, setVersions] = useState<ChatThreadVersion[] | null>(null);

  useEffect(() => {
    if (!threadId) {
      setVersions(null);
      return;
    }
    let cancelled = false;
    void getChatThreadBranches(threadId)
      .then((res) => {
        if (!cancelled) setVersions(res.threads ?? []);
      })
      .catch(() => {
        if (!cancelled) setVersions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Only show the picker when the thread actually has branches.
  if (!versions || versions.length < 2) return null;
  const current = versions.find((v) => v.id === threadId);

  return (
    <label
      className="branch-picker"
      title="Switch between versions of this thread — each branch keeps its own continuation"
    >
      <span aria-hidden="true">⑂</span>
      <select
        className="select branch-select"
        value={threadId}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value !== threadId) onSwitch(e.target.value);
        }}
        aria-label="Thread version"
      >
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            v{v.version}
            {v.isRoot ? ' · original' : ''} — {(v.title || 'Branch').slice(0, 40)}
            {v.id === current?.id ? ' ✓' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
