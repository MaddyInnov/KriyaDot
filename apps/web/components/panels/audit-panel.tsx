// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAudit } from '../../lib/api';
import type { AuditEntry } from '../../lib/api';

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function AuditPanel({ hideHeader = false }: { hideHeader?: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  const [limit] = useState(100);

  const refresh = useCallback(async () => {
    try {
      setEntries(await getAudit(limit));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div>
      {!hideHeader && (
        <>
          <h1 className="page-title">Audit log</h1>
          <p className="page-sub">
            Append-only record of governance decisions and tool executions. Newest first, refreshes
            every 5 seconds. Secrets are redacted at write time.
          </p>
        </>
      )}
      {error && <div className="error-box">{error}</div>}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Tool</th>
              <th>Decision</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                  {fmtTs(e.ts)}
                </td>
                <td className="mono">{e.actor}</td>
                <td className="mono">
                  {e.action}
                  {/failover|limit_reset|usage_warning|provider_limit/.test(e.action) && (
                    <span className="chip gray" style={{ marginLeft: 6 }} title="AI failover / provider limit event (W1)">
                      {e.action.includes('failover')
                        ? '🔁 failover'
                        : e.action.includes('usage_warning')
                          ? '⚠️ near-limit'
                          : '⏳ limit-reset'}
                    </span>
                  )}
                </td>
                <td className="mono">{e.toolName ?? '—'}</td>
                <td>
                  {e.decision ? (
                    <span
                      className={`chip ${
                        e.decision === 'approved' ? 'green' : e.decision === 'denied' ? 'red' : 'gray'
                      }`}
                    >
                      {e.decision}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="small muted truncate" title={e.detail ?? ''}>
                  {e.detail ?? '—'}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No audit entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
