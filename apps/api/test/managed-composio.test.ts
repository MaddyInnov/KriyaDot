// SPDX-License-Identifier: Apache-2.0
// Managed Composio transport (worker client): the managed-apps service
// client, the per-user platform-mode store, the client resolver, the
// mode / managed-token / status routes, and tool execution wired through
// the resolver. Zero network: every fetch is an injected mock and every
// store lives in a temp dir.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureVault } from '@mvp/vault';
import {
  COMPOSIO_KEY_NAME,
  COMPOSIO_MANAGED_TOKEN_NAME,
  fetchComposioClient,
  getComposioManagedToken,
  getComposioPlatformMode,
  readComposioEnables,
  registerComposioRoutes,
  resolveComposioClient,
  setComposioPlatformMode,
} from '../src/composio.js';
import {
  ManagedAppsError,
  createManagedComposioClient,
  fetchManagedUsage,
} from '../src/managed-composio.js';
import { createComposioCallTool, createComposioListActionsTool } from '../src/composio-tools.js';
import { writeAccountCache } from '../src/composio-accounts.js';
import type { ToolContext } from '@mvp/agent-runtime';

const OWNER_TOKEN = 'test-owner-token';
const SERVICE_URL = 'https://svc.example';
const SERVICE_TOKEN = 'managed-token-abc';
const USER = 'default-user';

interface RecordedCall {
  url: string;
  method: string;
  authorization?: string;
  body?: Record<string, unknown>;
}

type ServiceHandler = (call: RecordedCall) => { status?: number; body?: unknown };

/** A fetch double that records calls and answers from a handler table. */
function makeServiceFetch(handler: ServiceHandler) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const call: RecordedCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: init?.headers?.authorization,
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Default in-memory managed service implementing the fixed contract. */
function defaultServiceHandler(call: RecordedCall): { status?: number; body?: unknown } {
  const path = new URL(call.url).pathname;
  if (path === '/v1/usage') {
    return { body: { plan: 'pro', used: 3, quota: 100, month: '2026-11', globalCapReached: false } };
  }
  if (path === '/v1/apps') {
    return {
      body: {
        apps: [
          { appId: 'gmail', name: 'Gmail', description: 'mail', categories: ['productivity'] },
          { app_id: 'slack', name: 'Slack' },
        ],
      },
    };
  }
  if (path === '/v1/connect-link') return { body: { redirectUrl: 'https://managed.example/connect/xyz' } };
  if (path === '/v1/accounts') {
    return {
      body: {
        accounts: [
          { id: 'ca_1', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' },
          { id: 'ca_2', toolkit_slug: 'slack', status: 'ACTIVE' },
        ],
      },
    };
  }
  if (path.startsWith('/v1/accounts/')) return { body: {} };
  if (path === '/v1/tools') {
    return {
      body: {
        tools: [
          { slug: 'GMAIL_SEND_EMAIL', name: 'Send email', inputParameters: { type: 'object', properties: { to: { type: 'string' } } } },
          { slug: 'GMAIL_LIST', name: 'List', input_parameters: { type: 'object', properties: {} } },
        ],
      },
    };
  }
  if (path === '/v1/execute') return { body: { successful: true, data: { id: 'msg1' } } };
  return { status: 404, body: { code: 'not_found' } };
}

function seedVault(dir: string, name: string, value: string): void {
  new SecureVault(dir, USER, USER).create(name, value, 'test');
}

// ---------------------------------------------------------------------------
// Managed client: method mapping
// ---------------------------------------------------------------------------

describe('createManagedComposioClient', () => {
  it('maps every ComposioClient method onto the service contract', async () => {
    const { fetchFn, calls } = makeServiceFetch(defaultServiceHandler);
    const client = createManagedComposioClient({ serviceUrl: `${SERVICE_URL}/`, token: SERVICE_TOKEN, fetchFn });

    // validateApiKey → GET /v1/usage; plan mapped into orgName.
    await expect(client.validateApiKey(SERVICE_TOKEN)).resolves.toEqual({ ok: true, orgName: 'pro' });
    expect(calls[0]).toMatchObject({ url: `${SERVICE_URL}/v1/usage`, method: 'GET', authorization: `Bearer ${SERVICE_TOKEN}` });

    // listApps normalizes canonical AND raw shapes identically; the
    // closure token is used, not the apiKey argument.
    const apps = await client.listApps('ignored-argument');
    expect(apps.map((a) => a.appId)).toEqual(['gmail', 'slack']);
    expect(apps[0]).toMatchObject({ name: 'Gmail', description: 'mail', categories: ['productivity'] });
    expect(calls.at(-1)?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);

    // createAuthLink → POST /v1/connect-link { toolkitSlug, label }.
    const link = await client.createAuthLink('x', { toolkitSlug: 'gmail', userId: USER, label: 'work' });
    expect(link.redirectUrl).toBe('https://managed.example/connect/xyz');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `${SERVICE_URL}/v1/connect-link` });
    expect(calls.at(-1)?.body).toEqual({ toolkitSlug: 'gmail', label: 'work' });

    // Accounts: list + single fetch (via the list; no single-GET endpoint).
    const accounts = await client.listConnectedAccounts('x', USER);
    expect(accounts.map((a) => [a.id, a.toolkitSlug])).toEqual([
      ['ca_1', 'gmail'],
      ['ca_2', 'slack'],
    ]);
    await expect(client.getConnectedAccount('x', 'ca_2')).resolves.toMatchObject({ id: 'ca_2', toolkitSlug: 'slack' });
    await expect(client.getConnectedAccount('x', 'ca_nope')).resolves.toBeNull();

    // Delete + revoke both hit DELETE /v1/accounts/:id.
    await client.deleteConnectedAccount('x', 'ca_1');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${SERVICE_URL}/v1/accounts/ca_1` });
    await client.revokeConnectedAccount('x', 'ca_2');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${SERVICE_URL}/v1/accounts/ca_2` });

    // listTools passes toolkitSlug as the query param; schemas survive in
    // both camelCase and snake_case shapes.
    const tools = await client.listTools('x', 'gmail');
    expect(calls.at(-1)?.url).toBe(`${SERVICE_URL}/v1/tools?toolkitSlug=gmail`);
    expect(tools.map((t) => t.slug)).toEqual(['GMAIL_SEND_EMAIL', 'GMAIL_LIST']);
    expect(tools[0]?.inputParameters).toMatchObject({ properties: { to: { type: 'string' } } });
    expect(tools[1]?.inputParameters).toEqual({ type: 'object', properties: {} });

    // executeTool → POST /v1/execute with kind 'chat' by default.
    const result = await client.executeTool('x', {
      toolSlug: 'GMAIL_SEND_EMAIL',
      connectedAccountId: 'ca_1',
      userId: USER,
      args: { to: 'a@b.c' },
    });
    expect(result).toEqual({ successful: true, data: { id: 'msg1' }, error: undefined });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `${SERVICE_URL}/v1/execute` });
    expect(calls.at(-1)?.body).toEqual({
      accountId: 'ca_1',
      actionName: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'a@b.c' },
      kind: 'chat',
    });
  });

  it('validateApiKey: candidate token wins for the check; 401 → ok:false', async () => {
    const { fetchFn, calls } = makeServiceFetch((call) =>
      call.authorization === `Bearer ${SERVICE_TOKEN}`
        ? { body: { plan: 'pro', used: 0, quota: 10 } }
        : { status: 401, body: { code: 'unauthorized' } },
    );
    const client = createManagedComposioClient({ serviceUrl: SERVICE_URL, token: 'closure-token', fetchFn });
    await expect(client.validateApiKey('bad-token')).resolves.toEqual({ ok: false });
    expect(calls[0]?.authorization).toBe('Bearer bad-token');
    await expect(client.validateApiKey(SERVICE_TOKEN)).resolves.toEqual({ ok: true, orgName: 'pro' });
  });

  it('429 quota codes throw "managed allowance" + the code', async () => {
    for (const code of ['quota_exceeded', 'operator_cap_reached']) {
      const { fetchFn } = makeServiceFetch(() => ({ status: 429, body: { code } }));
      const client = createManagedComposioClient({ serviceUrl: SERVICE_URL, token: SERVICE_TOKEN, fetchFn });
      const err = await client
        .executeTool('x', { toolSlug: 'GMAIL_SEND_EMAIL', connectedAccountId: 'ca_1', userId: USER, args: {} })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('managed allowance');
      expect((err as Error).message).toContain(code);
    }
  });

  it('403 not_entitled throws "not included in your plan"', async () => {
    const { fetchFn } = makeServiceFetch(() => ({ status: 403, body: { code: 'not_entitled' } }));
    const client = createManagedComposioClient({ serviceUrl: SERVICE_URL, token: SERVICE_TOKEN, fetchFn });
    await expect(client.listApps('x')).rejects.toThrow(/not included in your plan/);
    await expect(
      client.executeTool('x', { toolSlug: 'GMAIL_SEND_EMAIL', connectedAccountId: 'ca_1', userId: USER, args: {} }),
    ).rejects.toThrow(/not included in your plan/);
  });

  it('fetchManagedUsage parses usage and carries HTTP status on failure', async () => {
    const ok = makeServiceFetch(defaultServiceHandler);
    await expect(fetchManagedUsage(SERVICE_URL, SERVICE_TOKEN, ok.fetchFn)).resolves.toEqual({
      plan: 'pro', used: 3, quota: 100, month: '2026-11', globalCapReached: false,
    });
    const bad = makeServiceFetch(() => ({ status: 401, body: { code: 'unauthorized' } }));
    const err = await fetchManagedUsage(SERVICE_URL, 'nope', bad.fetchFn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagedAppsError);
    expect((err as ManagedAppsError).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Mode store + resolver
// ---------------------------------------------------------------------------

describe('platform mode store + resolveComposioClient', () => {
  let dir: string;
  const savedEnv = process.env.KRIYADOT_MANAGED_APPS_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-composio-'));
    delete process.env.KRIYADOT_MANAGED_APPS_URL;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.KRIYADOT_MANAGED_APPS_URL;
    else process.env.KRIYADOT_MANAGED_APPS_URL = savedEnv;
  });

  it('mode defaults to byok and round-trips without clobbering enables', () => {
    expect(getComposioPlatformMode(dir, USER)).toBe('byok');
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ 'bot-1': { gmail: true } }));
    setComposioPlatformMode(dir, USER, 'managed');
    expect(getComposioPlatformMode(dir, USER)).toBe('managed');
    // Enablement survives, and the reserved mode key never leaks into it.
    expect(readComposioEnables(dir, USER)).toEqual({ 'bot-1': { gmail: true } });
    const raw = JSON.parse(readFileSync(join(dir, 'composio-enables.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['bot-1']).toEqual({ gmail: true });
    setComposioPlatformMode(dir, USER, 'byok');
    expect(getComposioPlatformMode(dir, USER)).toBe('byok');
    expect(readComposioEnables(dir, USER)).toEqual({ 'bot-1': { gmail: true } });
  });

  it('BYOK: null without a key; the fetch client with one', () => {
    expect(resolveComposioClient(dir, USER)).toBeNull();
    seedVault(dir, COMPOSIO_KEY_NAME, 'ak_test');
    const resolved = resolveComposioClient(dir, USER);
    expect(resolved?.mode).toBe('byok');
    expect(resolved?.apiKey).toBe('ak_test');
    expect(resolved?.client).toBe(fetchComposioClient);
  });

  it('managed: requires mode + service URL + token, all three', async () => {
    const { fetchFn } = makeServiceFetch(defaultServiceHandler);
    setComposioPlatformMode(dir, USER, 'managed');
    // No URL, no token.
    expect(resolveComposioClient(dir, USER, { fetchFn })).toBeNull();
    // URL but no token.
    expect(resolveComposioClient(dir, USER, { serviceUrl: SERVICE_URL, fetchFn })).toBeNull();
    // Token but no URL.
    seedVault(dir, COMPOSIO_MANAGED_TOKEN_NAME, SERVICE_TOKEN);
    expect(resolveComposioClient(dir, USER, { fetchFn })).toBeNull();
    // All three → managed client bound to the token.
    const resolved = resolveComposioClient(dir, USER, { serviceUrl: SERVICE_URL, fetchFn });
    expect(resolved?.mode).toBe('managed');
    expect(resolved?.apiKey).toBe(SERVICE_TOKEN);
    await expect(resolved!.client.listApps('anything')).resolves.toHaveLength(2);
    // The env var supplies the URL when no override is given.
    process.env.KRIYADOT_MANAGED_APPS_URL = SERVICE_URL;
    expect(resolveComposioClient(dir, USER, { fetchFn })?.mode).toBe('managed');
    // Back to byok: the BYOK key path applies again (null without a key).
    setComposioPlatformMode(dir, USER, 'byok');
    expect(resolveComposioClient(dir, USER, { fetchFn })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routes: status / mode / managed-token
// ---------------------------------------------------------------------------

describe('composio mode + managed routes', () => {
  let dir: string;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  const audit = vi.fn();
  const savedEnv = process.env.KRIYADOT_MANAGED_APPS_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-routes-'));
    audit.mockClear();
    delete process.env.KRIYADOT_MANAGED_APPS_URL;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    if (savedEnv === undefined) delete process.env.KRIYADOT_MANAGED_APPS_URL;
    else process.env.KRIYADOT_MANAGED_APPS_URL = savedEnv;
  });

  async function start(deps: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerComposioRoutes(router, {
      config: { dataDir: dir } as unknown as import('../src/config.js').AppConfig,
      governance: { audit } as unknown as import('@mvp/governance').GovernanceGateway,
      bots: [{ id: 'bot-1', name: 'Helper' }] as unknown as import('../src/routes.js').RouteDeps['bots'],
      loopbackToken: OWNER_TOKEN,
      ...deps,
    } as Parameters<typeof registerComposioRoutes>[1]);
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  }

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it('BYOK status shape: connected from the vault key, additive fields present', async () => {
    await start({});
    const before = await call('GET', '/composio/status');
    expect(before.json).toEqual({
      connected: false,
      mode: 'byok',
      managed: { serviceConfigured: false, tokenConfigured: false },
    });
    seedVault(dir, COMPOSIO_KEY_NAME, 'ak_test');
    const after = await call('GET', '/composio/status');
    expect(after.json).toEqual({
      connected: true,
      mode: 'byok',
      managed: { serviceConfigured: false, tokenConfigured: false },
    });
  });

  it('managed status: connected = service && token; usage filled fail-soft', async () => {
    seedVault(dir, COMPOSIO_MANAGED_TOKEN_NAME, SERVICE_TOKEN);
    setComposioPlatformMode(dir, USER, 'managed');
    const { fetchFn } = makeServiceFetch((call) => {
      const path = new URL(call.url).pathname;
      if (path === '/v1/usage') return { body: { plan: 'pro', used: 12, quota: 10, month: '2026-11', globalCapReached: false } };
      return { status: 404, body: {} };
    });
    await start({ managedAppsUrl: SERVICE_URL, managedFetch: fetchFn });
    const { status, json } = await call('GET', '/composio/status');
    expect(status).toBe(200);
    expect(json).toEqual({
      connected: true,
      mode: 'managed',
      managed: {
        serviceConfigured: true,
        tokenConfigured: true,
        plan: 'pro',
        used: 12,
        quota: 10,
        quotaExceeded: true, // used >= quota
      },
    });
  });

  it('managed status never fails when the usage call fails', async () => {
    seedVault(dir, COMPOSIO_MANAGED_TOKEN_NAME, SERVICE_TOKEN);
    setComposioPlatformMode(dir, USER, 'managed');
    const fetchFn = (async () => {
      throw new Error('service down');
    }) as unknown as typeof fetch;
    await start({ managedAppsUrl: SERVICE_URL, managedFetch: fetchFn });
    const { status, json } = await call('GET', '/composio/status');
    expect(status).toBe(200);
    expect(json.connected).toBe(true);
    expect(json.mode).toBe('managed');
    expect(json.managed).toEqual({ serviceConfigured: true, tokenConfigured: true });
  });

  it('managed mode without a token reports connected:false + tokenConfigured:false', async () => {
    setComposioPlatformMode(dir, USER, 'managed');
    const { fetchFn } = makeServiceFetch(defaultServiceHandler);
    await start({ managedAppsUrl: SERVICE_URL, managedFetch: fetchFn });
    const { json } = await call('GET', '/composio/status');
    expect(json).toEqual({
      connected: false,
      mode: 'managed',
      managed: { serviceConfigured: true, tokenConfigured: false },
    });
  });

  it('POST /mode validates and persists', async () => {
    await start({});
    expect((await call('POST', '/composio/mode', { mode: 'weird' })).status).toBe(400);
    expect((await call('POST', '/composio/mode', {})).status).toBe(400);
    const ok = await call('POST', '/composio/mode', { mode: 'managed' });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ mode: 'managed' });
    expect(getComposioPlatformMode(dir, USER)).toBe('managed');
    const back = await call('POST', '/composio/mode', { mode: 'byok' });
    expect(back.json).toEqual({ mode: 'byok' });
    expect(getComposioPlatformMode(dir, USER)).toBe('byok');
  });

  it('POST /managed-token validates against the service, then stores in the vault', async () => {
    const { fetchFn, calls } = makeServiceFetch((call) =>
      new URL(call.url).pathname === '/v1/usage'
        ? { body: { plan: 'team', used: 1, quota: 50 } }
        : { status: 404, body: {} },
    );
    await start({ managedAppsUrl: SERVICE_URL, managedFetch: fetchFn });
    const { status, json } = await call('POST', '/composio/managed-token', { token: SERVICE_TOKEN });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, plan: 'team', quota: 50 });
    expect(JSON.stringify(json)).not.toContain(SERVICE_TOKEN);
    expect(calls[0]?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(getComposioManagedToken(dir, USER)).toBe(SERVICE_TOKEN);
    // DELETE removes it again (idempotent).
    expect((await call('DELETE', '/composio/managed-token')).json).toEqual({ ok: true });
    expect(getComposioManagedToken(dir, USER)).toBeUndefined();
    expect((await call('DELETE', '/composio/managed-token')).status).toBe(200);
  });

  it('POST /managed-token: 401 from the service → 401 and nothing stored; no service → 503', async () => {
    const rejecting = makeServiceFetch(() => ({ status: 401, body: { code: 'unauthorized' } }));
    await start({ managedAppsUrl: SERVICE_URL, managedFetch: rejecting.fetchFn });
    const rejected = await call('POST', '/composio/managed-token', { token: 'bad-token' });
    expect(rejected.status).toBe(401);
    expect(getComposioManagedToken(dir, USER)).toBeUndefined();
    expect((await call('POST', '/composio/managed-token', {})).status).toBe(400);
  });

  it('POST /managed-token without a configured service → 503', async () => {
    await start({});
    const { status, json } = await call('POST', '/composio/managed-token', { token: SERVICE_TOKEN });
    expect(status).toBe(503);
    expect(json.ok).toBe(false);
    expect(getComposioManagedToken(dir, USER)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tools through the resolver (managed mode)
// ---------------------------------------------------------------------------

describe('composio tools execute through the managed client via the resolver', () => {
  let dir: string;
  const CTX: ToolContext = { sessionId: 's1', botId: 'bot-1' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-tools-'));
    seedVault(dir, COMPOSIO_MANAGED_TOKEN_NAME, SERVICE_TOKEN);
    // Enables first: setComposioPlatformMode preserves them in the same file.
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ 'bot-1': { gmail: true } }));
    setComposioPlatformMode(dir, USER, 'managed');
    writeAccountCache(dir, USER, {
      ca_gmail1: { toolkitSlug: 'gmail', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
    });
  });

  function serviceFetch() {
    return makeServiceFetch((call) => {
      const url = new URL(call.url);
      if (url.pathname === '/v1/execute') return { body: { successful: true, data: { sent: true } } };
      if (url.pathname === '/v1/apps') return { body: { apps: [{ appId: 'gmail', name: 'Gmail' }] } };
      if (url.pathname === '/v1/accounts') {
        return { body: { accounts: [{ id: 'ca_gmail1', toolkitSlug: 'gmail', status: 'ACTIVE' }] } };
      }
      if (url.pathname === '/v1/tools') {
        return { body: { tools: [{ slug: 'GMAIL_SEND_EMAIL', name: 'Send email', inputParameters: { type: 'object', properties: {} } }] } };
      }
      return { status: 404, body: {} };
    });
  }

  it('composio_call executes via POST /v1/execute even with no BYOK key', async () => {
    const { fetchFn, calls } = serviceFetch();
    const tool = createComposioCallTool({
      dataDir: dir,
      getApiKey: () => undefined, // no BYOK key anywhere — managed only
      managedAppsUrl: SERVICE_URL,
      managedFetch: fetchFn,
    });
    const result = (await tool.handler(
      { accountId: 'ca_gmail1', actionName: 'GMAIL_SEND_EMAIL', parameters: { to: 'a@b.c' } },
      CTX,
    )) as { ok: boolean; data: unknown };
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ sent: true });
    const exec = calls.find((c) => new URL(c.url).pathname === '/v1/execute');
    expect(exec?.body).toMatchObject({ actionName: 'GMAIL_SEND_EMAIL', accountId: 'ca_gmail1', kind: 'chat' });
    expect(exec?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });

  it('composio_list_actions JIT reports ready (not platform_not_configured) in managed mode', async () => {
    const { fetchFn } = serviceFetch();
    const tool = createComposioListActionsTool({
      dataDir: dir,
      getApiKey: () => undefined,
      managedAppsUrl: SERVICE_URL,
      managedFetch: fetchFn,
    });
    const result = (await tool.handler({ toolkitSlug: 'gmail' }, CTX)) as Record<string, unknown> & {
      accounts: Array<{ accountId: string }>;
    };
    expect(result.connected).toBe(true);
    expect(result.connectionStatus).toBe('ready');
    expect('connectionNeeded' in result).toBe(false);
    expect(result.accounts.map((a) => a.accountId)).toEqual(['ca_gmail1']);
  });
});
