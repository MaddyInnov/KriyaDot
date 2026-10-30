// SPDX-License-Identifier: Apache-2.0
// CN-3: first-party Google Workspace connectors — mock-verified only.
// Zero live Google calls: the client is a mock, the token getter is a
// stub, and the status route runs against a temp data dir with a fake
// env. The live OAuth step is honestly UNVERIFIED (no founder Google
// OAuth credentials exist in this environment).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_TOOL_NAMES,
  GOOGLE_WORKSPACE_SCOPES,
  createFetchGoogleWorkspaceClient,
  createGoogleWorkspaceTools,
  googleWorkspaceConfigStatus,
  googleWorkspaceToolPolicies,
  registerGoogleWorkspaceProvider,
  registerGoogleWorkspaceRoutes,
  registerGoogleWorkspaceTools,
  type GoogleWorkspaceClient,
} from '../src/google-workspace.js';
import { getOAuthProvider } from '../src/oauth.js';
import type { ToolContext } from '@mvp/agent-runtime';

const CTX: ToolContext = { sessionId: 's1', botId: 'bot-1' };
const CONFIGURED_ENV = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csecret' };

function makeMockClient() {
  const calls: Array<{ method: string; token: string; args: unknown[] }> = [];
  const client: GoogleWorkspaceClient = {
    listMessages: async (token, query, maxResults) => {
      calls.push({ method: 'listMessages', token, args: [query, maxResults] });
      return [{ id: 'msg-1', threadId: 'th-1', snippet: 'hello', from: 'a@example.com', subject: 'Hi', date: 'Fri, 30 Oct 2026' }];
    },
    getMessage: async (token, id) => {
      calls.push({ method: 'getMessage', token, args: [id] });
      return { id, from: 'a@example.com', subject: 'Hi', bodyText: 'the body' };
    },
    sendMessage: async (token, input) => {
      calls.push({ method: 'sendMessage', token, args: [input] });
      return { id: 'sent-1' };
    },
    listEvents: async (token, opts) => {
      calls.push({ method: 'listEvents', token, args: [opts] });
      return [{ id: 'ev-1', summary: 'Standup', start: '2026-10-31T09:00:00+05:30', end: '2026-10-31T09:30:00+05:30' }];
    },
    createEvent: async (token, event) => {
      calls.push({ method: 'createEvent', token, args: [event] });
      return { id: 'ev-2', ...event };
    },
    listFiles: async (token, query, maxResults) => {
      calls.push({ method: 'listFiles', token, args: [query, maxResults] });
      return [{ id: 'file-1', name: 'Plan.gdoc', mimeType: 'application/vnd.google-apps.document' }];
    },
    getFile: async (token, id) => {
      calls.push({ method: 'getFile', token, args: [id] });
      return { id, name: 'Plan.gdoc' };
    },
  };
  return { client, calls };
}

describe('provider registration (core-suite scopes)', () => {
  it('re-registers google with Gmail send + Calendar events + Drive read scopes', () => {
    registerGoogleWorkspaceProvider();
    const provider = getOAuthProvider('google');
    expect(provider).toBeDefined();
    expect(provider!.scopes).toEqual([...GOOGLE_WORKSPACE_SCOPES]);
    expect(provider!.scopes).toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(provider!.scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    // Least privilege: NO delete/trash/admin scope exists in the set.
    expect(provider!.scopes.every((s) => !/delete|admin|full/i.test(s))).toBe(true);
    expect(provider!.clientIdEnv).toBe('GOOGLE_OAUTH_CLIENT_ID');
  });
});

describe('config status (env-gated, values never exposed)', () => {
  it('reports missing env by NAME only', () => {
    const status = googleWorkspaceConfigStatus('/tmp/nowhere', {});
    expect(status.credentialsConfigured).toBe(false);
    expect(status.missingEnv).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
    expect(googleWorkspaceConfigStatus('/tmp/nowhere', CONFIGURED_ENV).credentialsConfigured).toBe(true);
  });
});

describe('tools (mock client, stub token)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'google-ws-'));
  });

  function toolsWith(client: GoogleWorkspaceClient, token = 'ya29.test-token') {
    return createGoogleWorkspaceTools({
      dataDir: dir,
      client,
      env: CONFIGURED_ENV,
      getAccessToken: async () => token,
    });
  }

  it('registers exactly the seven core-suite tools; writes are mutating', () => {
    const registry = new Map();
    registerGoogleWorkspaceTools(registry, { dataDir: dir, client: makeMockClient().client, env: CONFIGURED_ENV, getAccessToken: async () => 't' });
    expect([...registry.keys()].sort()).toEqual([...GOOGLE_TOOL_NAMES].sort());
    expect(registry.get('google_gmail_send').mutating).toBe(true);
    expect(registry.get('google_calendar_create').mutating).toBe(true);
    expect(registry.get('google_gmail_search').mutating).toBeFalsy();
    expect(() => registerGoogleWorkspaceTools(registry, { dataDir: dir, client: makeMockClient().client })).toThrow(/collision/);
  });

  it('gmail search/read pass the server-side token to the client', async () => {
    const { client, calls } = makeMockClient();
    const tools = toolsWith(client);
    const search = tools.find((t) => t.name === 'google_gmail_search')!;
    const out = (await search.handler({ query: 'from:a@example.com', maxResults: 5 }, CTX)) as { messages: unknown[] };
    expect(out.messages).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'listMessages', token: 'ya29.test-token', args: ['from:a@example.com', 5] });
    const read = tools.find((t) => t.name === 'google_gmail_read')!;
    const msg = (await read.handler({ messageId: 'msg-1' }, CTX)) as { message: { bodyText?: string } };
    expect(msg.message.bodyText).toBe('the body');
  });

  it('gmail send validates the recipient and returns the sent id; calendar + drive work', async () => {
    const { client, calls } = makeMockClient();
    const tools = toolsWith(client);
    const send = tools.find((t) => t.name === 'google_gmail_send')!;
    await expect(send.handler({ to: 'not-an-email', subject: 's', body: 'b' }, CTX)).rejects.toThrow(/not an email/);
    const sent = (await send.handler({ to: 'b@example.com', subject: 's', body: 'b' }, CTX)) as { messageId: string };
    expect(sent.messageId).toBe('sent-1');
    const create = tools.find((t) => t.name === 'google_calendar_create')!;
    const ev = (await create.handler({ summary: 'X', start: '2026-11-01T10:00:00+05:30', end: '2026-11-01T11:00:00+05:30' }, CTX)) as { event: { id?: string } };
    expect(ev.event.id).toBe('ev-2');
    const drive = tools.find((t) => t.name === 'google_drive_search')!;
    const files = (await drive.handler({ query: 'Plan' }, CTX)) as { files: unknown[] };
    expect(files.files).toHaveLength(1);
    expect(calls.map((c) => c.method)).toContain('listFiles');
  });

  it('fails closed and honestly when credentials are not configured', async () => {
    const { client } = makeMockClient();
    const tools = createGoogleWorkspaceTools({ dataDir: dir, client, env: {}, getAccessToken: async () => 't' });
    await expect(tools[0].handler({}, CTX)).rejects.toThrow(/founder OAuth credentials are missing/);
  });

  it('fails closed when configured but no account is connected', async () => {
    const { client } = makeMockClient();
    const tools = createGoogleWorkspaceTools({
      dataDir: dir,
      client,
      env: CONFIGURED_ENV,
      getAccessToken: async () => {
        throw new Error('OAuth provider "google" is not connected');
      },
    });
    await expect(tools[0].handler({}, CTX)).rejects.toThrow(/not connected/);
  });

  it('policy rules: reads allow, writes require approval', () => {
    const rules = googleWorkspaceToolPolicies();
    expect(rules.find((r) => r.id.includes('reads'))?.effect).toBe('allow');
    expect(rules.find((r) => r.id.includes('writes'))?.effect).toBe('require-approval');
    expect(rules.find((r) => r.id.includes('writes'))?.toolPattern).toContain('google_gmail_send');
  });
});

describe('fetch client shape (stubbed fetch, still zero live calls)', () => {
  it('drive search builds an authorized request and normalizes rows', async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: [{ id: 'f1', name: 'Budget.xlsx', mimeType: 'application/vnd.ms-excel', modifiedTime: '2026-10-01T00:00:00Z', owners: [{ displayName: 'Ash' }] }] }),
      };
    }) as unknown as typeof fetch;
    const client = createFetchGoogleWorkspaceClient(fetchFn);
    const files = await client.listFiles('tok-abc', 'Budget', 5);
    expect(files[0]).toMatchObject({ id: 'f1', name: 'Budget.xlsx', owners: ['Ash'] });
    expect(seen[0].auth).toBe('Bearer tok-abc');
    expect(seen[0].url).toContain('drive/v3/files');
  });

  it('gmail send base64url-encodes the RFC822 message', async () => {
    let rawBody = '';
    const fetchFn = vi.fn(async (_url: string, init?: { body?: string }) => {
      rawBody = init?.body ?? '';
      return { ok: true, status: 200, json: async () => ({ id: 'sent-9' }) };
    }) as unknown as typeof fetch;
    const client = createFetchGoogleWorkspaceClient(fetchFn);
    const out = await client.sendMessage('tok', { to: 'b@example.com', subject: 'Hello', body: 'Body text' });
    expect(out.id).toBe('sent-9');
    const parsed = JSON.parse(rawBody) as { raw: string };
    const decoded = Buffer.from(parsed.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: b@example.com');
    expect(decoded).toContain('Subject: Hello');
    expect(decoded).toContain('Body text');
  });
});

describe('status route', () => {
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('reports the env-gated, unverified-live state honestly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'google-ws-route-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerGoogleWorkspaceRoutes(router, { dataDir: dir, env: {} });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api`;
        resolve();
      });
    });
    const res = await fetch(`${baseUrl}/google-workspace/status`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.credentialsConfigured).toBe(false);
    expect(json.connected).toBe(false);
    expect(json.liveVerified).toBe(false);
    expect(json.firstParty).toBe(true);
    expect(json.missingEnv).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
    expect(JSON.stringify(json)).not.toMatch(/ya29\.|csecret/);
  });
});
