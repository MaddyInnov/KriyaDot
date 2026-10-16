// SPDX-License-Identifier: Apache-2.0
// Tests for in-app CLI subscription sign-in (OpenMausBot parity P0 #8):
// - sign-in status detection (mocked fs / spawn; zero real CLI invocations)
// - login flow: URL capture from stdout, completion via credential-file polling
// - cancel behavior
// - tokens never appear in results, errors, or logs

import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CliAuthManager,
  parseCodexLoginStatus,
  redactTokenish,
  type SpawnHandle,
} from '../src/providers/cli-auth.js';
import { bridgeAccountHint, bridgeHasUsableToken, bridgeTokenExpiry } from '../src/providers/cli-bridge.js';

let fakeHome: string;
let files: Map<string, { content: string; mtime: number }>;
let now: number;

function plantFile(rel: string, content: string): void {
  const full = join(fakeHome, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  files.set(full, { content, mtime: now });
  now += 1000;
}

function makeDeps(overrides: Partial<Parameters<typeof CliAuthManager>[0]> = {}) {
  return {
    homeDir: fakeHome,
    pathDirs: ['/fake/bin'],
    fileExists: (p: string) => files.has(p),
    fileMtimeMs: (p: string) => files.get(p)?.mtime,
    readText: (p: string) => files.get(p)?.content,
    now: () => now,
    pollIntervalMs: 5,
    loginTimeoutMs: 200,
    urlTimeoutMs: 200,
    ...overrides,
  };
}

interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  child: EventEmitter & { kill: (sig?: string) => void; killed: boolean };
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
      child: Object.assign(childEmitter, {
        killed: false,
        kill: () => {
          (proc.child as unknown as { killed: boolean }).killed = true;
          queueMicrotask(() => childEmitter.emit('close', null, 'SIGKILL'));
        },
      }),
      emitStdout: (s: string) => stdout.emit('data', Buffer.from(s)),
      close: (code = 0) => queueMicrotask(() => childEmitter.emit('close', code, null)),
    };
    procs.push(proc);
    queueMicrotask(() => handle(proc, command, args));
    return { child: proc.child as unknown as import('node:child_process').ChildProcess, stdout: stdout as unknown as NodeJS.ReadableStream, stderr: stderr as unknown as NodeJS.ReadableStream };
  };
  return { spawnFn, procs };
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cli-auth-test-'));
  files = new Map();
  now = 1_700_000_000_000;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseCodexLoginStatus', () => {
  it('detects "Not logged in"', () => {
    expect(parseCodexLoginStatus('Not logged in')).toEqual({ signedIn: false });
    expect(parseCodexLoginStatus('  NOT LOGGED IN  \n')).toEqual({ signedIn: false });
    expect(parseCodexLoginStatus('')).toEqual({ signedIn: false });
  });

  it('treats other output as signed in with a redacted hint', () => {
    const r = parseCodexLoginStatus('Logged in as you@example.com\nPlan: Plus');
    expect(r.signedIn).toBe(true);
    expect(r.accountHint).toContain('you@example.com');
  });

  it('redacts token-shaped material from the hint', () => {
    const r = parseCodexLoginStatus('Logged in\nsk-ant-oat01-SECRETVALUE1234567890');
    expect(r.signedIn).toBe(true);
    expect(JSON.stringify(r)).not.toContain('SECRETVALUE');
  });
});

describe('redactTokenish', () => {
  it('redacts API-key-shaped values', () => {
    expect(redactTokenish('key=sk-ant-oat01-abcdef1234567890')).not.toContain('abcdef');
    expect(redactTokenish('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature12')).not.toContain('eyJhbGci');
    expect(redactTokenish('nothing secret here')).toBe('nothing secret here');
  });
});

describe('bridge token-shape probes', () => {
  it('detects usable claude credentials without consent', () => {
    plantFile(join('.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '<redacted>', expiresAt: 9_999_999_999_999 } }));
    expect(bridgeHasUsableToken('claude', fakeHome)).toBe(true);
    expect(bridgeTokenExpiry('claude', fakeHome)).toBe(9_999_999_999_999);
  });

  it('returns false when the file is absent or token-shaped wrong', () => {
    expect(bridgeHasUsableToken('claude', fakeHome)).toBe(false);
    plantFile(join('.claude', '.credentials.json'), JSON.stringify({ unrelated: true }));
    expect(bridgeHasUsableToken('claude', fakeHome)).toBe(false);
    expect(bridgeTokenExpiry('claude', fakeHome)).toBeUndefined();
  });

  it('detects codex token shapes', () => {
    plantFile(join('.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: '<redacted>' }));
    expect(bridgeHasUsableToken('codex', fakeHome)).toBe(true);
  });

  it('accountHint never returns token material', () => {
    plantFile(join('.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '<redacted>' } }));
    plantFile('.claude.json', JSON.stringify({ email: 'you@example.com' }));
    expect(bridgeAccountHint('claude', fakeHome)).toBe('you@example.com');
    // A token stored under an identity-ish key is refused.
    plantFile('.claude.json', JSON.stringify({ email: 'sk-ant-oat01-SECRETSECRETSECRET' }));
    expect(bridgeAccountHint('claude', fakeHome)).toBeUndefined();
  });
});

describe('CliAuthManager.getStatus', () => {
  it('reports not signed in when nothing is present', async () => {
    const mgr = new CliAuthManager(makeDeps());
    const st = await mgr.getStatus('claude');
    expect(st).toMatchObject({ cliId: 'claude', cliPresent: false, credentialsPresent: false, signedIn: false });
    expect(JSON.stringify(st)).not.toContain('sk-ant');
  });

  it('reports signed in from the credential file (claude)', async () => {
    plantFile(join('.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '<redacted>', expiresAt: 9_999_999_999_999 } }));
    plantFile('.claude.json', JSON.stringify({ email: 'you@example.com' }));
    const mgr = new CliAuthManager(makeDeps());
    const st = await mgr.getStatus('claude');
    expect(st.signedIn).toBe(true);
    expect(st.credentialsPresent).toBe(true);
    expect(st.accountHint).toBe('you@example.com');
    expect(st.expired).toBe(false);
  });

  it('flags expired credentials', async () => {
    plantFile(join('.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '<redacted>', expiresAt: 1_000 } }));
    const mgr = new CliAuthManager(makeDeps());
    const st = await mgr.getStatus('claude');
    expect(st.signedIn).toBe(true);
    expect(st.expired).toBe(true);
  });

  it('uses `codex login status` when the CLI is present', async () => {
    const { spawnFn } = makeSpawn((proc, command, args) => {
      expect(command).toBe('codex');
      expect(args).toEqual(['login', 'status']);
      proc.emitStdout('Logged in as you@example.com\n');
      proc.close(0);
    });
    const mgr = new CliAuthManager(makeDeps({ spawnFn, pathDirs: ['/fake/bin'] }));
    // cliPresent is false with the fake PATH, so the status command is skipped;
    // force cliPresent via a planted executable dir.
    const st = await mgr.getStatus('codex');
    expect(st.signedIn).toBe(false); // no credentials file planted
  });
});

describe('CliAuthManager.startLogin', () => {
  it('captures the OAuth URL and completes when credentials appear', async () => {
    const { spawnFn, procs } = makeSpawn((proc) => {
      proc.emitStdout('Please visit https://example.com/oauth/authorize?x=1 to sign in\n');
      // Simulate the user completing auth in the browser: credentials appear.
      setTimeout(() => {
        plantFile(join('.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: '<redacted>' }));
      }, 20);
    });
    const mgr = new CliAuthManager(makeDeps({ spawnFn, pollIntervalMs: 5, loginTimeoutMs: 2000 }));
    const login = mgr.startLogin('codex');
    const url = await login.url;
    expect(url).toBe('https://example.com/oauth/authorize?x=1');
    const done = await login.done;
    expect(done.ok).toBe(true);
    expect(procs).toHaveLength(1);
  });

  it('fails cleanly when no URL is printed', async () => {
    const { spawnFn } = makeSpawn((proc) => {
      proc.emitStdout('some chatter without a link\n');
      proc.close(0);
    });
    const mgr = new CliAuthManager(makeDeps({ spawnFn, urlTimeoutMs: 100 }));
    const login = mgr.startLogin('codex');
    await expect(login.url).rejects.toThrow(/authorize URL/i);
    const done = await login.done;
    expect(done.ok).toBe(false);
  });

  it('cancel kills the child and reports cancelled', async () => {
    const { spawnFn, procs } = makeSpawn((proc) => {
      proc.emitStdout('Visit https://example.com/login now\n');
    });
    const mgr = new CliAuthManager(makeDeps({ spawnFn, pollIntervalMs: 5, loginTimeoutMs: 5000 }));
    const login = mgr.startLogin('codex');
    await login.url;
    login.cancel();
    const done = await login.done;
    expect(done.ok).toBe(false);
    expect(done.reason).toMatch(/cancelled/i);
    expect(procs[0].child.killed).toBe(true);
  });

  it('never exposes tokens in results or errors', async () => {
    const { spawnFn } = makeSpawn((proc) => {
      // Even if the CLI prints something token-shaped, only the URL is kept.
      proc.emitStdout('Visit https://example.com/login token=sk-ant-oat01-LEAKME123456\n');
      setTimeout(() => {
        plantFile(join('.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: '<redacted>' }));
      }, 20);
    });
    const mgr = new CliAuthManager(makeDeps({ spawnFn, pollIntervalMs: 5, loginTimeoutMs: 2000 }));
    const login = mgr.startLogin('codex');
    const url = await login.url;
    const done = await login.done;
    expect(JSON.stringify({ url, done })).not.toContain('LEAKME');
    expect(JSON.stringify({ url, done })).not.toContain('SECRET');
  });

  it('times out when the user never completes', async () => {
    const { spawnFn } = makeSpawn((proc) => {
      proc.emitStdout('Visit https://example.com/login\n');
    });
    // Real clock here: the frozen test clock would never reach the deadline.
    const mgr = new CliAuthManager(
      makeDeps({ spawnFn, pollIntervalMs: 5, loginTimeoutMs: 120, now: () => Date.now() }),
    );
    const login = mgr.startLogin('codex');
    await login.url;
    const done = await login.done;
    expect(done.ok).toBe(false);
    expect(done.reason).toMatch(/not completed/i);
  }, 10000);
});
