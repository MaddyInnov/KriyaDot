// SPDX-License-Identifier: Apache-2.0
// Tests for the CLI craft pass (Octomind parity Tier 3 #26):
//   1. --format jsonl event streaming
//   2. -c key=value per-run config overrides (never persisted)
//   3. `completion` bash/zsh scripts (dynamic names + static fallback)
//   4. the documented exit-code contract (0/1/2/75/130 constants)
//   5. named daemon sessions: run --daemon, send, sessions list/delete
// All API access is the scripted fake — zero real network.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandDeps } from '../src/commands.js';
import { parseChatEvent } from '../src/api.js';
import type { ChatEvent } from '../src/api.js';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_RESUMABLE, EXIT_SUCCESS, EXIT_USAGE } from '../src/exits.js';
import { parseConfigOverrides, UsageError } from '../src/overrides.js';
import { bashCompletionScript, withTimeout, zshCompletionScript } from '../src/completion.js';
import { getNamedSession, loadNamedSessions, saveNamedSession } from '../src/config.js';
import { makeDeps, makeFakeApi } from './fake-api.js';
import type { FakeApi } from './fake-api.js';

const BOTS = [
  { id: 'helper', name: 'Helper', model: 'llama-3.3-70b' },
  { id: 'coder', name: 'Coder' },
];

function run(argv: string[], fake: FakeApi = makeFakeApi({ bots: BOTS }), depOpts: Partial<CommandDeps> = {}) {
  const deps = makeDeps(fake, depOpts);
  return runCommand(parseArgs(argv), deps).then((code) => ({ code, deps, fake }));
}

/** Point the CLI config store at a temp dir for the block. */
function useTempConfigDir() {
  let dir = '';
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kriyadot-craft-'));
    prev = process.env.KRIYADOT_CONFIG_DIR;
    process.env.KRIYADOT_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.KRIYADOT_CONFIG_DIR;
    else process.env.KRIYADOT_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

describe('jsonl streaming output', () => {
  const script: ChatEvent[] = [
    { type: 'token', content: 'Hi' },
    { type: 'token', content: '!' },
    { type: 'tool_call', name: 'read_file', approvalRequired: false },
    { type: 'tool_result', name: 'read_file' },
    { type: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
  ];

  it('run --format jsonl prints one typed JSON object per event and nothing else', async () => {
    const { code, deps } = await run(
      ['run', '--bot', 'coder', '--message', 'hi', '--format', 'jsonl'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(code).toBe(0);
    const lines = deps.stdoutText().trim().split('\n');
    expect(lines).toHaveLength(script.length);
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toEqual(['token', 'token', 'tool_call', 'tool_result', 'done']);
    expect(events[0]).toEqual({ type: 'token', content: 'Hi' });
    expect(events[4]).toEqual({ type: 'done', usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it('chat <bot> --format jsonl streams too (bot positional path)', async () => {
    const { code, deps } = await run(
      ['chat', 'helper', 'hello', '--format', 'jsonl'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(code).toBe(0);
    const types = deps
      .stdoutText()
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('done');
    expect(types[0]).toBe('token');
  });

  it('jsonl keeps token text out of the stream on error and exits 1', async () => {
    const { code, deps } = await run(
      ['run', '--bot', 'coder', '--message', 'x', '--format', 'jsonl'],
      makeFakeApi({ bots: BOTS, chatScript: [{ type: 'token', content: 'partial' }, { type: 'error', message: 'boom' }] }),
    );
    expect(code).toBe(EXIT_ERROR);
    const lines = deps.stdoutText().trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toEqual({ type: 'error', message: 'boom' });
    expect(deps.stderrText()).toMatch(/boom/);
  });

  it('--format json and text output are unchanged by the jsonl path', async () => {
    const asJson = await run(
      ['run', '--bot', 'coder', '--message', 'hi', '--format', 'json'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    const parsed = JSON.parse(asJson.deps.stdoutText());
    expect(parsed.content).toBe('Hi!');
    expect(parsed.ok).toBe(true);
    const asText = await run(['run', '--bot', 'coder', '--message', 'hi'], makeFakeApi({ bots: BOTS, chatScript: script }));
    expect(asText.deps.stdoutText()).toBe('Hi!\n');
  });
});

describe('-c per-run config overrides', () => {
  const dir = useTempConfigDir();

  it('parseArgs collects repeatable -c values (both -c v and -c=v forms)', () => {
    const p = parseArgs(['run', '-c', 'bot=coder', '-c=model=m1', '--message', 'hi']);
    expect(p.global.overrides).toEqual(['bot=coder', 'model=m1']);
  });

  it('parseArgs rejects a dangling -c', () => {
    expect(() => parseArgs(['run', '-c'])).toThrow(/-c needs a key=value/);
  });

  it('parseConfigOverrides types the supported keys', () => {
    expect(
      parseConfigOverrides(['bot=coder', 'provider=groq', 'model=m1', 'apiUrl=http://localhost:5000/', 'format=jsonl']),
    ).toEqual({ bot: 'coder', provider: 'groq', model: 'm1', apiUrl: 'http://localhost:5000', format: 'jsonl' });
    expect(parseConfigOverrides(['model=a', 'model=b']).model).toBe('b');
  });

  it('parseConfigOverrides rejects unknown keys and bad values as UsageError', () => {
    expect(() => parseConfigOverrides(['bogus=1'])).toThrow(UsageError);
    expect(() => parseConfigOverrides(['bogus=1'])).toThrow(/Unknown -c key "bogus"/);
    expect(() => parseConfigOverrides(['model'])).toThrow(/key=value/);
    expect(() => parseConfigOverrides(['model='])).toThrow(/non-empty/);
    expect(() => parseConfigOverrides(['format=yaml'])).toThrow(/format/);
    expect(() => parseConfigOverrides(['apiUrl=ftp://x'])).toThrow(/apiUrl/);
  });

  it('-c bot= satisfies run without --bot and -c model/provider reach the API request', async () => {
    const { code, fake } = await run(['run', '-c', 'bot=coder', '-c', 'model=m-9', '-c', 'provider=groq', '--message', 'hi']);
    expect(code).toBe(0);
    expect(fake.chatRequests[0].botId).toBe('coder');
    expect(fake.chatRequests[0].model).toBe('m-9');
    expect(fake.chatRequests[0].providerId).toBe('groq');
  });

  it('-c overrides the --bot/--model/--format flags for that invocation', async () => {
    const script: ChatEvent[] = [{ type: 'token', content: 'yo' }, { type: 'done' }];
    const { code, deps, fake } = await run(
      ['run', '--bot', 'helper', '--model', 'flag-model', '--message', 'hi', '-c', 'bot=coder', '-c', 'model=override-model', '-c', 'format=jsonl'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(code).toBe(0);
    expect(fake.chatRequests[0].botId).toBe('coder');
    expect(fake.chatRequests[0].model).toBe('override-model');
    // format override won over the default text format → JSONL stream
    expect(JSON.parse(deps.stdoutText().trim().split('\n')[0]).type).toBe('token');
  });

  it('an unknown -c key is a usage error (exit 2) and no chat is sent', async () => {
    const { code, deps, fake } = await run(['run', '--bot', 'coder', '--message', 'hi', '-c', 'bogus=1']);
    expect(code).toBe(EXIT_USAGE);
    expect(deps.stderrText()).toMatch(/Unknown -c key "bogus"/);
    expect(fake.chatRequests).toHaveLength(0);
  });

  it('-c apiUrl= swaps the client via createApi for that run only', async () => {
    const fake = makeFakeApi({ bots: BOTS });
    const seen: string[] = [];
    const { code } = await run(['run', '--bot', 'coder', '--message', 'hi', '-c', 'apiUrl=http://localhost:9999'], fake, {
      createApi: (apiUrl: string) => {
        seen.push(apiUrl);
        return fake.asApi();
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(['http://localhost:9999']);
  });

  it('overrides are never persisted to the config file', async () => {
    const { code } = await run(['run', '--bot', 'coder', '--message', 'hi', '-c', 'model=secret-model', '-c', 'format=json']);
    expect(code).toBe(0);
    let raw = '';
    try {
      raw = readFileSync(join(dir(), 'cli.json'), 'utf8');
    } catch {
      raw = ''; // no config file was written at all — also fine
    }
    expect(raw).not.toContain('secret-model');
  });
});

describe('completion command', () => {
  it('bash script covers commands, flags and dynamic bot/workflow names', async () => {
    const fake = makeFakeApi({ bots: BOTS, routines: [{ id: 'morning-brief', name: 'Morning brief', botId: 'helper' }] });
    const { code, deps } = await run(['completion', 'bash'], fake);
    expect(code).toBe(0);
    const s = deps.stdoutText();
    expect(s).toContain('complete -F _kriyadot kriyadot');
    expect(s).toContain('_kriyadot_bots="helper coder"');
    expect(s).toContain('_kriyadot_workflows="morning-brief"');
    for (const cmd of ['chat', 'run', 'send', 'sessions', 'completion']) expect(s).toContain(cmd);
    for (const flag of ['--bot', '--daemon', '--format', '-c']) expect(s).toContain(flag);
    expect(s).toContain('text json jsonl');
  });

  it('zsh script has #compdef, dynamic names and flag specs', async () => {
    const fake = makeFakeApi({ bots: BOTS, routines: [{ id: 'r-1', name: 'R', botId: 'helper' }] });
    const { code, deps } = await run(['completion', 'zsh'], fake);
    expect(code).toBe(0);
    const s = deps.stdoutText();
    expect(s.startsWith('#compdef kriyadot')).toBe(true);
    expect(s).toContain("'helper'");
    expect(s).toContain("'coder'");
    expect(s).toContain("'r-1'");
    expect(s).toContain('--daemon');
    expect(s).toContain('(text json jsonl)');
  });

  it('bare `completion` prints both scripts', async () => {
    const { code, deps } = await run(['completion'], makeFakeApi({ bots: BOTS }));
    expect(code).toBe(0);
    expect(deps.stdoutText()).toContain('complete -F _kriyadot kriyadot');
    expect(deps.stdoutText()).toContain('#compdef kriyadot');
  });

  it('falls back to the static script silently when the API is unreachable', async () => {
    const failing = makeFakeApi({ bots: BOTS });
    const api = failing.asApi();
    (api as unknown as { listBots: () => Promise<never> }).listBots = async () => {
      throw new Error('connection refused');
    };
    const deps = makeDeps(failing, { api });
    const code = await runCommand(parseArgs(['completion', 'bash']), deps);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toContain('complete -F _kriyadot kriyadot');
    expect(deps.stdoutText()).toContain('_kriyadot_bots=""');
    expect(deps.stderrText()).toBe('');
  });

  it('falls back when the API hangs (short timeout, no hang)', async () => {
    const hanging = makeFakeApi({});
    const api = hanging.asApi();
    (api as unknown as { listBots: () => Promise<never> }).listBots = () => new Promise<never>(() => undefined);
    const deps = makeDeps(hanging, { api });
    const started = Date.now();
    const code = await runCommand(parseArgs(['completion', 'zsh']), deps);
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(deps.stdoutText()).toContain('#compdef kriyadot');
  });

  it('script generators sanitize names that are unsafe to embed', () => {
    const s = bashCompletionScript({ bots: ['ok-bot', 'bad name', 'evil";rm'], workflows: [] });
    expect(s).toContain('_kriyadot_bots="ok-bot"');
    // names with quotes/spaces are dropped, never embedded unsafely
    const z = zshCompletionScript({ bots: ["o'brien"], workflows: [] });
    expect(z).not.toContain("o'brien");
    expect(z).toContain('bots=()');
  });

  it('withTimeout resolves fast promises and rejects slow ones', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
    await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toThrow(/timed out/);
  });

  it('an unknown shell is a usage error (exit 2)', async () => {
    const { code } = await run(['completion', 'fish']);
    expect(code).toBe(EXIT_USAGE);
  });
});

describe('exit-code contract', () => {
  it('publishes the documented code values', () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_ERROR).toBe(1);
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_RESUMABLE).toBe(75);
    expect(EXIT_INTERRUPTED).toBe(130);
  });

  it('help documents the contract', async () => {
    const { code, deps } = await run(['help']);
    expect(code).toBe(0);
    const help = deps.stdoutText();
    expect(help).toContain('Exit codes:');
    expect(help).toContain('75');
    expect(help).toContain('Resumable stop');
    expect(help).toContain('130');
    expect(help).toContain('Usage error');
  });

  it('usage errors exit 2, runtime errors exit 1, success exits 0', async () => {
    expect((await run(['bots', 'delete'])).code).toBe(EXIT_USAGE);
    expect((await run(['chat', 'nope', 'hi'])).code).toBe(EXIT_ERROR);
    expect((await run(['bots', 'list'])).code).toBe(EXIT_SUCCESS);
  });

  it('parseChatEvent maps the spend_cap_reached SSE event', () => {
    expect(parseChatEvent('{"type":"spend_cap_reached","message":"daily cap hit"}')).toEqual({
      type: 'spend_cap_reached',
      message: 'daily cap hit',
    });
    expect(parseChatEvent('{"type":"spend_cap_reached"}')).toEqual({
      type: 'spend_cap_reached',
      message: 'Spend cap reached',
    });
  });

  it('a spend-cap stop exits 75 (resumable) in text, json and jsonl modes', async () => {
    const capScript: ChatEvent[] = [
      { type: 'token', content: 'partial work' },
      { type: 'spend_cap_reached', message: 'Daily spend cap reached ($5.00)' },
      { type: 'error', message: 'Daily spend cap reached ($5.00)' },
    ];
    const text = await run(['run', '--bot', 'coder', '--message', 'x'], makeFakeApi({ bots: BOTS, chatScript: capScript }));
    expect(text.code).toBe(EXIT_RESUMABLE);

    const json = await run(
      ['run', '--bot', 'coder', '--message', 'x', '--format', 'json'],
      makeFakeApi({ bots: BOTS, chatScript: capScript }),
    );
    expect(json.code).toBe(EXIT_RESUMABLE);
    const parsed = JSON.parse(json.deps.stdoutText());
    expect(parsed.ok).toBe(false);
    expect(parsed.resumable).toBe(true);

    const jsonl = await run(
      ['run', '--bot', 'coder', '--message', 'x', '--format', 'jsonl'],
      makeFakeApi({ bots: BOTS, chatScript: capScript }),
    );
    expect(jsonl.code).toBe(EXIT_RESUMABLE);
    const types = jsonl.deps
      .stdoutText()
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual(['token', 'spend_cap_reached', 'error']);
  });

  it('an ordinary turn error still exits 1, not 75', async () => {
    const { code } = await run(
      ['run', '--bot', 'coder', '--message', 'x'],
      makeFakeApi({ bots: BOTS, chatScript: [{ type: 'error', message: 'model exploded' }] }),
    );
    expect(code).toBe(EXIT_ERROR);
  });
});

describe('named daemon sessions', () => {
  const dir = useTempConfigDir();
  const script: ChatEvent[] = [{ type: 'token', content: 'working' }, { type: 'done' }];

  it('run --daemon records name → sessionId + bot in the config store', async () => {
    const { code, deps, fake } = await run(
      ['run', '--bot', 'coder', '--message', 'start the deploy watch', '--daemon', 'deploy'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(code).toBe(0);
    const named = getNamedSession('deploy');
    expect(named).not.toBeNull();
    expect(named!.botId).toBe('coder');
    expect(named!.sessionId).toBe(fake.chatRequests[0].sessionId);
    expect(deps.stderrText()).toMatch(/\[session\] "deploy"/);
    // stdout stays clean for scripts
    expect(deps.stdoutText()).toBe('working\n');
    // and it really is in the config file
    const saved = JSON.parse(readFileSync(join(dir(), 'cli.json'), 'utf8')) as {
      sessions?: Record<string, { sessionId: string; botId: string }>;
    };
    expect(saved.sessions?.deploy.sessionId).toBe(named!.sessionId);
  });

  it('a second --daemon run with the same name resumes the same session', async () => {
    const fake = makeFakeApi({ bots: BOTS, chatScript: script });
    await run(['run', '--bot', 'coder', '--message', 'one', '--daemon', 'deploy'], fake);
    await run(['run', '--bot', 'coder', '--message', 'two', '--daemon', 'deploy'], fake);
    expect(fake.chatRequests).toHaveLength(2);
    expect(fake.chatRequests[1].sessionId).toBe(fake.chatRequests[0].sessionId);
  });

  it('run --session <name> continues a named session without a raw id', async () => {
    saveNamedSession({ name: 'deploy', sessionId: 'sess-known', botId: 'coder', updatedAt: 1 });
    const { code, fake } = await run(
      ['run', '--bot', 'coder', '--message', 'status?', '--session', 'deploy'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(code).toBe(0);
    expect(fake.chatRequests[0].sessionId).toBe('sess-known');
  });

  it('run --session <raw-id> still works as before', async () => {
    const { code, fake } = await run(
      ['run', '--bot', 'coder', '--message', 'hi', '--session', 'raw-123'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(code).toBe(0);
    expect(fake.chatRequests[0].sessionId).toBe('raw-123');
  });

  it('run with both --daemon and --session is a usage error (exit 2)', async () => {
    const { code } = await run(['run', '--bot', 'coder', '--message', 'x', '--daemon', 'a', '--session', 'b']);
    expect(code).toBe(EXIT_USAGE);
  });

  it('send posts a follow-up to the named session with its recorded bot', async () => {
    saveNamedSession({ name: 'deploy', sessionId: 'sess-9', botId: 'coder', updatedAt: 1 });
    const { code, fake } = await run(['send', 'deploy', 'did it finish?'], makeFakeApi({ bots: BOTS, chatScript: script }));
    expect(code).toBe(0);
    expect(fake.chatRequests[0].botId).toBe('coder');
    expect(fake.chatRequests[0].sessionId).toBe('sess-9');
    expect(fake.chatRequests[0].message).toBe('did it finish?');
    // activity timestamp refreshed
    expect(getNamedSession('deploy')!.updatedAt).toBeGreaterThan(1);
  });

  it('send to an unknown name fails with how to start one (exit 1)', async () => {
    const { code, deps, fake } = await run(['send', 'ghost', 'hello']);
    expect(code).toBe(EXIT_ERROR);
    expect(deps.stderrText()).toMatch(/No named session "ghost"/);
    expect(deps.stderrText()).toMatch(/--daemon ghost/);
    expect(fake.chatRequests).toHaveLength(0);
  });

  it('send with no name is a usage error (exit 2)', async () => {
    const { code } = await run(['send']);
    expect(code).toBe(EXIT_USAGE);
  });

  it('sessions lists recorded sessions (text + json) and delete forgets one', async () => {
    saveNamedSession({ name: 'deploy', sessionId: 'sess-9', botId: 'coder', updatedAt: 1700000000000 });
    saveNamedSession({ name: 'research', sessionId: 'sess-3', botId: 'helper', updatedAt: 1700000000000 });

    const listed = await run(['sessions']);
    expect(listed.code).toBe(0);
    expect(listed.deps.stdoutText()).toMatch(/deploy\tbot:coder\tsess-9/);
    expect(listed.deps.stdoutText()).toMatch(/research\tbot:helper\tsess-3/);

    const asJson = await run(['sessions', '--format', 'json']);
    expect(JSON.parse(asJson.deps.stdoutText())).toHaveLength(2);

    const viaList = await run(['sessions', 'list']);
    expect(viaList.code).toBe(0);

    const deleted = await run(['sessions', 'delete', 'deploy']);
    expect(deleted.code).toBe(0);
    expect(loadNamedSessions().map((s) => s.name)).toEqual(['research']);
    expect((await run(['sessions', 'delete', 'deploy'])).code).toBe(EXIT_ERROR);
  });

  it('sessions with nothing recorded prints a helpful empty state', async () => {
    const { code, deps } = await run(['sessions']);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/No named sessions/);
  });

  it('recording a session preserves the stored token/apiUrl', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir(), 'cli.json'), JSON.stringify({ apiUrl: 'http://localhost:4000', token: 'keep-me' }), 'utf8');
    saveNamedSession({ name: 'x', sessionId: 's1', botId: 'coder', updatedAt: 1 });
    const saved = JSON.parse(readFileSync(join(dir(), 'cli.json'), 'utf8')) as { token: string; apiUrl: string };
    expect(saved.token).toBe('keep-me');
    expect(saved.apiUrl).toBe('http://localhost:4000');
  });
});
