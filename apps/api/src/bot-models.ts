// SPDX-License-Identifier: Apache-2.0
// Per-bot model + model-options persistence (Codync parity: model picker).
//
// Bot configs ship in seed/bots.json (immutable at runtime, and embedded in
// the single-file binary). Model selections from the UI are overlaid in
// <dataDir>/bot-models.json: { "<botId>": { "model": "...", "modelOptions": {...} } }.
// Applied onto the in-memory bots at boot (HOST WIRING: call
// applyBotModels(seed.bots, config.dataDir) in index.ts) and updated by
// PUT /api/bots/:id/model.

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, ModelOptions } from '@mvp/agent-runtime';

const MODELS_FILE = 'bot-models.json';

export function botModelsPath(dataDir: string): string {
  return path.join(dataDir, MODELS_FILE);
}

export interface BotModelSelection {
  model?: string;
  modelOptions?: ModelOptions;
  /** AI failover (W1): backup provider/model for hard-limit failures. */
  backupProvider?: string;
  backupModel?: string;
}

type ModelsFile = Record<string, BotModelSelection>;

function readFile(dataDir: string): ModelsFile {
  try {
    const raw = fs.readFileSync(botModelsPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ModelsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: ModelsFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botModelsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botModelsPath(dataDir));
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

function sanitizeOptions(input: unknown): ModelOptions {
  const out: ModelOptions = {};
  if (typeof input !== 'object' || input === null) return out;
  const o = input as Record<string, unknown>;
  if (typeof o.reasoningEffort === 'string' && VALID_EFFORTS.has(o.reasoningEffort)) {
    out.reasoningEffort = o.reasoningEffort as ModelOptions['reasoningEffort'];
  }
  if (typeof o.fastMode === 'boolean') out.fastMode = o.fastMode;
  if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) {
    out.temperature = Math.min(2, Math.max(0, o.temperature));
  }
  if (typeof o.maxTokens === 'number' && Number.isFinite(o.maxTokens) && o.maxTokens > 0) {
    out.maxTokens = Math.floor(o.maxTokens);
  }
  // ENGINES pack: DeepSeek thinking selection + local reply timeout.
  if (o.deepseekMode === 'chat' || o.deepseekMode === 'reasoner') {
    out.deepseekMode = o.deepseekMode;
  }
  if (typeof o.replyTimeoutMs === 'number' && Number.isFinite(o.replyTimeoutMs) && o.replyTimeoutMs > 0) {
    out.replyTimeoutMs = Math.min(3_600_000, Math.floor(o.replyTimeoutMs));
  }
  return out;
}

/**
 * Apply persisted model selections onto in-memory bot configs (call at boot).
 */
export function applyBotModels(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  for (const bot of bots) {
    const sel = file[bot.id];
    if (!sel) continue;
    if (typeof sel.model === 'string' && sel.model.trim()) bot.model = sel.model.trim();
    if (sel.modelOptions) bot.modelOptions = sanitizeOptions(sel.modelOptions);
    if (typeof sel.backupProvider === 'string' && sel.backupProvider.trim()) {
      bot.backupProvider = sel.backupProvider.trim();
    }
    if (typeof sel.backupModel === 'string' && sel.backupModel.trim()) {
      bot.backupModel = sel.backupModel.trim();
    }
  }
}

/**
 * Save a bot's model + options. Returns the saved selection.
 * Throws on unknown bot or invalid input.
 */
export function saveBotModel(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  model: unknown,
  modelOptions: unknown,
  backup?: { backupProvider?: unknown; backupModel?: unknown },
): BotModelSelection {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);

  const sel: BotModelSelection = {};
  if (typeof model === 'string' && model.trim()) {
    sel.model = model.trim();
    bot.model = sel.model;
  }
  // AI failover (W1): backup provider/model. Explicit null/empty clears.
  if (backup && backup.backupProvider !== undefined) {
    if (typeof backup.backupProvider === 'string' && backup.backupProvider.trim()) {
      sel.backupProvider = backup.backupProvider.trim().slice(0, 128);
      bot.backupProvider = sel.backupProvider;
    } else if (backup.backupProvider === null || backup.backupProvider === '') {
      bot.backupProvider = undefined;
    }
  }
  if (backup && backup.backupModel !== undefined) {
    if (typeof backup.backupModel === 'string' && backup.backupModel.trim()) {
      sel.backupModel = backup.backupModel.trim().slice(0, 256);
      bot.backupModel = sel.backupModel;
    } else if (backup.backupModel === null || backup.backupModel === '') {
      bot.backupModel = undefined;
    }
  }
  const opts = sanitizeOptions(modelOptions);
  if (Object.keys(opts).length > 0) {
    sel.modelOptions = opts;
    bot.modelOptions = opts;
  } else if (modelOptions !== undefined && modelOptions !== null) {
    // Explicit empty options clears.
    bot.modelOptions = undefined;
  }

  const file = readFile(dataDir);
  const existing = file[botId] ?? {};
  file[botId] = { ...existing, ...sel };
  // Explicit backup clears must also drop the persisted keys.
  if (backup?.backupProvider === null || backup?.backupProvider === '') delete file[botId].backupProvider;
  if (backup?.backupModel === null || backup?.backupModel === '') delete file[botId].backupModel;
  if (Object.keys(file[botId]).length === 0) delete file[botId];
  writeFile(dataDir, file);
  return file[botId] ?? {};
}
