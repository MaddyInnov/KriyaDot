// SPDX-License-Identifier: Apache-2.0
//
// Voice defaults tests: when a real TTS/STT provider is configured the
// resolved default (and a new bot's voice config) is that provider —
// the mock survives only when nothing is configured. Also covers the
// extended provider ids in persisted bot voice settings. Zero network:
// configuration is pure env inspection.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  applyBotVoice,
  botVoicePath,
  getDefaultVoiceSettingsForNewBot,
  isSttProviderConfigured,
  isTtsProviderConfigured,
  resolveDefaultSttProvider,
  resolveDefaultTtsProvider,
  resolveDefaultVoiceSettings,
  resolveVoiceSettingsForBot,
  sanitizeVoiceSettings,
  saveBotVoice,
} from '../src/bot-voice.js';

const bot = (over: Partial<BotConfig> = {}): BotConfig =>
  ({
    id: 'bot_1',
    name: 'Voice Bot',
    description: 'test bot',
    systemPrompt: 'You are a test bot.',
    provider: 'groq',
    model: 'test-model',
    skills: [],
    tools: [],
    mcpServers: [],
    ...over,
  }) as BotConfig;

const tmp = () => mkdtempSync(join(tmpdir(), 'bot-voice-test-'));

describe('resolveDefaultTtsProvider / resolveDefaultSttProvider', () => {
  it('mock when nothing is configured', () => {
    expect(resolveDefaultTtsProvider({})).toBe('mock');
    expect(resolveDefaultSttProvider({})).toBe('mock');
    expect(resolveDefaultVoiceSettings({})).toEqual({ sttProvider: 'mock', ttsProvider: 'mock' });
  });

  it('a configured real provider becomes the default', () => {
    expect(resolveDefaultTtsProvider({ ELEVENLABS_API_KEY: 'e' })).toBe('elevenlabs');
    expect(resolveDefaultTtsProvider({ FISH_API_KEY: 'f' })).toBe('fish');
    expect(resolveDefaultTtsProvider({ CHATTERBOX_BASE_URL: 'http://127.0.0.1:8000' })).toBe('chatterbox');
    expect(resolveDefaultTtsProvider({ GROQ_API_KEY: 'g' })).toBe('groq');
    expect(resolveDefaultSttProvider({ OPENAI_API_KEY: 'o' })).toBe('openai');
    expect(resolveDefaultSttProvider({ GROQ_API_KEY: 'g' })).toBe('groq');
  });

  it('priority: dedicated voice keys first; explicit env wins over auto', () => {
    expect(resolveDefaultTtsProvider({ GROQ_API_KEY: 'g', FISH_API_KEY: 'f', ELEVENLABS_API_KEY: 'e' })).toBe('elevenlabs');
    expect(resolveDefaultTtsProvider({ VOICE_TTS_PROVIDER: 'openai', ELEVENLABS_API_KEY: 'e' })).toBe('openai');
    expect(resolveDefaultTtsProvider({ VOICE_TTS_PROVIDER: 'mock', ELEVENLABS_API_KEY: 'e' })).toBe('mock');
    expect(resolveDefaultSttProvider({ VOICE_STT_PROVIDER: 'openai', GROQ_API_KEY: 'g' })).toBe('openai');
    // TTS-only configuration never leaks into STT defaults.
    expect(resolveDefaultSttProvider({ ELEVENLABS_API_KEY: 'e', FISH_API_KEY: 'f' })).toBe('mock');
  });

  it('configuration probes mirror env presence', () => {
    expect(isTtsProviderConfigured('fish', { FISH_API_KEY: 'f' })).toBe(true);
    expect(isTtsProviderConfigured('fish', {})).toBe(false);
    expect(isTtsProviderConfigured('system', {})).toBe(false);
    expect(isSttProviderConfigured('groq', { GROQ_API_KEY: 'g' })).toBe(true);
    expect(isSttProviderConfigured('groq', {})).toBe(false);
  });

  it('new-bot defaults carry the real provider', () => {
    expect(getDefaultVoiceSettingsForNewBot({ FISH_API_KEY: 'f' })).toEqual({
      sttProvider: 'mock',
      ttsProvider: 'fish',
    });
    expect(getDefaultVoiceSettingsForNewBot({ GROQ_API_KEY: 'g', ELEVENLABS_API_KEY: 'e' })).toEqual({
      sttProvider: 'groq',
      ttsProvider: 'elevenlabs',
    });
  });
});

describe('resolveVoiceSettingsForBot', () => {
  it('fills unset slots from the resolved defaults', () => {
    const env = { FISH_API_KEY: 'f', GROQ_API_KEY: 'g' };
    expect(resolveVoiceSettingsForBot(undefined, env)).toEqual({ sttProvider: 'groq', ttsProvider: 'fish' });
    expect(resolveVoiceSettingsForBot({ ttsVoice: 'model-9', autoVad: true }, env)).toEqual({
      sttProvider: 'groq',
      ttsProvider: 'fish',
      ttsVoice: 'model-9',
      autoVad: true,
    });
  });

  it('explicit per-bot providers always win over defaults', () => {
    const env = { FISH_API_KEY: 'f' };
    const out = resolveVoiceSettingsForBot({ ttsProvider: 'mock' }, env);
    expect(out.ttsProvider).toBe('mock');
  });
});

describe('sanitizeVoiceSettings with the extended providers', () => {
  it('accepts the new TTS providers and keeps the rest of validation', () => {
    for (const p of ['elevenlabs', 'fish', 'chatterbox', 'system'] as const) {
      expect(sanitizeVoiceSettings({ ttsProvider: p }).ttsProvider).toBe(p);
    }
    expect(sanitizeVoiceSettings({ ttsProvider: 'deepgram' })).toEqual({});
    expect(sanitizeVoiceSettings({ ttsProvider: 'fish', vadSensitivity: 99 })).toEqual({ ttsProvider: 'fish' });
  });

  it('rejects TTS-only providers as STT providers', () => {
    expect(sanitizeVoiceSettings({ sttProvider: 'elevenlabs' })).toEqual({});
    expect(sanitizeVoiceSettings({ sttProvider: 'fish', ttsProvider: 'fish' })).toEqual({ ttsProvider: 'fish' });
    expect(sanitizeVoiceSettings({ sttProvider: 'groq' })).toEqual({ sttProvider: 'groq' });
  });
});

describe('applyBotVoice default inheritance', () => {
  it('leaves bots untouched when nothing is configured and nothing persisted', () => {
    const bots = [bot()];
    applyBotVoice(bots, tmp(), {});
    expect(bots[0]!.voice).toBeUndefined();
  });

  it('new bots inherit the configured real providers', () => {
    const bots = [bot()];
    applyBotVoice(bots, tmp(), { FISH_API_KEY: 'f' });
    expect(bots[0]!.voice).toEqual({ sttProvider: 'mock', ttsProvider: 'fish' });

    const bots2 = [bot()];
    applyBotVoice(bots2, tmp(), { GROQ_API_KEY: 'g', ELEVENLABS_API_KEY: 'e' });
    expect(bots2[0]!.voice).toEqual({ sttProvider: 'groq', ttsProvider: 'elevenlabs' });
  });

  it('seed voice fields survive inheritance (only provider slots are filled)', () => {
    const bots = [bot({ voice: { ttsVoice: 'alloy', autoVad: true } })];
    applyBotVoice(bots, tmp(), { FISH_API_KEY: 'f' });
    expect(bots[0]!.voice).toEqual({ sttProvider: 'mock', ttsProvider: 'fish', ttsVoice: 'alloy', autoVad: true });
  });

  it('persisted settings win over defaults; unset slots take the real default', () => {
    const dir = tmp();
    const bots = [bot()];
    saveBotVoice(dir, bots, 'bot_1', { ttsProvider: 'openai', ttsVoice: 'nova' });
    const fresh = [bot()];
    applyBotVoice(fresh, dir, { FISH_API_KEY: 'f', GROQ_API_KEY: 'g' });
    expect(fresh[0]!.voice).toEqual({ sttProvider: 'groq', ttsProvider: 'openai', ttsVoice: 'nova' });
  });

  it('persisted settings apply exactly when nothing is configured (legacy behaviour)', () => {
    const dir = tmp();
    const bots = [bot()];
    saveBotVoice(dir, bots, 'bot_1', { ttsProvider: 'fish', ttsVoice: 'model-1' });
    const onDisk = JSON.parse(readFileSync(botVoicePath(dir), 'utf8')) as Record<string, unknown>;
    expect(onDisk['bot_1']).toEqual({ ttsProvider: 'fish', ttsVoice: 'model-1' });
    const fresh = [bot()];
    applyBotVoice(fresh, dir, {});
    expect(fresh[0]!.voice).toEqual({ ttsProvider: 'fish', ttsVoice: 'model-1' });
  });
});
