// SPDX-License-Identifier: Apache-2.0
// Per-bot voice-call settings persistence (Codync parity: realtime voice
// calls).
//
// Same overlay pattern as bot-models.ts: bot configs ship in seed/bots.json
// (immutable at runtime); voice settings from the UI are overlaid in
// <dataDir>/bot-voice.json: { "<botId>": { "sttProvider": "…", … } }.
// Applied onto the in-memory bots at boot (HOST WIRING: call
// applyBotVoice(seed.bots, config.dataDir) in index.ts) and updated by
// PUT /api/bots/:id/voice.
//
// Default resolution (voice defaults rule): when any real TTS provider
// is configured — API key or self-hosted base URL present in env — new
// and unconfigured bots resolve to that real provider instead of the
// mock. The mock remains the default only when nothing is configured.
// STT follows the same rule with the STT-capable providers (groq /
// openai). Explicit per-bot settings and an explicit VOICE_*_PROVIDER
// always win over the auto-resolved default. Priority lists are kept
// in sync with packages/voice/src/voice.ts.

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, VoiceSettings } from '@mvp/agent-runtime';

const VOICE_FILE = 'bot-voice.json';

export function botVoicePath(dataDir: string): string {
  return path.join(dataDir, VOICE_FILE);
}

type VoiceFile = Record<string, VoiceSettings>;

function readFile(dataDir: string): VoiceFile {
  try {
    const raw = fs.readFileSync(botVoicePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as VoiceFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: VoiceFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botVoicePath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botVoicePath(dataDir));
}

/**
 * Provider ids accepted in persisted voice settings. The agent-runtime
 * VoiceSettings union still lists only mock/groq/openai; the extra TTS
 * ids are stored as plain strings in the same fields (the runtime
 * treats them as opaque ids) — the casts in sanitizeVoiceSettings mark
 * exactly where the type lags the implementation.
 */
export type BotSttProviderId = 'mock' | 'groq' | 'openai';
export type BotTtsProviderId =
  | 'mock'
  | 'groq'
  | 'openai'
  | 'elevenlabs'
  | 'fish'
  | 'chatterbox'
  | 'system';

const VALID_STT_PROVIDERS = new Set<string>(['mock', 'groq', 'openai']);
const VALID_TTS_PROVIDERS = new Set<string>([
  'mock',
  'groq',
  'openai',
  'elevenlabs',
  'fish',
  'chatterbox',
  'system',
]);

/** Auto-default priority when VOICE_TTS_PROVIDER is unset (sync: @mvp/voice). */
export const TTS_AUTO_PRIORITY: readonly BotTtsProviderId[] = [
  'elevenlabs',
  'fish',
  'chatterbox',
  'groq',
  'openai',
];
/** Auto-default priority when VOICE_STT_PROVIDER is unset (sync: @mvp/voice). */
export const STT_AUTO_PRIORITY: readonly BotSttProviderId[] = ['groq', 'openai'];

function envHas(env: NodeJS.ProcessEnv, name: string): boolean {
  return typeof env[name] === 'string' && env[name]!.trim().length > 0;
}

/** Whether a TTS provider is usable from env alone (key/URL present). */
export function isTtsProviderConfigured(
  id: BotTtsProviderId | string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (id) {
    case 'mock':
      return true;
    case 'elevenlabs':
      return envHas(env, 'ELEVENLABS_API_KEY');
    case 'fish':
      return envHas(env, 'FISH_API_KEY');
    case 'chatterbox':
      return envHas(env, 'CHATTERBOX_BASE_URL');
    case 'groq':
      return envHas(env, 'GROQ_API_KEY');
    case 'openai':
      return envHas(env, 'OPENAI_API_KEY');
    default:
      // 'system' needs a runtime binary probe, not env; unknown ids no.
      return false;
  }
}

/** Whether an STT provider is usable from env alone (key present). */
export function isSttProviderConfigured(
  id: BotSttProviderId | string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (id) {
    case 'mock':
      return true;
    case 'groq':
      return envHas(env, 'GROQ_API_KEY');
    case 'openai':
      return envHas(env, 'OPENAI_API_KEY');
    default:
      return false;
  }
}

/**
 * The default TTS provider for new/unconfigured bots: explicit
 * VOICE_TTS_PROVIDER when valid, else the first configured real
 * provider, else 'mock'.
 */
export function resolveDefaultTtsProvider(env: NodeJS.ProcessEnv = process.env): BotTtsProviderId {
  const explicit = env['VOICE_TTS_PROVIDER']?.trim().toLowerCase();
  if (explicit && VALID_TTS_PROVIDERS.has(explicit)) return explicit as BotTtsProviderId;
  for (const id of TTS_AUTO_PRIORITY) {
    if (isTtsProviderConfigured(id, env)) return id;
  }
  return 'mock';
}

/** The default STT provider, following the same rule as TTS. */
export function resolveDefaultSttProvider(env: NodeJS.ProcessEnv = process.env): BotSttProviderId {
  const explicit = env['VOICE_STT_PROVIDER']?.trim().toLowerCase();
  if (explicit && VALID_STT_PROVIDERS.has(explicit)) return explicit as BotSttProviderId;
  for (const id of STT_AUTO_PRIORITY) {
    if (isSttProviderConfigured(id, env)) return id;
  }
  return 'mock';
}

/** Fully resolved default voice settings for the given env. */
export function resolveDefaultVoiceSettings(env: NodeJS.ProcessEnv = process.env): VoiceSettings {
  return {
    sttProvider: resolveDefaultSttProvider(env) as VoiceSettings['sttProvider'],
    // Cast: BotTtsProviderId is wider than the VoiceSettings union (see above).
    ttsProvider: resolveDefaultTtsProvider(env) as VoiceSettings['ttsProvider'],
  };
}

/** Default voice config handed to a newly created bot. */
export function getDefaultVoiceSettingsForNewBot(env: NodeJS.ProcessEnv = process.env): VoiceSettings {
  return resolveDefaultVoiceSettings(env);
}

/**
 * Resolution path for one bot: the bot's own (possibly partial) voice
 * settings win field-by-field; every unset provider slot falls back to
 * the resolved default — a configured real provider, never the mock
 * when a real one exists.
 */
export function resolveVoiceSettingsForBot(
  voice: VoiceSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): VoiceSettings {
  const out: VoiceSettings = { ...resolveDefaultVoiceSettings(env) };
  if (!voice) return out;
  const raw = voice as unknown as Record<string, unknown>;
  if (typeof raw['sttProvider'] === 'string' && VALID_STT_PROVIDERS.has(raw['sttProvider'])) {
    out.sttProvider = raw['sttProvider'] as VoiceSettings['sttProvider'];
  }
  if (typeof raw['ttsProvider'] === 'string' && VALID_TTS_PROVIDERS.has(raw['ttsProvider'])) {
    out.ttsProvider = raw['ttsProvider'] as VoiceSettings['ttsProvider'];
  }
  if (typeof voice.ttsVoice === 'string' && voice.ttsVoice) out.ttsVoice = voice.ttsVoice;
  if (typeof voice.autoVad === 'boolean') out.autoVad = voice.autoVad;
  if (typeof voice.vadSensitivity === 'number') out.vadSensitivity = voice.vadSensitivity;
  return out;
}

/** Sanitize raw input into VoiceSettings; unknown fields are dropped. */
export function sanitizeVoiceSettings(input: unknown): VoiceSettings {
  const out: VoiceSettings = {};
  if (typeof input !== 'object' || input === null) return out;
  const o = input as Record<string, unknown>;
  if (typeof o['sttProvider'] === 'string' && VALID_STT_PROVIDERS.has(o['sttProvider'])) {
    out.sttProvider = o['sttProvider'] as VoiceSettings['sttProvider'];
  }
  if (typeof o['ttsProvider'] === 'string' && VALID_TTS_PROVIDERS.has(o['ttsProvider'])) {
    // Cast: extended TTS ids (elevenlabs/fish/chatterbox/system) are
    // valid here even though the VoiceSettings union lags (see above).
    out.ttsProvider = o['ttsProvider'] as VoiceSettings['ttsProvider'];
  }
  if (typeof o.ttsVoice === 'string' && o.ttsVoice.trim() && o.ttsVoice.length <= 120) {
    out.ttsVoice = o.ttsVoice.trim();
  }
  if (typeof o.autoVad === 'boolean') out.autoVad = o.autoVad;
  if (
    typeof o.vadSensitivity === 'number' &&
    Number.isFinite(o.vadSensitivity) &&
    o.vadSensitivity >= 1 &&
    o.vadSensitivity <= 10
  ) {
    out.vadSensitivity = o.vadSensitivity;
  }
  return out;
}

/** Apply persisted voice settings onto in-memory bot configs (call at boot). */
export function applyBotVoice(bots: BotConfig[], dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = readFile(dataDir);
  const defaults = resolveDefaultVoiceSettings(env);
  const hasRealDefault = defaults.sttProvider !== 'mock' || defaults.ttsProvider !== 'mock';
  for (const bot of bots) {
    const sel = file[bot.id];
    const sanitized = sel ? sanitizeVoiceSettings(sel) : {};
    if (Object.keys(sanitized).length > 0) {
      // Persisted choices win; unresolved slots take the real default.
      bot.voice = hasRealDefault ? { ...defaults, ...sanitized } : sanitized;
    } else if (hasRealDefault) {
      // New/unconfigured bot: inherit the configured real provider(s)
      // instead of silently staying on the mock.
      bot.voice = resolveVoiceSettingsForBot(bot.voice, env);
    }
    // Nothing persisted and nothing configured: leave bot.voice as-is
    // (undefined means mock by convention — legacy behaviour preserved).
  }
}

/**
 * Save a bot's voice settings. Returns the saved settings.
 * Throws on unknown bot or invalid input.
 */
export function saveBotVoice(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  voice: unknown,
): VoiceSettings {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);
  if (typeof voice !== 'object' || voice === null) {
    throw new Error('voice must be an object');
  }
  const sanitized = sanitizeVoiceSettings(voice);
  if (Object.keys(sanitized).length === 0) {
    // Explicit empty clears.
    bot.voice = undefined;
  } else {
    bot.voice = sanitized;
  }
  const file = readFile(dataDir);
  if (Object.keys(sanitized).length === 0) delete file[botId];
  else file[botId] = sanitized;
  writeFile(dataDir, file);
  return sanitized;
}
