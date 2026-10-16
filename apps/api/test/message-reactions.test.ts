// SPDX-License-Identifier: Apache-2.0
// Tests for message reactions (Codync parity).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MessageReactionStore, MAX_REACTIONS_PER_MESSAGE } from '../src/message-reactions.js';

describe('MessageReactionStore', () => {
  let tmpDir: string;
  let store: MessageReactionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kriyadot-react-test-'));
    store = new MessageReactionStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts empty', () => {
    expect(store.list('s1', 'm1')).toEqual([]);
  });

  it('toggle adds a reaction', () => {
    const { reactions, added } = store.toggle('s1', 'm1', '👍', 'user');
    expect(added).toBe(true);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({ emoji: '👍', userId: 'user' });
    expect(reactions[0].createdAt).toBeTruthy();
  });

  it('toggle twice removes the reaction', () => {
    store.toggle('s1', 'm1', '👍', 'user');
    const { reactions, added } = store.toggle('s1', 'm1', '👍', 'user');
    expect(added).toBe(false);
    expect(reactions).toEqual([]);
  });

  it('different users can react with the same emoji', () => {
    store.toggle('s1', 'm1', '👍', 'user');
    store.toggle('s1', 'm1', '👍', 'bot-helper');
    expect(store.list('s1', 'm1')).toHaveLength(2);
  });

  it('same user can use different emojis', () => {
    store.toggle('s1', 'm1', '👍', 'user');
    store.toggle('s1', 'm1', '❤️', 'user');
    expect(store.list('s1', 'm1')).toHaveLength(2);
  });

  it(`evicts oldest when exceeding ${MAX_REACTIONS_PER_MESSAGE}`, () => {
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥', '⭐', '💯'];
    emojis.forEach((e, i) => store.toggle('s1', 'm1', e, `user${i}`));
    const reactions = store.list('s1', 'm1');
    expect(reactions).toHaveLength(MAX_REACTIONS_PER_MESSAGE);
    // Oldest two (👍, ❤️) evicted; newest (💯) present.
    const present = new Set(reactions.map((r) => r.emoji));
    expect(present.has('👍')).toBe(false);
    expect(present.has('❤️')).toBe(false);
    expect(present.has('💯')).toBe(true);
  });

  it('reactions are isolated per message and session', () => {
    store.toggle('s1', 'm1', '👍', 'user');
    expect(store.list('s1', 'm2')).toEqual([]);
    expect(store.list('s2', 'm1')).toEqual([]);
  });

  it('listForMessages batches correctly', () => {
    store.toggle('s1', 'm1', '👍', 'user');
    store.toggle('s1', 'm2', '❤️', 'user');
    const map = store.listForMessages('s1', ['m1', 'm2', 'm3']);
    expect(map.get('m1')).toHaveLength(1);
    expect(map.get('m2')).toHaveLength(1);
    expect(map.has('m3')).toBe(false);
  });

  it('rejects invalid emoji', () => {
    expect(() => store.toggle('s1', 'm1', '', 'user')).toThrow();
  });

  it('clearMessage removes all reactions', () => {
    store.toggle('s1', 'm1', '👍', 'user');
    store.clearMessage('s1', 'm1');
    expect(store.list('s1', 'm1')).toEqual([]);
  });
});
