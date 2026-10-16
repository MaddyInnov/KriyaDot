// SPDX-License-Identifier: Apache-2.0
// Tests for full-text message search (OpenMausBot parity P1 #16):
// - FTS5 indexing is incremental (insert/delete triggers)
// - snippets carry \u0001..\u0002 match markers
// - botId / sessionId filters, limit clamping
// - hostile queries never throw
// - rebuildSearchIndex backfills rows written before the FTS table existed
// - branched sessions are searchable

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sess-search-'));
  dirs.push(d);
  return d;
}

describe('SessionStore.searchMessages', () => {
  it('finds messages by keyword with marked snippets, best rank first', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-a');
    store.appendMessage(sid, { role: 'user', content: 'how do I bake sourdough bread at home' });
    store.appendMessage(sid, { role: 'assistant', content: 'here is a recipe for pancakes' });
    store.appendMessage(sid, { role: 'user', content: 'bread baking takes patience and practice' });

    const hits = store.searchMessages('bread');
    expect(hits).toHaveLength(2);
    // Snippet wraps matched terms in \u0001..\u0002.
    for (const h of hits) {
      expect(h.snippet).toContain('bread');
      expect(h.snippet).toMatch(/\x01/);
      expect(h.snippet).toMatch(/\x02/);
    }
    expect(hits[0]!.sessionId).toBe(sid);
    expect(hits[0]!.botId).toBe('bot-a');
    expect(typeof hits[0]!.messageId).toBe('number');
    expect(typeof hits[0]!.rank).toBe('number');
    store.close();
  });

  it('stems words (porter): "baking" matches "bake"', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-a');
    store.appendMessage(sid, { role: 'user', content: 'I love to bake cakes' });
    const hits = store.searchMessages('baking');
    expect(hits).toHaveLength(1);
    store.close();
  });

  it('filters by botId and sessionId', () => {
    const store = new SessionStore(':memory:');
    const s1 = store.createSession('bot-a');
    const s2 = store.createSession('bot-b');
    store.appendMessage(s1, { role: 'user', content: 'unique zebra keyword here' });
    store.appendMessage(s2, { role: 'user', content: 'another unique zebra mention' });

    expect(store.searchMessages('zebra', { botId: 'bot-a' })).toHaveLength(1);
    expect(store.searchMessages('zebra', { botId: 'bot-a' })[0]!.sessionId).toBe(s1);
    expect(store.searchMessages('zebra', { sessionId: s2 })).toHaveLength(1);
    expect(store.searchMessages('zebra', { botId: 'nope' })).toHaveLength(0);
    store.close();
  });

  it('clamps limit to 1..100', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-a');
    for (let i = 0; i < 10; i++) store.appendMessage(sid, { role: 'user', content: `commonword message ${i}` });
    expect(store.searchMessages('commonword', { limit: 3 })).toHaveLength(3);
    expect(store.searchMessages('commonword', { limit: 0 })).toHaveLength(1);
    expect(store.searchMessages('commonword', { limit: 500 })).toHaveLength(10);
    store.close();
  });

  it('never throws on hostile or empty queries', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-a');
    store.appendMessage(sid, { role: 'user', content: 'hello world' });
    for (const q of ['', '   ', '"', '*', '((((', 'OR OR OR', 'a: b^c', '"unclosed']) {
      expect(() => store.searchMessages(q)).not.toThrow();
    }
    expect(store.searchMessages('')).toEqual([]);
    expect(store.searchMessages('   ')).toEqual([]);
    store.close();
  });

  it('ANDs multiple terms', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-a');
    store.appendMessage(sid, { role: 'user', content: 'red apples are tasty' });
    store.appendMessage(sid, { role: 'user', content: 'red cars are fast' });
    const hits = store.searchMessages('red apples');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain('apples');
    store.close();
  });

  it('drops deleted messages from the index (rewind)', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-a');
    store.appendMessage(sid, { role: 'user', content: 'keep this memorable phrase' });
    store.appendMessage(sid, { role: 'user', content: 'drop this forgettable phrase' });
    expect(store.searchMessages('forgettable')).toHaveLength(1);
    store.rewindHistory(sid, 1);
    expect(store.searchMessages('forgettable')).toHaveLength(0);
    expect(store.searchMessages('memorable')).toHaveLength(1);
    store.close();
  });

  it('indexes branched sessions', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-a');
    store.appendMessage(sid, { role: 'user', content: 'original quokka discussion' });
    store.appendMessage(sid, { role: 'assistant', content: 'quokkas are cute' });
    const ids = store.listThreadMessages(sid).map((m) => m.id);
    const branched = store.branchSession(sid, ids[0]!);
    expect(branched.ok).toBe(true);
    if (!branched.ok) throw new Error('branch failed');
    const hits = store.searchMessages('quokka');
    // Porter stemming matches "quokkas" too: 2 hits in the original
    // session + 1 copied into the branch (only the first message).
    expect(hits).toHaveLength(3);
    const inBranch = hits.filter((h) => h.sessionId === branched.session.id);
    expect(inBranch).toHaveLength(1);
    store.close();
  });

  it('rebuildSearchIndex backfills rows written before the FTS table existed', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'agent.db');
    const store = new SessionStore(dbPath);
    const sid = store.createSession('bot-a');
    store.appendMessage(sid, { role: 'user', content: 'antediluvian platypus facts' });
    store.close();

    // Simulate an upgrade: drop the FTS table, then reopen (constructor
    // backfills because the table is empty).
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE messages_fts');
    raw.close();

    const reopened = new SessionStore(dbPath);
    expect(reopened.searchMessages('platypus')).toHaveLength(1);

    // And an explicit rebuild works too.
    const raw2 = new DatabaseSync(dbPath);
    raw2.exec('DELETE FROM messages_fts');
    raw2.close();
    expect(reopened.searchMessages('platypus')).toHaveLength(0);
    const indexed = reopened.rebuildSearchIndex();
    expect(indexed).toBe(1);
    expect(reopened.searchMessages('platypus')).toHaveLength(1);
    reopened.close();
  });

  it('search works on a reopened file DB (persistence)', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'agent.db');
    const s1 = new SessionStore(dbPath);
    const sid = s1.createSession('bot-x');
    s1.appendMessage(sid, { role: 'user', content: 'persistent wombat knowledge' });
    s1.close();
    const s2 = new SessionStore(dbPath);
    // No duplicate FTS rows after reopen (backfill is skipped when non-empty).
    const hits = s2.searchMessages('wombat');
    expect(hits).toHaveLength(1);
    s2.close();
  });
});
