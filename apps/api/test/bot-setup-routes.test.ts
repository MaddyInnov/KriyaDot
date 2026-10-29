// SPDX-License-Identifier: Apache-2.0
// W12a "Set me up" routes: propose creates NOTHING; apply (the approval)
// creates the bot with the proposed config + the suggested routines;
// rejecting = never calling apply. Mock provider — zero paid usage.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, type BotConfig } from '@mvp/agent-runtime';
import { createBotSetupRouter } from '../src/bot-setup-routes.js';
import { RoutineStore } from '../src/bot-routines.js';

const MODEL_JSON = JSON.stringify({
  name: 'Inbox Pilot',
  description: 'Watches Gmail and drafts replies.',
  systemPrompt: 'You are Inbox Pilot. Read new Gmail each morning and draft replies.',
  tools: ['gmail_read', 'web_search', 'teleport'],
  mcpServers: ['gmail', 'bogus-server'],
  routines: [
    {
      name: 'Morning inbox draft',
      promptTemplate: 'Read overnight Gmail and draft replies for review.',
      schedule: { kind: 'daily', timezone: 'UTC', enabled: true, overlap: 'skip', time: '08:00', weekdays: [1, 2, 3, 4, 5] },
    },
  ],
});

let dataDir: string;
let bots: BotConfig[];
let routineStore: RoutineStore;
let base: string;
let server: ReturnType<express.Express['listen']>;

const seedBot: BotConfig = {
  id: 'helper',
  name: 'Helper',
  description: 'default',
  systemPrompt: 'help',
  provider: 'groq',
  model: 'gpt-oss-20b',
  skills: [],
  tools: ['web_search'],
  mcpServers: [],
};

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'bot-setup-api-'));
  bots = [{ ...seedBot }];
  routineStore = new RoutineStore(dataDir);
  const provider = new MockProvider([{ content: MODEL_JSON }]);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/bots/setup',
    createBotSetupRouter({
      dataDir,
      getBots: () => bots,
      toolNames: () => ['web_search', 'web_fetch', 'gmail_read', 'ask_user_question'],
      mcpServerNames: () => ['gmail'],
      skillNames: () => [],
      routineStore,
      resolveSetupProvider: () => ({ provider, model: 'mock-model', providerId: 'mock' }),
      audit: () => undefined,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /propose', () => {
  it('returns a filtered proposal and creates nothing', async () => {
    const { status, json } = await req('POST', '/api/bots/setup/propose', {
      sentence: 'I need a bot that watches my Gmail and drafts replies every morning',
    });
    expect(status).toBe(200);
    const proposal = json.proposal as {
      name: string;
      tools: string[];
      droppedTools: string[];
      mcpServers: string[];
      routines: Array<{ name: string; schedule?: { kind: string } }>;
    };
    expect(proposal.name).toBe('Inbox Pilot');
    expect(proposal.tools).toEqual(['gmail_read', 'web_search']);
    expect(proposal.droppedTools).toEqual(['teleport']);
    expect(proposal.mcpServers).toEqual(['gmail']);
    expect(proposal.routines[0]?.schedule?.kind).toBe('daily');
    // Nothing created before approval:
    expect(bots.map((b) => b.id)).toEqual(['helper']);
    expect(routineStore.list()).toEqual([]);
  });

  it('rejects a missing sentence', async () => {
    const { status } = await req('POST', '/api/bots/setup/propose', {});
    expect(status).toBe(400);
  });
});

describe('POST /apply (approval)', () => {
  it('creates the bot with the proposed config and the suggested routines', async () => {
    const proposed = await req('POST', '/api/bots/setup/propose', { sentence: 'gmail drafts every morning' });
    const proposal = proposed.json.proposal;
    const { status, json } = await req('POST', '/api/bots/setup/apply', { proposal });
    expect(status).toBe(200);
    const bot = json.bot as BotConfig;
    expect(bot.id).toBe('inbox-pilot');
    expect(bot.name).toBe('Inbox Pilot');
    expect(bot.systemPrompt).toContain('Inbox Pilot');
    expect(bot.tools).toEqual(['gmail_read', 'web_search']);
    expect(bot.mcpServers).toEqual(['gmail']);
    expect(bots.map((b) => b.id)).toEqual(['helper', 'inbox-pilot']);
    const routines = json.routines as Array<{ name: string; botId: string; schedule?: { kind: string } }>;
    expect(routines).toHaveLength(1);
    expect(routines[0]!.botId).toBe('inbox-pilot');
    expect(routines[0]!.schedule?.kind).toBe('daily');
    expect(routineStore.list()).toHaveLength(1);
    expect(json.skippedRoutines).toEqual([]);
  });

  it('rejection path: discarding a proposal (never applying) leaves no trace', async () => {
    await req('POST', '/api/bots/setup/propose', { sentence: 'gmail drafts every morning' });
    // User discards → no /apply call.
    expect(bots).toHaveLength(1);
    expect(routineStore.list()).toEqual([]);
  });

  it('re-validates on apply: tools smuggled into the proposal are filtered out', async () => {
    const proposed = await req('POST', '/api/bots/setup/propose', { sentence: 'gmail drafts' });
    const proposal = proposed.json.proposal as { tools: string[] };
    proposal.tools = ['gmail_read', 'run_command_evil'];
    const { status, json } = await req('POST', '/api/bots/setup/apply', { proposal });
    expect(status).toBe(200);
    expect((json.bot as BotConfig).tools).toEqual(['gmail_read']);
  });

  it('rejects a missing proposal', async () => {
    const { status } = await req('POST', '/api/bots/setup/apply', {});
    expect(status).toBe(400);
  });
});
