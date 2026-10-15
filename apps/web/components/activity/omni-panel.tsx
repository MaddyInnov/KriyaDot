// SPDX-License-Identifier: Apache-2.0
'use client';

// Omni rolling summary: "Where am I right now?" — four temporal layers
// (Attention / Recent / Period / Milestone), user pins, and a time-travel
// version selector. Backed by GET /api/summary/omni; when the backend is not
// built yet the panel renders an empty state (never an error).

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorBox } from '../../app/modules/lib';
import { getOmniSummary } from '../../lib/kriyadot-api';
import type { BriefingItem, OmniSummary } from '../../lib/kriyadot-api';

function fmtTs(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function Layer({ title, items, icon }: { title: string; items: BriefingItem[]; icon: string }) {
  return (
    <div className="card omni-layer">
      <h4 className="mt0">
        <span aria-hidden="true">{icon} </span>
        {title} <span className="chip gray">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="muted small">Nothing recorded.</p>
      ) : (
        <ul className="brief-list">
          {items.map((it, i) => (
            <li key={it.id ?? `${title}-${i}`} className="brief-item">
              <div className="brief-item-title">{it.title}</div>
              {it.detail && <div className="brief-item-detail small muted">{it.detail}</div>}
              {it.ts ? <div className="brief-item-ts small muted">{fmtTs(it.ts)}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OmniPanel() {
  const [summary, setSummary] = useState<OmniSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [versionId, setVersionId] = useState('');

  const load = useCallback(async (v?: string) => {
    try {
      const s = await getOmniSummary(v || undefined);
      setMissing(s === null);
      setSummary(s);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pickVersion = (v: string) => {
    setVersionId(v);
    void load(v);
  };

  if (error) return <ErrorBox error={error} />;
  if (missing || summary === null) {
    return (
      <EmptyState text="No summary yet — the rolling summary service is not available. Your Attention / Recent / Period / Milestone view will appear here once it is." />
    );
  }

  const versions = summary.versions ?? [];

  return (
    <div>
      <div className="row-between">
        <h3 className="mt0">Where am I right now?</h3>
        {versions.length > 0 && (
          <label className="small muted row gap">
            Time-travel
            <select
              className="select"
              value={versionId}
              onChange={(e) => pickVersion(e.target.value)}
              aria-label="Summary version"
            >
              <option value="">Latest</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label ?? fmtTs(v.createdAt) ?? v.id}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="grid-2">
        <Layer title="Attention" icon="◎" items={summary.attention ?? []} />
        <Layer title="Recent" icon="◷" items={summary.recent ?? []} />
        <Layer title="This period" icon="▤" items={summary.period ?? []} />
        <Layer title="Milestones" icon="★" items={summary.milestones ?? []} />
      </div>

      <div className="card">
        <h4 className="mt0">
          <span aria-hidden="true">📌 </span>Pins{' '}
          <span className="chip gray">{(summary.pins ?? []).length}</span>
        </h4>
        {(summary.pins ?? []).length === 0 ? (
          <p className="muted small">No pins yet.</p>
        ) : (
          <ul className="brief-list">
            {(summary.pins ?? []).map((it, i) => (
              <li key={it.id ?? `pin-${i}`} className="brief-item brief-pin">
                <div className="brief-item-title">{it.title}</div>
                {it.detail && <div className="brief-item-detail small muted">{it.detail}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
