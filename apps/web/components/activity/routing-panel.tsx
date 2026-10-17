// SPDX-License-Identifier: Apache-2.0
'use client';

// Message-router observability (honest "Jev equivalent"): the router is
// deterministic heuristics, NOT a learned model. This panel exposes what it
// honestly offers — a scored decision log, accuracy measured ONLY over
// user-judged decisions (labeled as agreement), and tunable weights.

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface RoutingStats {
  totalDecisions: number;
  judged: number;
  correct: number;
  accuracy: number | null;
  avgConfidence: number;
  lowConfidence: number;
}

interface RoutingDecision {
  ts: number;
  textHash: string;
  scores: Array<{ botId: string; score: number; hits: string[] }>;
  winner: string;
  confidence: number;
  reason: string;
  weightsVersion: number;
}

interface RouterWeights {
  directHit: number;
  topicHit: number;
  phraseBonus: number;
  version: number;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

export function RoutingPanel() {
  const [stats, setStats] = useState<RoutingStats | null>(null);
  const [decisions, setDecisions] = useState<RoutingDecision[]>([]);
  const [weights, setWeights] = useState<RouterWeights | null>(null);
  const [draft, setDraft] = useState({ directHit: '', topicHit: '', phraseBonus: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, d, w] = await Promise.all([
        apiJson<{ ok: boolean; stats: RoutingStats }>('/api/routing/stats'),
        apiJson<{ ok: boolean; decisions: RoutingDecision[] }>('/api/routing/decisions?limit=20'),
        apiJson<{ ok: boolean; weights: RouterWeights }>('/api/routing/weights'),
      ]);
      setStats(s.stats);
      setDecisions(d.decisions);
      setWeights(w.weights);
      setDraft({
        directHit: String(w.weights.directHit),
        topicHit: String(w.weights.topicHit),
        phraseBonus: String(w.weights.phraseBonus),
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveWeights = async () => {
    try {
      const body: Record<string, number> = {};
      for (const k of ['directHit', 'topicHit', 'phraseBonus'] as const) {
        const v = Number(draft[k]);
        if (!Number.isFinite(v)) throw new Error(`${k} must be a number`);
        body[k] = v;
      }
      const res = await apiJson<{ ok: boolean; weights: RouterWeights }>('/api/routing/weights', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setWeights(res.weights);
      setNotice(`Weights saved (version ${res.weights.version}).`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Message routing</h2>
      <p className="muted small">
        The inbound-message router is <strong>deterministic heuristics</strong> — keyword/topic
        scoring, no learned model. Every decision is logged with its features (message text is
        never stored, only a hash). Accuracy is measured <em>only</em> over decisions you judged
        via corrections — it is agreement with you, not ML accuracy.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <p className="small muted">{notice}</p>}

      {stats && (
        <div className="card">
          <h3>Stats</h3>
          <ul className="list small">
            <li>Decisions logged: <strong>{stats.totalDecisions}</strong></li>
            <li>Judged by you: <strong>{stats.judged}</strong></li>
            <li>
              Agreement: <strong>{stats.accuracy === null ? '—' : `${(stats.accuracy * 100).toFixed(0)}%`}</strong>
              {stats.accuracy === null && <span className="muted"> (judge a decision via message corrections to measure)</span>}
            </li>
            <li>Average confidence: <strong>{stats.avgConfidence.toFixed(2)}</strong></li>
            <li>Low-confidence (&lt;0.5): <strong>{stats.lowConfidence}</strong></li>
          </ul>
        </div>
      )}

      {weights && (
        <div className="card">
          <h3>Tunable weights (v{weights.version})</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {(['directHit', 'topicHit', 'phraseBonus'] as const).map((k) => (
              <label key={k} className="small">
                {k}
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  value={draft[k]}
                  onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                  style={{ width: 90, marginLeft: 6 }}
                />
              </label>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveWeights()}>
              Save weights
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Recent decisions</h3>
        {decisions.length === 0 && <p className="muted small">No routing decisions logged yet.</p>}
        <ul className="list small">
          {decisions.map((d, i) => (
            <li key={`${d.ts}-${i}`}>
              <span className="muted">{new Date(d.ts).toLocaleString()}</span> → <strong>{d.winner}</strong>{' '}
              (confidence {d.confidence.toFixed(2)}, weights v{d.weightsVersion})
              <div className="muted">
                {d.scores.slice(0, 4).map((s) => `${s.botId}:${s.score.toFixed(1)}`).join(' · ')}
                {d.reason ? ` — ${d.reason}` : ''}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
