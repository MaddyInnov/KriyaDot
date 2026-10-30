// SPDX-License-Identifier: Apache-2.0
// Octomind closure rows #128, #132, #133, #134, #87, #137, #34.
// Offline only: in-memory / temp-file stores and mock providers.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionStore,
  collectNativeItems,
  estimateAmortization,
  measureGrowthRate,
  DEFAULT_RETENTION_BUDGETS,
} from '../src/sessions.js';
import {
  categorizeMessage,
  isHighAttention,
  rankByAttention,
  scoreAttention,
} from '../src/attention.js';
import { openDb } from '../src/sqlite.js';
import { addCacheUsage, cacheTokensOf, emptyCacheUsage, sumCacheUsage } from '../src/usage.js';
import { cacheRatesFor, costOfUsage, priceOfModel } from '../src/pricing.js';
import {
  cacheWarmSettingsForBot,
  createCacheWarmerForBot,
} from '../src/cache-warm.js';
import type { ChatMessage, LLMProvider } from '../src/types.js';

const genericSummarizer = async (msgs: ChatMessage[]): Promise<string> =>
  `GENERIC SUMMARY of ${msgs.length}`;

function seedPlain(store: SessionStore, sid: string, n: number, size = 8, start = 1): void {
  for (let i = start; i < start + n; i++) {
    store.appendMessage(sid, { role: 'user', content: `msg-${i} ${'x'.repeat(size)}` } as ChatMessage);
  }
}

describe('#133 attention subsystem (unit)', () => {
  it('scores decisions and tool errors above plain tool noise', () => {
    const decision = scoreAttention({ role: 'user', content: 'DECISION: we will always use Postgres' });
    const noise = scoreAttention({ role: 'tool', content: 'chunk 12 output ok' });
    const error = scoreAttention({ role: 'tool', content: 'Error: connection failed with exception' });
    expect(decision.score).toBeGreaterThan(noise.score);
    expect(error.score).toBeGreaterThan(noise.score);
    expect(isHighAttention(decision)).toBe(true);
    expect(isHighAttention(noise)).toBe(false);
    expect(decision.signals).toContain('explicit-marker');
    expect(error.signals).toContain('tool-error');
  });

  it('categorizes messages for retention budgets', () => {
    expect(categorizeMessage({ role: 'user', content: 'Decision: ship it' })).toBe('decisions');
    expect(categorizeMessage({ role: 'assistant', content: 'see src/app/main.ts' })).toBe('file-content');
    expect(categorizeMessage({ role: 'tool', content: 'decision mentioned in output' })).toBe('tool-results');
    expect(categorizeMessage({ role: 'user', content: 'hello there' })).toBe('user-turns');
    expect(categorizeMessage({ role: 'assistant', content: 'hello there' })).toBe('other');
  });

  it('is deterministic and ranks by attention, recency as tie-break only', () => {
    const msgs = [
      { role: 'user', content: 'plain one' },
      { role: 'user', content: 'DECISION: the important one' },
      { role: 'user', content: 'plain two' },
    ];
    expect(scoreAttentionBatchEqual(msgs)).toBe(true);
    expect(rankByAttention(msgs)[0]).toBe(1);
  });
});

function scoreAttentionBatchEqual(msgs: { role: string; content: string }[]): boolean {
  const a = msgs.map((m, i) => scoreAttention(m, { index: i, total: msgs.length }).score);
  const b = msgs.map((m, i) => scoreAttention(m, { index: i, total: msgs.length }).score);
  return JSON.stringify(a) === JSON.stringify(b);
}

describe('#128 growth-rate-adaptive fold depth + amortization gate', () => {
  it('measures overall and recent growth rates', () => {
    const g = measureGrowthRate([100, 100, 100, 500]);
    expect(g.totalTokens).toBe(800);
    expect(g.tokensPerTurn).toBe(200);
    expect(g.recentTokensPerTurn).toBe(200);
    const recent = measureGrowthRate([...Array(20).fill(10), 1010]);
    expect(recent.recentTokensPerTurn).toBeGreaterThan(recent.tokensPerTurn);
  });

  it('amortization: tiny folds do not pay, large folds do', () => {
    expect(estimateAmortization(100).amortizes).toBe(false);
    expect(estimateAmortization(100).summarizerCost).toBeGreaterThanOrEqual(
      estimateAmortization(100).tokensSaved,
    );
    expect(estimateAmortization(10_000).amortizes).toBe(true);
  });

  it('fold depth reacts to growth rate: fast-growing sessions keep fewer verbatim', async () => {
    // Same total tokens (~20k) and same budget; only the rate differs.
    const low = new SessionStore(':memory:', {
      summarizer: genericSummarizer, adaptiveCompaction: true, contextBudgetTokens: 4_000,
    });
    const lowSid = low.createSession('b');
    seedPlain(low, lowSid, 200, 368); // ~100 tokens each
    const lowMsgs = await low.getMessages(lowSid);

    const high = new SessionStore(':memory:', {
      summarizer: genericSummarizer, adaptiveCompaction: true, contextBudgetTokens: 4_000,
    });
    const highSid = high.createSession('b');
    seedPlain(high, highSid, 40, 1968); // ~500 tokens each
    const highMsgs = await high.getMessages(highSid);

    expect(String(lowMsgs[0]?.content)).toContain('[compacted summary');
    expect(String(highMsgs[0]?.content)).toContain('[compacted summary');
    expect(highMsgs.length).toBeLessThan(lowMsgs.length);
  });

  it('amortization gate defers a tiny automatic fold; compactNow forces it', async () => {
    const store = new SessionStore(':memory:', {
      summarizer: genericSummarizer, adaptiveCompaction: true, contextBudgetTokens: 80,
    });
    const sid = store.createSession('b');
    // 20 tiny "ok" turns (~9 tokens each): the foldable chunk is ~90
    // tokens, whose summary + call overhead costs more than it saves.
    for (let i = 0; i < 20; i++) {
      store.appendMessage(sid, { role: 'user', content: 'ok' } as ChatMessage);
    }
    const msgs = await store.getMessages(sid);
    expect(String(msgs[0]?.content)).not.toContain('[compacted summary');
    expect(store.listArchives(sid)).toEqual([]);
    // Forced folds bypass the gate.
    expect(await store.compactNow(sid)).toBe(true);
    expect(store.listArchives(sid)).toHaveLength(1);
  });
});

describe('#132 + #133 retention budgets feed fold survival (end-to-end)', () => {
  function buildStore(opts: Record<string, unknown> = {}): { store: SessionStore; sid: string } {
    const store = new SessionStore(':memory:', { summarizer: genericSummarizer, ...opts });
    const sid = store.createSession('b');
    store.appendMessage(sid, {
      role: 'user',
      content: 'DECISION: we will always use Postgres for billing — decision-token-1',
    } as ChatMessage);
    for (let i = 0; i < 140; i++) {
      store.appendMessage(sid, { role: 'tool', content: `tool output chunk ${i} all ok` } as ChatMessage);
    }
    store.appendMessage(sid, {
      role: 'user',
      content: 'Please keep src/billing/invoice.ts — it defines the totals, file-token-2',
    } as ChatMessage);
    seedPlain(store, sid, 148);
    return { store, sid };
  }

  it('a decision and a file block survive a fold over newer tool noise', async () => {
    const { store, sid } = buildStore();
    const msgs = await store.getMessages(sid);
    const joined = msgs.map((m) => m.content).join('\n');
    expect(joined).toContain('[compacted summary');
    // Retained verbatim, even though the (generic) summary omits them.
    expect(joined).toContain('decision-token-1');
    expect(joined).toContain('file-token-2');
    // Tool noise from the folded range does NOT survive verbatim.
    expect(joined).not.toContain('tool output chunk 7');
  });

  it('retention quotas are configurable: a zero decision quota yields the slot to files', async () => {
    const { store, sid } = buildStore({
      maxRetainedBlocks: 1,
      retentionBudgets: {
        decisions: 0, 'file-content': 1, 'user-turns': 0, 'tool-results': 0, other: 0,
      },
    });
    const msgs = await store.getMessages(sid);
    const joined = msgs.map((m) => m.content).join('\n');
    expect(joined).toContain('file-token-2');
    expect(joined).not.toContain('decision-token-1');
  });

  it('default budgets sum to 1 and rank decisions first', () => {
    const sum = Object.values(DEFAULT_RETENTION_BUDGETS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(DEFAULT_RETENTION_BUDGETS.decisions).toBeGreaterThan(DEFAULT_RETENTION_BUDGETS['tool-results']);
  });
});

describe('#87 explicit plan state across compression', () => {
  it('plan state is carried verbatim across folds and re-injected post-fold', async () => {
    const store = new SessionStore(':memory:', { summarizer: genericSummarizer });
    const sid = store.createSession('b');
    store.setPlanState(sid, 'PLAN-TOKEN: 1) migrate db 2) ship it');
    seedPlain(store, sid, 260);
    const msgs = await store.getMessages(sid);
    expect(String(msgs[0]?.content)).toContain('[compacted summary');
    expect(msgs[1]?.content).toContain('session plan state');
    expect(msgs[1]?.content).toContain('PLAN-TOKEN: 1) migrate db 2) ship it');
    expect(store.getPlanState(sid)?.plan).toContain('PLAN-TOKEN');

    seedPlain(store, sid, 40, 8, 261);
    const again = await store.getMessages(sid);
    expect(again.some((m) => m.content.includes('PLAN-TOKEN'))).toBe(true);
    expect(store.getPlanState(sid)?.plan).toContain('PLAN-TOKEN');

    // Object plans round-trip as JSON; clearing works; duplicates keep it.
    store.setPlanState(sid, { steps: ['a', 'b'] });
    expect(store.getPlanState(sid)?.plan).toBe('{"steps":["a","b"]}');
    const dup = store.duplicateSession(sid);
    expect(dup).toBeDefined();
    expect(store.getPlanState(dup!)?.plan).toBe('{"steps":["a","b"]}');
    expect(store.clearPlanState(sid)).toBe(true);
    expect(store.getPlanState(sid)).toBeUndefined();
  });
});

describe('#134 archive hash governance', () => {
  function fileStore(): { store: SessionStore; path: string; sid: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sess-hash-'));
    const path = join(dir, 's.db');
    const store = new SessionStore(path, { summarizer: genericSummarizer });
    const sid = store.createSession('b');
    seedPlain(store, sid, 260);
    return { store, path, sid };
  }

  it('writes a sha256 hash at archive time and verifies on read', async () => {
    const { store, sid } = fileStore();
    await store.getMessages(sid);
    const [arc] = store.listArchives(sid);
    expect(arc?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.verifyArchive(arc!.id)).toEqual({ verified: true });
    const found = store.readArchive(arc!.id);
    expect(found?.integrityFailure).toBeUndefined();
    expect(found?.messages.length).toBe(160);
    store.close();
  });

  it('a tampered archive row is an integrity failure, never best-effort parsed', async () => {
    const { store, path, sid } = fileStore();
    await store.getMessages(sid);
    const [arc] = store.listArchives(sid);
    const raw = openDb(path);
    raw.prepare('UPDATE compaction_archive SET messages_json = ? WHERE id = ?')
      .run('[{"role":"user","content":"forged"}]', arc!.id);
    raw.close();
    const found = store.readArchive(arc!.id);
    expect(found?.integrityFailure).toContain('hash verification');
    expect(found?.messages).toEqual([]);
    const verdict = store.verifyArchive(arc!.id);
    expect(verdict.verified).toBe(false);
    if (!verdict.verified) {
      expect(verdict.reason).toBe('hash-mismatch');
      expect(verdict.integrityFailure).toBe(true);
    }
    store.close();
  });

  it('legacy rows without a hash read fine (verify-when-present) and backfill', async () => {
    const { store, path, sid } = fileStore();
    await store.getMessages(sid);
    const raw = openDb(path);
    raw.prepare(
      `INSERT INTO compaction_archive (id, session_id, from_id, to_id, message_count, messages_json, summary, created_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run('arc-legacy-1-2', sid, 1, 2, 1, JSON.stringify([{ role: 'user', content: 'legacy hi' }]), 'old', new Date().toISOString());
    raw.close();
    const found = store.readArchive('arc-legacy-1-2');
    expect(found?.integrityFailure).toBeUndefined();
    expect(found?.messages[0]?.content).toBe('legacy hi');
    expect(store.verifyArchive('arc-legacy-1-2')).toMatchObject({ verified: false, reason: 'no-hash' });
    expect(store.backfillArchiveHashes(sid)).toBe(1);
    expect(store.verifyArchive('arc-legacy-1-2')).toEqual({ verified: true });
    store.close();
  });
});

describe('#34 provider-native output items across resume', () => {
  it('persists and returns native items verbatim (reopen, thread list, branch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-native-'));
    const path = join(dir, 's.db');
    const native = [
      { type: 'reasoning', id: 'rs_123', summary: [{ type: 'summary_text', text: 'thinking…' }] },
      { type: 'message', id: 'msg_123', content: [{ type: 'output_text', text: 'hi' }] },
    ];
    const store = new SessionStore(path);
    const sid = store.createSession('b');
    store.appendMessage(sid, { role: 'user', content: 'q' } as ChatMessage);
    store.appendMessage(sid, { role: 'assistant', content: 'hi', nativeItems: native } as ChatMessage);
    store.close();

    // Reopen = resume: a fresh store over the same file sees them intact.
    const reopened = new SessionStore(path);
    const msgs = await reopened.getMessages(sid);
    const assistant = msgs.find((m) => m.role === 'assistant') as ChatMessage & { nativeItems?: unknown[] };
    expect(assistant?.nativeItems).toEqual(native);
    expect(collectNativeItems(msgs)).toEqual(native);

    const thread = reopened.listThreadMessages(sid);
    expect(thread.find((m) => m.role === 'assistant')?.nativeItems).toEqual(native);

    const branched = reopened.branchSession(sid, thread[thread.length - 1]!.id);
    expect(branched.ok).toBe(true);
    if (branched.ok) {
      const copied = reopened.listThreadMessages(branched.session.id);
      expect(copied.find((m) => m.role === 'assistant')?.nativeItems).toEqual(native);
    }
    reopened.close();
  });
});

describe('#137 cache-token accounting + pricing', () => {
  it('aggregates cache buckets through usage helpers', () => {
    const a = { promptTokens: 100, completionTokens: 10, totalTokens: 110, cacheReadTokens: 40, cacheWriteTokens: 5 };
    const b = { promptTokens: 50, completionTokens: 5, totalTokens: 55 };
    expect(addCacheUsage(a, b)).toEqual({
      promptTokens: 150, completionTokens: 15, totalTokens: 165, cacheReadTokens: 40, cacheWriteTokens: 5,
    });
    expect(sumCacheUsage([a, b]).cacheReadTokens).toBe(40);
    expect(cacheTokensOf(b)).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(emptyCacheUsage().cacheWriteTokens).toBe(0);
  });

  it('prices cache reads/writes at catalog cache rates (Anthropic)', () => {
    const c = costOfUsage('anthropic', 'claude-3-5-sonnet-latest', {
      promptTokens: 1_000_000, completionTokens: 0, totalTokens: 3_000_000,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    });
    expect(c.input).toBeCloseTo(3.0, 10);
    expect(c.cacheRead).toBeCloseTo(0.3, 10);
    expect(c.cacheWrite).toBeCloseTo(3.75, 10);
    expect(c.total).toBeCloseTo(7.05, 10);
  });

  it('defaults cache rates to the base input rate when the catalog has none', () => {
    const price = priceOfModel('groq', 'gpt-oss-20b');
    expect(price).toBeDefined();
    expect(cacheRatesFor(price!)).toEqual({ cacheReadPer1M: 0.1, cacheWritePer1M: 0.1 });
    const c = costOfUsage('groq', 'gpt-oss-20b', {
      promptTokens: 0, completionTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 1_000_000,
    });
    expect(c.cacheRead).toBeCloseTo(0.1, 10);
    // Cache-free usage keeps the pre-#137 cost shape exactly.
    expect(costOfUsage('opencode-zen', 'big-pickle', {
      promptTokens: 10, completionTokens: 10, totalTokens: 20,
    })).toEqual({ input: 0, output: 0, total: 0, estimated: false });
  });
});

describe('#137 CacheWarmer factory', () => {
  const fakeProvider = (counter: { calls: number }): LLMProvider => ({
    providerId: 'anthropic',
    async chat() {
      counter.calls += 1;
      return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    async listModels() { return []; },
  });

  it('returns null when the bot has not opted in or the provider cannot cache', () => {
    const counter = { calls: 0 };
    const base = { provider: 'anthropic', model: 'm', systemPrompt: 'sys' };
    expect(createCacheWarmerForBot(base, { provider: fakeProvider(counter) })).toBeNull();
    expect(createCacheWarmerForBot({ ...base, cacheWarm: false }, { provider: fakeProvider(counter) })).toBeNull();
    expect(createCacheWarmerForBot(
      { provider: 'openai', model: 'm', systemPrompt: 'sys', cacheWarm: true },
      { provider: fakeProvider(counter) },
    )).toBeNull();
  });

  it('builds a working warmer from cacheWarm: true and from { intervalMs }', async () => {
    const counter = { calls: 0 };
    const warmer = createCacheWarmerForBot(
      { provider: 'anthropic', model: 'm', systemPrompt: 'sys', cacheWarm: true },
      { provider: () => fakeProvider(counter) },
    );
    expect(warmer).not.toBeNull();
    expect(await warmer!.tick(Date.now())).toBe(true);
    expect(counter.calls).toBe(1);
    warmer!.stop();

    expect(cacheWarmSettingsForBot({
      provider: 'anthropic', model: 'm', systemPrompt: 'sys', cacheWarm: { intervalMs: 120_000 },
    })?.intervalMinutes).toBe(2);
    expect(cacheWarmSettingsForBot({
      provider: 'anthropic', model: 'm', systemPrompt: 'sys', cacheWarm: true,
    })?.intervalMinutes).toBe(5);
  });
});
