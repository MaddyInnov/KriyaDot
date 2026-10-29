// SPDX-License-Identifier: Apache-2.0
'use client';

// Daily Briefing surface: overnight activity, today's calendar, and pending
// approvals in one digest card. Backed by GET /api/briefing; when the backend
// is not built yet the panel renders an empty state (never an error).

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorBox } from '../../app/modules/lib';
import { getBriefing, getRegressions } from '../../lib/kriyadot-api';
import type { Briefing, BriefingItem, RegressionAlert, RegressionsPayload } from '../../lib/kriyadot-api';
import { useUxMode } from '../../lib/ux-mode';

function fmtTs(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

/** Human-readable metric value: ms/s for latency, % for error rate, $ for cost. */
function fmtMetricValue(alert: RegressionAlert, v: number): string {
  if (alert.metric === 'latency-p50') {
    return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
  }
  if (alert.metric === 'error-rate') return `${(v * 100).toFixed(1)}%`;
  return `$${v.toFixed(4)}`;
}

/**
 * Regression alerts card (feature #5): "quietly got worse this week".
 * Simple mode shows the headline + plain-language summary; Pro shows the
 * full baseline/current/sample-count detail.
 */
function RegressionsCard({ payload }: { payload: RegressionsPayload }) {
  const [mode] = useUxMode();
  const alerts = payload.regressions ?? [];
  if (alerts.length === 0) return null;
  return (
    <div className="card" style={{ borderColor: 'var(--amber, #b97f1f)' }}>
      <h4 className="mt0">
        ⚠️ Quietly got worse <span className="chip amber">{alerts.length}</span>
      </h4>
      <p className="small muted mt0">
        Last {payload.windowDays} days vs the {payload.windowDays} before — flagged when &gt;{payload.thresholdPct}%
        worse (min {payload.minSamples} samples per window).
      </p>
      <ul className="brief-list">
        {alerts.map((a) => (
          <li key={a.id} className="brief-item">
            <div className="brief-item-title">
              {a.scopeKind === 'bot' ? 'Bot' : 'Workflow'} <span className="mono">{a.scopeId}</span> —{' '}
              {a.metricLabel} {a.changePct >= 0 ? 'up' : 'down'} {Math.abs(Math.round(a.changePct))}%
            </div>
            <div className="brief-item-detail small muted">
              {fmtMetricValue(a, a.baseline)} → {fmtMetricValue(a, a.current)}
              {mode === 'pro' &&
                ` · ${a.currentSamples} recent / ${a.baselineSamples} baseline samples · window ${fmtTs(a.windowStart)} – ${fmtTs(a.windowEnd)}`}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemList({ items }: { items: BriefingItem[] }) {
  if (items.length === 0) return <p className="muted small">Nothing here.</p>;
  return (
    <ul className="brief-list">
      {items.map((it, i) => (
        <li key={it.id ?? `${it.title}-${i}`} className="brief-item">
          <div className="brief-item-title">{it.title}</div>
          {it.detail && <div className="brief-item-detail small muted">{it.detail}</div>}
          {it.ts ? <div className="brief-item-ts small muted">{fmtTs(it.ts)}</div> : null}
        </li>
      ))}
    </ul>
  );
}

export function BriefingPanel() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [regressions, setRegressions] = useState<RegressionsPayload | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([getBriefing(), getRegressions()]);
      setMissing(b === null);
      setBriefing(b);
      // Prefer alerts embedded in the briefing payload when the briefing
      // backend emits them; otherwise fall back to the standalone endpoint.
      if (b?.regressions) {
        setRegressions({
          generatedAt: b.generatedAt,
          windowDays: 7,
          thresholdPct: 30,
          minSamples: 10,
          regressions: b.regressions,
        });
      } else {
        setRegressions(r);
      }
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  // Alerts reach the briefing surface even before the briefing backend
  // exists: show them above the empty state when there is anything to show.
  if (missing || briefing === null) {
    return (
      <div>
        {regressions && <RegressionsCard payload={regressions} />}
        <EmptyState text="No briefing yet — the daily digest service is not available. Your morning summary will appear here once it is." />
      </div>
    );
  }

  return (
    <div>
      <div className="row-between">
        <h3 className="mt0">Daily briefing</h3>
        <span className="small muted">
          Generated {briefing.generatedAt ? fmtTs(briefing.generatedAt) : '—'}
        </span>
      </div>
      {regressions && <RegressionsCard payload={regressions} />}
      {briefing.summary && <p className="brief-summary">{briefing.summary}</p>}
      <div className="grid-2">
        <div className="card">
          <h4>Overnight</h4>
          <ItemList items={briefing.overnight ?? []} />
        </div>
        <div className="card">
          <h4>Today&apos;s calendar</h4>
          <ItemList items={briefing.calendar ?? []} />
        </div>
      </div>
      <div className="card">
        <h4>Needs your approval</h4>
        <ItemList items={briefing.approvals ?? []} />
      </div>
      {/* W14c Signals: GitHub review requests, failing CI, mentions. */}
      {(briefing.signals?.length ?? 0) > 0 && (
        <div className="card">
          <h4>
            Signals <span className="chip">{briefing.signals?.length ?? 0}</span>
          </h4>
          <ItemList items={briefing.signals ?? []} />
        </div>
      )}
      {/* W14b: batched phone notifications accumulated for this digest. */}
      {(briefing.notifications?.length ?? 0) > 0 && (
        <div className="card">
          <h4>
            Phone notifications <span className="chip">{briefing.notifications?.length ?? 0}</span>
          </h4>
          <ItemList items={briefing.notifications ?? []} />
        </div>
      )}
      {/* Feature interconnection: notes + workflow runs in the digest. */}
      {(briefing.notes?.length ?? 0) > 0 || (briefing.workflows?.length ?? 0) > 0 ? (
        <div className="grid-2">
          <div className="card">
            <h4>
              Notes changed <span className="chip">{briefing.notes?.length ?? 0}</span>
            </h4>
            <ItemList items={briefing.notes ?? []} />
          </div>
          <div className="card">
            <h4>
              Workflow runs <span className="chip">{briefing.workflows?.length ?? 0}</span>
            </h4>
            <ItemList items={briefing.workflows ?? []} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
