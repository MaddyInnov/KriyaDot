// SPDX-License-Identifier: Apache-2.0
// Voice catalog picker: search a TTS provider's voice catalog and pick
// a voice. Self-contained — it talks to the API route
//   GET {apiBase}/api/voice/catalog?provider=<id>&q=<query>
// (see apps/api/src/voice-catalog-routes.ts) and reports the choice via
// onSelect(voiceId, entry). The parent mounts it wherever a voice id is
// edited (e.g. next to the TTS voice field in the voice settings panel).

'use client';

import React from 'react';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Mirrors VoiceCatalogEntry in @mvp/voice (JSON round-trip shape). */
export interface VoiceCatalogEntryDto {
  id: string;
  name: string;
  provider: string;
  description?: string;
  previewUrl?: string;
  imageUrl?: string;
  category?: string;
  labels?: Record<string, string>;
  language?: string;
}

export interface VoiceCatalogPickerProps {
  /** Catalog provider to browse ('elevenlabs', 'fish', 'chatterbox', 'openai', …). */
  provider: string;
  /** API origin prefix; '' (default) = same origin. */
  apiBase?: string;
  /** Currently selected voice id (highlighted in the results). */
  value?: string;
  /** Called with the chosen voice id and its catalog entry. */
  onSelect: (voiceId: string, entry: VoiceCatalogEntryDto) => void;
  /** Injectable fetch for tests/storybooks; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** Build the catalog endpoint URL for one search. */
export function buildVoiceCatalogUrl(apiBase: string, provider: string, query: string): string {
  const params = new URLSearchParams({ provider });
  if (query.trim()) params.set('q', query.trim());
  return `${apiBase.replace(/\/+$/, '')}/api/voice/catalog?${params.toString()}`;
}

export default function VoiceCatalogPicker({
  provider,
  apiBase = '',
  value,
  onSelect,
  fetchFn,
}: VoiceCatalogPickerProps) {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<VoiceCatalogEntryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const requestSeq = useRef(0);

  const search = useCallback(
    async (q: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError('');
      try {
        const doFetch = fetchFn ?? globalThis.fetch;
        const res = await doFetch(buildVoiceCatalogUrl(apiBase, provider, q));
        const body = (await res.json().catch(() => ({}))) as {
          voices?: VoiceCatalogEntryDto[];
          error?: string;
          detail?: string;
        };
        if (seq !== requestSeq.current) return; // a newer search won
        if (!res.ok) {
          setEntries([]);
          setError(body.detail ?? body.error ?? `catalog request failed (${res.status})`);
          return;
        }
        setEntries(Array.isArray(body.voices) ? body.voices : []);
        setLoaded(true);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [apiBase, provider, fetchFn],
  );

  // Load the provider's default listing on mount / provider change.
  useEffect(() => {
    setQuery('');
    setLoaded(false);
    void search('');
  }, [search]);

  return (
    <div className="voice-catalog-picker" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search(query);
            }
          }}
          placeholder={`Search ${provider} voices…`}
          aria-label={`Search ${provider} voices`}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-sm" onClick={() => void search(query)} disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!error && loaded && entries.length === 0 && (
        <p className="small muted" role="status">
          No voices found for this provider.
        </p>
      )}
      {entries.length > 0 && (
        <ul className="voice-catalog-results" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
          {entries.map((entry) => {
            const selected = value !== undefined && entry.id === value;
            const meta = [entry.language, entry.category, ...(entry.labels ? Object.values(entry.labels) : [])]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={`${entry.provider}:${entry.id}`}>
                <button
                  type="button"
                  className={selected ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
                  aria-pressed={selected}
                  onClick={() => onSelect(entry.id, entry)}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center' }}
                >
                  {entry.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={entry.imageUrl} alt="" width={28} height={28} style={{ borderRadius: 4 }} />
                  )}
                  <span style={{ flex: 1 }}>
                    <strong>{entry.name}</strong>
                    {meta && (
                      <>
                        <br />
                        <span className="muted small">{meta}</span>
                      </>
                    )}
                    {entry.description && (
                      <>
                        <br />
                        <span className="small">{entry.description}</span>
                      </>
                    )}
                  </span>
                  {entry.previewUrl && (
                    <audio controls preload="none" src={entry.previewUrl} style={{ height: 28 }} aria-label={`Preview ${entry.name}`} />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
