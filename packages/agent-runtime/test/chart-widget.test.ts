// SPDX-License-Identifier: Apache-2.0
// W8c: chart widget kind — validation (canonical + split series/values
// forms), caps, and tool-result attachment extraction.

import { describe, expect, it } from 'vitest';
import {
  extractWidgetAttachment,
  validateWidgetPayload,
  type ChartWidgetPayload,
} from '../src/widgets.js';

describe('chart widget validation (W8c)', () => {
  it('accepts the canonical series form (bar)', () => {
    const v = validateWidgetPayload({
      kind: 'chart',
      type: 'bar',
      title: 'Revenue',
      labels: ['Jan', 'Feb'],
      series: [{ label: 'Sales', values: [10, 20] }],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      const p = v.payload as ChartWidgetPayload;
      expect(p.kind).toBe('chart');
      expect(p.chartType).toBe('bar');
      expect(p.labels).toEqual(['Jan', 'Feb']);
      expect(p.series).toEqual([{ label: 'Sales', values: [10, 20] }]);
    }
  });

  it('accepts stacked-bar and normalizes the split series/values form', () => {
    const v = validateWidgetPayload({
      kind: 'chart',
      type: 'stacked-bar',
      labels: ['Q1', 'Q2', 'Q3'],
      series: ['A', 'B'],
      values: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      const p = v.payload as ChartWidgetPayload;
      expect(p.chartType).toBe('stacked-bar');
      expect(p.series).toEqual([
        { label: 'A', values: [1, 2, 3] },
        { label: 'B', values: [4, 5, 6] },
      ]);
    }
  });

  it('rejects unknown chart types, ragged values, and non-finite numbers', () => {
    expect(validateWidgetPayload({ kind: 'chart', type: 'pie', labels: ['a'], series: [{ label: 's', values: [1] }] }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'chart', type: 'bar', labels: ['a', 'b'], series: [{ label: 's', values: [1] }] }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'chart', type: 'bar', labels: ['a'], series: [{ label: 's', values: [Number.NaN] }] }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'chart', type: 'bar', labels: ['a'], series: [{ label: 's', values: ['1'] }] }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'chart', type: 'bar', labels: [], series: [{ label: 's', values: [] }] }).ok).toBe(false);
  });

  it('enforces caps on labels and series', () => {
    const manyLabels = Array.from({ length: 51 }, (_, i) => `l${i}`);
    expect(
      validateWidgetPayload({ kind: 'chart', type: 'bar', labels: manyLabels, series: [{ label: 's', values: manyLabels.map(() => 1) }] }).ok,
    ).toBe(false);
    const manySeries = Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, values: [1] }));
    expect(validateWidgetPayload({ kind: 'chart', type: 'bar', labels: ['a'], series: manySeries }).ok).toBe(false);
  });

  it('is extracted from tool results like other display widgets', () => {
    const w = extractWidgetAttachment({
      summary: 'done',
      widget: { kind: 'chart', type: 'bar', labels: ['a'], series: [{ label: 's', values: [3] }] },
    });
    expect(w?.kind).toBe('chart');
    expect(extractWidgetAttachment({ widget: { kind: 'chart', type: 'pie', labels: ['a'], series: [] } })).toBeUndefined();
    expect(extractWidgetAttachment({ noWidget: true })).toBeUndefined();
  });
});
