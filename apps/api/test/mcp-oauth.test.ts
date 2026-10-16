// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpOAuthTokenStore,
  getMcpOAuthStatus,
  peekMcpOAuthClientInfo,
  registerMcpOAuthRoutes,
  resolveMcpOAuthClient,
} from '../src/mcp-oauth.js';
import type { McpServerConfig } from '../src/seed.js';

const METADATA = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
};

const realFetch = globalThis.fetch;

/** Selective fetch mock: OAuth endpoints are stubbed, everything else passes through. */
function mockOAuthFetch() {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('.well-known/oauth-authorization-server')) {
      return { ok: true, status: 200, json: () => Promise.resolve(METADATA) } as Response;
    }
    if (u.includes('.well-known/oauth-protected-resource')) {
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            resource: 'https://mcp.example.com/',
            authorization_servers: ['https://auth.example.com'],
            scopes_supported: ['read'],
          }),
      } as Response;
    }
    if (u === 'https://mcp.example.com/') {
      // Probe target: refuses unauthenticated initialize, advertises metadata.
      return {
        ok: false,
        status: 401,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === 'www-authenticate'
              ? 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'
              : null,
        },
        json: () => Promise.resolve({}),
      } as unknown as Response;
    }
    if (u === 'https://plain.example.com/') {
      return { ok: true, status: 200, json: () => Promise.resolve({}) } as Response;
    }
    if (u === 'https://auth.example.com/token') {
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
      } as Response;
    }
    if (u === 'https://auth.example.com/register') {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ client_id: 'dyn-client', client_secret: 'dyn-secret' }),
      } as Response;
    }
    return realFetch(url as string, init as RequestInit);
  }) as typeof fetch;
}

const mcpServers: Record<string, McpServerConfig> = {
  testmcp: { url: 'https://mcp.example.com/', oauth: true },
  plainmcp: { url: 'https://plain.example.com/' },
};

const governance = { audit: vi.fn() };

describe('mcp-oauth routes', () => {
  let dir: string;
  let server: unknown = null;
  let baseUrl = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
    mockOAuthFetch();
    process.env.MCP_OAUTH_TESTMCP_CLIENT_ID = 'test-client-id';

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerMcpOAuthRoutes(router, {
      config: { dataDir: dir } as unknown as import('../src/config.js').AppConfig,
      governance: governance as unknown as import('@mvp/governance').GovernanceGateway,
      mcpServers,
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    delete process.env.MCP_OAUTH_TESTMCP_CLIENT_ID;
    delete process.env.MCP_OAUTH_DYNREG_CLIENT_ID;
    vi.restoreAllMocks();
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  async function api(method: string, path: string): Promise<{ status: number; json: any }> {
    const res = await realFetch(`${baseUrl}${path}`, { method });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  it('start returns an authorization URL with PKCE + state', async () => {
    const { status, json } = await api('GET', '/mcp/oauth/start?server=testmcp');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.server).toBe('testmcp');
    const u = new URL(json.authUrl);
    expect(u.origin + u.pathname).toBe('https://auth.example.com/authorize');
    expect(u.searchParams.get('client_id')).toBe('test-client-id');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')).toBe(json.state);
    expect(u.searchParams.get('resource')).toBe('https://mcp.example.com/');
  });

  it('start rejects unknown servers', async () => {
    const { status, json } = await api('GET', '/mcp/oauth/start?server=nope');
    expect(status).toBe(404);
    expect(json.error).toMatch(/Unknown MCP server/);
  });

  it('start requires the server param', async () => {
    const { status } = await api('GET', '/mcp/oauth/start');
    expect(status).toBe(400);
  });

  it('callback exchanges the code and stores tokens encrypted', async () => {
    const started = await api('GET', '/mcp/oauth/start?server=testmcp');
    const state = (started.json as { state: string }).state;

    const { status, json } = await api('GET', `/mcp/oauth/callback?code=auth-code-1&state=${state}`);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.server).toBe('testmcp');
    expect(json.expiresAt).toBeGreaterThan(Date.now());

    // Tokens are persisted (encrypted) — visible via the store, never via the API.
    const store = createMcpOAuthTokenStore(dir);
    const tokens = store.getTokens('testmcp');
    expect(tokens?.accessToken).toBe('at-1');
    expect(tokens?.refreshToken).toBe('rt-1');

    // Status reflects the connection without leaking tokens.
    const st = await api('GET', '/mcp/oauth/status');
    const entry = (st.json as { servers: any[] }).servers.find((s) => s.server === 'testmcp');
    expect(entry.connected).toBe(true);
    expect(entry.hasRefreshToken).toBe(true);
    expect(entry.oauth).toBe(true);
    expect(JSON.stringify(st.json)).not.toContain('at-1');

    expect(governance.audit).toHaveBeenCalledWith(
      'mcp.oauth.connected',
      expect.objectContaining({ toolName: 'mcp-oauth' }),
    );
  });

  it('callback rejects invalid/expired state', async () => {
    const { status, json } = await api('GET', '/mcp/oauth/callback?code=x&state=bogus');
    expect(status).toBe(400);
    expect(json.error).toMatch(/Invalid or expired OAuth state/);
  });

  it('callback is single-use (state consumed)', async () => {
    const started = await api('GET', '/mcp/oauth/start?server=testmcp');
    const state = (started.json as { state: string }).state;
    const first = await api('GET', `/mcp/oauth/callback?code=c1&state=${state}`);
    expect(first.status).toBe(200);
    const second = await api('GET', `/mcp/oauth/callback?code=c2&state=${state}`);
    expect(second.status).toBe(400);
  });

  it('revoke removes tokens and status flips to disconnected', async () => {
    const started = await api('GET', '/mcp/oauth/start?server=testmcp');
    const state = (started.json as { state: string }).state;
    await api('GET', `/mcp/oauth/callback?code=c&state=${state}`);

    const del = await api('DELETE', '/mcp/oauth/testmcp');
    expect(del.status).toBe(200);
    expect((del.json as { ok: boolean }).ok).toBe(true);

    const st = await api('GET', '/mcp/oauth/status');
    const entry = (st.json as { servers: any[] }).servers.find((s) => s.server === 'testmcp');
    expect(entry.connected).toBe(false);

    const del2 = await api('DELETE', '/mcp/oauth/testmcp');
    expect(del2.status).toBe(404);

    expect(governance.audit).toHaveBeenCalledWith(
      'mcp.oauth.disconnected',
      expect.objectContaining({ toolName: 'mcp-oauth' }),
    );
  });

  it('revoke rejects unknown servers', async () => {
    const { status } = await api('DELETE', '/mcp/oauth/nope');
    expect(status).toBe(404);
  });

  it('status lists HTTP servers with oauth flags', async () => {
    const { status, json } = await api('GET', '/mcp/oauth/status');
    expect(status).toBe(200);
    const servers = (json as { servers: any[] }).servers;
    const oauth = servers.find((s) => s.server === 'testmcp');
    const plain = servers.find((s) => s.server === 'plainmcp');
    expect(oauth.oauth).toBe(true);
    expect(oauth.connected).toBe(false);
    expect(plain.oauth).toBe(false);
  });
});

describe('client credential resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-resolve-'));
    mockOAuthFetch();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MCP_OAUTH_TESTMCP_CLIENT_ID;
    delete process.env.MCP_OAUTH_DYNREG_CLIENT_ID;
    vi.restoreAllMocks();
  });

  it('prefers pre-registered env credentials', async () => {
    process.env.MCP_OAUTH_TESTMCP_CLIENT_ID = 'env-client';
    const info = await resolveMcpOAuthClient(dir, 'testmcp', {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    }, 'http://localhost:4000/api/mcp/oauth/callback');
    expect(info.clientId).toBe('env-client');
  });

  it('falls back to dynamic registration and persists the client', async () => {
    // No env client id for dynreg → registration endpoint is used.
    const info = await resolveMcpOAuthClient(
      dir,
      'dynreg',
      {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
      },
      'http://localhost:4000/api/mcp/oauth/callback',
    );
    expect(info.clientId).toBe('dyn-client');
    expect(info.clientSecret).toBe('dyn-secret');
    // Persisted for later (peek finds it without re-registering).
    expect(peekMcpOAuthClientInfo(dir, 'dynreg')?.clientId).toBe('dyn-client');
  });

  it('fails clearly when no client and no registration endpoint', async () => {
    await expect(
      resolveMcpOAuthClient(
        dir,
        'noreg',
        {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        },
        'http://localhost:4000/api/mcp/oauth/callback',
      ),
    ).rejects.toThrow(/MCP_OAUTH_NOREG_CLIENT_ID/);
  });
});

describe('getMcpOAuthStatus', () => {
  it('returns empty for no HTTP servers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-empty-'));
    expect(getMcpOAuthStatus(dir, { local: { command: 'npx' } })).toEqual([]);
  });
});

describe('mcp-oauth probe + manual + deeplink', () => {
  let dir: string;
  let server: unknown = null;
  let baseUrl = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-probe-'));
    mockOAuthFetch();
    process.env.MCP_OAUTH_TESTMCP_CLIENT_ID = 'test-client-id';

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerMcpOAuthRoutes(router, {
      config: { dataDir: dir } as unknown as import('../src/config.js').AppConfig,
      governance: governance as unknown as import('@mvp/governance').GovernanceGateway,
      mcpServers,
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    delete process.env.MCP_OAUTH_TESTMCP_CLIENT_ID;
    vi.restoreAllMocks();
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await realFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.text().then((t) => (t ? JSON.parse(t) : null))) as unknown };
  }

  it('probe reports requiresOAuth for a 401-advertising server', async () => {
    const { status, json } = await post('/mcp/oauth/probe', { server: 'testmcp' });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.requiresOAuth).toBe(true);
    expect(json.signedOut).toBe(true);
    expect(json.connected).toBe(false);
    expect(json.authorizationServers).toEqual(['https://auth.example.com']);
  });

  it('probe reports no OAuth for a plain server', async () => {
    const { status, json } = await post('/mcp/oauth/probe', { server: 'plainmcp' });
    expect(status).toBe(200);
    expect(json.requiresOAuth).toBe(false);
  });

  it('probe accepts a raw URL', async () => {
    const { status, json } = await post('/mcp/oauth/probe', { url: 'https://mcp.example.com/' });
    expect(status).toBe(200);
    expect(json.requiresOAuth).toBe(true);
  });

  it('probe 400s without server or url', async () => {
    const { status } = await post('/mcp/oauth/probe', {});
    expect(status).toBe(400);
  });

  it('manual completes a flow with pasted code+state', async () => {
    // Start the flow to get a state.
    const startRes = await realFetch(`${baseUrl}/mcp/oauth/start?server=testmcp`);
    const startJson = (await startRes.json()) as { state: string };
    const { status, json } = await post('/mcp/oauth/manual', {
      code: 'pasted-code',
      state: startJson.state,
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.server).toBe('testmcp');
    // State is single-use.
    const retry = await post('/mcp/oauth/manual', { code: 'x', state: startJson.state });
    expect(retry.status).toBe(400);
  });

  it('manual accepts a pasted callback URL', async () => {
    const startRes = await realFetch(`${baseUrl}/mcp/oauth/start?server=testmcp`);
    const startJson = (await startRes.json()) as { state: string };
    const { status, json } = await post('/mcp/oauth/manual', {
      callbackUrl: `http://127.0.0.1:1/api/mcp/oauth/callback?code=url-code&state=${startJson.state}`,
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('manual rejects unknown state', async () => {
    const { status } = await post('/mcp/oauth/manual', { code: 'x', state: 'nope' });
    expect(status).toBe(400);
  });

  it('callback with display=deeplink redirects to kriyadot:// deep link', async () => {
    const startRes = await realFetch(`${baseUrl}/mcp/oauth/start?server=testmcp&display=deeplink`);
    const startJson = (await startRes.json()) as { state: string };
    // Manual redirect following off: check the 302 Location.
    const cb = await realFetch(
      `${baseUrl}/mcp/oauth/callback?code=phone-code&state=${startJson.state}`,
      { redirect: 'manual' } as RequestInit,
    );
    expect(cb.status).toBe(302);
    const loc = cb.headers.get('location') ?? '';
    expect(loc.startsWith('kriyadot://oauth-callback?')).toBe(true);
    expect(loc).toContain('code=phone-code');
    expect(loc).toContain(`state=${startJson.state}`);
    // The phone then completes via /manual with the deep-linked code+state.
    const done = await post('/mcp/oauth/manual', { code: 'phone-code', state: startJson.state });
    expect(done.status).toBe(200);
    expect(done.json.server).toBe('testmcp');
  });
});
