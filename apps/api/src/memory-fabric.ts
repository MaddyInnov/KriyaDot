// SPDX-License-Identifier: Apache-2.0
// Memory fabric host wiring (Atomic parity).
//
// Three pieces the runtime cannot own:
//  1. Per-bot memory settings overlay (<dataDir>/bot-memory-settings.json)
//     for the memoryReflection / memoryLiveDistill flags. Same overlay
//     pattern as bot-voice.ts: seed/bots.json is immutable at runtime.
//  2. buildBotChatFn(): a KeeperChatFn bound to a bot's own provider/model,
//     used by the reflection pass and the live (model) distiller.
//  3. wireMemoryDistillers(): installs the advanced LLM distiller for bots
//     with memoryLiveDistill enabled (call at boot; re-call after the
//     settings change).
//
// HOST WIRING (index.ts):
//   import { applyBotMemorySettings, wireMemoryDistillers } from './memory-fabric.js';
//   applyBotMemorySettings(seed.bots, config.dataDir);
//   wireMemoryDistillers(seed.bots, tieredMemoryStore);
//   // routes.ts, after PUT /api/bots/:id/memory-settings:
//   //   wireMemoryDistillers(deps.bots, tieredMemoryStore);

import fs from 'node:fs';
import path from 'node:path';
import {
  createLlmDistiller,
  createProvider,
  getDefaultModel,
  type BotConfig,
  type KeeperChatFn,
  type TieredMemoryStore,
} from '@mvp/agent-runtime';

const MEMORY_SETTINGS_FILE = 'bot-memory-settings.json';

export function botMemorySettingsPath(dataDir: string): string {
  return path.join(dataDir, MEMORY_SETTINGS_FILE);
}

export interface BotMemorySettings {
  memoryReflection?: boolean;
  memoryLiveDistill?: boolean;
}

type MemorySettingsFile = Record<string, BotMemorySettings>;

function readFile(dataDir: string): MemorySettingsFile {
  try {
    const raw = fs.readFileSync(botMemorySettingsPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as MemorySettingsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: MemorySettingsFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botMemorySettingsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botMemorySettingsPath(dataDir));
}

/** Sanitize raw input into BotMemorySettings; unknown fields are dropped. */
export function sanitizeMemorySettings(input: unknown): BotMemorySettings {
  const out: BotMemorySettings = {};
  if (typeof input !== 'object' || input === null) return out;
  const o = input as Record<string, unknown>;
  if (typeof o.memoryReflection === 'boolean') out.memoryReflection = o.memoryReflection;
  if (typeof o.memoryLiveDistill === 'boolean') out.memoryLiveDistill = o.memoryLiveDistill;
  return out;
}

/** Apply persisted memory settings onto in-memory bot configs (call at boot). */
export function applyBotMemorySettings(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  for (const bot of bots) {
    const sel = file[bot.id];
    if (!sel) continue;
    const sanitized = sanitizeMemorySettings(sel);
    if (typeof sanitized.memoryReflection === 'boolean') bot.memoryReflection = sanitized.memoryReflection;
    if (typeof sanitized.memoryLiveDistill === 'boolean') bot.memoryLiveDistill = sanitized.memoryLiveDistill;
  }
}

/**
 * Save a bot's memory settings. Returns the saved settings.
 * Throws on unknown bot or invalid input.
 */
export function saveBotMemorySettings(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  settings: unknown,
): BotMemorySettings {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);
  if (typeof settings !== 'object' || settings === null) {
    throw new Error('settings must be an object');
  }
  const sanitized = sanitizeMemorySettings(settings);
  if (typeof sanitized.memoryReflection === 'boolean') bot.memoryReflection = sanitized.memoryReflection;
  else bot.memoryReflection = undefined;
  if (typeof sanitized.memoryLiveDistill === 'boolean') bot.memoryLiveDistill = sanitized.memoryLiveDistill;
  else bot.memoryLiveDistill = undefined;
  const file = readFile(dataDir);
  if (Object.keys(sanitized).length === 0) delete file[botId];
  else file[botId] = sanitized;
  writeFile(dataDir, file);
  return sanitized;
}

/**
 * Build a KeeperChatFn from a bot's own provider/model. Returns undefined
 * when the provider cannot be constructed (unconfigured keys, unknown
 * provider) — memory must never break because a model is unreachable.
 */
export function buildBotChatFn(bot: BotConfig): KeeperChatFn | undefined {
  try {
    const providerId = bot.provider ?? 'groq';
    const provider = createProvider(providerId);
    const model = bot.model ?? getDefaultModel(providerId) ?? 'default';
    return async (systemPrompt: string, userText: string): Promise<string> => {
      const res = await provider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        [],
        { model },
      );
      return res.content;
    };
  } catch {
    return undefined;
  }
}

/**
 * Install (or clear) the live model distiller for every bot, based on
 * bot.memoryLiveDistill. Bots without the flag keep the zero-cost
 * heuristic distiller. The live distiller uses the advanced prompt so it
 * extracts lessons and procedures, not just facts.
 */
export function wireMemoryDistillers(bots: BotConfig[], store: TieredMemoryStore): void {
  for (const bot of bots) {
    if (bot.memoryLiveDistill === true) {
      const chat = buildBotChatFn(bot);
      store.setBotDistiller(bot.id, chat ? createLlmDistiller(chat, { advanced: true }) : undefined);
    } else {
      store.setBotDistiller(bot.id, undefined);
    }
  }
}
