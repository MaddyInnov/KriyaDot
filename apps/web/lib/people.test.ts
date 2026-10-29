// SPDX-License-Identifier: Apache-2.0
// W7 web helpers: org grouping + owner moves, mention picker (bots +
// people), draft mention application.

import { describe, expect, it } from 'vitest';
import {
  applyMention,
  currentMentionQuery,
  groupBotsByPerson,
  mentionCandidates,
  moveBotOwner,
  ownerOf,
  type OrgBot,
  type Person,
} from './people';

function person(id: string, name: string, extra: Partial<Person> = {}): Person {
  return {
    id,
    name,
    avatarColor: '#123456',
    channels: { handles: {} },
    isDefaultUser: id === 'you',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

const PEOPLE: Person[] = [person('you', 'You'), person('per_ana', 'Ana Rao'), person('per_ben', 'Ben Cole')];
const BOTS: OrgBot[] = [
  { id: 'b1', name: 'Coder Bot', ownerId: 'per_ana' },
  { id: 'b2', name: 'Scout' },
  { id: 'b3', name: 'Helper', ownerId: 'per_ben' },
];

describe('org helpers', () => {
  it('groups bots by owner with default-user fallback', () => {
    expect(ownerOf(BOTS[1]!)).toBe('you');
    const cols = groupBotsByPerson(PEOPLE, BOTS);
    const by = (pid: string) => cols.find((c) => c.person.id === pid)?.bots.map((b) => b.id);
    expect(by('per_ana')).toEqual(['b1']);
    expect(by('per_ben')).toEqual(['b3']);
    expect(by('you')).toEqual(['b2']);
  });

  it('moveBotOwner returns a new array with only that bot moved', () => {
    const moved = moveBotOwner(BOTS, 'b2', 'per_ben');
    expect(moved).not.toBe(BOTS);
    expect(moved.find((b) => b.id === 'b2')?.ownerId).toBe('per_ben');
    expect(BOTS.find((b) => b.id === 'b2')?.ownerId).toBeUndefined();
    const cols = groupBotsByPerson(PEOPLE, moved);
    expect(cols.find((c) => c.person.id === 'per_ben')?.bots.map((b) => b.id).sort()).toEqual(['b2', 'b3']);
  });
});

describe('mention picker', () => {
  it('reads the trailing @query only at the end of the draft', () => {
    expect(currentMentionQuery('hey @an')).toBe('an');
    expect(currentMentionQuery('@')).toBe('');
    expect(currentMentionQuery('no mention')).toBeNull();
    expect(currentMentionQuery('mail me @ work')).toBeNull();
    expect(currentMentionQuery('done @ana ')).toBeNull();
  });

  it('offers bots and people side by side, filtered by the query', () => {
    const all = mentionCandidates(BOTS, PEOPLE, '');
    expect(all.some((c) => c.kind === 'bot' && c.id === 'b1')).toBe(true);
    expect(all.some((c) => c.kind === 'person' && c.id === 'per_ana')).toBe(true);
    const anaOnly = mentionCandidates(BOTS, PEOPLE, 'ana');
    expect(anaOnly).toHaveLength(1);
    expect(anaOnly[0]).toMatchObject({ kind: 'person', id: 'per_ana', token: '@ana' });
    expect(mentionCandidates(BOTS, PEOPLE, null)).toEqual([]);
    const coder = mentionCandidates(BOTS, PEOPLE, 'coder');
    expect(coder[0]).toMatchObject({ kind: 'bot', token: '@CoderBot' });
  });

  it('applyMention swaps the trailing @query for the chosen token', () => {
    const cand = mentionCandidates(BOTS, PEOPLE, 'ana')[0]!;
    expect(applyMention('hey @an', cand)).toBe('hey @ana ');
    expect(applyMention('@an', cand)).toBe('@ana ');
  });
});
