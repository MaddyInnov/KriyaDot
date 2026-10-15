// SPDX-License-Identifier: Apache-2.0
'use client';

// Processing rules + firing log (feature #5: the auditable log gets a UI).
// Rules list on the left, the queryable firing log on the right. Reads
// GET /api/processing-rules and GET /api/processing-rules/firing-log via
// the kriyadot-api clients; renders an empty state (never an error) when the
// backend is missing.

import { useCallback, useEffect, useState } from 'react';
import {
  getProcessingRules,
  getRuleFirings,
  type ProcessingRule,
  type RuleFiring,
} from '../../lib/kriyadot-api';
import { EmptyState, ErrorBox } from '../../app/modules/lib';

function fmtTs(ts?: number): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function statusClass(status?: string): string {
  switch (status) {
    case 'success':
      return 'pill pill-ok';
    case 'error':
      return 'pill pill-bad';
    case 'skipped':
      return 'pill pill-warn';
    default:
      return 'pill';
  }
}

function firingDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return '—';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function RulesPanel() {
  const [rules, setRules] = useState<ProcessingRule[] | null>(null);
  const [firings, setFirings] = useState<RuleFiring[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterRule, setFilterRule] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, f] = await Promise.all([
        getProcessingRules(),
        getRuleFirings(filterRule ? { rule: filterRule } : undefined),
      ]);
      setRules(r ?? []);
      setFirings(f ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filterRule]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="rules-panel">
      <div className="panel-head">
        <div>
          <h2>Processing rules</h2>
          <p className="muted">
            Every rule firing is logged — who fired, what it did, and whether it
            succeeded — so automation stays auditable.
          </p>
        </div>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <ErrorBox error={error} />}

      <div className="rules-grid">
        <section className="card">
          <h3>Rules ({rules?.length ?? 0})</h3>
          {!rules || rules.length === 0 ? (
            <EmptyState text="No processing rules yet. Create one with POST /api/processing-rules." />
          ) : (
            <ul className="rule-list">
              {rules.map((r) => (
                <li key={r.id} className="rule-item">
                  <span className={r.enabled ? 'pill pill-ok' : 'pill pill-warn'}>
                    {r.enabled ? 'enabled' : 'disabled'}
                  </span>
                  <span className="rule-name">{r.name}</span>
                  <code className="mono muted">{r.id}</code>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3>Firing log</h3>
          <div className="row gap">
            <select
              aria-label="Filter by rule"
              value={filterRule}
              onChange={(e) => setFilterRule(e.target.value)}
            >
              <option value="">All rules</option>
              {(rules ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          {!firings || firings.length === 0 ? (
            <EmptyState text="No firings logged yet. Fire a rule with POST /api/processing-rules/:id/fire." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Rule</th>
                  <th>Item</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {firings.slice(0, 50).map((f, i) => (
                  <tr key={f.id ?? i}>
                    <td className="nowrap">{fmtTs(f.ts)}</td>
                    <td>{f.ruleName ?? f.ruleId ?? '—'}</td>
                    <td>
                      <code className="mono">{f.itemId ?? '—'}</code>
                    </td>
                    <td>{f.action ?? '—'}</td>
                    <td>
                      <span className={statusClass(f.status)}>{f.status ?? '—'}</span>
                    </td>
                    <td className="muted">{f.reason ?? firingDetail(f.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
