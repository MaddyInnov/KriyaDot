// SPDX-License-Identifier: Apache-2.0
// In-chat widget schema + validation.
//
// A widget is a small JSON payload the agent can stream inside chat
// (`{ "type": "widget", "widget": { "kind": "table", ... } }`) to render a
// rich card inline. Validation is strict on shape but forgiving on extras:
// unknown fields are stripped, never passed through to the DOM.
//
// This module is pure TypeScript (no React) so it can be unit-tested and
// shared between the stream handler and the renderer.

export const WIDGET_KINDS = [
  'table',
  'chart',
  'actions',
  'map',
  'file',
  'buttons',
  'select',
  'input',
  'confirm',
  'progress',
  'image-view',
  'mcp-app',
  'page',
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export interface WidgetBase {
  kind: WidgetKind;
  /** Optional card heading. */
  title?: string;
}

export interface TableWidget extends WidgetBase {
  kind: 'table';
  columns: string[];
  /**
   * Rows in column order. The validator normalizes object-shaped rows
   * (`{col: value}`) into arrays, so views only handle arrays.
   */
  rows: Array<Array<unknown>>;
}

export interface ChartDataset {
  label: string;
  values: number[];
}

export interface ChartWidget extends WidgetBase {
  kind: 'chart';
  /**
   * 'bar' = grouped bars; 'stacked-bar' = datasets stacked per label
   * (W8c — the server widget protocol's canonical chart form);
   * 'line' = line/area (legacy web-native form).
   */
  chart: 'bar' | 'line' | 'stacked-bar';
  labels: string[];
  datasets: ChartDataset[];
}

export interface WidgetAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger' | 'default';
  /**
   * POST target for the action, resolved against the API base
   * (e.g. "/api/workflows/abc/run"). Defaults to "/api/widget-action".
   */
  endpoint?: string;
  payload?: Record<string, unknown>;
}

export interface ActionsWidget extends WidgetBase {
  kind: 'actions';
  buttons: WidgetAction[];
}

export interface MapWidget extends WidgetBase {
  kind: 'map';
  /** Free-text place query, e.g. "Connaught Place, New Delhi". */
  query?: string;
  lat?: number;
  lng?: number;
  label?: string;
}

export interface FileWidget extends WidgetBase {
  kind: 'file';
  name: string;
  /** Size in bytes. */
  size?: number;
  mime?: string;
  /** Download href. */
  url?: string;
}

/** Sandboxed MCP App (HTML UI from an MCP server, rendered in an iframe). */
export interface McpAppWidget extends WidgetBase {
  kind: 'mcp-app';
  serverId: string;
  resourceUri: string;
  /** Per-render bridge nonce (never exposed to the app frame). */
  nonce: string;
}

/** Page artifact card (publish_page completion): open + preview actions. */
export interface PageWidget extends WidgetBase {
  kind: 'page';
  pageId: string;
  slug?: string;
  /** Public path, e.g. /p/<slug>. */
  path?: string;
}

export type Widget =
  | TableWidget
  | ChartWidget
  | ActionsWidget
  | MapWidget
  | FileWidget
  | ButtonsWidget
  | SelectWidget
  | InputWidget
  | ConfirmWidget
  | ProgressWidget
  | ImageViewWidget
  | McpAppWidget
  | PageWidget;

export type WidgetValidation =
  | { ok: true; widget: Widget }
  | { ok: false; error: string };

/* ---------- interactive widgets (OpenMausBot parity: AskUserQuestion) ---------- */

/** One selectable option in a buttons/select widget. */
export interface WidgetOption {
  id: string;
  label: string;
  description?: string;
}

export interface ButtonsWidget extends WidgetBase {
  kind: 'buttons';
  /** Prompt shown above the options. */
  question?: string;
  options: WidgetOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}

export interface SelectWidget extends WidgetBase {
  kind: 'select';
  /** Label for the dropdown. */
  label?: string;
  options: WidgetOption[];
  multiSelect?: boolean;
}

export interface InputWidget extends WidgetBase {
  kind: 'input';
  /** Label above the field. */
  label?: string;
  placeholder?: string;
  /** Prefilled text. */
  default?: string;
  multiline?: boolean;
}

export interface ConfirmWidget extends WidgetBase {
  kind: 'confirm';
  /** The yes/no question. */
  question: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ProgressWidget extends WidgetBase {
  kind: 'progress';
  /** Label shown next to the bar. */
  label?: string;
  /** 0-100. When omitted (or indeterminate is true) the bar animates. */
  percent?: number;
  indeterminate?: boolean;
}

export interface ImageViewWidget extends WidgetBase {
  kind: 'image-view';
  caption?: string;
  alt?: string;
  /** Remote image URL. */
  url?: string;
  /** Inline data: URL (image/*). */
  dataUrl?: string;
}

/**
 * Runtime answer state for an interactive widget. Kept by the page layer
 * (optimistic local answer + server `widget_answered` stream events), not
 * by the validator.
 */
export interface WidgetAnswerState {
  answered: boolean;
  value?: unknown;
  expired?: boolean;
  answeredAt: number;
}

// Hard caps keep a malicious/buggy payload from blowing up the chat UI.
const MAX_COLUMNS = 50;
const MAX_ROWS = 500;
const MAX_LABELS = 200;
const MAX_DATASETS = 12;
const MAX_BUTTONS = 10;
const MAX_STR = 500;
// Interactive-widget caps (OpenMausBot AskUserQuestion protocol).
const MAX_OPTIONS = 20;
const MAX_OPTION_ID = 200;
const MAX_OPTION_DESC = 500;
const MAX_QUESTION = 500;
const MAX_IMAGE_URL = 2000;
const MAX_DATA_URL = 2_000_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, cap = MAX_STR): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, cap) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function fail(error: string): WidgetValidation {
  return { ok: false, error };
}

function baseOf(raw: Record<string, unknown>, kind: WidgetKind): WidgetBase {
  const title = str(raw.title);
  return title !== undefined ? { kind, title } : { kind };
}

function validateTable(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'table');
  if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
    return fail('table widget requires a non-empty "columns" array');
  }
  if (raw.columns.length > MAX_COLUMNS) return fail(`table widget allows at most ${MAX_COLUMNS} columns`);
  const columns: string[] = [];
  for (const c of raw.columns) {
    const s = str(c, 120);
    if (s === undefined) return fail('table widget "columns" must be non-empty strings');
    columns.push(s);
  }
  if (!Array.isArray(raw.rows)) return fail('table widget requires a "rows" array');
  if (raw.rows.length > MAX_ROWS) return fail(`table widget allows at most ${MAX_ROWS} rows`);
  const rows: Array<Array<unknown>> = [];
  for (const r of raw.rows) {
    if (Array.isArray(r)) {
      rows.push(r.slice(0, columns.length));
    } else if (isRecord(r)) {
      rows.push(columns.map((c) => r[c]));
    } else {
      return fail('table widget "rows" must be objects or arrays');
    }
  }
  return { ok: true, widget: { ...base, kind: 'table', columns, rows } };
}

function validateChart(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'chart');
  // Three accepted spellings of the chart type: the web-native `chart`
  // field, and the server protocol's (W8c) `chartType` / `type` fields.
  const typeRaw = raw.chart ?? raw.chartType ?? raw.type;
  const chart =
    typeRaw === 'bar' || typeRaw === 'line' || typeRaw === 'stacked-bar' ? typeRaw : undefined;
  if (!chart) return fail('chart widget requires a chart type: "bar" | "stacked-bar" | "line"');
  if (!Array.isArray(raw.labels) || raw.labels.length === 0) {
    return fail('chart widget requires a non-empty "labels" array');
  }
  if (raw.labels.length > MAX_LABELS) return fail(`chart widget allows at most ${MAX_LABELS} labels`);
  const labels: string[] = [];
  for (const l of raw.labels) {
    const s = str(l, 80);
    if (s === undefined) return fail('chart widget "labels" must be non-empty strings');
    labels.push(s);
  }
  // Dataset sources, normalized to one shape: `datasets` (web-native),
  // `series: [{label, values}]` (server canonical), or the split form
  // `series: string[]` + `values: number[][]` (server split form).
  let rawDatasets: unknown[] | undefined;
  if (Array.isArray(raw.datasets) && raw.datasets.length > 0) {
    rawDatasets = raw.datasets;
  } else if (Array.isArray(raw.series) && raw.series.length > 0) {
    if (raw.series.every((s) => typeof s === 'string')) {
      const rows = Array.isArray(raw.values) ? raw.values : [];
      rawDatasets = (raw.series as string[]).map((label, i) => ({ label, values: rows[i] }));
    } else {
      rawDatasets = raw.series;
    }
  }
  if (!rawDatasets || rawDatasets.length === 0) {
    return fail('chart widget requires a non-empty "datasets" (or "series") array');
  }
  if (rawDatasets.length > MAX_DATASETS) {
    return fail(`chart widget allows at most ${MAX_DATASETS} datasets`);
  }
  const datasets: ChartDataset[] = [];
  for (const d of rawDatasets) {
    if (!isRecord(d)) return fail('chart widget "datasets" must be objects');
    const label = str(d.label, 80);
    if (label === undefined) return fail('chart dataset requires a "label" string');
    if (!Array.isArray(d.values) || d.values.length !== labels.length) {
      return fail(
        `chart dataset "${label}" must have exactly ${labels.length} values (one per label)`,
      );
    }
    const values: number[] = [];
    for (const v of d.values) {
      const n = num(v);
      if (n === undefined) return fail(`chart dataset "${label}" values must be finite numbers`);
      values.push(n);
    }
    datasets.push({ label, values });
  }
  return { ok: true, widget: { ...base, kind: 'chart', chart, labels, datasets } };
}

function validateActions(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'actions');
  if (!Array.isArray(raw.buttons) || raw.buttons.length === 0) {
    return fail('actions widget requires a non-empty "buttons" array');
  }
  if (raw.buttons.length > MAX_BUTTONS) return fail(`actions widget allows at most ${MAX_BUTTONS} buttons`);
  const buttons: WidgetAction[] = [];
  for (const b of raw.buttons) {
    if (!isRecord(b)) return fail('actions widget "buttons" must be objects');
    const id = str(b.id, 80);
    const label = str(b.label, 80);
    if (id === undefined || label === undefined) {
      return fail('actions widget buttons require "id" and "label" strings');
    }
    const style = b.style === 'primary' || b.style === 'danger' ? b.style : 'default';
    const btn: WidgetAction = { id, label, style };
    const endpoint = str(b.endpoint, 300);
    if (endpoint !== undefined) btn.endpoint = endpoint;
    if (isRecord(b.payload)) btn.payload = b.payload;
    buttons.push(btn);
  }
  return { ok: true, widget: { ...base, kind: 'actions', buttons } };
}

function validateMap(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'map');
  const w: MapWidget = { ...base, kind: 'map' };
  const query = str(raw.query);
  if (query !== undefined) w.query = query;
  const label = str(raw.label);
  if (label !== undefined) w.label = label;
  const lat = raw.lat === undefined ? undefined : num(raw.lat);
  const lng = raw.lng === undefined ? undefined : num(raw.lng);
  if (raw.lat !== undefined && lat === undefined) return fail('map widget "lat" must be a finite number');
  if (raw.lng !== undefined && lng === undefined) return fail('map widget "lng" must be a finite number');
  if (lat !== undefined && (lat < -90 || lat > 90)) return fail('map widget "lat" must be between -90 and 90');
  if (lng !== undefined && (lng < -180 || lng > 180)) {
    return fail('map widget "lng" must be between -180 and 180');
  }
  if (lat !== undefined) w.lat = lat;
  if (lng !== undefined) w.lng = lng;
  if (query === undefined && lat === undefined) {
    return fail('map widget needs at least a "query" or coordinates');
  }
  return { ok: true, widget: w };
}

function validateFile(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'file');
  const name = str(raw.name, 200);
  if (name === undefined) return fail('file widget requires a "name" string');
  const w: FileWidget = { ...base, kind: 'file', name };
  const size = raw.size === undefined ? undefined : num(raw.size);
  if (raw.size !== undefined && (size === undefined || size < 0)) {
    return fail('file widget "size" must be a non-negative number');
  }
  if (size !== undefined) w.size = Math.floor(size);
  const mime = str(raw.mime, 120);
  if (mime !== undefined) w.mime = mime;
  const url = str(raw.url, 2000);
  if (url !== undefined) w.url = url;
  return { ok: true, widget: w };
}

/* ---------- interactive widget validators ---------- */

/**
 * Shared option-list validation for buttons/select.
 * Returns the sanitized options or undefined when invalid.
 */
function validateOptions(raw: unknown): WidgetOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (raw.length > MAX_OPTIONS) return undefined;
  const options: WidgetOption[] = [];
  for (const o of raw) {
    if (!isRecord(o)) return undefined;
    const id = str(o.id, MAX_OPTION_ID);
    const label = str(o.label, MAX_OPTION_ID);
    if (id === undefined || label === undefined) return undefined;
    const opt: WidgetOption = { id, label };
    const description = str(o.description, MAX_OPTION_DESC);
    if (description !== undefined) opt.description = description;
    options.push(opt);
  }
  return options;
}

function flag(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key];
  return v === undefined ? undefined : bool(v);
}

function validateButtons(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'buttons');
  const options = validateOptions(raw.options);
  if (!options) return fail('buttons widget requires a non-empty "options" array (at most 20) of {id,label}');
  const w: ButtonsWidget = { ...base, kind: 'buttons', options };
  const question = str(raw.question, MAX_QUESTION);
  if (question !== undefined) w.question = question;
  const multiSelect = flag(raw, 'multiSelect');
  if (multiSelect !== undefined) w.multiSelect = multiSelect;
  const allowFreeText = flag(raw, 'allowFreeText');
  if (allowFreeText !== undefined) w.allowFreeText = allowFreeText;
  return { ok: true, widget: w };
}

function validateSelect(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'select');
  const options = validateOptions(raw.options);
  if (!options) return fail('select widget requires a non-empty "options" array (at most 20) of {id,label}');
  const w: SelectWidget = { ...base, kind: 'select', options };
  const label = str(raw.label);
  if (label !== undefined) w.label = label;
  const multiSelect = flag(raw, 'multiSelect');
  if (multiSelect !== undefined) w.multiSelect = multiSelect;
  return { ok: true, widget: w };
}

function validateInput(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'input');
  const w: InputWidget = { ...base, kind: 'input' };
  const label = str(raw.label);
  if (label !== undefined) w.label = label;
  const placeholder = str(raw.placeholder);
  if (placeholder !== undefined) w.placeholder = placeholder;
  const def = str(raw.default);
  if (def !== undefined) w.default = def;
  const multiline = flag(raw, 'multiline');
  if (multiline !== undefined) w.multiline = multiline;
  return { ok: true, widget: w };
}

function validateConfirm(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'confirm');
  const question = str(raw.question, MAX_QUESTION);
  if (question === undefined) return fail('confirm widget requires a "question" string');
  const w: ConfirmWidget = { ...base, kind: 'confirm', question };
  const confirmLabel = str(raw.confirmLabel, MAX_OPTION_ID);
  if (confirmLabel !== undefined) w.confirmLabel = confirmLabel;
  const cancelLabel = str(raw.cancelLabel, MAX_OPTION_ID);
  if (cancelLabel !== undefined) w.cancelLabel = cancelLabel;
  return { ok: true, widget: w };
}

function validateProgress(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'progress');
  const w: ProgressWidget = { ...base, kind: 'progress' };
  const label = str(raw.label);
  if (label !== undefined) w.label = label;
  if (raw.percent !== undefined) {
    const p = num(raw.percent);
    if (p === undefined) return fail('progress widget "percent" must be a finite number');
    w.percent = Math.min(100, Math.max(0, p));
  }
  const indeterminate = flag(raw, 'indeterminate');
  if (indeterminate !== undefined) w.indeterminate = indeterminate;
  return { ok: true, widget: w };
}

function validateMcpApp(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'mcp-app');
  const serverId = str(raw.serverId, 200);
  if (serverId === undefined) return fail('mcp-app widget requires a "serverId" string');
  const resourceUri = str(raw.resourceUri, MAX_IMAGE_URL);
  if (resourceUri === undefined || !resourceUri.startsWith('ui://')) {
    return fail('mcp-app widget requires a ui:// "resourceUri"');
  }
  const nonce = str(raw.nonce, 200);
  if (nonce === undefined) return fail('mcp-app widget requires a "nonce" string');
  return { ok: true, widget: { ...base, kind: 'mcp-app', serverId, resourceUri, nonce } };
}

function validatePage(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'page');
  const pageId = str(raw.pageId, 200);
  if (pageId === undefined) return fail('page widget requires a "pageId" string');
  const w: PageWidget = { ...base, kind: 'page', pageId };
  const slug = str(raw.slug, 200);
  if (slug !== undefined) w.slug = slug;
  const path = str(raw.path, MAX_IMAGE_URL);
  if (path !== undefined) w.path = path;
  return { ok: true, widget: w };
}

function validateImageView(raw: Record<string, unknown>): WidgetValidation {
  const base = baseOf(raw, 'image-view');
  const w: ImageViewWidget = { ...base, kind: 'image-view' };
  const url = str(raw.url, MAX_IMAGE_URL);
  if (url !== undefined) w.url = url;
  const dataUrl = str(raw.dataUrl, MAX_DATA_URL);
  if (dataUrl !== undefined) w.dataUrl = dataUrl;
  if (w.url === undefined && w.dataUrl === undefined) {
    return fail('image-view widget requires a "url" or "dataUrl"');
  }
  const caption = str(raw.caption);
  if (caption !== undefined) w.caption = caption;
  const alt = str(raw.alt);
  if (alt !== undefined) w.alt = alt;
  return { ok: true, widget: w };
}

/**
 * Validate an untrusted widget payload from the stream.
 * Returns the sanitized widget (unknown fields stripped) or an error.
 */
export function validateWidget(payload: unknown): WidgetValidation {
  if (!isRecord(payload)) return fail('widget payload must be an object');
  const kind = payload.kind;
  if (typeof kind !== 'string' || !(WIDGET_KINDS as readonly string[]).includes(kind)) {
    return fail(`unknown widget kind: ${JSON.stringify(kind)} (expected one of ${WIDGET_KINDS.join(', ')})`);
  }
  switch (kind as WidgetKind) {
    case 'table':
      return validateTable(payload);
    case 'chart':
      return validateChart(payload);
    case 'actions':
      return validateActions(payload);
    case 'map':
      return validateMap(payload);
    case 'file':
      return validateFile(payload);
    case 'buttons':
      return validateButtons(payload);
    case 'select':
      return validateSelect(payload);
    case 'input':
      return validateInput(payload);
    case 'confirm':
      return validateConfirm(payload);
    case 'progress':
      return validateProgress(payload);
    case 'image-view':
      return validateImageView(payload);
    case 'mcp-app':
      return validateMcpApp(payload);
    case 'page':
      return validatePage(payload);
  }
}

/** Human-readable byte size for the file widget. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Render a cell value as text (table widget). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '—';
  } catch {
    return '—';
  }
}
