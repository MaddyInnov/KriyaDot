// SPDX-License-Identifier: Apache-2.0
// Lazy MCP directory HTTP routes (OpenMausBot parity P1 #22): install from
// the directory, enable/disable, per-bot access, uninstall, warm-up —
// against a real LazyMcpManager with a fake connector (no real servers).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LazyMcpManager, type InstalledMcpServer, type LazyMcpConnector, type ToolDefinition } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { registerMcpDirectoryRoutes } from '../src/mcp-directory-routes.js';

let dataDir: string;
let manager: LazyMcpManager;
let server: { close(cb: () => void): void } | undefined;
let baseUrl = '';
const audits: Array<{ action: string; fields: unknown }> = [];
const connectCalls: string[] = [];

function fakeConnector(): LazyMcpConnector {
  return {
    async listTools() {
      return [
        {
          name: 'mcp:fake:tool',
          description: 'fake tool',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ ok: true }),
        },
      ];
    },
    async close() {},
  };
}

const governance = {
  audit: (action: string, fields: unknown) => void audits.push({ action, fields }),
} as unknown as GovernanceGateway;

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerMcpDirectoryRoutes(router, {
    manager,
    governance,
    refreshStubs: () => manager.syncRegistry(registry),
  });
  app.use('/api', router);
  return app;
}

const registry = new Map<string, ToolDefinition>();

beforeEach(async () => {
  audits.length = 0;
  connectCalls.length = 0;
  registry.clear();
  dataDir = mkdtempSync(join(tmpdir(), 'mcp-dir-routes-test-'));
  manager = new LazyMcpManager({
    dataDir,
    connectFn: async (s: InstalledMcpServer) => {
      connectCalls.push(s.label);
      return fakeConnector();
    },
  });
  const app = makeApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const port = (server as unknown as { address(): { port: number } }).address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await manager.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(baseUrl + path, init);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}
const post = (path: string, data?: unknown) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });

describe('MCP directory routes', () => {
  it('lists the directory with install state', async () => {
    const { status, body } = await api('/api/mcp/directory');
    expect(status).toBe(200);
    const entries = body as unknown as Array<{ id: string; installed: boolean }>;
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.find((e) => e.id === 'fetch')?.installed).toBe(false);
  });

  it('installs from the directory without connecting', async () => {
    const { status, body } = await post('/api/mcp/servers', { directoryId: 'fetch' });
    expect(status).toBe(201);
    expect((body as { label: string }).label).toBe('fetch');
    expect(connectCalls).toHaveLength(0);
    expect(registry.has('mcp:fetch:fetch')).toBe(true);
    expect(audits.some((a) => a.action === 'mcp.server_installed')).toBe(true);

    const dir = (await api('/api/mcp/directory')).body as unknown as Array<{ id: string; installed: boolean; serverId: string | null }>;
    expect(dir.find((e) => e.id === 'fetch')?.installed).toBe(true);
  });

  it('rejects unknown directory entries and bad input', async () => {
    expect((await post('/api/mcp/servers', { directoryId: 'nope' })).status).toBe(400);
    expect((await post('/api/mcp/servers', {})).status).toBe(400);
    expect((await post('/api/mcp/servers', { label: 'x' })).status).toBe(400);
  });

  it('installs custom configs', async () => {
    const { status, body } = await post('/api/mcp/servers', {
      label: 'custom-http',
      config: { kind: 'http', url: 'https://example.com/mcp' },
    });
    expect(status).toBe(201);
    expect((body as { directoryId: string | null }).directoryId).toBeNull();
  });

  it('enable/disable toggles health + registry stubs', async () => {
    const installed = (await post('/api/mcp/servers', { directoryId: 'time' })).body as { id: string };
    expect(registry.has('mcp:time:get_current_time')).toBe(true);
    await post(`/api/mcp/servers/${installed.id}/disable`);
    expect(registry.has('mcp:time:get_current_time')).toBe(false);
    await post(`/api/mcp/servers/${installed.id}/enable`);
    expect(registry.has('mcp:time:get_current_time')).toBe(true);
    expect((await post(`/api/mcp/servers/nope/disable`)).status).toBe(404);
  });

  it('per-bot overrides are stored', async () => {
    const installed = (await post('/api/mcp/servers', { directoryId: 'fetch' })).body as { id: string };
    const r = await api(`/api/mcp/servers/${installed.id}/bots/bot-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(r.status).toBe(200);
    expect(manager.store.isBotAllowed(installed.id, 'bot-1')).toBe(false);
    expect(manager.store.isBotAllowed(installed.id, 'bot-2')).toBe(true);
    expect((await api(`/api/mcp/servers/${installed.id}/bots/bot-1`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'x' }),
    })).status).toBe(400);
  });

  it('warm-up connects eagerly and reports health', async () => {
    const installed = (await post('/api/mcp/servers', { directoryId: 'fetch' })).body as { id: string };
    const { status, body } = await post(`/api/mcp/servers/${installed.id}/connect`);
    expect(status).toBe(200);
    expect((body as { health: { status: string } }).health.status).toBe('running');
    expect(connectCalls).toContain('fetch');
  });

  it('uninstall removes the server and its stubs', async () => {
    const installed = (await post('/api/mcp/servers', { directoryId: 'fetch' })).body as { id: string };
    const { status } = await api(`/api/mcp/servers/${installed.id}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(registry.has('mcp:fetch:fetch')).toBe(false);
    expect(manager.list()).toHaveLength(0);
    expect(audits.some((a) => a.action === 'mcp.server_uninstalled')).toBe(true);
  });

  it('lists servers with health', async () => {
    await post('/api/mcp/servers', { directoryId: 'fetch' });
    const { status, body } = await api('/api/mcp/servers');
    expect(status).toBe(200);
    const servers = body as unknown as Array<{ label: string; health: { status: string } }>;
    expect(servers).toHaveLength(1);
    expect(servers[0].health.status).toBe('stopped');
  });

  it('syncRegistry does not clobber seed MCP tools with other labels', async () => {
    registry.set('mcp:seedserver:tool', {
      name: 'mcp:seedserver:tool',
      description: 'seed',
      parameters: {},
      handler: async () => ({}),
    } as never);
    await post('/api/mcp/servers', { directoryId: 'fetch' });
    expect(registry.has('mcp:seedserver:tool')).toBe(true);
    void vi;
  });
});
