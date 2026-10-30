// SPDX-License-Identifier: Apache-2.0
// CA-20 consumer-style SDK test: EVERY import comes from the SDK
// entrypoint (src/sdk.ts) only — no internal modules. A consumer
// plugs a custom in-memory session store, registers a custom tool
// (also served through the in-process MCP path), and runs a
// mock-provider session end to end.

import { describe, expect, it } from 'vitest';
import {
  SDK_API_VERSION,
  SDK_VERSION,
  BuiltinSessionStorage,
  MockProvider,
  createInProcessMcpTools,
  createSdkAgent,
  defineSdkTool,
} from '../src/sdk.js';
import type {
  BotConfig,
  ChatMessage,
  SdkSessionStorage,
  SessionRecord,
  SessionSummary,
  StreamEvent,
} from '../src/sdk.js';

/** A consumer-owned in-memory session store (the adapter contract). */
class ConsumerMemoryStorage implements SdkSessionStorage {
  private seq = 0;
  private readonly sessions = new Map<string, { record: SessionRecord; messages: ChatMessage[] }>();

  createSession(botId: string, opts: { projectId?: string } = {}): string {
    const id = `consumer-sess-${++this.seq}`;
    this.sessions.set(id, {
      record: {
        id,
        botId,
        createdAt: new Date().toISOString(),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      },
      messages: [],
    });
    return id;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId)?.record;
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    s.messages.push(message);
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return [...(this.sessions.get(sessionId)?.messages ?? [])];
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      ...s.record,
      messageCount: s.messages.length,
      lastMessageTs: s.messages.length > 0 ? s.record.createdAt : null,
    }));
  }
}

const BOT: BotConfig = {
  id: 'sdk-bot',
  name: 'SDK Bot',
  description: 'Consumer test bot',
  systemPrompt: 'You are a test bot.',
  provider: 'mock',
  model: 'mock-model',
  skills: [],
  tools: ['adder'],
  mcpServers: [],
};

describe('SDK version surface', () => {
  it('exposes a versioned API contract', () => {
    expect(SDK_API_VERSION).toBe('1');
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('SDK agent with a CUSTOM session store', () => {
  it('runs a mock-provider session end to end, persisting through the custom store', async () => {
    const storage = new ConsumerMemoryStorage();
    let handlerCalls = 0;
    const adder = defineSdkTool({
      name: 'adder',
      description: 'Adds two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      handler: async (args) => {
        handlerCalls += 1;
        return (args.a as number) + (args.b as number);
      },
    });
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'adder', args: { a: 2, b: 3 } }] },
      { content: 'The answer is 5' },
    ]);
    const agent = createSdkAgent({ provider, storage, tools: [adder] });
    const events: StreamEvent[] = [];
    const result = await agent.runTurn({
      bot: BOT,
      message: 'add 2 and 3',
      onEvent: (e) => { events.push(e); },
    });

    expect(result.content).toBe('The answer is 5');
    expect(result.toolCalls).toHaveLength(1);
    expect(handlerCalls).toBe(1);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // Everything persisted through the CONSUMER's store, in order:
    // user → assistant(tool call) → tool result → assistant(final).
    const history = await storage.getMessages(result.sessionId);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(history[0]!.content).toBe('add 2 and 3');
    expect(history[2]!.content).toBe('5');
    expect(history[3]!.content).toBe('The answer is 5');
    const summaries = await agent.sessionStorage.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.messageCount).toBe(4);
    await agent.close();
  });

  it('denies mutating tools without an approval gate (fail closed), allows with one', async () => {
    const writer = defineSdkTool({
      name: 'writer',
      description: 'Writes something',
      parameters: { type: 'object', properties: {} },
      mutating: true,
      handler: async () => 'written',
    });
    const botWithWriter: BotConfig = { ...BOT, tools: ['writer'] };
    const script = () => new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'writer', args: {} }] },
      { content: 'done' },
    ]);

    const deniedAgent = createSdkAgent({ provider: script(), storage: new ConsumerMemoryStorage(), tools: [writer] });
    const denied = await deniedAgent.runTurn({ bot: botWithWriter, message: 'write it' });
    expect(denied.toolCalls).toHaveLength(0);
    await deniedAgent.close();

    const allowedAgent = createSdkAgent({
      provider: script(),
      storage: new ConsumerMemoryStorage(),
      tools: [writer],
      approveToolCall: async () => true,
    });
    const allowed = await allowedAgent.runTurn({ bot: botWithWriter, message: 'write it' });
    expect(allowed.toolCalls).toHaveLength(1);
    await allowedAgent.close();
  });
});

describe('SDK in-process MCP custom tools', () => {
  it('serves custom tools through the MCP loopback path and runs them in a session', async () => {
    const doubler = defineSdkTool({
      name: 'doubler',
      description: 'Doubles a number',
      parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      handler: async (args) => (args.n as number) * 2,
    });
    const { tools, facade } = await createInProcessMcpTools([doubler], { serverInfo: { name: 'sdk-test', version: '1.0.0' } });
    try {
      // Names survive the MCP round-trip exactly.
      expect(tools.map((t) => t.name)).toEqual(['doubler']);
      const storage = new ConsumerMemoryStorage();
      const provider = new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'doubler', args: { n: 21 } }] },
        { content: 'Doubled: 42' },
      ]);
      const agent = createSdkAgent({ provider, storage, tools });
      const result = await agent.runTurn({ bot: { ...BOT, tools: ['doubler'] }, message: 'double 21' });
      expect(result.content).toBe('Doubled: 42');
      const history = await storage.getMessages(result.sessionId);
      expect(history[2]!.content).toBe('42');
      await agent.close();
    } finally {
      await facade.close();
    }
  });
});

describe('SDK built-in storage (default implementation)', () => {
  it('BuiltinSessionStorage round-trips sessions and messages', async () => {
    const storage = new BuiltinSessionStorage(':memory:');
    const sid = storage.createSession('bot-x', { projectId: 'proj-1' });
    storage.appendMessage(sid, { role: 'user', content: 'hello' });
    expect((await storage.getMessages(sid)).map((m) => m.content)).toEqual(['hello']);
    expect(storage.getSession(sid)?.projectId).toBe('proj-1');
    expect(storage.listSessions({ projectId: 'proj-1' })).toHaveLength(1);
    expect(storage.listSessions({ projectId: 'other' })).toHaveLength(0);
    storage.close();
  });
});
