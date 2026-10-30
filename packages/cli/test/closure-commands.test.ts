// SPDX-License-Identifier: Apache-2.0
// Dispatch-level tests for the closure rows: bridge wiring (#104),
// learning commands (#83/#86), config validate/init + logLevel
// (#111/#181), --continue (#32), --schema (#108), live-daemon send
// (#102), REPL /reply + session commands + elicitation (#35/#114/#51).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandDeps } from '../src/commands.js';
import type { ChatEvent } from '../src/api.js';
import { runRepl, runStreamingTurn } from '../src/repl.js';
import { registerDaemon } from '../src/daemon.js';
import { loadConfigFile, saveNamedSession } from '../src/config.js';
import { EXIT_ERROR, EXIT_USAGE } from '../src/exits.js';
import { makeDeps, makeFakeApi, makeFakeLines } from './fake-api.js';

const BOTS = [
  { id: 'helper', name: 'Helper' },
  { id: 'coder', name: 'Coder' },
];

let cfgDir: string;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'kriyadot-closure-'));
  savedEnv = { ...process.env };
  process.env.KRIYADOT_CONFIG_DIR = cfgDir;
});
afterEach(() => {
  process.env = savedEnv;
  rmSync(cfgDir, { recursive: true, force: true });
});

/** Deps whose api.request is stubbed by `responder` (bridge/learning/inject surfaces). */
function depsWithRequest(responder: (path: string, method: string, body: unknown) => unknown, fake = makeFakeApi({ bots: BOTS })) {
  const deps = makeDeps(fake);
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const api = deps.api as unknown as Record<string, unknown>;
  api.request = async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ path, method: init?.method ?? 'GET', body });
    return responder(path, init?.method ?? 'GET', body);
  };
  return { deps, requests, fake };
}

function run(argv: string[], deps: CommandDeps) {
  return runCommand(parseArgs(argv), deps).then((code) => ({ code, deps }));
}

describe('bridge dispatch (#104)', () => {
  it('runCommand routes kriyadot bridge list to the federation endpoint', async () => {
    const { deps, requests } = depsWithRequest((path) => {
      if (path === '/federation/peers') return { ok: true, peers: [] };
      throw new Error(`unexpected ${path}`);
    });
    const { code } = await run(['bridge', 'list'], deps);
    expect(code).toBe(0);
    expect(requests).toEqual([{ path: '/federation/peers', method: 'GET', body: undefined }]);
    expect(deps.stdoutText()).toMatch(/No linked peers/);
  });

  it('unknown bridge subcommand is a usage error before any API call', async () => {
    const { deps, requests } = depsWithRequest(() => ({}));
    const { code } = await run(['bridge', 'frobnicate'], deps);
    expect(code).toBe(EXIT_USAGE);
    expect(requests).toHaveLength(0);
  });
});

describe('learning commands (#83/#86)', () => {
  const atom = { id: 'a1', fact: 'User likes tea', category: 'preference', tier: 'hot', createdAt: 1700000000000 };
  function learningDeps() {
    return depsWithRequest((path, method) => {
      if (path.startsWith('/memory/atoms?')) return { ok: true, atoms: [atom, { id: 'a2', fact: 'User likes coffee' }] };
      if (path.startsWith('/memory/atoms/a1')) return method === 'DELETE' ? { ok: true } : { ok: true, atom };
      if (path === '/routing/rules') return { ok: true, rules: [{ id: 'r1', status: 'shadow' }] };
      if (path.startsWith('/routing/rules/r1/')) return { ok: true, rules: [] };
      throw new Error(`unexpected ${method} ${path}`);
    });
  }

  it('list applies the glob filter over fact/id', async () => {
    const { deps } = learningDeps();
    const { code } = await run(['learning', 'list', '--bot', 'helper', '--glob', '*tea*'], deps);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/likes tea/);
    expect(deps.stdoutText()).not.toMatch(/coffee/);
  });

  it('list requires --bot', async () => {
    const { deps } = learningDeps();
    const { code } = await run(['learning', 'list'], deps);
    expect(code).toBe(EXIT_USAGE);
    expect(deps.stderrText()).toMatch(/--bot/);
  });

  it('clear refuses without --yes', async () => {
    const { deps, requests } = learningDeps();
    const { code } = await run(['learning', 'clear', '--bot', 'helper'], deps);
    expect(code).toBe(EXIT_USAGE);
    expect(requests).toHaveLength(0);
  });

  it('evolution approve/reject/rollback hit the distinct endpoints', async () => {
    const { deps, requests } = learningDeps();
    expect((await run(['learning', 'evolution', 'approve', 'r1'], deps)).code).toBe(0);
    expect((await run(['learning', 'evolution', 'reject', 'r1'], deps)).code).toBe(0);
    expect((await run(['learning', 'evolution', 'rollback', 'r1'], deps)).code).toBe(0);
    expect(requests.map((r) => r.path)).toEqual([
      '/routing/rules/r1/promote',
      '/routing/rules/r1/reject',
      '/routing/rules/r1/rollback',
    ]);
  });
});

describe('config validate / init / logLevel (#111/#181)', () => {
  it('init writes a commented template that then validates clean; second init refuses', async () => {
    const fake = makeFakeApi({ bots: BOTS });
    const deps = makeDeps(fake);
    expect((await run(['config', 'init'], deps)).code).toBe(0);
    expect(existsSync(join(cfgDir, 'cli.json'))).toBe(true);
    expect(readFileSync(join(cfgDir, 'cli.json'), 'utf8')).toMatch(/\/\/ KriyaDot CLI config/);
    expect((await run(['config', 'validate'], deps)).code).toBe(0);
    expect((await run(['config', 'init'], deps)).code).toBe(EXIT_ERROR);
    // the commented template actually loads
    expect(loadConfigFile().logLevel).toBe('info');
  });

  it('validate warns on unknown keys and fails on bad types', async () => {
    writeFileSync(join(cfgDir, 'cli.json'), JSON.stringify({ apiUrl: 'ftp://x', nope: 1 }));
    const deps = makeDeps(makeFakeApi({ bots: BOTS }));
    const { code } = await run(['config', 'validate'], deps);
    expect(code).toBe(EXIT_ERROR);
    expect(deps.stderrText()).toMatch(/unknown key "nope"/);
  });

  it('logLevel silent suppresses the CLI\u2019s own [session] diagnostics (#181)', async () => {
    const fake = makeFakeApi({ bots: BOTS, chatScript: [{ type: 'done' } as ChatEvent] });
    const loud = makeDeps(fake);
    expect((await run(['run', '--bot', 'coder', '--message', 'hi', '--daemon', 'work'], loud)).code).toBe(0);
    expect(loud.stderrText()).toMatch(/\[session\] "work"/);
    const quiet = makeDeps(fake, { cfg: { apiUrl: 'http://localhost:4000', token: 't', logLevel: 'silent' } });
    expect((await run(['run', '--bot', 'coder', '--message', 'hi', '--daemon', 'work2'], quiet)).code).toBe(0);
    expect(quiet.stderrText()).not.toMatch(/\[session\]/);
  });

  it('config set logLevel persists and get reads it back', async () => {
    const deps = makeDeps(makeFakeApi({ bots: BOTS }));
    expect((await run(['config', 'set', 'logLevel', 'debug'], deps)).code).toBe(0);
    expect(loadConfigFile().logLevel).toBe('debug');
    const deps2 = makeDeps(makeFakeApi({ bots: BOTS }), { cfg: loadConfigFile() });
    expect((await run(['config', 'get', 'logLevel'], deps2)).code).toBe(0);
    expect(deps2.stdoutText()).toBe('debug\n');
  });
});

describe('--continue (#32)', () => {
  it('chat --continue resumes the server\u2019s most recent thread for the bot', async () => {
    const fake = makeFakeApi({
      bots: BOTS,
      threads: [
        { id: 'sess-old', botId: 'coder', title: 'Older', createdAt: '', messageCount: 1, lastMessageTs: '2026-01-01T00:00:00Z' },
        { id: 'sess-new', botId: 'coder', title: 'Newest chat', createdAt: '', messageCount: 3, lastMessageTs: '2026-01-03T00:00:00Z' },
      ],
      chatScript: [{ type: 'done' } as ChatEvent],
    });
    const deps = makeDeps(fake);
    const { code } = await run(['chat', 'coder', '--continue=true', 'hello again'], deps);
    expect(code).toBe(0);
    expect(fake.chatRequests[0]?.sessionId).toBe('sess-new');
    expect(deps.stderrText()).toMatch(/continuing server session "Newest chat"/);
  });

  it('send --continue uses the most recent local named session', async () => {
    saveNamedSession({ name: 'one', sessionId: 's1', botId: 'coder', updatedAt: 100 });
    saveNamedSession({ name: 'two', sessionId: 's2', botId: 'coder', updatedAt: 200 });
    const fake = makeFakeApi({ bots: BOTS, chatScript: [{ type: 'done' } as ChatEvent] });
    const deps = makeDeps(fake);
    const { code } = await run(['send', '--continue=true', '--message', 'ping'], deps);
    expect(code).toBe(0);
    expect(fake.chatRequests[0]?.sessionId).toBe('s2');
  });

  it('sessions list merges server thread titles over local records', async () => {
    saveNamedSession({ name: 'work', sessionId: 'sess-new', botId: 'coder', updatedAt: 5 });
    const fake = makeFakeApi({
      bots: BOTS,
      threads: [{ id: 'sess-new', botId: 'coder', title: 'Server Title', createdAt: '', messageCount: 1, lastMessageTs: null }],
    });
    const deps = makeDeps(fake);
    const { code } = await run(['sessions'], deps);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/"Server Title"/);
  });
});

describe('--schema (#108)', () => {
  const schema = '{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}';

  function schemaDeps(replies: string[]) {
    const fake = makeFakeApi({ bots: BOTS });
    const deps = makeDeps(fake);
    const seen: Array<{ message: string; responseFormat?: unknown }> = [];
    let i = 0;
    deps.api = {
      listBots: async () => BOTS,
      sendChat: async (req: { message: string; responseFormat?: unknown }, cb: { onEvent: (ev: ChatEvent) => void }) => {
        seen.push(req);
        const controller = new AbortController();
        const content = replies[Math.min(i++, replies.length - 1)] ?? '';
        queueMicrotask(() => {
          cb.onEvent({ type: 'token', content });
          cb.onEvent({ type: 'done' });
        });
        return controller;
      },
    } as unknown as CommandDeps['api'];
    return { deps, seen };
  }

  it('passes responseFormat through and prints a valid reply', async () => {
    const { deps, seen } = schemaDeps(['{"name":"ok"}']);
    const { code } = await run(['run', '--bot', 'coder', '--message', 'hi', '--schema', schema], deps);
    expect(code).toBe(0);
    expect(seen[0]?.responseFormat).toMatchObject({ type: 'json_schema' });
    expect(deps.stdoutText()).toContain('{"name":"ok"}');
  });

  it('does one repair retry and prints the repaired reply', async () => {
    const { deps, seen } = schemaDeps(['{"name":42}', '{"name":"fixed"}']);
    const { code } = await run(['run', '--bot', 'coder', '--message', 'hi', '--schema', schema], deps);
    expect(code).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.message).toMatch(/did not satisfy the required output schema/);
    expect(deps.stdoutText()).toContain('{"name":"fixed"}');
  });

  it('fails when the reply is still invalid after the repair retry', async () => {
    const { deps } = schemaDeps(['nope', 'still nope']);
    const { code } = await run(['run', '--bot', 'coder', '--message', 'hi', '--schema', schema], deps);
    expect(code).toBe(EXIT_ERROR);
    expect(deps.stderrText()).toMatch(/still invalid/);
  });
});

describe('send into a live daemon (#102)', () => {
  it('injects via the API endpoint instead of starting a new turn', async () => {
    saveNamedSession({ name: 'work', sessionId: 's1', botId: 'coder', updatedAt: 1 });
    registerDaemon(cfgDir, {
      name: 'work',
      sessionId: 's1',
      botId: 'coder',
      pid: process.pid,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    });
    const { deps, requests, fake } = depsWithRequest((path) => {
      if (path === '/daemon/sessions/work/inject') return { ok: true, delivery: 'injected-into-live-turn' };
      throw new Error(`unexpected ${path}`);
    });
    const { code } = await run(['send', 'work', 'hello daemon'], deps);
    expect(code).toBe(0);
    expect(requests.map((r) => r.path)).toEqual(['/daemon/sessions/work/inject']);
    expect(fake.chatRequests).toHaveLength(0); // no new turn was started
    expect(deps.stdoutText()).toMatch(/Injected into live daemon/);
  });
});

describe('REPL: /reply, session commands, elicitation (#35/#114/#51)', () => {
  function replDeps(fake = makeFakeApi({ bots: BOTS, chatScript: [{ type: 'token', content: 'Answer one' }, { type: 'done' }] as ChatEvent[] })) {
    return makeDeps(fake);
  }

  it('/reply quotes the referenced message in the API format and sends it as a turn', async () => {
    const fake = makeFakeApi({
      bots: BOTS,
      chatScript: [{ type: 'token', content: 'Answer one' }, { type: 'done' }] as ChatEvent[],
    });
    const deps = replDeps(fake);
    const lines = makeFakeLines(['first message', '/reply 1 follow up', '/quit']);
    const code = await runRepl(
      { api: fake.asApi(), botName: 'Coder', out: (s) => deps.stdout.write(s), err: (s) => deps.stderr.write(s), lines, clearScreen: () => undefined },
      { botId: 'coder' },
    );
    expect(code).toBe(0);
    expect(fake.chatRequests).toHaveLength(2);
    expect(fake.chatRequests[1]?.message).toBe('[Replying to message #1 (user)]\n> first message\n\nfollow up');
  });

  it('/reply with an unknown ref errors and sends nothing', async () => {
    const fake = makeFakeApi({ bots: BOTS });
    const deps = replDeps(fake);
    const lines = makeFakeLines(['/reply 9 hi', '/quit']);
    await runRepl(
      { api: fake.asApi(), botName: 'Coder', out: (s) => deps.stdout.write(s), err: (s) => deps.stderr.write(s), lines, clearScreen: () => undefined },
      { botId: 'coder' },
    );
    expect(fake.chatRequests).toHaveLength(0);
    expect(deps.stderrText()).toMatch(/no message matches "9"/);
  });

  it('forwards /usage and /copy to the session-command dispatch; /copy uses the clipboard sink', async () => {
    const fake = makeFakeApi({ bots: BOTS });
    const deps = replDeps(fake);
    const forwarded: string[] = [];
    const copied: string[] = [];
    const lines = makeFakeLines(['/usage', '/copy last', '/quit']);
    await runRepl(
      {
        api: fake.asApi(),
        botName: 'Coder',
        out: (s) => deps.stdout.write(s),
        err: (s) => deps.stderr.write(s),
        lines,
        clearScreen: () => undefined,
        sessionCommand: async (_sid, _bot, text) => {
          forwarded.push(text);
          return text.startsWith('/copy')
            ? { reply: 'segment text', data: { segment: 'last', text: 'segment text' } }
            : { reply: 'Session usage: 5 tokens' };
        },
        copyToClipboard: (t) => (copied.push(t), true),
      },
      { botId: 'coder' },
    );
    expect(forwarded).toEqual(['/usage', '/copy last']);
    expect(deps.stdoutText()).toMatch(/Session usage: 5 tokens/);
    expect(copied).toEqual(['segment text']);
    expect(deps.stderrText()).toMatch(/copied to clipboard/);
  });

  it('renders assistant markdown at turn end', async () => {
    const fake = makeFakeApi({
      bots: BOTS,
      chatScript: [{ type: 'token', content: '# Report\n\n**Done** now' }, { type: 'done' }] as ChatEvent[],
    });
    const deps = replDeps(fake);
    const lines = makeFakeLines(['summarize', '/quit']);
    await runRepl(
      { api: fake.asApi(), botName: 'Coder', out: (s) => deps.stdout.write(s), err: (s) => deps.stderr.write(s), lines, clearScreen: () => undefined },
      { botId: 'coder' },
    );
    expect(deps.stdoutText()).toContain('Report');
    expect(deps.stdoutText()).not.toContain('**Done**');
  });

  it('routes an elicitation event to the terminal handler; declines clearly without one', async () => {
    const ev = { type: 'elicitation', id: 'e1', message: 'Which city?', requestedSchema: { properties: { city: { type: 'string' } } } } as unknown as ChatEvent;
    const fake = makeFakeApi({ bots: BOTS, chatScript: [ev, { type: 'done' }] });
    const deps = makeDeps(fake);
    const seen: string[] = [];
    await runStreamingTurn(
      { api: fake.asApi(), out: () => undefined, err: (s) => seen.push(s) },
      {
        botId: 'coder',
        message: 'hi',
        sessionId: 's1',
        autoApprove: false,
        elicitationHandler: async (req) => ({ action: 'accept', content: { city: req.message } }),
      },
      async () => true,
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.join('')).toMatch(/terminal answer: accept/);

    const seen2: string[] = [];
    await runStreamingTurn(
      { api: fake.asApi(), out: () => undefined, err: (s) => seen2.push(s) },
      { botId: 'coder', message: 'hi', sessionId: 's1', autoApprove: false },
      async () => true,
      () => undefined,
    );
    expect(seen2.join('')).toMatch(/declined \(no terminal elicitation handler/);
  });
});
