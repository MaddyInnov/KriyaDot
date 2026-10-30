// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Human time & energy panel (#47, Activity destination): per-session
 * approval counts, decision latency and the API's estimated time saved.
 * Consumes GET /api/human-accounting?sessionId= when present and falls
 * back to the existing global/by-bot GET /api/accounting/human — the
 * gap note below says plainly when per-session data is not available,
 * and a time-saved figure is only ever shown when the API provides one.
 */
import { useCallback, useEffect, useState } from 'react';
import { getHumanAccounting } from '../../lib/octomind-api';
import { formatDurationSeconds, normalizeHumanAccounting, type HumanAccountingView } from '../../lib/octomind-web';

export function HumanAccountingPanel() {
  const [sessionId, setSessionId] = useState('');
  const [appliedSession, setAppliedSession] = useState('');
  const [view, setView] = useState<HumanAccountingView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (sid: string) => {
    setLoading(true);
    setError('');
    try {
      const raw = await getHumanAccounting(sid || undefined);
      setView(normalizeHumanAccounting(raw));
      setAppliedSession(sid);
    } catch (err) {
      setView(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(''); }, [load]);

  const sessionRow = appliedSession ? view?.bySession.find((s) => s.sessionId === appliedSession) : undefined;
  const perSessionGap = Boolean(appliedSession) && view !== null && !sessionRow;

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Human time &amp; energy</h3>
      <p className="small muted">
        What this platform asks of a human: approval counts, how long decisions took
        (approval request → decision latency — bot blocked time and a proxy for human
        attention, not a time-tracking log), and the time-saved estimate when the API
        provides one.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input mono"
          style={{ flex: '0 1 320px' }}
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          placeholder="Session id (optional filter)"
          aria-label="Filter by session id"
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={loading} onClick={() => void load(sessionId.trim())}>
          {loading ? 'Loading…' : 'Apply'}
        </button>
        {appliedSession && (
          <button type="button" className="btn btn-sm" onClick={() => { setSessionId(''); void load(''); }}>Clear filter</button>
        )}
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>Human accounting unavailable: {error}</div>}
      {perSessionGap && (
        <div className="warn-box" style={{ marginTop: 8 }}>
          Per-session accounting is not available from this API yet — the filter was sent as
          <span className="mono"> ?sessionId={appliedSession}</span>, but the response only carries the
          global / by-bot report, which is what is shown below.
        </div>
      )}
      {view && (
        <>
          <div className="grid-2" style={{ marginTop: 12 }}>
            <div className="card">
              <strong>Approvals{sessionRow ? ` — session ${sessionRow.sessionId}` : ''}</strong>
              <p className="small" style={{ margin: '6px 0 0' }}>
                {sessionRow ? (
                  <>Interventions: {sessionRow.interventions} · Total decision latency: {formatDurationSeconds(sessionRow.responseSeconds)}</>
                ) : (
                  <>Requested: {view.requested} · Decided: {view.decided} · Approved: {view.approved} · Denied: {view.denied} · Pending: {view.pending}</>
                )}
              </p>
            </div>
            <div className="card">
              <strong>Decision latency</strong>
              <p className="small" style={{ margin: '6px 0 0' }}>
                Median: {formatDurationSeconds(view.medianSeconds)} · p90: {formatDurationSeconds(view.p90Seconds)} · Total: {formatDurationSeconds(view.totalResponseSeconds)}
              </p>
            </div>
            <div className="card">
              <strong>Estimated time saved</strong>
              <p className="small" style={{ margin: '6px 0 0' }}>
                {view.estimatedTimeSavedSeconds !== null || sessionRow?.estimatedTimeSavedSeconds !== undefined
                  ? formatDurationSeconds(sessionRow?.estimatedTimeSavedSeconds ?? view.estimatedTimeSavedSeconds)
                  : '— (the API does not provide a time-saved estimate yet, so none is shown rather than invented)'}
              </p>
            </div>
          </div>
          {!sessionRow && view.byBot.length > 0 && (
            <div className="card" style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
              <table className="tbl">
                <thead><tr><th>Bot</th><th>Interventions (decided approvals)</th><th>Human response time</th></tr></thead>
                <tbody>
                  {view.byBot.map((b) => (
                    <tr key={b.botId}>
                      <td className="mono">{b.botId}</td>
                      <td>{b.interventions}</td>
                      <td>{formatDurationSeconds(b.responseSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view.bySession.length > 0 && !appliedSession && (
            <p className="small muted" style={{ marginTop: 8 }}>
              Sessions in this report: {view.bySession.map((s) => s.sessionId).join(', ')}
            </p>
          )}
          {view.note && <p className="small muted" style={{ marginTop: 8 }}>{view.note}</p>}
        </>
      )}
    </div>
  );
}
