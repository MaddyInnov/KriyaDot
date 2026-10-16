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

const VALID_PROVIDERS = new Set(['mock', 'groq', 'openai']);

/** Sanitize raw input into VoiceSettings; unknown fields are dropped. */
export function sanitizeVoiceSettings(input: unknown): VoiceSettings {
  const out: VoiceSettings = {};
  if (typeof input !== 'object' || input === null) return out;
  const o = input as Record<string, unknown>;
  for (const key of ['sttProvider', 'ttsProvider'] as const) {
    if (typeof o[key] === 'string' && VALID_PROVIDERS.has(o[key])) {
      out[key] = o[key] as VoiceSettings[typeof key];
    }
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
export function applyBotVoice(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  for (const bot of bots) {
    const sel = file[bot.id];
    if (!sel) continue;
    const sanitized = sanitizeVoiceSettings(sel);
    if (Object.keys(sanitized).length > 0) bot.voice = sanitized;
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
