// SPDX-License-Identifier: Apache-2.0
// Tests for interactive widgets (OpenMausBot parity P1 #15): payload
// validation for all 7 kinds + caps + unknown-field stripping, the SQLite
// store, the coordinator (await/settle/abort/expiry), the ask_user_question
// tool with a mock WidgetHost, and tool-result widget attachments.
// Zero paid API usage; all timers are milliseconds.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WIDGET_CAPS,
  WidgetCoordinator,
  WidgetNotFoundError,
  WidgetNotPendingError,
  WidgetStore,
  extractWidgetAttachment,
  validateWidgetPayload,
} from '../src/widgets.js';
import type {
  ButtonsWidgetPayload,
  WidgetAnswer,
  WidgetHost,
  WidgetPayload,
  WidgetRaiseInput,
  WidgetRecord,
} from '../src/widgets.js';
import type { StreamEvent, ToolContext } from '../src/types.js';
import { createBuiltInTools } from '../src/tools/builtin.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'widgets-test-'));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateWidgetPayload', () => {
  it('accepts all 7 kinds', () => {
    const payloads: WidgetPayload[] = [
      { kind: 'buttons', question: 'Pick one?', options: [{ id: 'a', label: 'A' }] },
      { kind: 'select', label: 'Choose', options: [{ id: 'a', label: 'A' }] },
      { kind: 'input', label: 'Name', placeholder: 'Jane', multiline: true },
      { kind: 'confirm', question: 'Delete it?', confirmLabel: 'Yes', cancelLabel: 'No' },
      { kind: 'progress', label: 'Working…', percent: 42 },
      { kind: 'table', columns: ['a', 'b'], rows: [[1, 2], [3, 4]] },
      { kind: 'image-view', caption: 'A chart', url: 'https://example.com/x.png' },
    ];
    for (const p of payloads) {
      const v = validateWidgetPayload(p);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.payload.kind).toBe(p.kind);
    }
  });

  it('strips unknown fields', () => {
    const v = validateWidgetPayload({
      kind: 'buttons',
      question: 'Q?',
      options: [{ id: 'a', label: 'A', sneaky: 1 }],
      injected: 'nope',
      multiSelect: true,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      const p = v.payload as ButtonsWidgetPayload;
      expect(p).not.toHaveProperty('injected');
      expect(p.options[0]).not.toHaveProperty('sneaky');
      expect(p.multiSelect).toBe(true);
    }
  });

  it('auto-generates option ids (o1, o2, …) when omitted', () => {
    const v = validateWidgetPayload({
      kind: 'buttons',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect((v.payload as ButtonsWidgetPayload).options.map((o) => o.id)).toEqual(['o1', 'o2']);
    }
  });

  it('enforces caps', () => {
    const many = Array.from({ length: WIDGET_CAPS.options + 1 }, (_, i) => ({ id: `o${i}`, label: 'x' }));
    expect(validateWidgetPayload({ kind: 'buttons', options: many }).ok).toBe(false);
    expect(
      validateWidgetPayload({ kind: 'buttons', options: [{ id: 'a', label: 'x'.repeat(WIDGET_CAPS.label + 1) }] }).ok,
    ).toBe(false);
    expect(
      validateWidgetPayload({
        kind: 'buttons',
        options: [{ id: 'a', label: 'A', description: 'x'.repeat(WIDGET_CAPS.description + 1) }],
      }).ok,
    ).toBe(false);
    expect(validateWidgetPayload({ kind: 'buttons', title: 'x'.repeat(WIDGET_CAPS.title + 1), options: [] }).ok).toBe(
      false,
    );
    expect(validateWidgetPayload({ kind: 'confirm', question: 'x'.repeat(WIDGET_CAPS.question + 1) }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'confirm', question: '' }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'confirm' }).ok).toBe(false);
    expect(
      validateWidgetPayload({
        kind: 'table',
        columns: Array.from({ length: WIDGET_CAPS.columns + 1 }, () => 'c'),
      }).ok,
    ).toBe(false);
    expect(
      validateWidgetPayload({ kind: 'table', columns: ['c'], rows: Array.from({ length: WIDGET_CAPS.rows + 1 }, () => []) })
        .ok,
    ).toBe(false);
    expect(validateWidgetPayload({ kind: 'table', columns: [] }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'image-view', url: `https://x/${'y'.repeat(WIDGET_CAPS.url)}` }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'image-view', dataUrl: 'x'.repeat(WIDGET_CAPS.dataUrl + 1) }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'progress', percent: 101 }).ok).toBe(false);
    expect(validateWidgetPayload({ kind: 'progress', percent: -1 }).ok).toBe(false);
  });

  it('rejects unknown kinds and non-objects', () => {
    expect(validateWidgetPayload({ kind: 'carousel' }).ok).toBe(false);
    expect(validateWidgetPayload(null).ok).toBe(false);
    expect(validateWidgetPayload('buttons').ok).toBe(false);
    expect(validateWidgetPayload({}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function buttonsPayload(): WidgetPayload {
  const v = validateWidgetPayload({ kind: 'buttons', question: 'Q?', options: [{ label: 'Yes' }, { label: 'No' }] });
  if (!v.ok) throw new Error('fixture invalid');
  return v.payload;
}

describe('WidgetStore', () => {
  it('raise/get/list round-trip with session + status filters', () => {
    const store = new WidgetStore(tempDir());
    const a = store.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    store.raise({ sessionId: 's1', botId: 'b1', kind: 'progress', payload: { kind: 'progress', percent: 10 }, interactive: false });
    store.raise({ sessionId: 's2', botId: 'b1', kind: 'confirm', payload: { kind: 'confirm', question: 'Sure?' }, interactive: true });
    expect(store.get(a.id)?.id).toBe(a.id);
    expect(store.get(a.id)?.status).toBe('pending');
    expect(store.get('missing')).toBeUndefined();
    expect(store.list('s1')).toHaveLength(2);
    expect(store.list('s2')).toHaveLength(1);
    expect(store.list('s1', 'pending')).toHaveLength(2);
    expect(store.list('s1', 'answered')).toHaveLength(0);
    expect(store.list()).toHaveLength(3);
    store.close();
  });

  it('answer persists the value; double-answer → WidgetNotPendingError; missing → WidgetNotFoundError', () => {
    const store = new WidgetStore(tempDir());
    const w = store.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    const answered = store.answer(w.id, { selected: ['o1'] });
    expect(answered.status).toBe('answered');
    expect(answered.value).toEqual({ selected: ['o1'] });
    expect(typeof answered.answeredAt).toBe('number');
    expect(() => store.answer(w.id, {})).toThrow(WidgetNotPendingError);
    expect(() => store.answer('missing', {})).toThrow(WidgetNotFoundError);
    store.close();
  });

  it('expireStale transitions only past-due pending widgets', () => {
    const store = new WidgetStore(tempDir(), { ttlMs: 30 });
    const w = store.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    expect(store.expireStale(Date.now() + 10_000)).toEqual([w.id]);
    expect(store.get(w.id)?.status).toBe('expired');
    expect(store.expireStale()).toEqual([]);
    store.close();
  });

  it('rejects invalid payloads on raise', () => {
    const store = new WidgetStore(tempDir());
    expect(() =>
      store.raise({
        sessionId: 's1',
        botId: 'b1',
        kind: 'confirm',
        // Forced invalid: missing required question.
        payload: { kind: 'confirm' } as unknown as WidgetPayload,
        interactive: true,
      }),
    ).toThrow(/invalid widget payload/);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

describe('WidgetCoordinator', () => {
  it('awaitAnswer resolves with the settled answer', async () => {
    const store = new WidgetStore(tempDir());
    const coord = new WidgetCoordinator(store);
    const w = await coord.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    const waiting = coord.awaitAnswer(w.id, 5000);
    const settled = coord.settle(w.id, { answered: true, value: { selected: ['o2'] } });
    expect(settled.status).toBe('answered');
    const ans = await waiting;
    expect(ans).toMatchObject({ answered: true, value: { selected: ['o2'] } });
    expect(typeof ans.answeredAt).toBe('number');
    store.close();
  });

  it('awaitAnswer on an already-answered widget resolves immediately', async () => {
    const store = new WidgetStore(tempDir());
    const coord = new WidgetCoordinator(store);
    const w = await coord.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    store.answer(w.id, 'hi');
    const ans = await coord.awaitAnswer(w.id, 50);
    expect(ans.answered).toBe(true);
    expect(ans.value).toBe('hi');
    store.close();
  });

  it('awaitAnswer fails closed with expired:true when the TTL passes', async () => {
    const store = new WidgetStore(tempDir(), { ttlMs: 30 });
    const coord = new WidgetCoordinator(store);
    const w = await coord.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    const ans = await coord.awaitAnswer(w.id, 5000);
    expect(ans.answered).toBe(false);
    expect(ans.expired).toBe(true);
    expect(store.get(w.id)?.status).toBe('expired');
    store.close();
  });

  it('awaitAnswer rejects on abort', async () => {
    const store = new WidgetStore(tempDir());
    const coord = new WidgetCoordinator(store);
    const w = await coord.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    const ctl = new AbortController();
    const waiting = coord.awaitAnswer(w.id, 5000, ctl.signal);
    ctl.abort(new Error('steered'));
    await expect(waiting).rejects.toThrow('steered');
    // Abort does not decide the widget: it stays pending.
    expect(store.get(w.id)?.status).toBe('pending');
    store.close();
  });

  it('settle throws on missing / non-pending widgets', async () => {
    const store = new WidgetStore(tempDir());
    const coord = new WidgetCoordinator(store);
    expect(() => coord.settle('missing', { answered: true })).toThrow(WidgetNotFoundError);
    const w = await coord.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    coord.settle(w.id, { answered: true, value: 1 });
    expect(() => coord.settle(w.id, { answered: true })).toThrow(WidgetNotPendingError);
    store.close();
  });

  it('sweepExpired fails in-flight waiters closed', async () => {
    const store = new WidgetStore(tempDir(), { ttlMs: 60_000 });
    const coord = new WidgetCoordinator(store);
    const w = await coord.raise({ sessionId: 's1', botId: 'b1', kind: 'buttons', payload: buttonsPayload(), interactive: true });
    const waiting = coord.awaitAnswer(w.id, 60_000);
    // Force expiry via an explicit future clock (deterministic, no waiting
    // for the widget's own timer).
    const expired = coord.sweepExpired(Date.now() + 120_000);
    expect(expired).toContain(w.id);
    expect(await waiting).toMatchObject({ answered: false, expired: true });
    expect(store.get(w.id)?.status).toBe('expired');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// ask_user_question tool (mock WidgetHost)
// ---------------------------------------------------------------------------

interface MockHostCtl {
  host: WidgetHost;
  events: StreamEvent[];
  callOrder: string[];
  raised: Array<{ id: string; input: WidgetRaiseInput }>;
  resolvers: Map<string, (a: WidgetAnswer) => void>;
  rejecters: Map<string, (e: unknown) => void>;
}

function makeMockHost(): MockHostCtl {
  let n = 0;
  const ctl = {
    events: [],
    callOrder: [],
    raised: [],
    resolvers: new Map(),
    rejecters: new Map(),
  } as MockHostCtl;
  ctl.host = {
    raise: async (input: WidgetRaiseInput): Promise<WidgetRecord> => {
      ctl.callOrder.push('raise');
      n += 1;
      const id = `w${n}`;
      ctl.raised.push({ id, input });
      return {
        id,
        sessionId: 's1',
        botId: 'b1',
        kind: input.kind,
        payload: input.payload,
        title: input.title,
        interactive: input.interactive,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    },
    emit: (e: StreamEvent): void => {
      ctl.callOrder.push('emit');
      ctl.events.push(e);
    },
    awaitAnswer: (widgetId: string, _timeoutMs: number): Promise<WidgetAnswer> =>
      new Promise<WidgetAnswer>((resolve, reject) => {
        ctl.callOrder.push('awaitAnswer');
        ctl.resolvers.set(widgetId, resolve);
        ctl.rejecters.set(widgetId, reject);
      }),
  };
  return ctl;
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ask_user_question tool', () => {
  async function getTool() {
    const dir = mkdtempSync(join(tmpdir(), 'ask-q-'));
    const tools = createBuiltInTools({ workspaceDir: dir });
    const tool = tools.find((t) => t.name === 'ask_user_question')!;
    expect(tool).toBeDefined();
    return tool;
  }

  it('is registered with a fallback-oriented description and strict schema', async () => {
    const tool = await getTool();
    expect(tool.description).toMatch(/paus/i);
    expect(tool.description).toMatch(/fallback/i);
    expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('returns a no-host error when no interactive UI is attached', async () => {
    const tool = await getTool();
    const ctx: ToolContext = { sessionId: 's1', botId: 'b1' };
    const res = (await tool.handler({ question: 'Q?' }, ctx)) as { error: string };
    expect(res.error).toMatch(/not available in this context/);
    expect(res.error).toMatch(/best judgment/);
  });

  it('requires at least one question', async () => {
    const tool = await getTool();
    const ctx: ToolContext = { sessionId: 's1', botId: 'b1', widget: makeMockHost().host };
    const res = (await tool.handler({}, ctx)) as { error: string };
    expect(res.error).toMatch(/at least one question/);
    const res2 = (await tool.handler({ questions: [] }, ctx)) as { error: string };
    expect(res2.error).toMatch(/at least one question/);
  });

  it('pauses, renders clickable options, and resumes on answer', async () => {
    const tool = await getTool();
    const ctl = makeMockHost();
    const ctx: ToolContext = { sessionId: 's1', botId: 'b1', widget: ctl.host };
    const p = tool.handler(
      { question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No', description: 'Wait' }] },
      ctx,
    );
    await tick();
    // Raised exactly one interactive buttons widget and emitted its event.
    expect(ctl.raised).toHaveLength(1);
    const raised = ctl.raised[0]!;
    expect(raised.input.interactive).toBe(true);
    const payload = raised.input.payload as ButtonsWidgetPayload;
    expect(payload.kind).toBe('buttons');
    expect(payload.options.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(payload.title).toBe('Question for you');
    const widgetEvents = ctl.events.filter((e) => e.type === 'widget');
    expect(widgetEvents).toHaveLength(1);
    expect(widgetEvents[0]).toMatchObject({ widgetId: raised.id, sessionId: 's1', interactive: true });
    // Answer it.
    ctl.resolvers.get(raised.id)!({ answered: true, value: { selected: ['o1'] }, answeredAt: Date.now() });
    const res = (await p) as {
      answers: Array<{ question: string; answered: boolean; selected: string[]; labels: string[]; freeText: string | null }>;
      allAnswered: boolean;
    };
    expect(res.allAnswered).toBe(true);
    expect(res.answers).toHaveLength(1);
    expect(res.answers[0]).toMatchObject({
      question: 'Deploy now?',
      answered: true,
      selected: ['o1'],
      labels: ['Yes'],
      freeText: null,
    });
    const answeredEvents = ctl.events.filter((e) => e.type === 'widget_answered');
    expect(answeredEvents).toHaveLength(1);
    expect(answeredEvents[0]).toMatchObject({ widgetId: raised.id, answer: { answered: true } });
  });

  it('resumes with answered:false on expiry', async () => {
    const tool = await getTool();
    const ctl = makeMockHost();
    const ctx: ToolContext = { sessionId: 's1', botId: 'b1', widget: ctl.host };
    const p = tool.handler({ question: 'Q?', timeoutMinutes: 1 }, ctx);
    await tick();
    const raised = ctl.raised[0]!;
    ctl.resolvers.get(raised.id)!({ answered: false, expired: true, answeredAt: Date.now() });
    const res = (await p) as { answers: Array<{ answered: boolean; selected: string[] }>; allAnswered: boolean };
    expect(res.allAnswered).toBe(false);
    expect(res.answers[0]).toMatchObject({ answered: false, selected: [] });
    const answeredEvents = ctl.events.filter((e) => e.type === 'widget_answered');
    expect(answeredEvents[0]).toMatchObject({ answer: { answered: false, expired: true } });
  });

  it('fails closed on abort', async () => {
    const tool = await getTool();
    const ctl = makeMockHost();
    const ctx: ToolContext = { sessionId: 's1', botId: 'b1', widget: ctl.host };
    const p = tool.handler({ question: 'Q?' }, ctx);
    await tick();
    const raised = ctl.raised[0]!;
    ctl.rejecters.get(raised.id)!(new Error('aborted'));
    const res = (await p) as { answers: Array<{ answered: boolean; selected: string[] }>; allAnswered: boolean };
    expect(res.allAnswered).toBe(false);
    expect(res.answers[0]).toMatchObject({ answered: false, selected: [] });
  });

  it('batch mode raises + emits ALL questions before awaiting any', async () => {
    const tool = await getTool();
    const ctl = makeMockHost();
    const ctx: ToolContext = { sessionId: 's1', botId: 'b1', widget: ctl.host };
    const p = tool.handler(
      {
        questions: [
          { question: 'First?', options: [{ label: 'A' }] },
          { question: 'Second?', options: [{ label: 'B' }], multiSelect: true, allowFreeText: true },
        ],
      },
      ctx,
    );
    await tick(20);
    expect(ctl.raised).toHaveLength(2);
    // Order: raise, emit, raise, emit — the first await only starts after
    // ALL questions are raised; answers are then awaited in order.
    expect(ctl.callOrder.slice(0, 4)).toEqual(['raise', 'emit', 'raise', 'emit']);
    expect(ctl.callOrder.filter((c) => c === 'awaitAnswer')).toHaveLength(1);
    const [first, second] = ctl.raised;
    expect((first!.input.payload as ButtonsWidgetPayload).question).toBe('First?');
    expect((second!.input.payload as ButtonsWidgetPayload).multiSelect).toBe(true);
    expect((second!.input.payload as ButtonsWidgetPayload).allowFreeText).toBe(true);
    ctl.resolvers.get(first!.id)!({ answered: true, value: ['o1'], answeredAt: Date.now() });
    await tick();
    // Now the second question is being awaited.
    expect(ctl.callOrder.filter((c) => c === 'awaitAnswer')).toHaveLength(2);
    ctl.resolvers.get(second!.id)!({
      answered: true,
      value: { selectedIds: ['o1'], freeText: 'something else' },
      answeredAt: Date.now(),
    });
    const res = (await p) as {
      answers: Array<{ selected: string[]; labels: string[]; freeText: string | null }>;
      allAnswered: boolean;
    };
    expect(res.allAnswered).toBe(true);
    expect(res.answers[0]).toMatchObject({ selected: ['o1'], labels: ['A'], freeText: null });
    expect(res.answers[1]).toMatchObject({ selected: ['o1'], labels: ['B'], freeText: 'something else' });
    expect(ctl.events.filter((e) => e.type === 'widget_answered')).toHaveLength(2);
  });

  it('clamps timeoutMinutes into 1..60', async () => {
    const tool = await getTool();
    const seen: number[] = [];
    const ctl = makeMockHost();
    ctl.host.awaitAnswer = (widgetId: string, timeoutMs: number): Promise<WidgetAnswer> => {
      seen.push(timeoutMs);
      return new Promise(() => {});
    };
    const ctx: ToolContext = { sessionId: 's1', botId: 'b1', widget: ctl.host };
    void tool.handler({ question: 'Q?', timeoutMinutes: 500 }, ctx);
    await tick();
    expect(seen[0]).toBe(60 * 60_000);
    const ctl2 = makeMockHost();
    const seen2: number[] = [];
    ctl2.host.awaitAnswer = (_w: string, ms: number): Promise<WidgetAnswer> => {
      seen2.push(ms);
      return new Promise(() => {});
    };
    void tool.handler({ question: 'Q?', timeoutMinutes: 0 }, { sessionId: 's1', botId: 'b1', widget: ctl2.host });
    await tick();
    expect(seen2[0]).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Tool-result attachments
// ---------------------------------------------------------------------------

describe('extractWidgetAttachment', () => {
  it('returns the validated payload when result has a valid widget key', () => {
    const att = extractWidgetAttachment({
      summary: 'done',
      widget: { kind: 'table', title: 'Results', columns: ['a'], rows: [[1]] },
    });
    expect(att?.kind).toBe('table');
    if (att?.kind === 'table') expect(att.columns).toEqual(['a']);
  });

  it('returns undefined for missing/invalid widget keys and non-objects', () => {
    expect(extractWidgetAttachment({ summary: 'done' })).toBeUndefined();
    expect(extractWidgetAttachment({ widget: { kind: 'carousel' } })).toBeUndefined();
    expect(extractWidgetAttachment({ widget: { kind: 'confirm' } })).toBeUndefined();
    expect(extractWidgetAttachment(null)).toBeUndefined();
    expect(extractWidgetAttachment('widget')).toBeUndefined();
    expect(extractWidgetAttachment([{ widget: { kind: 'input' } }])).toBeUndefined();
  });
});
