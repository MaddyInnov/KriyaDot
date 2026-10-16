// SPDX-License-Identifier: Apache-2.0
// Per-bot skill list overlay (P1 #20): persistence, boot application,
// attach/detach idempotency.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  applyBotSkills,
  attachBotSkill,
  botSkillsPath,
  detachBotSkill,
  getBotSkills,
  setBotSkills,
} from '../src/bot-skills.js';

function bot(id: string, skills: string[] = []): BotConfig {
  return {
    id,
    name: id,
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills,
    tools: [],
    mcpServers: [],
  };
}

describe('bot-skills overlay', () => {
  it('set/get round-trips and persists to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botskills-'));
    const bots = [bot('a', ['x'])];
    expect(setBotSkills(dir, bots, 'a', ['x', 'y', 'x'])).toEqual(['x', 'y']);
    expect(getBotSkills(bots, 'a')).toEqual(['x', 'y']);
    const file = JSON.parse(readFileSync(botSkillsPath(dir), 'utf8')) as unknown as Record<string, string[]>;
    expect(file.a).toEqual(['x', 'y']);
  });

  it('applyBotSkills overlays at boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botskills-'));
    setBotSkills(dir, [bot('a')], 'a', ['s1']);
    const fresh = [bot('a', ['seed-skill'])];
    applyBotSkills(fresh, dir);
    expect(fresh[0].skills).toEqual(['s1']);
  });

  it('attach/detach are idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botskills-'));
    const bots = [bot('a')];
    expect(attachBotSkill(dir, bots, 'a', 's')).toEqual(['s']);
    expect(attachBotSkill(dir, bots, 'a', 's')).toEqual(['s']);
    expect(detachBotSkill(dir, bots, 'a', 's')).toEqual([]);
    expect(detachBotSkill(dir, bots, 'a', 's')).toEqual([]);
  });

  it('throws for unknown bots and bad input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botskills-'));
    const bots = [bot('a')];
    expect(() => getBotSkills(bots, 'ghost')).toThrow('Unknown bot');
    expect(() => setBotSkills(dir, bots, 'a', 'not-an-array' as unknown as string[])).toThrow();
  });
});
