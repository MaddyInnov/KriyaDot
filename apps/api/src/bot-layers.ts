// SPDX-License-Identifier: Apache-2.0
// Per-bot layer pipeline persistence (Octomind parity #41).
//
// Same overlay pattern as bot-approval-modes.ts: bot configs ship in
// seed/bots.json (immutable at runtime); layer pipelines edited in the
// UI are overlaid in <dataDir>/bot-layers.json:
// { "<botId>": LayerStageSpec[] }. Applied onto the in-memory bots at
// boot (HOST WIRING: applyBotLayers(seed.bots, config.dataDir) in
// index.ts) and updated by PUT /api/bots/:id/layers in routes.ts.
// Validation is the runtime's own validateExtendedLayers, so the API
// accepts exactly the stage shape the runtime executes (kinds
// prepare/review/execute/verify, outputMode, role, profile).

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, LayerStageSpec } from '@mvp/agent-runtime';
import { validateExtendedLayers } from '@mvp/agent-runtime';

const LAYERS_FILE = 'bot-layers.json';

export function botLayersPath(dataDir: string): string {
  return path.join(dataDir, LAYERS_FILE);
}

type LayersFile = Record<string, unknown>;

function readFile(dataDir: string): LayersFile {
  try {
    const raw = fs.readFileSync(botLayersPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as LayersFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: LayersFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botLayersPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botLayersPath(dataDir));
}

/** Sanitize a raw layers value; undefined when invalid (errors in `errors`). */
export function sanitizeBotLayers(input: unknown): { layers?: LayerStageSpec[]; errors: string[] } {
  const { layers, errors } = validateExtendedLayers(input, 'bot');
  return { ...(layers ? { layers: layers as LayerStageSpec[] } : {}), errors };
}

/** Apply persisted layer pipelines onto in-memory bot configs (call at boot). */
export function applyBotLayers(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  for (const bot of bots) {
    const raw = file[bot.id];
    if (raw === undefined) continue;
    const { layers } = sanitizeBotLayers(raw);
    if (layers) bot.layers = layers;
  }
}

/**
 * Persist one bot's layer pipeline and apply it to the in-memory bot.
 * Throws on unknown bot or invalid layers. An empty array clears the
 * pipeline (single-stage turns).
 */
export function saveBotLayersForBot(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  rawLayers: unknown,
): LayerStageSpec[] {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  const { layers, errors } = sanitizeBotLayers(rawLayers);
  if (errors.length > 0 || !layers) {
    throw new Error(errors.join('; ') || 'layers must be an array of stage specs');
  }
  const file = readFile(dataDir);
  file[botId] = layers;
  writeFile(dataDir, file);
  bot.layers = layers;
  return layers;
}
