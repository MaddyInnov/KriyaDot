// SPDX-License-Identifier: Apache-2.0

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HISTORY_LIMIT,
  SessionStore,
} from '../src/sessions.js';
import type { ChatMessage } from '../src/types.js';

const ENV_KEY = 'SESSION_HISTORY_LIMIT';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  vi.restoreAllMocks();
});

function seed(store: SessionStore, sessionId: string, n: number): void {
  for (let i = 1; i <= n; i++) {
    store.appendMessage(sessionId, { role: 'user', content: `msg-${i}` });
  }
}

describe('getMessages rolling cap', () => {
  it('returns at most the default limit, oldest first dropped, in order', async () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seed(store, sid, DEFAULT_HISTORY_LIMIT + 50);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    expect(msgs).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect(msgs[0]?.content).toBe(`msg-51`);
    expect(msgs[msgs.length - 1]?.content).toBe(`msg-${DEFAULT_HISTORY_LIMIT + 50}`);
    // Order preserved across the kept window.
    for (let i = 0; i < msgs.length; i++) {
      expect(msgs[i]?.content).toBe(`msg-${51 + i}`);
    }
    // Warning names how many were dropped.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('dropped 50');
    store.close();
  });

  it('does not truncate or warn when history fits the limit', async () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seed(store, sid, 10);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    expect(msgs).toHaveLength(10);
    expect(warn).not.toHaveBeenCalled();
    store.close();
  });

  it('historyLimit is configurable via constructor', async () => {
    const store = new SessionStore(':memory:', { historyLimit: 10 });
    const sid = store.createSession('bot-1');
    seed(store, sid, 25);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    expect(msgs).toHaveLength(10);
    expect(msgs[0]?.content).toBe('msg-16');
    expect(msgs[9]?.content).toBe('msg-25');
    store.close();
  });

  it('SESSION_HISTORY_LIMIT env var configures the cap', async () => {
    process.env[ENV_KEY] = '25';
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seed(store, sid, 40);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    expect(msgs).toHaveLength(25);
    expect(msgs[0]?.content).toBe('msg-16');
    store.close();
  });

  it('constructor option beats the env var', async () => {
    process.env[ENV_KEY] = '25';
    const store = new SessionStore(':memory:', { historyLimit: 5 });
    const sid = store.createSession('bot-1');
    seed(store, sid, 40);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await store.getMessages(sid)).toHaveLength(5);
    store.close();
  });

  it('invalid limits fall back to the default', async () => {
    process.env[ENV_KEY] = 'not-a-number';
    const store = new SessionStore(':memory:', { historyLimit: -3 });
    const sid = store.createSession('bot-1');
    seed(store, sid, DEFAULT_HISTORY_LIMIT + 1);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await store.getMessages(sid)).toHaveLength(DEFAULT_HISTORY_LIMIT);
    store.close();
  });
});

describe('summarization auto-compaction', () => {
  function stubSummarizer(calls: { count: number; received: ChatMessage[][] }) {
    return async (messages: ChatMessage[]): Promise<string> => {
      calls.count += 1;
      calls.received.push(messages);
      return `SUMMARY(${messages.length} msgs: ${messages[0]?.content}..${messages[messages.length - 1]?.content})`;
    };
  }

  it('summarizes everything except the last 100 when over keep + threshold', async () => {
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const store = new SessionStore(':memory:', { summarizer: stubSummarizer(calls) });
    const sid = store.createSession('bot-1');
    seed(store, sid, 250); // 100 keep + 140 threshold = 240; 250 > 240

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    expect(calls.count).toBe(1);
    // 150 messages compacted, last 100 kept verbatim.
    expect(calls.received[0]).toHaveLength(150);
    expect(msgs).toHaveLength(101);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toContain('[compacted summary');
    expect(msgs[0]?.content).toContain('SUMMARY(150 msgs: msg-1..msg-150)');
    expect(msgs[1]?.content).toBe('msg-151');
    expect(msgs[100]?.content).toBe('msg-250');
    // Compaction replaces blind truncation: no truncation warning.
    expect(warn).not.toHaveBeenCalled();
    store.close();
  });

  it('does not compact when history fits keep + threshold', async () => {
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const store = new SessionStore(':memory:', { summarizer: stubSummarizer(calls) });
    const sid = store.createSession('bot-1');
    seed(store, sid, 200);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    expect(calls.count).toBe(0);
    // Legacy rolling window applies below the compaction trigger.
    expect(msgs).toHaveLength(100);
    expect(msgs[0]?.content).toBe('msg-101');
    store.close();
  });

  it('is idempotent: a second getMessages does not re-summarize', async () => {
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const store = new SessionStore(':memory:', { summarizer: stubSummarizer(calls) });
    const sid = store.createSession('bot-1');
    seed(store, sid, 250);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await store.getMessages(sid);
    const second = await store.getMessages(sid);

    expect(calls.count).toBe(1);
    expect(second.map((m) => m.content)).toEqual(first.map((m) => m.content));
    store.close();
  });

  it('summarizes incrementally: only newly appended messages go to the summarizer', async () => {
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const store = new SessionStore(':memory:', { summarizer: stubSummarizer(calls) });
    const sid = store.createSession('bot-1');
    seed(store, sid, 250);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.getMessages(sid);
    expect(calls.count).toBe(1);

    for (let i = 251; i <= 260; i++) {
      store.appendMessage(sid, { role: 'user', content: `msg-${i}` });
    }
    const msgs = await store.getMessages(sid);
    expect(calls.count).toBe(2);
    // Second call saw only the 10 new messages entering the compact range.
    expect(calls.received[1]).toHaveLength(10);
    expect(calls.received[1]?.[0]?.content).toBe('msg-151');
    // Summary merged old + new chunk; last 100 kept verbatim.
    expect(msgs[0]?.content).toContain('SUMMARY(150 msgs: msg-1..msg-150)');
    expect(msgs[0]?.content).toContain('SUMMARY(10 msgs: msg-151..msg-160)');
    expect(msgs).toHaveLength(101);
    expect(msgs[100]?.content).toBe('msg-260');
    store.close();
  });

  it('compactThreshold is configurable', async () => {
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const store = new SessionStore(':memory:', { summarizer: stubSummarizer(calls), compactThreshold: 10 });
    const sid = store.createSession('bot-1');
    seed(store, sid, 115); // 100 keep + 10 threshold = 110; 115 > 110

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    expect(calls.count).toBe(1);
    expect(calls.received[0]).toHaveLength(15);
    expect(msgs).toHaveLength(101);
    store.close();
  });

  it('compaction watermark survives a store reopen (db-backed)', async () => {
    const dir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(join(tmpdir(), 'agent-sessions-')),
    );
    const dbPath = join(dir, 'sessions.db');
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const first = new SessionStore(dbPath, { summarizer: stubSummarizer(calls) });
    const sid = first.createSession('bot-1');
    seed(first, sid, 250);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await first.getMessages(sid);
    expect(calls.count).toBe(1);
    first.close();

    const calls2 = { count: 0, received: [] as ChatMessage[][] };
    const second = new SessionStore(dbPath, { summarizer: stubSummarizer(calls2) });
    const msgs = await second.getMessages(sid);
    expect(calls2.count).toBe(0); // watermark reused, no re-summarization
    expect(msgs[0]?.content).toContain('SUMMARY(150 msgs: msg-1..msg-150)');
    second.close();
  });

  it('the last-100 floor never shrinks even with a smaller historyLimit', async () => {
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const store = new SessionStore(':memory:', {
      summarizer: stubSummarizer(calls),
      historyLimit: 10,
      compactThreshold: 10,
    });
    const sid = store.createSession('bot-1');
    seed(store, sid, 150);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);

    // keepN = max(10, 100) = 100; compacted = 50.
    expect(calls.received[0]).toHaveLength(50);
    expect(msgs).toHaveLength(101);
    expect(msgs[100]?.content).toBe('msg-150');
    store.close();
  });

  it('preserves tool-call metadata through compaction', async () => {
    const calls = { count: 0, received: [] as ChatMessage[][] };
    const store = new SessionStore(':memory:', { summarizer: stubSummarizer(calls) });
    const sid = store.createSession('bot-1');
    seed(store, sid, 250);
    store.appendMessage(sid, {
      role: 'assistant',
      content: 'calling',
      toolCalls: [{ id: 'c1', name: 'web_search', args: { q: 'x' } }],
    } as ChatMessage);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = await store.getMessages(sid);
    const last = msgs[msgs.length - 1] as ChatMessage & {
      toolCalls?: Array<{ id: string }>;
    };
    expect(last.toolCalls?.[0]?.id).toBe('c1');
    store.close();
  });
});

describe('session worktree links', () => {
  it('attach/get/detach round-trips', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    expect(store.getWorktree(sid)).toBeUndefined();
    store.attachWorktree(sid, '/tmp/worktrees/feat-a');
    expect(store.getWorktree(sid)).toBe('/tmp/worktrees/feat-a');
    // re-attach overwrites
    store.attachWorktree(sid, '/tmp/worktrees/feat-b');
    expect(store.getWorktree(sid)).toBe('/tmp/worktrees/feat-b');
    store.detachWorktree(sid);
    expect(store.getWorktree(sid)).toBeUndefined();
    store.close();
  });
});

describe('listSessions', () => {
  it('lists sessions with message counts, most-recently-active first', () => {
    const store = new SessionStore(':memory:');
    const a = store.createSession('bot-a');
    store.appendMessage(a, { role: 'user', content: 'one' });
    store.appendMessage(a, { role: 'assistant', content: 'two' });
    const b = store.createSession('bot-b');
    const c = store.createSession('bot-a');
    store.appendMessage(c, { role: 'user', content: 'three' });

    const all = store.listSessions();
    expect(all).toHaveLength(3);
    // c got its message after a's messages → c first, then a, then empty b
    expect(all.map((s) => s.id)).toEqual([c, a, b]);
    expect(all[0]).toMatchObject({ botId: 'bot-a', messageCount: 1 });
    expect(all[1]).toMatchObject({ botId: 'bot-a', messageCount: 2 });
    expect(all[2]).toMatchObject({ botId: 'bot-b', messageCount: 0, lastMessageTs: null });
    expect(all[0].lastMessageTs).toBeTruthy();
    store.close();
  });

  it('filters by botId and clamps the limit', () => {
    const store = new SessionStore(':memory:');
    store.createSession('bot-a');
    store.createSession('bot-b');
    store.createSession('bot-a');
    expect(store.listSessions({ botId: 'bot-a' })).toHaveLength(2);
    expect(store.listSessions({ botId: 'nope' })).toHaveLength(0);
    expect(store.listSessions({ limit: 2 })).toHaveLength(2);
    expect(store.listSessions({ limit: 0 })).toHaveLength(1);
    store.close();
  });
});
