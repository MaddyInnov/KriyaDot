// SPDX-License-Identifier: Apache-2.0
// Command palette (chat polish): Cmd/Ctrl+K fuzzy list over bots,
// threads, the six top-level destinations, and actions (new thread,
// toggle Simple/Pro mode, cycle theme). Keyboard navigable.
// Pure filtering is exported for tests.

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

export type PaletteItemKind = 'bot' | 'thread' | 'destination' | 'action';
export interface PaletteItem { id: string; kind: PaletteItemKind; label: string; hint?: string }

/** Subsequence fuzzy score: higher is better; -1 = no match. Contiguous + early matches win. */
export function fuzzyScore(label: string, query: string): number {
  const l = label.toLowerCase(); const q = query.trim().toLowerCase();
  if (!q) return 0;
  let score = 0; let li = 0; let prev = -2;
  for (const ch of q) {
    const found = l.indexOf(ch, li);
    if (found < 0) return -1;
    score += found === prev + 1 ? 3 : 1;
    if (found === 0 || l[found - 1] === ' ') score += 2;
    prev = found; li = found + 1;
  }
  return score - l.length / 100;
}

export function filterPaletteItems(items: PaletteItem[], query: string, limit = 12): PaletteItem[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(item.label, query) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}

export interface CommandPaletteProps {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
  onSelect: (item: PaletteItem) => void;
}

export function CommandPalette({ open, items, onClose, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterPaletteItems(items, query), [items, query]);

  useEffect(() => { if (open) { setQuery(''); setHighlight(0); inputRef.current?.focus(); } }, [open ]);
  useEffect(() => { setHighlight(0); }, [query]);
  if (!open) return null;

  return (
    <div className="command-palette-scrim" role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,10,15,0.45)', display: 'flex', justifyContent: 'center', paddingTop: '12vh' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card command-palette" role="dialog" aria-label="Command palette" style={{ width: 560, maxWidth: '94vw', height: 'fit-content', padding: 10 }}>
        <input ref={inputRef} className="input" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search bots, threads, destinations, actions…" aria-label="Command palette search"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            if (e.key === 'Enter') { const it = results[highlight]; if (it) { onSelect(it); onClose(); } }
          }} />
        <div role="listbox" style={{ marginTop: 8, maxHeight: 360, overflowY: 'auto' }}>
          {results.length === 0 && <div className="small muted" style={{ padding: 8 }}>No matches.</div>}
          {results.map((item, i) => (
            <button key={item.id} type="button" role="option" aria-selected={i === highlight}
              className={`slash-opt${i === highlight ? ' hl' : ''}`} style={{ width: '100%', display: 'flex', gap: 8 }}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => { onSelect(item); onClose(); }}>
              <span>{item.kind === 'bot' ? '🤖' : item.kind === 'thread' ? '💬' : item.kind === 'destination' ? '🧭' : '⚡'}</span>
              <span className="cmd">{item.label}</span>
              {item.hint && <span className="desc">{item.hint}</span>}
            </button>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>↑↓ navigate · ↵ select · esc close</div>
      </div>
    </div>
  );
}

/** Bind Cmd/Ctrl+K to a palette open state. Returns nothing; call in the chat page. */
export function useCommandPaletteShortcut(setOpen: (fn: (v: boolean) => boolean) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}
