// SPDX-License-Identifier: Apache-2.0
// Chat | Trajectory projection (2026-10-31 minimal-UI redesign).
//
// Pure functions that turn the recorded observability data for ONE chat
// session (runs from GET /api/observability/runs?sessionId=… plus each
// run's spans from GET /api/observability/runs/:runId) into:
//   - a badge event feed (context / user / assistant / tool / subagent),
//   - a 3-lane timeline (input / model / tools) over the session window,
//   - a per-event inspector model (summary / payload / result / schema /
//     timing) for the step-inspector pane.
//
// No React, no fetch: components/chat/trajectory-view.tsx owns the I/O.
// Span payloads were already redacted + size-capped server-side at write
// time; a payload can therefore arrive as a truncated JSON *string* —
// every helper here tolerates that.

/** Run record as served by the observability API (totals attached). */
export interface TrajRun {
  runId: string;
  sessionId: string;
  botId: string;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  totals?: {
    spanCount: number;
    llmCostCents: number;
    toolCostCents: number;
    totalCostCents: number;
    errorCount: number;
    durationMs: number | null;
  };
}

/** Span record as served by the observability run-detail endpoint. */
export interface TrajSpan {
  id: string;
  runId: string;
  sessionId: string;
  parentSpanId: string | null;
  kind: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: string;
  botId: string;
  costCents?: number;
  payload?: unknown;
  error?: string;
}

export type TrajBadge = 'user' | 'assistant' | 'tool' | 'context' | 'subagent';

export interface TrajEvent {
  id: string;
  runId: string;
  spanId: string | null;
  ts: number;
  badge: TrajBadge;
  title: string;
  subtitle: string;
  status: string;
  durationMs: number | null;
  /** Span kind ('turn' | 'llm' | 'tool' | …) or 'run' for run-start events. */
  kind: string;
  /** Span name (tool name, 'llm:<model>', …) or the run kind. */
  name: string;
  botId: string;
}

export type TrajLaneId = 'input' | 'model' | 'tools';

export interface TrajSegment {
  startPct: number;
  widthPct: number;
  kind: TrajBadge;
  eventId: string;
}

export interface TrajLanes {
  input: TrajSegment[];
  model: TrajSegment[];
  tools: TrajSegment[];
}

export interface SessionTrajectory {
  events: TrajEvent[];
  lanes: TrajLanes;
  /** Session time window (ms epoch); both 0 for an empty session. */
  windowStart: number;
  windowEnd: number;
  /** Bot of the earliest run — other bots' runs read as subagent runs. */
  primaryBotId: string | null;
}

const SUBAGENT_TOOL_RE = /delegate|subagent|fusion/i;

/** Tool names that represent delegated work read as subagent events. */
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_RE.test(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Best-effort human text out of a span payload's input, for subtitles. */
export function payloadInputText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const input = payload.input;
  if (typeof input === 'string') return input;
  if (isRecord(input)) {
    for (const key of ['message', 'prompt', 'text', 'query'] as const) {
      const v = input[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    // Tool args: show the first salient field (path / command / url…).
    for (const key of ['path', 'command', 'url', 'pattern'] as const) {
      const v = input[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return null;
}

function spanDuration(span: TrajSpan): number | null {
  if (typeof span.durationMs === 'number') return span.durationMs;
  if (span.endedAt !== null) return Math.max(0, span.endedAt - span.startedAt);
  return null; // still running
}

function badgeForSpan(span: TrajSpan): TrajBadge | null {
  switch (span.kind) {
    case 'session':
      return null; // covered by the run-start event
    case 'turn':
      return 'user';
    case 'llm':
      return 'assistant';
    case 'tool':
      return isSubagentTool(span.name) ? 'subagent' : 'tool';
    default:
      // 'bot' | 'goal' | 'routine' and anything future: context framing.
      return 'context';
  }
}

function laneForBadge(badge: TrajBadge): TrajLaneId {
  if (badge === 'assistant') return 'model';
  if (badge === 'tool' || badge === 'subagent') return 'tools';
  return 'input'; // user + context
}

/**
 * Build the full trajectory projection for one session.
 * `spansByRun` maps runId → that run's spans (any order; may omit runs
 * whose detail has not been fetched — those runs still get a start event).
 */
export function buildTrajectory(runs: TrajRun[], spansByRun: Record<string, TrajSpan[]>): SessionTrajectory {
  const sortedRuns = [...runs].sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1));
  const primaryBotId = sortedRuns[0]?.botId ?? null;

  const events: TrajEvent[] = [];
  // Event end times (for lane segment widths), keyed by event id.
  const endByEventId = new Map<string, number>();

  for (const run of sortedRuns) {
    const foreign = primaryBotId !== null && run.botId !== primaryBotId;
    const runEvent: TrajEvent = {
      id: `run:${run.runId}`,
      runId: run.runId,
      spanId: null,
      ts: run.startedAt,
      badge: foreign ? 'subagent' : 'context',
      title: foreign ? `Subagent run · ${run.botId}` : 'Run started',
      subtitle: `${run.botId} · ${run.kind} run${run.outcome ? ` · ${run.outcome}` : ' · running'}`,
      status: run.outcome ?? 'running',
      durationMs:
        run.endedAt !== null ? Math.max(0, run.endedAt - run.startedAt) : (run.totals?.durationMs ?? null),
      kind: 'run',
      name: run.kind,
      botId: run.botId,
    };
    events.push(runEvent);
    endByEventId.set(runEvent.id, run.endedAt ?? run.startedAt + (runEvent.durationMs ?? 0));

    const spans = [...(spansByRun[run.runId] ?? [])].sort(
      (a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1),
    );
    for (const span of spans) {
      const badge = badgeForSpan(span);
      if (badge === null) continue;
      const durationMs = spanDuration(span);
      const inputText = payloadInputText(span.payload);
      let title: string;
      let subtitle: string;
      if (badge === 'user') {
        title = 'User turn';
        subtitle = inputText ? excerpt(inputText) : span.name;
      } else if (badge === 'assistant') {
        title = span.name.startsWith('llm:') ? span.name.slice(4) : span.name;
        subtitle = span.status === 'error' && span.error ? excerpt(span.error) : `LLM call · ${span.botId}`;
      } else if (badge === 'subagent' && span.kind === 'tool') {
        title = span.name;
        subtitle = inputText ? excerpt(inputText) : `Delegated · ${span.botId}`;
      } else if (badge === 'tool') {
        title = span.name;
        subtitle = inputText ? excerpt(inputText) : span.botId;
      } else {
        title = span.name;
        subtitle = `${span.kind} · ${span.botId}`;
      }
      const event: TrajEvent = {
        id: `span:${span.id}`,
        runId: span.runId,
        spanId: span.id,
        ts: span.startedAt,
        badge,
        title,
        subtitle,
        status: span.status,
        durationMs,
        kind: span.kind,
        name: span.name,
        botId: span.botId,
      };
      events.push(event);
      endByEventId.set(event.id, span.endedAt ?? span.startedAt + (durationMs ?? 0));
    }
  }

  events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Session window: earliest event start → latest known end (running
  // spans extend to their start; a zero-length window is widened to 1ms).
  const windowStart = events.length > 0 ? Math.min(...events.map((e) => e.ts)) : 0;
  const windowEnd = events.length > 0 ? Math.max(...events.map((e) => endByEventId.get(e.id) ?? e.ts)) : 0;
  const windowMs = Math.max(1, windowEnd - windowStart);

  const lanes: TrajLanes = { input: [], model: [], tools: [] };
  for (const event of events) {
    const end = Math.max(event.ts, endByEventId.get(event.id) ?? event.ts);
    const segment: TrajSegment = {
      startPct: ((event.ts - windowStart) / windowMs) * 100,
      widthPct: Math.max(0.6, ((end - event.ts) / windowMs) * 100),
      kind: event.badge,
      eventId: event.id,
    };
    lanes[laneForBadge(event.badge)].push(segment);
  }

  return { events, lanes, windowStart, windowEnd, primaryBotId };
}

// ---------------------------------------------------------------------------
// Inspector model
// ---------------------------------------------------------------------------

export interface InspectorRow {
  label: string;
  value: string;
}

export interface InspectorModel {
  summary: InspectorRow[];
  /** Pretty-printed span payload ('' when the event carries no span). */
  payload: string;
  /** payload.result ?? payload.output ?? span.error (pretty-printed). */
  result: string;
  /** Shallow key → type map derived from the payload object. */
  schema: InspectorRow[];
  timing: InspectorRow[];
}

export function prettyValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/** Shallow key → type map for an object payload (empty for non-objects). */
export function payloadSchema(payload: unknown): InspectorRow[] {
  if (!isRecord(payload)) return [];
  return Object.entries(payload).map(([key, value]) => {
    let type = typeName(value);
    if (isRecord(value)) {
      const inner = Object.keys(value).slice(0, 4).join(', ');
      type = inner ? `object { ${inner}${Object.keys(value).length > 4 ? ', …' : ''} }` : 'object';
    }
    return { label: key, value: type };
  });
}

function fmtClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  } catch {
    return String(ts);
  }
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${(s / 60).toFixed(1)}m`;
}

/**
 * Inspector model for one event. `span`/`run` are the event's source
 * records when available (run-start events have no span); `sessionStart`
 * is the trajectory window start, for the offset row.
 */
export function buildInspector(
  event: TrajEvent,
  span: TrajSpan | null,
  run: TrajRun | null,
  sessionStart: number,
): InspectorModel {
  const summary: InspectorRow[] = [
    { label: 'Kind', value: event.kind },
    { label: 'Name', value: event.name },
    { label: 'Status', value: event.status },
    { label: 'Bot', value: event.botId },
    { label: 'Duration', value: fmtMs(event.durationMs) },
  ];
  const costCents = span?.costCents ?? (event.spanId === null ? run?.totals?.totalCostCents : undefined);
  if (typeof costCents === 'number') {
    summary.push({ label: 'Cost', value: `$${(costCents / 100).toFixed(costCents < 10 ? 4 : 2)}` });
  }
  if (run?.outcome) summary.push({ label: 'Run outcome', value: run.outcome });

  const payload = span ? span.payload : undefined;
  let result = '';
  if (span) {
    if (isRecord(payload) && 'result' in payload) result = prettyValue(payload.result);
    else if (isRecord(payload) && 'output' in payload) result = prettyValue(payload.output);
    else if (span.error) result = span.error;
  }

  const startedAt = span?.startedAt ?? event.ts;
  const endedAt = span ? span.endedAt : (run?.endedAt ?? null);
  const timing: InspectorRow[] = [
    { label: 'Started', value: fmtClock(startedAt) },
    { label: 'Ended', value: endedAt !== null ? fmtClock(endedAt) : 'running' },
    { label: 'Duration', value: fmtMs(event.durationMs) },
    { label: 'Offset in session', value: fmtMs(Math.max(0, startedAt - sessionStart)) },
  ];

  return {
    summary,
    payload: span ? prettyValue(payload) || '(no payload recorded)' : '(run event — no span payload)',
    result: result || (span ? '(no result recorded)' : '(run event — see run spans)'),
    schema: payloadSchema(payload),
    timing,
  };
}
