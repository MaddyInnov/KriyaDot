// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager, parseSuggestion as _parseSuggestion } from '../src/terminal.js';
import { parseSuggestion, registerTerminalRoutes } from '../src/terminal-routes.js';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';

void _parseSuggestion;

/** Fake child process with piped stdio for hermetic tests. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string | null = null;
  kill(signal?: string): boolean {
    this.killed = signal ?? 'SIGTERM';
    this.emit('exit', 0);
    return true;
  }
}

function fakeSpawn(children: FakeChild[]) {
  return (_cmd: string, _args: string[], _opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
}

describe('TerminalManager', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'terminal-'));
  });

  it('creates a host session and round-trips input/output', async () => {
    const children: FakeChild[] = [];
    const mgr = new TerminalManager(fakeSpawn(children), { pty: () => undefined, docker: () => false });
    const session = await mgr.create({ workspaceDir: dir });
    expect(session.status).toBe('open');
    expect(session.backend).toBe('host');
    expect(session.sandboxed).toBe(false);
    expect(session.cwd).toBe(dir);
    expect(children).toHaveLength(1);

    // input → child's stdin
    expect(mgr.write(session.id, 'echo hi\n')).toBe(true);
    const stdinData = children[0].stdin.read() as Buffer | null;
    expect(stdinData?.toString()).toBe('echo hi\n');

    // shell output → subscribers + buffer
    const seen: string[] = [];
    const unsub = mgr.subscribe(session.id, (c) => seen.push(c));
    children[0].stdout.write('hi\n');
    await new Promise((r) => setImmediate(r));
    expect(seen.join('')).toContain('hi\n');
    expect(mgr.output(session.id)).toContain('hi\n');
    unsub();

    // write validation
    expect(mgr.write(session.id, '')).toBe(false);
    expect(mgr.write('nope', 'x')).toBe(false);

    // close
    expect(mgr.close(session.id)).toBe(true);
    expect(mgr.get(session.id)?.status).toBe('closed');
    expect(children[0].killed).toBe('SIGTERM');
    expect(mgr.close(session.id)).toBe(false); // already closed
  });

  it('lists sessions and rejects oversized writes', async () => {
    const children: FakeChild[] = [];
    const mgr = new TerminalManager(fakeSpawn(children), { pty: () => undefined, docker: () => false });
    const a = await mgr.create({ workspaceDir: dir, name: 'a' });
    const b = await mgr.create({ workspaceDir: dir, name: 'b' });
    expect(mgr.list().map((s) => s.name).sort()).toEqual(['a', 'b']);
    expect(mgr.write(a.id, 'x'.repeat(65 * 1024))).toBe(false);
    expect(mgr.resize(a.id, 120, 40)).toBe(true);
    expect(mgr.get(a.id)?.cols).toBe(120);
    expect(mgr.resize('missing', 80, 24)).toBe(false);
    void b;
  });

  it('emitForTest injects output for subscribers', async () => {
    const children: FakeChild[] = [];
    const mgr = new TerminalManager(fakeSpawn(children), { pty: () => undefined, docker: () => false });
    const s = await mgr.create({ workspaceDir: dir });
    const seen: string[] = [];
    mgr.subscribe(s.id, (c) => seen.push(c));
    expect(mgr.emitForTest(s.id, 'mocked output')).toBe(true);
    expect(seen.join('')).toBe('mocked output');
    expect(mgr.emitForTest('missing', 'x')).toBe(false);
  });
});

describe('TerminalManager session eviction (M6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'terminal-'));
  });

  it('sweepNow evicts closed sessions older than 30 minutes, keeps open and recent ones', async () => {
    vi.useFakeTimers();
    try {
      const children: FakeChild[] = [];
      const mgr = new TerminalManager(fakeSpawn(children), { pty: () => undefined, docker: () => false });
      const old = await mgr.create({ workspaceDir: dir });
      mgr.close(old.id);
      // 31 minutes pass; then a fresh session is opened and closed.
      vi.advanceTimersByTime(31 * 60 * 1000);
      const recent = await mgr.create({ workspaceDir: dir });
      mgr.close(recent.id);
      const open = await mgr.create({ workspaceDir: dir });
      mgr.sweepNow();
      expect(mgr.get(old.id)).toBeUndefined();
      expect(mgr.get(recent.id)).toBeDefined();
      expect(mgr.get(open.id)).toBeDefined();
      expect(mgr.output(recent.id)).toBeDefined();
      mgr.stopSweep();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps tracked sessions at 200, evicting oldest-closed first', async () => {
    const children: FakeChild[] = [];
    const mgr = new TerminalManager(fakeSpawn(children), { pty: () => undefined, docker: () => false });
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) {
      const s = await mgr.create({ workspaceDir: dir });
      ids.push(s.id);
    }
    for (const id of ids) mgr.close(id);
    mgr.sweepNow();
    expect(mgr.list()).toHaveLength(200);
    expect(mgr.get(ids[0])).toBeUndefined(); // oldest closed evicted
    expect(mgr.get(ids[204])).toBeDefined();
    mgr.stopSweep();
  });

  it('close() kills orphaned grandchildren via the process group', async () => {
    if (process.platform === 'win32') return; // POSIX process groups only
    const mgr = new TerminalManager(undefined, {
      pty: () => undefined,
      docker: () => false,
    });
    try {
      const s = await mgr.create({ workspaceDir: dir });
      const pids: number[] = [];
      const gotPid = new Promise<void>((resolve) => {
        const unsub = mgr.subscribe(s.id, (c) => {
          for (const m of c.matchAll(/GRANDCHILD:(\d+)/g)) pids.push(Number(m[1]));
          if (pids.length > 0) {
            unsub();
            resolve();
          }
        });
      });
      expect(mgr.write(s.id, 'sleep 300 & echo GRANDCHILD:$!\n')).toBe(true);
      await Promise.race([
        gotPid,
        new Promise((_, rej) => setTimeout(() => rej(new Error('no grandchild pid')), 10_000)),
      ]);
      const grandchild = pids[0];
      expect(() => process.kill(grandchild, 0)).not.toThrow(); // alive before close
      mgr.close(s.id);
      const deadline = Date.now() + 10_000;
      for (;;) {
        let alive = true;
        try {
          process.kill(grandchild, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
          else throw e;
        }
        if (!alive) break;
        if (Date.now() > deadline) throw new Error('grandchild survived close()');
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      mgr.stopSweep();
    }
  }, 30_000);
});

describe('parseSuggestion', () => {
  it('parses plain JSON', () => {
    expect(parseSuggestion('{"command": "ls -la", "explanation": "lists files"}')).toEqual({
      command: 'ls -la',
      explanation: 'lists files',
    });
  });

  it('parses JSON wrapped in code fences', () => {
    const text = 'Here you go:\n```json\n{"command": "git status", "explanation": "shows status"}\n```';
    expect(parseSuggestion(text)?.command).toBe('git status');
  });

  it('rejects non-JSON and empty commands', () => {
    expect(parseSuggestion('just run ls')).toBeUndefined();
    expect(parseSuggestion('{"command": "", "explanation": "x"}')).toBeUndefined();
  });
});

describe('terminal router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;

  const bot = {
    id: 'helper', name: 'Helper', description: 'd', systemPrompt: 's',
    provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [],
  } as unknown as BotConfig;

  const governance = {
    requestApproval: vi.fn(() => 'approval-1'),
    awaitDecision: vi.fn(async () => 'approved'),
  } as unknown as GovernanceGateway;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'terminal-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const agentRuntime = {
      runTurn: vi.fn(async ({ onEvent }: { onEvent: (e: { type: string; content?: string }) => Promise<void> }) => {
        await onEvent({ type: 'token', content: '{"command": "ls -la", "explanation": "lists files"}' });
        await onEvent({ type: 'done' });
        return { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
      }),
    } as unknown as AgentRuntime;
    registerTerminalRoutes(router, {
      workspaceDir: dir,
      agentRuntime,
      getBots: () => [bot],
      governance,
    });
    app.use('/api/terminal', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/terminal`;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  it('creates, lists, writes to, and closes a session', async () => {
    const created = await api('POST', '/sessions', { name: 't1' });
    expect(created.status).toBe(200);
    const session = (created.json as { session: { id: string; backend: string } }).session;
    expect(session.id).toBeTruthy();

    const listed = await api('GET', '/sessions');
    expect((listed.json as { sessions: unknown[] }).sessions).toHaveLength(1);

    // Write a command; the real host shell echoes it back through the stream.
    const written = await api('POST', `/sessions/${session.id}/input`, { data: 'echo terminal-ok\n' });
    expect(written.status).toBe(200);

    // Stream should replay output containing our echo.
    const streamRes = await fetch(`${baseUrl}/sessions/${session.id}/stream`);
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    let buf = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (value) buf += new TextDecoder().decode(value);
      if (buf.includes('terminal-ok')) break;
      if (done) break;
    }
    await reader.cancel();
    expect(buf).toContain('terminal-ok');

    expect((await api('POST', `/sessions/${session.id}/resize`, { cols: 120, rows: 40 })).status).toBe(200);
    expect((await api('DELETE', `/sessions/${session.id}`)).status).toBe(200);
    expect((await api('POST', `/sessions/${session.id}/input`, { data: 'x' })).status).toBe(404);
    expect((await api('POST', '/sessions/bad!id/input', { data: 'x' })).status).toBe(400);
  });

  it('ai/suggest returns a parsed command', async () => {
    const res = await api('POST', '/ai/suggest', { goal: 'list files' });
    expect(res.status).toBe(200);
    expect((res.json as { command: string }).command).toBe('ls -la');
    expect((await api('POST', '/ai/suggest', {})).status).toBe(400);
  });

  it('ai/run is approval-gated and writes on approval', async () => {
    const created = await api('POST', '/sessions', { name: 't2' });
    const session = (created.json as { session: { id: string } }).session;
    const res = await api('POST', '/ai/run', { sessionId: session.id, command: 'echo ai-run-ok' });
    expect(res.status).toBe(200);
    expect(governance.requestApproval).toHaveBeenCalledWith(
      'terminal.run',
      { sessionId: session.id, command: 'echo ai-run-ok' },
      { sessionId: 'api', botId: 'api', actor: 'user' },
      { provenance: 'terminal-ai' },
    );
    // The command should have been executed by the shell.
    const streamRes = await fetch(`${baseUrl}/sessions/${session.id}/stream`);
    const reader = streamRes.body!.getReader();
    let buf = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (value) buf += new TextDecoder().decode(value);
      if (buf.includes('ai-run-ok')) break;
      if (done) break;
    }
    await reader.cancel();
    expect(buf).toContain('ai-run-ok');
    await api('DELETE', `/sessions/${session.id}`);
  });

  it('ai/run fails closed when denied', async () => {
    (governance.awaitDecision as ReturnType<typeof vi.fn>).mockResolvedValueOnce('denied');
    const created = await api('POST', '/sessions', { name: 't3' });
    const session = (created.json as { session: { id: string } }).session;
    const res = await api('POST', '/ai/run', { sessionId: session.id, command: 'echo no' });
    expect(res.status).toBe(403);
    await api('DELETE', `/sessions/${session.id}`);
  });
});
