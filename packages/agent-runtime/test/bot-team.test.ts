// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import {
  BOT_TEAM_TOOL_NAMES,
  MAX_BOT_HANDOFFS,
  checkHandoff,
  createBotTeamTools,
  registerBotTeamTools,
} from '../src/tools/bot-team.js';
import type { BotExchange, CreateBotTeamToolsOptions, ToolContext, ToolDefinition } from '../src/tools/bot-team.js';
import type { BotConfig } from '../src/types.js';

const botA = { id: 'scout', name: 'Scout', tools: [] } as unknown as BotConfig;
const botB = { id: 'coder', name: 'Coder', tools: [] } as unknown as BotConfig;
const botC = { id: 'helper', name: 'Helper', tools: [] } as unknown as BotConfig;

interface Harness {
  tools: Map<string, ToolDefinition>;
  exchanges: BotExchange[];
  chains: Map<string, string[]>;
  runBotTurn: ReturnType<typeof vi.fn>;
  opts: CreateBotTeamToolsOptions;
}

function makeHarness(): Harness {
  const exchanges: BotExchange[] = [];
  const chains = new Map<string, string[]>();
  let seq = 0;
  const runBotTurn = vi.fn(
    async (bot: BotConfig, _message: string, _o: { chain: string[] }) => ({
      text: `reply from ${bot.id}`,
    }),
  );
  const opts: CreateBotTeamToolsOptions = {
    getBotConfig: (id) => ({ scout: botA, coder: botB, helper: botC } as Record<string, BotConfig>)[id],
    listBots: () => [
      { id: 'scout', name: 'Scout', description: 'research' },
      { id: 'coder', name: 'Coder', description: 'code' },
      { id: 'helper', name: 'Helper', description: 'general' },
    ],
    runBotTurn,
    getChain: (sessionId) => chains.get(sessionId) ?? [],
    recordExchange: (e) => {
      const recorded = { ...e, id: `bex_test_${seq++}`, createdAt: new Date().toISOString() };
      exchanges.push(recorded);
      return recorded;
    },
    updateExchange: (id, updates) => {
      const ex = exchanges.find((x) => x.id === id);
      if (ex) Object.assign(ex, updates);
    },
    askTimeoutMs: 2000,
  };
  const tools = new Map<string, ToolDefinition>();
  registerBotTeamTools(tools, opts);
  return { tools, exchanges, chains, runBotTurn, opts };
}

const ctxA: ToolContext = { sessionId: 'sess-a', botId: 'scout' };

function call(h: Harness, name: string, args: Record<string, unknown>, ctx: ToolContext = ctxA) {
  const tool = h.tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler(args, ctx);
}

describe('registration', () => {
  it('registers list_bots, ask_bot and message_bot', () => {
    const h = makeHarness();
    expect(h.tools.get(BOT_TEAM_TOOL_NAMES.listBots)).toBeDefined();
    expect(h.tools.get(BOT_TEAM_TOOL_NAMES.askBot)).toBeDefined();
    expect(h.tools.get(BOT_TEAM_TOOL_NAMES.messageBot)).toBeDefined();
  });

  it('does not overwrite existing registry entries', () => {
    const h = makeHarness();
    const sentinel = { name: 'ask_bot' } as ToolDefinition;
    h.tools.set('ask_bot', sentinel);
    registerBotTeamTools(h.tools, h.opts);
    expect(h.tools.get('ask_bot')).toBe(sentinel);
  });
});

describe('list_bots', () => {
  it('excludes the caller', async () => {
    const h = makeHarness();
    const res = (await call(h, 'list_bots', {})) as { bots: Array<{ id: string }> };
    expect(res.bots.map((b) => b.id).sort()).toEqual(['coder', 'helper']);
  });
});

describe('checkHandoff', () => {
  it('rejects self-talk', () => {
    expect(() => checkHandoff(['scout'], 'scout', 'scout')).toThrow(/yourself/i);
  });

  it('rejects cycles (A→B→A)', () => {
    expect(() => checkHandoff(['scout', 'coder'], 'coder', 'scout')).toThrow(/cycle/i);
  });

  it('rejects chains at the hop limit', () => {
    const chain = Array.from({ length: MAX_BOT_HANDOFFS }, (_, i) => `bot${i}`);
    expect(() => checkHandoff(chain, chain[chain.length - 1], 'newbot')).toThrow(/limit/i);
  });

  it('allows a fresh handoff and extends the chain', () => {
    expect(checkHandoff(['scout'], 'scout', 'coder')).toEqual(['scout', 'coder']);
  });
});

describe('ask_bot', () => {
  it('round-trips: runs the target turn and returns its reply', async () => {
    const h = makeHarness();
    const res = (await call(h, 'ask_bot', { bot_id: 'coder', message: 'review this' })) as {
      reply: string;
      exchangeId: string;
    };
    expect(res.reply).toBe('reply from coder');
    expect(h.runBotTurn).toHaveBeenCalledOnce();
    const [, , turnOpts] = h.runBotTurn.mock.calls[0] as [BotConfig, string, { chain: string[] }];
    expect(turnOpts.chain).toEqual(['scout', 'coder']);
    const ex = h.exchanges.find((x) => x.id === res.exchangeId);
    expect(ex?.status).toBe('completed');
    expect(ex?.reply).toBe('reply from coder');
    expect(ex?.type).toBe('ask');
  });

  it('rejects unknown bots', async () => {
    const h = makeHarness();
    await expect(call(h, 'ask_bot', { bot_id: 'nope', message: 'hi' })).rejects.toThrow(/unknown bot/);
  });

  it('rejects self-ask', async () => {
    const h = makeHarness();
    await expect(call(h, 'ask_bot', { bot_id: 'scout', message: 'hi' })).rejects.toThrow(/yourself/i);
  });

  it('rejects cycles via the session chain', async () => {
    const h = makeHarness();
    // Simulate: coder's turn was triggered by scout (chain ['scout','coder']),
    // and coder now tries to ask scout back.
    h.chains.set('sess-b', ['scout', 'coder']);
    await expect(
      call(h, 'ask_bot', { bot_id: 'scout', message: 'ping' }, { sessionId: 'sess-b', botId: 'coder' }),
    ).rejects.toThrow(/cycle/i);
  });

  it('propagates the chain for nested asks', async () => {
    const h = makeHarness();
    h.chains.set('sess-b', ['scout', 'coder']);
    h.runBotTurn.mockImplementationOnce(async () => ({ text: 'ok' }));
    await call(
      h,
      'ask_bot',
      { bot_id: 'helper', message: 'help' },
      { sessionId: 'sess-b', botId: 'coder' },
    );
    const [, , turnOpts] = h.runBotTurn.mock.calls[0] as [BotConfig, string, { chain: string[] }];
    expect(turnOpts.chain).toEqual(['scout', 'coder', 'helper']);
  });

  it('fails (not fabricates) when the recipient errors', async () => {
    const h = makeHarness();
    h.runBotTurn.mockRejectedValueOnce(new Error('boom'));
    await expect(call(h, 'ask_bot', { bot_id: 'coder', message: 'hi' })).rejects.toThrow(/boom/);
    expect(h.exchanges[0].status).toBe('failed');
    expect(h.exchanges[0].detail).toMatch(/boom/);
  });

  it('times out instead of hanging forever', async () => {
    const h = makeHarness();
    h.runBotTurn.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    await expect(call(h, 'ask_bot', { bot_id: 'coder', message: 'hi' })).rejects.toThrow(/timed out/);
    expect(h.exchanges[0].status).toBe('failed');
  }, 10000);
});

describe('message_bot', () => {
  it('returns immediately and completes in the background', async () => {
    const h = makeHarness();
    let resolveTurn!: (v: { text: string }) => void;
    h.runBotTurn.mockImplementationOnce(
      () => new Promise<{ text: string }>((res) => (resolveTurn = res)),
    );
    const res = (await call(h, 'message_bot', { bot_id: 'coder', message: 'fyi' })) as {
      queued: boolean;
      exchangeId: string;
    };
    expect(res.queued).toBe(true);
    // Returned before the turn finished:
    expect(h.exchanges[0].status).toBe('pending');
    resolveTurn({ text: 'done, thanks' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.exchanges[0].status).toBe('completed');
    expect(h.exchanges[0].reply).toBe('done, thanks');
  });

  it('records failures without throwing to the caller', async () => {
    const h = makeHarness();
    h.runBotTurn.mockRejectedValueOnce(new Error('recipient exploded'));
    const res = (await call(h, 'message_bot', { bot_id: 'coder', message: 'fyi' })) as {
      queued: boolean;
    };
    expect(res.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.exchanges[0].status).toBe('failed');
    expect(h.exchanges[0].detail).toMatch(/exploded/);
  });

  it('rejects cycles and unknown bots like ask_bot', async () => {
    const h = makeHarness();
    await expect(call(h, 'message_bot', { bot_id: 'nope', message: 'hi' })).rejects.toThrow(/unknown bot/);
    h.chains.set('sess-b', ['scout', 'coder']);
    await expect(
      call(h, 'message_bot', { bot_id: 'scout', message: 'ping' }, { sessionId: 'sess-b', botId: 'coder' }),
    ).rejects.toThrow(/cycle/i);
  });
});
