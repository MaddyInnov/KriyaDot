// SPDX-License-Identifier: Apache-2.0
// In-chat find bar (chat polish): Ctrl+F within the open thread.
// Pure matching lives in chat-polish.ts (findInMessages); this is the
// bar UI: query input, match count, prev/next, close.

'use client';

import React from 'react';

export interface FindBarProps {
  query: string;
  onQuery: (q: string) => void;
  matchCount: number;
  /** 0-based index of the current match (-1 when none). */
  current: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export function FindBar({ query, onQuery, matchCount, current, onNext, onPrev, onClose }: FindBarProps) {
  return (
    <div className="find-bar" role="search" aria-label="Find in this conversation"
      style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border, #2a2a35)' }}>
      <input
        className="input find-input"
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext(); }
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Find in conversation…"
        aria-label="Find in conversation"
        style={{ flex: 1 }}
      />
      <span className="small muted find-count" aria-live="polite">
        {query.trim() ? (matchCount === 0 ? 'No matches' : `${current + 1} of ${matchCount}`) : ''}
      </span>
      <button type="button" className="btn btn-sm" onClick={onPrev} disabled={matchCount === 0} aria-label="Previous match">↑</button>
      <button type="button" className="btn btn-sm" onClick={onNext} disabled={matchCount === 0} aria-label="Next match">↓</button>
      <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close find">✕</button>
    </div>
  );
}
