// SPDX-License-Identifier: Apache-2.0
// Tests for memory-upkeep.ts:
// - extractFactsFromText pulls durable facts from plain sentences
// - MemoryJournal keeps the last N changes revertable (undo)
// - readAboutMe/writeAboutMe persist the user profile
// - tidyMemory dedupes near-identical atoms

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractFactsFromText,
  MemoryJournal,
  readAboutMe,
  tidyMemory,
  writeAboutMe,
} from '../src/memory-upkeep.js';

describe('extractFactsFromText', () => {
  it('extracts durable facts, skips ephemera', () => {
    const facts = extractFactsFromText(
      'My name is Ashutosh. I live in Bengaluru. I prefer dark mode. The meeting is at 3pm.',
    ).map((f) => f.fact);
    expect(facts.some((f) => f.includes('Ashutosh'))).toBe(true);
    expect(facts.some((f) => f.toLowerCase().includes('bengaluru'))).toBe(true);
    expect(facts.some((f) => f.toLowerCase().includes('dark mode'))).toBe(true);
    expect(facts.some((f) => f.includes('3pm'))).toBe(false);
  });
  it('returns [] for empty input', () => {
    expect(extractFactsFromText('')).toEqual([]);
    expect(extractFactsFromText('   ')).toEqual([]);
  });
});

describe('MemoryJournal', () => {
  let dir: string;
  let journal: MemoryJournal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memjournal-'));
    journal = new MemoryJournal(dir);
  });
  afterEach(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records writes and undoes the last one', () => {
    journal.record({ botId: 'b1', action: 'add', atomId: 'atom-1', note: 'wrote atom' });
    journal.record({ botId: 'b1', action: 'add', atomId: 'atom-2', note: 'wrote atom 2' });
    expect(journal.list('b1')).toHaveLength(2);
    const fakeStore = { setAtomActive: () => true };
    const undone = journal.undoLast('b1', fakeStore as never);
    expect(undone?.atomId).toBe('atom-2');
    expect(journal.list('b1')).toHaveLength(1);
  });

  it('returns null when there is nothing to undo', () => {
    const fakeStore = { setAtomActive: () => true };
    expect(journal.undoLast('nobody', fakeStore as never)).toBeNull();
  });
});

describe('about-me profile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aboutme-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reads back', () => {
    expect(readAboutMe(dir).text).toBe('');
    writeAboutMe(dir, 'I am a night owl. I build robots.');
    expect(readAboutMe(dir).text).toBe('I am a night owl. I build robots.');
  });
  it('rejects overlong profiles', () => {
    expect(() => writeAboutMe(dir, 'x'.repeat(50_000))).toThrow();
  });
});

describe('tidyMemory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tidy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes near-identical atoms, keeping the earliest', () => {
    const atoms = [
      { id: 'a1', fact: 'The user lives in Bengaluru.', createdAt: 100, entities: [] },
      { id: 'a2', fact: 'The user lives in Bengaluru!', createdAt: 200, entities: [] },
      { id: 'a3', fact: 'The user likes filter coffee.', createdAt: 300, entities: [] },
    ];
    const deactivated: string[] = [];
    const store = {
      getAtoms: () => atoms,
      setAtomActive: (_botId: string, id: string, active: boolean) => {
        if (!active) deactivated.push(id);
        return true;
      },
      createLink: () => undefined,
    };
    const journal = new MemoryJournal(dir);
    try {
      const result = tidyMemory(store as never, journal, 'bot-1');
      expect(result.duplicatesDeactivated).toBe(1);
      expect(deactivated).toEqual(['a2']);
      expect(result.examined).toBe(3);
      // The dedupe is journaled so it can be undone.
      expect(journal.list('bot-1').some((e) => e.action === 'deactivate')).toBe(true);
    } finally {
      journal.close();
    }
  });
});
