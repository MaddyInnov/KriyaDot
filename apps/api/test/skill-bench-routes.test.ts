// SPDX-License-Identifier: Apache-2.0
// Skill bench routes (§1.20): real HTTP, real UserSkillStore, mock
// provider runner injected — zero paid API usage.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserSkillStore, type BotConfig } from '@mvp/agent-runtime';
import { createSkillBenchRouter } from '../src/skill-bench-routes.js';

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

const bot: BotConfig = {
  id: 'bot-1',
  name: 'Bench Bot',
  description: 'd',
  systemPrompt: 'p',
  provider: 'groq',
  model: 'm',
  skills: [],
  tools: [],
  mcpServers: [],
};

let store: UserSkillStore;
let app: express.Express;

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), 'skill-bench-routes-'));
  store = new UserSkillStore(dataDir, join(dataDir, 'skills'));
  store.createSkill({
    name: 'greeter',
    description: 'Greets',
    instructions: 'Always say hello and offer tea.',
    source: 'manual',
  });
  app = express();
  app.use(express.json());
  app.use(
    '/api/skills',
    createSkillBenchRouter({
      store,
      getBot: (id) => (id === bot.id ? bot : undefined),
      runTurn: async (_bot, req) => {
        // Mock provider: echoes the skill-flavored answer.
        if (req.prompt.includes('stock')) return { response: 'checking', toolsUsed: ['inventory_lookup'] };
        return { response: `Hello! ${req.skillInstructions.includes('tea') ? 'Tea?' : ''}`, toolsUsed: [] };
      },
    }),
  );
});

describe('POST /:name/bench', () => {
  it('runs cases and returns the aggregated report', async () => {
    const res = await request(app, 'POST', '/api/skills/greeter/bench', {
      botId: 'bot-1',
      cases: [
        { prompt: 'greet me', expectContains: ['hello', 'tea'] },
        { prompt: 'check stock', expectTool: 'inventory_lookup' },
        { prompt: 'greet me', expectContains: ['goodbye'] },
      ],
    });
    expect(res.status).toBe(200);
    const report = res.json.report as { total: number; passed: number; failed: number; passRate: number };
    expect(report).toMatchObject({ total: 3, passed: 2, failed: 1 });
    expect(report.passRate).toBeCloseTo(2 / 3);
  });

  it('404s unknown bots and skills; 400s invalid cases', async () => {
    expect(
      (await request(app, 'POST', '/api/skills/greeter/bench', { botId: 'nope', cases: [{ prompt: 'x', expectContains: ['y'] }] })).status,
    ).toBe(404);
    expect(
      (await request(app, 'POST', '/api/skills/ghost/bench', { botId: 'bot-1', cases: [{ prompt: 'x', expectContains: ['y'] }] })).status,
    ).toBe(404);
    expect(
      (await request(app, 'POST', '/api/skills/greeter/bench', { botId: 'bot-1', cases: [{ prompt: 'x' }] })).status,
    ).toBe(400);
  });
});
