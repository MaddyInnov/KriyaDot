// SPDX-License-Identifier: Apache-2.0
// W13: span/trace store CRUD + nesting, payload redaction + size cap,
// run totals with tool-cost attribution, outcome aggregation, tags +
// filters, and the loop detector. Zero paid API usage — in-memory only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SpanStore,
  detectLoops,
  mapTurnOutcome,
  resolveLoopThreshold,
  sanitizeSpanPayload,
  type Span,
} from '../src/spans.js';

let store: SpanStore;
beforeEach(() => {
  store = new SpanStore(':memory:');
});
afterEach(() => {
  store.close();
  delete process.env.KRIYADOT_LOOP_THRESHOLD;
});

function seedRun(botId = 'bot-a', sessionId = 'sess-1') {
  const run = store.createRun({ sessionId, botId });
  const session = store.startSpan({
    runId: run.runId, sessionId, kind: 'session', name: 'session', botId,
  });
  const turn = store.startSpan({
    runId: run.runId, sessionId, parentSpanId: session.id, kind: 'turn', name: 'turn', botId,
  });
  return { run, session, turn };
}

describe('SpanStore CRUD + nesting', () => {
  it('creates nested spans with correct parents and computed duration', () => {
    const { run, session, turn } = seedRun();
    const llm = store.startSpan({
      runId: run.runId, sessionId: 'sess-1', parentSpanId: turn.id, kind: 'llm', name: 'llm:m', botId: 'bot-a',
      payload: { input: { messages: [{ role: 'user', content: 'hi' }] } },
    });
    const ended = store.endSpan(llm.id, {
      status: 'ok',
      endedAt: llm.startedAt + 42,
      payload: { output: { content: 'hello' } },
      costCents: 3,
    });
    expect(ended?.durationMs).toBe(42);
    expect(ended?.status).toBe('ok');
    expect(ended?.costCents).toBe(3);
    // start payload (input) and end payload (output) merge into one record.
    const payload = ended?.payload as { input: unknown; output: unknown };
    expect(payload.input).toBeTruthy();
    expect(payload.output).toEqual({ content: 'hello' });

    const spans = store.listSpans(run.runId);
    expect(spans.map((s) => s.kind)).toEqual(['session', 'turn', 'llm']);
    const byId = new Map(spans.map((s) => [s.id, s]));
    expect(byId.get(session.id)?.parentSpanId).toBeNull();
    expect(byId.get(turn.id)?.parentSpanId).toBe(session.id);
    expect(byId.get(llm.id)?.parentSpanId).toBe(turn.id);
  });

  it('endSpan on an unknown id is a no-op, getSpan misses cleanly', () => {
    expect(store.endSpan('span_nope', { status: 'ok' })).toBeUndefined();
    expect(store.getSpan('span_nope')).toBeUndefined();
    expect(store.getRun('run_nope')).toBeUndefined();
  });

  it('finalizeRun records outcome + endedAt; listRuns filters compose', () => {
    const a = seedRun('bot-a', 's-a');
    store.finalizeRun(a.run.runId, 'success');
    const b = seedRun('bot-a', 's-b');
    store.finalizeRun(b.run.runId, 'failed');
    const c = seedRun('bot-b', 's-c');
    store.finalizeRun(c.run.runId, 'success');

    expect(store.getRun(a.run.runId)?.outcome).toBe('success');
    expect(store.getRun(a.run.runId)?.endedAt).not.toBeNull();
    expect(store.listRuns({ botId: 'bot-a' })).toHaveLength(2);
    expect(store.listRuns({ outcome: 'success' })).toHaveLength(2);
    expect(store.listRuns({ botId: 'bot-a', outcome: 'success' })).toHaveLength(1);
    expect(store.listRuns({ botId: 'bot-a', outcome: 'success' })[0]?.sessionId).toBe('s-a');
  });
});

describe('payload redaction + size cap', () => {
  it('a fake secret in a prompt/tool payload is NOT present in the stored span', () => {
    const { run, turn } = seedRun();
    const fakeKey = 'sk-FAKESECRET1234567890';
    const fakePw = 'hunter2-super-secret-value';
    const span = store.startSpan({
      runId: run.runId, sessionId: 'sess-1', parentSpanId: turn.id, kind: 'tool', name: 'paid_lookup', botId: 'bot-a',
      payload: {
        input: {
          prompt: `use this key ${fakeKey} and api_key = ${fakeKey}`,
          apiKey: fakePw,
          nested: { password: fakePw, note: 'Bearer abcdefghijklmnopqrstuvwxyz' },
        },
      },
    });
    const stored = store.getSpan(span.id);
    const raw = JSON.stringify(stored?.payload);
    expect(raw).not.toContain(fakeKey);
    expect(raw).not.toContain(fakePw);
    expect(raw).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(raw).toContain('[REDACTED]');
    // Non-secret content survives.
    expect(raw).toContain('use this key');
  });

  it('sanitizeSpanPayload caps size with an explicit truncation marker', () => {
    const big = { input: { text: 'x'.repeat(5000) } };
    const stored = sanitizeSpanPayload(big, 256) as string;
    expect(stored.length).toBeLessThan(400);
    expect(stored).toContain('TRUNCATED');
  });

  it('store-level payloads are capped at the default limit', () => {
    const { run, turn } = seedRun();
    const span = store.startSpan({
      runId: run.runId, sessionId: 'sess-1', parentSpanId: turn.id, kind: 'llm', name: 'llm:m', botId: 'bot-a',
      payload: { input: { text: 'y'.repeat(20000) } },
    });
    const stored = store.getSpan(span.id);
    expect(typeof stored?.payload).toBe('string');
    expect(stored?.payload as string).toContain('TRUNCATED');
  });
});

describe('run totals + tool cost attribution', () => {
  it('tool-span costCents rolls into run totals alongside LLM cost', () => {
    const { run, turn } = seedRun();
    store.recordSpan({
      runId: run.runId, sessionId: 'sess-1', parentSpanId: turn.id, kind: 'llm', name: 'llm:m', botId: 'bot-a',
      status: 'ok', costCents: 5, startedAt: 1000, endedAt: 1100,
    });
    store.recordSpan({
      runId: run.runId, sessionId: 'sess-1', parentSpanId: turn.id, kind: 'tool', name: 'composio_action', botId: 'bot-a',
      status: 'ok', costCents: 7, startedAt: 1100, endedAt: 1250,
    });
    store.recordSpan({
      runId: run.runId, sessionId: 'sess-1', parentSpanId: turn.id, kind: 'tool', name: 'free_tool', botId: 'bot-a',
      status: 'error', error: 'boom', startedAt: 1250, endedAt: 1300,
    });
    const totals = store.runTotals(run.runId);
    expect(totals.spanCount).toBe(5); // session + turn + 3 recorded
    expect(totals.llmCostCents).toBe(5);
    expect(totals.toolCostCents).toBe(7);
    expect(totals.totalCostCents).toBe(12);
    expect(totals.errorCount).toBe(1);
    expect(totals.durationMs).toBe(300);
  });
});

describe('outcome mapping + per-bot success rates', () => {
  it('mapTurnOutcome covers the four outcomes', () => {
    expect(mapTurnOutcome({})).toBe('success');
    expect(mapTurnOutcome({ errored: true })).toBe('failed');
    expect(mapTurnOutcome({ aborted: true })).toBe('cancelled');
    expect(mapTurnOutcome({ waitingForInput: true })).toBe('needs-input');
  });

  it('outcomesByBot aggregates counts and success rate per bot', () => {
    const mk = (botId: string, outcome: 'success' | 'failed' | 'cancelled' | 'needs-input') => {
      const r = store.createRun({ sessionId: `s-${Math.random()}`, botId });
      store.finalizeRun(r.runId, outcome);
    };
    mk('bot-a', 'success');
    mk('bot-a', 'success');
    mk('bot-a', 'failed');
    mk('bot-a', 'needs-input');
    mk('bot-b', 'cancelled');
    store.createRun({ sessionId: 's-running', botId: 'bot-b' }); // not finalized

    const stats = store.outcomesByBot();
    const a = stats.find((s) => s.botId === 'bot-a');
    const b = stats.find((s) => s.botId === 'bot-b');
    expect(a).toMatchObject({ total: 4, success: 2, failed: 1, needsInput: 1, cancelled: 0 });
    expect(a?.successRate).toBeCloseTo(0.5);
    expect(b).toMatchObject({ total: 2, running: 1, cancelled: 1 });
    expect(b?.successRate).toBe(0);
  });
});

describe('tags CRUD + tag filter', () => {
  it('adds, lists, removes tags and filters runs by tag', () => {
    const { run } = seedRun();
    expect(store.addTag(run.runId, '  release-check ')).toEqual(['release-check']);
    expect(store.addTag(run.runId, 'smoke')).toEqual(['release-check', 'smoke']);
    expect(store.addTag(run.runId, 'smoke')).toEqual(['release-check', 'smoke']); // idempotent
    expect(store.getRun(run.runId)?.tags).toEqual(['release-check', 'smoke']);
    expect(store.listRuns({ tag: 'smoke' }).map((r) => r.runId)).toEqual([run.runId]);
    expect(store.listRuns({ tag: 'missing' })).toHaveLength(0);
    expect(store.removeTag(run.runId, 'smoke')).toEqual(['release-check']);
    expect(() => store.addTag(run.runId, '   ')).toThrow(/empty/);
    expect(() => store.addTag('run_nope', 'x')).toThrow(/Unknown run/);
  });
});

describe('loop detector', () => {
  function toolSpan(id: string, name: string, args: unknown): Span {
    return {
      id, runId: 'r', sessionId: 's', parentSpanId: 't', kind: 'tool', name,
      startedAt: 0, endedAt: 1, durationMs: 1, status: 'ok', botId: 'b',
      payload: { input: args },
    };
  }
  function llmSpan(id: string, content: string): Span {
    return {
      id, runId: 'r', sessionId: 's', parentSpanId: 't', kind: 'llm', name: 'llm:m',
      startedAt: 0, endedAt: 1, durationMs: 1, status: 'ok', botId: 'b',
      payload: { output: { content } },
    };
  }

  it('flags >= threshold repeated identical tool calls with evidence span ids', () => {
    const spans = [1, 2, 3].map((i) => toolSpan(`t${i}`, 'web_search', { query: 'same query' }));
    const evidence = detectLoops(spans);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ kind: 'tool', key: 'web_search', count: 3 });
    expect(evidence[0]?.spanIds).toEqual(['t1', 't2', 't3']);
  });

  it('flags near-identical args (minor variation) for the same tool', () => {
    const base = { query: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda' };
    const spans = [
      toolSpan('t1', 'web_search', base),
      toolSpan('t2', 'web_search', { query: `${base.query} mu` }),
      toolSpan('t3', 'web_search', base),
    ];
    expect(detectLoops(spans).some((e) => e.kind === 'tool' && e.count === 3)).toBe(true);
  });

  it('does not flag varied calls or below-threshold repeats', () => {
    const varied = [
      toolSpan('t1', 'web_search', { query: 'apples and oranges fruit salad' }),
      toolSpan('t2', 'web_search', { query: 'quantum computing hardware roadmap' }),
      toolSpan('t3', 'web_search', { query: 'monsoon rainfall forecast odisha' }),
    ];
    expect(detectLoops(varied)).toEqual([]);
    const two = [1, 2].map((i) => toolSpan(`t${i}`, 'web_search', { query: 'same' }));
    expect(detectLoops(two)).toEqual([]);
    // Same args but DIFFERENT tools are not a loop cluster.
    const crossTool = [
      toolSpan('t1', 'search_a', { q: 'x' }),
      toolSpan('t2', 'search_b', { q: 'x' }),
      toolSpan('t3', 'search_a', { q: 'x' }),
    ];
    expect(detectLoops(crossTool)).toEqual([]);
  });

  it('flags repeated identical assistant text segments', () => {
    const spans = [1, 2, 3].map((i) => llmSpan(`l${i}`, 'I will check that for you.'));
    const evidence = detectLoops(spans);
    expect(evidence.some((e) => e.kind === 'text' && e.count === 3)).toBe(true);
  });

  it('threshold is configurable (argument and env override)', () => {
    const two = [1, 2].map((i) => toolSpan(`t${i}`, 'web_search', { query: 'same' }));
    expect(detectLoops(two, 2)).toHaveLength(1);
    expect(resolveLoopThreshold()).toBe(3);
    process.env.KRIYADOT_LOOP_THRESHOLD = '5';
    expect(resolveLoopThreshold()).toBe(5);
    const four = [1, 2, 3, 4].map((i) => toolSpan(`t${i}`, 'web_search', { query: 'same' }));
    expect(detectLoops(four)).toEqual([]); // env threshold 5 applies by default
  });

  it('flagLoop persists the flag + evidence on the run record', () => {
    const { run, turn } = seedRun();
    for (let i = 0; i < 3; i++) {
      store.recordSpan({
        runId: run.runId, sessionId: 'sess-1', parentSpanId: turn.id, kind: 'tool', name: 'web_search',
        botId: 'bot-a', status: 'ok', payload: { input: { query: 'same' } },
        startedAt: 1000 + i * 10, endedAt: 1005 + i * 10,
      });
    }
    const evidence = detectLoops(store.listSpans(run.runId));
    expect(evidence).toHaveLength(1);
    store.flagLoop(run.runId, evidence);
    const record = store.getRun(run.runId);
    expect(record?.loopDetected).toBe(true);
    expect(record?.loopEvidence[0]?.spanIds).toHaveLength(3);
  });
});
