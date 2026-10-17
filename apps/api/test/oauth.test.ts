// SPDX-License-Identifier: Apache-2.0
// Tests for the generic OAuth2 connected-app framework (apps/api/src/oauth.ts):
// - auth URL construction (scopes, state, client id — no secrets in the URL)
// - callback token exchange persists tokens ENCRYPTED (no plaintext on disk)
// - getValidToken returns a fresh token without network, refreshes on expiry
// - routes: /start (302), /callback (state CSRF + exchange), /status, DELETE
// Zero network: fetch is stubbed; the token endpoint is mocked.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from '../src/config.js';
import { localKeysPath } from '../src/providers.js';
import {
  buildAuthUrl,
  getOAuthProvider,
  getValidToken,
  handleCallback,
  registerOAuthRoutes,
} from '../src/oauth.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT = 'http://localhost:3000/api/oauth/google/callback';

const realFetch = globalThis.fetch.bind(globalThis);

/** Swap global fetch. Restored in afterEach — localhost stays real, mocks take the rest. */
function setFetch(fn: typeof globalThis.fetch): void {
  (globalThis as { fetch: typeof globalThis.fetch }).fetch = fn;
}

function restoreFetch(): void {
  (globalThis as { fetch: typeof globalThis.fetch }).fetch = realFetch;
}

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mvp-oauth-'));
}

function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    ...overrides,
  };
}

/** Stub fetch: localhost → real HTTP (route tests), everything else → the given mock. */
function stubFetchFor(mock: (url: string, init?: RequestInit) => Promise<Response>): void {
  setFetch(((url: unknown, init?: RequestInit) => {
    if (typeof url === 'string' && url.startsWith('http://127.0.0.1')) return realFetch(url, init);
    return mock(String(url), init);
  }) as typeof globalThis.fetch);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('oauth provider registry', () => {
  it('ships the google preset with gmail+calendar readonly scopes', () => {
    const google = getOAuthProvider('google');
    expect(google).toBeDefined();
    expect(google!.authUrl).toContain('accounts.google.com');
    expect(google!.tokenUrl).toContain('oauth2.googleapis.com');
    expect(google!.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(google!.scopes).toContain('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('rejects unknown providers', () => {
    expect(getOAuthProvider('nope')).toBeUndefined();
    expect(() => buildAuthUrl('nope', 's', REDIRECT)).toThrow(/Unknown OAuth provider/);
  });
});

describe('buildAuthUrl', () => {
  const OLD_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
  });
  afterEach(() => {
    if (OLD_ID === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = OLD_ID;
  });

  it('builds a Google consent URL with scopes, state and offline access', () => {
    const url = new URL(buildAuthUrl('google', 'csrf-123', REDIRECT));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('csrf-123');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly');
    // No secrets leak into the start URL.
    expect(url.toString()).not.toContain('test-client-secret');
  });

  it('fails closed when the client id is missing', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(() => buildAuthUrl('google', 's', REDIRECT)).toThrow(/no client id/);
  });
});

describe('handleCallback + getValidToken', () => {
  const OLD_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const OLD_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const OLD_BLOB = process.env.CUSTOM_OAUTH_GOOGLE_API_KEY;
  let dataDir: string;

  beforeEach(() => {
    dataDir = freshDataDir();
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    delete process.env.CUSTOM_OAUTH_GOOGLE_API_KEY;
  });

  afterEach(() => {
    restoreFetch();
    if (OLD_ID === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = OLD_ID;
    if (OLD_SECRET === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = OLD_SECRET;
    if (OLD_BLOB === undefined) delete process.env.CUSTOM_OAUTH_GOOGLE_API_KEY;
    else process.env.CUSTOM_OAUTH_GOOGLE_API_KEY = OLD_BLOB;
  });

  it('exchanges the code and stores tokens encrypted (never plaintext on disk)', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    stubFetchFor(async (url, init) => {
      calls.push({ url, body: String((init?.body as string) ?? '') });
      return jsonResponse(tokenResponse());
    });
    const tokens = await handleCallback('google', 'auth-code-xyz', REDIRECT, dataDir);
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(calls[0].body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('auth-code-xyz');
    expect(sent.get('redirect_uri')).toBe(REDIRECT);
    expect(sent.get('client_secret')).toBe(CLIENT_SECRET);

    // Encrypted at rest: no token bytes in the file.
    const raw = readFileSync(localKeysPath(dataDir), 'utf8');
    expect(raw).not.toContain('access-1');
    expect(raw).not.toContain('refresh-1');
    expect(JSON.parse(raw).alg).toBe('aes-256-gcm');
  });

  it('returns the stored token without network when it is still fresh', async () => {
    stubFetchFor(async () => jsonResponse(tokenResponse()));
    await handleCallback('google', 'code', REDIRECT, dataDir);
    // A fetch that throws if touched: a fresh token must not hit the network.
    stubFetchFor(async () => {
      throw new Error('network should not be touched');
    });
    await expect(getValidToken('google', dataDir)).resolves.toBe('access-1');
  });

  it('refreshes an expired token via the stored refresh token', async () => {
    stubFetchFor(async () => jsonResponse(tokenResponse({ access_token: 'old', expires_in: -10 })));
    await handleCallback('google', 'code', REDIRECT, dataDir);
    const calls: string[] = [];
    stubFetchFor(async (url, init) => {
      calls.push(String((init?.body as string) ?? ''));
      return jsonResponse(tokenResponse({ access_token: 'access-2' }));
    });
    await expect(getValidToken('google', dataDir)).resolves.toBe('access-2');
    const sent = new URLSearchParams(calls[0]);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('refresh-1');
    // The refreshed token was persisted.
    stubFetchFor(async () => {
      throw new Error('network should not be touched');
    });
    await expect(getValidToken('google', dataDir)).resolves.toBe('access-2');
  });

  it('fails closed when expired and no refresh token exists', async () => {
    stubFetchFor(async () =>
      jsonResponse({ access_token: 'old', expires_in: -10 /* no refresh_token */ }),
    );
    await handleCallback('google', 'code', REDIRECT, dataDir);
    stubFetchFor(async () => {
      throw new Error('network should not be touched');
    });
    await expect(getValidToken('google', dataDir)).rejects.toThrow(/no refresh token/);
  });

  it('fails closed when not connected', async () => {
    await expect(getValidToken('google', freshDataDir())).rejects.toThrow(/not connected/);
  });

  it('surfaces provider token errors', async () => {
    stubFetchFor(async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Bad code.' }, 400),
    );
    await expect(handleCallback('google', 'bad-code', REDIRECT, dataDir)).rejects.toThrow(
      /Token request failed \(400\): Bad code\./,
    );
  });
});

describe('oauth routes', () => {
  const OLD_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const OLD_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const OLD_BLOB = process.env.CUSTOM_OAUTH_GOOGLE_API_KEY;
  let dataDir: string;
  let governance: GovernanceGateway;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    dataDir = freshDataDir();
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    delete process.env.CUSTOM_OAUTH_GOOGLE_API_KEY;
    governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerOAuthRoutes(router, {
      config: { dataDir } as AppConfig,
      governance,
    });
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    restoreFetch();
    governance.close();
    if (OLD_ID === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = OLD_ID;
    if (OLD_SECRET === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = OLD_SECRET;
    if (OLD_BLOB === undefined) delete process.env.CUSTOM_OAUTH_GOOGLE_API_KEY;
    else process.env.CUSTOM_OAUTH_GOOGLE_API_KEY = OLD_BLOB;
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  it('status reports disconnected before any flow', async () => {
    const res = await fetch(`${baseUrl}/oauth/status`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ id: string; connected: boolean; hasRefreshToken: boolean }>;
    const google = json.find((p) => p.id === 'google');
    expect(google).toMatchObject({ connected: false, hasRefreshToken: false });
    // Tokens never leak through status.
    expect(JSON.stringify(json)).not.toContain('access');
  });

  it('completes a full connect flow: start → callback → status → disconnect', async () => {
    // 1. start → 302 to Google with a state param
    const start = await fetch(`${baseUrl}/oauth/google/start`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const location = start.headers.get('location') ?? '';
    expect(location).toContain('accounts.google.com');
    const state = new URL(location).searchParams.get('state');
    expect(state).toBeTruthy();

    // 2. callback with the echoed state exchanges the code
    stubFetchFor(async () => jsonResponse(tokenResponse()));
    const cb = await fetch(`${baseUrl}/oauth/google/callback?state=${state}&code=auth-code-1`);
    expect(cb.status).toBe(200);
    const cbJson = (await cb.json()) as { ok: boolean; provider: string; expiresAt: number };
    expect(cbJson.ok).toBe(true);
    expect(cbJson.provider).toBe('google');
    expect(cbJson.expiresAt).toBeGreaterThan(Date.now());

    // 3. status now shows connected (without tokens)
    const status = await (await fetch(`${baseUrl}/oauth/status`)).json();
    const google = (status as Array<{ id: string; connected: boolean; hasRefreshToken: boolean }>).find(
      (p) => p.id === 'google',
    );
    expect(google).toMatchObject({ connected: true, hasRefreshToken: true });

    // 4. disconnect removes the tokens
    const del = await fetch(`${baseUrl}/oauth/google`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const status2 = (await (await fetch(`${baseUrl}/oauth/status`)).json()) as Array<{
      id: string;
      connected: boolean;
    }>;
    expect(status2.find((p) => p.id === 'google')).toMatchObject({ connected: false });
    const delAgain = await fetch(`${baseUrl}/oauth/google`, { method: 'DELETE' });
    expect(delAgain.status).toBe(404);
  });

  it('rejects a callback with a missing/forged state', async () => {
    const res = await fetch(`${baseUrl}/oauth/google/callback?state=forged&code=x`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/state/i);
  });

  it('rejects unknown providers on every route', async () => {
    expect((await fetch(`${baseUrl}/oauth/nope/start`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${baseUrl}/oauth/nope/callback?state=x&code=y`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/oauth/nope`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('pending-state sweeper (L7)', () => {
  it('purges expired states on the 60s interval without route traffic', async () => {
    const { __testOAuthHooks } = await import('../src/oauth.js');
    vi.useFakeTimers();
    try {
      __testOAuthHooks.stopSweepForTest(); // drop any real-timer sweep from earlier tests
      const before = __testOAuthHooks.pendingStateCount();
      __testOAuthHooks.addPendingState('expired-1', 10 * 60 * 1000);
      __testOAuthHooks.addPendingState('fresh-1', 10 * 60 * 1000);
      expect(__testOAuthHooks.pendingStateCount()).toBe(before + 2);
      // Advance past the TTL: the interval sweeper fires and drops the old ones.
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(__testOAuthHooks.pendingStateCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps unexpired states across sweeps', async () => {
    const { __testOAuthHooks } = await import('../src/oauth.js');
    vi.useFakeTimers();
    try {
      __testOAuthHooks.stopSweepForTest();
      const before = __testOAuthHooks.pendingStateCount();
      __testOAuthHooks.addPendingState('fresh-2', 10 * 60 * 1000);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(__testOAuthHooks.pendingStateCount()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
