// SPDX-License-Identifier: Apache-2.0
// Auth contract: every API call sends `Authorization: Bearer <token>`; the
// token comes from GET /api/auth/bootstrap (in-memory only) and concurrent
// early callers share one bootstrap request.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authedFetch, ensureApiReady, getAuthToken, resetApiBootstrap } from './api';

const realFetch = globalThis.fetch;

interface SeenCall {
  url: string;
  init?: RequestInit;
}

let seen: SeenCall[];
let bootstrapBehavior: 'ok' | 'unreachable' | 'no-token';

beforeEach(() => {
  resetApiBootstrap();
  seen = [];
  bootstrapBehavior = 'ok';
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('/api/auth/bootstrap')) {
      if (bootstrapBehavior === 'unreachable') throw new TypeError('fetch failed');
      const body = bootstrapBehavior === 'no-token' ? {} : { token: 'tok123' };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetApiBootstrap();
});

function authHeaderOf(call: SeenCall): string | null {
  return new Headers(call.init?.headers).get('Authorization');
}

describe('API auth bootstrap', () => {
  it('fetches the token exactly once for concurrent early callers', async () => {
    const [a, b, c] = await Promise.all([ensureApiReady(), ensureApiReady(), ensureApiReady()]);
    expect(a).toBe('tok123');
    expect(b).toBe('tok123');
    expect(c).toBe('tok123');
    expect(getAuthToken()).toBe('tok123');
    expect(seen.filter((s) => s.url.includes('/api/auth/bootstrap'))).toHaveLength(1);
  });

  it('attaches Authorization: Bearer <token> to API calls', async () => {
    await authedFetch('/api/bots');
    const call = seen.find((s) => s.url.endsWith('/api/bots'));
    expect(call).toBeDefined();
    expect(authHeaderOf(call!)).toBe('Bearer tok123');
  });

  it('preserves caller headers alongside the auth header', async () => {
    await authedFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const call = seen.find((s) => s.url.endsWith('/api/chat'));
    const headers = new Headers(call!.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok123');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('rejects with a "Cannot reach the KriyaDot API" error when unreachable', async () => {
    bootstrapBehavior = 'unreachable';
    await expect(ensureApiReady()).rejects.toThrow('Cannot reach the KriyaDot API');
    expect(getAuthToken()).toBeNull();
  });

  it('rejects when bootstrap returns no token', async () => {
    bootstrapBehavior = 'no-token';
    await expect(ensureApiReady()).rejects.toThrow('no token');
  });

  it('resetApiBootstrap forces a fresh bootstrap', async () => {
    await ensureApiReady();
    resetApiBootstrap();
    expect(getAuthToken()).toBeNull();
    await ensureApiReady();
    expect(seen.filter((s) => s.url.includes('/api/auth/bootstrap'))).toHaveLength(2);
  });
});
