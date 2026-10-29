// SPDX-License-Identifier: Apache-2.0
// W13: pure layout + replay math for the Activity → Runs waterfall.
// Kept free of React so the geometry and the replay stepper are unit
// tested directly.

export interface ObsSpan {
  id: string;
  runId: string;
  sessionId: string;
  parentSpanId: string | null;
  kind: 'session' | 'bot' | 'goal' | 'routine' | 'turn' | 'llm' | 'tool';
  name: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: 'running' | 'ok' | 'error';
  botId: string;
  costCents?: number;
  payload?: unknown;
  error?: string;
}

export interface WaterfallRow {
  span: ObsSpan;
  /** Nesting depth from the parent chain (root = 0). */
  depth: number;
  /** Bar position as % of the run's total time window. */
  leftPct: number;
  widthPct: number;
}

export interface WaterfallLayout {
  rows: WaterfallRow[];
  windowStart: number;
  windowEnd: number;
  windowMs: number;
}

/** Depth of a span in its parent chain (cycle- and orphan-safe). */
export function spanDepth(span: ObsSpan, byId: Map<string, ObsSpan>): number {
  let depth = 0;
  let current: ObsSpan | undefined = span;
  const seen = new Set<string>();
  while (current?.parentSpanId && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentSpanId);
    if (current) depth += 1;
  }
  return depth;
}

/**
 * Lay spans out as waterfall rows: one row per span (input order is the
 * recorded start order), bar offset/width relative to the run window.
 * Running spans (no end) extend to the window end.
 */
export function layoutWaterfall(spans: ObsSpan[]): WaterfallLayout {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const windowStart = spans.length > 0 ? Math.min(...spans.map((s) => s.startedAt)) : 0;
  const windowEnd =
    spans.length > 0
      ? Math.max(...spans.map((s) => s.endedAt ?? s.startedAt + (s.durationMs ?? 0)))
      : 0;
  const windowMs = Math.max(1, windowEnd - windowStart);
  const rows = spans.map((span) => {
    const end = span.endedAt ?? windowEnd;
    const leftPct = ((span.startedAt - windowStart) / windowMs) * 100;
    const widthPct = Math.max(0.4, ((end - span.startedAt) / windowMs) * 100);
    return { span, depth: spanDepth(span, byId), leftPct, widthPct };
  });
  return { rows, windowStart, windowEnd, windowMs };
}

/** Clamp a replay cursor move (step forward/back) into [0, count-1]. */
export function stepReplayIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/** Milliseconds between replay frames at a given speed multiplier. */
export function replayDelayMs(speed: number): number {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.round(900 / s);
}

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

/** Short human duration for span/run labels. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

/** USD cents → $ label (fractional cents preserved for span costs). */
export function fmtCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toFixed(cents < 10 ? 4 : 2)}`;
}
