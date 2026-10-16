// SPDX-License-Identifier: Apache-2.0
// Tests for the native CLI drivers (OpenMausBot parity P0 #8):
// - TextAccumulator (cumulative vs discrete emission)
// - Claude Code stream-json parsing (text deltas, tool_use/tool_result, session id)
// - Codex --json JSONL parsing (thread.started, agent_message, command_execution)
// - permission-mode mapping per approval mode
// - resume args + session store round-trip
// - kill-switch on catastrophic commands (mocked child, zero real CLI invocations)

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CliSessionStore,
  NativeCliDriver,
  TextAccumulator,
  createNativeCliDriver,
  createParseState,
  getNativeCliSpec,
  hasNativeDriver,
  parseClaudeStreamLine,
  parseCodexJsonLine,
  type CliParseCallbacks,
} from '../src/providers/cli-driver.js';
import type { CliToolStreamEvent, ToolCall } from '../src/types.js';

function makeCbs(): CliParseCallbacks & {
  tokens: string[];
  toolEvents: CliToolStreamEvent[];
  sessionIds: string[];
  blocked: Array<{ call: ToolCall; reason: string }>;
} {
  const cbs = {
    tokens: [] as string[],
    toolEvents: [] as CliToolStreamEvent[],
    sessionIds: [] as string[],
    blocked: [] as Array<{ call: ToolCall; reason: string }>,
    onToken: (t: string) => cbs.tokens.push(t),
    onToolEvent: (e: CliToolStreamEvent) => cbs.toolEvents.push(e),
    onSessionId: (id: string) => cbs.sessionIds.push(id),
    onBlockedTool: (call: ToolCall, reason: string) => cbs.blocked.push({ call, reason }),
  };
  return cbs;
}

describe('TextAccumulator', () => {
  it('emits only the unseen suffix for cumulative emission', () => {
    const acc = new TextAccumulator();
    expect(acc.feed('Hello')).toBe('Hello');
    expect(acc.feed('Hello world')).toBe(' world');
    expect(acc.feed('Hello world')).toBe('');
    expect(acc.text).toBe('Hello world');
  });

  it('emits discrete chunks in full', () => {
    const acc = new TextAccumulator();
    expect(acc.feed('First message.')).toBe('First message.');
    // A wholly new message that does not extend the previous one is emitted.
    expect(acc.feed('Second message.')).toBe('Second message.');
  });

  it('dedupes exact repeats (result event echo)', () => {
    const acc = new TextAccumulator();
    acc.feed('done');
    expect(acc.feed('done')).toBe('');
  });
});

describe('Claude stream-json parsing', () => {
  it('streams text deltas and captures the session id', () => {
    const state = createParseState('claude-code');
    const cbs = makeCbs();
    parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }), state, cbs);
    parseClaudeStreamLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      state,
      cbs,
    );
    parseClaudeStreamLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } }),
      state,
      cbs,
    );
    parseClaudeStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Hello there', session_id: 'sess-1' }),
      state,
      cbs,
    );
    expect(cbs.sessionIds).toEqual(['sess-1', 'sess-1']);
    expect(cbs.tokens.join('')).toBe('Hello there');
    expect(state.finalText).toBe('Hello there');
  });

  it('surfaces tool_use and tool_result as tool events', () => {
    const state = createParseState('claude-code');
    const cbs = makeCbs();
    parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.txt' } }] },
      }),
      state,
      cbs,
    );
    parseClaudeStreamLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' }] },
      }),
      state,
      cbs,
    );
    expect(cbs.toolEvents).toHaveLength(2);
    expect(cbs.toolEvents[0]).toMatchObject({ kind: 'tool_call', cliId: 'claude-code' });
    expect((cbs.toolEvents[0] as { call: ToolCall }).call.name).toBe('claude.Read');
    expect(cbs.toolEvents[1]).toMatchObject({ kind: 'tool_result' });
  });

  it('never throws on malformed lines', () => {
    const state = createParseState('claude-code');
    const cbs = makeCbs();
    expect(() => parseClaudeStreamLine('not json', state, cbs)).not.toThrow();
    expect(() => parseClaudeStreamLine('{"type":', state, cbs)).not.toThrow();
    expect(() => parseClaudeStreamLine('{"type":"assistant"}', state, cbs)).not.toThrow();
  });
});

describe('Codex JSONL parsing', () => {
  it('captures thread_id and streams agent messages', () => {
    const state = createParseState('codex');
    const cbs = makeCbs();
    parseCodexJsonLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-9' }), state, cbs);
    parseCodexJsonLine(
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'PONG' } }),
      state,
      cbs,
    );
    expect(cbs.sessionIds).toEqual(['thread-9']);
    expect(cbs.tokens.join('')).toBe('PONG');
  });

  it('surfaces command_execution as tool_call + tool_result', () => {
    const state = createParseState('codex');
    const cbs = makeCbs();
    parseCodexJsonLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'ls -la', aggregated_output: 'total 0', exit_code: 0, status: 'completed' },
      }),
      state,
      cbs,
    );
    expect(cbs.toolEvents).toHaveLength(2);
    const call = (cbs.toolEvents[0] as { call: ToolCall }).call;
    expect(call.name).toBe('codex.exec');
    expect(call.args).toMatchObject({ command: 'ls -la' });
    expect((cbs.toolEvents[1] as { result: unknown }).result).toMatchObject({ exit_code: 0 });
  });

  it('ignores unknown event types (forward-compatible)', () => {
    const state = createParseState('codex');
    const cbs = makeCbs();
    expect(() =>
      parseCodexJsonLine(JSON.stringify({ type: 'something.new', foo: 1 }), state, cbs),
    ).not.toThrow();
    expect(cbs.tokens).toHaveLength(0);
  });
});

describe('kill-switch', () => {
  it('blocks catastrophic commands in Claude tool_use', () => {
    const state = createParseState('claude-code');
    const cbs = makeCbs();
    parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'rm -rf / --no-preserve-root' } }] },
      }),
      state,
      cbs,
    );
    expect(state.blocked).toBe(true);
    expect(cbs.blocked).toHaveLength(1);
    expect(cbs.toolEvents.some((e) => e.kind === 'tool_denied')).toBe(true);
    // The blocked call is NOT emitted as a normal tool_call.
    expect(cbs.toolEvents.some((e) => e.kind === 'tool_call')).toBe(false);
  });

  it('blocks catastrophic commands in Codex command_execution', () => {
    const state = createParseState('codex');
    const cbs = makeCbs();
    parseCodexJsonLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'c9', type: 'command_execution', command: 'sudo rm -rf /', aggregated_output: '', exit_code: 1 },
      }),
      state,
      cbs,
    );
    expect(state.blocked).toBe(true);
    expect(cbs.blocked).toHaveLength(1);
  });

  it('does not block benign commands', () => {
    const state = createParseState('codex');
    const cbs = makeCbs();
    parseCodexJsonLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'c2', type: 'command_execution', command: 'ls /tmp', aggregated_output: 'x', exit_code: 0 },
      }),
      state,
      cbs,
    );
    expect(state.blocked).toBe(false);
    expect(cbs.toolEvents.some((e) => e.kind === 'tool_call')).toBe(true);
  });
});

describe('permission mapping', () => {
  it('maps bypass to bypassPermissions for claude', () => {
    const spec = getNativeCliSpec('claude-code')!;
    expect(spec.permissionArgs('bypass')).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(spec.permissionArgs('auto')).toEqual(['--permission-mode', 'default']);
    expect(spec.permissionArgs('plan')).toEqual(['--permission-mode', 'default']);
  });

  it('maps bypass to danger-full-access for codex', () => {
    const spec = getNativeCliSpec('codex')!;
    expect(spec.permissionArgs('bypass')).toEqual([
      '--sandbox',
      'danger-full-access',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(spec.permissionArgs('auto')).toEqual(['--sandbox', 'workspace-write']);
  });

  it('only claude-code and codex have native drivers', () => {
    expect(hasNativeDriver('claude-code')).toBe(true);
    expect(hasNativeDriver('codex')).toBe(true);
    expect(hasNativeDriver('gemini')).toBe(false);
    expect(hasNativeDriver('pi')).toBe(false);
    expect(createNativeCliDriver('agent/gemini/gemini-2.5-pro')).toBeNull();
  });
});

describe('arg building', () => {
  it('builds claude streaming args with resume', () => {
    const spec = getNativeCliSpec('claude-code')!;
    const args = spec.buildArgs({ model: 'sonnet', prompt: 'hi', approvalMode: 'auto', resumeSessionId: 's1' });
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--resume');
    expect(args).toContain('s1');
    expect(args[args.length - 1]).toBe('hi');
  });

  it('builds codex resume args with the session id positionally', () => {
    const spec = getNativeCliSpec('codex')!;
    const args = spec.buildArgs({ model: 'gpt-5', prompt: 'hi', approvalMode: 'auto', resumeSessionId: 't1' });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--sandbox']);
    expect(args).toContain('t1');
    expect(args[args.length - 1]).toBe('hi');
    expect(args).toContain('--json');
  });
});

describe('CliSessionStore', () => {
  it('round-trips session ids per CLI', () => {
    const store = new CliSessionStore();
    store.set('codex', 'kriya-session-1', 'thread-abc');
    expect(store.get('codex', 'kriya-session-1')).toBe('thread-abc');
    expect(store.get('claude-code', 'kriya-session-1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Driver integration with a mocked child process (zero real CLI invocations).
// ---------------------------------------------------------------------------

interface FakeChild {
  emitter: EventEmitter;
  killed: boolean;
  kill: (sig?: string) => void;
}

function makeFakeSpawn(lines: string[], opts: { exitCode?: number; splitWrites?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawnFn = (command: string, args: string[]) => {
    calls.push({ command, args });
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child: FakeChild = {
      emitter,
      killed: false,
      kill: () => {
        child.killed = true;
        queueMicrotask(() => emitter.emit('close', null, 'SIGKILL'));
      },
    };
    children.push(child);
    // Emit the canned stdout asynchronously, like a real child.
    queueMicrotask(() => {
      for (const line of lines) {
        if (opts.splitWrites) {
          // Split each line into two writes to exercise the line buffer.
          const mid = Math.floor(line.length / 2);
          stdout.emit('data', Buffer.from(line.slice(0, mid)));
          stdout.emit('data', Buffer.from(line.slice(mid) + '\n'));
        } else {
          stdout.emit('data', Buffer.from(line + '\n'));
        }
      }
      queueMicrotask(() => emitter.emit('close', opts.exitCode ?? 0, null));
    });
    return {
      child: child as unknown as import('node:child_process').ChildProcess,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      done: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        emitter.on('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
      }),
    };
  };
  return { spawnFn, calls, children };
}

describe('NativeCliDriver', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('streams codex JSONL and stores the thread id for resume', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Hel' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Hello' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ];
    const { spawnFn, calls } = makeFakeSpawn(lines);
    const store = new CliSessionStore();
    const driver = new NativeCliDriver({ cliId: 'codex', model: 'gpt-5', command: 'fake-codex', spawnFn, sessionStore: store, timeoutMs: 5000, preflightAuthCheck: () => Promise.resolve(null) });
    const tokens: string[] = [];
    const result = await driver.chat(
      [{ role: 'user', content: 'hi' }],
      [],
      { model: 'gpt-5', onToken: (t) => tokens.push(t), sessionKey: 's1' },
    );
    expect(calls[0].args).toContain('--json');
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('untrusted');
    expect(tokens.join('')).toContain('Hello');
    expect(result.toolCalls).toEqual([]);
    // Session captured for resume.
    expect(store.get('codex', 's1')).toBe('thread-1');
  });

  it('resumes the stored session on the next turn', async () => {
    const lines = [JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' })];
    const { spawnFn, calls } = makeFakeSpawn(lines);
    const store = new CliSessionStore();
    store.set('codex', 's1', 'thread-1');
    const driver = new NativeCliDriver({ cliId: 'codex', model: 'gpt-5', command: 'fake-codex', spawnFn, sessionStore: store, timeoutMs: 5000, preflightAuthCheck: () => Promise.resolve(null) });
    await driver.chat([{ role: 'user', content: 'again' }], [], { model: 'gpt-5', sessionKey: 's1' });
    expect(calls[0].args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(calls[0].args).toContain('thread-1');
  });

  it('forwards CLI tool events via onCliToolEvent and never as runtime toolCalls', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi', exit_code: 0 },
      }),
    ];
    const { spawnFn } = makeFakeSpawn(lines);
    const driver = new NativeCliDriver({ cliId: 'codex', model: 'gpt-5', command: 'fake-codex', spawnFn, timeoutMs: 5000, preflightAuthCheck: () => Promise.resolve(null) });
    const toolEvents: CliToolStreamEvent[] = [];
    const result = await driver.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'gpt-5',
      onCliToolEvent: (e) => toolEvents.push(e),
    });
    expect(result.toolCalls).toEqual([]); // never re-executed by the runtime
    expect(toolEvents.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
  });

  it('kill-switch aborts the turn on catastrophic commands', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'rm -rf /', aggregated_output: '', exit_code: 0 },
      }),
    ];
    const { spawnFn, children } = makeFakeSpawn(lines);
    const driver = new NativeCliDriver({ cliId: 'codex', model: 'gpt-5', command: 'fake-codex', spawnFn, timeoutMs: 5000, preflightAuthCheck: () => Promise.resolve(null) });
    const toolEvents: CliToolStreamEvent[] = [];
    await expect(
      driver.chat([{ role: 'user', content: 'hi' }], [], {
        model: 'gpt-5',
        onCliToolEvent: (e) => toolEvents.push(e),
      }),
    ).rejects.toThrow(/catastrophic-command/);
    expect(children[0].killed).toBe(true);
    expect(toolEvents.some((e) => e.kind === 'tool_denied')).toBe(true);
  });

  it('maps bypass approval mode onto the CLI flags', async () => {
    const lines = [JSON.stringify({ type: 'thread.started', thread_id: 't' })];
    const { spawnFn, calls } = makeFakeSpawn(lines);
    const driver = new NativeCliDriver({ cliId: 'codex', model: 'gpt-5', command: 'fake-codex', spawnFn, timeoutMs: 5000, preflightAuthCheck: () => Promise.resolve(null) });
    await driver.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-5', approvalMode: 'bypass' });
    expect(calls[0].args).toContain('danger-full-access');
    expect(calls[0].args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('handles split writes across chunk boundaries', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't9' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'split-ok' } }),
    ];
    const { spawnFn } = makeFakeSpawn(lines, { splitWrites: true });
    const driver = new NativeCliDriver({ cliId: 'codex', model: 'gpt-5', command: 'fake-codex', spawnFn, timeoutMs: 5000, preflightAuthCheck: () => Promise.resolve(null) });
    const result = await driver.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-5' });
    expect(result.content).toContain('split-ok');
  });

  it('throws a clear error when the CLI is not installed', () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent-dir-for-tests';
    try {
      expect(() => createNativeCliDriver('agent/codex/gpt-5')).toThrow(/not installed or not on PATH/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('throws on malformed provider ids', () => {
    expect(() => createNativeCliDriver('not-a-cli-id')).toThrow(/Invalid agent-CLI provider id/);
  });
});

describe('preflight auth check', () => {
  it('fails fast when codex reports not logged in (no turn spawned)', async () => {
    const { spawnFn, calls } = makeFakeSpawn(['Not logged in']);
    const driver = new NativeCliDriver({
      cliId: 'codex',
      model: 'gpt-5',
      command: 'fake-codex',
      spawnFn,
      timeoutMs: 5000,
    });
    await expect(
      driver.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-5' }),
    ).rejects.toThrow(/not signed in/i);
    // Only the `login status` preflight ran; no turn was spawned.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['login', 'status']);
  });

  it('fails fast when the claude credentials file is absent', async () => {
    const { spawnFn, calls } = makeFakeSpawn([]);
    const driver = new NativeCliDriver({
      cliId: 'claude-code',
      model: 'sonnet',
      command: 'fake-claude',
      spawnFn,
      timeoutMs: 5000,
      homeDir: '/nonexistent-home-for-tests',
    });
    await expect(
      driver.chat([{ role: 'user', content: 'hi' }], [], { model: 'sonnet' }),
    ).rejects.toThrow(/not signed in/i);
    expect(calls).toHaveLength(0);
  });

  it('proceeds when the check passes', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } }),
    ];
    const { spawnFn, calls } = makeFakeSpawn(lines);
    const driver = new NativeCliDriver({
      cliId: 'codex',
      model: 'gpt-5',
      command: 'fake-codex',
      spawnFn,
      timeoutMs: 5000,
      preflightAuthCheck: () => Promise.resolve(null), // explicitly skipped
    });
    const result = await driver.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-5' });
    expect(result.content).toContain('ok');
    expect(calls).toHaveLength(1); // only the turn, no preflight
  });
});
