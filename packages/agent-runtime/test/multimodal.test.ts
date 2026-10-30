// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { SessionStore } from '../src/sessions.js';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ChatMessage, MessageMedia, ToolDefinition } from '../src/types.js';

const PNG: MessageMedia = { kind: 'image', mediaType: 'image/png', dataBase64: 'aVBvcg==' };
const MP4: MessageMedia = { kind: 'video', mediaType: 'video/mp4', dataBase64: 'AAAA' };

describe('#38 OpenAI-compatible native media parts', () => {
  it('serializes image/video attachments as data-URI content parts', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"seen"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'what is in this?', media: [PNG, MP4] },
    ];
    const result = await provider.chat(messages, [], { model: 'gpt-4o' });
    expect(result.content).toBe('seen');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = body.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const parts = userMsg?.content as Array<Record<string, Record<string, string> | string>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'what is in this?' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aVBvcg==' } });
    expect(parts[2]).toEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } });
    vi.unstubAllGlobals();
  });

  it('keeps plain text messages as plain strings', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    await provider.chat([{ role: 'user', content: 'plain' }], [], { model: 'gpt-4o' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0].content).toBe('plain');
    vi.unstubAllGlobals();
  });
});

describe('#38 Anthropic native media parts', () => {
  it('sends images as base64 blocks and degrades video to an explicit note', async () => {
    let requestBody: unknown;
    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      fetchFn: (async (_url: unknown, init: { body: string }) => {
        requestBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'described' }],
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
      sleepFn: async () => undefined,
    });
    const result = await provider.chat(
      [{ role: 'user', content: 'describe', media: [PNG, MP4] }],
      [],
      { model: 'claude-sonnet-x' },
    );
    expect(result.content).toBe('described');
    const body = requestBody as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const userMsg = body.messages.find((m) => m.role === 'user');
    const blocks = userMsg?.content ?? [];
    expect(blocks[0]).toEqual({ type: 'text', text: 'describe' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aVBvcg==' },
    });
    expect(blocks[2].type).toBe('text');
    expect(String((blocks[2] as { text: string }).text)).toContain('cannot view video');
  });
});

describe('#38 session persistence of media', () => {
  it('round-trips media through append/get and through duplicateSession', async () => {
    const store = new SessionStore(':memory:');
    const sessionId = store.createSession('bot-x');
    store.appendMessage(sessionId, { role: 'user', content: 'look', media: [PNG] });
    store.appendMessage(sessionId, { role: 'assistant', content: 'a cat' });
    const messages = await store.getMessages(sessionId);
    expect(messages[0].media).toEqual([PNG]);
    expect(messages[1].media).toBeUndefined();

    const dup = store.duplicateSession(sessionId);
    expect(dup).toBeTruthy();
    const dupMessages = await store.getMessages(dup as string);
    expect(dupMessages[0].media).toEqual([PNG]);
  });
});

class FakeGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> {
    return 'allow';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: 'allow' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

describe('#38 runtime turn media', () => {
  it('attaches RunTurnOptions.media to the provider-bound and stored user message', async () => {
    const provider = new MockProvider([
      { content: 'I see it.', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
    ]);
    class TestRuntime extends AgentRuntime {
      protected resolveProvider(): MockProvider {
        return provider;
      }
    }
    const runtime = new TestRuntime({
      dbPath: ':memory:',
      skillsDir: '/tmp/agent-runtime-test-skills-missing',
      governance: new FakeGateway(),
      toolRegistry: new Map<string, ToolDefinition>(),
      defaultProviderId: 'mock',
    });
    const bot: BotConfig = {
      id: 'bot-media',
      name: 'Media Bot',
      description: 'test',
      systemPrompt: 'You are a test bot.',
      provider: 'mock',
      model: 'mock-model',
      skills: [],
      tools: [],
      mcpServers: [],
    };
    await runtime.runTurn({
      bot,
      message: 'what do you see?',
      media: [PNG],
      onEvent: () => undefined,
    });
    expect(provider.calls.length).toBeGreaterThan(0);
    const userMsg = provider.calls[0].messages.find((m) => m.role === 'user');
    expect(userMsg?.media).toEqual([PNG]);
    // The stored message carries the media too (resume replays it).
    const sessions = runtime.sessionStore.listSessions({ botId: 'bot-media' });
    expect(sessions.length).toBeGreaterThan(0);
    const stored = await runtime.sessionStore.getMessages(sessions[0].id);
    const storedUser = stored.find((m) => m.role === 'user');
    expect(storedUser?.media).toEqual([PNG]);
  });
});
