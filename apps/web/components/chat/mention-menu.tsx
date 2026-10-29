// SPDX-License-Identifier: Apache-2.0
// Unified @mention menu (chat polish): one menu over bots + people
// from the existing directories. Pure helpers are exported for tests.

'use client';

import React from 'react';

export interface MentionEntry { id: string; kind: 'bot' | 'person'; label: string }

/** The @query being typed at the caret, or null when the caret is not in a mention. */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1] ?? '')) return null; // e.g. an email address
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

/** Case-insensitive prefix-then-substring filtering, bots and people unified. */
export function filterMentions(entries: MentionEntry[], query: string, limit = 8): MentionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const prefix = entries.filter((e) => e.label.toLowerCase().startsWith(q));
  const rest = entries.filter((e) => !e.label.toLowerCase().startsWith(q) && e.label.toLowerCase().includes(q));
  return [...prefix, ...rest].slice(0, limit);
}

export function MentionMenu({ entries, highlight, onPick }: {
  entries: MentionEntry[];
  highlight: number;
  onPick: (entry: MentionEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mention-menu slash-pop" role="listbox" aria-label="Mentions">
      {entries.map((e, i) => (
        <button key={`${e.kind}:${e.id}`} type="button" role="option" aria-selected={i === highlight}
          className={`slash-opt${i === highlight ? ' hl' : ''}`}
          onMouseDown={(ev) => { ev.preventDefault(); onPick(e); }}>
          <span className="cmd">@{e.label}</span>
          <span className="desc">{e.kind === 'bot' ? '🤖 bot' : '🧑 person'}</span>
        </button>
      ))}
    </div>
  );
}
