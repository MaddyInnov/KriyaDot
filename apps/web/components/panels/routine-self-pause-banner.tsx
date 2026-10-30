// SPDX-License-Identifier: Apache-2.0
'use client';

// SCH-13 — Self-pause banner for the routines (schedule) UI: when a job
// has paused ITSELF on a durable block (missing credential, repeated
// failures), show why it paused and when it would have run next, with an
// explicit Resume. Backed by GET /api/routine-pauses and
// POST /api/routine-pauses/:routineId/resume. Renders nothing when the
// routine has no active self-pause (the common case — one quiet fetch).

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface RoutinePause {
  routineId: string;
  reasonKind: 'durable-block' | 'repeated-failure';
  blockKind?: string;
  reason: string;
  consecutiveFailures: number;
  pausedAt: number;
  nextRunAt?: number;
}

export function RoutineSelfPauseBanner({ routineId }: { routineId: string }) {
  const [pause, setPause] = useState<RoutinePause | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/routine-pauses');
      if (!res.ok) return; // surface not wired on this instance — stay silent
      const data = (await res.json()) as { pauses: RoutinePause[] };
      setPause(data.pauses.find((p) => p.routineId === routineId) ?? null);
    } catch {
      // Silent: the banner is additive; the routines panel works without it.
    }
  }, [routineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resume = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await authedFetch(`/api/routine-pauses/${encodeURIComponent(routineId)}/resume`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
      setPause(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [routineId]);

  if (!pause) return null;

  return (
    <div className="streak-banner paused" role="alert">
      <p style={{ margin: 0 }}>
        ⏸️ <strong>This job paused itself</strong>
        {pause.reasonKind === 'durable-block'
          ? ` — durable block${pause.blockKind ? ` (${pause.blockKind})` : ''}: a human must fix the cause before it can succeed.`
          : ` — ${pause.consecutiveFailures} consecutive failed runs.`}
      </p>
      <p className="small" style={{ margin: '4px 0 0' }}>
        {pause.reason}
      </p>
      <p className="small" style={{ margin: '4px 0 0' }}>
        Paused {new Date(pause.pausedAt).toLocaleString()}
        {pause.nextRunAt
          ? ` · Would have run next at ${new Date(pause.nextRunAt).toLocaleString()}`
          : ''}
      </p>
      <button type="button" className="btn-ghost small" onClick={() => void resume()} disabled={busy}>
        {busy ? 'Resuming…' : 'Resume this job'}
      </button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
