// SPDX-License-Identifier: Apache-2.0
'use client';

// SCH-5 — Supervised services panel (Activity → Services tab): the
// long-lived subsystems the API supervises (routines engine, account
// sync, connector sync, dreamer, …) with live status, a restart action
// ONLY where a real in-process restart seam exists (the API says so via
// canRestart — there is no fake restart button), and recent logs.
// Backed by GET /api/services and POST /api/services/:id/restart.

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface SupervisedService {
  id: string;
  name: string;
  description: string;
  status: 'running' | 'degraded' | 'stopped' | 'unknown';
  detail?: string;
  since?: number;
  canRestart: boolean;
  recentLogs: string[];
  lastRestartAt?: number;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

const STATUS_ICON: Record<SupervisedService['status'], string> = {
  running: '🟢',
  degraded: '🟡',
  stopped: '🔴',
  unknown: '⚪',
};

export function ServicesPanel() {
  const [services, setServices] = useState<SupervisedService[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [openLogs, setOpenLogs] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiJson<{ ok: boolean; services: SupervisedService[] }>('/api/services');
      setServices(data.services);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restart = useCallback(
    async (id: string) => {
      setRestarting(id);
      setError('');
      try {
        await apiJson(`/api/services/${encodeURIComponent(id)}/restart`, { method: 'POST' });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRestarting(null);
      }
    },
    [load],
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Supervised services</h2>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      <p className="muted small">
        The background subsystems this instance supervises. Restart is offered only where a
        service can genuinely restart in-process; others restart with the app and say so.
      </p>
      {error && <p className="error-text">{error}</p>}
      {loading && !services && <p className="muted">Loading services…</p>}
      {services && services.length === 0 && <p className="muted">No supervised services registered.</p>}
      {services?.map((service) => (
        <div key={service.id} className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span aria-hidden="true">{STATUS_ICON[service.status]}</span>
            <strong>{service.name}</strong>
            <span className="muted small">{service.status}</span>
            {service.canRestart ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void restart(service.id)}
                disabled={restarting === service.id}
              >
                {restarting === service.id ? 'Restarting…' : 'Restart'}
              </button>
            ) : (
              <span className="muted small">(restarts with the app)</span>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setOpenLogs(openLogs === service.id ? null : service.id)}
            >
              {openLogs === service.id ? 'Hide logs' : 'Recent logs'}
            </button>
          </div>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            {service.description}
            {service.detail ? ` — ${service.detail}` : ''}
            {service.lastRestartAt
              ? ` · Last restarted ${new Date(service.lastRestartAt).toLocaleString()}`
              : ''}
          </p>
          {openLogs === service.id && (
            <pre
              className="small"
              style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', marginTop: 8 }}
            >
              {service.recentLogs.length > 0 ? service.recentLogs.join('\n') : '(no recent logs)'}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
