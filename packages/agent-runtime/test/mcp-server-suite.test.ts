// SPDX-License-Identifier: Apache-2.0
// #52: the five builtin MCP servers (core / orchestration / runtime /
// agent / local) as a partition of the platform surface.
// #57a: tools/list emits MCP annotations derived from `mutating`.
// #55 (server side): PlatformMcpServer honors a per-server tool filter.

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { ToolCall } from '../src/types.js';
import {
  BUILTIN_MCP_SERVER_IDS,
  PlatformMcpServer,
  annotationsForTool,
  builtinServerForTool,
  createBuiltinMcpServer,
  createPlatformMcpServerSuite,
  partitionToolDefs,
  type PlatformToolDef,
  type ToolProvider,
} from '../src/mcp-server.js';

type FakeGovernance = Pick<GovernanceGateway, 'classify' | 'evaluate' | 'audit'>;

function allowAll(): FakeGovernance {
  return {
    classify: () => 'allow' as GovernanceDecision,
    evaluate: async () => ({ decision: 'allow' as GovernanceDecision }),
    audit: () => undefined,
  };
}

const ALL_TOOLS: PlatformToolDef[] = [
  { name: 'read_file', description: 'local read', parameters: { type: 'object', properties: {} } },
  { name: 'write_file', description: 'local write', parameters: { type: 'object', properties: {} }, mutating: true },
  { name: 'run_command', description: 'local shell', parameters: { type: 'object', properties: {} }, mutating: true },
  { name: 'delegate_task', description: 'orchestration', parameters: { type: 'object', properties: {} } },
  { name: 'mcp_manage', description: 'orchestration', parameters: { type: 'object', properties: {} } },
  { name: 'memory_store', description: 'runtime memory', parameters: { type: 'object', properties: {} }, mutating: true },
  { name: 'recall_compacted_context', description: 'runtime recall', parameters: { type: 'object', properties: {} } },
  { name: 'web_search', description: 'agent web', parameters: { type: 'object', properties: {} } },
  { name: 'ask_user_question', description: 'agent interaction', parameters: { type: 'object', properties: {} } },
  { name: 'platform_ping', description: 'core misc', parameters: { type: 'object', properties: {} } },
];

function provider(calls: string[]): ToolProvider {
  return {
    listTools: () => ALL_TOOLS,
    callTool: async (name, args) => {
      calls.push(name);
      return { ok: true, name, args };
    },
  };
}

function suiteOpts(calls: string[]) {
  return {
    tools: provider(calls),
    governance: allowAll(),
    botId: 'suite-bot',
    chat: { handler: async (message: string) => ({ reply: message }) },
  };
}

describe('builtinServerForTool / partitionToolDefs (#52)', () => {
  it('assigns every tool to exactly one expected server', () => {
    expect(builtinServerForTool('read_file')).toBe('local');
    expect(builtinServerForTool('git_commit')).toBe('local');
    expect(builtinServerForTool('delegate_task')).toBe('orchestration');
    expect(builtinServerForTool('coordinate_bots')).toBe('orchestration');
    expect(builtinServerForTool('memory_recall')).toBe('runtime');
    expect(builtinServerForTool('checkpoint_save')).toBe('runtime');
    expect(builtinServerForTool('chat')).toBe('agent');
    expect(builtinServerForTool('web_fetch')).toBe('agent');
    expect(builtinServerForTool('something_else')).toBe('core');
    const parts = partitionToolDefs(ALL_TOOLS);
    const total = Object.values(parts).reduce((n, arr) => n + arr.length, 0);
    expect(total).toBe(ALL_TOOLS.length);
    for (const id of BUILTIN_MCP_SERVER_IDS) expect(parts[id].length).toBeGreaterThan(0);
  });
});

describe('five-server suite (#52)', () => {
  it('each server lists ONLY its partition; the union is the full surface', async () => {
    const calls: string[] = [];
    const suite = createPlatformMcpServerSuite(suiteOpts(calls));
    try {
      expect(suite.ids()).toEqual(['core', 'orchestration', 'runtime', 'agent', 'local']);
      const byId = new Map<string, string[]>();
      for (const id of suite.ids()) {
        byId.set(id, (await suite.listToolDefs(id)).map((d) => d.name).sort());
      }
      expect(byId.get('local')).toEqual(['read_file', 'run_command', 'write_file']);
      expect(byId.get('orchestration')).toEqual(['delegate_task', 'mcp_manage']);
      expect(byId.get('runtime')).toEqual(['memory_store', 'recall_compacted_context']);
      // chat lands on agent only.
      expect(byId.get('agent')).toEqual(['ask_user_question', 'chat', 'web_search']);
      expect(byId.get('core')).toEqual(['platform_ping']);
      const union = [...byId.values()].flat();
      expect(new Set(union).size).toBe(union.length); // no tool on two servers
    } finally {
      await suite.closeAll();
    }
  });

  it('each server is independently connectable over MCP and only serves its partition', async () => {
    const calls: string[] = [];
    const suite = createPlatformMcpServerSuite(suiteOpts(calls));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await suite.get('local').connect(serverT);
    await client.connect(clientT);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['read_file', 'run_command', 'write_file']);
      const info = client.getServerVersion();
      expect(info?.name).toBe('mvp-platform-mcp-local');
      const res = await client.callTool({ name: 'read_file', arguments: {} });
      expect(res.isError).not.toBe(true);
      expect(calls).toEqual(['read_file']);
    } finally {
      await client.close();
      await suite.closeAll();
    }
  });

  it('createBuiltinMcpServer returns one partition server; the legacy single server keeps the full surface', async () => {
    const calls: string[] = [];
    const core = createBuiltinMcpServer(suiteOpts(calls), 'core');
    expect((await core.listToolDefs()).map((d) => d.name)).toEqual(['platform_ping']);
    await core.close();

    const legacy = new PlatformMcpServer(suiteOpts(calls));
    const names = (await legacy.listToolDefs()).map((d) => d.name);
    expect(names).toHaveLength(ALL_TOOLS.length + 1); // + chat
    expect(names).toContain('chat');
    expect(names).toContain('read_file');
    await legacy.close();
  });
});

describe('tool annotations (#57a)', () => {
  it('derives hints from the mutating flag', () => {
    expect(annotationsForTool({ name: 'a', description: '', parameters: {} })).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotationsForTool({ name: 'b', description: '', parameters: {}, mutating: true })).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(
      annotationsForTool({ name: 'c', description: '', parameters: {}, mutating: true, idempotent: true }),
    ).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    const custom = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
    expect(annotationsForTool({ name: 'd', description: '', parameters: {}, annotations: custom })).toBe(custom);
  });

  it('tools/list over the wire carries annotations', async () => {
    const calls: string[] = [];
    const server = new PlatformMcpServer({ tools: provider(calls), governance: allowAll(), botId: 'b' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const { tools } = await client.listTools();
      const read = tools.find((t) => t.name === 'read_file')!;
      expect(read.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const write = tools.find((t) => t.name === 'write_file')!;
      expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('per-server tool filter on PlatformMcpServer (#55)', () => {
  it('hides filtered tools from tools/list and refuses their calls', async () => {
    const calls: string[] = [];
    const server = new PlatformMcpServer({
      tools: provider(calls),
      governance: allowAll(),
      botId: 'b',
      toolFilter: { deny: ['run_*', 'memory_*'] },
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('run_command');
      expect(names).not.toContain('memory_store');
      expect(names).toContain('read_file');
      const res = await client.callTool({ name: 'run_command', arguments: {} });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('tool_filtered');
      expect(calls).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Keep the ToolCall type import referenced for governance fakes above.
export type { ToolCall };
