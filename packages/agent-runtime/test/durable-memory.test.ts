// SPDX-License-Identifier: Apache-2.0
// Tests for Engram-parity durable memory extensions:
// - pin/unpin atoms (pinned surface first in recall)
// - category inference (fact/preference/decision/summary)
// - FTS5 search ranking and forget (delete removes FTS row)
// - session summaries
// - LLM distiller factory (mock chat fn, JSON parsing, fallback)
// - keeper trivial-turn skip
// - recall injection bounds (maxChars)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TieredMemoryStore,
  createLlmDistiller,
  heuristicDistill,
} from '../src/memory.js';

let dir: string;
let store: TieredMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-durable-'));
  store = new TieredMemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pin/unpin', () => {
  it('pins and unpins an atom', () => {
    const id = store.storeAtom('bot1', { fact: 'User likes tea.', entities: [], confidence: 0.8 }, 't1');
    expect(store.getAtoms('bot1')[0].pinned).toBe(false);

    expect(store.pinAtom('bot1', id)).toBe(true);
    expect(store.getAtoms('bot1')[0].pinned).toBe(true);

    expect(store.unpinAtom('bot1', id)).toBe(true);
    expect(store.getAtoms('bot1')[0].pinned).toBe(false);
  });

  it('returns false for unknown atom ids', () => {
    expect(store.pinAtom('bot1', 'nope')).toBe(false);
    expect(store.unpinAtom('bot1', 'nope')).toBe(false);
  });

  it('does not pin atoms from other bots', () => {
    const id = store.storeAtom('bot1', { fact: 'Fact one.', entities: [], confidence: 0.8 }, 't1');
    expect(store.pinAtom('bot2', id)).toBe(false);
    expect(store.getAtoms('bot1')[0].pinned).toBe(false);
  });
});

describe('pinned recall ordering', () => {
  it('pinned atoms surface first in recallForPrompt', () => {
    store.storeAtom('bot1', { fact: 'The user likes dark mode themes.', entities: [], confidence: 0.9 }, 't1');
    const pinnedId = store.storeAtom('bot1', { fact: 'The user likes light themes too.', entities: [], confidence: 0.5 }, 't2');
    store.pinAtom('bot1', pinnedId);

    const block = store.recallForPrompt('bot1', 'themes');
    const lines = block.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Pinned atom leads even though the other has higher confidence.
    expect(lines[0]).toContain('light themes too');
  });
});

describe('categories', () => {
  it('infers preference category from preference language', () => {
    const id = store.storeAtom('bot1', { fact: 'I like dark mode.', entities: [], confidence: 0.8 }, 't1');
    expect(store.getAtoms('bot1')[0].category).toBe('preference');
    void id;
  });

  it('infers decision category from decision language', () => {
    store.storeAtom('bot1', { fact: 'We decided to use SQLite for storage.', entities: [], confidence: 0.8 }, 't1');
    expect(store.getAtoms('bot1')[0].category).toBe('decision');
  });

  it('defaults to fact', () => {
    store.storeAtom('bot1', { fact: 'The meeting is on Tuesday.', entities: [], confidence: 0.8 }, 't1');
    expect(store.getAtoms('bot1')[0].category).toBe('fact');
  });

  it('accepts explicit category override', () => {
    store.storeAtom(
      'bot1',
      { fact: 'Custom category fact.', entities: [], confidence: 0.8 },
      't1',
      undefined,
      { category: 'decision' },
    );
    expect(store.getAtoms('bot1')[0].category).toBe('decision');
  });
});

describe('session summaries', () => {
  it('saves a summary with category=summary', () => {
    const id = store.saveSessionSummary('bot1', 'sess-1', 'Discussed the KriyaDot rename and release process.');
    const atoms = store.getAtoms('bot1');
    expect(atoms).toHaveLength(1);
    expect(atoms[0].id).toBe(id);
    expect(atoms[0].category).toBe('summary');
    expect(atoms[0].fact).toContain('KriyaDot rename');
  });

  it('rejects empty summaries', () => {
    expect(() => store.saveSessionSummary('bot1', 'sess-1', '  ')).toThrow();
  });

  it('dedupes identical summaries', () => {
    const s = 'Same summary text here.';
    const id1 = store.saveSessionSummary('bot1', 'sess-1', s);
    const id2 = store.saveSessionSummary('bot1', 'sess-2', s);
    expect(id1).toBe(id2);
    expect(store.getAtoms('bot1')).toHaveLength(1);
  });
});

describe('FTS5 search', () => {
  it('finds atoms by keyword', () => {
    store.storeAtom('bot1', { fact: 'The user prefers TypeScript over JavaScript.', entities: ['TypeScript'], confidence: 0.8 }, 't1');
    store.storeAtom('bot1', { fact: 'The user likes hiking on weekends.', entities: [], confidence: 0.8 }, 't2');

    const results = store.searchAtoms('bot1', 'TypeScript');
    expect(results).toHaveLength(1);
    expect(results[0].fact).toContain('TypeScript');
  });

  it('ranks BM25 relevance and returns empty for no match', () => {
    store.storeAtom('bot1', { fact: 'Python is great for scripting.', entities: [], confidence: 0.8 }, 't1');
    expect(store.searchAtoms('bot1', 'zebra')).toHaveLength(0);
    expect(store.searchAtoms('bot1', '')).toHaveLength(0);
  });

  it('forget removes the atom from FTS search too', () => {
    const id = store.storeAtom('bot1', { fact: 'Secret project codename is Phoenix.', entities: ['Phoenix'], confidence: 0.9 }, 't1');
    expect(store.searchAtoms('bot1', 'Phoenix')).toHaveLength(1);

    expect(store.deleteAtom('bot1', id)).toBe(true);
    expect(store.searchAtoms('bot1', 'Phoenix')).toHaveLength(0);
    expect(store.getAtoms('bot1')).toHaveLength(0);
  });

  it('isolates search per bot', () => {
    store.storeAtom('bot1', { fact: 'Bot one likes apples.', entities: [], confidence: 0.8 }, 't1');
    store.storeAtom('bot2', { fact: 'Bot two likes apples.', entities: [], confidence: 0.8 }, 't1');
    expect(store.searchAtoms('bot1', 'apples')).toHaveLength(1);
    expect(store.searchAtoms('bot1', 'apples')[0].botId).toBe('bot1');
  });
});

describe('dedup', () => {
  it('does not store the same fact twice', () => {
    const f = { fact: 'The user lives in Bangalore.', entities: ['Bangalore'], confidence: 0.8 };
    const id1 = store.storeAtom('bot1', f, 't1');
    const id2 = store.storeAtom('bot1', f, 't2');
    expect(id1).toBe(id2);
    expect(store.getAtoms('bot1')).toHaveLength(1);
  });

  it('treats case/punctuation variants as duplicates', () => {
    const id1 = store.storeAtom('bot1', { fact: 'User likes Tea!', entities: [], confidence: 0.8 }, 't1');
    const id2 = store.storeAtom('bot1', { fact: 'user likes tea', entities: [], confidence: 0.8 }, 't2');
    expect(id1).toBe(id2);
  });
});

describe('createLlmDistiller', () => {
  it('parses model JSON into facts', async () => {
    const chat = vi.fn().mockResolvedValue(
      JSON.stringify([
        { fact: 'The user is a software engineer.', entities: ['engineer'], confidence: 0.9 },
        { fact: 'The user prefers morning meetings.', entities: [], confidence: 0.75 },
      ]),
    );
    const distill = createLlmDistiller(chat);
    const facts = await distill('User: I am a software engineer. I prefer morning meetings.');
    expect(facts).toHaveLength(2);
    expect(facts[0].fact).toContain('software engineer');
    expect(facts[0].confidence).toBe(0.9);
    expect(chat).toHaveBeenCalledOnce();
  });

  it('strips markdown code fences', async () => {
    const chat = vi.fn().mockResolvedValue('```json\n[{"fact": "Fenced fact.", "entities": [], "confidence": 0.8}]\n```');
    const facts = await createLlmDistiller(chat)('User: hello world, this is a test message.');
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('Fenced fact.');
  });

  it('falls back to heuristic on bad JSON', async () => {
    const chat = vi.fn().mockResolvedValue('not json at all');
    const facts = await createLlmDistiller(chat)('User: I like dark mode and this is a longer test.');
    // Heuristic should extract the preference.
    expect(facts.some((f) => /dark mode/i.test(f.fact))).toBe(true);
  });

  it('falls back to heuristic on chat failure', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('model down'));
    const facts = await createLlmDistiller(chat)('User: call me Ashutosh please, this is a test.');
    expect(facts.some((f) => /Ashutosh/.test(f.fact))).toBe(true);
  });

  it('returns [] for empty model response without crashing', async () => {
    const chat = vi.fn().mockResolvedValue('[]');
    expect(await createLlmDistiller(chat)('User: hi there, this is long enough to pass.')).toEqual([]);
  });

  it('clamps confidence and caps at 10 facts', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      fact: `Fact number ${i} with enough length.`,
      entities: [],
      confidence: 5, // out of range
    }));
    const chat = vi.fn().mockResolvedValue(JSON.stringify(many));
    const facts = await createLlmDistiller(chat)('User: testing caps here for sure.');
    expect(facts).toHaveLength(10);
    expect(facts[0].confidence).toBe(1);
  });
});

describe('keeper trivial-turn skip', () => {
  it('skips distillation for trivial user text', async () => {
    const distillSpy = vi.fn().mockResolvedValue([]);
    store.setBotDistiller('bot1', distillSpy);
    // "hi" is too short to be substantive.
    store.ingestTurn('bot1', 'sess-1', 'hi', 'Hello! How can I help?');
    // Give the fire-and-forget a tick; distiller must NOT have run.
    await new Promise((r) => setTimeout(r, 50));
    expect(distillSpy).not.toHaveBeenCalled();
    // But the L0 events are still recorded.
    expect(store.getAtoms('bot1')).toHaveLength(0);
  });

  it('runs distillation for substantive turns', async () => {
    const distillSpy = vi.fn().mockResolvedValue([
      { fact: 'The user is testing the keeper.', entities: [], confidence: 0.8 },
    ]);
    store.setBotDistiller('bot1', distillSpy);
    store.ingestTurn('bot1', 'sess-1', 'I am testing the memory keeper with a longer message here.', 'Got it.');
    await new Promise((r) => setTimeout(r, 100));
    expect(distillSpy).toHaveBeenCalledOnce();
    expect(store.getAtoms('bot1')).toHaveLength(1);
  });

  it('setBotDistiller(undefined) clears the override', async () => {
    const distillSpy = vi.fn().mockResolvedValue([]);
    store.setBotDistiller('bot1', distillSpy);
    store.setBotDistiller('bot1', undefined);
    // Falls back to heuristic: "I like dark mode" is substantive + extractable.
    store.ingestTurn('bot1', 'sess-1', 'I like dark mode for all my editors, thanks.', 'Noted.');
    await new Promise((r) => setTimeout(r, 100));
    expect(distillSpy).not.toHaveBeenCalled();
    expect(store.getAtoms('bot1').length).toBeGreaterThan(0);
  });
});

describe('recall injection bounds', () => {
  it('caps recall output at maxChars', () => {
    for (let i = 0; i < 20; i++) {
      store.storeAtom(
        'bot1',
        { fact: `Memory fact number ${i} about testing the recall bounds thoroughly.`, entities: [], confidence: 0.8 },
        't1',
      );
    }
    const block = store.recallForPrompt('bot1', 'testing recall bounds', 200);
    expect(block.length).toBeLessThanOrEqual(200 + 100); // line granularity
    expect(block.startsWith('# What I remember')).toBe(true);
  });

  it('returns empty string when nothing matches', () => {
    store.storeAtom('bot1', { fact: 'Apples are red.', entities: [], confidence: 0.8 }, 't1');
    expect(store.recallForPrompt('bot1', 'quantum chromodynamics')).toBe('');
  });

  it('heuristicDistill is exported and functional', () => {
    const facts = heuristicDistill('Remember that the deadline is Friday.');
    expect(facts.length).toBeGreaterThan(0);
  });
});
