// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getFusionRun,
  listFusionRuns,
  type FusionRunDto,
} from '../../lib/api';
import {
  FusionProgressView,
  applyFusionEvent,
  emptyFusionState,
  type FusionLiveState,
} from '../../components/fusion/fusion-progress';

/**
 * Fusion run history: past planner + parallel-worker + fused-synthesis
 * runs, each expandable to show the plan, per-worker outputs, and the
 * fused result.
 */
export default function FusionHistoryPage() {
  const [runs, setRuns] = useState<FusionRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<FusionRunDto | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listFusionRuns(50)
      .then((r) => {
        if (!cancelled) setRuns(r.runs);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openDetail = async (runId: string): Promise<void> => {
    setLoadingDetail(true);
    try {
      const r = await getFusionRun(runId);
      setDetail(r.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  };

  const detailState: FusionLiveState | null = detail
    ? applyFusionEvent(emptyFusionState(), { type: 'snapshot', run: detail })
    : null;

  return (
    <div className="fusion-history">
      <Link href="/" className="fusion-history-link">
        ← Back to chat
      </Link>
      <h1>⚡ Fusion runs</h1>
      <p className="muted small">
        Planner + parallel worker + fused synthesis runs. Toggle Fusion mode in the chat composer
        to start one.
      </p>
      {error && <div className="fusion-error">Error: {error}</div>}
      {runs === null && !error && <div className="muted">Loading…</div>}
      {runs !== null && runs.length === 0 && (
        <div className="muted">No fusion runs yet.</div>
      )}
      {runs?.map((run) => (
        <details key={run.runId} className="fusion-history-item">
          <summary onClick={() => void openDetail(run.runId)}>
            <span className="fusion-history-task" title={run.task}>
              {run.task}
            </span>
            <span className="mono small muted">{run.botName}</span>
            <span className="mono small muted">
              {new Date(run.createdAt).toLocaleString()}
            </span>
          </summary>
          <div className="mt">
            {loadingDetail && !detail ? (
              <div className="muted small">Loading…</div>
            ) : detail && detail.runId === run.runId && detailState ? (
              <FusionProgressView state={detailState} run={detail} />
            ) : (
              <button
                type="button"
                className="fusion-toggle"
                onClick={() => void openDetail(run.runId)}
              >
                Load details
              </button>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
