// SPDX-License-Identifier: Apache-2.0
'use client';

// Cost dashboard (Pro surface): spend by feature (SVG donut + table), spend
// by step (CSS bars), and monthly caps with exceeded highlighting.
// Charts are pure CSS/SVG — no new dependencies. Backed by
// GET /api/usage/breakdown?period=…; when the backend is missing the panel
// renders an empty state (never an error).

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorBox } from '../../app/modules/lib';
import { getUsageBreakdown } from '../../lib/kriyadot-api';
import type { UsageBreakdown } from '../../lib/kriyadot-api';
import { formatTokens } from '../../lib/usage';
import { capPct, donutSegments, fmtUsd, sharePct } from '../../lib/cost';

const DONUT_COLORS = [
  'var(--cost-1, #7c6cf0)',
  'var(--cost-2, #4cc2a8)',
  'var(--cost-3, #f0a35e)',
  'var(--cost-4, #e06c9f)',
  'var(--cost-5, #5eb3f0)',
  'var(--cost-6, #b8b34e)',
];

function Donut({ values }: { values: number[] }) {
  const segs = donutSegments(values);
  const any = segs.some((s) => s.length > 0);
  return (
    <svg viewBox="0 0 42 42" className="cost-donut" role="img" aria-label="Cost share by feature">
      <circle cx="21" cy="21" r="15.9155" fill="none" strokeWidth="6"
        className="cost-donut-track" />
      {any &&
        segs.map((s, i) =>
          s.length > 0 ? (
            <circle
              key={i}
              cx="21"
              cy="21"
              r="15.9155"
              fill="none"
              strokeWidth="6"
              pathLength={100}
              strokeDasharray={`${s.length} ${100 - s.length}`}
              strokeDashoffset={s.offset}
              stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
              strokeLinecap="butt"
            />
          ) : null,
        )}
    </svg>
  );
}

export function CostPanel() {
  const [period, setPeriod] = useState<'week' | 'month'>('month');
  const [data, setData] = useState<UsageBreakdown | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (p: 'week' | 'month') => {
    try {
      const d = await getUsageBreakdown(p);
      setMissing(d === null);
      setData(d);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  if (error) return <ErrorBox error={error} />;
  if (missing || data === null) {
    return (
      <EmptyState text="No usage data yet — the usage/breakdown service is not available. Spend by feature, by step, and cap tracking will appear here once it is." />
    );
  }

  const byFeature = data.byFeature ?? [];
  const byStep = data.byStep ?? [];
  const caps = data.caps ?? [];
  const totalCost = byFeature.reduce((a, f) => a + (f.cost || 0), 0);
  const totalTokens = byFeature.reduce((a, f) => a + (f.tokens || 0), 0);
  const maxStepCost = Math.max(0, ...byStep.map((s) => s.cost || 0));

  return (
    <div>
      <div className="row-between">
        <h3 className="mt0">Cost dashboard</h3>
        <div className="row gap">
          <span className="chip blue">{fmtUsd(totalCost)} total</span>
          <span className="chip gray">{formatTokens(totalTokens)} tokens</span>
          <select
            className="select"
            value={period}
            onChange={(e) => setPeriod(e.target.value as 'week' | 'month')}
            aria-label="Usage period"
          >
            <option value="month">This month</option>
            <option value="week">This week</option>
          </select>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h4 className="mt0">Spend by feature</h4>
          {byFeature.length === 0 ? (
            <p className="muted small">No feature spend recorded.</p>
          ) : (
            <div className="row gap">
              <Donut values={byFeature.map((f) => f.cost)} />
              <div className="cost-legend">
                {byFeature.map((f, i) => (
                  <div key={f.feature} className="cost-legend-row">
                    <span
                      className="cost-swatch"
                      style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
                      aria-hidden="true"
                    />
                    <span className="mono small">{f.feature}</span>
                    <span className="small muted">{sharePct(f.cost, totalCost).toFixed(1)}%</span>
                    <strong className="small">{fmtUsd(f.cost)}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="card">
          <h4 className="mt0">Spend by step</h4>
          {byStep.length === 0 ? (
            <p className="muted small">No step spend recorded.</p>
          ) : (
            <div className="cost-bars">
              {byStep.map((s) => (
                <div key={s.step} className="cost-bar-row">
                  <span className="mono small cost-bar-label">{s.step}</span>
                  <div className="cost-bar-track" role="img" aria-label={`${s.step}: ${fmtUsd(s.cost)}`}>
                    <div
                      className="cost-bar-fill"
                      style={{ width: `${sharePct(s.cost, maxStepCost)}%` }}
                    />
                  </div>
                  <span className="small muted cost-bar-val">
                    {fmtUsd(s.cost)} · {formatTokens(s.tokens)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h4 className="mt0">Monthly caps</h4>
        {caps.length === 0 ? (
          <p className="muted small">No caps configured.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Used / cap</th>
                <th style={{ width: '40%' }}>Progress</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {caps.map((c) => (
                <tr key={c.feature} className={c.exceeded ? 'cost-cap-exceeded' : undefined}>
                  <td className="mono">{c.feature}</td>
                  <td className="small">
                    {fmtUsd(c.used)} / {fmtUsd(c.cap)}
                  </td>
                  <td>
                    <div className="cost-bar-track" role="img" aria-label={`${c.feature} cap ${capPct(c.used, c.cap).toFixed(0)}% used`}>
                      <div
                        className={`cost-bar-fill${c.exceeded ? ' exceeded' : ''}`}
                        style={{ width: `${capPct(c.used, c.cap)}%` }}
                      />
                    </div>
                  </td>
                  <td>
                    {c.exceeded ? (
                      <span className="chip red">exceeded</span>
                    ) : (
                      <span className="chip green">within cap</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
