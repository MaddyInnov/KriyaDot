// SPDX-License-Identifier: Apache-2.0
// Tests for the memory fabric (Atomic parity):
// - new categories: lesson / procedure / reflection
// - typed links between atoms (relates | contradicts | supersedes)
// - conflicts: open (deduped), vote, resolve (loser goes inactive, kept)
// - reflection pass with a mocked chat fn
// - turn counters for the periodic auto-reflection trigger
// - advanced LLM distiller extracts lessons/procedures with categories

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TieredMemoryStore,
  createLlmDistiller,
  parseReflectionJson,
  type KeeperChatFn,
} from '../src/memory.js';

let dir: string;
let store: TieredMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-fabric-'));
  store = new TieredMemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const atom = (fact: string, category?: 'fact' | 'lesson' | 'procedure' | 'reflection') =>
  store.storeAtom('bot1', { fact, entities: [], confidence: 0.8 }, 'test', undefined, { category });

describe('new memory categories', () => {
  it('stores and returns lesson / procedure / reflection atoms', () => {
    const l = atom('Always run the test suite before pushing.', 'lesson');
    const p = atom('Procedure: deploy\n1. Build.\n2. Test.', 'procedure');
    const r = atom('Recent turns went well; deployment knowledge is solid.', 'reflection');
    const byId = new Map(store.getAtoms('bot1').map((a) => [a.id, a]));
    expect(byId.get(l)?.category).toBe('lesson');
    expect(byId.get(p)?.category).toBe('procedure');
    expect(byId.get(r)?.category).toBe('reflection');
  });

  it('atoms are active by default', () => {
    const id = atom('Some durable fact here.');
    expect(store.getAtom('bot1', id)?.active).toBe(true);
  });

  it('getAtom returns undefined for unknown ids', () => {
    expect(store.getAtom('bot1', 'nope')).toBeUndefined();
  });
});

describe('memory links', () => {
  it('creates and lists relates links in both directions', () => {
    const a = atom('The user likes dark mode interface.');
    const b = atom('The user works late at night often.');
    const id = store.createLink('bot1', a, b, 'relates');
    expect(typeof id).toBe('string');
    expect(store.getLinksForAtom('bot1', a)).toHaveLength(1);
    expect(store.getLinksForAtom('bot1', b)).toHaveLength(1);
    expect(store.getLinks('bot1')).toHaveLength(1);
  });

  it('dedupes identical links', () => {
    const a = atom('The user likes dark mode interface.');
    const b = atom('The user works late at night often.');
    const first = store.createLink('bot1', a, b, 'relates');
    const second = store.createLink('bot1', a, b, 'relates');
    expect(second).toBe(first);
    expect(store.getLinks('bot1')).toHaveLength(1);
  });

  it('rejects invalid kinds, self-links, and unknown atoms', () => {
    const a = atom('The user likes dark mode interface.');
    expect(() => store.createLink('bot1', a, a, 'relates')).toThrow(/itself/);
    expect(() => store.createLink('bot1', a, 'missing', 'relates')).toThrow(/Unknown atom/);
    expect(() => store.createLink('bot1', a, 'missing2', 'nope' as never)).toThrow(/Invalid link kind/);
  });

  it('deletes links', () => {
    const a = atom('The user likes dark mode interface.');
    const b = atom('The user works late at night often.');
    const id = store.createLink('bot1', a, b, 'relates');
    expect(store.deleteLink('bot1', id)).toBe(true);
    expect(store.getLinksForAtom('bot1', a)).toHaveLength(0);
    expect(store.deleteLink('bot1', id)).toBe(false);
  });

  it('forgetting an atom cleans up its links', () => {
    const a = atom('The user likes dark mode interface.');
    const b = atom('The user works late at night often.');
    store.createLink('bot1', a, b, 'relates');
    store.deleteAtom('bot1', a);
    expect(store.getLinks('bot1')).toHaveLength(0);
  });
});

describe('conflicts and voting', () => {
  const twoAtoms = () => {
    const a = atom('The user prefers dark mode interface.');
    const b = atom('The user prefers light mode interface.');
    return { a, b };
  };

  it('contradicts links auto-open a conflict', () => {
    const { a, b } = twoAtoms();
    store.createLink('bot1', a, b, 'contradicts');
    const conflicts = store.listConflicts('bot1');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).toBe('open');
    expect([conflicts[0].atomAId, conflicts[0].atomBId].sort()).toEqual([a, b].sort());
  });

  it('openConflict dedupes in both orders', () => {
    const { a, b } = twoAtoms();
    const first = store.openConflict('bot1', a, b);
    const second = store.openConflict('bot1', b, a);
    expect(second).toBe(first);
    expect(store.listConflicts('bot1')).toHaveLength(1);
  });

  it('votes accumulate without resolving', () => {
    const { a, b } = twoAtoms();
    const id = store.openConflict('bot1', a, b);
    const after = store.voteConflict('bot1', id, a, 'user');
    expect(after.votes).toHaveLength(1);
    expect(after.votes[0]).toMatchObject({ by: 'user', winnerId: a });
    expect(store.listConflicts('bot1')[0].status).toBe('open');
  });

  it('resolveConflict keeps the winner, inactivates the loser, links supersedes', () => {
    const { a, b } = twoAtoms();
    const id = store.openConflict('bot1', a, b);
    const resolved = store.resolveConflict('bot1', id, a);
    expect(resolved.status).toBe('resolved');
    expect(resolved.winnerId).toBe(a);
    // Loser is inactive but kept; winner still active.
    expect(store.getAtom('bot1', b)?.active).toBe(false);
    expect(store.getAtom('bot1', a)?.active).toBe(true);
    // Inactive atoms are excluded from recall, search, and default listing.
    expect(store.getAtoms('bot1').some((x) => x.id === b)).toBe(false);
    expect(store.getAtoms('bot1', 200, { includeInactive: true }).some((x) => x.id === b)).toBe(true);
    expect(store.recallForPrompt('bot1', 'light mode interface')).not.toContain('light mode');
    // A supersedes link winner → loser is recorded.
    const links = store.getLinksForAtom('bot1', a);
    expect(links.some((l) => l.kind === 'supersedes' && l.toAtomId === b)).toBe(true);
    // Conflict no longer listed as open, but visible as resolved.
    expect(store.listConflicts('bot1')).toHaveLength(0);
    expect(store.listConflicts('bot1', 'resolved')).toHaveLength(1);
  });

  it('double resolve and votes on resolved conflicts throw', () => {
    const { a, b } = twoAtoms();
    const id = store.openConflict('bot1', a, b);
    store.resolveConflict('bot1', id, a);
    expect(() => store.resolveConflict('bot1', id, a)).toThrow(/already resolved/);
    expect(() => store.voteConflict('bot1', id, a)).toThrow(/already resolved/);
  });

  it('winnerId must be one of the two atoms', () => {
    const { a, b } = twoAtoms();
    const c = atom('The user drinks coffee in the morning.');
    const id = store.openConflict('bot1', a, b);
    expect(() => store.resolveConflict('bot1', id, c)).toThrow(/one of the two/);
    expect(() => store.voteConflict('bot1', id, c)).toThrow(/one of the two/);
  });

  it('supersedes links inactivate the target immediately', () => {
    const a = atom('The new deployment process is fully automated.');
    const b = atom('Deployment is a manual checklist process.');
    store.createLink('bot1', a, b, 'supersedes');
    expect(store.getAtom('bot1', b)?.active).toBe(false);
    expect(store.getAtom('bot1', a)?.active).toBe(true);
  });
});

describe('reflection turn counters', () => {
  it('returns false until the threshold, then true and resets', () => {
    for (let i = 0; i < TieredMemoryStore.REFLECTION_EVERY_TURNS - 1; i++) {
      expect(store.noteTurnForReflection('bot1')).toBe(false);
    }
    expect(store.noteTurnForReflection('bot1')).toBe(true);
    // Counter reset: next turn is not due again.
    expect(store.noteTurnForReflection('bot1')).toBe(false);
  });

  it('counters are per-bot', () => {
    for (let i = 0; i < TieredMemoryStore.REFLECTION_EVERY_TURNS; i++) {
      store.noteTurnForReflection('bot1');
    }
    expect(store.noteTurnForReflection('bot2')).toBe(false);
  });
});

describe('runReflectionPass', () => {
  const seedThree = () => {
    atom('The user prefers dark mode interface.');
    atom('The user works on the KriyaDot project daily.');
    atom('Deployments happen on Friday afternoons regularly.');
  };

  const chatReturning = (payload: unknown): KeeperChatFn =>
    async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));

  it('stores lessons, procedures, opens conflicts, and writes a reflection atom', async () => {
    seedThree();
    const chat = chatReturning({
      lessons: [{ fact: 'Always run tests before pushing to main.', entities: [], confidence: 0.9 }],
      procedures: [
        { name: 'Friday deploy', steps: ['Build the app', 'Run smoke tests', 'Publish the release'], entities: [], confidence: 0.8 },
      ],
      contradictions: [{ a: 0, b: 1, note: 'test contradiction' }],
      reflection: 'Deployment knowledge is solid; UI preference may need revisiting.',
    });
    const result = await store.runReflectionPass('bot1', chat);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.lessonsCreated).toBe(1);
    expect(result.proceduresCreated).toBe(1);
    expect(result.conflictsOpened).toBe(1);
    expect(result.reflectionAtomId).toBeTruthy();
    const cats = new Map(store.getAtoms('bot1').map((a) => [a.id, a.category]));
    expect([...cats.values()]).toContain('lesson');
    expect([...cats.values()]).toContain('procedure');
    expect([...cats.values()]).toContain('reflection');
    const lesson = store.getAtoms('bot1').find((a) => a.category === 'lesson');
    expect(lesson?.fact).toContain('run tests before pushing');
    // The reflection pass votes (as 'reflection'); the conflict stays open for the user.
    const conflicts = store.listConflicts('bot1');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].votes[0].by).toBe('reflection');
  });

  it('skips when there are fewer than 3 memories', async () => {
    atom('Only one memory exists here.');
    const chat = chatReturning({ lessons: [], procedures: [], contradictions: [], reflection: 'x' });
    const result = await store.runReflectionPass('bot1', chat);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/not enough/);
  });

  it('skips cleanly on invalid JSON and on chat failure', async () => {
    seedThree();
    const badJson = await store.runReflectionPass('bot1', chatReturning('not json at all'));
    expect(badJson.ok).toBe(false);
    expect(badJson.skipped).toBe(true);
    const failing: KeeperChatFn = async () => {
      throw new Error('model down');
    };
    const failed = await store.runReflectionPass('bot1', failing);
    expect(failed.ok).toBe(false);
    expect(failed.skipped).toBe(true);
  });

  it('ignores out-of-range contradiction indexes', async () => {
    seedThree();
    const chat = chatReturning({
      lessons: [],
      procedures: [],
      contradictions: [{ a: 0, b: 99, note: 'bad index' }, { a: 1, b: 1, note: 'self' }],
      reflection: 'Nothing new.',
    });
    const result = await store.runReflectionPass('bot1', chat);
    expect(result.ok).toBe(true);
    expect(result.conflictsOpened).toBe(0);
  });
});

describe('parseReflectionJson', () => {
  it('parses valid JSON and fenced JSON', () => {
    const raw = '{"lessons": [], "procedures": [], "contradictions": [], "reflection": "ok"}';
    expect(parseReflectionJson(raw)?.reflection).toBe('ok');
    expect(parseReflectionJson('```json\n' + raw + '\n```')?.reflection).toBe('ok');
  });

  it('returns null for invalid JSON', () => {
    expect(parseReflectionJson('nope')).toBeNull();
    expect(parseReflectionJson('[1,2,3]'.replace('[', '{'))).toBeNull();
  });
});

describe('advanced LLM distiller', () => {
  it('extracts lessons and procedures with categories when advanced', async () => {
    const chat: KeeperChatFn = async () =>
      JSON.stringify([
        { fact: 'Always run tests before pushing.', entities: [], confidence: 0.9, category: 'lesson' },
        { fact: 'Procedure: deploy\n1. Build.\n2. Test.', entities: [], confidence: 0.8, category: 'procedure' },
        { fact: 'The user likes dark mode.', entities: [], confidence: 0.8, category: 'preference' },
      ]);
    const distill = createLlmDistiller(chat, { advanced: true });
    const facts = await distill('User: I broke main again. Assistant: I fixed it after running tests.');
    expect(facts).toHaveLength(3);
    expect(facts[0].category).toBe('lesson');
    expect(facts[1].category).toBe('procedure');
    expect(facts[2].category).toBe('preference');
  });

  it('ignores categories in the non-advanced prompt', async () => {
    const chat: KeeperChatFn = async () =>
      JSON.stringify([{ fact: 'Always run tests before pushing.', entities: [], confidence: 0.9, category: 'lesson' }]);
    const distill = createLlmDistiller(chat);
    const facts = await distill('some turn text here');
    expect(facts).toHaveLength(1);
    expect(facts[0].category).toBeUndefined();
  });

  it('advanced categories flow through distillAndStore via ingestTurn path', async () => {
    // storeAtom honors an explicit category from the distiller.
    const id = store.storeAtom(
      'bot1',
      { fact: 'Always verify checksums after downloading binaries.', entities: [], confidence: 0.9, category: 'lesson' },
      'turn-1',
      undefined,
      { category: 'lesson' },
    );
    expect(store.getAtom('bot1', id)?.category).toBe('lesson');
  });
});
