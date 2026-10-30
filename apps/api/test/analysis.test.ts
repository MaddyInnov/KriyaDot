// SPDX-License-Identifier: Apache-2.0
// CA-36: analysis outputs as inline chat cards — payload production
// (declarative aggregates + sandboxed-code mode over a MOCK executor),
// the run_analysis tool contract, widget-attachment validity through
// the existing widget validator, and the HTTP route. Zero paid APIs;
// no real code execution in tests (executor is injected).

import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { validateWidgetPayload } from '@mvp/agent-runtime';
import {
  analysisWidgetAttachments,
  createAnalysisRouter,
  createAnalysisTool,
  runAnalysis,
  runDeclarativeOperation,
} from '../src/analysis.js';
import type { AnalysisDataset, AnalysisExecutor } from '../src/analysis.js';

const DATASET: AnalysisDataset = {
  name: 'sales',
  columns: ['region', 'amount'],
  rows: [
    { region: 'north', amount: 10 },
    { region: 'north', amount: 30 },
    { region: 'south', amount: 20 },
    { region: 'south', amount: 40 },
  ],
};

describe('runDeclarativeOperation', () => {
  it('groups and aggregates deterministically', () => {
    const out = runDeclarativeOperation(DATASET, { kind: 'aggregate', fn: 'sum', column: 'amount', groupBy: 'region' });
    expect(out.columns).toEqual(['region', 'sum(amount)']);
    expect(out.rows).toEqual([
      { region: 'north', 'sum(amount)': 40 },
      { region: 'south', 'sum(amount)': 60 },
    ]);
  });

  it('count needs no column; bad columns are rejected', () => {
    const out = runDeclarativeOperation(DATASET, { kind: 'aggregate', fn: 'count', groupBy: 'region' });
    expect(out.rows).toEqual([{ region: 'north', count: 2 }, { region: 'south', count: 2 }]);
    expect(() => runDeclarativeOperation(DATASET, { kind: 'aggregate', fn: 'sum', column: 'nope' })).toThrow(/operation\.column/);
  });
});

describe('runAnalysis — declarative card payload', () => {
  it('produces a typed analysis card: table + chart + stats + provenance', async () => {
    const card = await runAnalysis({
      title: 'Sales by region',
      dataset: DATASET,
      operation: { kind: 'aggregate', fn: 'sum', column: 'amount', groupBy: 'region' },
    });
    expect(card.kind).toBe('analysis');
    expect(card.title).toBe('Sales by region');
    expect(card.summary).toContain('sum of amount by region');
    expect(card.table).toMatchObject({ kind: 'table', columns: ['region', 'sum(amount)'], rows: [['north', 40], ['south', 60]] });
    expect(card.chart).toMatchObject({
      kind: 'chart', chartType: 'bar', labels: ['north', 'south'],
      series: [{ label: 'sum(amount)', values: [40, 60] }],
    });
    expect(card.stats).toContainEqual({ label: 'Rows', value: '4' });
    expect(card.stats).toContainEqual({ label: 'amount avg', value: '25' });
    expect(card.provenance).toEqual({ dataset: 'sales', rowCount: 4, execution: 'declarative' });

    // The widget attachments pass the EXISTING widget validator —
    // they are exactly what the chat surface renders inline today.
    for (const w of analysisWidgetAttachments(card)) {
      expect(validateWidgetPayload(w).ok).toBe(true);
    }
  });

  it('ungrouped aggregates produce a table without a chart', async () => {
    const card = await runAnalysis({ dataset: DATASET, operation: { kind: 'aggregate', fn: 'avg', column: 'amount' } });
    expect(card.table.rows).toEqual([[25]]);
    expect(card.chart).toBeUndefined();
  });

  it('rejects missing operation AND code, and oversize datasets', async () => {
    await expect(runAnalysis({ dataset: DATASET })).rejects.toThrow(/operation/);
    await expect(runAnalysis({
      dataset: { name: 'x', columns: ['a'], rows: Array.from({ length: 5001 }, () => ({ a: 1 })) },
      operation: { kind: 'aggregate', fn: 'count' },
    })).rejects.toThrow(/capped/);
  });
});

describe('runAnalysis — sandboxed code mode (mock executor)', () => {
  it('runs code through the injected executor and cards the result with provenance', async () => {
    const seen: Array<{ code: string; rowCount: number }> = [];
    const mockExecutor: AnalysisExecutor = async ({ code, dataset }) => {
      seen.push({ code, rowCount: dataset.rows.length });
      return {
        rows: dataset.rows.filter((r) => (r.amount as number) > 15).map((r) => ({ region: r.region, amount: r.amount })),
        sandboxed: true,
      };
    };
    const card = await runAnalysis(
      {
        title: 'Big sales',
        dataset: DATASET,
        code: 'return rows.filter(r => r.amount > 15)',
        chartLabelColumn: 'region',
        chartValueColumn: 'amount',
      },
      { executor: mockExecutor },
    );
    expect(seen).toEqual([{ code: 'return rows.filter(r => r.amount > 15)', rowCount: 4 }]);
    expect(card.provenance.execution).toBe('sandboxed-code');
    expect(card.provenance.sandboxed).toBe(true);
    expect(card.table.rows).toEqual([['north', 30], ['south', 20], ['south', 40]]);
    expect(card.chart?.labels).toEqual(['north', 'south', 'south']);
    expect(card.stats).toContainEqual({ label: 'Result rows', value: '3' });
  });
});

describe('run_analysis tool + HTTP route', () => {
  it('the tool handler returns { ok, analysis, widgets }', async () => {
    const tool = createAnalysisTool();
    expect(tool.name).toBe('run_analysis');
    expect(tool.mutating).toBe(false);
    const out = (await tool.handler({
      dataset: DATASET,
      operation: { kind: 'aggregate', fn: 'max', column: 'amount', groupBy: 'region' },
    })) as { ok: boolean; analysis: { table: { rows: unknown[][] } }; widgets: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.analysis.table.rows).toEqual([['north', 30], ['south', 40]]);
    expect(out.widgets).toHaveLength(2); // table + chart
  });

  it('POST /analysis/run returns the card; bad input is a 400', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createAnalysisRouter());
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/analysis/run`;
    try {
      const ok = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: DATASET, operation: { kind: 'aggregate', fn: 'sum', column: 'amount', groupBy: 'region' } }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { analysis: { kind: string }; widgets: unknown[] };
      expect(body.analysis.kind).toBe('analysis');
      expect(body.widgets).toHaveLength(2);

      const bad = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: DATASET }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
