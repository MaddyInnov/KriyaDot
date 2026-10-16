// SPDX-License-Identifier: Apache-2.0
// Per-bot skill list persistence (OpenMausBot parity P1 #20: skill review).
//
// Bot configs ship in seed/bots.json (immutable at runtime, and embedded in
// the single-file binary). Skill attachments from the review UI are overlaid
// in <dataDir>/bot-skills.json: { "<botId>": ["skill-a", "skill-b"] }.
// Applied onto the in-memory bots at boot (HOST WIRING: call
// applyBotSkills(seed.bots, config.dataDir) in index.ts) and updated by the
// /api/skills/:name/attach|detach endpoints.

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig } from '@mvp/agent-runtime';

const SKILLS_FILE = 'bot-skills.json';

export function botSkillsPath(dataDir: string): string {
  return path.join(dataDir, SKILLS_FILE);
}

type SkillsFile = Record<string, string[]>;

function readFile(dataDir: string): SkillsFile {
  try {
    const raw = fs.readFileSync(botSkillsPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: SkillsFile = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && Array.isArray(v) && v.every((e) => typeof e === 'string')) {
        out[k] = [...new Set(v as string[])];
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: SkillsFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botSkillsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botSkillsPath(dataDir));
}

/** Apply persisted skill lists onto in-memory bot configs (call at boot). */
export function applyBotSkills(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  for (const bot of bots) {
    const skills = file[bot.id];
    if (skills) bot.skills = [...skills];
  }
}

/** Current skill list for a bot (overlay applied). */
export function getBotSkills(bots: BotConfig[], botId: string): string[] {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);
  return [...(bot.skills ?? [])];
}

/** Replace a bot's skill list (persisted + in-memory). Returns the new list. */
export function setBotSkills(dataDir: string, bots: BotConfig[], botId: string, skills: unknown): string[] {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);
  if (!Array.isArray(skills) || !skills.every((s) => typeof s === 'string')) {
    throw new Error('skills must be an array of strings');
  }
  const clean = [...new Set((skills as string[]).map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  bot.skills = clean;
  const file = readFile(dataDir);
  file[botId] = clean;
  writeFile(dataDir, file);
  return [...clean];
}

/** Attach one skill to a bot (idempotent). Returns the new list. */
export function attachBotSkill(dataDir: string, bots: BotConfig[], botId: string, skillName: string): string[] {
  const current = getBotSkills(bots, botId);
  if (current.includes(skillName)) return current;
  return setBotSkills(dataDir, bots, botId, [...current, skillName]);
}

/** Detach one skill from a bot (idempotent). Returns the new list. */
export function detachBotSkill(dataDir: string, bots: BotConfig[], botId: string, skillName: string): string[] {
  const current = getBotSkills(bots, botId);
  return setBotSkills(
    dataDir,
    bots,
    botId,
    current.filter((s) => s !== skillName),
  );
}
