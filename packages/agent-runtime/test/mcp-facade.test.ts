// SPDX-License-Identifier: Apache-2.0
// #48: the in-process MCP facade — built-in tools executed THROUGH the
// MCP protocol path (JSON-RPC frames over a loopback pair), plus the
// direct/mcp transport switch.

import { describe, expect, it } from 'vitest';
import {
  createDirectFacade,
  createMcpFacade,
  createToolFacade,
  toolTransportFromEnv,
  type McpFrameObservation,
} from '../src/mcp-facade.js';
import type { McpToolDefinition } from '../src/mcp.js';
import type { ToolDefinition } from '../src/types.js';

function makeRegistry(): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  registry.set('read_file', {
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async (args) => ({ content: `file:${String(args.path)}`, bytes: 42 }),
  });
  registry.set('write_file', {
    name: 'write_file',
    description: 'Write a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    mutating: true,
    handler: async () => 'written',
  });
  registry.set('lucky_number', {
    name: 'lucky_number',
    description: 'A string that looks like a number must stay a string.',
    parameters: { type: 'object', properties: {} },
    handler: async () => '123',
  });
  return registry;
}

describe('MCP facade (#48)', () => {
  it('executes a built-in tool through real MCP JSON-RPC frames', async () => {
    const frames: McpFrameObservation[] = [];
    const facade = await createMcpFacade(makeRegistry(), { onFrame: (f) => frames.push(f) });
    try {
      const result = await facade.callTool('read_file', { path: '/tmp/x' });
      expect(result).toEqual({ content: 'file:/tmp/x', bytes: 42 });

      const requests = frames.filter((f) => f.direction === 'client->server');
      const methods = requests.map((f) => f.frame.method).filter(Boolean);
      // The full protocol path was traversed, in order.
      expect(methods).toContain('initialize');
      expect(methods).toContain('tools/list');
      expect(methods).toContain('tools/call');
      expect(methods.indexOf('initialize')).toBeLessThan(methods.indexOf('tools/call'));
      for (const f of requests) {
        expect(f.frame.jsonrpc).toBe('2.0');
      }
      const callFrame = requests.find((f) => f.frame.method === 'tools/call')!;
      const params = callFrame.frame.params as { name: string; arguments: unknown };
      expect(params.name).toBe('read_file');
      expect(params.arguments).toEqual({ path: '/tmp/x' });
      // And the server answered with a JSON-RPC result frame.
      const responses = frames.filter(
        (f) => f.direction === 'server->client' && f.frame.id === callFrame.frame.id,
      );
      expect(responses).toHaveLength(1);
      expect(responses[0]!.frame.result).toBeDefined();
    } finally {
      await facade.close();
    }
  });

  it('lists tools under the registry names (no mcp: prefix leakage)', async () => {
    const facade = await createMcpFacade(makeRegistry());
    try {
      const defs = await facade.listTools();
      expect(defs.map((d) => d.name).sort()).toEqual(['lucky_number', 'read_file', 'write_file']);
      // A listed def's handler also goes through the MCP path.
      const read = defs.find((d) => d.name === 'read_file')!;
      await expect(read.handler({ path: '/a' }, { sessionId: 's', botId: 'b' })).resolves.toEqual({
        content: 'file:/a',
        bytes: 42,
      });
    } finally {
      await facade.close();
    }
  });

  it('preserves string results verbatim, including numeric-looking strings', async () => {
    const facade = await createMcpFacade(makeRegistry());
    try {
      await expect(facade.callTool('write_file', { path: '/a' })).resolves.toBe('written');
      await expect(facade.callTool('lucky_number', {})).resolves.toBe('123');
    } finally {
      await facade.close();
    }
  });

  it('carries tool annotations through the facade listing (#57a)', async () => {
    const facade = await createMcpFacade(makeRegistry());
    try {
      const defs = (await facade.listTools()) as McpToolDefinition[];
      const read = defs.find((d) => d.name === 'read_file')!;
      expect(read.annotations?.readOnlyHint).toBe(true);
      expect(read.annotations?.destructiveHint).toBe(false);
      const write = defs.find((d) => d.name === 'write_file')!;
      expect(write.annotations?.readOnlyHint).toBe(false);
      expect(write.annotations?.destructiveHint).toBe(true);
    } finally {
      await facade.close();
    }
  });

  it('rejects unknown tools and surfaces handler errors', async () => {
    const registry = makeRegistry();
    registry.set('boom', {
      name: 'boom',
      description: 'Fails.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('kaboom');
      },
    });
    const facade = await createMcpFacade(registry);
    try {
      await expect(facade.callTool('nope', {})).rejects.toThrow(/Unknown tool/);
      await expect(facade.callTool('boom', {})).rejects.toThrow(/kaboom/);
    } finally {
      await facade.close();
    }
  });

  it('sees live registry changes on the next listing', async () => {
    const registry = makeRegistry();
    const facade = await createMcpFacade(registry);
    try {
      expect((await facade.listTools()).map((d) => d.name)).not.toContain('late_tool');
      registry.set('late_tool', {
        name: 'late_tool',
        description: 'Added after the facade was built.',
        parameters: { type: 'object', properties: {} },
        handler: async () => 'late',
      });
      expect((await facade.listTools()).map((d) => d.name)).toContain('late_tool');
      await expect(facade.callTool('late_tool', {})).resolves.toBe('late');
    } finally {
      await facade.close();
    }
  });
});

describe('tool transport switch (#48)', () => {
  it('defaults to direct and reads the env spelling', () => {
    expect(toolTransportFromEnv({})).toBe('direct');
    expect(toolTransportFromEnv({ KRIYADOT_TOOL_TRANSPORT: 'mcp' })).toBe('mcp');
    expect(toolTransportFromEnv({ KRIYADOT_TOOL_TRANSPORT: 'direct' })).toBe('direct');
    expect(toolTransportFromEnv({ KRIYADOT_TOOL_TRANSPORT: 'bogus' })).toBe('direct');
  });

  it('direct and mcp facades are interchangeable for the same registry', async () => {
    const registry = makeRegistry();
    const direct = createDirectFacade(registry);
    const viaSwitch = await createToolFacade(registry, { toolTransport: 'mcp' });
    try {
      expect(direct.transport).toBe('direct');
      expect(viaSwitch.transport).toBe('mcp');
      for (const facade of [direct, viaSwitch]) {
        expect((await facade.listTools()).map((d) => d.name).sort()).toEqual([
          'lucky_number',
          'read_file',
          'write_file',
        ]);
        await expect(facade.callTool('read_file', { path: '/same' })).resolves.toEqual({
          content: 'file:/same',
          bytes: 42,
        });
      }
      const defaulted = await createToolFacade(registry, {});
      expect(defaulted.transport).toBe('direct');
      await defaulted.close();
    } finally {
      await direct.close();
      await viaSwitch.close();
    }
  });
});
