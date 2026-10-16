// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import type {
  FusionPlanDto,
  FusionRunDto,
  FusionRunStatus,
  FusionStreamEvent,
  FusionWorkerResultDto,
} from '../../lib/api';

/**
 * Live view of a fusion run: plan → per-worker status → fused result.
 * Driven by FusionStreamEvents from the SSE stream (or a stored record).
 */

export interface FusionLiveState {
  status: FusionRunStatus;
  plan: FusionPlanDto | null;
  planFailedReason: string | null;
  workerStatus: Record<string, 'running' | 'done' | 'failed'>;
  workerResults: FusionWorkerResultDto[];
  fused: string | null;
  fallbackSingleAgent: boolean;
  error: string | null;
  costUsd: number | null;
}

export function emptyFusionState(): FusionLiveState {
  return {
    status: 'running',
    plan: null,
    planFailedReason: null,
    workerStatus: {},
    workerResults: [],
    fused: null,
    fallbackSingleAgent: false,
    error: null,
    costUsd: null,
  };
}

/** Fold one stream event into the live state. Pure — easy to test. */
export function applyFusionEvent(state: FusionLiveState, e: FusionStreamEvent): FusionLiveState {
  switch (e.type) {
    case 'snapshot': {
      const run = e.run;
      const workerStatus: Record<string, 'running' | 'done' | 'failed'> = {};
      for (const r of run.workerResults) workerStatus[r.subtaskId] = r.error ? 'failed' : 'done';
      return {
        status: run.status,
        plan: run.plan,
        planFailedReason: run.fallbackSingleAgent && !run.plan ? 'Planner fell back to single-agent mode.' : null,
        workerStatus,
        workerResults: run.workerResults,
        fused: run.fused,
        fallbackSingleAgent: run.fallbackSingleAgent,
        error: run.error,
        costUsd: run.costUsd,
      };
    }
    case 'plan_created':
      return { ...state, plan: e.plan };
    case 'plan_failed':
      return { ...state, planFailedReason: e.reason, fallbackSingleAgent: true };
    case 'worker_started':
      return { ...state, workerStatus: { ...state.workerStatus, [e.subtaskId]: 'running' } };
    case 'worker_done':
      return {
        ...state,
        workerStatus: { ...state.workerStatus, [e.subtaskId]: e.ok ? 'done' : 'failed' },
      };
    case 'fusion_started':
      return state;
    case 'done': {
      const r = e.result;
      const workerStatus: Record<string, 'running' | 'done' | 'failed'> = {};
      for (const w of r.workerResults) workerStatus[w.subtaskId] = w.error ? 'failed' : 'done';
      return {
        status: r.status,
        plan: r.plan,
        planFailedReason: state.planFailedReason,
        workerStatus,
        workerResults: r.workerResults,
        fused: r.fused,
        fallbackSingleAgent: r.fallbackSingleAgent,
        error: r.error ?? null,
        costUsd: r.costUsd ?? null,
      };
    }
    case 'error':
      return { ...state, status: 'failed', error: e.message };
    default:
      return state;
  }
}

function statusChip(status: FusionRunStatus): string {
  switch (status) {
    case 'completed':
      return 'chip green';
    case 'failed':
      return 'chip red';
    case 'aborted_budget':
      return 'chip amber';
    default:
      return 'chip gray';
  }
}

export function FusionProgressView({ state, run }: { state: FusionLiveState; run?: FusionRunDto }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string): void => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const subtasks = state.plan?.subtasks ?? [];
  const resultsById = new Map(state.workerResults.map((r) => [r.subtaskId, r]));

  return (
    <div className="fusion-run">
      <div className="fusion-head">
        <span className={statusChip(state.status)}>{state.status.replace('_', ' ')}</span>
        <span className="mono small muted">fusion</span>
        {state.costUsd !== null && state.costUsd !== undefined && (
          <span className="mono small muted">≈${state.costUsd.toFixed(4)}</span>
        )}
      </div>

      {state.planFailedReason && (
        <div className="fusion-note">
          Planner unavailable ({state.planFailedReason}) — ran as a single agent turn.
        </div>
      )}

      {subtasks.length > 0 && (
        <div className="fusion-plan">
          <div className="label">Plan · {subtasks.length} subtask{subtasks.length === 1 ? '' : 's'}</div>
          <ul className="fusion-workers">
            {subtasks.map((s) => {
              const st = state.workerStatus[s.id];
              const result = resultsById.get(s.id);
              const icon = st === 'done' ? '✓' : st === 'failed' ? '✗' : st === 'running' ? '◌' : '○';
              return (
                <li key={s.id} className={`fusion-worker ${st ?? 'pending'}`}>
                  <button
                    type="button"
                    className="fusion-worker-toggle"
                    onClick={() => toggle(s.id)}
                    aria-expanded={!!expanded[s.id]}
                  >
                    <span className="fusion-icon" aria-hidden="true">
                      {icon}
                    </span>
                    <span className="mono small">{s.id}</span>
                    <span>{s.title}</span>
                    {s.dependencies.length > 0 && (
                      <span className="muted small">← after {s.dependencies.join(', ')}</span>
                    )}
                  </button>
                  {expanded[s.id] && (
                    <div className="fusion-worker-detail">
                      <div className="label">Instructions</div>
                      <p className="pre-wrap small">{s.description}</p>
                      {result && (
                        <>
                          <div className="label mt">Worker output</div>
                          {result.error ? (
                            <p className="fusion-error small">Worker failed: {result.error}</p>
                          ) : (
                            <p className="pre-wrap small">{result.output || '(no output)'}</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {state.error && <div className="fusion-error">Error: {state.error}</div>}

      {state.fused !== null && (
        <div className="fusion-result">
          <div className="label">
            {state.fallbackSingleAgent ? 'Result (single agent)' : 'Fused result'}
          </div>
          <div className="msg-text pre-wrap">{state.fused}</div>
          {state.workerResults.length > 0 && !state.fallbackSingleAgent && (
            <div className="muted small mt">
              Synthesized from {state.workerResults.filter((r) => !r.error).length}/
              {state.workerResults.length} worker outputs
              {run && <> · <span className="mono">{run.runId}</span></>}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
