// SPDX-License-Identifier: Apache-2.0
// #53: the mcp_manage agent tool exposes add/remove/persist — a bot can
// install a new MCP server mid-session (persisted through the directory
// store AND connected live) and remove one (disconnected + record
// deleted), on top of the pre-existing list/status/health_check/
// restart/bind actions.
// No network, no processes: LazyMcpManager runs on a fake connectFn.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LazyMcpManager, type LazyMcpConnector } from '@mvp/agent-runtime';
import type { ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { createMcpManageTool } from '../src/mcp-manage-tool.js';

const dirs: string[] = [];
const managers: LazyMcpManager[] = [];

function fakeConnector(): LazyMcpConnector {
  return {
    async listTools(): Promise<ToolDefinition[]> {
      return [
        {
          name: 'call',
          description: 'call',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ ok: true }),
        },
      ];
    },
    async close() {},
    async ping() {},
  };
}

function setup(connectFn?: ConstructorParameters<typeof LazyMcpManager>[0]['connectFn']) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-manage-test-'));
  dirs.push(dataDir);
  const manager = new LazyMcpManager({
    dataDir,
    healthCheckIntervalMs: 0,
    connectFn: connectFn ?? (async () => fakeConnector()),
  });
  managers.push(manager);
  const tool = createMcpManageTool(manager);
  const ctx = { sessionId: 's1', botId: 'bot1' } as ToolContext;
  return { dataDir, manager, call: (args: Record<string, unknown>) => tool.handler(args, ctx) as Promise<any> };
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('mcp_manage add/remove (#53)', () => {
  it('add with a custom config persists AND connects live; a fresh manager still lists it', async () => {
    const { dataDir, manager, call } = setup();
    const res = await call({
      action: 'add',
      label: 'custom-one',
      config: { kind: 'stdio', command: 'true', args: [] },
    });
    expect(res.added).toBe(true);
    expect(res.persisted).toBe(true);
    expect(res.server).toBe('custom-one');
    expect(res.health.status).toBe('running');
    expect(manager.list().map((s) => s.label)).toEqual(['custom-one']);

    const fresh = new LazyMcpManager({ dataDir, healthCheckIntervalMs: 0, connectFn: async () => fakeConnector() });
    managers.push(fresh);
    expect(fresh.list().map((s) => s.label)).toEqual(['custom-one']);
  });

  it('add from a directoryId installs the curated server', async () => {
    const { call } = setup();
    const res = await call({ action: 'add', directoryId: 'filesystem', connect: false });
    expect(res.added).toBe(true);
    expect(res.persisted).toBe(true);
    expect(res.server).toBe('filesystem');
  });

  it('add with connect:false persists only', async () => {
    const { call } = setup();
    const res = await call({
      action: 'add',
      label: 'lazy-one',
      config: { kind: 'stdio', command: 'true' },
      connect: false,
    });
    expect(res.added).toBe(true);
    expect(res.health.status).toBe('stopped');
  });

  it('add validates its inputs', async () => {
    const { call } = setup();
    expect((await call({ action: 'add' })).error).toMatch(/directoryId/);
    expect((await call({ action: 'add', config: { kind: 'stdio', command: 'true' } })).error).toMatch(/label/);
    expect((await call({ action: 'add', directoryId: 'nope' })).error).toMatch(/add failed/);
  });

  it('a failed live connect still reports the durable install', async () => {
    const { call, manager } = setup(async () => {
      throw new Error('spawn blew up');
    });
    const res = await call({
      action: 'add',
      label: 'broken-one',
      config: { kind: 'stdio', command: 'true' },
    });
    expect(res.added).toBe(true);
    expect(res.persisted).toBe(true);
    expect(res.connected).toBe(false);
    expect(res.health.status).toBe('error');
    expect(manager.list().map((s) => s.label)).toEqual(['broken-one']);
  });

  it('remove disconnects live and deletes the persisted record', async () => {
    const { dataDir, call } = setup();
    await call({ action: 'add', label: 'temp-one', config: { kind: 'stdio', command: 'true' } });
    const res = await call({ action: 'remove', server: 'temp-one' });
    expect(res).toEqual({ removed: true, persisted: true, server: 'temp-one' });

    const fresh = new LazyMcpManager({ dataDir, healthCheckIntervalMs: 0, connectFn: async () => fakeConnector() });
    managers.push(fresh);
    expect(fresh.list()).toEqual([]);
    expect((await call({ action: 'remove', server: 'temp-one' })).error).toMatch(/no MCP server matches/);
  });

  it('the pre-existing actions still work alongside add/remove', async () => {
    const { call } = setup();
    await call({ action: 'add', label: 'kept', config: { kind: 'stdio', command: 'true' } });
    const list = await call({ action: 'list' });
    expect(list.servers.map((s: { label: string }) => s.label)).toEqual(['kept']);
    const status = await call({ action: 'status', server: 'kept' });
    expect(status.health.status).toBe('running');
    expect((await call({ action: 'bogus' })).error).toMatch(/unknown action/);
  });
});
