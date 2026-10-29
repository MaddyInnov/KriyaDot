// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import {
  McpAppBridgeRelay,
  buildBridgeResponse,
  createBridgePoster,
  isAllowedBridgeOrigin,
  mcpAppServeUrl,
  parseBridgeRequest,
} from './mcp-app-bridge';

const ORIGIN = 'http://127.0.0.1:4567';
const frame = { name: 'frame-window' };

describe('mcp-app bridge relay', () => {
  it('validates origins strictly', () => {
    expect(isAllowedBridgeOrigin(ORIGIN, [ORIGIN])).toBe(true);
    expect(isAllowedBridgeOrigin('https://evil.example', [ORIGIN])).toBe(false);
    expect(isAllowedBridgeOrigin('', [ORIGIN])).toBe(false);
  });

  it('parses only well-formed requests from the right origin + source', () => {
    const opts = { allowedOrigins: [ORIGIN], frameSource: frame };
    const req = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } };
    expect(parseBridgeRequest({ origin: ORIGIN, source: frame, data: req }, opts)?.id).toBe(7);
    expect(parseBridgeRequest({ origin: 'https://evil.example', source: frame, data: req }, opts)).toBeNull();
    expect(parseBridgeRequest({ origin: ORIGIN, source: { other: 1 }, data: req }, opts)).toBeNull();
    expect(parseBridgeRequest({ origin: ORIGIN, source: frame, data: { result: 1 } }, opts)).toBeNull();
    expect(parseBridgeRequest({ origin: ORIGIN, source: frame, data: 'tools/call' }, opts)).toBeNull();
  });

  it('correlates responses to the frame request id and forwards results', async () => {
    const posted: unknown[] = [];
    const relay = new McpAppBridgeRelay({
      allowedOrigins: [ORIGIN],
      getFrameSource: () => frame,
      postToBridge: async () => ({ jsonrpc: '2.0', id: 999, result: { ok: true } }),
      postToFrame: (m) => posted.push(m),
    });
    const handled = await relay.handleEvent({
      origin: ORIGIN,
      source: frame,
      data: { jsonrpc: '2.0', id: 'abc', method: 'ui/initialize', params: {} },
    });
    expect(handled).toBe(true);
    // Response carries the FRAME's id ('abc'), not the API echo (999).
    expect(posted).toEqual([{ jsonrpc: '2.0', id: 'abc', result: { ok: true } }]);
    expect(relay.pendingCount).toBe(0);
  });

  it('turns bridge failures into JSON-RPC errors for the frame', async () => {
    const posted: Array<{ error?: { code: number } }> = [];
    const relay = new McpAppBridgeRelay({
      allowedOrigins: [ORIGIN],
      getFrameSource: () => frame,
      postToBridge: async () => {
        throw new Error('offline');
      },
      postToFrame: (m) => posted.push(m as { error?: { code: number } }),
    });
    await relay.handleEvent({
      origin: ORIGIN,
      source: frame,
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });
    expect(posted[0].error?.code).toBe(-32603);
  });

  it('ignores foreign messages entirely', async () => {
    const postToBridge = vi.fn(async () => ({}));
    const relay = new McpAppBridgeRelay({
      allowedOrigins: [ORIGIN],
      getFrameSource: () => frame,
      postToBridge,
      postToFrame: () => undefined,
    });
    expect(
      await relay.handleEvent({ origin: 'https://evil.example', source: frame, data: { method: 'tools/call' } }),
    ).toBe(false);
    expect(postToBridge).not.toHaveBeenCalled();
  });

  it('buildBridgeResponse stamps id and exactly one of result/error', () => {
    expect(buildBridgeResponse({ id: 3 }, { result: 1 })).toEqual({ jsonrpc: '2.0', id: 3, result: 1 });
    expect(buildBridgeResponse({ id: 3 }, { error: { code: -1, message: 'x' } })).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -1, message: 'x' },
    });
  });

  it('createBridgePoster posts {nonce, message} to the bridge endpoint', async () => {
    const seen: Array<{ path: string; body: string }> = [];
    const poster = createBridgePoster({
      serverId: 'weather',
      nonce: 'n1',
      authedFetch: async (path, init) => {
        seen.push({ path, body: String((init as RequestInit)?.body) });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const reply = await poster({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
    expect(reply.result).toEqual({ ok: true });
    expect(seen[0].path).toBe('/api/mcp-apps/weather/bridge');
    expect(JSON.parse(seen[0].body)).toEqual({
      nonce: 'n1',
      message: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
    });
  });

  it('builds the serve URL with encoded server, URI, and nonce', () => {
    expect(
      mcpAppServeUrl({ apiBase: '', serverId: 'my server', resourceUri: 'ui://a/b', nonce: 'n x' }),
    ).toBe('/api/mcp-apps/my%20server/ui%3A%2F%2Fa%2Fb?nonce=n%20x');
  });
});
