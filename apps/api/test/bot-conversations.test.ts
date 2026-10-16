// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotConversationStore, pairKey } from '../src/bot-conversations.js';
import { createBotConversationsRouter } from '../src/bot-conversations-routes.js';
import type { BotConfig } from '@mvp/agent-runtime';

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

const bots = [bot('scout'), bot('coder'), bot('helper')];

let dir: string;
let store: BotConversationStore;
let baseUrl: string;
let server: { close(cb: () => void): void };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'botconv-'));
  store = new BotConversationStore(dir);
  const app = express();
  app.use(express.json());
  app.use('/api/bots', createBotConversationsRouter({ store, getBots: () => bots }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as {
      close(cb: () => void): void;
    };
  });
  const port = (server as unknown as { address(): AddressInfo | null }).address()?.port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedExchange(source: string, target: string, type: 'ask' | 'message' = 'ask') {
  return store.record({
    sourceBotId: source,
    targetBotId: target,
    type,
    text: `from ${source} to ${target}`,
    status: 'completed',
    reply: 'ok',
  });
}

describe('pairKey', () => {
  it('is order-independent', () => {
    expect(pairKey('a', 'b')).toBe(pairKey('b', 'a'));
  });
});

describe('BotConversationStore', () => {
  it('records and lists a pair chronologically, oldest first', () => {
    seedExchange('scout', 'coder');
    seedExchange('coder', 'scout', 'message');
    seedExchange('scout', 'coder');
    const list = store.listPair('coder', 'scout'); // reversed args — same pair
    expect(list).toHaveLength(3);
    expect(list[0].sourceBotId).toBe('scout');
    expect(list[1].sourceBotId).toBe('coder');
    expect(list[1].type).toBe('message');
    expect(list[2].sourceBotId).toBe('scout');
  });

  it('isolates pairs', () => {
    seedExchange('scout', 'coder');
    seedExchange('scout', 'helper');
    expect(store.listPair('scout', 'coder')).toHaveLength(1);
    expect(store.listPair('scout', 'helper')).toHaveLength(1);
  });

  it('updates status/reply/detail', () => {
    const ex = store.record({
      sourceBotId: 'scout',
      targetBotId: 'coder',
      type: 'ask',
      text: 'q',
      status: 'pending',
    });
    expect(store.update(ex.id, { status: 'completed', reply: 'a', completedAt: 't' })).toBe(true);
    const got = store.get(ex.id);
    expect(got?.status).toBe('completed');
    expect(got?.reply).toBe('a');
  });

  it('lists peers with counts', () => {
    seedExchange('scout', 'coder');
    seedExchange('coder', 'scout', 'message');
    seedExchange('scout', 'helper');
    const peers = store.listPeers('scout');
    expect(peers).toHaveLength(2);
    const coder = peers.find((p) => p.peerId === 'coder');
    expect(coder?.exchangeCount).toBe(2);
  });
});

describe('routes', () => {
  it('GET /:botId/conversations/:otherBotId returns the sheet', async () => {
    seedExchange('scout', 'coder');
    seedExchange('coder', 'scout', 'message');
    const res = await fetch(`${baseUrl}/api/bots/scout/conversations/coder`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; exchanges: Array<{ sourceBotId: string }> };
    expect(body.ok).toBe(true);
    expect(body.exchanges).toHaveLength(2);
    expect(body.exchanges[0].sourceBotId).toBe('scout');
  });

  it('404s unknown bots, 400s self-sheets', async () => {
    expect((await fetch(`${baseUrl}/api/bots/nope/conversations/coder`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/bots/scout/conversations/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/bots/scout/conversations/scout`)).status).toBe(400);
  });

  it('GET /:botId/conversations lists peers', async () => {
    seedExchange('scout', 'coder');
    const res = await fetch(`${baseUrl}/api/bots/scout/conversations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peers: Array<{ peerId: string }> };
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].peerId).toBe('coder');
  });

  it('respects the limit param', async () => {
    for (let i = 0; i < 5; i++) seedExchange('scout', 'coder');
    const res = await fetch(`${baseUrl}/api/bots/scout/conversations/coder?limit=2`);
    const body = (await res.json()) as { exchanges: unknown[] };
    expect(body.exchanges).toHaveLength(2);
  });
});
