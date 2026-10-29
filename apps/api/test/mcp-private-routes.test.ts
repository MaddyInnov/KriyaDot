// SPDX-License-Identifier: Apache-2.0
// Per-bot private MCP server HTTP routes (W9 engines pack): install is
// scoped to one bot, lists never leak across bots, config updates and
// deletes go through the manager, unknown bots 404 — against a real
// PerBotMcpManager with a fake connector (no real servers spawn).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PerBotMcpManager,
  type LazyMcpConnector,
  type PrivateMcpServer,
  type ToolDefinition,
} from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { registerMcpPrivateRoutes } from '../src/mcp-private-routes.js';

let dataDir: string;
let manager: PerBotMcpManager;
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';
const audits: Array<{ action: string; fields: unknown }> = [];
const connectCalls: string[] = [];

function fakeConnector(s: PrivateMcpServer): LazyMcpConnector {
  connectCalls.push(`${s.botId}:${s.label}`);
  return {
    async listTools(): Promise<ToolDefinition[]> {
      return [
        {
          name: `mcp:${s.label}:fetch`,
          description: 'fake',
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

const BOTS = [{ id: 'bot-a' }, { id: 'bot-b' }];

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

beforeEach(async () => {
  audits.length = 0;
  connectCalls.length = 0;
  dataDir = mkdtempSync(join(tmpdir(), 'mcp-private-routes-'));
  manager = new PerBotMcpManager({ dataDir, connectFn: async (s) => fakeConnector(s) });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerMcpPrivateRoutes(router, {
    manager,
    governance,
    botExists: (botId) => BOTS.some((b) => b.id === botId),
  });
  app.use('/api', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
});

afterEach(async () => {
  await manager.close().catch(() => undefined);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('per-bot private MCP routes', () => {
  it('installs for one bot only; the other bot sees nothing', async () => {
    const created = await api('POST', '/bots/bot-a/mcp-servers', { directoryId: 'fetch' });
    expect(created.status).toBe(201);
    expect(created.json.label).toBe('fetch');
    expect(created.json.botId).toBe('bot-a');
    expect(connectCalls).toEqual([]); // lazy: install spawns nothing

    const listA = await api('GET', '/bots/bot-a/mcp-servers');
    expect(listA.status).toBe(200);
    expect((listA.json as unknown as unknown[]).length).toBe(1);

    const listB = await api('GET', '/bots/bot-b/mcp-servers');
    expect(listB.status).toBe(200);
    expect(listB.json).toEqual([]);

    // Same label is fine for bot-b (labels are per-bot).
    const createdB = await api('POST', '/bots/bot-b/mcp-servers', { directoryId: 'fetch' });
    expect(createdB.status).toBe(201);
    expect(audits.some((a) => a.action === 'mcp.private_server_installed')).toBe(true);
  });

  it('404s for unknown bots and unknown servers', async () => {
    expect((await api('GET', '/bots/ghost/mcp-servers')).status).toBe(404);
    expect((await api('DELETE', '/bots/bot-a/mcp-servers/nope')).status).toBe(404);
    expect((await api('GET', '/bots/bot-a/mcp-servers/nope/tools')).status).toBe(404);
  });

  it('tools endpoint lists only the owning bot tools', async () => {
    const created = await api('POST', '/bots/bot-a/mcp-servers', { directoryId: 'fetch' });
    const id = created.json.id as string;
    const tools = await api('GET', `/bots/bot-a/mcp-servers/${id}/tools`);
    expect(tools.status).toBe(200);
    expect(tools.json.tools).toContain('mcp:fetch:fetch');
    // Bot B asking for bot A's server id gets a 404 (no cross-bot visibility).
    expect((await api('GET', `/bots/bot-b/mcp-servers/${id}/tools`)).status).toBe(404);
  });

  it('config update replaces the config and audits; delete removes the server', async () => {
    const created = await api('POST', '/bots/bot-a/mcp-servers', {
      label: 'custom',
      config: { kind: 'stdio', command: 'old-cmd' },
    });
    const id = created.json.id as string;
    const updated = await api('PUT', `/bots/bot-a/mcp-servers/${id}`, {
      config: { kind: 'stdio', command: 'new-cmd', args: ['v2'] },
    });
    expect(updated.status).toBe(200);
    expect((updated.json.config as { command: string }).command).toBe('new-cmd');
    expect(manager.getForBot('bot-a', id)?.config.command).toBe('new-cmd');
    expect(audits.some((a) => a.action === 'mcp.private_server_config_updated')).toBe(true);

    const del = await api('DELETE', `/bots/bot-a/mcp-servers/${id}`);
    expect(del.status).toBe(200);
    expect(manager.listForBot('bot-a')).toEqual([]);
  });

  it('enable/disable toggles through the manager', async () => {
    const created = await api('POST', '/bots/bot-a/mcp-servers', { directoryId: 'time' });
    const id = created.json.id as string;
    expect((await api('POST', `/bots/bot-a/mcp-servers/${id}/disable`)).status).toBe(200);
    expect(manager.getForBot('bot-a', id)?.enabled).toBe(false);
    expect((await api('POST', `/bots/bot-a/mcp-servers/${id}/enable`)).status).toBe(200);
    expect(manager.getForBot('bot-a', id)?.enabled).toBe(true);
  });
});
