// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, afterEach } from 'vitest';
import { LlamaCppProvider } from '../src/providers/llamacpp.js';
import { llamacppBaseUrl } from '../src/local-llm.js';
import { createProvider } from '../src/providers/factory.js';
import { getProviderPreset } from '../src/providers/catalog.js';

const realFetch = globalThis.fetch;
const realPort = process.env.KRIYADOT_LLAMACPP_PORT;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  if (realPort === undefined) delete process.env.KRIYADOT_LLAMACPP_PORT;
  else process.env.KRIYADOT_LLAMACPP_PORT = realPort;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('llamacpp catalog preset', () => {
  it('is registered as a local provider', () => {
    const preset = getProviderPreset('llamacpp');
    expect(preset).toBeDefined();
    expect(preset?.local).toBe(true);
    expect(preset?.api).toBe('llamacpp');
    expect(preset?.name).toContain('llama.cpp');
  });

  it('createProvider("llamacpp") returns the LlamaCppProvider', () => {
    const p = createProvider('llamacpp');
    expect(p).toBeInstanceOf(LlamaCppProvider);
  });
});

describe('LlamaCppProvider.listModels', () => {
  it('reads /v1/models from the managed server and marks models free', async () => {
    delete process.env.KRIYADOT_LLAMACPP_PORT;
    globalThis.fetch = (async (url: unknown) => {
      expect(String(url)).toBe('http://127.0.0.1:11435/v1/models');
      return jsonResponse({ data: [{ id: 'qwen2.5-1.5b' }] });
    }) as typeof fetch;
    const models = await new LlamaCppProvider().listModels();
    expect(models).toEqual([{ id: 'qwen2.5-1.5b', name: 'qwen2.5-1.5b', free: true }]);
  });

  it('returns [] when the server is not running', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    expect(await new LlamaCppProvider().listModels()).toEqual([]);
  });

  it('honors KRIYADOT_LLAMACPP_PORT', () => {
    process.env.KRIYADOT_LLAMACPP_PORT = '18080';
    expect(llamacppBaseUrl()).toBe('http://127.0.0.1:18080');
  });
});

describe('LlamaCppProvider.chat', () => {
  it('maps connection failures to the Local LLM settings guidance', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    await expect(
      new LlamaCppProvider().chat([], [], { model: 'x' }),
    ).rejects.toThrow(/Settings → Local LLM/);
  });
});
