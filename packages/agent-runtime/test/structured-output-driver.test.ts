// SPDX-License-Identifier: Apache-2.0
// Structured output on the wire: the OpenAI-compatible driver must send
// `response_format` (json_object / json_schema) and the per-call knobs
// (temperature / top_p / max_tokens). Zero paid API usage — fetch is
// stubbed with a canned SSE stream.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';

const SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"{\\"ok\\":true}"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureFetch(): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies };
}

function provider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    providerId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'test-key',
  });
}

describe('OpenAICompatibleProvider structured output', () => {
  it('sends response_format json_schema with name + strict default', async () => {
    const { bodies } = captureFetch();
    const result = await provider().chat([{ role: 'user', content: 'hi' }], [], {
      model: 'm',
      responseFormat: {
        type: 'json_schema',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    });
    expect(result.content).toBe('{"ok":true}');
    expect(bodies[0]!.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        strict: true,
      },
    });
  });

  it('sends response_format json_object', async () => {
    const { bodies } = captureFetch();
    await provider().chat([{ role: 'user', content: 'hi' }], [], {
      model: 'm',
      responseFormat: { type: 'json_object' },
    });
    expect(bodies[0]!.response_format).toEqual({ type: 'json_object' });
  });

  it('forwards temperature/topP/maxTokens when set', async () => {
    const { bodies } = captureFetch();
    await provider().chat([{ role: 'user', content: 'hi' }], [], {
      model: 'm',
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 123,
    });
    expect(bodies[0]!.temperature).toBe(0.2);
    expect(bodies[0]!.top_p).toBe(0.9);
    expect(bodies[0]!.max_tokens).toBe(123);
  });

  it('omits the knobs when unset (provider defaults rule)', async () => {
    const { bodies } = captureFetch();
    await provider().chat([{ role: 'user', content: 'hi' }], [], { model: 'm' });
    expect(bodies[0]).not.toHaveProperty('response_format');
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });
});
