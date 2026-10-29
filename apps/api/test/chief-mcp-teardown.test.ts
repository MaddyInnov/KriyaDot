// SPDX-License-Identifier: Apache-2.0
// Bot-deletion teardown for per-bot private MCP servers (W9): approving a
// chief delete proposal for a bot fires the onBotDeleted hook, which the
// host wires to PerBotMcpManager.removeAllForBot — the bot's private MCP
// processes are killed and its configs dropped, other bots untouched.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PerBotMcpManager,
  type BotConfig,
  type LazyMcpConnector,
  type PrivateMcpServer,
  type ToolDefinition,
} from '@mvp/agent-runtime';
import { ChiefTeamsStore } from '../src/chief-teams.js';
import { createChiefRouter } from '../src/chief-routes.js';

function bot(id: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

let dir: string;
let bots: BotConfig[];
let store: ChiefTeamsStore;
let mcp: PerBotMcpManager;
let closedFor: string[];
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chief-mcp-teardown-'));
  bots = [bot('helper'), bot('coder')];
  store = new ChiefTeamsStore(dir);
  closedFor = [];
  mcp = new PerBotMcpManager({
    dataDir: dir,
    connectFn: async (s: PrivateMcpServer): Promise<LazyMcpConnector> => ({
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
      async close() {
        closedFor.push(s.botId);
      },
    }),
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/teams',
    createChiefRouter({
      dataDir: dir,
      getBots: () => bots,
      store,
      retryDelegation: async () => undefined,
      audit: () => undefined,
      onBotDeleted: (botId) => mcp.removeAllForBot(botId),
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${addr.port}/api/teams`;
});

afterEach(async () => {
  await mcp.close().catch(() => undefined);
  store.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('chief delete → private MCP teardown', () => {
  it('deleting a bot kills its private MCP processes and drops its configs', async () => {
    // Both bots run a private "fetch" server; coder's is connected (live process).
    mcp.installFromDirectory('coder', 'fetch');
    const helperServer = mcp.installFromDirectory('helper', 'fetch');
    const coderDef = mcp
      .toolDefinitions('coder')
      .find((d) => d.name === 'mcp:fetch:fetch')!;
    await coderDef.handler({}, { sessionId: 's', botId: 'coder' });
    expect(mcp.connectedKeys()).toHaveLength(1);

    const proposal = store.createProposal({
      kind: 'delete-bot' as never,
      createdByBotId: 'helper',
      reason: 'test',
      operations: [{ action: 'delete', botId: 'coder' }] as never,
    });
    const res = await fetch(`${baseUrl}/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(bots.some((b) => b.id === 'coder')).toBe(false);

    // The hook is fire-and-forget in the route; wait for teardown to land.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && mcp.listForBot('coder').length > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(mcp.listForBot('coder')).toEqual([]);
    expect(closedFor).toContain('coder');
    expect(mcp.connectedKeys()).toEqual([]);
    // Helper's private server is untouched.
    expect(mcp.listForBot('helper')).toHaveLength(1);
    expect(mcp.getForBot('helper', helperServer.id)).toBeDefined();
  });
});
