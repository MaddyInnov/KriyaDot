// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  buildSessionHistory,
  buildWorkspaceList,
  filterHistoryByWorkspace,
  relativeTime,
  searchHistory,
  type HistoryBot,
  type HistoryConvo,
} from './sessions-history';

const NOW = 1_730_000_000_000;

describe('relativeTime', () => {
  it('uses harness-style compact units', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(relativeTime(NOW - 22 * 3_600_000, NOW)).toBe('22h');
    expect(relativeTime(NOW - 24 * 3_600_000, NOW)).toBe('1d');
    expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe('4d');
  });
  it('falls back to a date for old entries', () => {
    expect(relativeTime(NOW - 90 * 86_400_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

const bots: HistoryBot[] = [
  { id: 'scout', name: 'Scout' },
  { id: 'coder', name: 'Coder', workspace: '/home/u/proj-alpha' },
  { id: 'writer', name: 'Writer', workspace: '/home/u/proj-beta' },
];

const convos: Record<string, HistoryConvo[]> = {
  scout: [
    { id: 's1', title: 'Morning briefing', createdAt: NOW - 50 * 3_600_000 },
    { id: 's2', title: 'Hidden one', createdAt: NOW - 3_600_000, hidden: true },
  ],
  coder: [
    { id: 'c1', title: 'Fix the build', createdAt: NOW - 90 * 3_600_000 },
    { id: 'c2', title: 'Pinned task', createdAt: NOW - 200 * 3_600_000, pinned: true },
  ],
  writer: [{ id: 'w1', title: 'Draft post', createdAt: NOW - 30 * 3_600_000 }],
};

const lastTs = (id: string): number | null =>
  ({ s1: NOW - 2 * 3_600_000, c1: NOW - 26 * 3_600_000, w1: NOW - 30 * 3_600_000 })[id] ?? null;

describe('buildSessionHistory', () => {
  it('excludes hidden, prefers last block time, sorts pinned then recency', () => {
    const h = buildSessionHistory(bots, convos, lastTs);
    expect(h.map((e) => e.convoId)).toEqual(['c2', 's1', 'c1', 'w1']);
    expect(h[1].lastActivity).toBe(NOW - 2 * 3_600_000);
    expect(h[1].botName).toBe('Scout');
    expect(h[1].workspace).toBeNull();
    expect(h[2].workspace).toBe('/home/u/proj-alpha');
  });
  it('falls back to createdAt and botId for unknown bots', () => {
    const h = buildSessionHistory([], { ghost: [{ id: 'g1', title: 'X', createdAt: 42 }] }, () => null);
    expect(h[0]).toMatchObject({ botName: 'ghost', lastActivity: 42, pinned: false });
  });
});

describe('buildWorkspaceList + filter', () => {
  it('lists default first, then named workspaces with counts', () => {
    const h = buildSessionHistory(bots, convos, lastTs);
    const ws = buildWorkspaceList(bots, h);
    expect(ws.map((w) => w.label)).toEqual(['Default workspace', 'proj-alpha', 'proj-beta']);
    expect(ws[0].sessionCount).toBe(1);
    expect(ws[1].sessionCount).toBe(2);
    expect(filterHistoryByWorkspace(h, '/home/u/proj-alpha').map((e) => e.convoId)).toEqual(['c2', 'c1']);
    expect(filterHistoryByWorkspace(h, null).map((e) => e.convoId)).toEqual(['s1']);
    expect(filterHistoryByWorkspace(h, undefined)).toHaveLength(4);
  });

  it('labels allocated …/bots/<id>/workspace paths by the bot segment', () => {
    const allocBots = [
      { id: 'scout', name: 'Scout', workspace: '/data/bots/scout/workspace' },
      { id: 'helper', name: 'Helper', workspace: '/data/bots/helper/workspace' },
    ];
    const ws = buildWorkspaceList(allocBots, []);
    expect(ws.map((w) => w.label)).toEqual(['Default workspace', 'helper', 'scout']);
  });
});

describe('searchHistory', () => {
  it('matches title and bot name case-insensitively', () => {
    const h = buildSessionHistory(bots, convos, lastTs);
    expect(searchHistory(h, 'BUILD').map((e) => e.convoId)).toEqual(['c1']);
    expect(searchHistory(h, 'writer').map((e) => e.convoId)).toEqual(['w1']);
    expect(searchHistory(h, '  ')).toHaveLength(4);
  });
});
