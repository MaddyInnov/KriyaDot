// SPDX-License-Identifier: Apache-2.0
// Tests for the ACP sessions router (acp-sessions-routes.ts):
// - session lifecycle endpoints (list/create/get/resume/cancel/close)
// - validation (command required)
// - prompt streaming over SSE (mocked manager)
// - tool-call bridging through the governance approval hook
// - error mapping to HTTP status codes

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSession, AcpStreamEvent, AcpToolVerdict } from '@mvp/agent-runtime';
import { createAcpSessionsRouter } from '../src/acp-sessions-routes.js';

function makeSession(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: 'acp_test1',
    label: 'fake',
    command: 'opencode',
    args: ['acp'],
    agentName: 'fake-agent',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('acp-sessions router', () => {
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let manager: {
    listSessions: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    getTranscript: ReturnType<typeof vi.fn>;
    resumeSession: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    cancelPrompt: ReturnType<typeof vi.fn>;
    closeSession: ReturnType<typeof vi.fn>;
  };
  let governance: {
    requestApproval: ReturnType<typeof vi.fn>;
    awaitDecision: ReturnType<typeof vi.fn>;
  };
  let audits: Array<{ action: string; fields: unknown }>;

  beforeEach(async () => {
    audits = [];
    const session = makeSession();
    manager = {
      listSessions: vi.fn().mockReturnValue([session]),
      createSession: vi.fn().mockImplementation(async (opts: { command: string }) => makeSession({ command: opts.command })),
      getSession: vi.fn().mockImplementation((id: string) => {
        if (id === 'missing') {
          const e = new Error('No ACP session "missing".') as Error & { kind: string };
          e.kind = 'not-found';
          throw e;
        }
        return makeSession({ id });
      }),
      getTranscript: vi.fn().mockReturnValue([]),
      resumeSession: vi.fn().mockImplementation(async (id: string) => makeSession({ id })),
      prompt: vi.fn(),
      cancelPrompt: vi.fn().mockReturnValue(true),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    governance = {
      requestApproval: vi.fn().mockReturnValue('appr_1'),
      awaitDecision: vi.fn().mockResolvedValue('approved'),
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/api/acp',
      createAcpSessionsRouter({
        manager: manager as never,
        workspaceDir: '/tmp',
        governance,
        audit: (action, fields) => {
          audits.push({ action, fields });
        },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('lists sessions', async () => {
    const res = await fetch(`${baseUrl}/api/acp`);
    const body = (await res.json()) as { ok: boolean; sessions: AcpSession[] };
    expect(body.ok).toBe(true);
    expect(body.sessions).toHaveLength(1);
  });

  it('creates a session and audits it', async () => {
    const res = await fetch(`${baseUrl}/api/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'opencode', args: ['acp'], label: 'coder' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; session: AcpSession };
    expect(body.session.command).toBe('opencode');
    expect(audits.some((a) => a.action === 'acp.session_created')).toBe(true);
    expect(manager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'opencode', cwd: '/tmp' }),
    );
  });

  it('rejects creation without a command', async () => {
    const res = await fetch(`${baseUrl}/api/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('maps spawn failures to 502', async () => {
    manager.createSession.mockRejectedValue(Object.assign(new Error('nope'), { kind: 'spawn-failed' }));
    const res = await fetch(`${baseUrl}/api/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '/nope' }),
    });
    expect(res.status).toBe(502);
  });

  it('returns session detail with transcript, 404 for unknown', async () => {
    const res = await fetch(`${baseUrl}/api/acp/acp_test1`);
    expect(res.ok).toBe(true);
    const missing = await fetch(`${baseUrl}/api/acp/missing`);
    expect(missing.status).toBe(404);
  });

  it('streams prompt events over SSE', async () => {
    manager.prompt.mockImplementation(
      async (_id: string, _text: string, hooks: { onEvent?: (e: AcpStreamEvent) => void }) => {
        hooks.onEvent?.({ type: 'chunk', text: 'hel' });
        hooks.onEvent?.({ type: 'chunk', text: 'lo' });
        hooks.onEvent?.({ type: 'done', text: 'hello' });
        return 'hello';
      },
    );
    const res = await fetch(`${baseUrl}/api/acp/acp_test1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const raw = await res.text();
    expect(raw).toContain('"type":"chunk"');
    expect(raw).toContain('"type":"done"');
  });

  it('bridges tool calls through the governance approval hook', async () => {
    let captured: ((tc: { toolCallId: string; name: string; args: Record<string, unknown> }) => Promise<AcpToolVerdict>) | null = null;
    manager.prompt.mockImplementation(
      async (
        _id: string,
        _text: string,
        hooks: {
          onEvent?: (e: AcpStreamEvent) => void;
          requestToolApproval?: (tc: { toolCallId: string; name: string; args: Record<string, unknown> }) => Promise<AcpToolVerdict>;
        },
      ) => {
        captured = hooks.requestToolApproval ?? null;
        const verdict = await hooks.requestToolApproval!({ toolCallId: 'tc1', name: 'read_file', args: { path: '/x' } });
        expect(verdict.approved).toBe(true);
        hooks.onEvent?.({ type: 'done', text: 'ok' });
        return 'ok';
      },
    );
    const res = await fetch(`${baseUrl}/api/acp/acp_test1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go' }),
    });
    await res.text();
    expect(captured).not.toBeNull();
    expect(governance.requestApproval).toHaveBeenCalledWith(
      'acp.tool:read_file',
      expect.objectContaining({ toolCallId: 'tc1' }),
      expect.objectContaining({ botId: 'acp' }),
    );
    expect(audits.some((a) => a.action === 'acp.tool_call_approved')).toBe(true);
  });

  it('denies tool calls when the user denies', async () => {
    governance.awaitDecision.mockResolvedValue('denied');
    manager.prompt.mockImplementation(
      async (
        _id: string,
        _text: string,
        hooks: {
          requestToolApproval?: (tc: { toolCallId: string; name: string; args: Record<string, unknown> }) => Promise<AcpToolVerdict>;
        },
      ) => {
        const verdict = await hooks.requestToolApproval!({ toolCallId: 'tc1', name: 'rm', args: {} });
        expect(verdict).toEqual({ approved: false, error: 'Denied by the user.' });
        return 'ok';
      },
    );
    const res = await fetch(`${baseUrl}/api/acp/acp_test1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go' }),
    });
    await res.text();
    expect(audits.some((a) => a.action === 'acp.tool_call_denied')).toBe(true);
  });

  it('cancels and closes sessions', async () => {
    const cancel = await fetch(`${baseUrl}/api/acp/acp_test1/cancel`, { method: 'POST' });
    expect(((await cancel.json()) as { cancelled: boolean }).cancelled).toBe(true);
    const del = await fetch(`${baseUrl}/api/acp/acp_test1`, { method: 'DELETE' });
    expect(del.ok).toBe(true);
    expect(audits.some((a) => a.action === 'acp.session_closed')).toBe(true);
  });

  it('resumes a session', async () => {
    const res = await fetch(`${baseUrl}/api/acp/acp_test1/resume`, { method: 'POST' });
    expect(res.ok).toBe(true);
    expect(manager.resumeSession).toHaveBeenCalledWith('acp_test1');
  });
});
