// SPDX-License-Identifier: Apache-2.0
// W13: waterfall layout + replay stepper math.

import { describe, expect, it } from 'vitest';
import {
  fmtCents,
  fmtDuration,
  layoutWaterfall,
  replayDelayMs,
  spanDepth,
  stepReplayIndex,
  type ObsSpan,
} from './runs-waterfall';

function span(partial: Partial<ObsSpan> & { id: string }): ObsSpan {
  return {
    runId: 'r1',
    sessionId: 's1',
    parentSpanId: null,
    kind: 'llm',
    name: 'llm:m',
    startedAt: 0,
    endedAt: 10,
    durationMs: 10,
    status: 'ok',
    botId: 'b1',
    ...partial,
  };
}

describe('layoutWaterfall', () => {
  const session = span({ id: 'session', kind: 'session', startedAt: 0, endedAt: 1000, durationMs: 1000 });
  const turn = span({ id: 'turn', kind: 'turn', parentSpanId: 'session', startedAt: 100, endedAt: 900, durationMs: 800 });
  const llm = span({ id: 'llm', kind: 'llm', parentSpanId: 'turn', startedAt: 200, endedAt: 400, durationMs: 200 });
  const tool = span({ id: 'tool', kind: 'tool', parentSpanId: 'turn', startedAt: 500, endedAt: 600, durationMs: 100 });

  it('computes nesting depth from the parent chain', () => {
    const { rows } = layoutWaterfall([session, turn, llm, tool]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
  });

  it('positions bars by start/duration within the run window', () => {
    const { rows, windowMs } = layoutWaterfall([session, turn, llm, tool]);
    expect(windowMs).toBe(1000);
    const llmRow = rows.find((r) => r.span.id === 'llm');
    expect(llmRow?.leftPct).toBeCloseTo(20);
    expect(llmRow?.widthPct).toBeCloseTo(20);
    const toolRow = rows.find((r) => r.span.id === 'tool');
    expect(toolRow?.leftPct).toBeCloseTo(50);
    expect(toolRow?.widthPct).toBeCloseTo(10);
  });

  it('handles running spans (no end) and empty input', () => {
    const running = span({ id: 'run1', endedAt: null, durationMs: null, startedAt: 100 });
    const { rows } = layoutWaterfall([session, running]);
    expect(rows[1]?.leftPct).toBeCloseTo(10);
    expect(rows[1]?.widthPct).toBeGreaterThan(0);
    expect(layoutWaterfall([]).rows).toEqual([]);
  });

  it('spanDepth is orphan- and cycle-safe', () => {
    const orphan = span({ id: 'o', parentSpanId: 'missing' });
    expect(spanDepth(orphan, new Map())).toBe(0);
    const a = span({ id: 'a', parentSpanId: 'b' });
    const b = span({ id: 'b', parentSpanId: 'a' });
    const byId = new Map([
      ['a', a],
      ['b', b],
    ]);
    expect(spanDepth(a, byId)).toBeLessThanOrEqual(2);
  });
});

describe('replay stepper', () => {
  it('steps forward/back with clamping at both ends', () => {
    expect(stepReplayIndex(0, 1, 5)).toBe(1);
    expect(stepReplayIndex(0, -1, 5)).toBe(0);
    expect(stepReplayIndex(4, 1, 5)).toBe(4);
    expect(stepReplayIndex(2, -1, 5)).toBe(1);
    expect(stepReplayIndex(0, 1, 0)).toBe(0);
  });

  it('delay scales inversely with speed', () => {
    expect(replayDelayMs(1)).toBe(900);
    expect(replayDelayMs(2)).toBe(450);
    expect(replayDelayMs(0.5)).toBe(1800);
    expect(replayDelayMs(0)).toBe(900);
  });
});

describe('formatters', () => {
  it('formats durations and cents', () => {
    expect(fmtDuration(250)).toBe('250ms');
    expect(fmtDuration(2500)).toBe('2.5s');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtCents(7)).toBe('$0.0700');
    expect(fmtCents(12345)).toBe('$123.45');
    expect(fmtCents(undefined)).toBe('—');
  });
});
