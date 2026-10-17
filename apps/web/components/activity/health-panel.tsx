// SPDX-License-Identifier: Apache-2.0
'use client';

// Sentinel health panel (Activity → Health tab): the scheduled self-check
// report at GET /api/health/detail. Failing checks surface as warnings.

import { useCallback, useEffect, useState } from 'react';
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
    </div>
  );
}
