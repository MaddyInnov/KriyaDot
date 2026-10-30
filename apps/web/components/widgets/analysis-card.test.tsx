// SPDX-License-Identifier: Apache-2.0
// CA-36 web contract: the AnalysisCard renders an analysis payload
// (table + chart + stats + provenance) through the existing widget
// renderer, and isAnalysisCardData gates the chat mount point.
// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AnalysisCard, isAnalysisCardData } from './analysis-card';
import type { AnalysisCardData } from './analysis-card';

const CARD: AnalysisCardData = {
  kind: 'analysis',
  title: 'Sales by region',
  summary: 'sum of amount by region over 4 row(s) of sales.',
  table: {
    kind: 'table',
    title: 'Sales by region',
    columns: ['region', 'sum(amount)'],
    rows: [['north', 40], ['south', 60]],
  },
  chart: {
    kind: 'chart',
    title: 'Sales by region',
    chartType: 'bar',
    labels: ['north', 'south'],
    series: [{ label: 'sum(amount)', values: [40, 60] }],
  },
  stats: [
    { label: 'Rows', value: '4' },
    { label: 'amount avg', value: '25' },
  ],
  provenance: { dataset: 'sales', rowCount: 4, execution: 'declarative' },
};

describe('AnalysisCard (CA-36)', () => {
  it('renders title, summary, stats, the table and the chart', () => {
    const { container } = render(<AnalysisCard data={CARD} />);
    expect(container.querySelector('[data-analysis-card="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Sales by region');
    expect(container.textContent).toContain('sum of amount by region');
    // Table half (existing TableView via WidgetRenderer).
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).toContain('north');
    expect(container.textContent).toContain('60');
    // Chart half: one SVG rect per label for a single-series bar chart.
    expect(container.querySelectorAll('svg rect').length).toBeGreaterThanOrEqual(2);
    // Stats + provenance.
    expect(container.textContent).toContain('amount avg');
    expect(container.textContent).toContain('sales · 4 row(s) · declarative aggregate');
  });

  it('renders a table-only card (no chart) without an SVG', () => {
    const { chart: _chart, ...rest } = CARD;
    const { container } = render(<AnalysisCard data={rest} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('isAnalysisCardData accepts the payload shape and rejects others', () => {
    expect(isAnalysisCardData(CARD)).toBe(true);
    expect(isAnalysisCardData({ kind: 'table', columns: [], rows: [] })).toBe(false);
    expect(isAnalysisCardData(null)).toBe(false);
    expect(isAnalysisCardData({ kind: 'analysis', title: 'x' })).toBe(false);
  });

  it('surfaces the host-fallback warning for unsandboxed code execution', () => {
    const codeCard: AnalysisCardData = {
      ...CARD,
      provenance: { dataset: 'sales', rowCount: 4, execution: 'sandboxed-code', sandboxed: false, warning: 'ran on host' },
    };
    const { container } = render(<AnalysisCard data={codeCard} />);
    expect(container.textContent).toContain('sandboxed code (host fallback');
    expect(container.textContent).toContain('ran on host');
  });
});
