// SPDX-License-Identifier: Apache-2.0
// Pack B footprint: SpanStore retention bounds the observability DB.
// pruneOldRuns removes aged ENDED runs (with their spans + tags), trims
// ended runs beyond the count cap oldest-first, and never touches
// in-flight runs.

import { describe, expect, it } from 'vitest';
import { SpanStore } from '../src/spans.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed clock for determinism

function makeRun(store: SpanStore, endedAt: number | null, spans = 1): string {
  const run = store.createRun({ sessionId: 's', botId: 'b', startedAt: endedAt ?? NOW });
  for (let i = 0; i < spans; i++) {
    const span = store.startSpan({
      runId: run.runId,
      sessionId: 's',
      botId: 'b',
      kind: 'turn',
      name: `span-${i}`,
      startedAt: endedAt ?? NOW,
    });
    store.endSpan(span.id, { status: 'ok', endedAt: endedAt ?? NOW });
  }
  if (endedAt !== null) store.finalizeRun(run.runId, 'success', endedAt);
  return run.runId;
}

describe('SpanStore.pruneOldRuns', () => {
  it('removes runs older than maxAgeMs with their spans, keeps fresh + in-flight runs', () => {
    const store = new SpanStore(':memory:');
    const oldRun = makeRun(store, NOW - 40 * DAY, 2);
    const freshRun = makeRun(store, NOW - 1 * DAY, 1);
    const liveRun = makeRun(store, null, 1);
    store.addTag?.(freshRun, 'keep-me');

    const res = store.pruneOldRuns({ maxAgeMs: 30 * DAY, maxRuns: 20_000, now: NOW });
    expect(res.runsRemoved).toBe(1);
    expect(res.spansRemoved).toBe(2);
    expect(store.getRun(oldRun)).toBeUndefined();
    expect(store.getRun(freshRun)).toBeDefined();
    expect(store.getRun(liveRun)).toBeDefined();
    // spans of the pruned run are gone; fresh run's span survives
    expect(store.listSpans(oldRun)).toHaveLength(0);
    expect(store.listSpans(freshRun)).toHaveLength(1);
    store.close();
  });

  it('trims ended runs beyond maxRuns, oldest first', () => {
    const store = new SpanStore(':memory:');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(makeRun(store, NOW - (10 - i) * DAY, 1));
    const res = store.pruneOldRuns({ maxAgeMs: 365 * DAY, maxRuns: 2, now: NOW });
    expect(res.runsRemoved).toBe(3);
    // the two newest ended runs remain
    expect(store.getRun(ids[3]!)).toBeDefined();
    expect(store.getRun(ids[4]!)).toBeDefined();
    expect(store.getRun(ids[0]!)).toBeUndefined();
    store.close();
  });

  it('is a no-op when nothing is aged or over cap', () => {
    const store = new SpanStore(':memory:');
    makeRun(store, NOW - 1 * DAY, 1);
    const res = store.pruneOldRuns({ now: NOW });
    expect(res).toEqual({ runsRemoved: 0, spansRemoved: 0 });
    store.close();
  });
});
