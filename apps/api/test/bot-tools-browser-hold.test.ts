// SPDX-License-Identifier: Apache-2.0
// Item 13 (per-expert tool hot toggle) + item 14 routes (browser hold):
// real HTTP against router factories with stubbed host deps.

import express from 'express';
import { describe, expect, it } from 'vitest';
import { BrowserHoldRegistry, type BotConfig } from '@mvp/agent-runtime';
import { createBotToolsRouter, toggleBotTool } from '../src/bot-tools-routes.js';
import { createBrowserHoldRouter } from '../src/browser-hold-routes.js';

async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('toggleBotTool (pure)', () => {
  it('adds when enabling an absent tool, removes when disabling, never mutates input', () => {
    const tools = ['read_file', 'web_search'];
    expect(toggleBotTool(tools, 'run_command', true)).toEqual(['read_file', 'web_search', 'run_command']);
    expect(toggleBotTool(tools, 'web_search', false)).toEqual(['read_file']);
    expect(toggleBotTool(tools, 'read_file', true)).toEqual(tools);
    expect(tools).toEqual(['read_file', 'web_search']);
  });
});

describe('PUT /bots/:id/tools/:toolName', () => {
  function makeApp() {
    const bot: BotConfig = {
      id: 'expert-1',
      name: 'Expert',
      description: 'keep me',
      systemPrompt: 'prompt',
      provider: 'groq',
      model: 'm',
      skills: ['skill-a'],
      tools: ['read_file'],
      mcpServers: ['srv'],
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/api/bots',
      createBotToolsRouter({
        getBot: (id) => (id === bot.id ? bot : undefined),
        setBotTools: (_id, tools) => {
          bot.tools = [...tools];
          return bot.tools;
        },
        knownTools: () => ['read_file', 'web_search', 'run_command'],
      }),
    );
    return { app, bot };
  }

  it('toggle persists and leaves the rest of the roster unchanged', async () => {
    const { app, bot } = makeApp();
    const on = await request(app, 'PUT', '/api/bots/expert-1/tools/web_search', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.json.tools).toEqual(['read_file', 'web_search']);
    expect(bot.tools).toEqual(['read_file', 'web_search']);
    const off = await request(app, 'PUT', '/api/bots/expert-1/tools/read_file', { enabled: false });
    expect(off.json.tools).toEqual(['web_search']);
    // Everything else on the bot is untouched.
    expect(bot.skills).toEqual(['skill-a']);
    expect(bot.mcpServers).toEqual(['srv']);
    expect(bot.description).toBe('keep me');
    expect(bot.systemPrompt).toBe('prompt');
  });

  it('unknown tool → 400, unknown bot → 404, bad body → 400', async () => {
    const { app } = makeApp();
    expect((await request(app, 'PUT', '/api/bots/expert-1/tools/nope_tool', { enabled: true })).status).toBe(400);
    expect((await request(app, 'PUT', '/api/bots/ghost/tools/web_search', { enabled: true })).status).toBe(404);
    expect((await request(app, 'PUT', '/api/bots/expert-1/tools/web_search', { enabled: 'yes' })).status).toBe(400);
  });
});

describe('browser hold routes', () => {
  function makeApp(registry: BrowserHoldRegistry) {
    const app = express();
    app.use(express.json());
    app.use('/api/browser', createBrowserHoldRouter({ registry }));
    return app;
  }

  it('hold → list/get → release flow, with conflict + ownership rules', async () => {
    const registry = new BrowserHoldRegistry();
    const app = makeApp(registry);

    const hold = await request(app, 'POST', '/api/browser/holds/bot-a', { personId: 'p1', personName: 'Ash' });
    expect(hold.status).toBe(201);
    expect(registry.get('bot-a')?.personId).toBe('p1');

    const conflict = await request(app, 'POST', '/api/browser/holds/bot-a', { personId: 'p2' });
    expect(conflict.status).toBe(409);
    expect(String(conflict.json.error)).toContain('held by Ash');

    const list = await request(app, 'GET', '/api/browser/holds');
    expect((list.json.holds as unknown[]).length).toBe(1);

    const wrongRelease = await request(app, 'DELETE', '/api/browser/holds/bot-a', { personId: 'p2' });
    expect(wrongRelease.status).toBe(409);

    const release = await request(app, 'DELETE', '/api/browser/holds/bot-a', { personId: 'p1' });
    expect(release.status).toBe(200);
    expect(registry.get('bot-a')).toBeUndefined();

    const gone = await request(app, 'DELETE', '/api/browser/holds/bot-a', { personId: 'p1' });
    expect(gone.status).toBe(404);
  });

  it('hold without personId is a 400', async () => {
    const app = makeApp(new BrowserHoldRegistry());
    expect((await request(app, 'POST', '/api/browser/holds/bot-a', {})).status).toBe(400);
  });
});
