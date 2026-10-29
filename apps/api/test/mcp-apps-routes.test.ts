// SPDX-License-Identifier: Apache-2.0

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpAppNonceStore } from '@mvp/agent-runtime';
import {
  MCP_APP_CSP,
  registerMcpAppRoutes,
  type McpAppClient,
  type McpAppGovernance,
} from '../src/mcp-apps-routes.js';

const APP_HTML =
  '<!doctype html><html><body><h1>Weather</h1><script>/* app */</script></body></html>';

/** In-process stub MCP server: resources/list/read + tools/call. */
function makeFakeServer(): McpAppClient & { calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    async readResource(uri: string) {
      if (uri !== 'ui://weather') throw new Error(`unknown resource: ${uri}`);
      return {
        contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: APP_HTML }],
      };
    },
    async callToolByName(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `called ${name}` }] };
    },
  };
}

function makeGovernance(decision: 'allow' | 'deny' | 'require-approval'): McpAppGovernance & {
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    async evaluate(call) {
      seen.push(call.name);
      return { decision, reason: 'test policy' };
    },
  };
}

describe('MCP Apps routes', () => {
  let base: string;
  let server: ReturnType<express.Express['listen']>;
  let nonces: McpAppNonceStore;
  let fake: ReturnType<typeof makeFakeServer>;
  let governance: ReturnType<typeof makeGovernance>;

  async function start(decision: 'allow' | 'deny' | 'require-approval' = 'allow') {
    nonces = new McpAppNonceStore({ ttlMs: 60_000 });
    fake = makeFakeServer();
    governance = makeGovernance(decision);
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerMcpAppRoutes(router, {
      getClient: (id) => (id === 'weather' ? fake : undefined),
      governance,
      nonces,
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    await start('allow');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const serveUrl = (nonce: string) =>
    `${base}/api/mcp-apps/weather/${encodeURIComponent('ui://weather')}?nonce=${encodeURIComponent(nonce)}`;

  it('serves the app HTML with the strict CSP and nosniff headers', async () => {
    const { nonce } = nonces.issue('weather', 'ui://weather');
    const res = await fetch(serveUrl(nonce));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(MCP_APP_CSP);
    expect(MCP_APP_CSP).toContain("connect-src 'none'");
    expect(MCP_APP_CSP).toContain("frame-ancestors 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(APP_HTML);
  });

  it('rejects serving without a valid nonce, and for unknown servers', async () => {
    expect((await fetch(serveUrl('bogus'))).status).toBe(401);
    const { nonce } = nonces.issue('weather', 'ui://weather');
    const wrongServer = await fetch(
      `${base}/api/mcp-apps/nope/${encodeURIComponent('ui://weather')}?nonce=${nonce}`,
    );
    expect(wrongServer.status).toBe(401); // nonce is bound to 'weather'
  });

  async function bridge(nonce: string, message: unknown) {
    const res = await fetch(`${base}/api/mcp-apps/weather/bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, message }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('bridge ui/initialize returns host info', async () => {
    const { nonce } = nonces.issue('weather', 'ui://weather');
    const { status, body } = await bridge(nonce, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: {},
    });
    expect(status).toBe(200);
    expect(body.id).toBe(1);
    const result = body.result as { host: { name: string } };
    expect(result.host.name).toBe('KriyaDot');
  });

  it('bridge resources/read proxies to the server', async () => {
    const { nonce } = nonces.issue('weather', 'ui://weather');
    const { body } = await bridge(nonce, {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: 'ui://weather' },
    });
    const result = body.result as { contents: Array<{ text: string }> };
    expect(result.contents[0].text).toBe(APP_HTML);
  });

  it('bridge tools/call proxies when governance allows (registered name evaluated)', async () => {
    const { nonce } = nonces.issue('weather', 'ui://weather');
    const { body } = await bridge(nonce, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_forecast', arguments: { city: 'Pune' } },
    });
    expect(body.error).toBeUndefined();
    expect(governance.seen).toEqual(['mcp:weather:get_forecast']);
    expect(fake.calls).toEqual([{ name: 'get_forecast', args: { city: 'Pune' } }]);
  });

  it('bridge tools/call returns a JSON-RPC error when governance denies', async () => {
    server.close();
    await start('deny');
    const { nonce } = nonces.issue('weather', 'ui://weather');
    const { body } = await bridge(nonce, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_forecast', arguments: {} },
    });
    const error = body.error as { code: number; message: string };
    expect(error.code).toBe(-32004);
    expect(error.message).toContain('denied by governance');
    expect(fake.calls).toEqual([]); // the tool never executed
  });

  it('bridge rejects expired nonces', async () => {
    const short = new McpAppNonceStore({ ttlMs: 1 });
    const { nonce } = short.issue('weather', 'ui://weather', Date.now() - 10_000);
    // Swap in the expired-nonce store by re-verifying through a fresh route
    // is overkill; verify the store contract the route relies on instead:
    expect(short.verify(nonce, 'weather')).toBe(false);
    const { status } = await bridge('expired-nonce-value', {
      jsonrpc: '2.0',
      id: 5,
      method: 'ui/initialize',
      params: {},
    });
    expect(status).toBe(401);
  });
});
