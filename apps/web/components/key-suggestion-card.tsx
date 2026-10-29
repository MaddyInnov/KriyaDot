// SPDX-License-Identifier: Apache-2.0
'use client';

// Helper key suggestions (§1.7): a Settings card that asks
// GET /api/settings/key-suggestions and shows the ranked list of missing
// keys by how much each one unlocks — "the one key that unlocks the
// most" first. Read-only: adding a key still happens through the normal
// provider-key flow; this card only points at the highest-leverage gap.
//
// HOST WIRING (parent mounts in Settings):
//   import { KeySuggestionCard } from './key-suggestion-card';
//   <KeySuggestionCard />

import { useEffect, useState } from 'react';
import { kriyadotFetch } from '../lib/kriyadot-api';

interface KeySuggestion {
  key: string;
  unlocks: string[];
  provider?: string;
  score: number;
}

export function KeySuggestionCard() {
  const [suggestions, setSuggestions] = useState<KeySuggestion[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await kriyadotFetch('/api/settings/key-suggestions', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { suggestions?: KeySuggestion[] };
        if (!cancelled) setSuggestions(json.suggestions ?? []);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null; // A helper card must never break Settings.
  if (suggestions === null) {
    return (
      <section aria-label="Key suggestions" className="key-suggestion-card">
        <h3>Add one key, unlock the most</h3>
        <p>Checking which keys are missing…</p>
      </section>
    );
  }
  if (suggestions.length === 0) {
    return (
      <section aria-label="Key suggestions" className="key-suggestion-card">
        <h3>Add one key, unlock the most</h3>
        <p>All known provider and feature keys are configured. 🎉</p>
      </section>
    );
  }

  const [top, ...rest] = suggestions;
  return (
    <section aria-label="Key suggestions" className="key-suggestion-card">
      <h3>Add one key, unlock the most</h3>
      <p>
        Start with <code>{top.key}</code> — it unlocks the most right now:
      </p>
      <ul>
        {top.unlocks.map((u) => (
          <li key={u}>{u}</li>
        ))}
      </ul>
      {rest.length > 0 && (
        <>
          <p>Also missing, in order of leverage:</p>
          <ol>
            {rest.map((s) => (
              <li key={s.key}>
                <code>{s.key}</code> — {s.unlocks.join('; ')}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
