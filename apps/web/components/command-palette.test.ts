// SPDX-License-Identifier: Apache-2.0
// Command palette filtering tests (pure functions).

import { describe, expect, it } from 'vitest';
import { filterPaletteItems, fuzzyScore, type PaletteItem } from './command-palette';

const items: PaletteItem[] = [
  { id: 'bot:scout', kind: 'bot', label: 'Scout' },
  { id: 'dest:chat', kind: 'destination', label: 'Chat' },
  { id: 'dest:workflows', kind: 'destination', label: 'Workflows' },
  { id: 'action:new', kind: 'action', label: 'New thread' },
  { id: 'thread:1', kind: 'thread', label: 'Research chatbots' },
];

describe('fuzzyScore / filterPaletteItems', () => {
  it('empty query returns items in order (capped)', () => {
    expect(filterPaletteItems(items, '')).toEqual(items);
    expect(filterPaletteItems(items, '', 2)).toHaveLength(2);
  });
  it('subsequence match: "wf" finds Workflows, gibberish finds nothing', () => {
    expect(fuzzyScore('Workflows', 'wf')).toBeGreaterThan(0);
    expect(filterPaletteItems(items, 'wf').map((i) => i.id)).toEqual(['dest:workflows']);
    expect(filterPaletteItems(items, 'zzz')).toEqual([]);
  });
  it('contiguous/prefix matches rank above scattered ones', () => {
    const out = filterPaletteItems(items, 'chat');
    expect(out[0]?.id).toBe('dest:chat');
    expect(out.map((i) => i.id)).toContain('thread:1');
  });
});
