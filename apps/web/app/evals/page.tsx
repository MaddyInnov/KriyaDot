// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  deleteEvalSuite,
  getBots,
  getEvalRun,
  listEvalRuns,
  listEvalSuites,
  startEvalRun,
  streamEvalRun,
  type BotConfig,
  type EvalCaseResultDto,
  type EvalRunDto,
  type EvalStreamEvent,
  type EvalSuiteDto,
} from '../../lib/api';

interface LiveCase {
  status: 'running' | 'done';
  result?: EvalCaseResultDto;
}

function scoreColor(score: number | null): string {
  if (score === null || score === undefined) return 'muted';
  if (score >= 0.8) return 'eval-good';
  if (score >= 0.5) return 'eval-warn';
  return 'eval-bad';
}

function formatScore(score: number | null): string {
  if (score === null || score === undefined) return '—';
  return `${Math.round(score * 100)}%`;
}

export default function EvalsPage() {
  const [suites, setSuites] = useState<EvalSuiteDto[] | null>(null);
  const [bots, setBots] = useState<BotConfig[] | null>(null);
  const [runs, setRuns] = useState<EvalRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runBot, setRunBot] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState('');
  const [starting, setStarting] = useState<string | null>(null);
  // Live run state
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [liveSuite, setLiveSuite] = useState<EvalSuiteDto | null>(null);
  const [liveCases, setLiveCases] = useState<Record<string, LiveCase>>({});
  const [liveStatus, setLiveStatus] = useState<string>('');
  const [liveError, setLiveError] = useState<string | null>(null);
  // Detail view
  const [detail, setDetail] = useState<EvalRunDto | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Trend
  const [trendSuite, setTrendSuite] = useState<string>('');
  const unsubRef = useRef<(() => void) | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [s, r] = await Promise.all([listEvalSuites(), listEvalRuns(50)]);
      setSuites(s.suites);
      setRuns(r.runs);
      if (!trendSuite && s.suites.length > 0) setTrendSuite(s.suites[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    getBots()
      .then((b) => {
        if (!cancelled) setBots(b);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    void refresh();
    return () => {
      cancelled = true;
      unsubRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyEvent = (e: EvalStreamEvent): void => {
    switch (e.type) {
      case 'run_started':
        setLiveStatus(`Running ${e.caseCount} cases…`);
        break;
      case 'case_started':
        setLiveCases((prev) => ({ ...prev, [e.caseId]: { status: 'running' } }));
        break;
      case 'case_done':
        setLiveCases((prev) => ({ ...prev, [e.result.caseId]: { status: 'done', result: e.result } }));
        break;
      case 'done': {
        const report = e.report as {
          status: string;
          score: number;
          passed: number;
          failed: number;
          costUsd?: number;
          error?: string;
        };
        setLiveStatus(
          `Done: ${report.passed} passed, ${report.failed} failed, score ${formatScore(report.score)}` +
            (report.costUsd !== undefined ? `, $${report.costUsd.toFixed(4)}` : '') +
            (report.status === 'aborted_budget' ? ' (budget exceeded — remaining cases skipped)' : ''),
        );
        void refresh();
        break;
      }
      case 'error':
        setLiveError(e.message);
        setLiveStatus('');
        break;
      case 'snapshot':
        break;
    }
  };

  const startRun = async (suite: EvalSuiteDto): Promise<void> => {
    const botId = runBot[suite.id];
    if (!botId) {
      setError('Pick a bot to run the eval against.');
      return;
    }
    setError(null);
    setLiveError(null);
    setStarting(suite.id);
    setLiveSuite(suite);
    setLiveCases({});
    try {
      const maxBudgetUsd = budget.trim() ? parseFloat(budget) : undefined;
      const { runId } = await startEvalRun({
        suiteId: suite.id,
        botId,
        maxBudgetUsd: maxBudgetUsd !== undefined && Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : undefined,
      });
      setLiveRunId(runId);
      setLiveStatus('Starting…');
      unsubRef.current?.();
      unsubRef.current = streamEvalRun(runId, applyEvent, (err) => setLiveError(err.message));
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  };

  const openDetail = async (runId: string): Promise<void> => {
    setLoadingDetail(true);
    try {
      const r = await getEvalRun(runId);
      setDetail(r.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  };

  const removeSuite = async (suite: EvalSuiteDto): Promise<void> => {
    if (!window.confirm(`Delete eval suite "${suite.name}"? This removes ${suite.id}.json.`)) return;
    try {
      await deleteEvalSuite(suite.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const trendRuns = (runs ?? [])
    .filter((r) => r.suiteId === trendSuite && r.score !== null)
    .slice(0, 12)
    .reverse();

  return (
    <div className="eval-page">
      <Link href="/bots" className="eval-back">
        ← Back to bots
      </Link>
      <h1>🧪 Eval harnesses</h1>
      <p className="muted small">
        Rubric-scored test suites that run a bot in isolated sessions. Built-in suites live in{' '}
        <span className="mono">&lt;dataDir&gt;/evals/*.json</span> — edit them freely; files win.
      </p>
      {error && <div className="eval-error">Error: {error}</div>}

      <h2>Suites</h2>
      {suites === null && <div className="muted">Loading…</div>}
      {suites?.map((suite) => (
        <div key={suite.id} className="eval-suite">
          <div className="eval-suite-head">
            <div>
              <strong>{suite.name}</strong>{' '}
              <span className="mono small muted">{suite.id}</span>
              <div className="muted small">
                {suite.description} · {suite.cases.length} case{suite.cases.length === 1 ? '' : 's'}
              </div>
            </div>
            <button
              className="eval-delete"
              title="Delete suite file"
              onClick={() => void removeSuite(suite)}
            >
              🗑
            </button>
          </div>
          <details className="small">
            <summary className="muted">Cases</summary>
            <ul className="eval-case-list">
              {suite.cases.map((c) => (
                <li key={c.id}>
                  <span className="mono">{c.id}</span> — {c.name}{' '}
                  <span className="muted">({c.rubrics.map((r) => r.type).join(', ')})</span>
                </li>
              ))}
            </ul>
          </details>
          <div className="eval-run-row">
            <select
              value={runBot[suite.id] ?? ''}
              onChange={(e) => setRunBot((prev) => ({ ...prev, [suite.id]: e.target.value }))}
              aria-label="Bot to evaluate"
            >
              <option value="">Select bot…</option>
              {bots?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <input
              className="eval-budget"
              placeholder="Budget $ (optional)"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              aria-label="Max budget USD"
            />
            <button disabled={starting === suite.id} onClick={() => void startRun(suite)}>
              {starting === suite.id ? 'Starting…' : '▶ Run'}
            </button>
          </div>
        </div>
      ))}

      {liveRunId && liveSuite && (
        <div className="eval-live">
          <h2>
            Live run <span className="mono small muted">{liveRunId}</span>
          </h2>
          {liveStatus && <div className="muted">{liveStatus}</div>}
          {liveError && <div className="eval-error">Error: {liveError}</div>}
          <ul className="eval-live-cases">
            {liveSuite.cases.map((c) => {
              const lc = liveCases[c.id];
              return (
                <li key={c.id} className={lc?.result && !lc.result.passed ? 'eval-case-fail' : ''}>
                  <span>{lc ? (lc.status === 'running' ? '⏳' : lc.result?.passed ? '✅' : '❌') : '◻️'}</span>{' '}
                  {c.name}
                  {lc?.result && (
                    <span className={`small ${scoreColor(lc.result.score)}`}>
                      {' '}
                      {formatScore(lc.result.score)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <h2>Score trends</h2>
      <div className="eval-trend-row">
        <select value={trendSuite} onChange={(e) => setTrendSuite(e.target.value)} aria-label="Trend suite">
          {suites?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {trendRuns.length > 0 ? (
        <div className="eval-trend">
          {trendRuns.map((r) => (
            <div key={r.runId} className="eval-trend-bar" title={`${r.botName} · ${new Date(r.createdAt).toLocaleString()} · ${formatScore(r.score)}`}>
              <div
                className={`eval-trend-fill ${scoreColor(r.score)}`}
                style={{ height: `${Math.round((r.score ?? 0) * 100)}%` }}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="muted small">No completed runs for this suite yet.</div>
      )}

      <h2>Run history</h2>
      {runs === null && <div className="muted">Loading…</div>}
      {runs?.length === 0 && <div className="muted">No eval runs yet.</div>}
      {runs?.map((r) => (
        <details key={r.runId} className="eval-history-item">
          <summary onClick={() => void openDetail(r.runId)}>
            <span className={`eval-score ${scoreColor(r.score)}`}>{formatScore(r.score)}</span>{' '}
            <strong>{r.suiteName}</strong> <span className="muted small">on {r.botName}</span>{' '}
            <span className="mono small muted">{new Date(r.createdAt).toLocaleString()}</span>{' '}
            <span className="small muted">{r.status}</span>
          </summary>
          {loadingDetail && detail?.runId !== r.runId && <div className="muted small">Loading…</div>}
          {detail?.runId === r.runId && (
            <div className="eval-report">
              <div className="small muted">
                {detail.passed} passed · {detail.failed} failed
                {detail.costUsd !== null && detail.costUsd !== undefined && ` · $${detail.costUsd.toFixed(4)}`}
                {detail.error && <div className="eval-error">{detail.error}</div>}
              </div>
              {detail.caseResults?.map((cr) => (
                <details key={cr.caseId} className="eval-case">
                  <summary>
                    {cr.passed ? '✅' : '❌'} {cr.name}{' '}
                    <span className={`small ${scoreColor(cr.score)}`}>{formatScore(cr.score)}</span>
                    <span className="muted small"> · {cr.durationMs}ms</span>
                    {cr.toolsUsed.length > 0 && (
                      <span className="muted small"> · tools: {cr.toolsUsed.join(', ')}</span>
                    )}
                  </summary>
                  <ul className="small">
                    {cr.rubricResults.map((rr, i) => (
                      <li key={i}>
                        <span className="mono">{rr.rubric.type}</span>: {Math.round(rr.score * 100)}% —{' '}
                        {rr.detail}
                      </li>
                    ))}
                  </ul>
                  {cr.error && <div className="eval-error small">{cr.error}</div>}
                  {cr.response && (
                    <details className="small">
                      <summary className="muted">Response</summary>
                      <pre className="eval-response">{cr.response.slice(0, 2000)}</pre>
                    </details>
                  )}
                </details>
              ))}
            </div>
          )}
        </details>
      ))}
    </div>
  );
}
