// SPDX-License-Identifier: Apache-2.0
'use client';

// Step inspector (2026-10-31 minimal-UI redesign): right-pane detail for
// one trajectory event, modelled by lib/trajectory.ts buildInspector().
// Tabs: Summary / Payload / Result / Schema / Timing. Payloads were
// redacted + size-capped server-side before storage, so what renders
// here is exactly what was recorded — never a raw prompt.

import { useEffect, useState } from 'react';
import {
  buildInspector,
  type TrajEvent,
  type TrajRun,
  type TrajSpan,
} from '../../lib/trajectory';

type InspectorTab = 'summary' | 'payload' | 'result' | 'schema' | 'timing';

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'payload', label: 'Payload' },
  { id: 'result', label: 'Result' },
  { id: 'schema', label: 'Schema' },
  { id: 'timing', label: 'Timing' },
];

function RowTable({ rows, emptyText }: { rows: Array<{ label: string; value: string }>; emptyText: string }) {
  if (rows.length === 0) return <div className="small muted">{emptyText}</div>;
  return (
    <table className="insp-rows">
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td className="mono">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StepInspector({
  event,
  span,
  run,
  sessionStart,
  onClose,
}: {
  event: TrajEvent;
  span: TrajSpan | null;
  run: TrajRun | null;
  sessionStart: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('summary');
  useEffect(() => {
    setTab('summary');
  }, [event.id]);

  const model = buildInspector(event, span, run, sessionStart);

  return (
    <aside className="step-inspector glass" aria-label="Step inspector">
      <div className="insp-head">
        <div className="insp-title">
          <span className={`traj-badge traj-badge--${event.badge}`}>{event.badge.toUpperCase()}</span>
          <strong className="insp-name">{event.title}</strong>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close step inspector" title="Close">
          ✕
        </button>
      </div>
      <div className="insp-tabs" role="tablist" aria-label="Inspector sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`insp-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="insp-body" role="tabpanel">
        {tab === 'summary' && <RowTable rows={model.summary} emptyText="No summary recorded." />}
        {tab === 'payload' && <pre className="mono small insp-pre">{model.payload}</pre>}
        {tab === 'result' && <pre className="mono small insp-pre">{model.result}</pre>}
        {tab === 'schema' && (
          <RowTable rows={model.schema} emptyText="No object payload — nothing to map." />
        )}
        {tab === 'timing' && <RowTable rows={model.timing} emptyText="No timing recorded." />}
      </div>
      <p className="small muted insp-foot">Recorded payload — secrets were redacted before storage.</p>
    </aside>
  );
}
