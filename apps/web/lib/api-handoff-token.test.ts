// SPDX-License-Identifier: Apache-2.0
// Handoff session token (front-door Part 3): when the user arrives on their
// cloud instance via the website handoff, the instance's /handoff page has
// stored an SSO session token in localStorage. The web app must prefer it
// over the loopback bootstrap token, and must drop it (retrying once via
// bootstrap) when the API rejects it.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authedFetch, ensureApiReady, getAuthToken, resetApiBootstrap } from './api';

const KEY = 'kriyadot:sessionToken';
const realFetch = globalThis.fetch;

interface SeenCall {
  url: string;
  init?: RequestInit;
}

let seen: SeenCall[];

function authHeaderOf(call: SeenCall): string | null {
  return new Headers(call.init?.headers).get('Authorization');
}

beforeEach(() => {
  resetApiBootstrap();
  localStorage.removeItem(KEY);
  seen = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('/api/auth/bootstrap')) {
      return new Response(JSON.stringify({ token: 'tok123' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  localStorage.removeItem(KEY);
  resetApiBootstrap();
});

describe('handoff session token', () => {
  it('prefers the stored handoff token and skips bootstrap entirely', async () => {
    localStorage.setItem(KEY, 'sso-session-token');
    const token = await ensureApiReady();
    expect(token).toBe('sso-session-token');
    expect(getAuthToken()).toBe('sso-session-token');
    expect(seen.filter((s) => s.url.includes('/api/auth/bootstrap'))).toHaveLength(0);
    await authedFetch('/api/bots');
    const call = seen.find((s) => s.url.endsWith('/api/bots'));
    expect(authHeaderOf(call!)).toBe('Bearer ' + 'sso-session-token');
  });

  it('clears a rejected stored token and retries once via bootstrap', async () => {
    localStorage.setItem(KEY, 'expired-token');
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      if (String(url).includes('/api/auth/bootstrap')) {
        return new Response(JSON.stringify({ token: 'tok123' }), { status: 200 });
      }
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth === 'Bearer ' + 'expired-token') {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const res = await authedFetch('/api/bots');
    expect(res.status).toBe(200);
    expect(localStorage.getItem(KEY)).toBeNull();
    const botCalls = seen.filter((s) => s.url.endsWith('/api/bots'));
    expect(botCalls).toHaveLength(2);
    expect(authHeaderOf(botCalls[1])).toBe('Bearer ' + 'tok123');
  });
});
