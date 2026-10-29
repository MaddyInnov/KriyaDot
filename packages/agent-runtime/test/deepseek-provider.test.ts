// SPDX-License-Identifier: Apache-2.0
// DeepSeek as a first-class provider preset (W9 engines pack):
// - preset registration (base URL, env key, models) via the same catalog
//   path as Groq/OpenRouter
// - key resolution through the existing provider-key flow (env, then
//   providers.local.json) and the key NEVER appearing in logs
// - provider requests against a MOCK HTTP endpoint (zero paid usage)
// - routing can select DeepSeek models
// - a models.dev cache entry for deepseek does not clobber the preset

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDefaultModel,
  getProviderPreset,
  listProviderPresets,
  resolveApiKey,
  resolveBaseUrl,
} from '../src/providers/catalog.js';
import { createProvider } from '../src/providers/factory.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { readModelsDevCache, writeModelsDevCache } from '../src/providers/models-dev.js';
import { routeModel } from '../src/routing.js';
import { priceOfModel } from '../src/pricing.js';

const ENV_KEYS = ['DEEPSEEK_API_KEY', 'PROVIDERS_FILE', 'FREE_MODELS_ONLY'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PROVIDERS_FILE = join(tmpdir(), 'deepseek-test-no-such-providers.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deepseek preset', () => {
  it('is registered with the correct base URL, env key, and models', () => {
    const preset = getProviderPreset('deepseek');
    expect(preset).toBeDefined();
    expect(preset?.api).toBe('openai-compatible');
    expect(preset?.baseUrl).toBe('https://api.deepseek.com');
    expect(preset?.envKey).toBe('DEEPSEEK_API_KEY');
    expect(preset?.name).toBe('DeepSeek');
    const ids = preset?.models.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['deepseek-chat', 'deepseek-reasoner']));
    expect(getDefaultModel('deepseek')).toBe('deepseek-chat');
    expect(listProviderPresets().map((p) => p.id)).toContain('deepseek');
    expect(resolveBaseUrl('deepseek')).toBe('https://api.deepseek.com');
  });

  it('has pricing entries for both models', () => {
    expect(priceOfModel('deepseek', 'deepseek-chat')).toBeDefined();
    expect(priceOfModel('deepseek', 'deepseek-reasoner')).toBeDefined();
  });

  it('createProvider names DEEPSEEK_API_KEY when the key is missing', () => {
    expect(() => createProvider('deepseek')).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('resolves the key via env first, then providers.local.json', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-env-key';
    expect(resolveApiKey('deepseek')).toBe('ds-env-key');
    delete process.env.DEEPSEEK_API_KEY;
    const dir = mkdtempSync(join(tmpdir(), 'deepseek-providers-'));
    const file = join(dir, 'providers.local.json');
    writeFileSync(file, JSON.stringify({ DEEPSEEK_API_KEY: 'ds-file-key' }));
    process.env.PROVIDERS_FILE = file;
    expect(resolveApiKey('deepseek')).toBe('ds-file-key');
    const provider = createProvider('deepseek');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.providerId).toBe('deepseek');
  });
});

describe('deepseek requests (mock HTTP, zero paid usage)', () => {
  function sseResponse(): Response {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello"}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n' +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  it('posts chat completions to the DeepSeek base URL with the key as bearer auth', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-secret-key-123';
    const fetchMock = vi.fn(async () => sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    const provider = createProvider('deepseek');
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'deepseek-chat' });
    expect(result.content).toBe('Hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ds-secret-key-123');
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe('deepseek-chat');
  });

  it('supports deepseek-reasoner and never logs the API key', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-secret-key-456';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse()));
    const provider = createProvider('deepseek');
    await provider.chat([{ role: 'user', content: 'think' }], [], { model: 'deepseek-reasoner' });
    const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls]
      .map((c) => c.map(String).join(' '))
      .join('\n');
    expect(logged).not.toContain('ds-secret-key-456');
  });
});

describe('deepseek routing + models.dev merge safety', () => {
  it('routing can select deepseek models when the provider is pinned', () => {
    const decision = routeModel({ taskType: 'reasoning', providerHint: 'deepseek' });
    expect(decision.providerId).toBe('deepseek');
    expect(['deepseek-chat', 'deepseek-reasoner']).toContain(decision.modelId);
  });

  it('routing resolves an explicit deepseek override', () => {
    const decision = routeModel({ taskType: 'chat', botModel: 'deepseek/deepseek-reasoner' });
    expect(decision).toMatchObject({ providerId: 'deepseek', modelId: 'deepseek-reasoner' });
  });

  it('a models.dev cache with a conflicting deepseek entry does not clobber the preset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepseek-models-dev-'));
    writeModelsDevCache(dir, {
      fetchedAt: new Date().toISOString(),
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek (models.dev)',
          models: [{ id: 'deepseek-chat', name: 'RENAMED BY MODELS.DEV', contextLength: 1 }],
        },
      ],
    });
    const cached = readModelsDevCache(dir);
    expect(cached?.providers[0]?.models[0]?.name).toBe('RENAMED BY MODELS.DEV');
    // The shipped preset is authoritative and untouched by the cache.
    const preset = getProviderPreset('deepseek');
    expect(preset?.baseUrl).toBe('https://api.deepseek.com');
    expect(preset?.models.find((m) => m.id === 'deepseek-chat')?.name).toBe('DeepSeek Chat (V3)');
    expect(preset?.models.find((m) => m.id === 'deepseek-chat')?.contextLength).toBe(65536);
  });
});
