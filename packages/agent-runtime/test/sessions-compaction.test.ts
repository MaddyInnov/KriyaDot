// SPDX-License-Identifier: Apache-2.0
// Adaptive compression (Octomind parity): computed fold depth,
// background folds, lossless archives + recall, compactNow.

import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';
import { createRecallTools } from '../src/tools/recall.js';
import type { ChatMessage } from '../src/types.js';

function seed(store: SessionStore, sessionId: string, n: number, size = 8): void {
  for (let i = 1; i <= n; i++) {
    store.appendMessage(sessionId, {
      role: 'user',
      content: `msg-${i} ${'x'.repeat(size)}`,
    } as ChatMessage);
  }
}

const summarizer = async (msgs: ChatMessage[]): Promise<string> =>
  `SUMMARY of ${msgs.length} messages (${String(msgs[0]?.content ?? '').slice(0, 12)}…)`; 

describe('lossless archive + recall', () => {
  it('archives folded ranges and the recall tool dereferences them', async () => {
    const store = new SessionStore(':memory:', { summarizer });
    const sid = store.createSession('bot-1');
    seed(store, sid, 260); // fixed mode: fold beyond 100 keep + 140 threshold

    const msgs = await store.getMessages(sid);
    expect(String(msgs[0]?.content)).toContain('[compacted summary');
    expect(String(msgs[0]?.content)).toContain('lossless archive');
    expect(msgs).toHaveLength(101); // header + 100 verbatim

    const archives = store.listArchives(sid);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.messageCount).toBe(160);

    const found = store.readArchive(archives[0]!.id);
    expect(found?.messages).toHaveLength(160);
    expect(String(found?.messages[0]?.content)).toContain('msg-1');

    // The recall tool returns the originals for the owning session only.
    const [tool] = createRecallTools(store);
    const ok = (await tool!.handler({ archiveId: archives[0]!.id }, {
      sessionId: sid,
      botId: 'bot-1',
    } as never)) as { messages?: string; error?: string };
    expect(ok.messages).toContain('msg-1');
    const wrongSession = (await tool!.handler({ archiveId: archives[0]!.id }, {
      sessionId: 'other-session',
      botId: 'bot-1',
    } as never)) as { error?: string };
    expect(wrongSession.error).toContain('different session');
    const missing = (await tool!.handler({ archiveId: 'arc-nope-1-2' }, {
      sessionId: sid,
      botId: 'bot-1',
    } as never)) as { error?: string };
    expect(missing.error).toContain('No compaction archive');
  });

  it('folds incrementally: second fold archives only the new range', async () => {
    const store = new SessionStore(':memory:', { summarizer });
    const sid = store.createSession('bot-1');
    seed(store, sid, 260);
    await store.getMessages(sid);
    seed(store, sid, 30); // grows past the trigger again (290 > 240)
    // appends continue numbering from seed(): contents repeat msg-1.. —
    // ids are what matter here.
    const msgs = await store.getMessages(sid);
    expect(String(msgs[0]?.content)).toContain('SUMMARY of 160');
    expect(String(msgs[0]?.content)).toContain('SUMMARY of 30');
    const archives = store.listArchives(sid);
    expect(archives).toHaveLength(2);
    expect(archives[1]!.messageCount).toBe(30);
  });
});

describe('adaptive fold depth', () => {
  it('folds by token budget: huge messages fold earlier than tiny ones', async () => {
    // Budget 2_000 tokens; each message ≈ 500 tokens (2000 chars).
    const store = new SessionStore(':memory:', {
      summarizer,
      adaptiveCompaction: true,
      contextBudgetTokens: 2_000,
    });
    const sid = store.createSession('bot-1');
    seed(store, sid, 30, 2_000);
    const msgs = await store.getMessages(sid);
    expect(String(msgs[0]?.content)).toContain('[compacted summary');
    // Tail ≈ 70% of budget ≈ 1400 tokens ≈ 3 messages of ~500, with
    // the verbatim floor of 8 → header + 8.
    expect(msgs.length).toBeLessThanOrEqual(9);
    expect(store.listArchives(sid).length).toBe(1);
  });

  it('does not fold a small session under the budget', async () => {
    const store = new SessionStore(':memory:', {
      summarizer,
      adaptiveCompaction: true,
      contextBudgetTokens: 60_000,
    });
    const sid = store.createSession('bot-1');
    seed(store, sid, 30);
    const msgs = await store.getMessages(sid);
    expect(msgs).toHaveLength(30);
    expect(store.listArchives(sid)).toEqual([]);
  });
});

describe('background folds', () => {
  it('serves the stale summary immediately and folds in the background', async () => {
    let releaseSummary: (() => void) | undefined;
    let calls = 0;
    const slowSummarizer = async (msgs: ChatMessage[]): Promise<string> => {
      calls += 1;
      if (calls === 1) return `SUMMARY of ${msgs.length} messages`;
      await new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      return `SUMMARY2 of ${msgs.length} messages`;
    };
    const store = new SessionStore(':memory:', {
      summarizer: slowSummarizer,
      backgroundCompaction: true,
    });
    const sid = store.createSession('bot-1');
    seed(store, sid, 260);
    const first = await store.getMessages(sid); // synchronous first fold
    expect(String(first[0]?.content)).toContain('SUMMARY of 160');

    seed(store, sid, 30);
    const stale = await store.getMessages(sid); // background fold starts, stale view served
    expect(String(stale[0]?.content)).toContain('SUMMARY of 160');
    expect(String(stale[0]?.content)).not.toContain('SUMMARY2');

    releaseSummary!();
    await new Promise((r) => setTimeout(r, 25)); // let the fold land
    const fresh = await store.getMessages(sid);
    expect(String(fresh[0]?.content)).toContain('SUMMARY2 of 30');
  });
});

describe('compactNow', () => {
  it('forces a fold when one is due and reports no-op otherwise', async () => {
    const store = new SessionStore(':memory:', { summarizer });
    const sid = store.createSession('bot-1');
    seed(store, sid, 10);
    expect(await store.compactNow(sid)).toBe(false);
    seed(store, sid, 250);
    expect(await store.compactNow(sid)).toBe(true);
    expect(store.listArchives(sid)).toHaveLength(1);
    // Already folded up to the watermark: no-op.
    expect(await store.compactNow(sid)).toBe(false);
  });

  it('is a no-op without a summarizer', async () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seed(store, sid, 300);
    expect(await store.compactNow(sid)).toBe(false);
  });
});
