// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Per-bot durable memory management (Engram parity).
 *
 * Lists the bot's distilled memories (atoms) with search, pin/unpin,
 * and forget (delete). Pinned memories surface first in recall and are
 * never auto-pruned. Deleting removes the FTS index row too.
 */

import { useCallback, useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

export interface MemoryAtom {
  id: string;
  botId: string;
  fact: string;
  entities: string[];
  confidence: number;
  sourceTurn: string;
  createdAt: number;
  tier: string;
  pinned: boolean;
  category: 'fact' | 'preference' | 'summary' | 'decision';
}

const CATEGORY_LABEL: Record<MemoryAtom['category'], string> = {
  fact: 'Fact',
  preference: 'Preference',
  summary: 'Summary',
  decision: 'Decision',
};

export function MemoryPanel({ botId }: { botId: string }) {
  const [atoms, setAtoms] = useState<MemoryAtom[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await kriyadotFetch(`/api/memory/atoms?botId=${encodeURIComponent(botId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAtoms(data.atoms ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [botId]);

  useEffect(() => {
    setQuery('');
    setConfirmForget(null);
    void refresh();
  }, [botId, refresh]);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      void refresh();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await kriyadotFetch(
        `/api/memory/search?botId=${encodeURIComponent(botId)}&q=${encodeURIComponent(q)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAtoms(data.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [botId, query, refresh]);

  const togglePin = useCallback(
    async (atom: MemoryAtom) => {
      setError('');
      try {
        const action = atom.pinned ? 'unpin' : 'pin';
        const res = await kriyadotFetch(
          `/api/memory/atoms/${encodeURIComponent(atom.id)}/${action}?botId=${encodeURIComponent(botId)}`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setAtoms((prev) => prev.map((a) => (a.id === atom.id ? { ...a, pinned: !a.pinned } : a)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  const forget = useCallback(
    async (id: string) => {
      setError('');
      try {
        const res = await kriyadotFetch(
          `/api/memory/atoms/${encodeURIComponent(id)}?botId=${encodeURIComponent(botId)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setAtoms((prev) => prev.filter((a) => a.id !== id));
        setConfirmForget(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  return (
    <div className="memory-panel">
      <p className="muted" style={{ marginBottom: 12 }}>
        Durable memories this bot has learned about you. Pinned memories always come first when the
        bot recalls context. Forgetting removes a memory permanently.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="search"
          placeholder="Search memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
          style={{ flex: 1 }}
          aria-label="Search memories"
        />
        <button type="button" onClick={() => void search()} disabled={busy}>
          Search
        </button>
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              void refresh();
            }}
            disabled={busy}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      )}

      {busy && atoms.length === 0 ? (
        <p className="muted">Loading memories…</p>
      ) : atoms.length === 0 ? (
        <p className="muted">
          No memories yet. The keeper saves durable facts automatically after conversations — or
          teach the bot with "remember that…".
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {atoms.map((atom) => (
            <li
              key={atom.id}
              style={{
                border: '1px solid var(--border, #ddd)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: atom.pinned ? 600 : 400 }}>{atom.fact}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {CATEGORY_LABEL[atom.category] ?? atom.category}
                    {atom.entities.length > 0 && ` · ${atom.entities.join(', ')}`}
                    {` · ${new Date(atom.createdAt).toLocaleDateString()}`}
                    {atom.pinned && ' · 📌 Pinned'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    title={atom.pinned ? 'Unpin' : 'Pin'}
                    onClick={() => void togglePin(atom)}
                    aria-label={atom.pinned ? `Unpin memory: ${atom.fact}` : `Pin memory: ${atom.fact}`}
                  >
                    {atom.pinned ? '📌' : '📍'}
                  </button>
                  {confirmForget === atom.id ? (
                    <>
                      <button type="button" onClick={() => void forget(atom.id)} style={{ color: 'var(--danger, #c00)' }}>
                        Confirm
                      </button>
                      <button type="button" onClick={() => setConfirmForget(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" title="Forget this memory" onClick={() => setConfirmForget(atom.id)}>
                      🗑️
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
