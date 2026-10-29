// SPDX-License-Identifier: Apache-2.0
// Learning hardening: verbatim-quote grounding, verifier-gated tidy
// merges, provenance on atoms, and neural recall re-ranking.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJournal, tidyMemory } from '../src/memory-upkeep.js';
import { TieredMemoryStore } from '../src/memory.js';
import type { SyncEmbedder } from '../src/hybrid-search.js';

const BOT = 'bot-learn';

let dir: string;
let store: TieredMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-learn-'));
  store = new TieredMemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verbatim-quote grounding', () => {
  it('stores a quote that literally appears in the source, with provenance', () => {
    const source = 'The user said: "I deploy on Fridays, never Mondays." Then discussion followed.';
    const id = store.storeVerbatimQuote(BOT, {
      quote: 'I deploy on Fridays, never Mondays.',
      sourceText: source,
      sourceRef: 'event-123',
    });
    expect(id).not.toBeNull();
    const atom = store.getAtom(BOT, id!);
    expect(atom?.fact).toBe('I deploy on Fridays, never Mondays.');
    expect(atom?.quote).toBe('I deploy on Fridays, never Mondays.');
    expect(atom?.quoteSource).toBe('event-123');
    expect(store.droppedUngroundedQuotes).toBe(0);
  });

  it('drops a quote the source never said (fail-closed) and counts it', () => {
    const id = store.storeVerbatimQuote(BOT, {
      quote: 'I always deploy on Sundays',
      sourceText: 'The user talked about deployment schedules for a while.',
      sourceRef: 'event-9',
    });
    expect(id).toBeNull();
    expect(store.droppedUngroundedQuotes).toBe(1);
    expect(store.getAtoms(BOT, 10)).toEqual([]);
  });

  it('tolerates whitespace differences between quote and source', () => {
    const id = store.storeVerbatimQuote(BOT, {
      quote: 'line one line two',
      sourceText: 'line one\n   line two',
      sourceRef: 'event-10',
    });
    expect(id).not.toBeNull();
  });
});

describe('near-duplicate detection + verifier-gated merges', () => {
  function seedNearDupes(): void {
    // Trigram-similar paraphrases (same words, slightly reworded).
    store.storeAtom(BOT, { fact: 'The user prefers dark roast coffee in the morning', entities: [], confidence: 0.9 }, 't1');
    store.storeAtom(BOT, { fact: 'The user prefers dark roast coffee every morning', entities: [], confidence: 0.9 }, 't2');
    store.storeAtom(BOT, { fact: 'Quarterly revenue grew twelve percent year over year', entities: [], confidence: 0.9 }, 't3');
  }

  it('finds near-duplicate pairs above the threshold', () => {
    seedNearDupes();
    const pairs = store.findNearDuplicatePairs(BOT, 0.8);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0]!.keep.fact).toContain('dark roast');
    expect(pairs[0]!.duplicate.fact).toContain('dark roast');
  });

  it('tidy never merges paraphrases without a verifier', () => {
    seedNearDupes();
    const journal = new MemoryJournal(dir);
    const result = tidyMemory(store, journal, BOT, { nearDuplicateThreshold: 0.8 });
    expect(result.nearDuplicatesFound).toBeGreaterThanOrEqual(1);
    expect(result.mergesVetoed).toBe(0);
    expect(store.getAtoms(BOT, 10).filter((a) => a.fact.includes('dark roast'))).toHaveLength(2);
  });

  it('tidy merges when the verifier approves, and counts vetoes', () => {
    seedNearDupes();
    const journal = new MemoryJournal(dir);
    const vetoed = tidyMemory(store, journal, BOT, {
      nearDuplicateThreshold: 0.8,
      mergeVerifier: () => false,
    });
    expect(vetoed.mergesVetoed).toBeGreaterThanOrEqual(1);
    expect(store.getAtoms(BOT, 10).filter((a) => a.fact.includes('dark roast'))).toHaveLength(2);

    const merged = tidyMemory(store, journal, BOT, {
      nearDuplicateThreshold: 0.8,
      mergeVerifier: () => true,
    });
    expect(merged.duplicatesDeactivated).toBeGreaterThanOrEqual(1);
    expect(store.getAtoms(BOT, 10).filter((a) => a.fact.includes('dark roast'))).toHaveLength(1);
  });

  it('a throwing verifier vetoes (fail-closed)', () => {
    seedNearDupes();
    const journal = new MemoryJournal(dir);
    const result = tidyMemory(store, journal, BOT, {
      nearDuplicateThreshold: 0.8,
      mergeVerifier: () => {
        throw new Error('verifier down');
      },
    });
    expect(result.mergesVetoed).toBeGreaterThanOrEqual(1);
    expect(store.getAtoms(BOT, 10).filter((a) => a.fact.includes('dark roast'))).toHaveLength(2);
  });
});

describe('neural recall re-rank', () => {
  it('re-ranks hybrid candidates with the async embedder', async () => {
    store.storeAtom(BOT, { fact: 'The user drives a blue automobile to work', entities: [], confidence: 0.9 }, 't1');
    store.storeAtom(BOT, { fact: 'The user brews coffee at home', entities: [], confidence: 0.9 }, 't2');
    // Stub neural embedder: anything mentioning car-ish words is close
    // to the query; everything else is orthogonal.
    const stub: SyncEmbedder = {
      name: 'stub-neural',
      dim: 2,
      embedSync: (texts) => texts.map(() => new Float32Array([1, 0])),
      embed: async (texts) =>
        texts.map((t) =>
          /car|automobile|vehicle/i.test(t)
            ? new Float32Array([1, 0])
            : new Float32Array([0, 1]),
        ),
    };
    const neuralStore = new TieredMemoryStore(dir, { neuralEmbedder: stub });
    const hits = await neuralStore.recallHybridNeural(BOT, 'what car does the user drive', 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.atom.fact).toContain('automobile');
    const block = await neuralStore.recallForPromptNeural(BOT, 'what car does the user drive');
    expect(block).toContain('automobile');
  });

  it('degrades to hybrid order without a neural embedder', async () => {
    store.storeAtom(BOT, { fact: 'The user brews coffee at home every day', entities: [], confidence: 0.9 }, 't1');
    const hits = await store.recallHybridNeural(BOT, 'coffee', 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
