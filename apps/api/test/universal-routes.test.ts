// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, BotConfig, ChatMessage, TokenUsage } from '@mvp/agent-runtime';
import { FusionRunStore } from '../src/fusion.js';
import { createUniversalRouter, type UniversalLlmCaller } from '../src/universal-routes.js';
import {
  UniversalChatStore,
  decideUniversalRoute,
  detectSplit,
  parseBotMention,
  resolveAnchorBot,
} from '../src/universal.js';

const U: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const TOKEN = 'test-owner-token';

const CHIEF: BotConfig = {
  id: 'chief',
  name: 'Chief',
  description: 'Chief of Staff coordinating the team',
  systemPrompt: 'coordinate',
  provider: 'ovh-anonymous',
  model: 'gpt-oss-120b',
  tools: [],
  skills: [],
} as BotConfig;

const CODER: BotConfig = {
  id: 'coder',
  name: 'Coder',
  description: 'Writes and debugs code, programming in typescript',
  systemPrompt: 'code',
  provider: 'ovh-anonymous',
  model: 'gpt-oss-120b',
  tools: [],
  skills: [],
  routeKeywords: ['code', 'debug'],
} as BotConfig;

const WRITER: BotConfig = {
  id: 'writer',
  name: 'Copywriter',
  description: 'Writes essays, blogs, articles and marketing copy',
  systemPrompt: 'write',
  provider: 'ovh-anonymous',
  model: 'gpt-oss-120b',
  tools: [],
  skills: [],
  routeKeywords: ['essay', 'blog'],
} as BotConfig;

const BOTS = [CHIEF, CODER, WRITER];

interface TurnCall {
  bot: BotConfig;
  message: string;
  sessionId?: string;
}

function makeRuntime() {
  const calls: TurnCall[] = [];
  const appended: Array<{ sessionId: string; role: string; content: string }> = [];
  let created = 0;
  const runtime = {
    runTurn: vi.fn(
      async (opts: {
        bot: BotConfig;
        message: string;
        sessionId?: string;
        onEvent: (e: { type: string; content?: string; usage?: TokenUsage }) => void | Promise<void>;
      }) => {
        calls.push({ bot: opts.bot, message: opts.message, sessionId: opts.sessionId });
        await opts.onEvent({ type: 'token', content: `reply from ${opts.bot.id}` });
        await opts.onEvent({ type: 'done', usage: U });
        return U;
      },
    ),
    sessionStore: {
      createSession: vi.fn((_botId: string) => `sess_test_${++created}`),
      appendMessage: vi.fn((sessionId: string, msg: { role: string; content: string }) => {
        appended.push({ sessionId, role: msg.role, content: msg.content });
      }),
    },
  };
  return { runtime: runtime as unknown as AgentRuntime, calls, appended };
}

/** Planner returns a fixed 2-subtask plan; every other call is the fusion step. */
const splitCallLlm: UniversalLlmCaller = async (
  _providerId: string,
  _model: string,
  messages: ChatMessage[],
) => {
  const text = messages.map((m) => m.content).join('\n');
  if (text.includes('task planner')) {
    return {
      content:
        '{"subtasks": [' +
        '{"id": "s1", "title": "Research part", "description": "research it", "dependencies": []},' +
        '{"id": "s2", "title": "Write part", "description": "write it up", "dependencies": ["s1"]}' +
        '], "rationale": "two halves"}',
      usage: U,
    };
  }
  return { content: 'FUSED ANSWER', usage: U };
};

function makeApp(dataDir: string, opts?: { callLlm?: UniversalLlmCaller }) {
  const { runtime, calls, appended } = makeRuntime();
  const fusionStore = new FusionRunStore(dataDir);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/universal',
    createUniversalRouter({
      dataDir,
      getBots: () => BOTS,
      getChiefBotId: () => 'chief',
      agentRuntime: runtime,
      audit: () => undefined,
      loopbackToken: TOKEN,
      fusionStore,
      callLlm: opts?.callLlm ?? splitCallLlm,
    }),
  );
  return { app, calls, appended, fusionStore };
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

const authHeaders = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
};

async function postChat(
  base: string,
  message: string,
  fileIds?: string[],
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/universal/chat`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(fileIds ? { message, fileIds } : { message }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice('data: '.length)) as Record<string, unknown>);
}

describe('universal router (pure)', () => {
  it('anchor resolution prefers the configured chief, then flag, then first bot', () => {
    expect(resolveAnchorBot(BOTS, 'chief')?.id).toBe('chief');
    expect(resolveAnchorBot(BOTS, 'missing')?.id).toBe('chief'); // first bot fallback
    expect(resolveAnchorBot(BOTS, null)?.id).toBe('chief');
    const flagged = [{ ...CODER, chiefOfStaff: true }, CHIEF];
    expect(resolveAnchorBot(flagged as BotConfig[], null)?.id).toBe('coder');
    expect(resolveAnchorBot([], null)).toBeUndefined();
  });

  it('mention parsing matches names and ids, longest first', () => {
    expect(parseBotMention('hey @Coder look', BOTS)?.id).toBe('coder');
    expect(parseBotMention('ask @copywriter please', BOTS)?.id).toBe('writer');
    expect(parseBotMention('no mention here', BOTS)).toBeUndefined();
  });

  it('routes @mention of a specialist as forced specialist, anchor mention as direct', () => {
    const forced = decideUniversalRoute('@Coder fix the thing', BOTS, CHIEF);
    expect(forced.path).toBe('specialist');
    expect(forced.via).toBe('mention');
    expect(forced.confidence).toBe(1);
    const anchorMention = decideUniversalRoute('@Chief what is up', BOTS, CHIEF);
    expect(anchorMention.path).toBe('direct');
    expect(anchorMention.via).toBe('mention');
  });

  it('routes a strong domain match to the specialist', () => {
    const d = decideUniversalRoute('help me debug this typescript code, it has a bug', BOTS, CHIEF);
    expect(d.path).toBe('specialist');
    expect(d.botId).toBe('coder');
    expect(d.via).toBe('keyword-score');
  });

  it('routes weak or absent matches direct (when unsure, direct)', () => {
    expect(decideUniversalRoute('hello there', BOTS, CHIEF).path).toBe('direct');
    expect(decideUniversalRoute('what is the capital of France?', BOTS, CHIEF).path).toBe('direct');
    // One stray topic word is not a strong match.
    expect(decideUniversalRoute('I read a blog yesterday', BOTS, CHIEF).path).toBe('direct');
  });

  it('detects clear multi-part structure only', () => {
    expect(detectSplit('Research the history of tea, and then write a summary of it, and then compare it with coffee culture').split).toBe(true);
    expect(detectSplit('Do these:\n- gather the sales figures\n- draft the report').split).toBe(true);
    expect(detectSplit('What is a monad? And how is it used in Haskell?').split).toBe(true);
    expect(detectSplit('please split this task into smaller pieces').split).toBe(true);
    expect(detectSplit('Write a poem about the moon and stars').split).toBe(false);
    expect(detectSplit('What is the capital of France?').split).toBe(false);
    expect(detectSplit('Summarize this article for me').split).toBe(false);
  });

  it('split beats keyword scoring but mention beats split', () => {
    const compound = 'Research the history of tea, and then write a summary of it, and then compare it with coffee culture';
    expect(decideUniversalRoute(compound, BOTS, CHIEF).path).toBe('split');
    const mentioned = decideUniversalRoute(`@Coder — ${compound}`, BOTS, CHIEF);
    expect(mentioned.path).toBe('specialist');
    expect(mentioned.botId).toBe('coder');
  });
});

describe('UniversalChatStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-store-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips sessions and attributions', () => {
    const store = new UniversalChatStore(dir);
    expect(store.getSessionId('user-1')).toBeUndefined();
    store.setSession('user-1', 'sess_1', 'chief');
    expect(store.getSessionId('user-1')).toBe('sess_1');
    const rec = store.recordAttribution({
      sessionId: 'sess_1',
      userId: 'user-1',
      path: 'specialist',
      botId: 'coder',
      botName: 'Coder',
      reason: 'you mentioned Coder',
      confidence: 1,
      via: 'mention',
    });
    expect(rec.id).toBeGreaterThan(0);
    const listed = store.listAttributions('sess_1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ path: 'specialist', botId: 'coder', via: 'mention' });
  });
});

describe('universal routes (HTTP)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-routes-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unauthenticated calls', async () => {
    const { app } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/api/universal/session`);
      expect(res.status).toBe(401);
      const res2 = await fetch(`${base}/api/universal/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(res2.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('auto-creates one universal session per user and reuses it', async () => {
    const { app } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      const r1 = await (await fetch(`${base}/api/universal/session`, { headers: authHeaders })).json();
      expect(r1.ok).toBe(true);
      expect(r1.sessionId).toBe('sess_test_1');
      expect(r1.anchorBotId).toBe('chief');
      expect(r1.chiefConfigured).toBe(true);
      const r2 = await (await fetch(`${base}/api/universal/session`, { headers: authHeaders })).json();
      expect(r2.sessionId).toBe('sess_test_1');
    } finally {
      server.close();
    }
  });

  it('DIRECT: simple message is answered by the anchor in the universal session, with no planner LLM calls', async () => {
    const llmCalls: string[] = [];
    const spyLlm: UniversalLlmCaller = async (_p, _m, messages) => {
      llmCalls.push(messages.map((x) => x.content).join('\n'));
      return { content: 'unused', usage: U };
    };
    const { app, calls } = makeApp(dir, { callLlm: spyLlm });
    const { server, base } = await listen(app);
    try {
      const frames = await postChat(base, 'hello there, how are you?');
      expect(frames[0]).toMatchObject({ type: 'routing', path: 'direct', botId: 'chief', via: 'default' });
      expect(frames.some((f) => f.type === 'token' && f.content === 'reply from chief')).toBe(true);
      expect(frames.some((f) => f.type === 'done')).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.bot.id).toBe('chief');
      expect(calls[0]!.sessionId).toBe('sess_test_1');
      // Routing must never pay for an LLM classification call on this path.
      expect(llmCalls).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('SPECIALIST: @mention forces the named bot, runs in its shadow session, mirrors into the thread', async () => {
    const { app, calls, appended } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      const frames = await postChat(base, '@Coder please review my function');
      expect(frames[0]).toMatchObject({ type: 'routing', path: 'specialist', botId: 'coder', via: 'mention' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.bot.id).toBe('coder');
      expect(calls[0]!.sessionId).toMatch(/^universal_via_coder_/);
      // Mirror: user message then the assistant reply, in the universal session.
      expect(appended).toHaveLength(2);
      expect(appended[0]).toMatchObject({ sessionId: 'sess_test_1', role: 'user' });
      expect(appended[1]).toMatchObject({ sessionId: 'sess_test_1', role: 'assistant', content: 'reply from coder' });
    } finally {
      server.close();
    }
  });

  it('SPECIALIST: strong keyword match routes without a mention', async () => {
    const { app, calls } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      const frames = await postChat(base, 'help me debug this typescript code, it has a bug');
      expect(frames[0]).toMatchObject({ type: 'routing', path: 'specialist', botId: 'coder', via: 'keyword-score' });
      expect(calls[0]!.bot.id).toBe('coder');
    } finally {
      server.close();
    }
  });

  it('SPLIT: compound task is planned, split visibly, and returns one synthesized answer', async () => {
    const { app, appended, fusionStore } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      const frames = await postChat(
        base,
        'Research the history of tea, and then write a summary of it, and then compare it with coffee culture',
      );
      expect(frames[0]).toMatchObject({ type: 'routing', path: 'split', botId: 'chief', via: 'split-rules' });
      const plan = frames.find((f) => f.type === 'split_plan');
      expect(plan).toBeDefined();
      expect((plan!.subtasks as unknown[]).length).toBe(2);
      const tokens = frames.filter((f) => f.type === 'token').map((f) => f.content);
      expect(tokens).toContain('FUSED ANSWER');
      expect(frames.some((f) => f.type === 'done')).toBe(true);
      // The fused answer is mirrored into the universal thread.
      expect(appended.some((a) => a.sessionId === 'sess_test_1' && a.role === 'assistant' && a.content === 'FUSED ANSWER')).toBe(true);
      // And the run lands in the shared Fusion history, completed.
      const runs = fusionStore.listRuns(5);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('completed');
    } finally {
      server.close();
    }
  });

  it('records attributions that the session endpoint returns', async () => {
    const { app } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      await postChat(base, 'hello there');
      await postChat(base, '@Coder review this');
      const info = await (await fetch(`${base}/api/universal/session`, { headers: authHeaders })).json();
      expect(info.attributions).toHaveLength(2);
      expect(info.attributions[0]).toMatchObject({ path: 'specialist', botId: 'coder' });
      expect(info.attributions[1]).toMatchObject({ path: 'direct', botId: 'chief' });
    } finally {
      server.close();
    }
  });

  it('ATTACHMENTS: fileIds content is prepended to the executed message; routing still uses the typed text', async () => {
    const { app, calls } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      const fid = '123e4567-e89b-12d3-a456-426614174000';
      const uploads = path.join(dir, 'uploads');
      fs.mkdirSync(uploads, { recursive: true });
      fs.writeFileSync(path.join(uploads, `${fid}-notes.txt`), 'quarterly numbers: 42');
      fs.writeFileSync(
        path.join(uploads, `${fid}-notes.txt.meta.json`),
        JSON.stringify({ name: 'notes.txt', mimeType: 'text/plain' }),
      );
      const frames = await postChat(base, 'hello there', [fid]);
      // Routing decided on the typed text only (no file keywords present).
      expect(frames[0]).toMatchObject({ type: 'routing', path: 'direct', botId: 'chief' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.message).toContain('[Attached file: notes.txt]');
      expect(calls[0]!.message).toContain('quarterly numbers: 42');
      expect(calls[0]!.message.endsWith('hello there')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('validates the message body', async () => {
    const { app } = makeApp(dir);
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/api/universal/chat`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ message: '   ' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
