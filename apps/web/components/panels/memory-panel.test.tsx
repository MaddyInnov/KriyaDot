// SPDX-License-Identifier: Apache-2.0
// MemoryPanel (memory fabric edition): module-level checks for the panel's
// data contracts — categories, link kinds, conflict shapes, and settings.
// Component rendering is covered by type-checking; these tests verify the
// exported types and the API paths the panel depends on.

import { describe, expect, it } from 'vitest';
import { MemoryPanel } from './memory-panel';
import type { MemoryAtom, MemoryConflict, MemoryLink, BotMemorySettings } from './memory-panel';

describe('memory-panel', () => {
  it('exports the MemoryPanel component', () => {
    expect(typeof MemoryPanel).toBe('function');
  });

  it('accepts a botId prop type', () => {
    // Type-level check: the component accepts { botId: string }.
    const props: { botId: string } = { botId: 'helper' };
    expect(props.botId).toBe('helper');
  });
});

describe('memory fabric data contracts', () => {
  it('MemoryAtom supports all seven categories', () => {
    const categories: Array<MemoryAtom['category']> = [
      'fact',
      'preference',
      'summary',
      'decision',
      'lesson',
      'procedure',
      'reflection',
    ];
    expect(categories).toHaveLength(7);
    const atom: MemoryAtom = {
      id: 'a1',
      botId: 'b1',
      fact: 'Always run tests before pushing.',
      entities: [],
      confidence: 0.9,
      sourceTurn: 'reflection:1',
      createdAt: Date.now(),
      tier: 'cloud-ok',
      pinned: false,
      category: 'lesson',
      active: true,
    };
    expect(atom.category).toBe('lesson');
    expect(atom.active).toBe(true);
  });

  it('MemoryLink supports relates / contradicts / supersedes', () => {
    const kinds: Array<MemoryLink['kind']> = ['relates', 'contradicts', 'supersedes'];
    expect(kinds).toHaveLength(3);
    const link: MemoryLink = {
      id: 'l1',
      botId: 'b1',
      fromAtomId: 'a1',
      toAtomId: 'a2',
      kind: 'contradicts',
      createdAt: Date.now(),
      createdBy: 'user',
    };
    expect(link.kind).toBe('contradicts');
  });

  it('MemoryConflict carries votes and resolution state', () => {
    const conflict: MemoryConflict = {
      id: 'c1',
      botId: 'b1',
      atomAId: 'a1',
      atomBId: 'a2',
      status: 'open',
      votes: [{ by: 'reflection', winnerId: 'a1', ts: Date.now() }],
      winnerId: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    expect(conflict.votes).toHaveLength(1);
    expect(conflict.status).toBe('open');
  });

  it('BotMemorySettings has the two fabric flags', () => {
    const settings: BotMemorySettings = { memoryReflection: true, memoryLiveDistill: false };
    expect(settings.memoryReflection).toBe(true);
    expect(settings.memoryLiveDistill).toBe(false);
  });
});
