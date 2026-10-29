// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertModelAllowed,
  getDefaultModel,
  getProviderPreset,
  isFreeModel,
  listProviderPresets,
  resolveApiKey,
  resolveBaseUrl,
} from '../src/providers/catalog.js';
import { createProvider } from '../src/providers/factory.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';

const ENV_KEYS = [
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OMNIRUSH_API_KEY',
  'XAI_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY',
  'MINIMAX_API_KEY',
  'MOONSHOT_API_KEY',
  'PROVIDERS_FILE',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PROVIDERS_FILE = join(tmpdir(), 'agent-runtime-test-no-such-providers.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('catalog', () => {
  it('exposes the expected provider presets', () => {
    const ids = listProviderPresets().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['groq', 'openrouter', 'openai', 'anthropic', 'omnirush']));
    expect(getProviderPreset('openrouter')?.liveModels).toBe(true);
    expect(getProviderPreset('groq')?.envKey).toBe('GROQ_API_KEY');
    expect(getDefaultModel('groq')).toBe('gpt-oss-120b');
    expect(getProviderPreset('nope')).toBeUndefined();
  });

  it('resolveApiKey reads the env var first', () => {
    process.env.OPENROUTER_API_KEY = 'or-env-key';
    expect(resolveApiKey('openrouter')).toBe('or-env-key');
  });

  it('resolveApiKey falls back to providers.local.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-providers-'));
    const file = join(dir, 'providers.local.json');
    writeFileSync(file, JSON.stringify({ ANTHROPIC_API_KEY: 'anthropic-file-key' }), { mode: 0o600 });
    process.env.PROVIDERS_FILE = file;
    expect(resolveApiKey('anthropic')).toBe('anthropic-file-key');
  });

  it('resolveApiKey returns undefined when nothing is configured', () => {
    expect(resolveApiKey('groq')).toBeUndefined();
  });

  it('createProvider names the env var when the key is missing', () => {
    expect(() => createProvider('groq')).toThrow(/GROQ_API_KEY/);
  });

  it('createProvider rejects unknown providers', () => {
    expect(() => createProvider('nope')).toThrow(/Unknown provider/);
  });
});

describe('omnirush bring-your-own preset', () => {
  it('exists, is marked byo, and ships with an empty baseUrl', () => {
    const preset = getProviderPreset('omnirush');
    expect(preset).toBeDefined();
    expect(preset?.byo).toBe(true);
    expect(preset?.baseUrl).toBe('');
    expect(preset?.envKey).toBe('OMNIRUSH_API_KEY');
    expect(preset?.api).toBe('openai-compatible');
    expect(preset?.models).toEqual([]);
    expect(preset?.notes).toMatch(/own/i);
  });

  it('createProvider throws a helpful configuration error when no baseUrl is set', () => {
    expect(() => createProvider('omnirush')).toThrow(/bring-your-own/i);
    expect(() => createProvider('omnirush')).toThrow(/Providers settings page/);
    expect(() => createProvider('omnirush')).toThrow(/OMNIRUSH_API_KEY/);
  });

  it('resolveApiKey checks OMNIRUSH_API_KEY env then providers.local.json', () => {
    process.env.OMNIRUSH_API_KEY = 'own-env-key';
    expect(resolveApiKey('omnirush')).toBe('own-env-key');
    delete process.env.OMNIRUSH_API_KEY;
    const dir = mkdtempSync(join(tmpdir(), 'agent-providers-'));
    const file = join(dir, 'providers.local.json');
    writeFileSync(file, JSON.stringify({ OMNIRUSH_API_KEY: 'own-file-key' }), { mode: 0o600 });
    process.env.PROVIDERS_FILE = file;
    expect(resolveApiKey('omnirush')).toBe('own-file-key');
  });

  it('becomes usable once the user configures their own endpoint + key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-providers-'));
    const file = join(dir, 'providers.local.json');
    writeFileSync(
      file,
      JSON.stringify({
        OMNIRUSH_API_KEY: 'own-key',
        OMNIRUSH_API_KEY_BASE_URL: 'https://my-own-omnirush.example/v1',
      }),
      { mode: 0o600 },
    );
    process.env.PROVIDERS_FILE = file;
    expect(resolveBaseUrl('omnirush')).toBe('https://my-own-omnirush.example/v1');
    const provider = createProvider('omnirush');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.providerId).toBe('omnirush');
  });
});

describe('direct openai-compatible provider presets', () => {
  const NEW_PRESETS = [
    {
      id: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      envKey: 'XAI_API_KEY',
      defaultModel: 'grok-4',
      defaultContextLength: 256000,
      models: ['grok-4', 'grok-3', 'grok-3-mini'],
    },
    {
      id: 'together',
      baseUrl: 'https://api.together.xyz/v1',
      envKey: 'TOGETHER_API_KEY',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      defaultContextLength: 131072,
      models: [
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        'meta-llama/Llama-3.1-8B-Instruct-Turbo',
        'deepseek-ai/DeepSeek-V3',
      ],
    },
    {
      id: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      envKey: 'FIREWORKS_API_KEY',
      defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      defaultContextLength: 131072,
      models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/deepseek-v3'],
    },
    {
      id: 'cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      envKey: 'CEREBRAS_API_KEY',
      defaultModel: 'llama-3.3-70b',
      defaultContextLength: 131072,
      models: ['llama-3.3-70b', 'llama3.1-8b', 'qwen-3-32b'],
    },
    {
      id: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      envKey: 'MINIMAX_API_KEY',
      defaultModel: 'MiniMax-Text-01',
      defaultContextLength: 245760,
      models: ['MiniMax-Text-01', 'MiniMax-M1'],
    },
    {
      id: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      envKey: 'MOONSHOT_API_KEY',
      defaultModel: 'kimi-k2-0711-preview',
      defaultContextLength: 131072,
      models: ['kimi-k2-0711-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'],
    },
  ];

  it('lists all six new presets', () => {
    const ids = listProviderPresets().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(NEW_PRESETS.map((p) => p.id)));
  });

  for (const expected of NEW_PRESETS) {
    it(`${expected.id}: exists as an openai-compatible preset with the right baseUrl + envKey`, () => {
      const preset = getProviderPreset(expected.id);
      expect(preset).toBeDefined();
      expect(preset?.api).toBe('openai-compatible');
      expect(preset?.baseUrl).toBe(expected.baseUrl);
      expect(preset?.envKey).toBe(expected.envKey);
      expect(preset?.models.map((m) => m.id)).toEqual(expected.models);
    });

    it(`${expected.id}: has a default model and getDefaultModel returns it`, () => {
      const preset = getProviderPreset(expected.id);
      const defaults = preset?.models.filter((m) => m.default) ?? [];
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(expected.defaultModel);
      expect(defaults[0]?.contextLength).toBe(expected.defaultContextLength);
      expect(getDefaultModel(expected.id)).toBe(expected.defaultModel);
    });

    it(`${expected.id}: createProvider constructs an OpenAICompatibleProvider when ${expected.envKey} is set`, () => {
      process.env[expected.envKey] = 'test-key';
      const provider = createProvider(expected.id);
      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(provider.providerId).toBe(expected.id);
    });

    it(`${expected.id}: createProvider names ${expected.envKey} when the key is missing`, () => {
      expect(() => createProvider(expected.id)).toThrow(new RegExp(expected.envKey));
    });
  }
});

describe('isFreeModel', () => {
  it('is true for catalog models pinned free:true', () => {
    // opencode-zen roster pinned 2026-10-09 (free:true in catalog.json).
    expect(isFreeModel('opencode-zen', 'big-pickle')).toBe(true);
    expect(isFreeModel('opencode-zen', 'jev-1.13-free')).toBe(true);
  });

  it('is false for catalog models without the free flag', () => {
    expect(isFreeModel('groq', 'gpt-oss-120b')).toBe(false);
    expect(isFreeModel('openai', 'gpt-4o')).toBe(false);
  });

  it('is true for OpenRouter :free and Zen -free suffixes', () => {
    expect(isFreeModel('openrouter', 'deepseek/deepseek-chat:free')).toBe(true);
    expect(isFreeModel('opencode-zen', 'some-new-model-free')).toBe(true);
  });

  it('is false for unknown providers/models', () => {
    expect(isFreeModel('nope', 'nope')).toBe(false);
  });
});

describe('assertModelAllowed (FREE_MODELS_ONLY)', () => {
  const KEY = 'FREE_MODELS_ONLY';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is a no-op when the guard is off', () => {
    expect(() => assertModelAllowed('openai', 'gpt-4o')).not.toThrow();
  });

  it('throws for paid models when enabled with "1"', () => {
    process.env[KEY] = '1';
    expect(() => assertModelAllowed('openai', 'gpt-4o')).toThrow(/FREE_MODELS_ONLY/);
    expect(() => assertModelAllowed('openai', 'gpt-4o')).toThrow(/openai\/gpt-4o/);
  });

  it('accepts "true" (any case) as enabled', () => {
    process.env[KEY] = 'TRUE';
    expect(() => assertModelAllowed('groq', 'gpt-oss-120b')).toThrow(/FREE_MODELS_ONLY/);
  });

  it('passes free models when the guard is on', () => {
    process.env[KEY] = '1';
    expect(() => assertModelAllowed('opencode-zen', 'big-pickle')).not.toThrow();
    expect(() => assertModelAllowed('openrouter', 'x:free')).not.toThrow();
  });

  it('ignores unrelated values', () => {
    process.env[KEY] = '0';
    expect(() => assertModelAllowed('openai', 'gpt-4o')).not.toThrow();
  });
});
