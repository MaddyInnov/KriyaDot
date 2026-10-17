// SPDX-License-Identifier: Apache-2.0
// Interactive widgets + AskUserQuestion (OpenMausBot parity P1 #15).
//
// A widget is a structured UI card the server raises and the web client
// renders. Two flavors:
//
// - Interactive widgets (buttons / select / input / confirm): raised by the
//   `ask_user_question` tool, which pauses the turn until the human answers
//   (or the widget expires). The turn resumes with the answer.
// - Display widgets (progress / table / image-view): raised from a tool
//   result's `widget` attachment (see extractWidgetAttachment) and rendered
//   inline — they never pause the turn.
//
// Protocol (the web client implements the same shapes; keep field names
// identical):
//
//   StreamEvent { type: 'widget', widgetId, sessionId, widget, expiresAt,
//                 interactive }
//   StreamEvent { type: 'widget_answered', widgetId,
//                 answer: { answered, value?, expired?, answeredAt } }
//
// Widgets expire after WIDGET_TTL_MS (15 minutes): an unanswered widget
// auto-expires and the turn resumes with answered:false.

import { randomUUID } from 'node:crypto';

import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';

import type { StreamEvent } from './types.js';

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/** Widget kinds: interactive first, display-only last. */
export type WidgetKind =
  | 'buttons'
  | 'select'
  | 'input'
  | 'confirm'
  | 'progress'
  | 'table'
  | 'image-view';

export const WIDGET_KINDS: readonly WidgetKind[] = [
  'buttons',
  'select',
  'input',
  'confirm',
  'progress',
  'table',
  'image-view',
] as const;

export function isWidgetKind(v: unknown): v is WidgetKind {
  return typeof v === 'string' && (WIDGET_KINDS as readonly string[]).includes(v);
}

export interface WidgetOption {
  id: string;
  label: string;
  description?: string;
}

export interface ButtonsWidgetPayload {
  kind: 'buttons';
  title?: string;
  question?: string;
  options: WidgetOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}

export interface SelectWidgetPayload {
  kind: 'select';
  title?: string;
  label?: string;
  options: WidgetOption[];
  multiSelect?: boolean;
}

export interface InputWidgetPayload {
  kind: 'input';
  title?: string;
  label?: string;
  placeholder?: string;
  default?: string;
  multiline?: boolean;
}

export interface ConfirmWidgetPayload {
  kind: 'confirm';
  title?: string;
  question: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ProgressWidgetPayload {
  kind: 'progress';
  title?: string;
  label?: string;
  /** 0-100. */
  percent?: number;
  indeterminate?: boolean;
}

export interface TableWidgetPayload {
  kind: 'table';
  title?: string;
  columns: string[];
  rows: unknown[][];
}

export interface ImageViewWidgetPayload {
  kind: 'image-view';
  title?: string;
  caption?: string;
  alt?: string;
  url?: string;
  dataUrl?: string;
}

export type WidgetPayload =
  | ButtonsWidgetPayload
  | SelectWidgetPayload
  | InputWidgetPayload
  | ConfirmWidgetPayload
  | ProgressWidgetPayload
  | TableWidgetPayload
  | ImageViewWidgetPayload;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Payload caps (protocol limits the web client enforces identically). */
export const WIDGET_CAPS = {
  options: 20,
  id: 200,
  label: 200,
  description: 500,
  title: 500,
  question: 500,
  columns: 50,
  rows: 500,
  url: 2000,
  dataUrl: 2_000_000,
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function optStr(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (!str(v)) return undefined;
  return v.length > max ? undefined : v;
}

function reqStr(v: unknown, max: number, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (!str(v) || v.length === 0) return { ok: false, error: `${field} must be a non-empty string` };
  if (v.length > max) return { ok: false, error: `${field} exceeds ${max} characters` };
  return { ok: true, value: v };
}

function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

interface Validated<T> {
  ok: true;
  payload: T;
}
interface Invalid {
  ok: false;
  error: string;
}
type ValidationResult = Validated<WidgetPayload> | Invalid;

function invalid(error: string): Invalid {
  return { ok: false, error };
}

function validateOptions(raw: unknown): { ok: true; options: WidgetOption[] } | Invalid {
  if (!Array.isArray(raw)) return invalid('options must be an array');
  if (raw.length > WIDGET_CAPS.options) {
    return invalid(`options exceeds the cap of ${WIDGET_CAPS.options}`);
  }
  const options: WidgetOption[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i];
    if (!isRecord(o)) return invalid(`options[${i}] must be an object`);
    // ids are auto-generated (o1, o2, …) when the caller omits them.
    const id = o.id === undefined || o.id === null ? `o${i + 1}` : o.id;
    if (!str(id) || id.length === 0 || id.length > WIDGET_CAPS.id) {
      return invalid(`options[${i}].id must be a non-empty string of at most ${WIDGET_CAPS.id} characters`);
    }
    const label = reqStr(o.label, WIDGET_CAPS.label, `options[${i}].label`);
    if (!label.ok) return label;
    const description = o.description === undefined || o.description === null ? undefined : o.description;
    if (description !== undefined && (!str(description) || description.length > WIDGET_CAPS.description)) {
      return invalid(`options[${i}].description must be a string of at most ${WIDGET_CAPS.description} characters`);
    }
    options.push(description === undefined ? { id, label: label.value } : { id, label: label.value, description });
  }
  return { ok: true, options };
}

/**
 * Validate an unknown value against the widget protocol and strip unknown
 * fields. Returns the canonical payload on success.
 */
export function validateWidgetPayload(payload: unknown): ValidationResult {
  if (!isRecord(payload)) return invalid('widget payload must be an object');
  const kindRaw = payload.kind;
  if (!isWidgetKind(kindRaw)) {
    return invalid(`unknown widget kind ${JSON.stringify(kindRaw)} — expected one of ${WIDGET_KINDS.join('|')}`);
  }

  const title = optStr(payload.title, WIDGET_CAPS.title);
  if (payload.title !== undefined && title === undefined) {
    return invalid(`title must be a string of at most ${WIDGET_CAPS.title} characters`);
  }
  const base: { title?: string } = title === undefined ? {} : { title };

  switch (kindRaw) {
    case 'buttons': {
      const options = validateOptions(payload.options);
      if (!options.ok) return options;
      const question = optStr(payload.question, WIDGET_CAPS.question);
      if (payload.question !== undefined && question === undefined) {
        return invalid(`question must be a string of at most ${WIDGET_CAPS.question} characters`);
      }
      const out: ButtonsWidgetPayload = { kind: 'buttons', ...base, options: options.options };
      if (question !== undefined) out.question = question;
      const multiSelect = optBool(payload.multiSelect);
      if (multiSelect !== undefined) out.multiSelect = multiSelect;
      const allowFreeText = optBool(payload.allowFreeText);
      if (allowFreeText !== undefined) out.allowFreeText = allowFreeText;
      return { ok: true, payload: out };
    }
    case 'select': {
      const options = validateOptions(payload.options);
      if (!options.ok) return options;
      const label = optStr(payload.label, WIDGET_CAPS.label);
      if (payload.label !== undefined && label === undefined) {
        return invalid(`label must be a string of at most ${WIDGET_CAPS.label} characters`);
      }
      const out: SelectWidgetPayload = { kind: 'select', ...base, options: options.options };
      if (label !== undefined) out.label = label;
      const multiSelect = optBool(payload.multiSelect);
      if (multiSelect !== undefined) out.multiSelect = multiSelect;
      return { ok: true, payload: out };
    }
    case 'input': {
      const out: InputWidgetPayload = { kind: 'input', ...base };
      for (const f of ['label', 'placeholder', 'default'] as const) {
        const v = optStr(payload[f], WIDGET_CAPS.label);
        if (payload[f] !== undefined && v === undefined) {
          return invalid(`${f} must be a string of at most ${WIDGET_CAPS.label} characters`);
        }
        if (v !== undefined) out[f] = v;
      }
      const multiline = optBool(payload.multiline);
      if (multiline !== undefined) out.multiline = multiline;
      return { ok: true, payload: out };
    }
    case 'confirm': {
      const question = reqStr(payload.question, WIDGET_CAPS.question, 'question');
      if (!question.ok) return question;
      const out: ConfirmWidgetPayload = { kind: 'confirm', ...base, question: question.value };
      for (const f of ['confirmLabel', 'cancelLabel'] as const) {
        const v = optStr(payload[f], WIDGET_CAPS.label);
        if (payload[f] !== undefined && v === undefined) {
          return invalid(`${f} must be a string of at most ${WIDGET_CAPS.label} characters`);
        }
        if (v !== undefined) out[f] = v;
      }
      return { ok: true, payload: out };
    }
    case 'progress': {
      const out: ProgressWidgetPayload = { kind: 'progress', ...base };
      const label = optStr(payload.label, WIDGET_CAPS.label);
      if (payload.label !== undefined && label === undefined) {
        return invalid(`label must be a string of at most ${WIDGET_CAPS.label} characters`);
      }
      if (label !== undefined) out.label = label;
      if (payload.percent !== undefined) {
        if (typeof payload.percent !== 'number' || !Number.isFinite(payload.percent) || payload.percent < 0 || payload.percent > 100) {
          return invalid('percent must be a number between 0 and 100');
        }
        out.percent = payload.percent;
      }
      const indeterminate = optBool(payload.indeterminate);
      if (indeterminate !== undefined) out.indeterminate = indeterminate;
      return { ok: true, payload: out };
    }
    case 'table': {
      const rawColumns = payload.columns;
      if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
        return invalid('columns must be a non-empty array of strings');
      }
      if (rawColumns.length > WIDGET_CAPS.columns) {
        return invalid(`columns exceeds the cap of ${WIDGET_CAPS.columns}`);
      }
      const columns: string[] = [];
      for (let i = 0; i < rawColumns.length; i++) {
        if (!str(rawColumns[i])) return invalid(`columns[${i}] must be a string`);
        columns.push(rawColumns[i] as string);
      }
      const rawRows = payload.rows === undefined || payload.rows === null ? [] : payload.rows;
      if (!Array.isArray(rawRows)) return invalid('rows must be an array of arrays');
      if (rawRows.length > WIDGET_CAPS.rows) {
        return invalid(`rows exceeds the cap of ${WIDGET_CAPS.rows}`);
      }
      const rows: unknown[][] = [];
      for (let i = 0; i < rawRows.length; i++) {
        if (!Array.isArray(rawRows[i])) return invalid(`rows[${i}] must be an array`);
        rows.push(rawRows[i] as unknown[]);
      }
      return { ok: true, payload: { kind: 'table', ...base, columns, rows } };
    }
    case 'image-view': {
      const out: ImageViewWidgetPayload = { kind: 'image-view', ...base };
      for (const f of ['caption', 'alt'] as const) {
        const v = optStr(payload[f], WIDGET_CAPS.label);
        if (payload[f] !== undefined && v === undefined) {
          return invalid(`${f} must be a string of at most ${WIDGET_CAPS.label} characters`);
        }
        if (v !== undefined) out[f] = v;
      }
      const url = optStr(payload.url, WIDGET_CAPS.url);
      if (payload.url !== undefined && url === undefined) {
        return invalid(`url must be a string of at most ${WIDGET_CAPS.url} characters`);
      }
      if (url !== undefined) out.url = url;
      const dataUrl = optStr(payload.dataUrl, WIDGET_CAPS.dataUrl);
      if (payload.dataUrl !== undefined && dataUrl === undefined) {
        return invalid(`dataUrl must be a string of at most ${WIDGET_CAPS.dataUrl} characters`);
      }
      if (dataUrl !== undefined) out.dataUrl = dataUrl;
      return { ok: true, payload: out };
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a widget id does not exist. Maps to HTTP 404. */
export class WidgetNotFoundError extends Error {
  constructor(id: string) {
    super(`widget not found: ${id}`);
    this.name = 'WidgetNotFoundError';
  }
}

/** Thrown when answering a widget that is no longer pending. Maps to HTTP 409. */
export class WidgetNotPendingError extends Error {
  readonly status: WidgetStatus;
  constructor(id: string, status: WidgetStatus) {
    super(`widget ${id} is ${status}, not pending`);
    this.name = 'WidgetNotPendingError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type WidgetStatus = 'pending' | 'answered' | 'expired';

export interface WidgetRecord {
  id: string;
  sessionId: string;
  botId: string;
  kind: WidgetKind;
  payload: WidgetPayload;
  title?: string;
  interactive: boolean;
  status: WidgetStatus;
  createdAt: number;
  expiresAt: number;
  /** Parsed answer value (only when status === 'answered'). */
  value?: unknown;
  answeredAt?: number;
}

export interface RaiseWidgetInput {
  sessionId: string;
  botId: string;
  kind: WidgetKind;
  payload: WidgetPayload;
  title?: string;
  interactive: boolean;
  ttlMs?: number;
}

/** Default widget time-to-live: 15 minutes (OpenMausBot parity). */
export const WIDGET_TTL_MS = 15 * 60 * 1000;

interface WidgetRow {
  id: string;
  session_id: string;
  bot_id: string;
  kind: string;
  payload_json: string;
  title: string | null;
  interactive: number;
  status: string;
  created_at: number;
  expires_at: number;
  answer_json: string | null;
  answered_at: number | null;
}

function parseStoredPayload(json: string): WidgetPayload {
  // Stored payloads were validated on raise; re-validate defensively so a
  // hand-edited DB row can never crash the reader.
  const parsed: unknown = JSON.parse(json);
  const v = validateWidgetPayload(parsed);
  if (!v.ok) throw new Error(`stored widget payload is invalid: ${v.error}`);
  return v.payload;
}

function rowToRecord(r: WidgetRow): WidgetRecord {
  let value: unknown;
  if (r.answer_json !== null) {
    try {
      value = JSON.parse(r.answer_json);
    } catch {
      value = undefined;
    }
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    botId: r.bot_id,
    kind: r.kind as WidgetKind,
    payload: parseStoredPayload(r.payload_json),
    title: r.title ?? undefined,
    interactive: r.interactive === 1,
    status: r.status as WidgetStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    value,
    answeredAt: r.answered_at ?? undefined,
  };
}

function isWidgetStatus(v: unknown): v is WidgetStatus {
  return v === 'pending' || v === 'answered' || v === 'expired';
}

/**
 * SQLite-backed store for interactive widgets. Records live in
 * `widgets.db` under the data dir.
 */
export class WidgetStore {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;

  constructor(dataDir: string, opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? WIDGET_TTL_MS;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'widgets.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        title TEXT,
        interactive INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        answer_json TEXT,
        answered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_widgets_session ON widgets (session_id, status);
      CREATE INDEX IF NOT EXISTS idx_widgets_status ON widgets (status, expires_at);
    `);
  }

  /** Widget TTL in ms (for the coordinator's await timeout). */
  get widgetTtlMs(): number {
    return this.ttlMs;
  }

  raise(input: RaiseWidgetInput): WidgetRecord {
    const v = validateWidgetPayload({ ...input.payload, kind: input.kind });
    if (!v.ok) throw new Error(`invalid widget payload: ${v.error}`);
    const now = Date.now();
    const record: WidgetRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      botId: input.botId,
      kind: input.kind,
      payload: v.payload,
      title: input.title,
      interactive: input.interactive,
      status: 'pending',
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? this.ttlMs),
    };
    this.db
      .prepare(
        `INSERT INTO widgets
           (id, session_id, bot_id, kind, payload_json, title, interactive,
            status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.botId,
        record.kind,
        JSON.stringify(record.payload),
        record.title ?? null,
        record.interactive ? 1 : 0,
        record.status,
        record.createdAt,
        record.expiresAt,
      );
    return record;
  }

  get(id: string): WidgetRecord | undefined {
    const row = this.db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as unknown as
      | WidgetRow
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(sessionId?: string, status?: WidgetStatus): WidgetRecord[] {
    let rows: unknown[];
    if (sessionId && status) {
      rows = this.db
        .prepare('SELECT * FROM widgets WHERE session_id = ? AND status = ? ORDER BY created_at DESC')
        .all(sessionId, status);
    } else if (sessionId) {
      rows = this.db
        .prepare('SELECT * FROM widgets WHERE session_id = ? ORDER BY created_at DESC')
        .all(sessionId);
    } else if (status) {
      rows = this.db
        .prepare('SELECT * FROM widgets WHERE status = ? ORDER BY created_at DESC')
        .all(status);
    } else {
      rows = this.db.prepare('SELECT * FROM widgets ORDER BY created_at DESC').all();
    }
    return (rows as WidgetRow[]).map(rowToRecord);
  }

  /**
   * Record an answer for a pending widget. Throws WidgetNotFoundError when
   * the widget does not exist and WidgetNotPendingError when it is no
   * longer pending.
   */
  answer(id: string, value: unknown): WidgetRecord {
    const record = this.get(id);
    if (!record) throw new WidgetNotFoundError(id);
    if (record.status !== 'pending') throw new WidgetNotPendingError(id, record.status);
    const now = Date.now();
    let answerJson: string | null = null;
    if (value !== undefined) {
      try {
        answerJson = JSON.stringify(value) ?? null;
      } catch {
        answerJson = null;
      }
    }
    this.db
      .prepare("UPDATE widgets SET status = 'answered', answer_json = ?, answered_at = ? WHERE id = ?")
      .run(answerJson, now, id);
    const updated = this.get(id);
    if (!updated) throw new WidgetNotFoundError(id);
    return updated;
  }

  /**
   * Mark pending widgets past their expiry as 'expired'. Returns the ids
   * that transitioned (so the host can settle in-flight waiters).
   */
  expireStale(now = Date.now()): string[] {
    const rows = this.db
      .prepare("SELECT id FROM widgets WHERE status = 'pending' AND expires_at <= ?")
      .all(now) as unknown as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const stmt = this.db.prepare(
      "UPDATE widgets SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'",
    );
    const expired: string[] = [];
    for (const r of rows) {
      const res = stmt.run(now, r.id);
      if (res.changes > 0) expired.push(r.id);
    }
    return expired;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/** The human's answer to an interactive widget. */
export interface WidgetAnswer {
  answered: boolean;
  value?: unknown;
  expired?: boolean;
  answeredAt?: number;
}

export interface WidgetAnswerInput {
  answered: boolean;
  value?: unknown;
  expired?: boolean;
}

export interface WidgetCoordinatorOpts {
  /** Optional audit sink for raise/answer/expire events. */
  audit?: (type: string, detail: Record<string, unknown>) => void;
}

interface Waiter {
  resolve: (a: WidgetAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Host-side coordinator: raises widgets in the store, holds in-flight
 * awaitAnswer waiters, and fails them closed on expiry or abort.
 */
export class WidgetCoordinator {
  private readonly store: WidgetStore;
  private readonly audit?: (type: string, detail: Record<string, unknown>) => void;
  private readonly waiters = new Map<string, Waiter>();

  constructor(store: WidgetStore, opts: WidgetCoordinatorOpts = {}) {
    this.store = store;
    this.audit = opts.audit;
  }

  /** The underlying store (for HTTP routes). */
  get widgetStore(): WidgetStore {
    return this.store;
  }

  async raise(input: RaiseWidgetInput): Promise<WidgetRecord> {
    const record = this.store.raise(input);
    try {
      this.audit?.('widget.raised', {
        widgetId: record.id,
        sessionId: record.sessionId,
        botId: record.botId,
        kind: record.kind,
        interactive: record.interactive,
      });
    } catch {
      // Audit must never break widget minting.
    }
    return record;
  }

  /**
   * Wait for a human answer. Resolves {answered:true, value} when the
   * widget is answered, {answered:false, expired:true} on expiry, and
   * REJECTS when the signal aborts (the caller fails closed). The wait is
   * capped at the widget's own expiry — never waits past it.
   */
  async awaitAnswer(widgetId: string, timeoutMs: number, signal?: AbortSignal): Promise<WidgetAnswer> {
    const record = this.store.get(widgetId);
    if (!record) throw new WidgetNotFoundError(widgetId);
    if (record.status === 'answered') {
      return { answered: true, value: record.value, answeredAt: record.answeredAt };
    }
    if (record.status !== 'pending') {
      return { answered: false, expired: record.status === 'expired', answeredAt: record.answeredAt };
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    // Never wait past the widget's own expiry.
    const remaining = Math.min(Math.max(timeoutMs, 1), Math.max(record.expiresAt - Date.now(), 1));
    return new Promise<WidgetAnswer>((resolve, reject) => {
      const cleanup = (): void => {
        const w = this.waiters.get(widgetId);
        if (w) {
          clearTimeout(w.timer);
          if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
          this.waiters.delete(widgetId);
        }
      };
      const timer = setTimeout(() => {
        // Re-check: the HTTP answer path may have landed just before the
        // timer fired (settle clears the timer, but be defensive).
        const current = this.store.get(widgetId);
        cleanup();
        if (current?.status === 'answered') {
          resolve({ answered: true, value: current.value, answeredAt: current.answeredAt });
          return;
        }
        if (current && current.status !== 'pending') {
          resolve({ answered: false, expired: current.status === 'expired', answeredAt: current.answeredAt });
          return;
        }
        // Fail closed: mark expired (only if still pending) and audit.
        const stillPending = current?.status === 'pending';
        const expiredIds = stillPending ? this.store.expireStale() : [];
        if (expiredIds.includes(widgetId) || stillPending) {
          try {
            this.audit?.('widget.expired', {
              widgetId,
              sessionId: current?.sessionId,
              botId: current?.botId,
              kind: current?.kind,
            });
          } catch {
            // Audit must never break the wait.
          }
        }
        resolve({ answered: false, expired: true, answeredAt: Date.now() });
      }, remaining);
      if (typeof timer.unref === 'function') timer.unref();
      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(widgetId, { resolve: (a) => { cleanup(); resolve(a); }, timer, signal, onAbort });
    });
  }

  /**
   * Persist an answer and resolve the in-flight waiter (HTTP answer path).
   * Throws WidgetNotFoundError / WidgetNotPendingError.
   */
  settle(widgetId: string, input: WidgetAnswerInput): WidgetRecord {
    const record = this.store.answer(widgetId, input.value);
    const waiter = this.waiters.get(widgetId);
    if (waiter) {
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.waiters.delete(widgetId);
      waiter.resolve({
        answered: input.answered,
        value: input.value,
        expired: input.expired,
        answeredAt: record.answeredAt,
      });
    }
    try {
      this.audit?.('widget.answered', {
        widgetId: record.id,
        sessionId: record.sessionId,
        botId: record.botId,
        kind: record.kind,
        answered: input.answered,
      });
    } catch {
      // Audit must never break the answer path.
    }
    return record;
  }

  /**
   * Backstop sweep: expire stale widgets and fail their in-flight waiters
   * closed with {answered:false, expired:true}. Returns the transitioned
   * ids (for the host's audit trail).
   */
  sweepExpired(now = Date.now()): string[] {
    const expired = this.store.expireStale(now);
    for (const id of expired) {
      const waiter = this.waiters.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
        this.waiters.delete(id);
        waiter.resolve({ answered: false, expired: true, answeredAt: now });
      }
    }
    return expired;
  }
}

// ---------------------------------------------------------------------------
// WidgetHost (per-turn, built by the runtime)
// ---------------------------------------------------------------------------

export interface WidgetRaiseInput {
  kind: WidgetKind;
  payload: WidgetPayload;
  title?: string;
  interactive: boolean;
  ttlMs?: number;
}

/**
 * Per-turn widget host handed to tools via ToolContext.widget. The runtime
 * wires sessionId/botId into raise and the turn's AbortSignal into
 * awaitAnswer.
 */
export interface WidgetHost {
  raise(input: WidgetRaiseInput): Promise<WidgetRecord>;
  emit(e: StreamEvent): void | Promise<void>;
  awaitAnswer(widgetId: string, timeoutMs: number): Promise<WidgetAnswer>;
}

// ---------------------------------------------------------------------------
// Tool-result attachments
// ---------------------------------------------------------------------------

/**
 * Extract a display widget from a tool result. When a tool returns an
 * object with a `widget` key that validates against the widget protocol,
 * the validated payload is returned so the runtime can raise it as a
 * non-interactive widget inline with the tool result. Anything else →
 * undefined (never throws).
 */
export function extractWidgetAttachment(result: unknown): WidgetPayload | undefined {
  if (!isRecord(result)) return undefined;
  const raw = result.widget;
  if (raw === undefined) return undefined;
  const v = validateWidgetPayload(raw);
  return v.ok ? v.payload : undefined;
}

export { isWidgetStatus };
