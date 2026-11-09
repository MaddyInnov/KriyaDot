// SPDX-License-Identifier: Apache-2.0
// CliAuthManager bridge hardening (2026-11-09): identity-verified status
// (a same-named impostor is NOT "present" and yields a plain-words
// namesake warning), login fast-fail against namesakes / missing CLIs
// (never spawn the impostor), the Claude Code paste-code flow (the code
// is written to the child's stdin exactly once), and `claude auth
// status` JSON handling. Spawns are injected fakes; resolution is
// injected too, so nothing here touches the real PATH.

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CliAuthManager,
  type CliResolution,
  type SpawnHandle,
} from '../src/providers/cli-auth.js';

let fakeHome = '';

interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdinWrites: string[];
  child: EventEmitter & { kill: () => void; killed: boolean };
  emitStdout: (s: string) => void;
  close: (code?: number) => void;
}

function makeSpawn(handle: (proc: FakeProc, command: string, args: string[]) => void) {
  const procs: FakeProc[] = [];
  const spawnFn = (command: string, args: string[]): SpawnHandle => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const childEmitter = new EventEmitter();
    const proc: FakeProc = {
      stdout,
      stderr,
      stdinWrites: [],
      child: Object.assign(childEmitter, {
        killed: false,
        kill: () => {
          proc.child.killed = true;
          queueMicrotask(() => childEmitter.emit('close', null, 'SIGKILL'));
        },
      }),
      emitStdout: (s: string) => stdout.emit('data', Buffer.from(s)),
      close: (code = 0) => queueMicrotask(() => childEmitter.emit('close', code, null)),
    };
    procs.push(proc);
    queueMicrotask(() => handle(proc, command, args));
    return {
      child: proc.child as unknown as import('node:child_process').ChildProcess,
      stdin: {
        write: (s: string) => {
          proc.stdinWrites.push(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
    };
  };
  return { spawnFn, procs };
}

const files = new Map<string, { content: string; mtime: number }>();

function makeManager(overrides: Record<string, unknown> = {}) {
  return new CliAuthManager({
    homeDir: fakeHome,
    pathDirs: ['/fake/bin'],
    fileExists: (p: string) => files.has(p),
    fileMtimeMs: (p: string) => files.get(p)?.mtime,
    readText: (p: string) => files.get(p)?.content,
    pollIntervalMs: 5,
    loginTimeoutMs: 500,
    urlTimeoutMs: 500,
    ...overrides,
  } as never);
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cli-auth-bridge-'));
  files.clear();
});

describe('namesake handling', () => {
  const namesakeResolution: CliResolution = {
    namesakeWarning:
      'Found a program named "codex" on this machine, but it isn\'t OpenAI\'s Codex CLI (it appears to be a Python program).',
  };

  it('getStatus: cliPresent is false and the warning is surfaced', async () => {
    const mgr = makeManager({ resolveCli: () => namesakeResolution });
    const st = await mgr.getStatus('codex');
    expect(st.cliPresent).toBe(false);
    expect(st.signedIn).toBe(false);
    expect(st.namesakeWarning).toMatch(/isn't OpenAI's Codex CLI/);
  });

  it('startLogin: fast-fails with the namesake warning and never spawns', async () => {
    const { spawnFn, procs } = makeSpawn(() => undefined);
    const mgr = makeManager({ resolveCli: () => namesakeResolution, spawnFn });
    const login = mgr.startLogin('codex');
    const done = await login.done;
    expect(done.ok).toBe(false);
    expect(done.reason).toMatch(/isn't OpenAI's Codex CLI/);
    expect(procs.length).toBe(0);
    await expect(login.url).rejects.toThrow(/isn't OpenAI's Codex CLI/);
  });
});

describe('claude paste-code login', () => {
  it('spawns `claude auth login`, captures the URL, and submitCode writes the code to stdin once', async () => {
    const credPath = join(fakeHome, '.claude', '.credentials.json');
    const { spawnFn, procs } = makeSpawn((proc) => {
      proc.emitStdout('Open https://claude.ai/oauth/authorize?x=1 to sign in\nPaste code here if prompted > ');
    });
    const mgr = makeManager({
      spawnFn,
      resolveCli: () => ({ path: '/fake/bin/claude' }),
    });
    const login = mgr.startLogin('claude');
    const url = await login.url;
    expect(url).toContain('https://claude.ai/oauth/authorize');
    expect(login.submitCode).toBeTypeOf('function');
    login.submitCode!('  CODE-123  ');
    login.submitCode!('CODE-AGAIN'); // second submission is ignored
    expect(procs[0]!.stdinWrites).toEqual(['CODE-123\n']);
    // Simulate the CLI finishing: a usable credential file appears (the
    // bridge shape probe reads the real file under homeDir).
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-z', expiresAt: Date.now() + 3_600_000 } }),
    );
    const done = await login.done;
    expect(done.ok).toBe(true);
  });

  it('non-claude logins expose no submitCode', async () => {
    const { spawnFn } = makeSpawn((proc) => {
      proc.emitStdout('Visit https://example.com/device and enter the code\n');
    });
    const mgr = makeManager({ spawnFn, resolveCli: () => ({ path: '/fake/bin/codex' }) });
    const login = mgr.startLogin('codex');
    await login.url;
    expect(login.submitCode).toBeUndefined();
    login.cancel();
  });
});

describe('claude auth status via the CLI JSON', () => {
  it('reports signed-in + email from `claude auth status` output', async () => {
    const { spawnFn } = makeSpawn((proc) => {
      proc.emitStdout('{"loggedIn":true,"authMethod":"claude.ai","email":"me@example.com"}');
      proc.close(0);
    });
    const mgr = makeManager({ spawnFn, resolveCli: () => ({ path: '/fake/bin/claude' }) });
    const st = await mgr.getStatus('claude');
    expect(st.cliPresent).toBe(true);
    expect(st.signedIn).toBe(true);
    expect(st.accountHint).toBe('me@example.com');
  });
});
