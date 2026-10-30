// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Unified /status view (#178, Activity destination): one panel
 * aggregating workflow runs, background jobs, monitors and shell jobs
 * from the new GET /api/status endpoint. Rendered through the generic
 * command-result sections so any payload shape displays sanely; when
 * the endpoint has not landed, the panel says so honestly instead of
 * stitching together a partial picture and calling it unified.
 */
import { useCallback, useEffect, useState } from 'react';
import { getUnifiedStatus, isAbsent } from '../../lib/octomind-api';
import { CommandResultCard } from '../chat/command-result-card';

export function UnifiedStatusPanel() {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [absent, setAbsent] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setAbsent(false);
    try {
      setPayload(await getUnifiedStatus());
    } catch (err) {
      setPayload(null);
      if (isAbsent(err)) setAbsent(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Unified status (/status)</h3>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void load()}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>
      <p className="small muted">
        Workflow runs, background jobs, monitors and shell jobs in one place — the same
        payload the in-chat <span className="mono">/status</span> command renders.
      </p>
      {absent && (
        <div className="warn-box">
          The unified status endpoint (GET /api/status) has not landed on this API yet.
          Until it does, the pieces live in their existing places: workflow runs in
          Workflows and Activity → Runs, monitors in Activity → Watch, approvals in
          Activity → Approvals.
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {payload && <CommandResultCard title="Status" payload={payload} />}
    </div>
  );
}
