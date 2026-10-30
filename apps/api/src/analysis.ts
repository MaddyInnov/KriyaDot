// SPDX-License-Identifier: Apache-2.0
// Analysis outputs as inline chat cards (CA-36, coding-apps parity
// audit): a packaged analysis flow over workspace data whose tabular /
// chart results render as FIRST-CLASS inline chat cards through the
// existing widget path (agent-runtime widgets.ts payloads → web
// WidgetRenderer), packaged as one typed composite card.
//
// HOST WIRING (coordinator — see the wave-6 WIRING note):
//   app.use('/api', createAnalysisRouter({ dataDir: config.dataDir }));
//   // and register createAnalysisTool(...) into the chat tool registry
//   // so bots can raise analysis cards mid-turn.
//
// Two execution modes, both producing the same AnalysisCardPayload:
// - declarative: an aggregate/group-by operation computed in-process
//   over the supplied dataset (deterministic; no code runs).
// - code: a JS snippet executed over the dataset via the SANDBOXED
//   command runner (agent-runtime executeSandboxedCommand — the
//   existing sandbox policy chain decides confinement; the result's
//   `sandboxed` flag and any host-fallback warning ride in the card's
//   provenance, never hidden). Tests inject a mock executor — zero
//   real execution, zero paid APIs.
//
// Routes (router mounted at /api):
//   POST /analysis/run   { title?, dataset, operation? | code?,
//                          chart?: { valueColumn } }
//                        → 200 { analysis: AnalysisCardPayload }
//                        → 400 invalid input / execution failure
//
// The `run_analysis` tool (createAnalysisTool) returns
// { ok, analysis, widgets } where `widgets` are the validated
// table/chart WidgetPayloads — the exact attachments the existing
// widget/artifact path renders inline in chat today. The web
// AnalysisCard component renders the composite payload itself.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { executeSandboxedCommand, validateWidgetPayload } from '@mvp/agent-runtime';
import type { ChartWidgetPayload, TableWidgetPayload, WidgetPayload } from '@mvp/agent-runtime';

export interface AnalysisDataset {
  /** Dataset name (shown in the card provenance). */
  name: string;
  columns: string[];
  /** Row objects keyed by column name. */
  rows: Array<Record<string, unknown>>;
}

export type AggregateFn = 'sum' | 'avg' | 'min' | 'max' | 'count';

export interface AnalysisOperation {
  kind: 'aggregate';
  /** Numeric column to aggregate. Required except for fn 'count'. */
  column?: string;
  fn: AggregateFn;
  /** Optional column to group rows by (one output row per group). */
  groupBy?: string;
}

/** Sandboxed code execution seam (injectable for tests). */
export type AnalysisExecutor = (input: {
  code: string;
  dataset: AnalysisDataset;
  workDir: string;
}) => Promise<{ rows: Array<Record<string, unknown>>; sandboxed?: boolean; warning?: string }>;

export interface AnalysisStat {
  label: string;
  value: string;
}

/** The typed composite chat-card payload (CA-36). */
export interface AnalysisCardPayload {
  kind: 'analysis';
  title: string;
  /** One-line human summary of what was computed. */
  summary: string;
  table: TableWidgetPayload;
  chart?: ChartWidgetPayload;
  stats: AnalysisStat[];
  provenance: {
    dataset: string;
    rowCount: number;
    execution: 'declarative' | 'sandboxed-code';
    /** Sandbox confinement actually applied (code mode only). */
    sandboxed?: boolean;
    warning?: string;
  };
}

export const ANALYSIS_LIMITS = { rows: 5_000, columns: 50, codeLength: 8_000, groups: 50 } as const;

function fail(message: string): never {
  throw new Error(message);
}

export function validateDataset(raw: unknown): AnalysisDataset {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('dataset must be an object { name, columns, rows }');
  const d = raw as Record<string, unknown>;
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 200) : 'dataset';
  if (!Array.isArray(d.columns) || d.columns.length === 0) fail('dataset.columns must be a non-empty array');
  if (d.columns.length > ANALYSIS_LIMITS.columns) fail(`dataset.columns is capped at ${ANALYSIS_LIMITS.columns}`);
  const columns = d.columns.map((c) => {
    if (typeof c !== 'string' || !c.trim()) fail('dataset.columns must be non-empty strings');
    return c;
  });
  if (!Array.isArray(d.rows)) fail('dataset.rows must be an array');
  if (d.rows.length > ANALYSIS_LIMITS.rows) fail(`dataset.rows is capped at ${ANALYSIS_LIMITS.rows}`);
  const rows = d.rows.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`dataset.rows[${i}] must be an object`);
    return r as Record<string, unknown>;
  });
  return { name, columns, rows };
}

function numeric(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function aggregateValues(values: number[], fn: AggregateFn): number {
  if (fn === 'count') return values.length;
  if (values.length === 0) return 0;
  switch (fn) {
    case 'sum': return values.reduce((s, n) => s + n, 0);
    case 'avg': return values.reduce((s, n) => s + n, 0) / values.length;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Run a declarative aggregate over a dataset → table rows (grouped or single). */
export function runDeclarativeOperation(
  dataset: AnalysisDataset,
  op: AnalysisOperation,
): { columns: string[]; rows: Array<Record<string, unknown>>; valueColumn: string } {
  if (op.fn !== 'count' && (!op.column || !dataset.columns.includes(op.column))) {
    fail(`operation.column must be one of: ${dataset.columns.join(', ')}`);
  }
  if (op.groupBy && !dataset.columns.includes(op.groupBy)) {
    fail(`operation.groupBy must be one of: ${dataset.columns.join(', ')}`);
  }
  const valueColumn = op.fn === 'count' ? 'count' : `${op.fn}(${op.column})`;
  const groups = new Map<string, number[]>();
  const order: string[] = [];
  for (const row of dataset.rows) {
    const key = op.groupBy ? String(row[op.groupBy] ?? '—') : 'all';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    if (op.fn === 'count') {
      groups.get(key)!.push(1);
    } else {
      const n = numeric(row[op.column!]);
      if (n !== undefined) groups.get(key)!.push(n);
    }
  }
  const keys = order.slice(0, ANALYSIS_LIMITS.groups);
  const columns = op.groupBy ? [op.groupBy, valueColumn] : [valueColumn];
  const rows = keys.map((key) => {
    const value = round(aggregateValues(groups.get(key)!, op.fn));
    return op.groupBy ? { [op.groupBy]: key, [valueColumn]: value } : { [valueColumn]: value };
  });
  return { columns, rows, valueColumn };
}

function toTable(columns: string[], rows: Array<Record<string, unknown>>, title?: string): TableWidgetPayload {
  const payload: TableWidgetPayload = {
    kind: 'table',
    ...(title ? { title } : {}),
    columns,
    rows: rows.map((r) => columns.map((c) => r[c] ?? null)),
  };
  const v = validateWidgetPayload(payload);
  if (!v.ok) fail(`internal: table payload failed widget validation: ${v.error}`);
  return v.payload as TableWidgetPayload;
}

function toChart(
  title: string,
  labelColumn: string | undefined,
  valueColumn: string,
  rows: Array<Record<string, unknown>>,
): ChartWidgetPayload | undefined {
  if (!labelColumn) return undefined;
  const labels = rows.map((r) => String(r[labelColumn] ?? '—')).slice(0, ANALYSIS_LIMITS.groups);
  const values = rows.map((r) => numeric(r[valueColumn]) ?? 0);
  if (labels.length === 0) return undefined;
  const payload: ChartWidgetPayload = {
    kind: 'chart',
    title,
    chartType: 'bar',
    labels,
    series: [{ label: valueColumn, values }],
  };
  const v = validateWidgetPayload(payload);
  return v.ok ? (v.payload as ChartWidgetPayload) : undefined;
}

/**
 * The default code executor: writes the dataset + code into a temp
 * workspace and runs a fixed Node runner through the existing
 * sandboxed command path (no network; the sandbox policy chain —
 * E2B / Docker / kernel / documented host fallback — decides
 * confinement, and its verdict is returned for the provenance block).
 * The snippet receives `rows` (array of row objects) and must
 * `return` the result rows array.
 */
export const sandboxedAnalysisExecutor: AnalysisExecutor = async ({ code, dataset, workDir }) => {
  const runner = [
    "import { readFileSync } from 'node:fs';",
    'const dataset = JSON.parse(readFileSync(new URL(\'./dataset.json\', import.meta.url), \'utf8\'));',
    'const rows = dataset.rows;',
    'const fn = new Function(\'rows\', \'dataset\', process.env.ANALYSIS_CODE_B64 ? Buffer.from(process.env.ANALYSIS_CODE_B64, \'base64\').toString(\'utf8\') : \'\');',
    'const out = fn(rows, dataset);',
    'if (!Array.isArray(out)) { console.error(\'analysis code must return an array of row objects\'); process.exit(2); }',
    'console.log(JSON.stringify(out));',
    '',
  ].join('\n');
  writeFileSync(join(workDir, 'dataset.json'), JSON.stringify(dataset));
  writeFileSync(join(workDir, 'analysis-runner.mjs'), runner);
  const codeB64 = Buffer.from(code, 'utf8').toString('base64');
  const res = await executeSandboxedCommand(
    `ANALYSIS_CODE_B64=${codeB64} node analysis-runner.mjs`,
    { workspaceDir: workDir, network: false, timeoutMs: 30_000, maxOutputBytes: 512_000 },
  );
  if (res.exitCode !== 0) {
    fail(`analysis code failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim().split('\n').pop() ?? 'null');
  } catch {
    fail('analysis code did not return JSON rows');
  }
  if (!Array.isArray(parsed)) fail('analysis code must return an array of row objects');
  return {
    rows: parsed as Array<Record<string, unknown>>,
    ...(res.sandboxed !== undefined ? { sandboxed: res.sandboxed } : {}),
    ...(res.warning ? { warning: res.warning } : {}),
  };
};

export interface RunAnalysisInput {
  title?: string;
  dataset: AnalysisDataset;
  operation?: AnalysisOperation;
  code?: string;
  /** Column used as chart labels for code-mode results (optional). */
  chartLabelColumn?: string;
  /** Column used as chart values for code-mode results (optional). */
  chartValueColumn?: string;
}

export interface AnalysisDeps {
  /** Code executor seam. Default: the sandboxed executor above. */
  executor?: AnalysisExecutor;
  /** Base dir for code-mode temp workspaces. Default: os tmpdir. */
  workRoot?: string;
}

/** Run an analysis and produce the typed inline-card payload. */
export async function runAnalysis(input: RunAnalysisInput, deps: AnalysisDeps = {}): Promise<AnalysisCardPayload> {
  const dataset = validateDataset(input.dataset);
  const title = (typeof input.title === 'string' && input.title.trim() ? input.title.trim() : `Analysis of ${dataset.name}`).slice(0, 200);

  if (input.code !== undefined) {
    if (typeof input.code !== 'string' || !input.code.trim()) fail('code must be a non-empty string');
    if (input.code.length > ANALYSIS_LIMITS.codeLength) fail(`code is capped at ${ANALYSIS_LIMITS.codeLength} characters`);
    const executor = deps.executor ?? sandboxedAnalysisExecutor;
    const workDir = mkdtempSync(join(deps.workRoot ?? tmpdir(), 'kriyadot-analysis-'));
    try {
      const exec = await executor({ code: input.code, dataset, workDir });
      const rows = exec.rows.slice(0, ANALYSIS_LIMITS.rows);
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : dataset.columns;
      const chart = input.chartLabelColumn && input.chartValueColumn
        ? toChart(title, input.chartLabelColumn, input.chartValueColumn, rows)
        : undefined;
      return {
        kind: 'analysis',
        title,
        summary: `Ran sandboxed code over ${dataset.rows.length} row(s) of ${dataset.name}; ${rows.length} result row(s).`,
        table: toTable(columns, rows, title),
        ...(chart ? { chart } : {}),
        stats: [
          { label: 'Input rows', value: String(dataset.rows.length) },
          { label: 'Result rows', value: String(rows.length) },
        ],
        provenance: {
          dataset: dataset.name,
          rowCount: dataset.rows.length,
          execution: 'sandboxed-code',
          ...(exec.sandboxed !== undefined ? { sandboxed: exec.sandboxed } : {}),
          ...(exec.warning ? { warning: exec.warning } : {}),
        },
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (!input.operation || input.operation.kind !== 'aggregate') {
    fail('provide either an operation ({ kind: "aggregate", fn, column?, groupBy? }) or code');
  }
  const op = input.operation;
  const { columns, rows, valueColumn } = runDeclarativeOperation(dataset, op);
  const chart = toChart(title, op.groupBy, valueColumn, rows);
  const allValues = dataset.rows.map((r) => (op.column ? numeric(r[op.column]) : undefined)).filter((n): n is number => n !== undefined);
  const stats: AnalysisStat[] = [{ label: 'Rows', value: String(dataset.rows.length) }];
  if (op.column && allValues.length > 0) {
    stats.push(
      { label: `${op.column} min`, value: String(round(Math.min(...allValues))) },
      { label: `${op.column} max`, value: String(round(Math.max(...allValues))) },
      { label: `${op.column} avg`, value: String(round(allValues.reduce((s, n) => s + n, 0) / allValues.length)) },
    );
  }
  return {
    kind: 'analysis',
    title,
    summary: op.groupBy
      ? `${op.fn} of ${op.column ?? 'rows'} by ${op.groupBy} over ${dataset.rows.length} row(s) of ${dataset.name}.`
      : `${op.fn} of ${op.column ?? 'rows'} over ${dataset.rows.length} row(s) of ${dataset.name}.`,
    table: toTable(columns, rows, title),
    ...(chart ? { chart } : {}),
    stats,
    provenance: { dataset: dataset.name, rowCount: dataset.rows.length, execution: 'declarative' },
  };
}

/** The validated widget attachments for the existing inline widget path. */
export function analysisWidgetAttachments(card: AnalysisCardPayload): WidgetPayload[] {
  const out: WidgetPayload[] = [card.table];
  if (card.chart) out.push(card.chart);
  return out;
}

/**
 * The `run_analysis` chat tool: hosts register the returned definition
 * in the tool registry; a turn that calls it gets the card payload
 * plus the widget attachments the chat surface renders inline.
 */
export function createAnalysisTool(deps: AnalysisDeps = {}): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: 'run_analysis',
    description:
      'Run an analysis over a dataset (aggregate/group-by, or a sandboxed code snippet) and return the result as an inline chat card: a table, an optional bar chart, and summary stats.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        dataset: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            columns: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'object' } },
          },
          required: ['name', 'columns', 'rows'],
        },
        operation: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['aggregate'] },
            fn: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count'] },
            column: { type: 'string' },
            groupBy: { type: 'string' },
          },
          required: ['kind', 'fn'],
        },
        code: { type: 'string', description: 'JS snippet receiving `rows`; must return an array of row objects. Runs sandboxed.' },
        chartLabelColumn: { type: 'string' },
        chartValueColumn: { type: 'string' },
      },
      required: ['dataset'],
    },
    mutating: false,
    handler: async (args) => {
      const card = await runAnalysis(
        {
          title: args.title as string | undefined,
          dataset: args.dataset as AnalysisDataset,
          operation: args.operation as AnalysisOperation | undefined,
          code: args.code as string | undefined,
          chartLabelColumn: args.chartLabelColumn as string | undefined,
          chartValueColumn: args.chartValueColumn as string | undefined,
        },
        deps,
      );
      return { ok: true, analysis: card, widgets: analysisWidgetAttachments(card) };
    },
  };
}

export interface AnalysisRoutesDeps extends AnalysisDeps {}

/** Register POST /analysis/run on an existing router (paths relative). */
export function registerAnalysisRoutes(router: Router, deps: AnalysisRoutesDeps = {}): void {
  router.post('/analysis/run', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const card = await runAnalysis(
        {
          title: b.title as string | undefined,
          dataset: b.dataset as AnalysisDataset,
          operation: b.operation as AnalysisOperation | undefined,
          code: b.code as string | undefined,
          chartLabelColumn: b.chartLabelColumn as string | undefined,
          chartValueColumn: b.chartValueColumn as string | undefined,
        },
        deps,
      );
      res.json({ analysis: card, widgets: analysisWidgetAttachments(card) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Standalone router for the analysis surface (mount at /api). */
export function createAnalysisRouter(deps: AnalysisRoutesDeps = {}): Router {
  const router = express.Router();
  registerAnalysisRoutes(router, deps);
  return router;
}
