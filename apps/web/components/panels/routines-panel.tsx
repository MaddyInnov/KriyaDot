// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Per-bot routines panel (Codync parity: public webhook ingress).
 *
 * Lists the bot's routines. Each routine expands to show its public webhook
 * URL + secret (reveal / regenerate with confirmation / copy) and the recent
 * delivery log (timestamp, status, event type).
 *
 * Reachability note (also in the API): the API binds to 127.0.0.1, so the
 * public URL only works for external senders (GitHub etc.) when a tunnel
 * (Tailscale / cloudflared / ngrok) fronts the API port and
 * KRIYADOT_PUBLIC_URL is set. LAN senders can use the local URL directly.
 */

import { useCallback, useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

interface Routine {
  id: string;
  name: string;
  botId: string;
  enabled: boolean;
}

interface HookInfo {
  routineId: string;
  url: string | null;
  localUrl: string;
  hasSecret: boolean;
  connected: boolean;
  queueDepth: number;
  secret?: string;
}

interface Delivery {
  id: string;
  eventType: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const STATUS_LABEL: Record<Delivery['status'], string> = {
  pending: '⏳ queued',
  processing: '⚙️ running',
  done: '✅ done',
  failed: '❌ failed',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

function copyText(text: string, done: () => void) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    // ignore
  }
  document.body.removeChild(ta);
}

function RoutineRow({ routine, botId }: { routine: Routine; botId: string }) {
  const [open, setOpen] = useState(false);
  const [hook, setHook] = useState<HookInfo | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [confirmRegen, setConfirmRegen] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [h, d] = await Promise.all([
        api<{ hook: HookInfo }>(`/api/routines/${encodeURIComponent(routine.id)}/hook`),
        api<{ deliveries: Delivery[] }>(`/api/routines/${encodeURIComponent(routine.id)}/deliveries?limit=20`),
      ]);
      setHook(h.hook);
      setDeliveries(d.deliveries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhook info');
    } finally {
      setBusy(false);
    }
  }, [routine.id]);

  useEffect(() => {
    if (open && !hook) void load();
  }, [open, hook, load]);

  const onReveal = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ hook: HookInfo }>(`/api/routines/${encodeURIComponent(routine.id)}/hook/reveal`, {
        method: 'POST',
      });
      setHook(res.hook);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reveal failed');
    } finally {
      setBusy(false);
    }
  };

  const onRegenerate = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ hook: HookInfo }>(`/api/routines/${encodeURIComponent(routine.id)}/hook/regenerate`, {
        method: 'POST',
      });
      setHook(res.hook);
      setConfirmRegen(false);
      void loadDeliveries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Regenerate failed');
    } finally {
      setBusy(false);
    }
  };

  const loadDeliveries = useCallback(async () => {
    try {
      const d = await api<{ deliveries: Delivery[] }>(
        `/api/routines/${encodeURIComponent(routine.id)}/deliveries?limit=20`,
      );
      setDeliveries(d.deliveries);
    } catch {
      // ignore — non-fatal
    }
  }, [routine.id]);

  const doCopy = (label: string, text: string) => copyText(text, () => {
    setCopied(label);
    setTimeout(() => setCopied(''), 1500);
  });

  const displayUrl = hook?.url ?? hook?.localUrl ?? '';

  return (
    <div className="routine-row">
      <button
        type="button"
        className="routine-row-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="routine-name">{routine.name}</span>
        <span className={`routine-badge${routine.enabled ? '' : ' paused'}`}>
          {routine.enabled ? 'on' : 'paused'}
        </span>
        {hook?.connected && <span className="routine-badge connected">connected</span>}
        <span className="routine-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="routine-detail">
          {busy && !hook && <p className="muted">Loading…</p>}
          {error && <p className="error">{error}</p>}
          {hook && (
            <>
              <label className="field-label">
                Public webhook URL
                <span className="muted"> — POST JSON here to run the routine</span>
              </label>
              <div className="copy-row">
                <code className="url-box">{displayUrl}</code>
                <button type="button" className="btn-ghost" onClick={() => doCopy('url', displayUrl)}>
                  {copied === 'url' ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
              {!hook.url && (
                <p className="muted small">
                  Public URL is unset — set <code>KRIYADOT_PUBLIC_URL</code> and use a tunnel
                  (Tailscale / cloudflared / ngrok) so external senders can reach this PC.
                  LAN senders can use the local URL above.
                </p>
              )}
              <label className="field-label">Secret</label>
              <div className="copy-row">
                {hook.secret ? (
                  <>
                    <code className="url-box secret">{hook.secret}</code>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => doCopy('secret', hook.secret as string)}
                    >
                      {copied === 'secret' ? 'Copied ✓' : 'Copy'}
                    </button>
                  </>
                ) : (
                  <>
                    <code className="url-box secret masked">•••••••• (hidden)</code>
                    <button type="button" className="btn-ghost" onClick={onReveal} disabled={busy}>
                      Reveal
                    </button>
                  </>
                )}
                {confirmRegen ? (
                  <>
                    <button type="button" className="btn-danger" onClick={onRegenerate} disabled={busy}>
                      Confirm regenerate
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => setConfirmRegen(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost" onClick={() => setConfirmRegen(true)}>
                    Regenerate
                  </button>
                )}
              </div>
              <p className="muted small">
                GitHub: paste the URL as the payload URL, content type{' '}
                <code>application/json</code>, secret = the key above. The routine also
                accepts <code>Authorization: Bearer &lt;secret&gt;</code> or an{' '}
                <code>X-Signature-256</code> HMAC.
              </p>

              <div className="deliveries-head">
                <label className="field-label">Recent deliveries</label>
                <button type="button" className="btn-ghost small" onClick={() => void loadDeliveries()}>
                  Refresh
                </button>
              </div>
              {deliveries.length === 0 ? (
                <p className="muted small">No deliveries yet.</p>
              ) : (
                <table className="deliveries-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Status</th>
                      <th>Tries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id} title={d.error ?? ''}>
                        <td>{new Date(d.createdAt).toLocaleString()}</td>
                        <td>
                          <code>{d.eventType}</code>
                        </td>
                        <td>{STATUS_LABEL[d.status]}</td>
                        <td>{d.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function RoutinesPanel({ botId }: { botId: string }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ routines: Routine[] }>('/api/routines');
      setRoutines(res.routines.filter((r) => r.botId === botId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load routines');
    } finally {
      setBusy(false);
    }
  }, [botId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="panel routines-panel" aria-label="Routines and webhooks">
      <div className="panel-head">
        <h3>🔁 Routines & webhooks</h3>
        <button type="button" className="btn-ghost small" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {busy && routines.length === 0 && <p className="muted">Loading…</p>}
      {!busy && routines.length === 0 && !error && (
        <p className="muted small">
          No routines for this bot yet. Ask the bot “I want a routine that…” to create one —
          each routine gets a public webhook URL automatically.
        </p>
      )}
      {routines.map((r) => (
        <RoutineRow key={r.id} routine={r} botId={botId} />
      ))}
    </section>
  );
}
