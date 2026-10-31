// SPDX-License-Identifier: Apache-2.0
'use client';

// Chat | Trajectory view (2026-10-31 minimal-UI redesign): the recorded
// span trajectory of the CURRENT chat session, projected by
// lib/trajectory.ts into a harness-style badge feed + 3-lane timeline.
//
// Data: GET /api/observability/runs?sessionId=… (runs are created per
// chat turn with the chat sessionId), then per-run detail for spans,
// newest runs first, with a total span budget so a long session stays
// cheap — older runs still appear as run-start events without spans.
// Polls every ~3s while `live` (a turn is streaming) and reloads when
// `refreshKey` changes (a turn completed).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';
import {
  buildTrajectory,
  type SessionTrajectory,
  type TrajBadge,
  type TrajEvent,
  type TrajRun,
  type TrajSpan,
} from '../../lib/trajectory';

/** What a selection hands to the step inspector. */
export interface TrajSelection {
  event: TrajEvent;
  span: TrajSpan | null;
  run: TrajRun | null;
  sessionStart: number;
  /** Session the selection belongs to (lets the page drop stale selections). */
  sessionId: string;
}

const MAX_RUNS = 100;
/** Total spans fetched across all runs (newest runs win the budget). */
const MAX_SPANS = 400;
const POLL_MS = 3000;

type TrajFilter = 'all' | 'turns' | 'calls' | 'subagents';

const FILTERS: Array<{ id: TrajFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'turns', label: 'Turns' },
  { id: 'calls', label: 'Calls' },
  { id: 'subagents', label: 'Subagents' },
];

function matchesFilter(event: TrajEvent, filter: TrajFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'turns':
      return event.badge === 'user' || event.badge === 'assistant' || event.badge === 'context';
    case 'calls':
      return event.badge === 'tool';
    case 'subagents':
      return event.badge === 'subagent';
  }
}

const BADGE_LABEL: Record<TrajBadge, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  context: 'CONTEXT',
  subagent: 'SUBAGENT',
};

const LANE_LABEL = { input: 'Input', model: 'Model', tools: 'Tools' } as const;

async function apiJson<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

function fmtClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  } catch {
    return '';
  }
}

function fmtDur(ms: number | null): string {
  if (ms === null) return '…';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${(s / 60).toFixed(1)}m`;
}

export function TrajectoryView({
  sessionId,
  live = false,
  refreshKey = 0,
  selectedEventId = null,
  onSelect,
}: {
  sessionId: string;
  live?: boolean;
  refreshKey?: number;
  selectedEventId?: string | null;
  onSelect?: (selection: TrajSelection) => void;
}) {
  const [runs, setRuns] = useState<TrajRun[]>([]);
  const [spansByRun, setSpansByRun] = useState<Record<string, TrajSpan[]>>({});
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<TrajFilter>('all');
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) {
      setRuns([]);
      setSpansByRun({});
      setLoaded(true);
      return;
    }
    const seq = ++loadSeq.current;
    try {
      const list = await apiJson<{ runs: TrajRun[] }>(
        `/api/observability/runs?sessionId=${encodeURIComponent(sessionId)}&limit=${MAX_RUNS}`,
      );
      if (loadSeq.current !== seq) return;
      const fetchedRuns = list.runs ?? [];
      // Detail-fetch newest first until the span budget runs out.
      const byRun: Record<string, TrajSpan[]> = {};
      let budget = MAX_SPANS;
      for (const run of fetchedRuns) {
        if (budget <= 0) break;
        try {
          const detail = await apiJson<{ spans: TrajSpan[] }>(
            `/api/observability/runs/${encodeURIComponent(run.runId)}`,
          );
          if (loadSeq.current !== seq) return;
          const spans = (detail.spans ?? []).slice(0, budget);
          byRun[run.runId] = spans;
          budget -= spans.length;
        } catch {
          // One run's detail failing must not blank the whole trajectory.
        }
      }
      setRuns(fetchedRuns);
      setSpansByRun(byRun);
      setError('');
      setLoaded(true);
    } catch (e) {
      if (loadSeq.current !== seq) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const model: SessionTrajectory = useMemo(
    () => buildTrajectory(runs, spansByRun),
    [runs, spansByRun],
  );
  const visible = useMemo(
    () => model.events.filter((e) => matchesFilter(e, filter)),
    [model, filter],
  );

  const select = (event: TrajEvent) => {
    if (!onSelect) return;
    const span = event.spanId
      ? (spansByRun[event.runId] ?? []).find((s) => s.id === event.spanId) ?? null
      : null;
    const run = runs.find((r) => r.runId === event.runId) ?? null;
    onSelect({ event, span, run, sessionStart: model.windowStart, sessionId });
  };

  if (!sessionId) {
    return <div className="traj-empty muted">No chat session yet — send a message first.</div>;
  }
  if (!loaded) {
    return <div className="traj-empty muted">Loading trajectory…</div>;
  }
  if (error && runs.length === 0) {
    return <div className="traj-empty error-text">Could not load trajectory: {error}</div>;
  }
  if (model.events.length === 0) {
    return (
      <div className="traj-empty muted">
        No recorded runs for this session yet. Turns are recorded as they happen — send a message and
        its trajectory will appear here.
      </div>
    );
  }

  return (
    <div className="traj-view">
      <div className="traj-chips" role="group" aria-label="Trajectory filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`traj-chip${filter === f.id ? ' active' : ''}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span className="traj-count small muted">
          {visible.length} of {model.events.length} events
        </span>
      </div>

      <div className="traj-lanes" aria-label="Session timeline">
        {(Object.keys(LANE_LABEL) as Array<keyof typeof LANE_LABEL>).map((lane) => (
          <div key={lane} className="traj-lane-row">
            <span className="traj-lane-label">{LANE_LABEL[lane]}</span>
            <div className="traj-lane-track">
              {model.lanes[lane].map((seg) => (
                <button
                  key={seg.eventId}
                  type="button"
                  className={`traj-seg traj-seg--${seg.kind}${selectedEventId === seg.eventId ? ' selected' : ''}`}
                  style={{ left: `${seg.startPct}%`, width: `${seg.widthPct}%` }}
                  title={seg.eventId}
                  aria-label={`Timeline event ${seg.eventId}`}
                  onClick={() => {
                    const ev = model.events.find((e) => e.id === seg.eventId);
                    if (ev) select(ev);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="traj-feed" role="list" aria-label="Trajectory events">
        {visible.map((event) => (
          <button
            key={event.id}
            type="button"
            role="listitem"
            className={`traj-event${selectedEventId === event.id ? ' selected' : ''}`}
            onClick={() => select(event)}
          >
            <span className={`traj-badge traj-badge--${event.badge}`}>{BADGE_LABEL[event.badge]}</span>
            <span className="traj-event-main">
              <span className="traj-event-title">{event.title}</span>
              <span className="traj-event-sub">{event.subtitle}</span>
            </span>
            <span className="traj-event-meta">
              <span className={`traj-status traj-status--${event.status}`}>{event.status}</span>
              <span className="mono">{fmtDur(event.durationMs)}</span>
              <span className="muted">{fmtClock(event.ts)}</span>
            </span>
          </button>
        ))}
        {visible.length === 0 && (
          <div className="traj-empty muted">No events match this filter.</div>
        )}
      </div>
    </div>
  );
}
