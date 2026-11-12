// SPDX-License-Identifier: Apache-2.0
'use client';

// Sentinel health panel (Activity → Health tab): the scheduled self-check
// report at GET /api/health/detail. Failing checks surface as warnings.
// Below it, the self-monitoring section (B3) renders the resource guard's
// snapshot from GET /api/health/self — uptime, memory trend, event-loop
// lag, live run counts, and the guard's pressure/shedding state — with
// the guard's on/off and shedding switches (PUT /api/health/resource-guard).

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface SentinelCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface SentinelReport {
  at: number;
  checks: SentinelCheck[];
  warnings: string[];
}

async function apiJson<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

// ---- Self-monitoring snapshot (B3, GET /api/health/self) -----------------

export interface SelfSnapshot {
  at: number;
  uptimeSeconds: number;
  process: { pid: number; rssBytes: number | null; heapUsedBytes: number | null; heapTotalBytes: number | null };
  eventLoopLagMs: number | null;
  memoryTrend: { samples: number; rssSlopeBytesPerMinute: number; rssMinBytes: number | null; rssMaxBytes: number | null };
  counts: { activeTurns?: number; runningWorkflowRuns?: number; routineRunsInFlight?: number; pendingApprovals?: number };
  guard: {
    enabled: boolean;
    shedEnabled: boolean;
    level: 'ok' | 'soft' | 'hard';
    shedding: boolean;
    denialCount: number;
    lastDenial: { at: number; kind: string; reason: string } | null;
    settings: { memorySoftBytes: number; memoryHardBytes: number };
  };
}

function fmtMb(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '—' : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function fmtUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

export function SelfMonitorSection() {
  const [snapshot, setSnapshot] = useState<SelfSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnapshot(await apiJson<SelfSnapshot>('/api/health/self'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (patch: { enabled?: boolean; shedEnabled?: boolean }) => {
      if (!snapshot) return;
      setBusy(true);
      try {
        const res = await authedFetch('/api/health/resource-guard', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...snapshot.guard.settings, ...patch }),
        });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [snapshot, load],
  );

  if (error && !snapshot) {
    return (
      <div className="card">
        <h3>Self-monitoring</h3>
        <p className="muted small">Unavailable on this server ({error}).</p>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="card">
        <h3>Self-monitoring</h3>
        <p className="muted">Loading…</p>
      </div>
    );
  }
  const g = snapshot.guard;
  const slopeMb = Math.round(snapshot.memoryTrend.rssSlopeBytesPerMinute / 1024 ** 2);
  return (
    <div className="card" style={g.shedding ? { borderColor: 'var(--danger, #c00)' } : undefined}>
      <h3>Self-monitoring — this process</h3>
      {g.shedding && (
        <p>
          🛑 <strong>Resource guard is shedding new optional work</strong> (background routines pause;
          work already running is untouched).
          {g.lastDenial && <div className="muted small">{g.lastDenial.reason}</div>}
        </p>
      )}
      <ul className="list">
        <li>
          <strong>Guard</strong>:{' '}
          {g.enabled ? `on — pressure ${g.level}${g.shedding ? ', shedding' : ''}` : 'off'}
          {g.enabled && !g.shedEnabled ? ' (monitor only — shedding disabled)' : ''}
          <div className="muted small">
            Soft at {fmtMb(g.settings.memorySoftBytes)} RSS, hard at {fmtMb(g.settings.memoryHardBytes)} RSS.
            Refused starts so far: {g.denialCount}.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void toggle({ enabled: !g.enabled })}>
              {g.enabled ? 'Turn guard off' : 'Turn guard on'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !g.enabled}
              onClick={() => void toggle({ shedEnabled: !g.shedEnabled })}
            >
              {g.shedEnabled ? 'Disable shedding' : 'Enable shedding'}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </li>
        <li>
          <strong>Memory</strong>: RSS {fmtMb(snapshot.process.rssBytes)} · heap {fmtMb(snapshot.process.heapUsedBytes)} of{' '}
          {fmtMb(snapshot.process.heapTotalBytes)}
          <div className="muted small">
            Trend over {snapshot.memoryTrend.samples} samples: {slopeMb > 0 ? '▲' : slopeMb < 0 ? '▼' : '•'} {Math.abs(slopeMb)} MB/min
            · range {fmtMb(snapshot.memoryTrend.rssMinBytes)}–{fmtMb(snapshot.memoryTrend.rssMaxBytes)}
          </div>
        </li>
        <li>
          <strong>Event-loop lag</strong>: {snapshot.eventLoopLagMs === null ? '—' : `${snapshot.eventLoopLagMs.toFixed(1)} ms`}
        </li>
        <li>
          <strong>Uptime</strong>: {fmtUptime(snapshot.uptimeSeconds)} · <strong>Active turns</strong>:{' '}
          {snapshot.counts.activeTurns ?? '—'} · <strong>Workflow runs</strong>: {snapshot.counts.runningWorkflowRuns ?? '—'} ·{' '}
          <strong>Pending approvals</strong>: {snapshot.counts.pendingApprovals ?? '—'}
        </li>
      </ul>
      <p className="muted small">
        The guard watches this process only (RSS, event-loop lag, data-disk space). It cannot see other
        processes or container limits — a seatbelt, not a cage.
      </p>
    </div>
  );
}

export function HealthPanel() {
  const [report, setReport] = useState<SentinelReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiJson<{ ok: boolean; report: SentinelReport }>('/api/health/detail');
      setReport(data.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>System health</h2>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          Re-check now
        </button>
      </div>
      <p className="muted small">
        The Sentinel self-check runs every 30 minutes: databases, disk space, memory, and provider
        configuration presence (no paid calls). Last check:{' '}
        {report ? new Date(report.at).toLocaleString() : '—'}
      </p>
      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Checking…</p>}
      {report && (
        <>
          {report.warnings.length > 0 && (
            <div className="card" style={{ borderColor: 'var(--danger, #c00)' }}>
              <h3>Warnings</h3>
              <ul>
                {report.warnings.map((w, i) => (
                  <li key={i}>⚠️ {w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="card">
            <h3>Checks</h3>
            <ul className="list">
              {report.checks.map((c) => (
                <li key={c.name}>
                  {c.ok ? '✅' : '❌'} <strong>{c.name}</strong>
                  <div className="muted small">{c.detail}</div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <SelfMonitorSection />
    </div>
  );
}
