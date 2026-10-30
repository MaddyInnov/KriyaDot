// SPDX-License-Identifier: Apache-2.0
//
// W13 observability: persisted span/trace store + loop detection.
//
// Every agent run is recorded as a tree of spans:
//   session > turn > (llm | tool)*
// stored in SQLite (<dataDir>/spans.db by default) using the platform's
// shared openDb() patterns. The runtime auto-instruments the provider-call
// choke point (every LLM call) and the tool-execution choke point (every
// executed tool call) — features never log spans by hand.
//
// SECRETS: span payloads (prompts, completions, tool inputs/outputs) pass
// through BOTH existing redaction layers before they are written:
//   1. @mvp/governance redactSecrets — key-based redaction for structured
//      payloads (any value under an api-key/token/password/… key).
//   2. agent-import's redactSecrets — pattern-based redaction applied to
//      every string leaf (sk-…, Bearer …, key=value secrets embedded in
//      free-text prompts).
// Payloads are also size-capped (default 8192 chars, override with
// KRIYADOT_SPAN_PAYLOAD_MAX_CHARS); overflow is replaced with an explicit
// truncation marker so a stored payload never silently pretends to be
// complete.
//
// Loop detection threshold: default 3 near-identical repetitions, override
// with KRIYADOT_LOOP_THRESHOLD (integer >= 2).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { redactSecrets as redactStructured } from '@mvp/governance';
import { redactSecrets as redactText } from './agent-import.js';
import { openDb } from './sqlite.js';
import type { AttemptRecord } from './execution-policy.js';

export type { AttemptRecord } from './execution-policy.js';

export type SpanKind = 'session' | 'bot' | 'goal' | 'routine' | 'turn' | 'llm' | 'tool';
export type SpanStatus = 'running' | 'ok' | 'error';
/** Final outcome of a run/session (W13d). */
export type RunOutcome = 'success' | 'failed' | 'cancelled' | 'needs-input';

export interface Span {
  id: string;
  runId: string;
  sessionId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: SpanStatus;
  botId: string;
  /** USD cents attributed to this span (LLM token cost, or a paid tool's cost). */
  costCents?: number;
  /**
   * Redacted, size-capped payload. Parsed JSON when the stored form is
   * intact JSON; a string when truncation broke the JSON framing (the
   * truncation marker is part of the string).
   */
  payload?: unknown;
  error?: string;
}

export interface RunRecord {
  runId: string;
  sessionId: string;
  botId: string;
  kind: SpanKind;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  loopDetected: boolean;
  loopEvidence: LoopEvidence[];
  tags: string[];
  /**
   * ADD-4 execution-policy attempt trail, when the turn ran under the
   * policy and recorded attempts. The API work-panel projection surfaces
   * this array verbatim as the run's `attempts`. Absent when empty.
   */
  attempts?: AttemptRecord[];
}

export interface RunTotals {
  runId: string;
  spanCount: number;
  llmCostCents: number;
  toolCostCents: number;
  totalCostCents: number;
  errorCount: number;
  durationMs: number | null;
}

export interface BotOutcomeStats {
  botId: string;
  total: number;
  running: number;
  success: number;
  failed: number;
  cancelled: number;
  needsInput: number;
  /** success / finalized runs, 0..1 (0 when nothing has finalized). */
  successRate: number;
}

export interface LoopEvidence {
  kind: 'tool' | 'text';
  /** Tool name (kind 'tool') or 'assistant-text' (kind 'text'). */
  key: string;
  /** Number of near-identical repetitions in the cluster. */
  count: number;
  spanIds: string[];
}

// ---------------------------------------------------------------------------
// Payload sanitization (redaction + size cap)
// ---------------------------------------------------------------------------

export const SPAN_PAYLOAD_MAX_CHARS_DEFAULT = 8192;
const ERROR_MAX_CHARS = 2000;

export function spanPayloadMaxChars(): number {
  const raw = Number(process.env.KRIYADOT_SPAN_PAYLOAD_MAX_CHARS);
  return Number.isFinite(raw) && raw >= 256 ? Math.floor(raw) : SPAN_PAYLOAD_MAX_CHARS_DEFAULT;
}

/**
 * Redact + cap a payload for storage. Returns the stored JSON text (or
 * undefined when there is no payload). Never throws: on any failure the
 * payload degrades to a redaction-failure placeholder rather than leaking.
 */
/**
 * JSON-string form of a secret assignment: `"apiKey": "value"`. Tool
 * results ride into later prompts as JSON *strings*, where the key-based
 * walker cannot see the keys and the key=value text pattern cannot match
 * the quoted-colon form — this bridges that one gap, using the same key
 * family as the governance SECRET_KEY_RE.
 */
const JSON_KEY_SECRET_RE =
  /("(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|credential|private[_-]?key)"\s*:\s*)"[^"]*"/gi;

/** Recursively apply the pattern-based text redactor to every string leaf. */
function redactStringLeaves(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return redactText(value).replace(JSON_KEY_SECRET_RE, '$1"[REDACTED]"');
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactStringLeaves(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = redactStringLeaves(entry, seen);
  return out;
}

export function sanitizeSpanPayload(
  value: unknown,
  maxChars: number = spanPayloadMaxChars(),
): string | undefined {
  if (value === undefined) return undefined;
  try {
    // Normalize through a JSON round-trip first when possible: it breaks
    // shared object references (a tool result echoing its args object)
    // into independent copies, so the key-based walker's cycle guard does
    // not mislabel them '[CIRCULAR]'. True cycles throw here and fall
    // through with the raw value, which the walker guards correctly.
    let normalized: unknown = value;
    try {
      normalized = JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      // keep raw value
    }
    // Layer 1: key-based structural redaction (governance machinery).
    const structured = redactStructured(normalized);
    // Layer 2: pattern-based text redaction (agent-import machinery),
    // applied per string leaf BEFORE serialization. Running it over the
    // serialized JSON instead would let its `key=value` pattern's \S+
    // value run across JSON punctuation and swallow neighbouring fields.
    const walked = redactStringLeaves(structured);
    let json: string;
    try {
      json = JSON.stringify(walked) ?? 'null';
    } catch {
      json = JSON.stringify(String(walked));
    }
    if (json.length > maxChars) {
      const dropped = json.length - maxChars;
      json = `${json.slice(0, maxChars)}…[TRUNCATED ${dropped} chars]`;
    }
    return json;
  } catch {
    return '"[REDACTED: redaction failed]"';
  }
}

/** Redact + cap a free-text field (span name / error). Never throws. */
export function sanitizeSpanText(text: string, maxChars: number = ERROR_MAX_CHARS): string {
  try {
    const out = redactText(text);
    return out.length > maxChars ? `${out.slice(0, maxChars)}…[TRUNCATED ${out.length - maxChars} chars]` : out;
  } catch {
    return '[REDACTED: redaction failed]';
  }
}

function parseStoredPayload(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    // Truncation can break JSON framing; surface the stored text as-is.
    return json;
  }
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

export const LOOP_THRESHOLD_DEFAULT = 3;

/** Configured loop threshold: KRIYADOT_LOOP_THRESHOLD (int >= 2), default 3. */
export function resolveLoopThreshold(): number {
  const raw = Number(process.env.KRIYADOT_LOOP_THRESHOLD);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : LOOP_THRESHOLD_DEFAULT;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Stable stringify with sorted object keys (arg comparison). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9_]+/i).filter(Boolean));
}

/** Jaccard similarity of two token sets; 1 when both are empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const NEAR_IDENTICAL_SIMILARITY = 0.9;

function payloadInput(span: Span): unknown {
  const p = span.payload;
  if (p !== null && typeof p === 'object') return (p as { input?: unknown }).input;
  return undefined;
}

function payloadOutputText(span: Span): string | undefined {
  const p = span.payload;
  if (p !== null && typeof p === 'object') {
    const out = (p as { output?: unknown }).output;
    if (out !== null && typeof out === 'object') {
      const content = (out as { content?: unknown }).content;
      if (typeof content === 'string' && content.trim()) return content;
    }
    if (typeof out === 'string' && out.trim()) return out;
  }
  return undefined;
}

/**
 * Detect repeated near-identical behaviour in a run's span stream:
 * - tool spans: same tool whose args are near-identical (token-Jaccard
 *   >= 0.9 over the stable-stringified args) to a cluster representative;
 * - llm spans: identical normalized assistant text segments.
 * A cluster at or above `threshold` repetitions is reported as evidence.
 * Pure function — no I/O.
 */
export function detectLoops(spans: Span[], threshold: number = resolveLoopThreshold()): LoopEvidence[] {
  const evidence: LoopEvidence[] = [];
  const min = Math.max(2, threshold);

  // Tool-call clusters, grouped by tool name.
  const toolSpans = spans.filter((s) => s.kind === 'tool');
  const byTool = new Map<string, Span[]>();
  for (const s of toolSpans) {
    const list = byTool.get(s.name) ?? [];
    list.push(s);
    byTool.set(s.name, list);
  }
  for (const [name, list] of byTool) {
    if (list.length < min) continue;
    const clusters: Array<{ rep: Set<string>; spanIds: string[] }> = [];
    for (const span of list) {
      const tokens = tokenSet(normalizeText(stableStringify(payloadInput(span) ?? {})));
      const hit = clusters.find((c) => jaccard(c.rep, tokens) >= NEAR_IDENTICAL_SIMILARITY);
      if (hit) hit.spanIds.push(span.id);
      else clusters.push({ rep: tokens, spanIds: [span.id] });
    }
    for (const c of clusters) {
      if (c.spanIds.length >= min) {
        evidence.push({ kind: 'tool', key: name, count: c.spanIds.length, spanIds: c.spanIds });
      }
    }
  }

  // Repeated identical assistant text (llm span outputs).
  const textCounts = new Map<string, string[]>();
  for (const span of spans) {
    if (span.kind !== 'llm') continue;
    const text = payloadOutputText(span);
    if (!text) continue;
    const key = normalizeText(text);
    const list = textCounts.get(key) ?? [];
    list.push(span.id);
    textCounts.set(key, list);
  }
  for (const [, spanIds] of textCounts) {
    if (spanIds.length >= min) {
      evidence.push({ kind: 'text', key: 'assistant-text', count: spanIds.length, spanIds });
    }
  }
  return evidence;
}

/**
 * Map a turn's terminal condition to a run outcome (W13d):
 * waiting on a human (approval/question) at end → 'needs-input';
 * user stop / abort → 'cancelled'; error → 'failed'; normal end → 'success'.
 */
export function mapTurnOutcome(input: {
  errored?: boolean;
  aborted?: boolean;
  waitingForInput?: boolean;
}): RunOutcome {
  if (input.waitingForInput) return 'needs-input';
  if (input.aborted) return 'cancelled';
  if (input.errored) return 'failed';
  return 'success';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SpanRow {
  id: string;
  run_id: string;
  session_id: string;
  parent_span_id: string | null;
  kind: string;
  name: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  bot_id: string;
  cost_cents: number | null;
  payload_json: string | null;
  error: string | null;
}

interface RunRow {
  run_id: string;
  session_id: string;
  bot_id: string;
  kind: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  loop_detected: number;
  loop_evidence_json: string | null;
  attempts_json: string | null;
}

function toSpan(row: SpanRow): Span {
  const span: Span = {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    parentSpanId: row.parent_span_id,
    kind: row.kind as SpanKind,
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    status: row.status as SpanStatus,
    botId: row.bot_id,
  };
  if (row.cost_cents !== null) span.costCents = row.cost_cents;
  const payload = parseStoredPayload(row.payload_json);
  if (payload !== undefined) span.payload = payload;
  if (row.error !== null) span.error = row.error;
  return span;
}

export interface StartSpanInput {
  runId: string;
  sessionId: string;
  parentSpanId?: string | null;
  kind: SpanKind;
  name: string;
  botId: string;
  payload?: unknown;
  costCents?: number;
  startedAt?: number;
}

export interface EndSpanPatch {
  status: SpanStatus;
  payload?: unknown;
  error?: string;
  costCents?: number;
  endedAt?: number;
}

export class SpanStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS span_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'session',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        loop_detected INTEGER NOT NULL DEFAULT 0,
        loop_evidence_json TEXT
      );
      CREATE TABLE IF NOT EXISTS spans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_span_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        cost_cents REAL,
        payload_json TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS run_tags (
        run_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (run_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_spans_run ON spans(run_id, started_at, id);
      CREATE INDEX IF NOT EXISTS idx_span_runs_bot ON span_runs(bot_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_tags_tag ON run_tags(tag);
    `);
    // ADD-4: attempt-trail column for databases created before it existed.
    const runCols = this.db.prepare('PRAGMA table_info(span_runs)').all() as unknown as Array<{
      name: string;
    }>;
    if (!runCols.some((c) => c.name === 'attempts_json')) {
      this.db.exec('ALTER TABLE span_runs ADD COLUMN attempts_json TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  // -- runs -----------------------------------------------------------------

  createRun(input: { sessionId: string; botId: string; kind?: SpanKind; startedAt?: number }): RunRecord {
    const runId = `run_${randomUUID()}`;
    const startedAt = input.startedAt ?? Date.now();
    this.db
      .prepare(
        'INSERT INTO span_runs (run_id, session_id, bot_id, kind, started_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, input.sessionId, input.botId, input.kind ?? 'session', startedAt);
    return {
      runId,
      sessionId: input.sessionId,
      botId: input.botId,
      kind: input.kind ?? 'session',
      startedAt,
      endedAt: null,
      outcome: null,
      loopDetected: false,
      loopEvidence: [],
      tags: [],
    };
  }

  finalizeRun(runId: string, outcome: RunOutcome, endedAt: number = Date.now()): void {
    this.db
      .prepare('UPDATE span_runs SET outcome = ?, ended_at = ? WHERE run_id = ?')
      .run(outcome, endedAt, runId);
  }

  flagLoop(runId: string, evidence: LoopEvidence[]): void {
    this.db
      .prepare('UPDATE span_runs SET loop_detected = ?, loop_evidence_json = ? WHERE run_id = ?')
      .run(evidence.length > 0 ? 1 : 0, evidence.length > 0 ? JSON.stringify(evidence) : null, runId);
  }

  private toRun(row: RunRow): RunRecord {
    let loopEvidence: LoopEvidence[] = [];
    if (row.loop_evidence_json) {
      try {
        loopEvidence = JSON.parse(row.loop_evidence_json) as LoopEvidence[];
      } catch {
        loopEvidence = [];
      }
    }
    let attempts: AttemptRecord[] | undefined;
    if (row.attempts_json) {
      try {
        const parsed = JSON.parse(row.attempts_json) as AttemptRecord[];
        if (Array.isArray(parsed) && parsed.length > 0) attempts = parsed;
      } catch {
        attempts = undefined;
      }
    }
    const record: RunRecord = {
      runId: row.run_id,
      sessionId: row.session_id,
      botId: row.bot_id,
      kind: row.kind as SpanKind,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outcome: (row.outcome as RunOutcome | null) ?? null,
      loopDetected: row.loop_detected === 1,
      loopEvidence,
      tags: this.listTags(row.run_id),
    };
    if (attempts) record.attempts = attempts;
    return record;
  }

  /**
   * ADD-4: persist the execution-policy attempt trail on the run record.
   * The payload passes through the same redaction + size cap as span
   * payloads (failure strings are tool-error text and can embed secrets).
   * Unknown run ids are a no-op — instrumentation never breaks a caller.
   */
  setRunAttempts(runId: string, attempts: AttemptRecord[]): void {
    if (!this.getRun(runId)) return;
    const json = attempts.length > 0 ? (sanitizeSpanPayload(attempts) ?? null) : null;
    this.db.prepare('UPDATE span_runs SET attempts_json = ? WHERE run_id = ?').run(json, runId);
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM span_runs WHERE run_id = ?').get(runId) as unknown as
      | RunRow
      | undefined;
    return row ? this.toRun(row) : undefined;
  }

  /** Newest first. Filters compose (bot AND outcome AND tag). */
  listRuns(
    filter: { botId?: string; outcome?: RunOutcome; tag?: string; limit?: number } = {},
  ): RunRecord[] {
    const conds: string[] = [];
    const args: Array<string | number> = [];
    if (filter.botId) {
      conds.push('r.bot_id = ?');
      args.push(filter.botId);
    }
    if (filter.outcome) {
      conds.push('r.outcome = ?');
      args.push(filter.outcome);
    }
    if (filter.tag) {
      conds.push('EXISTS (SELECT 1 FROM run_tags t WHERE t.run_id = r.run_id AND t.tag = ?)');
      args.push(filter.tag);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    const rows = this.db
      .prepare(`SELECT r.* FROM span_runs r ${where} ORDER BY r.started_at DESC, r.run_id DESC LIMIT ?`)
      .all(...args, limit) as unknown as RunRow[];
    return rows.map((r) => this.toRun(r));
  }

  /** Per-bot outcome aggregation for success-rate analytics (W13d). */
  outcomesByBot(): BotOutcomeStats[] {
    const rows = this.db
      .prepare(
        `SELECT bot_id,
                COUNT(*) AS total,
                SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS running,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN outcome = 'needs-input' THEN 1 ELSE 0 END) AS needs_input
         FROM span_runs GROUP BY bot_id ORDER BY bot_id ASC`,
      )
      .all() as unknown as Array<{
      bot_id: string;
      total: number;
      running: number;
      success: number;
      failed: number;
      cancelled: number;
      needs_input: number;
    }>;
    return rows.map((r) => {
      const finalized = r.success + r.failed + r.cancelled + r.needs_input;
      return {
        botId: r.bot_id,
        total: r.total,
        running: r.running,
        success: r.success,
        failed: r.failed,
        cancelled: r.cancelled,
        needsInput: r.needs_input,
        successRate: finalized > 0 ? r.success / finalized : 0,
      };
    });
  }

  // -- tags -----------------------------------------------------------------

  listTags(runId: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM run_tags WHERE run_id = ? ORDER BY tag ASC')
      .all(runId) as unknown as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  /** Add a tag (normalized: trimmed, max 64 chars). Returns the run's tags. */
  addTag(runId: string, tag: string): string[] {
    const clean = tag.trim().slice(0, 64);
    if (!clean) throw new Error('tag must not be empty');
    if (!this.getRun(runId)) throw new Error(`Unknown run "${runId}"`);
    this.db.prepare('INSERT OR IGNORE INTO run_tags (run_id, tag) VALUES (?, ?)').run(runId, clean);
    return this.listTags(runId);
  }

  removeTag(runId: string, tag: string): string[] {
    this.db.prepare('DELETE FROM run_tags WHERE run_id = ? AND tag = ?').run(runId, tag.trim());
    return this.listTags(runId);
  }

  // -- spans ----------------------------------------------------------------

  startSpan(input: StartSpanInput): Span {
    const id = `span_${randomUUID()}`;
    const startedAt = input.startedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO spans (id, run_id, session_id, parent_span_id, kind, name, started_at, status, bot_id, cost_cents, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.sessionId,
        input.parentSpanId ?? null,
        input.kind,
        sanitizeSpanText(input.name, 512),
        startedAt,
        input.botId,
        input.costCents ?? null,
        sanitizeSpanPayload(input.payload) ?? null,
      );
    return this.getSpan(id) as Span;
  }

  /**
   * End a span. `payload` shallow-merges over the start payload (so a span
   * can record its input at start and its output at end). Unknown ids are
   * a no-op — instrumentation must never break the caller.
   */
  endSpan(id: string, patch: EndSpanPatch): Span | undefined {
    const existing = this.getSpan(id);
    if (!existing) return undefined;
    const endedAt = patch.endedAt ?? Date.now();
    let payloadJson: string | null = null;
    if (patch.payload !== undefined) {
      const merged =
        existing.payload !== null &&
        typeof existing.payload === 'object' &&
        patch.payload !== null &&
        typeof patch.payload === 'object' &&
        !Array.isArray(existing.payload) &&
        !Array.isArray(patch.payload)
          ? { ...(existing.payload as Record<string, unknown>), ...(patch.payload as Record<string, unknown>) }
          : patch.payload;
      payloadJson = sanitizeSpanPayload(merged) ?? null;
    }
    this.db
      .prepare(
        `UPDATE spans SET status = ?, ended_at = ?, duration_ms = ?,
           cost_cents = COALESCE(?, cost_cents),
           payload_json = COALESCE(?, payload_json),
           error = COALESCE(?, error)
         WHERE id = ?`,
      )
      .run(
        patch.status,
        endedAt,
        Math.max(0, endedAt - existing.startedAt),
        patch.costCents ?? null,
        payloadJson,
        patch.error !== undefined ? sanitizeSpanText(patch.error) : null,
        id,
      );
    return this.getSpan(id);
  }

  /** One-shot span insert (already finished) — used by importers/tests. */
  recordSpan(input: StartSpanInput & EndSpanPatch & { endedAt: number }): Span {
    const span = this.startSpan(input);
    return this.endSpan(span.id, {
      status: input.status,
      payload: input.payload,
      error: input.error,
      costCents: input.costCents,
      endedAt: input.endedAt,
    }) as Span;
  }

  getSpan(id: string): Span | undefined {
    const row = this.db.prepare('SELECT * FROM spans WHERE id = ?').get(id) as unknown as SpanRow | undefined;
    return row ? toSpan(row) : undefined;
  }

  /** All spans of a run, oldest first (waterfall/replay order). */
  listSpans(runId: string): Span[] {
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE run_id = ? ORDER BY started_at ASC, rowid ASC')
      .all(runId) as unknown as SpanRow[];
    return rows.map(toSpan);
  }

  /** Cost attribution roll-up for a run: LLM token cost + paid tool cost. */
  runTotals(runId: string): RunTotals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN kind = 'llm' THEN cost_cents ELSE 0 END), 0) AS llm_cents,
                COALESCE(SUM(CASE WHEN kind = 'tool' THEN cost_cents ELSE 0 END), 0) AS tool_cents,
                COALESCE(SUM(cost_cents), 0) AS total_cents,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                MIN(started_at) AS first_start,
                MAX(ended_at) AS last_end
         FROM spans WHERE run_id = ?`,
      )
      .get(runId) as unknown as {
      n: number;
      llm_cents: number;
      tool_cents: number;
      total_cents: number;
      errors: number;
      first_start: number | null;
      last_end: number | null;
    };
    return {
      runId,
      spanCount: row.n,
      llmCostCents: row.llm_cents,
      toolCostCents: row.tool_cents,
      totalCostCents: row.total_cents,
      errorCount: row.errors,
      durationMs:
        row.first_start !== null && row.last_end !== null ? Math.max(0, row.last_end - row.first_start) : null,
    };
  }
}

/**
 * Extract a paid tool's cost from its result: tools that execute paid
 * external APIs (e.g. Composio actions) may return `costCents` (or
 * `cost_cents`) in their result object; that cost is attributed to the
 * tool span so it rolls into run totals alongside LLM token cost.
 */
export function extractToolCostCents(result: unknown): number | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const rec = result as Record<string, unknown>;
  for (const key of ['costCents', 'cost_cents'] as const) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Supervisor statistics surface (closure #180): the Activity surface
// reads SupervisorStats snapshots through this summarizer (kept pure so
// spans.ts stays free of supervisor imports).
// ---------------------------------------------------------------------------

export interface SupervisorStatsSnapshot {
  gatesFired: number;
  gateAccepts: number;
  gateRejections: number;
  gateSkipped: number;
  steers: number;
  authorizerAllowed: number;
  authorizerDenied: number;
  authorizerSkipped: number;
  plansCreated: number;
  condensations: number;
  planSketches: number;
}

export function summarizeSupervisorStats(stats: SupervisorStatsSnapshot): {
  gateAcceptRate: number | null;
  authorizerDenyRate: number | null;
  total: SupervisorStatsSnapshot;
} {
  const decided = stats.gateAccepts + stats.gateRejections;
  const authDecided = stats.authorizerAllowed + stats.authorizerDenied;
  return {
    gateAcceptRate: decided > 0 ? stats.gateAccepts / decided : null,
    authorizerDenyRate: authDecided > 0 ? stats.authorizerDenied / authDecided : null,
    total: stats,
  };
}
