// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  WIDGET_KINDS,
  cellText,
  formatBytes,
  validateWidget,
} from './schema';
import { WIDGET_REGISTRY, registeredWidgetKinds } from './widgets';

describe('validateWidget', () => {
  it('rejects non-objects and unknown kinds', () => {
    for (const bad of [null, 42, 'table', [], { kind: 'carousel' }, {}]) {
      const r = validateWidget(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('validates a table and normalizes object rows to column order', () => {
    const r = validateWidget({
      kind: 'table',
      title: 'Plans',
      columns: ['plan', 'price'],
      rows: [
        { plan: 'Free', price: 0 },
        ['Pro', 20],
      ],
      extra: 'stripped',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget.kind).toBe('table');
    expect(r.widget.title).toBe('Plans');
    if (r.widget.kind !== 'table') return;
    expect(r.widget.rows).toEqual([
      ['Free', 0],
      ['Pro', 20],
    ]);
    expect('extra' in r.widget).toBe(false);
  });

  it('rejects tables with empty columns or bad rows', () => {
    expect(validateWidget({ kind: 'table', columns: [], rows: [] }).ok).toBe(false);
    expect(validateWidget({ kind: 'table', columns: ['a'] }).ok).toBe(false);
    expect(validateWidget({ kind: 'table', columns: ['a'], rows: [42] }).ok).toBe(false);
  });

  it('caps table size', () => {
    const cols = Array.from({ length: 60 }, (_, i) => `c${i}`);
    expect(validateWidget({ kind: 'table', columns: cols, rows: [] }).ok).toBe(false);
    const rows = Array.from({ length: 600 }, () => ['x']);
    expect(validateWidget({ kind: 'table', columns: ['a'], rows }).ok).toBe(false);
  });

  it('validates bar and line charts, requiring one value per label', () => {
    const good = {
      kind: 'chart',
      chart: 'bar',
      labels: ['Jan', 'Feb'],
      datasets: [{ label: 'MRR', values: [10, 20] }],
    };
    expect(validateWidget(good).ok).toBe(true);
    expect(validateWidget({ ...good, chart: 'line' }).ok).toBe(true);
    expect(
      validateWidget({ ...good, datasets: [{ label: 'MRR', values: [10] }] }).ok,
    ).toBe(false);
    expect(
      validateWidget({ ...good, datasets: [{ label: 'MRR', values: [10, NaN] }] }).ok,
    ).toBe(false);
    expect(validateWidget({ ...good, chart: 'pie' }).ok).toBe(false);
    expect(validateWidget({ ...good, labels: [] }).ok).toBe(false);
  });

  it('validates action buttons with style and endpoint defaults', () => {
    const r = validateWidget({
      kind: 'actions',
      buttons: [
        { id: 'run', label: 'Run it', style: 'primary', endpoint: '/api/x', payload: { a: 1 } },
        { id: 'skip', label: 'Skip' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'actions') return;
    expect(r.widget.buttons[0]).toMatchObject({
      id: 'run',
      label: 'Run it',
      style: 'primary',
      endpoint: '/api/x',
      payload: { a: 1 },
    });
    expect(r.widget.buttons[1].style).toBe('default');
    expect(r.widget.buttons[1].endpoint).toBeUndefined();
    expect(validateWidget({ kind: 'actions', buttons: [] }).ok).toBe(false);
    expect(validateWidget({ kind: 'actions', buttons: [{ id: 'x' }] }).ok).toBe(false);
  });

  it('validates map widgets with query or coordinates', () => {
    expect(validateWidget({ kind: 'map', query: 'Connaught Place, New Delhi' }).ok).toBe(true);
    const r = validateWidget({ kind: 'map', lat: 28.63, lng: 77.21, label: 'CP' });
    expect(r.ok).toBe(true);
    expect(validateWidget({ kind: 'map' }).ok).toBe(false);
    expect(validateWidget({ kind: 'map', lat: 999 }).ok).toBe(false);
    expect(validateWidget({ kind: 'map', query: 'x', lng: 200 }).ok).toBe(false);
  });

  it('validates file widgets', () => {
    const r = validateWidget({ kind: 'file', name: 'report.pdf', size: 1048576, mime: 'application/pdf' });
    expect(r.ok).toBe(true);
    expect(validateWidget({ kind: 'file' }).ok).toBe(false);
    expect(validateWidget({ kind: 'file', name: 'x', size: -1 }).ok).toBe(false);
  });

  it('strips unknown fields instead of passing them through', () => {
    const r = validateWidget({
      kind: 'file',
      name: 'a.txt',
      onclick: 'alert(1)',
      title: 'ok',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('onclick' in r.widget).toBe(false);
      expect(r.widget.title).toBe('ok');
    }
  });
});

describe('interactive widgets (buttons/select/input/confirm/progress/image-view)', () => {
  const opts = [
    { id: 'a', label: 'Alpha', description: 'first option' },
    { id: 'b', label: 'Beta' },
  ];

  it('validates a buttons widget and strips extras', () => {
    const r = validateWidget({
      kind: 'buttons',
      title: 'Pick one',
      question: 'Which plan?',
      options: opts,
      multiSelect: true,
      allowFreeText: true,
      onclick: 'alert(1)',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'buttons') return;
    expect(r.widget.question).toBe('Which plan?');
    expect(r.widget.multiSelect).toBe(true);
    expect(r.widget.allowFreeText).toBe(true);
    expect(r.widget.options).toEqual(opts);
    expect('onclick' in r.widget).toBe(false);
  });

  it('rejects buttons with empty/missing/too many options', () => {
    expect(validateWidget({ kind: 'buttons', options: [] }).ok).toBe(false);
    expect(validateWidget({ kind: 'buttons' }).ok).toBe(false);
    expect(validateWidget({ kind: 'buttons', options: [{ id: 'x' }] }).ok).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    expect(validateWidget({ kind: 'buttons', options: many }).ok).toBe(false);
  });

  it('caps buttons option id/label/description/question lengths', () => {
    const long = 'x'.repeat(300);
    const r = validateWidget({
      kind: 'buttons',
      question: 'q'.repeat(600),
      options: [{ id: long, label: long, description: 'd'.repeat(600) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'buttons') return;
    expect(r.widget.question!.length).toBe(500);
    expect(r.widget.options[0].id.length).toBe(200);
    expect(r.widget.options[0].label.length).toBe(200);
    expect(r.widget.options[0].description!.length).toBe(500);
  });

  it('validates a select widget', () => {
    const r = validateWidget({ kind: 'select', label: 'Region', options: opts, multiSelect: true });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'select') return;
    expect(r.widget.label).toBe('Region');
    expect(r.widget.multiSelect).toBe(true);
    expect(r.widget.options.length).toBe(2);
    expect(validateWidget({ kind: 'select', options: [] }).ok).toBe(false);
    expect(validateWidget({ kind: 'select' }).ok).toBe(false);
  });

  it('validates an input widget with defaults and multiline', () => {
    const r = validateWidget({
      kind: 'input',
      title: 'Name',
      label: 'Your name',
      placeholder: 'Ada Lovelace',
      default: 'Ada',
      multiline: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'input') return;
    expect(r.widget.label).toBe('Your name');
    expect(r.widget.placeholder).toBe('Ada Lovelace');
    expect(r.widget.default).toBe('Ada');
    expect(r.widget.multiline).toBe(true);
    // bare input is valid too
    expect(validateWidget({ kind: 'input' }).ok).toBe(true);
  });

  it('validates a confirm widget, requiring a question', () => {
    const r = validateWidget({
      kind: 'confirm',
      question: 'Delete the database?',
      confirmLabel: 'Yes, delete',
      cancelLabel: 'Keep it',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'confirm') return;
    expect(r.widget.question).toBe('Delete the database?');
    expect(r.widget.confirmLabel).toBe('Yes, delete');
    expect(validateWidget({ kind: 'confirm' }).ok).toBe(false);
    expect(validateWidget({ kind: 'confirm', question: '   ' }).ok).toBe(false);
  });

  it('validates a progress widget and clamps percent to 0-100', () => {
    const r = validateWidget({ kind: 'progress', title: 'Deploy', label: 'Uploading', percent: 42 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'progress') return;
    expect(r.widget.percent).toBe(42);
    const hi = validateWidget({ kind: 'progress', percent: 150 });
    expect(hi.ok).toBe(true);
    if (hi.ok && hi.widget.kind === 'progress') expect(hi.widget.percent).toBe(100);
    const lo = validateWidget({ kind: 'progress', percent: -5 });
    expect(lo.ok).toBe(true);
    if (lo.ok && lo.widget.kind === 'progress') expect(lo.widget.percent).toBe(0);
    expect(validateWidget({ kind: 'progress', indeterminate: true }).ok).toBe(true);
    expect(validateWidget({ kind: 'progress', percent: NaN }).ok).toBe(false);
    expect(validateWidget({ kind: 'progress', percent: 'half' }).ok).toBe(false);
  });

  it('validates an image-view widget, requiring url or dataUrl', () => {
    const r = validateWidget({
      kind: 'image-view',
      url: 'https://example.com/chart.png',
      caption: 'Weekly MRR',
      alt: 'Bar chart of weekly MRR',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'image-view') return;
    expect(r.widget.url).toBe('https://example.com/chart.png');
    expect(r.widget.caption).toBe('Weekly MRR');
    expect(validateWidget({ kind: 'image-view', dataUrl: 'data:image/png;base64,AAA' }).ok).toBe(true);
    expect(validateWidget({ kind: 'image-view', caption: 'no source' }).ok).toBe(false);
    expect(validateWidget({ kind: 'image-view', url: '   ' }).ok).toBe(false);
  });

  it('caps image-view dataUrl length', () => {
    const big = `data:image/png;base64,${'A'.repeat(2_000_001)}`;
    const r = validateWidget({ kind: 'image-view', dataUrl: big });
    expect(r.ok).toBe(true);
    if (!r.ok || r.widget.kind !== 'image-view') return;
    expect(r.widget.dataUrl!.length).toBe(2_000_000);
  });

  it('registers every new kind in the renderer', () => {
    for (const k of ['buttons', 'select', 'input', 'confirm', 'progress', 'image-view'] as const) {
      expect(WIDGET_REGISTRY[k]).toBeTypeOf('function');
      expect(registeredWidgetKinds()).toContain(k);
    }
  });
});

describe('widget registry', () => {
  it('covers every schema kind', () => {
    expect(registeredWidgetKinds().sort()).toEqual([...WIDGET_KINDS].sort());
    for (const k of WIDGET_KINDS) {
      expect(typeof WIDGET_REGISTRY[k]).toBe('function');
    }
  });
});

describe('helpers', () => {
  it('formatBytes renders human sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('cellText stringifies values safely', () => {
    expect(cellText(null)).toBe('—');
    expect(cellText(undefined)).toBe('—');
    expect(cellText(42)).toBe('42');
    expect(cellText('hi')).toBe('hi');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});

// ---- W8c: server-protocol chart forms (stacked-bar, series/values) ----

describe('validateWidget — W8c chart forms', () => {
  it('accepts the canonical server form: type + series[{label,values}]', () => {
    const v = validateWidget({
      kind: 'chart',
      type: 'stacked-bar',
      title: 'Spend by category',
      labels: ['Jan', 'Feb'],
      series: [
        { label: 'Food', values: [10, 12] },
        { label: 'Travel', values: [3, 4] },
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok && v.widget.kind === 'chart') {
      expect(v.widget.chart).toBe('stacked-bar');
      expect(v.widget.datasets).toEqual([
        { label: 'Food', values: [10, 12] },
        { label: 'Travel', values: [3, 4] },
      ]);
    }
  });

  it('accepts the split form: series names + values matrix', () => {
    const v = validateWidget({
      kind: 'chart',
      chartType: 'bar',
      labels: ['Q1', 'Q2'],
      series: ['A', 'B'],
      values: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok && v.widget.kind === 'chart') {
      expect(v.widget.chart).toBe('bar');
      expect(v.widget.datasets).toEqual([
        { label: 'A', values: [1, 2] },
        { label: 'B', values: [3, 4] },
      ]);
    }
  });

  it('rejects ragged split-form values', () => {
    const v = validateWidget({
      kind: 'chart',
      type: 'bar',
      labels: ['Q1', 'Q2'],
      series: ['A'],
      values: [[1]],
    });
    expect(v.ok).toBe(false);
  });
});
