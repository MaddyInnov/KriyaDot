// SPDX-License-Identifier: Apache-2.0
// OH-3: memory explorer API (filters / stats / cited ask) + cited recall
// on the chat turn (memoryUsed in the SSE done frame AND persisted as
// assistant-message metadata; absent when nothing was recalled).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TieredMemoryStore, type BotConfig } from '@mvp/agent-runtime';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { RunHealthStore } from '@mvp/run-health';
import { createMemoryUpkeepRouter } from '../src/memory-upkeep-routes.js';
import { citationsFromPack } from '../src/memory-citations.js';
import { MessageMetaStore } from '../src/message-meta.js';
import { createRouter, type RouteDeps } from '../src/routes.js';

let dir: string;
let store: TieredMemoryStore;

const BOT_ID = 'bot1';

function seedAtoms(): { colorId: string; cityId: string; foodId: string } {
  const colorId = store.storeAtom(
    BOT_ID,
    { fact: 'The user favorite color is teal', entities: [], confidence: 0.9 },
    'turn-1',
    undefined,
    { category: 'preference' },
  );
  const cityId = store.storeAtom(
    BOT_ID,
    { fact: 'The user lives in Portland and likes rainy weather', entities: [], confidence: 0.9 },
    'turn-2',
    undefined,
    { category: 'fact' },
  );
  const foodId = store.storeAtom(
    BOT_ID,
    { fact: 'Weekly summary: the user cooked pasta twice', entities: [], confidence: 0.8 },
    'turn-3',
    undefined,
    { category: 'summary' },
  );
  return { colorId, cityId, foodId };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oh3-memory-'));
  store = new TieredMemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Citations builder
// ---------------------------------------------------------------------------

describe('citationsFromPack', () => {
  it('builds citations from pack atoms with a 200-char fact preview', () => {
    seedAtoms();
    const atoms = store.getAtoms(BOT_ID, 10);
    const citations = citationsFromPack({
      id: 'p1', botId: BOT_ID, query: 'q', atoms, atomIds: atoms.map((a) => a.id),
      tokenBudget: 512, tokensUsed: 10, createdAt: Date.now(),
    });
    expect(citations).toHaveLength(3);
    expect(citations![0]).toMatchObject({ atomId: atoms[0]!.id, category: atoms[0]!.category, sourceTurn: atoms[0]!.sourceTurn });
    const long = citationsFromPack({
      id: 'p2', botId: BOT_ID, query: 'q',
      atoms: [{ ...atoms[0]!, fact: 'x'.repeat(300) }],
      atomIds: [atoms[0]!.id], tokenBudget: 512, tokensUsed: 10, createdAt: Date.now(),
    });
    expect(long![0]!.fact.length).toBe(200);
  });

  it('returns undefined for empty/absent packs (field stays absent)', () => {
    expect(citationsFromPack(undefined)).toBeUndefined();
    expect(
      citationsFromPack({ id: 'p', botId: BOT_ID, query: 'q', atoms: [], atomIds: [], tokenBudget: 1, tokensUsed: 0, createdAt: 0 }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Explorer endpoints
// ---------------------------------------------------------------------------

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function explorerApp(extra: Partial<Parameters<typeof createMemoryUpkeepRouter>[0]> = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/memory',
    createMemoryUpkeepRouter({
      dataDir: dir,
      tieredMemoryStore: store,
      getBots: () => [{ id: BOT_ID }],
      ...extra,
    }),
  );
  return app;
}

describe('memory explorer endpoints', () => {
  it('atoms list supports q (substring) and category filters', async () => {
    const { colorId } = seedAtoms();
    const { server, base } = await listen(explorerApp());
    try {
      const all = await (await fetch(`${base}/api/memory/atoms?botId=${BOT_ID}`)).json();
      expect(all.atoms).toHaveLength(3);
      const byQ = await (await fetch(`${base}/api/memory/atoms?botId=${BOT_ID}&q=TEAL`)).json();
      expect(byQ.atoms).toHaveLength(1);
      expect(byQ.atoms[0].id).toBe(colorId);
      const byCat = await (await fetch(`${base}/api/memory/atoms?botId=${BOT_ID}&category=summary`)).json();
      expect(byCat.atoms).toHaveLength(1);
      expect(byCat.atoms[0].category).toBe('summary');
      const both = await (await fetch(`${base}/api/memory/atoms?botId=${BOT_ID}&q=user&category=fact`)).json();
      expect(both.atoms).toHaveLength(1);
      expect(both.atoms[0].category).toBe('fact');
    } finally {
      server.close();
    }
  });

  it('stats returns total + byCategory', async () => {
    seedAtoms();
    const { server, base } = await listen(explorerApp());
    try {
      const body = await (await fetch(`${base}/api/memory/stats?botId=${BOT_ID}`)).json();
      expect(body).toMatchObject({ ok: true, botId: BOT_ID, total: 3 });
      expect(body.byCategory).toMatchObject({ preference: 1, fact: 1, summary: 1 });
    } finally {
      server.close();
    }
  });

  it('ask in extractive mode returns the top atoms as the answer with citations', async () => {
    const { colorId } = seedAtoms();
    const { server, base } = await listen(explorerApp());
    try {
      const res = await fetch(`${base}/api/memory/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: BOT_ID, question: 'what is my favorite color?' }),
      });
      const body = await res.json();
      expect(body.mode).toBe('extractive');
      expect(body.answer).toContain('teal');
      expect(body.citations[0]).toMatchObject({ atomId: colorId, category: 'preference' });
      expect(body.citations[0].fact).toContain('teal');
    } finally {
      server.close();
    }
  });

  it('ask uses the grounded LLM path only when a provider is configured (mocked)', async () => {
    seedAtoms();
    const bot = {
      id: BOT_ID, name: 'Bot One', description: 'd', systemPrompt: 'p',
      provider: 'ovh-anonymous', model: 'gpt-oss-120b', tools: [], skills: [],
    } as BotConfig;
    const askChatFn = vi.fn(async () => 'Your favorite color is teal.');
    const { server, base } = await listen(
      explorerApp({ getBotById: () => bot, askChatFn, isProviderConfigured: () => true }),
    );
    try {
      const res = await fetch(`${base}/api/memory/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: BOT_ID, question: 'what is my favorite color?' }),
      });
      const body = await res.json();
      expect(body.mode).toBe('llm');
      expect(body.answer).toBe('Your favorite color is teal.');
      expect(body.citations.length).toBeGreaterThan(0);
      expect(askChatFn).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });

  it('DELETE really removes the atom', async () => {
    const { cityId } = seedAtoms();
    const { server, base } = await listen(explorerApp());
    try {
      const del = await fetch(`${base}/api/memory/atoms/${cityId}?botId=${BOT_ID}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const after = await fetch(`${base}/api/memory/atoms/${cityId}?botId=${BOT_ID}`);
      expect(after.status).toBe(404);
      expect(store.getAtom(BOT_ID, cityId)).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Cited recall on /api/chat (+ OH-5 modelRoute on the same seam)
// ---------------------------------------------------------------------------

function chatApp(botModel: string) {
  const governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
  const captured: Array<{ model?: string; providerId?: string }> = [];
  const agentRuntime = {
    addContextProvider: () => {},
    setDefaultSpendCapGateFactory: () => {},
    sessionStore: {
      getWorktree: () => undefined,
      listThreadMessages: () => [
        { id: 1, role: 'user', content: 'hi', ts: '2026-11-02T00:00:00.000Z' },
        { id: 2, role: 'assistant', content: 'reply', ts: '2026-11-02T00:00:01.000Z' },
      ],
    },
    runTurn: async (input: {
      model?: string;
      providerId?: string;
      onEvent?: (e: unknown) => void | Promise<void>;
    }) => {
      captured.push({ model: input.model, providerId: input.providerId });
      await input.onEvent?.({ type: 'token', content: 'reply' });
      await input.onEvent?.({ type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    },
  };
  const stub = {} as never;
  const deps = {
    config: { dataDir: dir, workspaceDir: dir, port: 0 } as RouteDeps['config'],
    bots: [
      {
        id: BOT_ID, name: 'Bot One', description: 'd', systemPrompt: 'p',
        provider: 'ovh-anonymous', model: botModel, tools: [], skills: [],
      },
    ] as unknown as RouteDeps['bots'],
    agentRuntime: agentRuntime as unknown as RouteDeps['agentRuntime'],
    governance,
    governanceAdapter: stub,
    workflowRunner: { listRuns: () => [], startRun: async () => ({ id: 'run1' }) } as unknown as RouteDeps['workflowRunner'],
    threadScheduleStore: stub,
    checkpointStore: stub,
    dotStore: stub,
    preferenceStore: { getPreference: () => undefined } as unknown as RouteDeps['preferenceStore'],
    recordingStore: stub,
    chatQueueStore: {
      enqueue: () => ({ id: 'q1', position: 1 }),
      nextForSession: () => undefined,
      list: () => [],
    } as unknown as RouteDeps['chatQueueStore'],
    mcpServers: {},
    tieredMemoryStore: store,
    runHealth: new RunHealthStore(join(dir, 'run-health.db')),
    omniStore: stub,
    omniCollector: stub,
    computerManager: stub,
    vpsPool: stub,
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createRouter(deps));
  return { app, captured };
}

async function postChat(base: string, message: string): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: BOT_ID, message, sessionId: 'sess-oh3' }),
  });
  return res.text();
}

describe('chat turn cited recall + auto model meta', () => {
  it('memoryUsed rides the SSE done frame and persists as message metadata when atoms match', async () => {
    const { colorId } = seedAtoms();
    const { app } = chatApp('gpt-oss-120b');
    const { server, base } = await listen(app);
    try {
      const body = await postChat(base, 'what is my favorite color?');
      expect(body).toContain('"memoryUsed"');
      expect(body).toContain(colorId);
      const meta = new MessageMetaStore(dir).get('sess-oh3', '2');
      expect(Array.isArray(meta.memoryUsed)).toBe(true);
      expect((meta.memoryUsed as Array<{ atomId: string }>)[0]!.atomId).toBe(colorId);
      // Explicit (non-auto) model: no modelRoute anywhere.
      expect(body).not.toContain('"modelRoute"');
      expect(meta.modelRoute).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('memoryUsed is absent (not an empty array) when nothing is recalled', async () => {
    const { app } = chatApp('gpt-oss-120b');
    const { server, base } = await listen(app);
    try {
      const body = await postChat(base, 'zzqqx unrelated gibberish token');
      expect(body).not.toContain('memoryUsed');
    } finally {
      server.close();
    }
  });

  it("bot model 'auto' resolves per turn, records the decision, and surfaces modelRoute", async () => {
    const { app, captured } = chatApp('auto');
    const { server, base } = await listen(app);
    try {
      const body = await postChat(base, 'hello there');
      expect(captured).toHaveLength(1);
      expect(captured[0]!.model).toBeTruthy();
      expect(captured[0]!.model).not.toBe('auto');
      expect(body).toContain('"modelRoute"');
      const meta = new MessageMetaStore(dir).get('sess-oh3', '2');
      expect(meta.modelRoute).toMatchObject({ chosen: expect.stringContaining('/') });
      const logRaw = readFileSync(join(dir, 'invocation-decisions.jsonl'), 'utf8');
      expect(logRaw).toContain('"via":"auto"');
    } finally {
      server.close();
    }
  });
});
