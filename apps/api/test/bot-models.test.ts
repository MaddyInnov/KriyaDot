// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from '@mvp/agent-runtime';
import { applyBotModels, saveBotModel } from '../src/bot-models.js';

function makeBots(): BotConfig[] {
  return [
    { id: 'scout', name: 'Scout', description: '', systemPrompt: '', provider: 'groq', model: 'gpt-oss-120b', skills: [], tools: [], mcpServers: [] },
    { id: 'coder', name: 'Coder', description: '', systemPrompt: '', provider: 'groq', model: 'gpt-oss-120b', skills: [], tools: [], mcpServers: [] },
  ];
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bot-models-test-'));
  return () => rmSync(dataDir, { recursive: true, force: true });
});

describe('saveBotModel', () => {
  it('saves model and options, applies to in-memory bot', () => {
    const bots = makeBots();
    const sel = saveBotModel(dataDir, bots, 'scout', 'gpt-5', { reasoningEffort: 'high', fastMode: true });
    expect(sel.model).toBe('gpt-5');
    expect(sel.modelOptions?.reasoningEffort).toBe('high');
    expect(bots[0].model).toBe('gpt-5');
    expect(bots[0].modelOptions?.fastMode).toBe(true);
  });

  it('throws on unknown bot', () => {
    expect(() => saveBotModel(dataDir, makeBots(), 'nope', 'x', null)).toThrow('Unknown bot');
  });

  it('sanitizes invalid options', () => {
    const bots = makeBots();
    const sel = saveBotModel(dataDir, bots, 'scout', null, {
      reasoningEffort: 'ultra',
      temperature: 99,
      maxTokens: -5,
    });
    expect(sel.modelOptions?.reasoningEffort).toBeUndefined();
    expect(sel.modelOptions?.temperature).toBe(2);
    expect(sel.modelOptions?.maxTokens).toBeUndefined();
  });

  it('persists across applyBotModels', () => {
    const bots = makeBots();
    saveBotModel(dataDir, bots, 'coder', 'o3-mini', { reasoningEffort: 'medium' });
    const fresh = makeBots();
    applyBotModels(fresh, dataDir);
    expect(fresh[1].model).toBe('o3-mini');
    expect(fresh[1].modelOptions?.reasoningEffort).toBe('medium');
    // Untouched bot keeps defaults.
    expect(fresh[0].model).toBe('gpt-oss-120b');
    expect(fresh[0].modelOptions).toBeUndefined();
  });
});
