// SPDX-License-Identifier: Apache-2.0
// Tests for tiered memory (L0 events → L2 atoms → L3 entity pages):
// - heuristic distillation extracts preferences/identity/memory requests
// - dedupe: same fact stored twice yields one atom
// - entity pages aggregate atoms by entity
// - recall ranks by keyword overlap and caps output size
// - ingestTurn is fire-and-forget (never throws, never blocks)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TieredMemoryStore, heuristicDistill } from '../src/memory.js';

let dir: string;
let store: TieredMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-tiered-'));
  store = new TieredMemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('heuristicDistill', () => {
  it('extracts preferences', () => {
    const facts = heuristicDistill('I like dark mode. I prefer concise answers.');
    expect(facts.length).toBe(2);
    expect(facts[0].fact).toMatch(/like dark mode/i);
    expect(facts[1].fact).toMatch(/prefer concise/i);
  });

  it('extracts identity facts', () => {
    const facts = heuristicDistill('Call me Ashutosh. My timezone is Asia/Kolkata.');
    expect(facts.some((f) => f.fact.includes('Ashutosh'))).toBe(true);
    expect(facts.some((f) => f.fact.includes('Asia/Kolkata'))).toBe(true);
  });

  it('extracts explicit memory requests', () => {
    const facts = heuristicDistill('Remember that the deploy happens on Fridays.');
    expect(facts).toHaveLength(1);
    expect(facts[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('ignores ordinary chit-chat', () => {
    expect(heuristicDistill('Hello, how are you today?')).toHaveLength(0);
    expect(heuristicDistill('The weather is nice.')).toHaveLength(0);
  });

  it('skips code blocks producing phantom facts', () => {
    // heuristic works per-sentence; code-ish long lines are skipped
    expect(heuristicDistill('x'.repeat(500))).toHaveLength(0);
  });
});

describe('TieredMemoryStore', () => {
  it('stores atoms and dedupes identical facts', () => {
    const id1 = store.storeAtom('helper', { fact: 'I like dark mode.', entities: [], confidence: 0.8 }, 'sess-1');
    const id2 = store.storeAtom('helper', { fact: 'i like dark mode!', entities: [], confidence: 0.8 }, 'sess-2');
    expect(id1).toBe(id2); // normalized dedupe
    expect(store.getAtoms('helper')).toHaveLength(1);
  });

  it('keeps per-bot isolation', () => {
    store.storeAtom('helper', { fact: 'I like dark mode.', entities: [], confidence: 0.8 }, 's1');
    store.storeAtom('coder', { fact: 'I like dark mode.', entities: [], confidence: 0.8 }, 's1');
    expect(store.getAtoms('helper')).toHaveLength(1);
    expect(store.getAtoms('coder')).toHaveLength(1);
  });

  it('aggregates entity pages from atoms', () => {
    store.storeAtom('helper', { fact: 'The user works at Acme Corp.', entities: ['Acme Corp'], confidence: 0.8 }, 's1');
    store.storeAtom('helper', { fact: 'Acme Corp uses TypeScript.', entities: ['Acme Corp'], confidence: 0.7 }, 's2');
    const entities = store.getEntities('helper');
    const page = entities.find((e) => e.entity === 'Acme Corp');
    expect(page).toBeDefined();
    expect(page!.atomIds).toHaveLength(2);
    expect(page!.summary).toContain('Acme Corp');
  });

  it('deletes atoms', () => {
    const id = store.storeAtom('helper', { fact: 'I like dark mode.', entities: [], confidence: 0.8 }, 's1');
    expect(store.deleteAtom('helper', id)).toBe(true);
    expect(store.deleteAtom('helper', id)).toBe(false);
    expect(store.getAtoms('helper')).toHaveLength(0);
  });

  it('recall ranks by keyword overlap and caps size', () => {
    store.storeAtom('helper', { fact: 'I like dark mode.', entities: ['UI'], confidence: 0.8 }, 's1');
    store.storeAtom('helper', { fact: 'My dog is named Bruno.', entities: ['Bruno'], confidence: 0.9 }, 's1');
    const block = store.recallForPrompt('helper', 'what theme do I like for the UI?');
    expect(block).toContain('dark mode');
    expect(block).not.toContain('Bruno');
    expect(block.length).toBeLessThanOrEqual(2100);
  });

  it('recall returns empty when nothing matches', () => {
    store.storeAtom('helper', { fact: 'I like dark mode.', entities: [], confidence: 0.8 }, 's1');
    expect(store.recallForPrompt('helper', 'quantum chromodynamics')).toBe('');
    expect(store.recallForPrompt('nobody', 'dark mode')).toBe('');
  });

  it('ingestTurn records L0 events and distills async without throwing', async () => {
    store.ingestTurn('helper', 'sess-9', 'I like dark mode, remember that.', 'Got it, dark mode it is.', ['write_file']);
    // L0 events are recorded synchronously
    // distillation is async — wait a tick
    await new Promise((r) => setTimeout(r, 50));
    const atoms = store.getAtoms('helper');
    expect(atoms.some((a) => a.fact.toLowerCase().includes('dark mode'))).toBe(true);
  });

  it('ingestTurn never throws even with a failing distiller', async () => {
    const bad = new TieredMemoryStore(dir, {
      distiller: async () => {
        throw new Error('boom');
      },
    });
    expect(() => bad.ingestTurn('helper', 's', 'hi', 'hello')).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('uses an injected LLM distiller when provided', async () => {
    const distiller = vi.fn(async () => [{ fact: 'LLM fact.', entities: ['TestCo'], confidence: 0.95 }]);
    const s2 = new TieredMemoryStore(dir, { distiller });
    // Substantive user text so the keeper's trivial-turn skip doesn't fire.
    s2.ingestTurn('helper', 'sess-1', 'Please remember that TestCo is our biggest client account.', 'hi there');
    await new Promise((r) => setTimeout(r, 50));
    expect(distiller).toHaveBeenCalled();
    const atoms = s2.getAtoms('helper');
    expect(atoms.some((a) => a.fact === 'LLM fact.')).toBe(true);
    const entities = s2.getEntities('helper');
    expect(entities.some((e) => e.entity === 'TestCo')).toBe(true);
  });
});
