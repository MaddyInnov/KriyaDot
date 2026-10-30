// SPDX-License-Identifier: Apache-2.0
// CA-1 hook expansion tests: event catalog + gate semantics, async
// handlers, HTTP handlers (fake transport + a real localhost server),
// prompt handlers (fake evaluator), and config parsing/registration.
// Zero paid APIs.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  HOOK_EVENTS,
  GATE_HOOK_EVENTS,
  createHttpHookHandler,
  createPromptHookHandler,
  parseHookConfig,
  registerHookConfig,
  providerPromptEvaluator,
  parseHookVerdict,
  type HookFetchFn,
} from '../src/hooks.js';
import { MockProvider } from '../src/providers/mock.js';

describe('event catalog', () => {
  it('has all 16 events: the original 5 plus the CA-1 batch', () => {
    expect(HOOK_EVENTS).toHaveLength(16);
    for (const e of [
      'session.created', 'tool.before', 'tool.after', 'turn.ending', 'input.transform',
      'session.start', 'session.end', 'subagent.start', 'subagent.stop',
      'compact.before', 'compact.after', 'permission.request', 'file.changed',
      'worktree.create', 'worktree.remove', 'turn.start',
    ] as const) expect(HOOK_EVENTS).toContain(e);
  });

  it('gate set is exactly the five blockable events', () => {
    expect([...GATE_HOOK_EVENTS].sort()).toEqual(
      ['compact.before', 'permission.request', 'subagent.start', 'tool.before', 'worktree.create'].sort(),
    );
  });
});

describe('gate semantics', () => {
  it('honors cancel on the new gate events', async () => {
    for (const event of ['subagent.start', 'compact.before', 'worktree.create'] as const) {
      const bus = new HookBus();
      bus.on(event, () => ({ cancel: true, reason: 'halt' }) as const);
      const res = await bus.emit(event, { sessionId: 's', botId: 'b' });
      expect(res.cancelled, event).toBe(true);
      expect(res.reason).toBe('halt');
    }
  });

  it('ignores cancel on observer events', async () => {
    for (const event of ['session.start', 'session.end', 'turn.start', 'file.changed', 'worktree.remove', 'compact.after'] as const) {
      const bus = new HookBus();
      bus.on(event, () => ({ cancel: true, reason: 'halt' }) as const);
      const res = await bus.emit(event, { sessionId: 's', botId: 'b' });
      expect(res.cancelled, event).toBe(false);
    }
  });

  it('permission.request is advisory by default and block-only with canBlock', async () => {
    const payload = { sessionId: 's', botId: 'b', toolName: 'run_command', args: {}, decision: 'require-approval' as const };
    const advisory = new HookBus();
    advisory.on('permission.request', () => ({ cancel: true, reason: 'no' }) as const);
    expect((await advisory.emit('permission.request', payload)).cancelled).toBe(false);

    const denying = new HookBus();
    denying.on('permission.request', () => ({ cancel: true, reason: 'policy' }) as const, { canBlock: true });
    const res = await denying.emit('permission.request', payload);
    expect(res.cancelled).toBe(true);
    expect(res.reason).toBe('policy');
  });

  it('collects inject on subagent.stop and compact.after', async () => {
    const bus = new HookBus();
    bus.on('subagent.stop', () => ({ inject: 'note' }));
    bus.on('compact.after', () => ({ inject: 'folded' }));
    expect((await bus.emit('subagent.stop', { sessionId: 's', botId: 'b', task: 't', status: 'done', via: 'delegate' })).injections).toEqual(['note']);
    expect((await bus.emit('compact.after', { sessionId: 's', messageCount: 3, compacted: true })).injections).toEqual(['folded']);
  });
});

describe('async handlers', () => {
  it('fire-and-forget: emit does not wait and async verdicts cannot block', async () => {
    const bus = new HookBus();
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    bus.on('tool.before', async () => {
      await gate;
      finished = true;
      return { cancel: true, reason: 'too late' } as const;
    }, { async: true });
    const res = await bus.emit('tool.before', { sessionId: 's', botId: 'b', toolName: 'x', args: {} });
    expect(res.asyncFired).toBe(1);
    expect(res.cancelled).toBe(false);
    expect(finished).toBe(false);
    release();
    await bus.flushAsync();
    expect(finished).toBe(true);
  });

  it('collects async handler errors into asyncErrors, never throws', async () => {
    const bus = new HookBus();
    bus.on('turn.start', async () => { throw new Error('async boom'); }, { async: true });
    const res = await bus.emit('turn.start', { sessionId: 's', botId: 'b', isNewSession: false });
    expect(res.errors).toEqual([]);
    await bus.flushAsync();
    expect(bus.asyncErrors).toEqual([{ event: 'turn.start', message: 'async boom' }]);
  });
});

describe('parseHookVerdict', () => {
  it('recognizes block shapes and never treats allow as an upgrade', () => {
    expect(parseHookVerdict('{"cancel":true}')).toEqual({ cancel: true });
    expect(parseHookVerdict('{"decision":"deny","reason":"r"}')).toEqual({ cancel: true, reason: 'r' });
    expect(parseHookVerdict('{"allow":false}')).toEqual({ cancel: true });
    expect(parseHookVerdict('{"decision":"allow"}')).toBeUndefined();
    expect(parseHookVerdict('{"inject":"hi"}')).toEqual({ inject: 'hi' });
    expect(parseHookVerdict('plain text')).toBeUndefined();
    expect(parseHookVerdict('prefix {"decision":"block"} suffix')).toEqual({ cancel: true });
  });
});

describe('HTTP handlers (fake transport)', () => {
  const payload = { sessionId: 's', botId: 'b', toolName: 'run_command', args: {} };
  const fetchReturning = (status: number, body: string): HookFetchFn =>
    async () => ({ status, text: async () => body });

  it('blocks a gate event on an explicit block response', async () => {
    const bus = new HookBus();
    bus.on('tool.before', createHttpHookHandler('http://127.0.0.1:9/hook', {
      event: 'tool.before',
      fetchFn: fetchReturning(200, '{"decision":"block","reason":"http says no"}'),
    }));
    const res = await bus.emit('tool.before', payload);
    expect(res.cancelled).toBe(true);
    expect(res.reason).toBe('http says no');
  });

  it('passes on allow, and fails open on 500 / network error', async () => {
    const allow = new HookBus();
    allow.on('tool.before', createHttpHookHandler('http://x/h', { fetchFn: fetchReturning(200, '{"decision":"allow"}') }));
    expect((await allow.emit('tool.before', payload)).cancelled).toBe(false);

    const fiveHundred = new HookBus();
    fiveHundred.on('tool.before', createHttpHookHandler('http://x/h', { fetchFn: fetchReturning(500, '{"decision":"block"}') }));
    expect((await fiveHundred.emit('tool.before', payload)).cancelled).toBe(false);

    const down = new HookBus();
    down.on('tool.before', createHttpHookHandler('http://x/h', {
      fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    }));
    const res = await down.emit('tool.before', payload);
    expect(res.cancelled).toBe(false);
    expect(res.errors).toEqual([]);
  });

  it('fails open on timeout (abort)', async () => {
    const bus = new HookBus();
    bus.on('tool.before', createHttpHookHandler('http://x/h', {
      timeoutMs: 20,
      fetchFn: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }));
    const res = await bus.emit('tool.before', payload);
    expect(res.cancelled).toBe(false);
  });

  it('posts { event, payload } JSON to the URL', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchFn: HookFetchFn = async (url, init) => {
      seen.push({ url, body: init.body });
      return { status: 200, text: async () => '{}' };
    };
    const handler = createHttpHookHandler('https://hooks.example/x', { event: 'file.changed', fetchFn });
    await handler({ sessionId: 's1', botId: 'b1', toolName: 'write_file', path: 'a.ts' });
    expect(seen[0]!.url).toBe('https://hooks.example/x');
    const body = JSON.parse(seen[0]!.body) as { event: string; payload: { path: string } };
    expect(body.event).toBe('file.changed');
    expect(body.payload.path).toBe('a.ts');
  });
});

describe('HTTP handlers (real localhost server)', () => {
  let server: Server;
  let baseUrl = '';
  let lastBody = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        lastBody = body;
        const parsed = JSON.parse(body) as { payload?: { toolName?: string } };
        const block = parsed.payload?.toolName === 'danger_tool';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(block ? { decision: 'block', reason: 'server policy' } : { decision: 'allow' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('blocks danger_tool and allows others over real HTTP', async () => {
    const bus = new HookBus();
    bus.on('tool.before', createHttpHookHandler(baseUrl, { event: 'tool.before', timeoutMs: 5000 }));
    const blocked = await bus.emit('tool.before', { sessionId: 's', botId: 'b', toolName: 'danger_tool', args: {} });
    expect(blocked.cancelled).toBe(true);
    expect(blocked.reason).toBe('server policy');
    expect(JSON.parse(lastBody).event).toBe('tool.before');
    const allowed = await bus.emit('tool.before', { sessionId: 's', botId: 'b', toolName: 'read_file', args: {} });
    expect(allowed.cancelled).toBe(false);
  });
});

describe('prompt handlers (fake evaluator)', () => {
  const payload = { sessionId: 's', botId: 'b', toolName: 'run_command', args: { cmd: 'rm' } };

  it('blocks when the evaluator verdict is block; template is rendered', async () => {
    const seenPrompts: string[] = [];
    const bus = new HookBus();
    bus.on('tool.before', createPromptHookHandler('Judge {{toolName}} for {{botId}}: {{payload}}', {
      event: 'tool.before',
      evaluator: async ({ prompt }) => {
        seenPrompts.push(prompt);
        return '{"decision":"block","reason":"judged risky"}';
      },
    }));
    const res = await bus.emit('tool.before', payload);
    expect(res.cancelled).toBe(true);
    expect(res.reason).toBe('judged risky');
    expect(seenPrompts[0]).toContain('Judge run_command for b');
    expect(seenPrompts[0]).toContain('"cmd":"rm"');
  });

  it('fails open with no evaluator, an allow verdict, an error, or a timeout', async () => {
    const noEval = new HookBus();
    noEval.on('tool.before', createPromptHookHandler('anything', { event: 'tool.before' }));
    expect((await noEval.emit('tool.before', payload)).cancelled).toBe(false);

    const allow = new HookBus();
    allow.on('tool.before', createPromptHookHandler('x', { evaluator: async () => '{"decision":"allow"}' }));
    expect((await allow.emit('tool.before', payload)).cancelled).toBe(false);

    const boom = new HookBus();
    boom.on('tool.before', createPromptHookHandler('x', {
      evaluator: async () => { throw new Error('model down'); },
    }));
    expect((await boom.emit('tool.before', payload)).cancelled).toBe(false);

    const slow = new HookBus();
    slow.on('tool.before', createPromptHookHandler('x', {
      timeoutMs: 20,
      evaluator: () => new Promise<string>(() => {}),
    }));
    expect((await slow.emit('tool.before', payload)).cancelled).toBe(false);
  });

  it('providerPromptEvaluator wires the evaluate small-model path', async () => {
    const prev = process.env.MODEL_PROFILE_EVALUATE;
    process.env.MODEL_PROFILE_EVALUATE = 'mock/mock-model';
    try {
      const provider = new MockProvider([{ content: '{"decision":"block","reason":"small model"}' }]);
      const evaluator = providerPromptEvaluator(provider);
      const reply = await evaluator({ prompt: 'judge this', event: 'tool.before', payload });
      expect(JSON.parse(reply)).toEqual({ decision: 'block', reason: 'small model' });
      expect(provider.calls[0]!.model).toBe('mock-model');
    } finally {
      if (prev === undefined) delete process.env.MODEL_PROFILE_EVALUATE;
      else process.env.MODEL_PROFILE_EVALUATE = prev;
    }
  });
});

describe('hook config parsing + registration', () => {
  it('parses script entries back-compatibly (Octomind shape)', () => {
    const { entries, errors } = parseHookConfig([
      { kind: 'script', command: ['node', 'check.mjs'], events: ['tool.after', 'turn.ending'] },
      { kind: 'script', command: ['true'] },
    ]);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'script', command: ['node', 'check.mjs'], events: ['tool.after', 'turn.ending'] });
    expect(entries[1]!.events).toEqual(['tool.after']); // default preserved
  });

  it('parses http + prompt entries with async and additionalDeny flags', () => {
    const { entries, errors } = parseHookConfig([
      { kind: 'http', url: 'http://127.0.0.1:8080/h', events: ['permission.request'], additionalDeny: true, async: false },
      { kind: 'prompt', prompt: 'Block deletions', events: ['tool.before'], async: true, timeoutMs: 3000, name: 'judge' },
    ]);
    expect(errors).toEqual([]);
    expect(entries[0]).toMatchObject({ kind: 'http', url: 'http://127.0.0.1:8080/h', additionalDeny: true });
    expect(entries[1]).toMatchObject({ kind: 'prompt', prompt: 'Block deletions', async: true, timeoutMs: 3000, name: 'judge' });
  });

  it('reports bad entries and skips them (unknown events, bad url, empty prompt, unknown kind)', () => {
    const { entries, errors } = parseHookConfig([
      { kind: 'http', url: 'ftp://nope', events: ['tool.before'] },
      { kind: 'prompt', prompt: '  ', events: ['tool.before'] },
      { kind: 'webhook', url: 'http://x' },
      { kind: 'script', command: ['true'], events: ['not.an.event'] },
      'garbage',
    ]);
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(5);
  });

  it('registerHookConfig installs handlers per entry×event honoring flags', async () => {
    const bus = new HookBus();
    const fetchFn = vi.fn(async () => ({ status: 200, text: async () => '{"decision":"block","reason":"cfg"}' }));
    const { entries } = parseHookConfig([
      { kind: 'http', url: 'http://127.0.0.1:1/h', events: ['permission.request'], additionalDeny: true },
      { kind: 'http', url: 'http://127.0.0.1:1/h', events: ['session.start'], async: true },
    ]);
    const { registered, unsubs } = registerHookConfig(bus, entries, { fetchFn: fetchFn as unknown as HookFetchFn });
    expect(registered).toBe(2);
    expect(bus.handlerCount('permission.request')).toBe(1);
    expect(bus.handlerCount('session.start')).toBe(1);
    // additionalDeny: the configured http hook CAN add a deny on permission.request
    const res = await bus.emit('permission.request', {
      sessionId: 's', botId: 'b', toolName: 'x', args: {}, decision: 'require-approval' as const,
    });
    expect(res.cancelled).toBe(true);
    // async observer fires without blocking
    const started = await bus.emit('session.start', { sessionId: 's', botId: 'b' });
    expect(started.asyncFired).toBe(1);
    await bus.flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const u of unsubs) u();
    expect(bus.handlerCount('permission.request')).toBe(0);
  });
});
