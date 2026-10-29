// SPDX-License-Identifier: Apache-2.0
// Tests for command dispatch (commands.ts) with a mocked API: list/show
// commands, JSON output, one-shot chat, piping, config and login flows.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandDeps } from '../src/commands.js';
import type { ChatEvent } from '../src/api.js';
import { makeDeps, makeFakeApi, makeFakeLines } from './fake-api.js';

const BOTS = [
  { id: 'helper', name: 'Helper', model: 'llama-3.3-70b' },
  { id: 'coder', name: 'Coder' },
];

function run(argv: string[], fake = makeFakeApi({ bots: BOTS }), depOpts: Partial<CommandDeps> = {}) {
  const deps = makeDeps(fake, depOpts);
  return runCommand(parseArgs(argv), deps).then((code) => ({ code, deps, fake }));
}

describe('meta commands', () => {
  it('--version prints the version', async () => {
    const { code, deps } = await run(['--version']);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/kriyadot \d+\.\d+\.\d+/);
  });

  it('bare invocation and help print usage', async () => {
    for (const argv of [[], ['help'], ['--help']]) {
      const { code, deps } = await run(argv);
      expect(code).toBe(0);
      expect(deps.stdoutText()).toMatch(/headless CLI for KriyaDot/);
    }
  });

  it('unknown commands fail with a hint (usage error, exit 2)', async () => {
    const { code, deps } = await run(['frobnicate']);
    expect(code).toBe(2);
    expect(deps.stderrText()).toMatch(/Unknown command/);
  });
});

describe('bots', () => {
  it('bots list prints a table', async () => {
    const { code, deps } = await run(['bots', 'list']);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/helper\tHelper/);
    expect(deps.stdoutText()).toMatch(/coder\tCoder/);
  });

  it('bots list --format json prints the array', async () => {
    const { code, deps } = await run(['bots', 'list', '--format', 'json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(deps.stdoutText());
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('helper');
  });
});

describe('chat / run one-shot', () => {
  const script: ChatEvent[] = [
    { type: 'token', content: 'Hi!' },
    { type: 'done', usage: { inputTokens: 3, outputTokens: 1 } },
  ];

  it('chat <bot> message streams text and exits 0', async () => {
    const { code, deps, fake } = await run(['chat', 'helper', 'hello'], makeFakeApi({ bots: BOTS, chatScript: script }));
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/Hi!/);
    expect(fake.chatRequests[0].botId).toBe('helper');
    expect(fake.chatRequests[0].message).toBe('hello');
  });

  it('resolves bots by name case-insensitively', async () => {
    const { code, fake } = await run(['chat', 'CODER', 'hi'], makeFakeApi({ bots: BOTS, chatScript: script }));
    expect(code).toBe(0);
    expect(fake.chatRequests[0].botId).toBe('coder');
  });

  it('errors on an unknown bot, listing available ones', async () => {
    const { code, deps } = await run(['chat', 'nope', 'hi']);
    expect(code).toBe(1);
    expect(deps.stderrText()).toMatch(/Unknown bot "nope"/);
    expect(deps.stderrText()).toMatch(/helper/);
  });

  it('run --format json emits a single JSON object and exit 0', async () => {
    const { code, deps } = await run(
      ['run', '--bot', 'coder', '--message', 'list files', '--format', 'json'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(deps.stdoutText());
    expect(parsed).toEqual({
      ok: true,
      bot: 'coder',
      sessionId: expect.any(String),
      content: 'Hi!',
      usage: { inputTokens: 3, outputTokens: 1 },
    });
  });

  it('run exits 1 with {ok:false} JSON on turn error', async () => {
    const { code, deps } = await run(
      ['run', '--bot', 'coder', '--message', 'x', '--format', 'json'],
      makeFakeApi({ bots: BOTS, chatScript: [{ type: 'error', message: 'model exploded' }] }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(deps.stdoutText());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('model exploded');
  });

  it('reads the message from piped stdin', async () => {
    const { code, fake } = await run(['chat', 'helper'], makeFakeApi({ bots: BOTS, chatScript: script }), {
      readStdinAll: async () => 'piped message\n',
    });
    expect(code).toBe(0);
    expect(fake.chatRequests[0].message).toBe('piped message');
  });

  it('errors when no message and stdin is not a pipe', async () => {
    const { code, deps } = await run(['chat', 'helper']);
    expect(code).toBe(1);
    expect(deps.stderrText()).toMatch(/No message given/);
  });

  it('passes --auto-approve through', async () => {
    const { fake } = await run(
      ['run', '--bot', 'helper', '--message', 'x', '--auto-approve'],
      makeFakeApi({ bots: BOTS, chatScript: script }),
    );
    expect(fake.chatRequests[0].autoApprove).toBe(true);
  });

  it('denies approvals headlessly by default', async () => {
    const { code, deps, fake } = await run(
      ['run', '--bot', 'helper', '--message', 'x'],
      makeFakeApi({
        bots: BOTS,
        chatScript: [{ type: 'approval_required', approvalId: 'a1', name: 'run_command' }, { type: 'done' }],
      }),
    );
    expect(code).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.decisions).toEqual([{ approvalId: 'a1', decision: 'denied' }]);
    expect(deps.stderrText()).toMatch(/headless.*denied/);
  });

  it('chat with no message on a TTY starts the REPL', async () => {
    const { code, deps } = await run(['chat', 'helper'], makeFakeApi({ bots: BOTS }), {
      isTTY: true,
      createLineSource: () => makeFakeLines(['/quit']),
    });
    expect(code).toBe(0);
    expect(deps.stderrText()).toMatch(/Chatting with Helper/);
  });
});

describe('threads', () => {
  const threads = [
    { id: 'sess_1', botId: 'helper', title: 'First', createdAt: '2026-01-01', messageCount: 4, lastMessageTs: null },
  ];
  const messages = [
    { id: 1, role: 'user', content: 'q1' },
    { id: 2, role: 'assistant', content: 'a1' },
  ];

  it('threads list prints a table', async () => {
    const { code, deps } = await run(['threads', 'list'], makeFakeApi({ threads }));
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/sess_1\thelper\tFirst\t4 msgs/);
  });

  it('threads list --format json', async () => {
    const { code, deps } = await run(['threads', 'list', '--format', 'json'], makeFakeApi({ threads }));
    expect(code).toBe(0);
    expect(JSON.parse(deps.stdoutText())).toHaveLength(1);
  });

  it('threads show prints messages with ids', async () => {
    const { code, deps } = await run(['threads', 'show', 'sess_1'], makeFakeApi({ threads, messages }));
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/\[1\] you: q1/);
    expect(deps.stdoutText()).toMatch(/\[2\] assistant: a1/);
  });

  it('threads show --limit trims to the last n', async () => {
    const { deps } = await run(['threads', 'show', 'sess_1', '--limit', '1'], makeFakeApi({ threads, messages }));
    expect(deps.stdoutText()).not.toMatch(/q1/);
    expect(deps.stdoutText()).toMatch(/a1/);
  });

  it('threads branch requires --from and reports the new thread', async () => {
    const fake = makeFakeApi({ branchResult: { id: 'sess_2', title: 'Alt', botId: 'helper' } });
    const { code, deps } = await run(['threads', 'branch', 'sess_1', '--from', '2'], fake);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/Branched to sess_2/);
    const bad = await run(['threads', 'branch', 'sess_1'], makeFakeApi({}));
    expect(bad.code).toBe(1);
    expect(bad.deps.stderrText()).toMatch(/Missing --from/);
  });
});

describe('routines, models, mcp', () => {
  it('routines list + run', async () => {
    const fake = makeFakeApi({ routines: [{ id: 'r1', name: 'Morning brief', botId: 'helper', enabled: true }] });
    const listed = await run(['routines', 'list'], fake);
    expect(listed.code).toBe(0);
    expect(listed.deps.stdoutText()).toMatch(/r1\tMorning brief/);
    const started = await run(['routines', 'run', 'r1'], fake);
    expect(started.code).toBe(0);
    expect(started.deps.stdoutText()).toMatch(/Run started: run-123/);
  });

  it('models list', async () => {
    const fake = makeFakeApi({ models: [{ providerId: 'groq', id: 'llama-3.3-70b', name: 'Llama 3.3 70B', free: true }] });
    const { code, deps } = await run(['models', 'list'], fake);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/groq\/llama-3.3-70b.*free/);
  });

  it('mcp list shows health', async () => {
    const fake = makeFakeApi({
      mcpServers: [{ id: 'fs', label: 'filesystem', enabled: true, health: { status: 'stopped' } }],
    });
    const { code, deps } = await run(['mcp', 'list'], fake);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/fs\tfilesystem\tenabled\tstopped/);
  });
});

describe('config', () => {
  it('config shows the effective config with the token masked', async () => {
    const { code, deps } = await run(['config']);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toMatch(/apiUrl/);
    expect(deps.stdoutText()).not.toMatch(/test-token/);
    expect(deps.stdoutText()).toMatch(/\*\*\*set\*\*\*/);
  });

  it('config get api prints the URL', async () => {
    const { deps } = await run(['config', 'get', 'api']);
    expect(deps.stdoutText()).toMatch(/http:\/\/localhost:4000/);
  });
});

describe('login', () => {
  it('fails clearly when the server is unreachable', async () => {
    const fake = makeFakeApi({ health: false });
    const { code, deps } = await run(['login'], fake);
    expect(code).toBe(1);
    expect(deps.stderrText()).toMatch(/Cannot reach KriyaDot API/);
  });

  it('saves the token from --token after verifying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-login-'));
    const prev = process.env.KRIYADOT_CONFIG_DIR;
    process.env.KRIYADOT_CONFIG_DIR = dir;
    try {
      const fake = makeFakeApi({ bots: BOTS });
      const { code, deps } = await run(['login', '--token', 'new-token', '--api', 'http://localhost:4000'], fake, {
        isTTY: false,
      });
      expect(code).toBe(0);
      expect(deps.stdoutText()).toMatch(/Logged in to http:\/\/localhost:4000/);
      const saved = JSON.parse(readFileSync(join(dir, 'cli.json'), 'utf8')) as {
        apiUrl: string;
        token: string;
      };
      expect(saved.apiUrl).toBe('http://localhost:4000');
      expect(saved.token).toBe('new-token');
    } finally {
      process.env.KRIYADOT_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
