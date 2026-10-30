// SPDX-License-Identifier: Apache-2.0
'use client';

// W13: Activity → Runs. Recorded agent runs from the span/trace store
// (GET /api/observability/*): filterable run list, a span waterfall with
// per-span payload detail, a step-through replay of the recorded trace,
// per-bot outcomes are on the Usage page; tags are edited inline here.
//
// The replay is a RECORDED-DATA replay: it steps through the spans that
// were stored when the run happened. It never re-executes the agent.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';
import {
  REPLAY_SPEEDS,
  fmtCents,
  fmtDuration,
  layoutWaterfall,
  replayDelayMs,
  stepReplayIndex,
  type ObsSpan,
} from './runs-waterfall';

interface RunTotals {
  spanCount: number;
  llmCostCents: number;
  toolCostCents: number;
  totalCostCents: number;
  errorCount: number;
  durationMs: number | null;
}

interface ObsRun {
  runId: string;
  sessionId: string;
  botId: string;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  outcome: 'success' | 'failed' | 'cancelled' | 'needs-input' | null;
  loopDetected: boolean;
  loopEvidence: Array<{ kind: string; key: string; count: number; spanIds: string[] }>;
  tags: string[];
  totals?: RunTotals;
}

interface RunDetail {
  run: ObsRun;
  spans: ObsSpan[];
  totals: RunTotals;
  findings: Array<{ signal: string; severity: string; title: string; detail: string; fix: string }>;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

const OUTCOME_CHIP: Record<string, string> = {
  success: 'green',
  failed: 'red',
  cancelled: 'gray',
  'needs-input': 'amber',
};

const KIND_COLOR: Record<string, string> = {
  session: 'var(--muted, #888)',
  turn: '#5eb3f0',
  llm: '#7c6cf0',
  tool: '#4cc2a8',
  bot: '#5eb3f0',
  goal: '#5eb3f0',
  routine: '#5eb3f0',
};

function prettyPayload(payload: unknown): string {
  if (payload === undefined) return '(no payload recorded)';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function SpanDetailPane({ span }: { span: ObsSpan }) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row gap" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong className="mono small">{span.name}</strong>
        <span className={`chip ${span.status === 'error' ? 'red' : span.status === 'ok' ? 'green' : 'gray'}`}>
          {span.status}
        </span>
        <span className="chip gray">{span.kind}</span>
        <span className="small muted">
          {new Date(span.startedAt).toLocaleTimeString()} · {fmtDuration(span.durationMs)}
          {span.costCents !== undefined ? ` · ${fmtCents(span.costCents)}` : ''}
        </span>
      </div>
      {span.error && (
        <div className="small" style={{ color: 'var(--red, #c00)', marginTop: 6 }}>
          {span.error}
        </div>
      )}
      <p className="small muted" style={{ marginBottom: 4 }}>
        Recorded payload (secrets redacted before storage):
      </p>
      <pre className="mono small" style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {prettyPayload(span.payload)}
      </pre>
    </div>
  );
}

function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState('');
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<RunDetail>(`/api/observability/runs/${encodeURIComponent(runId)}`);
      setDetail(data);
      setTags(data.run.tags);
      setReplayIndex(0);
      setPlaying(false);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const spans = useMemo(() => detail?.spans ?? [], [detail]);
  const layout = useMemo(() => layoutWaterfall(spans), [spans]);
  const currentSpan = spans[Math.min(replayIndex, Math.max(0, spans.length - 1))];

  // Replay driver: advance one frame per delay tick while playing.
  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setReplayIndex((idx) => {
        if (idx >= spans.length - 1) {
          setPlaying(false);
          return idx;
        }
        return idx + 1;
      });
    }, replayDelayMs(speed));
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, speed, spans.length]);

  const stepTo = (idx: number) => {
    setPlaying(false);
    setReplayIndex(stepReplayIndex(idx, 0, spans.length));
  };

  const addTag = async () => {
    const tag = tagInput.trim();
    if (!tag) return;
    try {
      const out = await apiJson<{ tags: string[] }>(
        `/api/observability/runs/${encodeURIComponent(runId)}/tags`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tag }),
        },
      );
      setTags(out.tags);
      setTagInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeTag = async (tag: string) => {
    try {
      const out = await apiJson<{ tags: string[] }>(
        `/api/observability/runs/${encodeURIComponent(runId)}/tags/${encodeURIComponent(tag)}`,
        { method: 'DELETE' },
      );
      setTags(out.tags);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error && !detail) {
    return (
      <div>
        <button type="button" className="btn btn-sm" onClick={onBack}>
          ← All runs
        </button>
        <div className="error" style={{ marginTop: 12 }}>{error}</div>
      </div>
    );
  }
  if (!detail) return <p className="muted">Loading run…</p>;

  const { run, totals, findings } = detail;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={onBack}>
          ← All runs
        </button>
        <h2 style={{ margin: 0 }}>
          Run <span className="mono">{run.runId.slice(0, 13)}…</span>
        </h2>
        {run.outcome ? (
          <span className={`chip ${OUTCOME_CHIP[run.outcome] ?? 'gray'}`}>{run.outcome}</span>
        ) : (
          <span className="chip blue">running</span>
        )}
        {run.loopDetected && <span className="chip amber">⚠ loop detected</span>}
      </div>
      <p className="muted small">
        Bot <span className="mono">{run.botId}</span> · session <span className="mono">{run.sessionId}</span> ·{' '}
        {new Date(run.startedAt).toLocaleString()} · {fmtDuration(totals.durationMs)} · LLM{' '}
        {fmtCents(totals.llmCostCents)} + tools {fmtCents(totals.toolCostCents)} = {fmtCents(totals.totalCostCents)}
      </p>
      {error && <div className="error">{error}</div>}

      {findings.map((f, i) => (
        <div key={i} className="card" style={{ borderColor: 'var(--amber, #d97706)' }}>
          <strong className="small">{f.title}</strong>
          <div className="small">{f.detail}</div>
          <div className="small">
            <strong>Fix:</strong> {f.fix}
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
        <span className="small muted">Tags:</span>
        {tags.map((t) => (
          <span key={t} className="chip gray">
            {t}{' '}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => void removeTag(t)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addTag();
          }}
          placeholder="add tag…"
          className="input"
          style={{ width: 140 }}
        />
        <button type="button" className="btn btn-sm" onClick={() => void addTag()} disabled={!tagInput.trim()}>
          Add tag
        </button>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong className="small">Recorded replay</strong>
          <span className="small muted">
            Plays back the stored trace frame by frame — it does not re-run the agent.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Step back"
            onClick={() => {
              setPlaying(false);
              setReplayIndex((i) => stepReplayIndex(i, -1, spans.length));
            }}
          >
            ⏮ Step
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (replayIndex >= spans.length - 1) setReplayIndex(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Step forward"
            onClick={() => {
              setPlaying(false);
              setReplayIndex((i) => stepReplayIndex(i, 1, spans.length));
            }}
          >
            Step ⏭
          </button>
          <label className="small muted">
            Speed{' '}
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              aria-label="Replay speed"
            >
              {REPLAY_SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <span className="small muted">
            Frame {spans.length === 0 ? 0 : replayIndex + 1} / {spans.length}
            {currentSpan ? ` — ${currentSpan.name}` : ''}
          </span>
        </div>

        <div style={{ marginTop: 12 }}>
          {layout.rows.map((row, i) => {
            const isCurrent = i === replayIndex;
            const s = row.span;
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                aria-label={`Span ${s.name}`}
                onClick={() => stepTo(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') stepTo(i);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '3px 6px',
                  cursor: 'pointer',
                  background: isCurrent ? 'var(--accent-soft, rgba(124,108,240,0.15))' : 'transparent',
                  borderRadius: 6,
                  outline: isCurrent ? '1px solid var(--accent, #7c6cf0)' : 'none',
                }}
              >
                <span
                  className="mono small"
                  style={{ width: 220, flexShrink: 0, paddingLeft: row.depth * 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {s.status === 'error' ? '✖ ' : ''}
                  {s.name}
                </span>
                <span style={{ position: 'relative', flex: 1, height: 14, background: 'var(--track, rgba(127,127,127,0.15))', borderRadius: 4 }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: `${row.leftPct}%`,
                      width: `${row.widthPct}%`,
                      top: 2,
                      height: 10,
                      borderRadius: 3,
                      background: s.status === 'error' ? 'var(--red, #dc2626)' : (KIND_COLOR[s.kind] ?? '#888'),
                      opacity: isCurrent ? 1 : 0.65,
                    }}
                  />
                </span>
                <span className="small muted" style={{ width: 90, textAlign: 'right', flexShrink: 0 }}>
                  {fmtDuration(s.durationMs)}
                  {s.costCents !== undefined ? ` · ${fmtCents(s.costCents)}` : ''}
                </span>
              </div>
            );
          })}
          {spans.length === 0 && <p className="muted small">No spans recorded for this run.</p>}
        </div>
      </div>

      {currentSpan && <SpanDetailPane span={currentSpan} />}
    </div>
  );
}

export function RunsPanel({ initialRunId }: { initialRunId?: string } = {}) {
  const [runs, setRuns] = useState<ObsRun[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [botFilter, setBotFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (botFilter.trim()) params.set('botId', botFilter.trim());
      if (outcomeFilter) params.set('outcome', outcomeFilter);
      if (tagFilter.trim()) params.set('tag', tagFilter.trim());
      const qs = params.toString();
      const data = await apiJson<{ runs: ObsRun[] }>(`/api/observability/runs${qs ? `?${qs}` : ''}`);
      setRuns(data.runs);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [botFilter, outcomeFilter, tagFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (selectedRunId) {
    return <RunDetailView runId={selectedRunId} onBack={() => setSelectedRunId(null)} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Runs</h2>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      <p className="muted small">
        Every recorded agent run as a span trace — LLM calls, tool calls, costs, outcomes, and loop
        detection. Click a run for its waterfall and recorded replay.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        <input
          className="input"
          placeholder="Filter by bot id…"
          aria-label="Filter by bot"
          value={botFilter}
          onChange={(e) => setBotFilter(e.target.value)}
          style={{ width: 180 }}
        />
        <select
          className="input"
          aria-label="Filter by outcome"
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value)}
        >
          <option value="">All outcomes</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
          <option value="needs-input">needs-input</option>
        </select>
        <input
          className="input"
          placeholder="Filter by tag…"
          aria-label="Filter by tag"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          style={{ width: 160 }}
        />
      </div>
      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading runs…</p>}
      {!loading && runs.length === 0 && !error && (
        <p className="muted">No recorded runs match these filters yet. Runs appear after a bot completes a turn.</p>
      )}
      <ul className="list" style={{ listStyle: 'none', padding: 0 }}>
        {runs.map((run) => (
          <li key={run.runId} className="card" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSelectedRunId(run.runId)}
              >
                <span className="mono">{run.runId.slice(0, 13)}…</span>
              </button>
              {run.outcome ? (
                <span className={`chip ${OUTCOME_CHIP[run.outcome] ?? 'gray'}`}>{run.outcome}</span>
              ) : (
                <span className="chip blue">running</span>
              )}
              {run.loopDetected && <span className="chip amber">⚠ loop</span>}
              <span className="small">
                bot <span className="mono">{run.botId}</span>
              </span>
              <span className="small muted">
                {new Date(run.startedAt).toLocaleString()} · {fmtDuration(run.totals?.durationMs)} ·{' '}
                {run.totals?.spanCount ?? 0} spans · {fmtCents(run.totals?.totalCostCents)}
              </span>
              {run.tags.map((t) => (
                <span key={t} className="chip gray">
                  {t}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
