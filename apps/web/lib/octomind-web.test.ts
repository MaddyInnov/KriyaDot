// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for the Octomind-parity web surfaces.

import { describe, expect, it } from 'vitest';
import {
  buildFragmentReply,
  buildQuotedReply,
  builtinCommand,
  commandResultToText,
  detectWorkflowFileKind,
  formatDurationSeconds,
  groupDiscoveryResults,
  hasQuotedFragmentMarker,
  isBuiltinCommand,
  keylessLaneFor,
  mapCloudStatus,
  normalizeCommandResult,
  normalizeDryRunPlan,
  normalizeHumanAccounting,
  parseCopySegment,
  parseSlashInvocation,
  parseWorkflowJsonFile,
  quoteBlock,
  selectCopySegment,
  serializeWorkflowJson,
  serializeWorkflowToml,
  QUOTED_FRAGMENT_MARKER,
} from './octomind-web';

describe('#35 quoted replies (API /reply format)', () => {
  it('single quote matches buildQuotedReply shape', () => {
    const out = buildQuotedReply([{ ref: '7', role: 'assistant', text: 'line one\nline two' }], 'Agreed, but…');
    expect(out).toBe('[Replying to message #7 (assistant)]\n> line one\n> line two\n\nAgreed, but…');
  });
  it('multi-quote composes one block per message, in order', () => {
    const out = buildQuotedReply(
      [
        { ref: '1', role: 'user', text: 'first' },
        { ref: '3', role: 'assistant', text: 'second' },
      ],
      'point by point',
    );
    expect(out).toContain('[Replying to message #1 (user)]\n> first');
    expect(out).toContain('[Replying to message #3 (assistant)]\n> second');
    expect(out.endsWith('\n\npoint by point')).toBe(true);
    expect(out.indexOf('#1')).toBeLessThan(out.indexOf('#3'));
  });
  it('excerpts long messages at 600 chars with an ellipsis', () => {
    const long = 'x'.repeat(700);
    expect(quoteBlock(long)).toBe(`> ${'x'.repeat(600)}…`);
  });
});

describe('#37 fragment replies', () => {
  it('quotes only the fragment and carries the marker', () => {
    const out = buildFragmentReply({ ref: '2', role: 'assistant' }, 'just this bit', 'my answer');
    expect(out.startsWith(QUOTED_FRAGMENT_MARKER)).toBe(true);
    expect(hasQuotedFragmentMarker(out)).toBe(true);
    expect(out).toContain('[Replying to a selection from message #2 (assistant)]\n> just this bit');
    expect(out.endsWith('\n\nmy answer')).toBe(true);
    expect(out).not.toContain('the whole message');
  });
});

describe('slash command catalog + parsing', () => {
  it('covers the full Octomind command set', () => {
    for (const name of ['share', 'analyze', 'copy', 'done', 'info', 'report', 'usage', 'status', 'learning', 'schedule', 'compact', 'role', 'skill']) {
      expect(isBuiltinCommand(name), name).toBe(true);
      expect(builtinCommand(name)?.description.length).toBeGreaterThan(0);
    }
    expect(isBuiltinCommand('nope')).toBe(false);
  });
  it('parses invocations and rejects plain text', () => {
    expect(parseSlashInvocation('/role reviewer please')).toEqual({ name: 'role', args: 'reviewer please' });
    expect(parseSlashInvocation('/info')).toEqual({ name: 'info', args: '' });
    expect(parseSlashInvocation('hello /info')).toBeNull();
    expect(parseSlashInvocation('not a command')).toBeNull();
  });
});

describe('#172 /copy segments', () => {
  const msgs = [
    { role: 'user', text: 'q1' },
    { role: 'assistant', text: 'a1' },
    { role: 'user', text: 'q2' },
    { role: 'assistant', text: 'a2' },
  ];
  it('parses segment spellings', () => {
    expect(parseCopySegment('')).toBe('last');
    expect(parseCopySegment('all-assistant')).toBe('assistant');
    expect(parseCopySegment('all-user')).toBe('user');
    expect(parseCopySegment('whole')).toBe('all');
  });
  it('selects segment text', () => {
    expect(selectCopySegment(msgs, 'last').text).toBe('a2');
    expect(selectCopySegment(msgs, 'assistant').text).toBe('a1\n\na2');
    expect(selectCopySegment(msgs, 'user').text).toBe('q1\n\nq2');
    expect(selectCopySegment(msgs, 'all').text).toBe('user: q1\n\nassistant: a1\n\nuser: q2\n\nassistant: a2');
  });
});

describe('generic command-result renderer model', () => {
  it('flattens scalars, arrays and nested objects into sections', () => {
    const sections = normalizeCommandResult(
      { tokens: 1200, costUsd: 0.02, cache: { hits: 3, misses: 1 }, tags: ['a', 'b'], rows: [{ a: 1 }] },
      'Info',
    );
    expect(sections[0]!.title).toBe('Info');
    expect(sections[0]!.lines).toContain('tokens: 1200');
    expect(sections.find((s) => s.title === 'cache')?.lines).toEqual(['hits: 3', 'misses: 1']);
    expect(sections.find((s) => s.title === 'tags')?.lines).toEqual(['a', 'b']);
    expect(sections.find((s) => s.title === 'rows')?.pre).toContain('"a": 1');
  });
  it('handles strings and empty payloads, and renders text', () => {
    expect(normalizeCommandResult('plain')).toEqual([{ title: 'Result', lines: ['plain'] }]);
    expect(normalizeCommandResult(null)[0]!.lines).toEqual(['(no data)']);
    expect(commandResultToText({ a: 1 }, 'Info')).toContain('## Info\na: 1');
  });
});

describe('cloud status mapping', () => {
  it('maps disconnected / connected / running / sleeping / waking', () => {
    expect(mapCloudStatus({ ok: true, connected: false, studio: null }).state).toBe('disconnected');
    expect(mapCloudStatus({ ok: true, connected: true, studio: null }).state).toBe('connected');
    expect(mapCloudStatus({ connected: true, studio: { state: 'running', url: 'https://x' } }).publicUrl).toBe('https://x');
    expect(mapCloudStatus({ connected: true, studio: { state: 'running' } }).state).toBe('running');
    expect(mapCloudStatus({ connected: true, studio: { rawStatus: 'STOPPED' } }).state).toBe('sleeping');
    expect(mapCloudStatus({ connected: true, studio: { state: 'starting' } }).state).toBe('waking');
  });
  it('never invents a public URL', () => {
    expect(mapCloudStatus({ connected: true, studio: { state: 'running' } }).publicUrl).toBeNull();
  });
});

describe('keyless lane labels', () => {
  it('labels the keyless stack honestly', () => {
    expect(keylessLaneFor({ id: 'ollama' })?.label).toContain('on your machine');
    expect(keylessLaneFor({ id: 'ovh' })?.label).toContain('2 requests/min');
    expect(keylessLaneFor({ id: 'llm7' })?.label).toContain('best-effort');
    expect(keylessLaneFor({ id: 'ai-horde' })?.chatOnly).toBe(true);
  });
  it('pollinations is bring-your-own-key only', () => {
    const lane = keylessLaneFor({ id: 'pollinations' });
    expect(lane?.keyless).toBe(false);
    expect(lane?.byokOnly).toBe(true);
    expect(lane?.note).toContain('requires your own key');
  });
  it('catalog metadata wins over the fallback note', () => {
    const lane = keylessLaneFor({ id: 'ovh', keyless: true, limitsNote: 'Catalog says 3/min' });
    expect(lane?.note).toBe('Catalog says 3/min');
    expect(lane?.keyless).toBe(true);
  });
  it('unknown keyed providers get no lane', () => {
    expect(keylessLaneFor({ id: 'openai' })).toBeNull();
  });
});

describe('#47 human accounting normalization', () => {
  it('reads the global by-bot shape', () => {
    const v = normalizeHumanAccounting({
      approvals: { requested: 5, decided: 4, approved: 3, denied: 1, pending: 1 },
      humanResponse: { count: 4, totalSeconds: 400, medianSeconds: 90, p90Seconds: 200 },
      byBot: [{ botId: 'b1', interventions: 4, responseSeconds: 400 }],
    });
    expect(v.requested).toBe(5);
    expect(v.medianSeconds).toBe(90);
    expect(v.byBot[0]).toEqual({ botId: 'b1', interventions: 4, responseSeconds: 400 });
    // No time-saved field in the API → null, never invented.
    expect(v.estimatedTimeSavedSeconds).toBeNull();
  });
  it('reads a per-session shape and a provided time-saved estimate', () => {
    const v = normalizeHumanAccounting({
      estimatedTimeSavedMinutes: 30,
      session: { sessionId: 's1', interventions: 2, responseSeconds: 60 },
    });
    expect(v.estimatedTimeSavedSeconds).toBe(1800);
    expect(v.bySession[0]?.sessionId).toBe('s1');
  });
  it('formats durations', () => {
    expect(formatDurationSeconds(45)).toBe('45s');
    expect(formatDurationSeconds(125)).toBe('2m 5s');
    expect(formatDurationSeconds(3700)).toBe('1h 1m');
    expect(formatDurationSeconds(null)).toBe('—');
  });
});

describe('#166 discovery grouping', () => {
  it('groups flat results by kind and grouped payloads', () => {
    const g = groupDiscoveryResults({
      results: [
        { kind: 'bot', id: 'b1', name: 'Writer' },
        { kind: 'skill', id: 's1', name: 'SEO' },
        { kind: 'tool', id: 't1', name: 'web_search' },
        { kind: 'mcp-server', id: 'm1', name: 'fetch' },
        { kind: 'mystery', id: 'x1', name: '?' },
      ],
    });
    expect(g.bots.map((i) => i.id)).toEqual(['b1']);
    expect(g.skills.map((i) => i.id)).toEqual(['s1']);
    expect(g.capabilities.map((i) => i.id)).toEqual(['t1']);
    expect(g.mcp.map((i) => i.id)).toEqual(['m1']);
    expect(g.other).toHaveLength(1);
  });
  it('unwraps the real API hits shape ({hits:[{item,score}]})', () => {
    const g = groupDiscoveryResults({
      ok: true,
      hits: [
        { item: { kind: 'bot', id: 'b9', name: 'Chaser', description: 'invoices' }, score: 0.87 },
        { item: { kind: 'capability', id: 'c1', name: 'send_email' }, score: 0.5 },
      ],
    });
    expect(g.bots[0]).toMatchObject({ id: 'b9', name: 'Chaser', score: 0.87 });
    expect(g.capabilities[0]?.id).toBe('c1');
  });
});

describe('#143 workflow files', () => {
  const def = {
    id: 'wf1',
    name: 'Demo',
    nodes: [
      { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
      { id: 'work', type: 'agent', name: 'Work', config: { botId: 'writer', prompt: 'Hi "there"' } },
    ],
    edges: [['trigger', 'work']],
  };
  it('JSON envelope round-trips and validates the format tag', () => {
    const text = serializeWorkflowJson(def);
    expect(parseWorkflowJsonFile(text)).toEqual(def);
    expect(() => parseWorkflowJsonFile('{"format":"other","workflow":{}}')).toThrow(/unsupported format/);
    expect(() => parseWorkflowJsonFile('not json')).toThrow(/invalid JSON/);
  });
  it('TOML serialization carries the envelope fields and nodes', () => {
    const toml = serializeWorkflowToml(def);
    expect(toml).toContain('format = "kriyadot.workflow"');
    expect(toml).toContain('[[workflow.nodes]]');
    expect(toml).toContain('prompt = "Hi \\"there\\""');
    expect(toml).toContain('edges = [["trigger", "work"]]');
  });
  it('detects file kind by extension and content', () => {
    expect(detectWorkflowFileKind('{}', 'a.toml')).toBe('toml');
    expect(detectWorkflowFileKind('format = "x"', '')).toBe('toml');
    expect(detectWorkflowFileKind('  {"a":1}', '')).toBe('json');
  });
});

describe('#151 dry-run normalization', () => {
  it('flattens plan levels into steps and reads budget/errors', () => {
    const v = normalizeDryRunPlan({
      plan: {
        levels: [{ level: 0, nodes: [{ id: 'a', type: 'trigger', name: 'Start' }] }, { level: 1, nodes: [{ id: 'b', type: 'agent', name: 'Work', step: { model: 'm1', role: 'writer' } }] }],
        budget: { maxCostUsd: 1.5 },
        skipped: ['z'],
      },
      validationErrors: [{ message: 'bad edge' }],
    });
    expect(v.steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(v.steps[1]?.detail).toContain('model=m1');
    expect(v.estimatedCostUsd).toBe(1.5);
    expect(v.errors).toEqual(['bad edge']);
    expect(v.skipped).toEqual(['z']);
  });
});
