// SPDX-License-Identifier: Apache-2.0
// #57b: context epochs — a changed tool list bumps the epoch and
// stale-epoch definitions refuse to call.
// #57a (client half): annotations survive ingestion onto tool defs.
// #51: ElicitationRouter — per-surface registration, decline-by-default
// for headless.

import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ElicitationRouter,
  MCPClient,
  McpStaleContextEpochError,
  type McpToolAnnotations,
  type McpToolDefinition,
} from '../src/mcp.js';

interface FakeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

function fakeSdkClient(tools: FakeTool[]): Client {
  return {
    async connect() {},
    async close() {},
    async listTools() {
      return { tools };
    },
    async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
      return { ok: true, name: req.name, args: req.arguments ?? {} };
    },
    getServerVersion() {
      return { name: 'fake', version: '1' };
    },
  } as unknown as Client;
}

const CTX = { sessionId: 's', botId: 'b' };

describe('context epochs (#57b)', () => {
  it('bumps on tool-list change; stale definitions are rejected with a clear error', async () => {
    const tools: FakeTool[] = [
      { name: 'lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ];
    const client = new MCPClient({ createClient: () => fakeSdkClient(tools) });
    await client.connectStdio({ command: 'fake' });
    try {
      expect(client.contextEpoch).toBe(0);
      const defsV1 = (await client.listTools()) as McpToolDefinition[];
      expect(defsV1[0]!.contextEpoch).toBe(0);
      await expect(defsV1[0]!.handler({ q: 'x' }, CTX)).resolves.toEqual({
        ok: true,
        name: 'lookup',
        args: { q: 'x' },
      });

      // Re-listing an unchanged list does NOT bump the epoch.
      await client.listTools();
      expect(client.contextEpoch).toBe(0);

      // The server changes the tool's schema (list_changed / restart).
      tools[0] = {
        name: 'lookup',
        inputSchema: { type: 'object', properties: { q: { type: 'string' }, lang: { type: 'string' } } },
      };
      const defsV2 = (await client.listTools()) as McpToolDefinition[];
      expect(client.contextEpoch).toBe(1);
      expect(defsV2[0]!.contextEpoch).toBe(1);

      // The stale definition refuses; the fresh one works.
      await expect(defsV1[0]!.handler({ q: 'x' }, CTX)).rejects.toBeInstanceOf(McpStaleContextEpochError);
      await expect(defsV1[0]!.handler({ q: 'x' }, CTX)).rejects.toThrow(/context epoch/);
      await expect(defsV2[0]!.handler({ q: 'x', lang: 'en' }, CTX)).resolves.toMatchObject({ ok: true });

      // callToolByName enforces an explicitly carried epoch too.
      await expect(client.callToolByName('lookup', {}, { contextEpoch: 0 })).rejects.toThrow(/context epoch/);
      await expect(client.callToolByName('lookup', {}, { contextEpoch: 1 })).resolves.toMatchObject({ ok: true });
      await expect(client.callToolByName('lookup', {})).resolves.toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
  });

  it('adding or removing a tool also bumps the epoch', async () => {
    const tools: FakeTool[] = [{ name: 'a', inputSchema: { type: 'object', properties: {} } }];
    const client = new MCPClient({ createClient: () => fakeSdkClient(tools) });
    await client.connectStdio({ command: 'fake' });
    try {
      await client.listTools();
      tools.push({ name: 'b', inputSchema: { type: 'object', properties: {} } });
      await client.listTools();
      expect(client.contextEpoch).toBe(1);
      tools.splice(0, 1);
      await client.listTools();
      expect(client.contextEpoch).toBe(2);
    } finally {
      await client.close();
    }
  });
});

describe('annotations preserved on ingestion (#57a client half)', () => {
  it('listTools defs carry the wire annotations verbatim', async () => {
    const client = new MCPClient({
      createClient: () =>
        fakeSdkClient([
          {
            name: 'read_file',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
          {
            name: 'delete_file',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ]),
    });
    await client.connectStdio({ command: 'fake' });
    try {
      const defs = (await client.listTools()) as McpToolDefinition[];
      expect(defs.find((d) => d.name === 'mcp:read_file')!.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(defs.find((d) => d.name === 'mcp:delete_file')!.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    } finally {
      await client.close();
    }
  });
});

describe('ElicitationRouter (#51)', () => {
  it('routes to the handler registered for the client surface', async () => {
    const router = new ElicitationRouter();
    router.register('cli', async (req) => ({ action: 'accept', content: { via: `cli:${req.message}` } }));
    const client = new MCPClient({ elicitationRouter: router, elicitationSurface: 'cli' });
    await expect(
      client.handleElicitation({ message: 'token?', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'accept', content: { via: 'cli:token?' } });
  });

  it('declines by default for headless: no registration for the surface', async () => {
    const router = new ElicitationRouter();
    router.register('chat', async () => ({ action: 'accept', content: {} }));
    const headless = new MCPClient({ elicitationRouter: router, elicitationSurface: 'acp' });
    await expect(
      headless.handleElicitation({ message: 'x', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'decline' });

    const emptyRouterClient = new MCPClient({ elicitationRouter: new ElicitationRouter() });
    await expect(
      emptyRouterClient.handleElicitation({ message: 'x', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'decline' });
  });

  it('uses the router default surface when the client names none; handler errors decline', async () => {
    const router = new ElicitationRouter();
    router.setDefaultSurface('ws');
    router.register('ws', async () => ({ action: 'accept', content: { via: 'ws' } }));
    const client = new MCPClient({ elicitationRouter: router });
    await expect(
      client.handleElicitation({ message: 'x', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'accept', content: { via: 'ws' } });

    const throwing = new ElicitationRouter();
    throwing.register('cli', async () => {
      throw new Error('no tty');
    });
    await expect(
      throwing.route({ message: 'x', requestedSchema: {} }, 'cli'),
    ).resolves.toEqual({ action: 'decline' });
  });

  it('registration returns an unregister function; surfaces() reflects live handlers', async () => {
    const router = new ElicitationRouter();
    const off = router.register('chat', async () => ({ action: 'accept' }));
    router.register('acp', async () => ({ action: 'accept' }));
    expect(router.surfaces().sort()).toEqual(['acp', 'chat']);
    off();
    expect(router.has('chat')).toBe(false);
    expect(router.unregister('acp')).toBe(true);
    expect(router.surfaces()).toEqual([]);
  });
});
