// SPDX-License-Identifier: Apache-2.0
// Analysis card (CA-36): renders an AnalysisCardPayload (produced by
// apps/api analysis.ts — sandboxed code execution or a declarative
// aggregate over workspace data) as a first-class inline chat card.
// The table and chart halves are validated through the EXISTING
// widget schema and rendered by the EXISTING WidgetRenderer — this
// component only adds the composite frame: title, summary, stat
// chips, and the provenance footer.

import React from 'react';
import { WidgetRenderer } from './widgets';
import { validateWidget } from './schema';

export interface AnalysisCardData {
  kind: 'analysis';
  title: string;
  summary: string;
  table: {
    kind: 'table';
    title?: string;
    columns: string[];
    rows: unknown[][];
  };
  chart?: {
    kind: 'chart';
    title?: string;
    chartType: 'bar' | 'stacked-bar';
    labels: string[];
    series: Array<{ label: string; values: number[] }>;
  };
  stats: Array<{ label: string; value: string }>;
  provenance: {
    dataset: string;
    rowCount: number;
    execution: 'declarative' | 'sandboxed-code';
    sandboxed?: boolean;
    warning?: string;
  };
}

/** True when an unknown payload is shaped like an analysis card. */
export function isAnalysisCardData(v: unknown): v is AnalysisCardData {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  return (
    d.kind === 'analysis' &&
    typeof d.title === 'string' &&
    typeof d.summary === 'string' &&
    !!d.table && typeof d.table === 'object' &&
    Array.isArray(d.stats)
  );
}

export function AnalysisCard({ data }: { data: AnalysisCardData }): React.JSX.Element {
  const table = validateWidget(data.table);
  const chart = data.chart ? validateWidget(data.chart) : null;
  return (
    <div className="analysis-card" data-analysis-card="true">
      <div className="analysis-card-head">
        <div className="analysis-card-title">{data.title}</div>
        <div className="analysis-card-summary">{data.summary}</div>
      </div>
      {data.stats.length > 0 && (
        <div className="analysis-card-stats">
          {data.stats.map((s) => (
            <span key={s.label} className="analysis-card-stat">
              <span className="analysis-card-stat-label">{s.label}</span>{' '}
              <span className="analysis-card-stat-value">{s.value}</span>
            </span>
          ))}
        </div>
      )}
      {table.ok && (
        <div className="analysis-card-table">
          <WidgetRenderer widget={table.widget} />
        </div>
      )}
      {chart?.ok && (
        <div className="analysis-card-chart">
          <WidgetRenderer widget={chart.widget} />
        </div>
      )}
      <div className="analysis-card-provenance">
        {data.provenance.dataset} · {data.provenance.rowCount} row(s) ·{' '}
        {data.provenance.execution === 'sandboxed-code'
          ? `sandboxed code${data.provenance.sandboxed === false ? ' (host fallback — see warning)' : ''}`
          : 'declarative aggregate'}
        {data.provenance.warning ? ` · ${data.provenance.warning}` : ''}
      </div>
    </div>
  );
}
