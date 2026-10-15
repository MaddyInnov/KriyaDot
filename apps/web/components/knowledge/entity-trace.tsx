// SPDX-License-Identifier: Apache-2.0
'use client';

// Entity tracing (lite) UI (feature #14): cross-source entity search over the
// knowledge base and tiered memory, backed by GET /api/entities/trace.
// Mounted at the bottom of the Knowledge page.

import { useState } from 'react';
import { traceEntityApi, type EntityTraceResult } from '../../lib/kriyadot-api';

export function EntityTrace() {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<EntityTraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trace = async () => {
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await traceEntityApi({ q: query, topK: 5 });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card mt">
      <h2 className="card-title">🔍 Entity trace</h2>
      <p className="small muted">
        Cross-source search: finds an entity across the knowledge base and agent memory,
        with a summary of what the platform knows about it.
      </p>
      <div className="row gap mt">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void trace();
          }}
          placeholder="Trace an entity — e.g. PgBouncer"
          aria-label="Entity to trace"
        />
        <button className="btn btn-primary btn-sm" onClick={() => void trace()} disabled={loading || !q.trim()}>
          {loading ? 'Tracing…' : 'Trace'}
        </button>
      </div>

      {error && <div className="error-box mt">{error}</div>}

      {result && (
        <div className="mt">
          {result.summary && (
            <p>
              <strong>{result.entity}</strong>{' '}
              <span className="pill">{result.summaryKind ?? 'summary'}</span>
              <br />
              <span className="muted">{result.summary}</span>
            </p>
          )}
          {result.matches.length === 0 ? (
            <p className="small muted">No matches in the knowledge base or memory.</p>
          ) : (
            <ul className="entity-matches">
              {result.matches.map((m, i) => (
                <li key={`${m.source}-${m.chunkId ?? m.atomId ?? i}`} className="entity-match">
                  <span className="pill">{m.source === 'knowledge-base' ? 'knowledge' : 'memory'}</span>{' '}
                  <strong>{m.documentTitle ?? m.atomId ?? '(untitled)'}</strong>
                  {(m.text ?? m.fact) && <p className="small muted">{m.text ?? m.fact}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
