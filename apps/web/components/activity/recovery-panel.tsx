// SPDX-License-Identifier: Apache-2.0
'use client';

// Crash recovery inbox (Activity → Recovery tab): turns/runs/goals orphaned
// by a server restart, with one-click resume.

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface Orphan {
  id: string;
  kind: 'chat-turn' | 'routine-run' | 'team-run' | 'group-goal';
  refId: string;
  label: string;
  context: Record<string, unknown>;
  interruptedAt: number;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

const KIND_LABEL: Record<Orphan['kind'], string> = {
  'chat-turn': '💬 chat turn',
  'routine-run': '🔁 routine run',
  'team-run': '👥 team run',
  'group-goal': '🎯 group goal',
};

export function RecoveryPanel() {
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [busy, setBusy] = useState<string>('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ ok: boolean; orphans: Orphan[] }>('/api/recovery/orphans');
      setOrphans(data.orphans);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resume = async (o: Orphan) => {
    setBusy(o.id);
    try {
      const res = await apiJson<{ ok: boolean; kind: string; sessionId?: string; botId?: string; message?: string; resumeUrl?: string; newRunId?: string }>(
        `/api/recovery/orphans/${o.id}/resume`,
        { method: 'POST' },
      );
      if (res.kind === 'chat-turn' && res.message) {
        setNotice(
          `Resume this turn by re-sending to the bot (session ${res.sessionId}): “${String(res.message).slice(0, 120)}…”`,
        );
      } else if (res.resumeUrl) {
        setNotice(`Resume at ${res.resumeUrl}`);
      } else if (res.newRunId) {
        setNotice(`Team run restarted: ${res.newRunId}`);
      } else {
        setNotice('Resumed.');
      }
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const dismiss = async (o: Orphan) => {
    setBusy(o.id);
    try {
      await apiJson(`/api/recovery/orphans/${o.id}/dismiss`, { method: 'POST' });
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Crash recovery</h2>
      <p className="muted small">
        When the server restarts, in-flight turns, runs, and goals are marked{' '}
        <em>interrupted (server restart)</em> and land here for one-click resume.
      </p>
      {notice && <p className="small muted">{notice}</p>}
      {orphans.length === 0 && <p className="muted">No interrupted work. Everything is clean.</p>}
      {orphans.map((o) => (
        <div key={o.id} className="card" style={{ borderLeft: '3px solid var(--warn, #c90)' }}>
          <div>
            <span className="chip">{KIND_LABEL[o.kind]}</span>{' '}
            <strong>{o.label}</strong>
            <div className="small muted">
              interrupted {new Date(o.interruptedAt).toLocaleString()}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy === o.id}
              onClick={() => void resume(o)}
            >
              {o.kind === 'chat-turn' ? 'Show resume context' : 'Resume'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy === o.id}
              onClick={() => void dismiss(o)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
