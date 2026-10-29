// SPDX-License-Identifier: Apache-2.0
// Chat polish pure-logic tests: find, spoilers, citations, unread
// divider, badge title, finished-step folding, mentions.

import { describe, expect, it } from 'vitest';
import {
  badgedTitle, findInMessages, normalizeCitation, normalizeCitations,
  parseSpoilerSegments, splitByQuery, unreadDividerIndex,
} from './chat-polish';
import { foldFinishedSteps } from './step-state';
import { filterMentions, mentionQueryAt } from './mention-menu';

const msgs = [
  { id: 'a', text: 'Hello world' },
  { id: 'b', text: 'say hello again, HELLO' },
  { id: 'c', text: 'nothing here' },
];

describe('findInMessages', () => {
  it('finds all case-insensitive matches in order with ranges', () => {
    const m = findInMessages(msgs, 'hello');
    expect(m).toHaveLength(3);
    expect(m[0]).toMatchObject({ blockId: 'a', start: 0, end: 5, index: 0 });
    expect(m[2]).toMatchObject({ blockId: 'b', index: 2 });
  });
  it('empty query → no matches', () => {
    expect(findInMessages(msgs, '  ')).toEqual([]);
  });
  it('splitByQuery marks hits', () => {
    expect(splitByQuery('a hello b', 'hello')).toEqual([
      { text: 'a ', hit: false }, { text: 'hello', hit: true }, { text: ' b', hit: false },
    ]);
  });
});

describe('spoilers + citations', () => {
  it('parseSpoilerSegments splits ||spans||', () => {
    expect(parseSpoilerSegments('x ||secret|| y')).toEqual([
      { text: 'x ', spoiler: false }, { text: 'secret', spoiler: true }, { text: ' y', spoiler: false },
    ]);
  });
  it('normalizeCitation accepts chat shape and KB shape', () => {
    expect(normalizeCitation({ title: 'Doc', url: 'https://x', excerpt: 'e' })).toEqual({ title: 'Doc', url: 'https://x', excerpt: 'e' });
    expect(normalizeCitation({ docTitle: 'KB Doc', docId: 'd1', excerpt: 'e2' })).toEqual({ title: 'KB Doc', docId: 'd1', excerpt: 'e2' });
    expect(normalizeCitation({ nope: 1 })).toBeNull();
    expect(normalizeCitations('nope')).toEqual([]);
    expect(normalizeCitations([{ title: 'A' }, null])).toHaveLength(1);
  });
});

describe('unread divider + badge', () => {
  const blocks = [{ id: '1', ts: 10 }, { id: '2', ts: 20 }, { id: '3', ts: 30 }];
  it('first block after last-read id; -1 when all read', () => {
    expect(unreadDividerIndex(blocks, { id: '1' })).toBe(1);
    expect(unreadDividerIndex(blocks, { id: '3' })).toBe(-1);
    expect(unreadDividerIndex(blocks, { ts: 20 })).toBe(2);
    expect(unreadDividerIndex(blocks, {})).toBe(-1);
  });
  it('badgedTitle prefixes count only when > 0', () => {
    expect(badgedTitle('KriyaDot', 3)).toBe('(3) KriyaDot');
    expect(badgedTitle('KriyaDot', 0)).toBe('KriyaDot');
  });
});

describe('foldFinishedSteps', () => {
  it('collapses completed steps into a summary line', () => {
    const s = foldFinishedSteps(['read_file', 'search', 'write', 'test']);
    expect(s?.count).toBe(4);
    expect(s?.label).toBe('✓ 4 steps · read_file, search, +2 more');
    expect(foldFinishedSteps([])).toBeNull();
    expect(foldFinishedSteps([' one '])?.label).toBe('✓ 1 step · one');
  });
});

describe('mentions', () => {
  const entries = [
    { id: 'scout', kind: 'bot' as const, label: 'Scout' },
    { id: 'p1', kind: 'person' as const, label: 'Sara' },
    { id: 'sage', kind: 'bot' as const, label: 'Sage' },
  ];
  it('mentionQueryAt finds the @query at the caret, not emails', () => {
    expect(mentionQueryAt('hi @Sc', 6)).toEqual({ query: 'Sc', start: 3 });
    expect(mentionQueryAt('mail a@b', 8)).toBeNull();
    expect(mentionQueryAt('hi @Sc x', 9)).toBeNull();
  });
  it('filterMentions unifies bots + people, prefix first', () => {
    expect(filterMentions(entries, 'sa').map((e) => e.label)).toEqual(['Sara', 'Sage']);
    expect(filterMentions(entries, '')).toHaveLength(3);
  });
});
