// SPDX-License-Identifier: Apache-2.0
'use client';

// "Works on" surface selection (OpenMausBot parity P1 #14). Rendered at the
// top of the per-bot Computer tab (computer-panel.tsx): lets the user pick
// which computer a bot drives — auto (best available), local (this machine),
// docker (isolated container), browser (Playwright), or off (disable
// computer tools for this bot). Shows instance status + a restart button,
// and manages per-conversation surface pins.

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

const SURFACES = [
  { id: 'auto', label: 'Auto (best available)' },
  { id: 'local', label: 'Local (this machine)' },
  { id: 'docker', label: 'Docker sandbox' },
  { id: 'browser', label: 'Browser (Playwright)' },
  { id: 'off', label: 'Off (disable computer tools)' },
] as const;

interface InstanceStatus {
  key: string;
  pinned: boolean;
  conversationId?: string;
  surface: string;
  resolved: string;
  running: boolean;
  lastUsedMs: number;
  idleMs: number;
}

interface SurfaceState {
  surface: string;
  resolved: string | null;
  off: boolean;
  instances: InstanceStatus[];
}

interface Pin {
  conversationId: string;
  surface: string;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await authedFetch(path, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }
  return res.json() as Promise<unknown>;
}

function idleLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function ComputerSurfaceSection({ botId }: { botId: string }) {
  const [state, setState] = useState<SurfaceState | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinConv, setPinConv] = useState('');
  const [pinSurface, setPinSurface] = useState<string>('browser');

  const refresh = useCallback(async () => {
    try {
      const s = (await api(`/api/bots/${encodeURIComponent(botId)}/computer`)) as {
        ok: boolean;
        surface: string;
        resolved: string | null;
        off: boolean;
        instances: InstanceStatus[];
      };
      setState({ surface: s.surface, resolved: s.resolved, off: s.off, instances: s.instances });
      const p = (await api(`/api/bots/${encodeURIComponent(botId)}/computer/pins`)) as {
        ok: boolean;
        pins: Pin[];
      };
      setPins(p.pins);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [botId]);

  useEffect(() => {
    setState(null);
    setPins([]);
    void refresh();
  }, [botId, refresh]);

  const setSurface = async (surface: string) => {
    setSaving(true);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/computer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    setSaving(true);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/computer/restart`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const savePin = async (surface: string | null) => {
    const conv = pinConv.trim();
    if (!conv) {
      setError('Enter a conversation/session id to pin a surface for.');
      return;
    }
    setSaving(true);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/computer/pin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conv, surface }),
      });
      setPinConv('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="computer-surface" aria-label="Works on surface">
      <div className="computer-surface-row">
        <label htmlFor={`surface-${botId}`}>
          <strong>Works on</strong>
        </label>
        <select
          id={`surface-${botId}`}
          value={state?.surface ?? 'auto'}
          disabled={saving || !state}
          onChange={(e) => void setSurface(e.target.value)}
          aria-label="Computer surface for this bot"
        >
          {SURFACES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void restart()} disabled={saving || state?.off}>
          Restart computer
        </button>
      </div>

      <div className="muted computer-surface-status">
        {state ? (
          state.off ? (
            <>Computer tools are <strong>off</strong> for this bot — calls fail with a clear error instead of driving a screen.</>
          ) : (
            <>
              Backend: <strong>{state.resolved}</strong>
              {' · '}
              {state.instances.length === 0 ? (
                <>no instance yet — created on first computer-tool use</>
              ) : (
                state.instances.map((i) => (
                  <span key={i.key}>
                    {i.pinned ? `pinned ${i.conversationId}` : 'main'}: {i.running ? 'running' : 'starting'}
                    {' · '}idle {idleLabel(i.idleMs)}
                  </span>
                ))
              )}
            </>
          )
        ) : (
          'Loading surface…'
        )}
      </div>
      <div className="muted computer-surface-note">
        Each bot gets its own computer — no shared cursors. Idle computers are
        shut down after 30 minutes and recreated on next use.
      </div>

      {error && (
        <div className="computer-error" role="alert">
          {error}
        </div>
      )}

      <details className="computer-surface-pins">
        <summary>Per-conversation pins ({pins.length})</summary>
        <div className="computer-surface-row">
          <input
            type="text"
            value={pinConv}
            onChange={(e) => setPinConv(e.target.value)}
            placeholder="Conversation / session id…"
            aria-label="Conversation id to pin"
            style={{ minWidth: 220 }}
          />
          <select
            value={pinSurface}
            onChange={(e) => setPinSurface(e.target.value)}
            aria-label="Pinned surface"
          >
            {SURFACES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void savePin(pinSurface)} disabled={saving}>
            Pin
          </button>
          <button className="btn" onClick={() => void savePin(null)} disabled={saving}>
            Clear
          </button>
        </div>
        {pins.length > 0 && (
          <ul className="computer-pin-list">
            {pins.map((p) => (
              <li key={p.conversationId}>
                <code className="mono">{p.conversationId}</code> → {p.surface}
              </li>
            ))}
          </ul>
        )}
        <div className="muted">
          A pin overrides this bot&apos;s surface for one conversation (e.g. drive the
          browser surface only in a specific chat).
        </div>
      </details>
    </section>
  );
}
