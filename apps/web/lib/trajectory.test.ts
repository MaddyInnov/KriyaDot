// SPDX-License-Identifier: Apache-2.0
// Trajectory projection tests: badge mapping (incl. subagent tools and
// foreign-bot runs), lane geometry, inspector model, and the graceful
// paths (running spans, string payloads, empty sessions).

import { describe, expect, it } from 'vitest';
import {
  buildInspector,
  buildTrajectory,
  isSubagentTool,
  payloadInputText,
  payloadSchema,
  type TrajRun,
  type TrajSpan,
} from './trajectory';

let seq = 0;
function span(partial: Partial<TrajSpan> & { kind: string; name: string; startedAt: number }): TrajSpan {
  seq += 1;
  return {
    id: `span_${seq}`,
    runId: 'run_1',
    sessionId: 'sess-1',
    parentSpanId: null,
    endedAt: partial.startedAt + 100,
    durationMs: 100,
    status: 'ok',
    botId: 'bot-a',
    ...partial,
  };
}

function run(partial: Partial<TrajRun> & { runId: string; startedAt: number }): TrajRun {
  return {
    sessionId: 'sess-1',
    botId: 'bot-a',
    kind: 'session',
    endedAt: partial.startedAt + 1000,
    outcome: 'success',
    ...partial,
  };
}

const runA = run({ runId: 'run_1', startedAt: 1000, endedAt: 5000 });
const turnSpan = span({
  kind: 'turn', name: 'turn', startedAt: 1100, runId: 'run_1',
  payload: { input: { message: 'Please fix the flaky test in parser.ts' } },
});
const llmSpan = span({
  kind: 'llm', name: 'llm:gpt-test', startedAt: 1200, runId: 'run_1', costCents: 3,
  payload: { input: { providerId: 'openai', model: 'gpt-test' }, output: { content: 'On it.' } },
});
const toolSpan = span({
  kind: 'tool', name: 'read_file', startedAt: 2000, runId: 'run_1',
  payload: { input: { path: 'src/parser.ts' }, output: { content: '…' } },
});
const delegateSpan = span({
  kind: 'tool', name: 'delegate_task', startedAt: 3000, runId: 'run_1',
  payload: { input: { task: 'research' }, output: { summary: 'done' } },
});
const sessionSpan = span({ kind: 'session', name: 'session sess-1', startedAt: 1000, runId: 'run_1' });

describe('buildTrajectory — badges + ordering', () => {
  const model = buildTrajectory([runA], {
    run_1: [toolSpan, sessionSpan, delegateSpan, llmSpan, turnSpan], // deliberately unsorted
  });

  it('sorts events by startedAt and skips the session span (run start covers it)', () => {
    expect(model.events.map((e) => e.badge)).toEqual(['context', 'user', 'assistant', 'tool', 'subagent']);
    expect(model.events.map((e) => e.ts)).toEqual([1000, 1100, 1200, 2000, 3000]);
    expect(model.events.some((e) => e.spanId === sessionSpan.id)).toBe(false);
  });

  it('run start is a context event with spanId null', () => {
    const first = model.events[0]!;
    expect(first.spanId).toBeNull();
    expect(first.kind).toBe('run');
    expect(first.status).toBe('success');
    expect(first.durationMs).toBe(4000);
  });

  it('turn span → user badge with the message as subtitle', () => {
    const ev = model.events.find((e) => e.spanId === turnSpan.id)!;
    expect(ev.badge).toBe('user');
    expect(ev.subtitle).toContain('flaky test');
  });

  it('llm span → assistant badge, title is the bare model name', () => {
    const ev = model.events.find((e) => e.spanId === llmSpan.id)!;
    expect(ev.badge).toBe('assistant');
    expect(ev.title).toBe('gpt-test');
  });

  it('tool span → tool badge with the salient arg in the subtitle; delegate → subagent', () => {
    const tool = model.events.find((e) => e.spanId === toolSpan.id)!;
    expect(tool.badge).toBe('tool');
    expect(tool.subtitle).toBe('src/parser.ts');
    const del = model.events.find((e) => e.spanId === delegateSpan.id)!;
    expect(del.badge).toBe('subagent');
  });

  it('primaryBotId is the earliest run bot', () => {
    expect(model.primaryBotId).toBe('bot-a');
  });
});

describe('buildTrajectory — foreign-bot runs surface as subagent events', () => {
  it('a later run from a different bot gets a subagent run-start event', () => {
    const foreign = run({ runId: 'run_2', botId: 'bot-b', startedAt: 6000, endedAt: 7000 });
    const model = buildTrajectory([foreign, runA], {});
    const ev = model.events.find((e) => e.id === 'run:run_2')!;
    expect(ev.badge).toBe('subagent');
    expect(ev.title).toContain('bot-b');
    const own = model.events.find((e) => e.id === 'run:run_1')!;
    expect(own.badge).toBe('context');
  });
});

describe('buildTrajectory — lanes + window', () => {
  const model = buildTrajectory([runA], { run_1: [turnSpan, llmSpan, toolSpan, delegateSpan] });

  it('window spans run start → latest end', () => {
    expect(model.windowStart).toBe(1000);
    expect(model.windowEnd).toBe(5000);
  });

  it('lanes: user/context → input, llm → model, tool+subagent → tools', () => {
    expect(model.lanes.input.map((s) => s.kind)).toEqual(['context', 'user']);
    expect(model.lanes.model.map((s) => s.kind)).toEqual(['assistant']);
    expect(model.lanes.tools.map((s) => s.kind)).toEqual(['tool', 'subagent']);
  });

  it('segment geometry is percentage-based within the window', () => {
    const llmSeg = model.lanes.model[0]!;
    // llm starts 200ms into a 4000ms window → 5%; lasts 100ms → 2.5%.
    expect(llmSeg.startPct).toBeCloseTo(5);
    expect(llmSeg.widthPct).toBeCloseTo(2.5);
    expect(llmSeg.eventId).toBe(`span:${llmSpan.id}`);
  });
});

describe('buildTrajectory — graceful paths', () => {
  it('empty session → no events, zero window, null primary bot', () => {
    const model = buildTrajectory([], {});
    expect(model.events).toEqual([]);
    expect(model.windowStart).toBe(0);
    expect(model.windowEnd).toBe(0);
    expect(model.primaryBotId).toBeNull();
    expect(model.lanes).toEqual({ input: [], model: [], tools: [] });
  });

  it('running span (endedAt null, durationMs null) → duration null, still listed', () => {
    const running = span({
      kind: 'llm', name: 'llm:slow', startedAt: 1500, runId: 'run_1', endedAt: null, durationMs: null, status: 'running',
    });
    const model = buildTrajectory([run({ runId: 'run_1', startedAt: 1000, endedAt: null, outcome: null })], {
      run_1: [running],
    });
    const ev = model.events.find((e) => e.spanId === running.id)!;
    expect(ev.durationMs).toBeNull();
    expect(ev.status).toBe('running');
    const runEv = model.events[0]!;
    expect(runEv.status).toBe('running');
  });

  it('string payload (truncated JSON) does not crash and yields no input text', () => {
    const truncated = span({
      kind: 'turn', name: 'turn', startedAt: 1100, runId: 'run_1',
      payload: '{"input":{"message":"hello wor…[TRUNCATED 512 chars]',
    });
    const model = buildTrajectory([runA], { run_1: [truncated] });
    const ev = model.events.find((e) => e.spanId === truncated.id)!;
    expect(ev.badge).toBe('user');
    expect(ev.subtitle).toBe('turn'); // falls back to the span name
  });

  it('runs without fetched spans still produce their start event', () => {
    const model = buildTrajectory([runA], {});
    expect(model.events).toHaveLength(1);
    expect(model.events[0]?.badge).toBe('context');
  });
});

describe('isSubagentTool / payloadInputText / payloadSchema', () => {
  it('matches delegate/subagent/fusion case-insensitively only', () => {
    expect(isSubagentTool('delegate_task')).toBe(true);
    expect(isSubagentTool('spawn_SubAgent')).toBe(true);
    expect(isSubagentTool('run_FUSION_panel')).toBe(true);
    expect(isSubagentTool('read_file')).toBe(false);
    expect(isSubagentTool('web_search')).toBe(false);
  });

  it('payloadInputText prefers message-like fields, then salient tool args', () => {
    expect(payloadInputText({ input: { message: 'hi' } })).toBe('hi');
    expect(payloadInputText({ input: { path: 'a/b.ts', content: 'x' } })).toBe('a/b.ts');
    expect(payloadInputText({ input: 'raw string' })).toBe('raw string');
    expect(payloadInputText('a string payload')).toBeNull();
    expect(payloadInputText(undefined)).toBeNull();
    expect(payloadInputText({ input: { count: 3 } })).toBeNull();
  });

  it('payloadSchema maps shallow keys to types', () => {
    expect(payloadSchema({ input: { a: 1 }, output: 'text', n: null, list: [1, 2] })).toEqual([
      { label: 'input', value: 'object { a }' },
      { label: 'output', value: 'string' },
      { label: 'n', value: 'null' },
      { label: 'list', value: 'array(2)' },
    ]);
    expect(payloadSchema('nope')).toEqual([]);
    expect(payloadSchema(undefined)).toEqual([]);
  });
});

describe('buildInspector', () => {
  const model = buildTrajectory([runA], { run_1: [llmSpan, toolSpan] });
  const llmEvent = model.events.find((e) => e.spanId === llmSpan.id)!;

  it('summary rows carry kind/name/status/bot/duration and cost when present', () => {
    const insp = buildInspector(llmEvent, llmSpan, runA, model.windowStart);
    const byLabel = Object.fromEntries(insp.summary.map((r) => [r.label, r.value]));
    expect(byLabel.Kind).toBe('llm');
    expect(byLabel.Name).toBe('llm:gpt-test');
    expect(byLabel.Status).toBe('ok');
    expect(byLabel.Bot).toBe('bot-a');
    expect(byLabel.Duration).toBe('100ms');
    expect(byLabel.Cost).toBe('$0.0300');
  });

  it('payload is pretty-printed; result prefers payload.output over nothing', () => {
    const insp = buildInspector(llmEvent, llmSpan, runA, model.windowStart);
    expect(insp.payload).toContain('"providerId": "openai"');
    expect(insp.result).toContain('On it.');
    expect(insp.schema.map((r) => r.label)).toEqual(['input', 'output']);
  });

  it('result prefers payload.result over payload.output, then span.error', () => {
    const withBoth = span({
      kind: 'tool', name: 'x', startedAt: 10,
      payload: { result: 'R', output: 'O' },
    });
    const ev = { ...llmEvent, spanId: withBoth.id, kind: 'tool', name: 'x' };
    expect(buildInspector(ev, withBoth, runA, 0).result).toBe('R');
    const errored = span({ kind: 'tool', name: 'y', startedAt: 10, status: 'error', error: 'boom', payload: { input: {} } });
    expect(buildInspector({ ...ev, name: 'y' }, errored, runA, 0).result).toBe('boom');
  });

  it('timing rows include the offset from session start and running end', () => {
    const insp = buildInspector(llmEvent, llmSpan, runA, 1000);
    const byLabel = Object.fromEntries(insp.timing.map((r) => [r.label, r.value]));
    expect(byLabel['Offset in session']).toBe('200ms');
    expect(byLabel.Ended).not.toBe('running');
    const runningSpan = span({ kind: 'llm', name: 'llm:s', startedAt: 2000, endedAt: null, durationMs: null, status: 'running' });
    const runningInsp = buildInspector({ ...llmEvent, spanId: runningSpan.id, durationMs: null }, runningSpan, runA, 1000);
    const t2 = Object.fromEntries(runningInsp.timing.map((r) => [r.label, r.value]));
    expect(t2.Ended).toBe('running');
    expect(t2.Duration).toBe('—');
  });

  it('run-start event (no span) still produces a model', () => {
    const runEvent = model.events.find((e) => e.spanId === null)!;
    const insp = buildInspector(runEvent, null, runA, model.windowStart);
    expect(insp.payload).toContain('run event');
    const byLabel = Object.fromEntries(insp.summary.map((r) => [r.label, r.value]));
    expect(byLabel['Run outcome']).toBe('success');
  });

  it('string payload passes through as-is with an empty schema', () => {
    const s = span({ kind: 'turn', name: 'turn', startedAt: 5, payload: '{"input":…[TRUNCATED 10 chars]' });
    const insp = buildInspector({ ...llmEvent, spanId: s.id, kind: 'turn', name: 'turn' }, s, runA, 0);
    expect(insp.payload).toContain('TRUNCATED');
    expect(insp.schema).toEqual([]);
  });
});
