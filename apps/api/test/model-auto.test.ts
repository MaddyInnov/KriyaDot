// SPDX-License-Identifier: Apache-2.0
// OH-5: automatic model routing — deterministic rules over CONFIGURED
// providers only, the 'auto' sentinel persisting through bot-models,
// and decision-log recording.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvocationDecisionLog, type BotConfig } from '@mvp/agent-runtime';
import {
  resolveAutoModel,
  recordAutoModelDecision,
  type AutoModelCatalogEntry,
} from '../src/model-auto.js';
import { applyBotModels, saveBotModel } from '../src/bot-models.js';

const CATALOG: AutoModelCatalogEntry[] = [
  {
    providerId: 'groq',
    configured: true,
    models: [{ id: 'small-fast', name: 'Small Fast', contextLength: 8192, free: true }],
  },
  {
    providerId: 'openai',
    configured: true,
    models: [{ id: 'big-strong', name: 'Big Strong', contextLength: 128000, free: false }],
  },
  {
    providerId: 'anthropic',
    configured: false,
    models: [{ id: 'huge-unconfigured', name: 'Huge', contextLength: 200000, free: false }],
  },
];

const BOT = { id: 'b1', provider: 'groq', model: 'auto' } as Pick<BotConfig, 'id' | 'provider' | 'model'>;

describe('resolveAutoModel (fixture catalog)', () => {
  it('code fences take the strong lane: largest configured context wins', () => {
    const d = resolveAutoModel(BOT, 'fix this:\n```ts\nconst x = 1;\n```', { catalog: CATALOG });
    expect(d.tier).toBe('strong');
    expect(d.chosen).toBe('openai/big-strong');
  });

  it('long messages (>8000 chars) take the strong lane', () => {
    const d = resolveAutoModel(BOT, 'x'.repeat(9000), { catalog: CATALOG });
    expect(d.tier).toBe('strong');
    expect(d.chosen).toBe('openai/big-strong');
  });

  it('tool turns take the strong lane', () => {
    const d = resolveAutoModel(BOT, 'hi', { catalog: CATALOG, hasTools: true });
    expect(d.tier).toBe('strong');
    expect(d.chosen).toBe('openai/big-strong');
  });

  it('short simple messages take the cheap lane: free first, smallest context', () => {
    const d = resolveAutoModel(BOT, 'hello there', { catalog: CATALOG });
    expect(d.tier).toBe('cheap');
    expect(d.chosen).toBe('groq/small-fast');
  });

  it('unconfigured providers are never chosen, even with the biggest model', () => {
    for (const msg of ['hi', '```code```', 'x'.repeat(9000)]) {
      const d = resolveAutoModel(BOT, msg, { catalog: CATALOG });
      expect(d.providerId).not.toBe('anthropic');
    }
    const onlyUnconfigured = resolveAutoModel(BOT, 'hi', {
      catalog: CATALOG.map((c) => ({ ...c, configured: false })),
    });
    // No configured candidates at all → bot provider default fallback.
    expect(onlyUnconfigured.tier).toBe('default');
    expect(onlyUnconfigured.providerId).toBe('groq');
  });

  it('is deterministic: same inputs, same choice', () => {
    const a = resolveAutoModel(BOT, 'hello', { catalog: CATALOG });
    const b = resolveAutoModel(BOT, 'hello', { catalog: CATALOG });
    expect(a).toEqual(b);
  });
});

describe("'auto' sentinel persistence (bot-models)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'model-auto-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("PUT-model path accepts 'auto' and it round-trips through bot-models.json", () => {
    const bots = [
      { id: 'b1', name: 'B1', provider: 'groq', model: 'llama-3.3-70b', tools: [], skills: [] },
    ] as unknown as BotConfig[];
    const sel = saveBotModel(dir, bots, 'b1', 'auto', undefined);
    expect(sel.model).toBe('auto');
    expect(bots[0]!.model).toBe('auto');
    const fresh = [
      { id: 'b1', name: 'B1', provider: 'groq', model: 'llama-3.3-70b', tools: [], skills: [] },
    ] as unknown as BotConfig[];
    applyBotModels(fresh, dir);
    expect(fresh[0]!.model).toBe('auto');
  });
});

describe('recordAutoModelDecision', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'model-auto-log-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records via the unified invocation decision log with via:auto detail', () => {
    const d = resolveAutoModel(BOT, 'hello', { catalog: CATALOG });
    recordAutoModelDecision(dir, 'b1', d);
    const entries = new InvocationDecisionLog(dir).list(10, 'routing');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.subject).toBe(d.chosen);
    expect(entries[0]!.metadata).toMatchObject({ via: 'auto', chosen: d.chosen });
    expect(readFileSync(join(dir, 'invocation-decisions.jsonl'), 'utf8')).toContain('"via":"auto"');
  });
});
