// SPDX-License-Identifier: Apache-2.0
// Tests for acp-sessions.ts: lifecycle, streaming, tool-call bridging,
// cancellation, error mapping, and untrusted-content handling.
// The "external agent" is a tiny Node script speaking the minimal ACP
// wire format over stdio. Zero paid API usage, no network.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AcpSessionManager,
  AcpSessionStore,
  AcpSessionError,
  mapAcpError,
} from '../src/acp-sessions.js';
import { defusePeerText } from '../src/provenance.js';

// Fake ACP agent behaviors, selected via argv[2]:
//   echo        → initialize, then respond {text} to every prompt
//   stream      → emit two text_chunk notifications, then respond
//   tool        → on prompt, send a tool_call notification, wait for
//                 tool_result, then respond with the verdict embedded
//   tool-hang   → send tool_call and never answer tool_result (tests deny path via timeout)
//   boom        → respond with a JSON-RPC error to prompt
//   slow        → never respond to prompt (tests client timeout)
//   exit        → exit(1) right after initialize
const FAKE_AGENT = `
const mode = process.argv[2];
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-agent' } } });
    } else if (m.method === 'prompt') {
      const sid = (m.params && m.params.sessionId) || 's';
      if (mode === 'stream') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { kind: 'text_chunk', text: 'hel' } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { kind: 'text_chunk', text: 'lo' } } });
        send({ jsonrpc: '2.0', id: m.id, result: { text: 'hello-done' } });
      } else if (mode === 'tool' || mode === 'tool-hang') {
        send({ jsonrpc: '2.0', method: 'tool_call', params: { sessionId: sid, toolCallId: 'tc1', name: 'read_file', args: { path: '/etc/passwd' } } });
        if (mode === 'tool') pending.set(m.id, m);
      } else if (mode === 'boom') {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'synthetic agent failure' } });
      } else if (mode === 'slow') {
        // never respond
      } else {
        send({ jsonrpc: '2.0', id: m.id, result: { text: 'echo:' + m.params.prompt } });
      }
    } else if (m.method === 'tool_result') {
      // Ack the tool_result request itself, then answer the original prompt.
      send({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
      for (const [pid] of pending) {
        send({ jsonrpc: '2.0', id: pid, result: { text: 'after-tool approved=' + m.params.approved + ' out=' + (m.params.output || '') } });
        pending.delete(pid);
      }
    }
  }
});
const pending = new Map();
if (mode === 'exit') { setTimeout(() => process.exit(1), 50); }
`;

describe('AcpSessionManager', () => {
  let dir: string;
  let agentPath: string;
  let store: AcpSessionStore;
  let manager: AcpSessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-sess-'));
    agentPath = join(dir, 'fake-agent.mjs');
    writeFileSync(agentPath, FAKE_AGENT);
    store = new AcpSessionStore(dir);
    manager = new AcpSessionManager(store);
  });

  afterEach(() => {
    manager.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const create = (mode: string, extra: Record<string, unknown> = {}) =>
    manager.createSession({ command: process.execPath, args: [agentPath, mode], label: `fake-${mode}`, ...extra });

  it('creates, lists, and closes a session', async () => {
    const s = await create('echo');
    expect(s.agentName).toBe('fake-agent');
    expect(s.status).toBe('active');
    expect(manager.listSessions()).toHaveLength(1);
    const t = manager.getTranscript(s.id);
    expect(t.some((e) => e.type === 'system')).toBe(true);
    await manager.closeSession(s.id);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('rejects an empty command', async () => {
    await expect(manager.createSession({ command: '   ' })).rejects.toMatchObject({ kind: 'spawn-failed' });
  });

  it('maps a missing binary to spawn-failed', async () => {
    await expect(manager.createSession({ command: '/nonexistent/acp-binary-xyz' })).rejects.toMatchObject({
      kind: 'spawn-failed',
    });
  });

  it('streams prompt chunks and returns the final text', async () => {
    const s = await create('stream');
    const chunks: string[] = [];
    const text = await manager.prompt(s.id, 'hi', { onEvent: (e) => { if (e.type === 'chunk') chunks.push(e.text); } });
    expect(chunks.join('')).toBe('hello');
    expect(text).toBe('hello-done');
    const t = manager.getTranscript(s.id);
    expect(t.map((e) => e.type)).toEqual(['system', 'user', 'agent']);
    expect(t[2]!.untrusted).toBe(true);
  });

  it('defuses hostile agent text (invisible chars stripped)', async () => {
    const s = await create('echo');
    const text = await manager.prompt(s.id, 'a\u200bb\u202ec');
    // The prompt is echoed back; invisible chars must be gone from the stored text.
    expect(text).not.toContain('\u200b');
    expect(text).not.toContain('\u202e');
    expect(text).toBe(defusePeerText('echo:a\u200bb\u202ec'));
  });

  it('bridges tool calls through the approval hook (approved)', async () => {
    const s = await create('tool');
    const seen: string[] = [];
    const text = await manager.prompt(
      s.id,
      'do it',
      {
        onEvent: (e) => { if (e.type === 'tool_call') seen.push(e.toolCall.toolCallId); },
        requestToolApproval: async (tc) => {
          expect(tc.name).toBe('read_file');
          return { approved: true, output: 'file-contents-here' };
        },
      },
    );
    expect(seen).toEqual(['tc1']);
    expect(text).toContain('approved=true');
    expect(text).toContain('file-contents-here');
    const t = manager.getTranscript(s.id);
    const types = t.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(t.find((e) => e.type === 'tool_result')!.untrusted).toBe(true);
  });

  it('denies tool calls when the hook denies (and tells the agent)', async () => {
    const s = await create('tool');
    const text = await manager.prompt(s.id, 'do it', {
      requestToolApproval: async () => ({ approved: false, error: 'nope' }),
    });
    expect(text).toContain('approved=false');
    const t = manager.getTranscript(s.id);
    expect(t.find((e) => e.type === 'tool_result')!.text).toContain('Denied: nope');
  });

  it('denies tool calls when no approval hook is attached', async () => {
    const s = await create('tool');
    const text = await manager.prompt(s.id, 'do it');
    expect(text).toContain('approved=false');
  });

  it('rejects a second concurrent prompt as busy', async () => {
    const s = await create('slow');
    const first = manager.prompt(s.id, 'one', { timeoutMs: 500 });
    await expect(manager.prompt(s.id, 'two')).rejects.toMatchObject({ kind: 'busy' });
    await expect(first).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('cancels an in-flight prompt', async () => {
    const s = await create('slow');
    const events: string[] = [];
    const p = manager.prompt(s.id, 'take your time', {
      timeoutMs: 10_000,
      onEvent: (e) => events.push(e.type),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.cancelPrompt(s.id)).toBe(true);
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(events).toContain('cancelled');
    // Session is usable again after cancel.
    expect(manager.cancelPrompt(s.id)).toBe(false);
  });

  it('maps agent JSON-RPC errors to agent-error', async () => {
    const s = await create('boom');
    await expect(manager.prompt(s.id, 'hi')).rejects.toMatchObject({ kind: 'agent-error' });
  });

  it('maps prompt timeouts to timeout', async () => {
    const s = await create('slow');
    await expect(manager.prompt(s.id, 'hi', { timeoutMs: 300 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('resumes a session after the process dies', async () => {
    const s = await create('echo');
    // Simulate a dead external process, then resume.
    const live = (manager as unknown as { live: Map<string, { client: { close(): void } }> }).live.get(s.id);
    live!.client.close();
    const resumed = await manager.resumeSession(s.id);
    expect(resumed.status).toBe('active');
    const text = await manager.prompt(s.id, 'still there?');
    expect(text).toContain('echo:');
  });

  it('throws not-found for unknown sessions', async () => {
    await expect(manager.prompt('nope', 'hi')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('toFencedContext fences untrusted agent text', async () => {
    const s = await create('echo');
    await manager.prompt(s.id, 'hello');
    const events = manager.getTranscript(s.id);
    const fenced = manager.toFencedContext(s, events);
    expect(fenced).toContain('<<<UNTRUSTED PEER CONTENT — BEGIN>>>');
    expect(fenced).toContain('UNTRUSTED DATA');
    // User text is not fenced.
    expect(fenced).toContain('hello');
  });
});

describe('mapAcpError', () => {
  it('passes AcpSessionError through', () => {
    const e = new AcpSessionError('busy', 'x');
    expect(mapAcpError(e)).toBe(e);
  });
  it('maps timeouts, spawn failures, disconnects, agent errors', () => {
    expect(mapAcpError(new Error('request "prompt" timed out after 1ms')).kind).toBe('timeout');
    expect(mapAcpError(new Error('spawn /x ENOENT')).kind).toBe('spawn-failed');
    expect(mapAcpError(new Error('ACP agent process exited')).kind).toBe('disconnected');
    expect(mapAcpError(new Error('ACP error: bad thing'))).toMatchObject({ kind: 'agent-error', message: expect.stringContaining('bad thing') });
  });
});
