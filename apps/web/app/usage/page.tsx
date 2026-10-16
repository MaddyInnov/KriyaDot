// SPDX-License-Identifier: Apache-2.0
'use client';

// Usage dashboard (OpenCode-style): token usage and cost breakdown
// backed by GET /api/usage/breakdown.

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface BreakdownTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  eventCount: number;
}

interface BreakdownEntry {
  key: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  eventCount: number;
}

interface BreakdownResponse {
  period: string;
  since: number;
  until: number;
  byFeature: BreakdownEntry[];
  byStep: BreakdownEntry[];
  totals: BreakdownTotals;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}

export default function UsagePage() {
  const [period, setPeriod] = useState<'day' | 'week' | 'month' | 'all'>('month');
  const [data, setData] = useState<BreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authedFetch(`/api/usage/breakdown?period=${period}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as BreakdownResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page usage-page">
      <div className="page-header">
        <h1>Usage</h1>
        <div className="period-picker">
          {(['day', 'week', 'month', 'all'] as const).map((p) => (
            <button
              key={p}
              className={`btn btn-sm${period === p ? ' btn-primary' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="muted">Loading usage…</p>}
      {error && <p className="error">Failed to load usage: {error}</p>}

      {data && !loading && (
        <>
          <div className="usage-cards">
            <div className="usage-card">
              <div className="usage-card-label">Total tokens</div>
              <div className="usage-card-value">{fmtTokens(data.totals.totalTokens)}</div>
              <div className="usage-card-sub">
                ↑ {fmtTokens(data.totals.inputTokens)} in · ↓ {fmtTokens(data.totals.outputTokens)} out
              </div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">Estimated cost</div>
              <div className="usage-card-value">{fmtUsd(data.totals.costCents)}</div>
              <div className="usage-card-sub">{data.totals.eventCount} turns</div>
            </div>
          </div>

          <h2>By model</h2>
          {data.byStep.length === 0 ? (
            <p className="muted">No usage in this period.</p>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Turns</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.byStep.map((s) => (
                  <tr key={s.key}>
                    <td className="mono">{s.key}</td>
                    <td>{s.eventCount}</td>
                    <td>{fmtTokens(s.totalTokens)}</td>
                    <td>{fmtUsd(s.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>By feature</h2>
          {data.byFeature.length === 0 ? (
            <p className="muted">No usage in this period.</p>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Turns</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.byFeature.map((f) => (
                  <tr key={f.key}>
                    <td className="mono">{f.key}</td>
                    <td>{f.eventCount}</td>
                    <td>{fmtTokens(f.totalTokens)}</td>
                    <td>{fmtUsd(f.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
