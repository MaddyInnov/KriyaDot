// SPDX-License-Identifier: Apache-2.0
// In-chat widget renderers. The registry maps each WidgetKind to its view;
// WidgetRenderer dispatches. Pure SVG charts — no chart dependencies.

'use client';

import React, { useEffect, useState } from 'react';
import {
  cellText,
  formatBytes,
  type ActionsWidget,
  type ButtonsWidget,
  type ChartWidget,
  type ConfirmWidget,
  type FileWidget,
  type ImageViewWidget,
  type InputWidget,
  type MapWidget,
  type ProgressWidget,
  type SelectWidget,
  type TableWidget,
  type Widget,
  type WidgetAction,
  type WidgetAnswerState,
  type WidgetKind,
  type WidgetOption,
  WIDGET_KINDS,
} from './schema';

export type WidgetActionHandler = (action: WidgetAction, widget: ActionsWidget) => void | Promise<void>;

/** Posts an interactive widget's answer back to the API. Wired by the page layer. */
export type WidgetAnswerHandler = (widgetId: string, value: unknown) => void | Promise<void>;

/**
 * Runtime state for interactive widgets, supplied by the page layer
 * (stream events + optimistic answer state). Old display kinds ignore it.
 */
export interface WidgetRuntimeProps {
  /** Server stream id — required to post an answer. */
  widgetId?: string;
  /** Epoch ms after which answering is disabled. */
  expiresAt?: number;
  /** false = display-only; the answer UI renders read-only. */
  interactive?: boolean;
  /** Optimistic + server-confirmed answer state. */
  answered?: WidgetAnswerState;
  onAnswer?: WidgetAnswerHandler;
}

const KIND_LABEL: Record<WidgetKind, string> = {
  table: 'table',
  chart: 'chart',
  actions: 'actions',
  map: 'place',
  file: 'file',
  buttons: 'choices',
  select: 'select',
  input: 'input',
  confirm: 'confirm',
  progress: 'progress',
  'image-view': 'image',
};

/* ---------- interactive-widget helpers ---------- */

/**
 * True once the answer window has closed without an answer — either the
 * server marked the widget expired, or its expiresAt passed. A one-shot
 * timer flips the UI exactly at expiresAt so a widget left open in chat
 * shows the expired note without a reload.
 */
function useExpired(expiresAt: number | undefined, answered?: WidgetAnswerState): boolean {
  const serverExpired = answered?.expired === true;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined || serverExpired) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return; // already expired; no timer needed
    const t = setTimeout(() => setNow(Date.now()), Math.min(remaining, 2147483647));
    return () => clearTimeout(t);
  }, [expiresAt, serverExpired]);
  if (serverExpired) return true;
  if (expiresAt === undefined) return false;
  return now >= expiresAt;
}

/** Read-only summary shown after an interactive widget is answered. */
function AnsweredNote({ summary }: { summary: string }) {
  return (
    <div className="widget-answered">
      <span className="chip green">answered</span>
      <span>
        You chose: <strong>{summary}</strong>
      </span>
    </div>
  );
}

function ExpiredNote() {
  return (
    <div className="widget-answered">
      <span className="chip gray">expired</span>
      <span className="muted">Expired — the agent continued without an answer.</span>
    </div>
  );
}

/**
 * Human-readable summary of an answer value for the "You chose" note.
 * Falls back to JSON-ish text for unknown shapes (never crashes on
 * server-echoed values).
 */
function answerSummary(widget: Widget, value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return cellText(value);
  }
  const v = value as Record<string, unknown>;
  switch (widget.kind) {
    case 'buttons':
    case 'select': {
      const opts: WidgetOption[] = (widget as ButtonsWidget | SelectWidget).options;
      const sel = Array.isArray(v.selected) ? v.selected : [];
      const labels = sel.map((id) => opts.find((o) => o.id === id)?.label ?? String(id));
      const ft = typeof v.freeText === 'string' && v.freeText.trim().length > 0 ? ` — “${v.freeText}”` : '';
      return labels.length > 0 ? labels.join(', ') + ft : '—';
    }
    case 'input':
      return typeof v.text === 'string' && v.text.length > 0 ? v.text : '—';
    case 'confirm': {
      const w = widget as ConfirmWidget;
      return v.confirmed === true ? w.confirmLabel ?? 'Confirmed' : w.cancelLabel ?? 'Cancelled';
    }
    default:
      return cellText(value);
  }
}

/**
 * Per-view answer plumbing. `canAnswer` is true only when the page wired a
 * handler, the server marked the widget interactive, and a widgetId exists
 * for the POST. `done` is the answered (or server-expired) terminal state;
 * `expired` is the unanswered expiry that disables the form.
 */
function useInteractive(runtime: WidgetRuntimeProps) {
  const done = runtime.answered?.answered === true;
  const expired = useExpired(runtime.expiresAt, runtime.answered);
  const canAnswer =
    runtime.interactive === true && !!runtime.onAnswer && typeof runtime.widgetId === 'string';
  return { done, expired, canAnswer };
}

/** Post an answer, guarding the double-submit. Returns true on dispatch. */
async function postAnswer(
  runtime: WidgetRuntimeProps,
  value: unknown,
  setSubmitting: (b: boolean) => void,
): Promise<boolean> {
  if (!runtime.onAnswer || typeof runtime.widgetId !== 'string') return false;
  setSubmitting(true);
  try {
    await runtime.onAnswer(runtime.widgetId, value);
    return true;
  } finally {
    setSubmitting(false);
  }
}

/* ---------- table ---------- */

function TableView({ widget }: { widget: TableWidget }) {
  return (
    <div className="widget-table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {widget.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {widget.rows.map((row, i) => (
            <tr key={i}>
              {widget.columns.map((c, j) => (
                <td key={j} className={typeof row[j] === 'number' ? 'mono' : undefined}>
                  {cellText(row[j])}
                </td>
              ))}
            </tr>
          ))}
          {widget.rows.length === 0 && (
            <tr>
              <td colSpan={widget.columns.length} className="muted">
                No rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- chart (SVG, no deps) ---------- */

const CHART_COLORS = ['#4f46e5', '#16a34a', '#d97706', '#dc2626', '#0ea5e9', '#8b5cf6'];
const CW = 420;
const CH = 240;
const PAD = { l: 40, r: 12, t: 14, b: 34 };

function chartScales(widget: ChartWidget) {
  const all = widget.datasets.flatMap((d) => d.values);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const span = max - min || 1;
  const iw = CW - PAD.l - PAD.r;
  const ih = CH - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (iw * (i + 0.5)) / widget.labels.length;
  const y = (v: number) => PAD.t + ih - ((v - min) / span) * ih;
  return { x, y, iw, ih, min, max };
}

function ChartView({ widget }: { widget: ChartWidget }) {
  const { x, y, iw } = chartScales(widget);
  const n = widget.labels.length;
  const slot = iw / n;
  if (widget.chart === 'bar') {
    const per = Math.min(28, (slot * 0.7) / widget.datasets.length);
    const groupW = per * widget.datasets.length;
    return (
      <>
        <svg className="widget-chart" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={widget.title ?? 'Bar chart'}>
          {widget.labels.map((l, i) => (
            <text key={i} x={x(i)} y={CH - 10} textAnchor="middle" fontSize="10" fill="#a1a1aa">
              {l.length > 12 ? `${l.slice(0, 11)}…` : l}
            </text>
          ))}
          {widget.datasets.map((d, di) =>
            d.values.map((v, i) => {
              const bx = x(i) - groupW / 2 + di * per;
              const by = y(v);
              const zeroY = y(0);
              return (
                <rect
                  key={`${di}-${i}`}
                  x={bx}
                  y={Math.min(by, zeroY)}
                  width={Math.max(2, per - 3)}
                  height={Math.max(2, Math.abs(zeroY - by))}
                  rx="2"
                  fill={CHART_COLORS[di % CHART_COLORS.length]}
                >
                  <title>{`${d.label} · ${widget.labels[i]}: ${v}`}</title>
                </rect>
              );
            }),
          )}
        </svg>
        <ChartLegend widget={widget} />
      </>
    );
  }
  // line
  return (
    <>
      <svg className="widget-chart" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={widget.title ?? 'Line chart'}>
        {widget.datasets.map((d, di) => {
          const pts = d.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
          const color = CHART_COLORS[di % CHART_COLORS.length];
          const area = `${PAD.l},${y(0)} ${pts} ${PAD.l + iw},${y(0)}`;
          return (
            <g key={di}>
              <polygon points={area} fill={color} opacity="0.12" />
              <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
              {d.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={color} stroke="#fff" strokeWidth="1.5">
                  <title>{`${d.label} · ${widget.labels[i]}: ${v}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {widget.labels.map((l, i) => (
          <text key={i} x={x(i)} y={CH - 10} textAnchor="middle" fontSize="10" fill="#a1a1aa">
            {l.length > 12 ? `${l.slice(0, 11)}…` : l}
          </text>
        ))}
      </svg>
      <ChartLegend widget={widget} />
    </>
  );
}

function ChartLegend({ widget }: { widget: ChartWidget }) {
  if (widget.datasets.length < 2) return null;
  return (
    <div className="widget-chart-legend">
      {widget.datasets.map((d, i) => (
        <span key={i}>
          <span className="swatch" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
          {d.label}
        </span>
      ))}
    </div>
  );
}

/* ---------- actions ---------- */

function ActionsView({
  widget,
  onAction,
}: {
  widget: ActionsWidget;
  onAction?: WidgetActionHandler;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const click = async (a: WidgetAction) => {
    if (!onAction || busyId) return;
    setBusyId(a.id);
    try {
      await onAction(a, widget);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="widget-actions">
      {widget.buttons.map((b) => {
        const cls =
          b.style === 'primary' ? 'btn btn-primary' : b.style === 'danger' ? 'btn btn-danger' : 'btn';
        return (
          <button
            key={b.id}
            className={`${cls}${busyId === b.id ? ' busy' : ''}`}
            onClick={() => void click(b)}
            disabled={!onAction || busyId !== null}
            title={onAction ? undefined : 'No action handler wired'}
          >
            {busyId === b.id ? 'Working…' : b.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- map / place placeholder ---------- */

function MapView({ widget }: { widget: MapWidget }) {
  const q =
    widget.query ??
    (widget.lat !== undefined && widget.lng !== undefined
      ? `${widget.lat},${widget.lng}`
      : undefined);
  const mapsUrl = q
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
    : undefined;
  return (
    <div className="widget-map">
      <div className="map-pin" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </div>
      <div>
        <div style={{ fontWeight: 650 }}>{widget.label ?? widget.query ?? 'Pinned place'}</div>
        <div className="small muted">
          {widget.lat !== undefined && widget.lng !== undefined
            ? `${widget.lat.toFixed(4)}, ${widget.lng.toFixed(4)}`
            : widget.query}
        </div>
        {mapsUrl && (
          <a className="small" href={mapsUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Open in Maps →
          </a>
        )}
      </div>
    </div>
  );
}

/* ---------- file ---------- */

function FileView({ widget }: { widget: FileWidget }) {
  return (
    <div className="widget-file">
      <div className="file-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {widget.name}
        </div>
        <div className="small muted">
          {widget.mime ? `${widget.mime} · ` : ''}
          {widget.size !== undefined ? formatBytes(widget.size) : 'size unknown'}
        </div>
        {widget.url && (
          <a className="small" href={widget.url} download={widget.name} style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Download →
          </a>
        )}
      </div>
    </div>
  );
}

/* ---------- buttons (AskUserQuestion: option list) ---------- */

function ButtonsView({ widget, runtime }: { widget: ButtonsWidget; runtime: WidgetRuntimeProps }) {
  const { done, expired, canAnswer } = useInteractive(runtime);
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (done && !runtime.answered?.expired) {
    return <AnsweredNote summary={answerSummary(widget, runtime.answered?.value)} />;
  }
  // Unanswered expiry: show the note, keep the form visible but disabled.
  const expiredNow = (done && runtime.answered?.expired === true) || (canAnswer && expired);

  const toggle = (id: string) => {
    if (!canAnswer || submitting) return;
    setSelected((prev) =>
      widget.multiSelect
        ? prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        : [id],
    );
  };

  const submit = () => {
    const value: { selected: string[]; freeText?: string } = { selected };
    const ft = freeText.trim();
    if (ft) value.freeText = ft;
    void postAnswer(runtime, value, setSubmitting);
  };

  const canSubmit =
    canAnswer && !expiredNow && !submitting && (selected.length > 0 || freeText.trim().length > 0);

  return (
    <div className="widget-buttons">
      {expiredNow && <ExpiredNote />}
      {widget.question && <p className="widget-question">{widget.question}</p>}
      <div className="widget-options">
        {widget.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`btn opt${selected.includes(o.id) ? ' selected' : ''}`}
            onClick={() => toggle(o.id)}
            disabled={!canAnswer || submitting || expiredNow}
            title={o.description}
            aria-pressed={selected.includes(o.id)}
          >
            <span>{o.label}</span>
            {o.description && <span className="small muted opt-desc">{o.description}</span>}
          </button>
        ))}
      </div>
      {widget.allowFreeText && canAnswer && (
        <input
          className="widget-freetext"
          placeholder="Or type your own answer…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          disabled={submitting || expiredNow}
          aria-label="Free-text answer"
        />
      )}
      {canAnswer && !expiredNow && (
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
          {submitting ? 'Sending…' : 'Submit'}
        </button>
      )}
    </div>
  );
}

/* ---------- select (AskUserQuestion: dropdown) ---------- */

function SelectView({ widget, runtime }: { widget: SelectWidget; runtime: WidgetRuntimeProps }) {
  const { done, expired, canAnswer } = useInteractive(runtime);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  if (done && !runtime.answered?.expired) {
    return <AnsweredNote summary={answerSummary(widget, runtime.answered?.value)} />;
  }
  const expiredNow = (done && runtime.answered?.expired === true) || (canAnswer && expired);

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (widget.multiSelect) {
      setSelected(Array.from(e.target.selectedOptions).map((o) => o.value));
    } else {
      setSelected([e.target.value]);
    }
  };

  const submit = () => {
    void postAnswer(runtime, { selected }, setSubmitting);
  };

  return (
    <div className="widget-select">
      {expiredNow && <ExpiredNote />}
      {widget.label && (
        <label className="small" style={{ fontWeight: 650 }} htmlFor={`wselect-${widget.options[0]?.id}`}>
          {widget.label}
        </label>
      )}
      <select
        id={`wselect-${widget.options[0]?.id}`}
        className="widget-dropdown"
        multiple={!!widget.multiSelect}
        value={widget.multiSelect ? selected : selected[0] ?? ''}
        onChange={onChange}
        disabled={!canAnswer || submitting || expiredNow}
        aria-label={widget.label ?? 'Choose an option'}
      >
        {!widget.multiSelect && (
          <option value="" disabled>
            Choose…
          </option>
        )}
        {widget.options.map((o) => (
          <option key={o.id} value={o.id} title={o.description}>
            {o.label}
          </option>
        ))}
      </select>
      {canAnswer && !expiredNow && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={submitting || selected.length === 0}
        >
          {submitting ? 'Sending…' : 'Submit'}
        </button>
      )}
    </div>
  );
}

/* ---------- input (AskUserQuestion: free text) ---------- */

function InputView({ widget, runtime }: { widget: InputWidget; runtime: WidgetRuntimeProps }) {
  const { done, expired, canAnswer } = useInteractive(runtime);
  const [text, setText] = useState(widget.default ?? '');
  const [submitting, setSubmitting] = useState(false);

  if (done && !runtime.answered?.expired) {
    return <AnsweredNote summary={answerSummary(widget, runtime.answered?.value)} />;
  }
  const expiredNow = (done && runtime.answered?.expired === true) || (canAnswer && expired);

  const submit = () => {
    void postAnswer(runtime, { text }, setSubmitting);
  };

  return (
    <div className="widget-input">
      {expiredNow && <ExpiredNote />}
      {widget.label && (
        <div className="small" style={{ fontWeight: 650, marginBottom: 6 }}>
          {widget.label}
        </div>
      )}
      {widget.multiline ? (
        <textarea
          className="widget-textarea"
          rows={4}
          placeholder={widget.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!canAnswer || submitting || expiredNow}
          aria-label={widget.label ?? 'Answer'}
        />
      ) : (
        <input
          className="widget-freetext"
          placeholder={widget.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!canAnswer || submitting || expiredNow}
          aria-label={widget.label ?? 'Answer'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canAnswer && !submitting && !expiredNow) submit();
          }}
        />
      )}
      {canAnswer && !expiredNow && (
        <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Sending…' : 'Submit'}
        </button>
      )}
    </div>
  );
}

/* ---------- confirm (AskUserQuestion: yes/no) ---------- */

function ConfirmView({ widget, runtime }: { widget: ConfirmWidget; runtime: WidgetRuntimeProps }) {
  const { done, expired, canAnswer } = useInteractive(runtime);
  const [submitting, setSubmitting] = useState(false);

  if (done && !runtime.answered?.expired) {
    return <AnsweredNote summary={answerSummary(widget, runtime.answered?.value)} />;
  }
  const expiredNow = (done && runtime.answered?.expired === true) || (canAnswer && expired);

  const answer = (confirmed: boolean) => {
    void postAnswer(runtime, { confirmed }, setSubmitting);
  };

  if (!canAnswer) {
    return <p className="widget-question">{widget.question}</p>;
  }
  return (
    <div className="widget-confirm">
      {expiredNow && <ExpiredNote />}
      <p className="widget-question">{widget.question}</p>
      {!expiredNow && (
        <div className="widget-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => answer(true)}
            disabled={submitting}
          >
            {submitting ? 'Sending…' : widget.confirmLabel ?? 'Confirm'}
          </button>
          <button type="button" className="btn" onClick={() => answer(false)} disabled={submitting}>
            {widget.cancelLabel ?? 'Cancel'}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- progress (display-only) ---------- */

function ProgressView({ widget }: { widget: ProgressWidget; runtime: WidgetRuntimeProps }) {
  const indeterminate = widget.indeterminate === true || widget.percent === undefined;
  return (
    <div className="widget-progress">
      {widget.label && <div className="small" style={{ fontWeight: 650 }}>{widget.label}</div>}
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(widget.percent ?? 0)}
        aria-label={widget.label ?? widget.title ?? 'Progress'}
      >
        <div
          className={`progress-bar${indeterminate ? ' indeterminate' : ''}`}
          style={indeterminate ? undefined : { width: `${widget.percent}%` }}
        />
      </div>
      {!indeterminate && <div className="small muted">{Math.round(widget.percent ?? 0)}%</div>}
    </div>
  );
}

/* ---------- image-view (display-only) ---------- */

function ImageViewView({ widget }: { widget: ImageViewWidget; runtime: WidgetRuntimeProps }) {
  const src = widget.url ?? widget.dataUrl;
  return (
    <div className="widget-imageview">
      {src ? (
        <img className="widget-image" src={src} alt={widget.alt ?? widget.caption ?? ''} />
      ) : (
        <div className="small muted">No image source provided.</div>
      )}
      {widget.caption && <div className="small muted">{widget.caption}</div>}
    </div>
  );
}

/* ---------- registry ---------- */

/** Kind → view component registry. Views receive the validated widget as `widget`. */
export const WIDGET_REGISTRY: Record<
  WidgetKind,
  (props: { widget: Widget; onAction?: WidgetActionHandler } & WidgetRuntimeProps) => React.ReactElement
> = {
  table: ({ widget }) => <TableView widget={widget as TableWidget} />,
  chart: ({ widget }) => <ChartView widget={widget as ChartWidget} />,
  actions: ({ widget, onAction }) => <ActionsView widget={widget as ActionsWidget} onAction={onAction} />,
  map: ({ widget }) => <MapView widget={widget as MapWidget} />,
  file: ({ widget }) => <FileView widget={widget as FileWidget} />,
  buttons: ({ widget, ...runtime }) => <ButtonsView widget={widget as ButtonsWidget} runtime={runtime} />,
  select: ({ widget, ...runtime }) => <SelectView widget={widget as SelectWidget} runtime={runtime} />,
  input: ({ widget, ...runtime }) => <InputView widget={widget as InputWidget} runtime={runtime} />,
  confirm: ({ widget, ...runtime }) => <ConfirmView widget={widget as ConfirmWidget} runtime={runtime} />,
  progress: ({ widget, ...runtime }) => <ProgressView widget={widget as ProgressWidget} runtime={runtime} />,
  'image-view': ({ widget, ...runtime }) => (
    <ImageViewView widget={widget as ImageViewWidget} runtime={runtime} />
  ),
};

/** All kinds the registry can render (should mirror schema's WIDGET_KINDS). */
export function registeredWidgetKinds(): WidgetKind[] {
  return [...WIDGET_KINDS].filter((k) => k in WIDGET_REGISTRY);
}

export function WidgetRenderer({
  widget,
  onAction,
  widgetId,
  expiresAt,
  interactive,
  answered,
  onAnswer,
}: {
  widget: Widget;
  onAction?: WidgetActionHandler;
} & WidgetRuntimeProps) {
  const View = WIDGET_REGISTRY[widget.kind];
  if (!View) return null;
  return (
    <div className="widget" data-widget-kind={widget.kind}>
      <div className="widget-head">
        <span className="widget-kind">{KIND_LABEL[widget.kind]}</span>
        {widget.title && <span className="truncate">{widget.title}</span>}
      </div>
      <div className="widget-body">
        <View
          widget={widget}
          onAction={onAction}
          widgetId={widgetId}
          expiresAt={expiresAt}
          interactive={interactive}
          answered={answered}
          onAnswer={onAnswer}
        />
      </div>
    </div>
  );
}
