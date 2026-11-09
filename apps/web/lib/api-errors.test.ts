// SPDX-License-Identifier: Apache-2.0
// apiJson error surfacing (2026-11-09): the API's plain-words `detail`
// must reach the thrown error. Before this, only `error` was read, so a
// bridge connect failure surfaced as the bare "API 400: Failed to
// connect bridge" while the actionable probe reason ("not signed in —
// run `claude auth login`") was dropped on the floor.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectBridge, resetApiBootstrap } from './api';

const realFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('/api/auth/bootstrap')) {
      return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
    }
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

beforeEach(() => {
  resetApiBootstrap();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetApiBootstrap();
});

describe('apiJson error detail', () => {
  it('includes the API detail in the thrown message', async () => {
    stubFetch(400, {
      error: 'Failed to connect bridge',
      detail: 'Claude Code is installed, but you\'re not signed in yet — run `claude auth login`.',
      code: 'not-signed-in',
    });
    await expect(connectBridge('claude')).rejects.toThrow(/Failed to connect bridge — Claude Code is installed/);
    await expect(connectBridge('claude')).rejects.toThrow(/API 400/);
  });

  it('falls back to the bare error when no detail is present', async () => {
    stubFetch(500, { error: 'Boom' });
    await expect(connectBridge('claude')).rejects.toThrow('API 500: Boom');
  });

  it('does not duplicate the detail when it equals the error', async () => {
    stubFetch(400, { error: 'Same', detail: 'Same' });
    await expect(connectBridge('claude')).rejects.toThrow('API 400: Same');
  });
});
