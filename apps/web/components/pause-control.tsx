// SPDX-License-Identifier: Apache-2.0
'use client';

// Global pause (W14d): a Pause/Resume button in the app header plus a
// persistent banner while paused. Both poll GET /api/system/pause-state
// (same pattern as the remote-screen banner) so every destination shows
// the current state; Resume is one tap from the banner.

import { useCallback, useEffect, useState } from 'react';
import { kriyadotFetch } from '../lib/kriyadot-api';

interface PauseState {
  paused: boolean;
  pausedAt?: number | null;
  pausedBy?: string | null;
  reason?: string | null;
}

function usePauseState(): { state: PauseState | null; refresh: () => Promise<void> } {
  const [state, setState] = useState<PauseState | null>(null);
  const refresh = useCallback(async () => {
    try {
      const res = await kriyadotFetch('/api/system/pause-state', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as PauseState;
      setState(json);
    } catch {
      // API unreachable — controls stay in their last known state.
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { state, refresh };
}

async function post(path: string): Promise<void> {
  await kriyadotFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: 'web' }),
  });
}

/** Header button: Pause when running, Resume when paused. */
export function PauseControl() {
  const { state, refresh } = usePauseState();
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      await post(state.paused ? '/api/system/resume' : '/api/system/pause');
      await refresh();
    } catch {
      // ignore — next poll refreshes
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={state.paused}
      title={state.paused ? 'Resume all KriyaDot work' : 'Pause all new KriyaDot work (chat, routines, watchers, phone actions)'}
      style={{
        marginLeft: 12,
        padding: '4px 10px',
        borderRadius: 999,
        border: '1px solid var(--border, #ccc)',
        background: state.paused ? 'var(--amber, #b97f1f)' : 'transparent',
        color: state.paused ? '#fff' : 'inherit',
        cursor: 'pointer',
        fontSize: 13,
      }}
    >
      {state.paused ? '▶ Resume' : '⏸ Pause'}
    </button>
  );
}

/** Persistent banner shown on every destination while paused. */
export function PausedBanner() {
  const { state, refresh } = usePauseState();
  const [busy, setBusy] = useState(false);
  if (!state?.paused) return null;
  const resume = async () => {
    setBusy(true);
    try {
      await post('/api/system/resume');
      await refresh();
    } catch {
      // ignore — next poll refreshes
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        background: 'var(--amber, #b97f1f)',
        color: '#fff',
        fontSize: 14,
      }}
    >
      <span>
        ⏸ KriyaDot is paused — new chat turns, routines, watchers and phone actions are on hold
        {state.pausedBy ? ` (paused by ${state.pausedBy})` : ''}
        {state.reason ? ` — ${state.reason}` : ''}.
      </span>
      <button
        type="button"
        onClick={() => void resume()}
        disabled={busy}
        style={{
          marginLeft: 'auto',
          padding: '4px 12px',
          borderRadius: 999,
          border: '1px solid #fff',
          background: 'transparent',
          color: '#fff',
          cursor: 'pointer',
        }}
      >
        Resume
      </button>
    </div>
  );
}
