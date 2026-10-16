// SPDX-License-Identifier: Apache-2.0
// Tests for the REPL (repl.ts): slash-command parsing and the interactive
// session loop with a fake line source and a scripted fake API.
import { describe, expect, it } from 'vitest';
import { parseSlashCommand, runRepl, runStreamingTurn } from '../src/repl.js';
import type { ChatEvent } from '../src/api.js';
import { makeDeps, makeFakeApi, makeFakeLines } from './fake-api.js';

describe('parseSlashCommand', () => {
  it('returns null for plain messages', () => {
    expect(parseSlashCommand('hello there')).toBeNull();
    expect(parseSlashCommand('  not a command  ')).toBeNull();
  });

  it('parses name and args', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' });
    expect(parseSlashCommand('/MODEL gpt-oss-120b')).toEqual({ name: 'model', args: 'gpt-oss-120b' });
    expect(parseSlashCommand('/quit')).toEqual({ name: 'quit', args: '' });
    expect(parseSlashCommand('/')).toEqual({ name: '', args: '' });
  });
});

describe('runStreamingTurn', () => {
  it('streams tokens and collects content + usage', async () => {
    const script: ChatEvent[] = [
      { type: 'token', content: 'Hello' },
      { type: 'token', content: ' world' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 2 } },
    ];
    const fake = makeFakeApi({ chatScript: script });
    const deps = makeDeps(fake);
    const seen: string[] = [];
    const result = await runStreamingTurn(
      { api: fake.asApi(), out: (s) => deps.stdout.write(s), err: () => undefined },
      { botId: 'helper', message: 'hi', sessionId: 's1', autoApprove: false },
      async () => true,
      (t) => seen.push(t),
    );
    expect(result.failed).toBe(false);
    expect(result.content).toBe('Hello world');
    expect(seen).toEqual(['Hello', ' world']);
    expect(result.usage?.outputTokens).toBe(2);
    expect(fake.chatRequests[0].sessionId).toBe('s1');
  });

  it('asks for approval and records the decision', async () => {
    const script: ChatEvent[] = [
      { type: 'approval_required', approvalId: 'ap-1', name: 'run_command' },
      { type: 'tool_result', name: 'run_command', denied: true },
      { type: 'done' },
    ];
    const fake = makeFakeApi({ chatScript: script });
    const deps = makeDeps(fake);
    const result = await runStreamingTurn(
      { api: fake.asApi(), out: () => undefined, err: (s) => deps.stderr.write(s) },
      { botId: 'helper', message: 'hi', sessionId: 's1', autoApprove: false },
      async () => false,
      () => undefined,
    );
    expect(result.failed).toBe(false);
    // let the void async approval IIFE settle
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.decisions).toEqual([{ approvalId: 'ap-1', decision: 'denied' }]);
    expect(deps.stderrText()).toMatch(/denied/);
  });

  it('reports turn errors as failed', async () => {
    const fake = makeFakeApi({ chatScript: [{ type: 'error', message: 'boom' }] });
    const deps = makeDeps(fake);
    const result = await runStreamingTurn(
      { api: fake.asApi(), out: () => undefined, err: () => undefined },
      { botId: 'helper', message: 'hi', sessionId: 's1', autoApprove: false },
      async () => true,
      () => undefined,
    );
    expect(result.failed).toBe(true);
    expect(result.error).toBe('boom');
  });

  it('passes autoApprove through to the API', async () => {
    const fake = makeFakeApi({});
    const deps = makeDeps(fake);
    await runStreamingTurn(
      { api: fake.asApi(), out: () => undefined, err: () => undefined },
      { botId: 'helper', message: 'hi', sessionId: 's1', autoApprove: true },
      async () => true,
      () => undefined,
    );
    expect(fake.chatRequests[0].autoApprove).toBe(true);
  });
});

describe('runRepl', () => {
  it('handles /help, /model listing, unknown commands and /quit', async () => {
    const fake = makeFakeApi({
      models: [{ providerId: 'groq', id: 'llama-3.3-70b', name: 'Llama 3.3 70B', free: true }],
    });
    const deps = makeDeps(fake);
    const lines = makeFakeLines(['/help', '/model', '/bogus', '/session', '/quit']);
    const code = await runRepl(
      {
        api: fake.asApi(),
        botName: 'Helper',
        out: (s) => deps.stdout.write(s),
        err: (s) => deps.stderr.write(s),
        lines,
        clearScreen: () => undefined,
      },
      { botId: 'helper' },
    );
    expect(code).toBe(0);
    expect(deps.stderrText()).toMatch(/REPL commands/);
    expect(deps.stderrText()).toMatch(/groq\/llama-3.3-70b/);
    expect(deps.stderrText()).toMatch(/unknown command \/bogus/);
    expect(deps.stderrText()).toMatch(/session sess_|session /);
  });

  it('sends a message, streams the reply, and asks for approvals', async () => {
    const fake = makeFakeApi({
      chatScript: [
        { type: 'token', content: 'Working on it' },
        { type: 'approval_required', approvalId: 'ap-9', name: 'write_file' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 3 } },
      ],
    });
    const deps = makeDeps(fake);
    const lines = makeFakeLines(['do the thing', 'y', '/quit']);
    const code = await runRepl(
      {
        api: fake.asApi(),
        botName: 'Coder',
        out: (s) => deps.stdout.write(s),
        err: (s) => deps.stderr.write(s),
        lines,
        clearScreen: () => undefined,
      },
      { botId: 'coder' },
    );
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/Working on it/);
    expect(lines.asked.some((q) => q.includes('[approval]'))).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.decisions).toEqual([{ approvalId: 'ap-9', decision: 'approved' }]);
    // same session reused across turns
    expect(fake.chatRequests).toHaveLength(1);
    expect(fake.chatRequests[0].sessionId).toBeTruthy();
  });

  it('exits on EOF', async () => {
    const fake = makeFakeApi({});
    const deps = makeDeps(fake);
    const code = await runRepl(
      {
        api: fake.asApi(),
        botName: 'Helper',
        out: (s) => deps.stdout.write(s),
        err: (s) => deps.stderr.write(s),
        lines: makeFakeLines([]),
        clearScreen: () => undefined,
      },
      { botId: 'helper' },
    );
    expect(code).toBe(0);
  });
});
