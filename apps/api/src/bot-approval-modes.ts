// SPDX-License-Identifier: Apache-2.0
// Per-bot approval mode persistence (Atomic parity: plan/auto/bypass).
//
// Same overlay pattern as bot-voice.ts: bot configs ship in seed/bots.json
// (immutable at runtime); approval modes from the UI are overlaid in
// <dataDir>/bot-approval-modes.json: { "<botId>": "plan"|"auto"|"bypass" }.
// Applied onto the in-memory bots at boot (HOST WIRING: call
// applyBotApprovalModes(seed.bots, config.dataDir) in index.ts) and updated
// by PUT /api/bots/:id/approval-mode.

import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalMode, BotConfig } from '@mvp/agent-runtime';
import { parseApprovalMode } from '@mvp/agent-runtime';

const MODES_FILE = 'bot-approval-modes.json';

export function botApprovalModesPath(dataDir: string): string {
  return path.join(dataDir, MODES_FILE);
}

type ModesFile = Record<string, string>;

function readFile(dataDir: string): ModesFile {
  try {
    const raw = fs.readFileSync(botApprovalModesPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ModesFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: ModesFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botApprovalModesPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botApprovalModesPath(dataDir));
}

/** Sanitize a raw approval mode value; returns undefined when invalid. */
export function sanitizeApprovalMode(input: unknown): ApprovalMode | undefined {
  return parseApprovalMode(input);
}

/** Apply persisted approval modes onto in-memory bot configs (call at boot). */
export function applyBotApprovalModes(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  for (const bot of bots) {
    const raw = file[bot.id];
    if (!raw) continue;
    const mode = sanitizeApprovalMode(raw);
    if (mode) bot.approvalMode = mode;
  }
}

/** Persist one bot's approval mode. Returns the sanitized mode or undefined. */
export function saveBotApprovalMode(
  dataDir: string,
  botId: string,
  mode: unknown,
): ApprovalMode | undefined {
  const sanitized = sanitizeApprovalMode(mode);
  if (!sanitized) return undefined;
  const file = readFile(dataDir);
  file[botId] = sanitized;
  writeFile(dataDir, file);
  return sanitized;
}

/**
 * Persist one bot's approval mode and apply it to the in-memory bot.
 * Throws on unknown bot or invalid mode.
 */
export function saveBotApprovalModeForBot(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  mode: unknown,
): ApprovalMode {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);
  const sanitized = sanitizeApprovalMode(mode);
  if (!sanitized) throw new Error('approvalMode must be one of plan|auto|bypass');
  const file = readFile(dataDir);
  file[botId] = sanitized;
  writeFile(dataDir, file);
  bot.approvalMode = sanitized;
  return sanitized;
}

/** Read one bot's persisted approval mode (undefined = default 'auto'). */
export function getBotApprovalMode(dataDir: string, botId: string): ApprovalMode | undefined {
  return sanitizeApprovalMode(readFile(dataDir)[botId]);
}
