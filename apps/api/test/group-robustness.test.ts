// SPDX-License-Identifier: Apache-2.0
// Tests for group room robustness (OpenMausBot parity):
// - group-rooms.ts: settings validation/defaults, timeouts, anti-spam,
//   holds, queue (?queue=1), member locks, failure retry
// - group-chats-routes.ts: the new robustness endpoints over HTTP
// The model layer is fully mocked; zero paid API usage.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { BotConfig } from '@mvp/agent-runtime';
import { GroupChatStore, type GroupChat } from '../src/group-chats.js';
import {
  GroupRoomManager,
  isNearDuplicate,
  normalizeText,
  parseTimeoutOverride,
  sanitizeRoomSettingsPatch,
  textSimilarity,
} from '../src/group-rooms.js';
import { createGroupChatsRouter } from '../src/group-chats-routes.js';

function bot(id: string, name: string): BotConfig {
  return {
    id,
    name,
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
  } as BotConfig;
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

/** Deferred member-turn mock: tests resolve/reject calls manually. */
function deferredMember() {
  const calls: Array<{
    bot: BotConfig;
    prompt: string;
    resolve: (v: { text: string }) => void;
    reject: (e: unknown) => void;
  }> = [];
  const runMemberTurn = (b: BotConfig, prompt: string): Promise<{ text: string }> =>
    new Promise((resolve, reject) => {
      calls.push({ bot: b, prompt, resolve, reject });
    });
  return { calls, runMemberTurn };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'group-robust-'));
  const store = new GroupChatStore(dir);
  const bots = [bot('coder', 'Coder'), bot('scout', 'Scout')];
  const group: GroupChat = store.createGroup('Team', ['coder', 'scout']);
  const audit = vi.fn();
  return { dir, store, bots, group, audit };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---- pure helpers -----------------------------------------------------------

describe('text similarity helpers', () => {
  it('normalizes text for comparison', () => {
    expect(normalizeText('  Hello,   WORLD! ')).toBe('hello world');
    expect(normalizeText('')).toBe('');
  });

  it('computes jaccard similarity', () => {
    expect(textSimilarity('hello world', 'hello world')).toBe(1);
    expect(textSimilarity('hello world', 'goodbye moon')).toBe(0);
    expect(textSimilarity('', '')).toBe(1);
    const s = textSimilarity('the quick brown fox', 'the quick brown fox jumps');
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });

  it('detects near-duplicates', () => {
    expect(isNearDuplicate('hello world', 'hello world')).toBe(true);
    expect(isNearDuplicate('Hello,  world!', 'hello world')).toBe(true);
    expect(isNearDuplicate('totally different text here', 'nothing alike at all')).toBe(false);
    expect(isNearDuplicate('', 'x')).toBe(false);
  });
});

describe('sanitizeRoomSettingsPatch', () => {
  it('accepts a valid patch', () => {
    const r = sanitizeRoomSettingsPatch({ turnTimeoutMin: 45, maxHeld: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ turnTimeoutMin: 45, maxHeld: 5 });
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(sanitizeRoomSettingsPatch({ turnTimeoutMin: 0 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ turnTimeoutMin: 1441 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ turnTimeoutMin: 1.5 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ maxHeld: 21 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ duplicateRepeatLimit: 1 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ postsPerMinute: 'fast' }).ok).toBe(false);
  });

  it('rejects empty and non-object bodies', () => {
    expect(sanitizeRoomSettingsPatch({}).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ unknownKey: 3 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch(null).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch('x').ok).toBe(false);
  });
});

describe('parseTimeoutOverride', () => {
  it('parses valid overrides', () => {
    expect(parseTimeoutOverride('45')).toBe(45);
    expect(parseTimeoutOverride(60)).toBe(60);
    expect(parseTimeoutOverride(undefined)).toBe(null);
    expect(parseTimeoutOverride(null)).toBe(null);
  });

  it('rejects invalid overrides', () => {
    expect(parseTimeoutOverride('0')).toBe('invalid');
    expect(parseTimeoutOverride('1441')).toBe('invalid');
    expect(parseTimeoutOverride('abc')).toBe('invalid');
    expect(parseTimeoutOverride(1.5)).toBe('invalid');
  });
});

// ---- settings -----------------------------------------------------------------

describe('room settings', () => {
  it('returns global defaults, persists overrides, and resets', () => {
    const { dir, store, bots, group, audit } = setup();
    try {
      const mgr = new GroupRoomManager({ store, getBots: () => bots, runMemberTurn: async () => ({ text: '(pass)' }), audit });
      expect(mgr.getSettings(group.id).turnTimeoutMin).toBe(30);
      expect(mgr.getSettings(group.id).maxHeld).toBe(20);

      const updated = mgr.updateSettings(group.id, { turnTimeoutMin: 45, maxHeld: 5 });
      expect(updated.turnTimeoutMin).toBe(45);
      expect(updated.maxHeld).toBe(5);

      const status = mgr.getStatus(group.id);
      expect(status.overrides.turnTimeoutMin).toBe(45);
      expect(status.overrides.postsPerMinute).toBe(null);

      const reset = mgr.resetSettings(group.id);
      expect(reset.turnTimeoutMin).toBe(30);
      expect(mgr.getStatus(group.id).overrides.turnTimeoutMin).toBe(null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors KRIYADOT_GROUP_TURN_TIMEOUT_MIN as the global default', () => {
    const { dir, store, bots, group, audit } = setup();
    const prev = process.env.KRIYADOT_GROUP_TURN_TIMEOUT_MIN;
    process.env.KRIYADOT_GROUP_TURN_TIMEOUT_MIN = '90';
    try {
      const mgr = new GroupRoomManager({ store, getBots: () => bots, runMemberTurn: async () => ({ text: '(pass)' }), audit });
      expect(mgr.getSettings(group.id).turnTimeoutMin).toBe(90);
    } finally {
      if (prev === undefined) delete process.env.KRIYADOT_GROUP_TURN_TIMEOUT_MIN;
      else process.env.KRIYADOT_GROUP_TURN_TIMEOUT_MIN = prev;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- member locks ---------------------------------------------------------------

describe('member locks', () => {
  it('claims exclusively per turn and releases', () => {
    const { dir, store, bots, group, audit } = setup();
    try {
      const mgr = new GroupRoomManager({ store, getBots: () => bots, runMemberTurn: async () => ({ text: '(pass)' }), audit });
      expect(mgr.claimLock(group.id, 'coder', 'turn-A')).toBe(true);
      expect(mgr.claimLock(group.id, 'coder', 'turn-B')).toBe(false); // held by another turn
      expect(mgr.claimLock(group.id, 'coder', 'turn-A')).toBe(true); // re-entrant same turn
      mgr.releaseLock(group.id, 'coder', 'turn-B'); // wrong turn: no-op
      expect(mgr.claimLock(group.id, 'coder', 'turn-B')).toBe(false);
      mgr.releaseLock(group.id, 'coder', 'turn-A');
      expect(mgr.claimLock(group.id, 'coder', 'turn-B')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds the lock while a member turn runs and releases after', async () => {
    const { dir, store, bots, group, audit } = setup();
    const mem = deferredMember();
    const mgr = new GroupRoomManager({ store, getBots: () => bots, runMemberTurn: mem.runMemberTurn, audit });
    try {
      const p = mgr.postMessage(group.id, group, 'hello');
      await ticks(10);
      expect(mem.calls.length).toBe(1);
      // coder's turn is in flight: its lock is held.
      expect(mgr.getStatus(group.id).locks.map((l) => l.botId)).toEqual(['coder']);
      mem.calls[0].resolve({ text: '(pass)' });
      await ticks(10);
      expect(mem.calls.length).toBe(2);
      // scout's turn is in flight now: its lock is held instead.
      expect(mgr.getStatus(group.id).locks.map((l) => l.botId)).toEqual(['scout']);
      mem.calls[1].resolve({ text: '(pass)' });
      const res = await p;
      expect(res.ok && !res.queued && res.result.quietRound).toBe(true);
      expect(mgr.getStatus(group.id).locks).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- turn timeouts (mocked clock) -----------------------------------------------

describe('turn timeouts', () => {
  it('aborts a hung turn, marks it timed-out, and notifies the room', async () => {
    vi.useFakeTimers();
    const { dir, store, bots, group, audit } = setup();
    // now() follows the fake clock (Date is mocked by vitest).
    const mem = deferredMember(); // never resolved -> hangs
    const mgr = new GroupRoomManager({
      store,
      getBots: () => bots,
      runMemberTurn: mem.runMemberTurn,
      audit,
      now: () => Date.now(),
    });
    try {
      mgr.updateSettings(group.id, { turnTimeoutMin: 1 });
      // The turn's first member call is registered synchronously.
      const p = mgr.postMessage(group.id, group, 'take your time');
      expect(mem.calls.length).toBe(1);

      await vi.advanceTimersByTimeAsync(61_000);
      const res = await p;
      expect(res.ok).toBe(true);
      if (!res.ok || res.queued) throw new Error('expected an immediate turn');
      expect(res.result.timedOut).toBe(true);
      expect(res.result.stoppedEarly).toBe(true);

      const messages = store.listMessages(group.id);
      const sys = messages.filter((m) => m.authorType === 'system');
      expect(sys.length).toBeGreaterThan(0);
      expect(sys[sys.length - 1].text).toMatch(/timed out after 1 min/);
      expect(audit).toHaveBeenCalledWith('group.turn_timeout', expect.anything());
      expect(mgr.getStatus(group.id).turnInFlight).toBe(false);
    } finally {
      vi.useRealTimers();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a per-message timeout override', async () => {
    vi.useFakeTimers();
    const { dir, store, bots, group, audit } = setup();
    const mem = deferredMember();
    const mgr = new GroupRoomManager({
      store,
      getBots: () => bots,
      runMemberTurn: mem.runMemberTurn,
      audit,
      now: () => Date.now(),
    });
    try {
      // Room default is 30 min; the override asks for 1 min.
      const p = mgr.postMessage(group.id, group, 'quick please', { timeoutMin: 1 });
      expect(mem.calls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(61_000);
      const res = await p;
      expect(res.ok && !res.queued && res.result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- anti-spam --------------------------------------------------------------------

describe('anti-spam breaker', () => {
  it('trips on near-identical repeats, pauses the room, and notifies', async () => {
    const { dir, store, bots, group, audit } = setup();
    // One member; phase 1 is spammy (trips the breaker), phase 2 is normal.
    const oneBot = [bots[0]];
    let spammy = true;
    let n = 0;
    const mgr = new GroupRoomManager({
      store,
      getBots: () => oneBot,
      runMemberTurn: async () =>
        spammy ? { text: 'The deploy steps are build then push' } : { text: `thoughtful reply ${++n}` },
      audit,
    });
    try {
      mgr.updateSettings(group.id, { duplicateRepeatLimit: 2 });
      const res = await mgr.postMessage(group.id, group, 'how do I deploy?');
      expect(res.ok && !res.queued).toBe(true);
      if (!res.ok || res.queued) throw new Error('expected turn');
      expect(res.result.breakerTripped).not.toBe(null);
      expect(res.result.breakerTripped!.reason).toBe('duplicate-spam');

      const status = mgr.getStatus(group.id);
      expect(status.hold).toBe('held');
      expect(status.breaker).not.toBe(null);
      expect(status.breaker!.reason).toBe('duplicate-spam');

      const sys = store.listMessages(group.id).filter((m) => m.authorType === 'system');
      expect(sys.some((m) => m.text.includes('Anti-spam breaker tripped'))).toBe(true);

      // Posting while the breaker holds the room queues the message.
      const q = await mgr.postMessage(group.id, group, 'are you there?');
      expect(q.ok && q.queued && q.position).toBe(1);

      // Release clears the breaker and drains the queue with sane replies.
      spammy = false;
      const released = await mgr.release(group.id);
      expect(released.hold).toBe('active');
      expect(released.breaker).toBe(null);
      expect(released.queueDepth).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rate-limits rapid user posts with 429', async () => {
    const { dir, store, bots, group, audit } = setup();
    const mgr = new GroupRoomManager({
      store,
      getBots: () => bots,
      runMemberTurn: async () => ({ text: '(pass)' }),
      audit,
    });
    try {
      mgr.updateSettings(group.id, { postsPerMinute: 2 });
      const r1 = await mgr.postMessage(group.id, group, 'one');
      const r2 = await mgr.postMessage(group.id, group, 'two');
      expect(r1.ok && !r1.queued).toBe(true);
      expect(r2.ok && !r2.queued).toBe(true);
      const r3 = await mgr.postMessage(group.id, group, 'three');
      expect(r3.ok).toBe(false);
      if (r3.ok) throw new Error('expected rate limit');
      expect(r3.status).toBe(429);
      expect(r3.error).toBe('rate-limited');
      expect(typeof r3.retryAfterMs).toBe('number');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces the per-member per-turn post budget', async () => {
    const { dir, store, bots, group, audit } = setup();
    const oneBot = [bots[0]];
    let n = 0;
    const mgr = new GroupRoomManager({
      store,
      getBots: () => oneBot,
      runMemberTurn: async () => ({ text: `reply number ${++n} with unique content ${Math.random()}` }),
      audit,
    });
    try {
      mgr.updateSettings(group.id, { maxPostsPerMemberPerTurn: 2, duplicateRepeatLimit: 20 });
      const res = await mgr.postMessage(group.id, group, 'talk a lot');
      expect(res.ok && !res.queued).toBe(true);
      if (!res.ok || res.queued) throw new Error('expected turn');
      // 2 allowed posts, then skips; the quiet round ends the turn.
      expect(res.result.replies.length).toBe(2);
      expect(res.result.skipped.some((s) => s.reason === 'post-budget-exceeded')).toBe(true);
      expect(res.result.breakerTripped).toBe(null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- holds + queue ------------------------------------------------------------------

describe('holds and queue', () => {
  it('hold queues messages; release drains them in order', async () => {
    const { dir, store, bots, group, audit } = setup();
    const seen: string[] = [];
    const mgr = new GroupRoomManager({
      store,
      getBots: () => [bots[0]], // single member: one recorded prompt per turn
      runMemberTurn: async (_b, prompt) => {
        const m = /The user said: (.*)/.exec(prompt);
        seen.push(m ? m[1] : '?');
        return { text: '(pass)' };
      },
      audit,
    });
    try {
      mgr.hold(group.id);
      expect(mgr.getStatus(group.id).hold).toBe('held');

      const q1 = await mgr.postMessage(group.id, group, 'first held');
      const q2 = await mgr.postMessage(group.id, group, 'second held');
      expect(q1.ok && q1.queued && q1.position).toBe(1);
      expect(q2.ok && q2.queued && q2.position).toBe(2);
      expect(seen).toEqual([]); // nothing dispatched while held

      await mgr.release(group.id);
      expect(seen).toEqual(['first held', 'second held']);
      expect(mgr.getStatus(group.id).queueDepth).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queues behind an in-flight turn with queue:true and dispatches in order', async () => {
    const { dir, store, bots, group, audit } = setup();
    const seen: string[] = [];
    const mem = deferredMember();
    const mgr = new GroupRoomManager({
      store,
      getBots: () => [bots[0]],
      runMemberTurn: async (b, prompt) => {
        const m = /The user said: (.*)/.exec(prompt);
        if (m) seen.push(m[1]);
        return mem.runMemberTurn(b, prompt);
      },
      audit,
    });
    try {
      const p1 = mgr.postMessage(group.id, group, 'first');
      await ticks(10);
      expect(mem.calls.length).toBe(1);

      const q1 = await mgr.postMessage(group.id, group, 'second', { queue: true });
      const q2 = await mgr.postMessage(group.id, group, 'third', { queue: true });
      expect(q1.ok && q1.queued && q1.position).toBe(1);
      expect(q2.ok && q2.queued && q2.position).toBe(2);
      expect(mgr.getQueue(group.id).map((q) => q.text)).toEqual(['second', 'third']);

      // Finish the in-flight turn; the queue must drain in order.
      for (let i = 0; i < 3; i++) {
        mem.calls[mem.calls.length - 1].resolve({ text: '(pass)' });
        await ticks(10);
      }
      await p1;
      // Each queued turn also needed its member call resolved; loop until drained.
      for (let i = 0; i < 20 && mgr.getStatus(group.id).queueDepth > 0; i++) {
        const last = mem.calls[mem.calls.length - 1];
        if (last) last.resolve({ text: '(pass)' });
        await ticks(10);
      }
      expect(mgr.getStatus(group.id).queueDepth).toBe(0);
      expect(seen).toEqual(['first', 'second', 'third']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects queueing past maxHeld with 429', async () => {
    const { dir, store, bots, group, audit } = setup();
    const mgr = new GroupRoomManager({
      store,
      getBots: () => bots,
      runMemberTurn: async () => ({ text: '(pass)' }),
      audit,
    });
    try {
      mgr.updateSettings(group.id, { maxHeld: 1, postsPerMinute: 600 });
      mgr.hold(group.id);
      const q1 = await mgr.postMessage(group.id, group, 'one');
      expect(q1.ok && q1.queued).toBe(true);
      const q2 = await mgr.postMessage(group.id, group, 'two');
      expect(q2.ok).toBe(false);
      if (q2.ok) throw new Error('expected queue-full');
      expect(q2.status).toBe(429);
      expect(q2.error).toBe('queue-full');
      // clearQueue works
      expect(mgr.clearQueue(group.id)).toBe(1);
      expect(mgr.getQueue(group.id)).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('halt stops the in-flight turn immediately', async () => {
    const { dir, store, bots, group, audit } = setup();
    const mem = deferredMember();
    const mgr = new GroupRoomManager({
      store,
      getBots: () => [bots[0]],
      runMemberTurn: mem.runMemberTurn,
      audit,
    });
    try {
      const p = mgr.postMessage(group.id, group, 'go');
      await ticks(10);
      expect(mem.calls.length).toBe(1);
      const status = mgr.halt(group.id);
      expect(status.hold).toBe('halted');
      mem.calls[0].resolve({ text: 'late reply' });
      const res = await p;
      expect(res.ok && !res.queued && res.result.stoppedEarly).toBe(true);
      expect(mgr.getStatus(group.id).turnInFlight).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a new message cancels the in-flight turn by default (legacy behavior)', async () => {
    const { dir, store, bots, group, audit } = setup();
    const mem = deferredMember();
    const mgr = new GroupRoomManager({
      store,
      getBots: () => [bots[0]],
      runMemberTurn: mem.runMemberTurn,
      audit,
    });
    try {
      const p1 = mgr.postMessage(group.id, group, 'first');
      await ticks(10);
      expect(mem.calls.length).toBe(1);
      const p2 = mgr.postMessage(group.id, group, 'second');
      await ticks(10);
      // The first turn's member call is still pending, but the second turn started.
      expect(mem.calls.length).toBe(2);
      expect(mem.calls[1].prompt).toMatch(/The user said: second/);
      // Settle both.
      mem.calls[0].resolve({ text: '(pass)' });
      mem.calls[1].resolve({ text: '(pass)' });
      const r1 = await p1;
      const r2 = await p2;
      expect(r1.ok && !r1.queued && r1.result.stoppedEarly).toBe(true);
      expect(r2.ok && !r2.queued).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- failure resume -------------------------------------------------------------------

describe('failure resume', () => {
  it('records a throwing member turn and retries it on demand', async () => {
    const { dir, store, bots, group, audit } = setup();
    let scoutCalls = 0;
    const mgr = new GroupRoomManager({
      store,
      getBots: () => bots,
      runMemberTurn: async (b) => {
        if (b.id === 'scout' && scoutCalls++ === 0) throw new Error('model exploded');
        return { text: `reply from ${b.id}` };
      },
      audit,
    });
    try {
      const res = await mgr.postMessage(group.id, group, 'hello all');
      expect(res.ok && !res.queued).toBe(true);
      if (!res.ok || res.queued) throw new Error('expected turn');
      // scout fails in round 1 only (first call), succeeds later — one failure recorded.
      expect(res.result.failures.length).toBe(1);
      expect(res.result.failures[0].botId).toBe('scout');
      const failureId = res.result.failures[0].failureId;
      expect(failureId).not.toBe(null);

      const failures = mgr.listFailures(group.id);
      expect(failures.length).toBe(1);
      expect(failures[0].retried).toBe(false);

      const msg = await mgr.retryFailure(group.id, failureId!);
      expect(msg.authorType).toBe('bot');
      expect(msg.authorBotId).toBe('scout');
      expect(msg.text).toBe('reply from scout');

      const after = mgr.listFailures(group.id);
      expect(after[0].retried).toBe(true);
      expect(after[0].resolvedMessageId).toBe(msg.id);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retry rejects unknown failures and missing bots', async () => {
    const { dir, store, bots, group, audit } = setup();
    const mgr = new GroupRoomManager({
      store,
      getBots: () => bots,
      runMemberTurn: async () => ({ text: 'ok' }),
      audit,
    });
    try {
      await expect(mgr.retryFailure(group.id, 'rfail_nope')).rejects.toThrow('failure-not-found');
      // Failure for a bot that no longer exists.
      const f = store.recordRoomFailure({
        groupId: group.id,
        botId: 'ghost',
        botName: 'Ghost',
        round: 1,
        prompt: 'p',
        userText: 'u',
        error: 'boom',
      });
      await expect(mgr.retryFailure(group.id, f.id)).rejects.toThrow('bot-not-found');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- HTTP surface -----------------------------------------------------------------------

describe('robustness HTTP endpoints', () => {
  let dir: string;
  let server: ReturnType<typeof import('node:http').createServer>;
  let base: string;
  let groupId: string;
  let store: GroupChatStore;

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'group-robust-http-'));
    store = new GroupChatStore(dir);
    const bots = [bot('coder', 'Coder'), bot('scout', 'Scout')];
    const app = express();
    app.use(express.json());
    app.use(
      '/api/groups',
      createGroupChatsRouter({
        dataDir: dir,
        getBots: () => bots,
        runMemberTurn: async (b) => ({ text: `hello from ${b.id}` }),
        audit: () => {},
      }),
    );
    server = app.listen(0);
    await new Promise<void>((r) => server.on('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await api('POST', '/api/groups', { name: 'HTTP Team', memberBotIds: ['coder', 'scout'] });
    groupId = created.json.group.id;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes settings CRUD', async () => {
    const get1 = await api('GET', `/api/groups/${groupId}/settings`);
    expect(get1.status).toBe(200);
    expect(get1.json.settings.turnTimeoutMin).toBe(30);

    const bad = await api('PUT', `/api/groups/${groupId}/settings`, { turnTimeoutMin: 9999 });
    expect(bad.status).toBe(400);

    const put = await api('PUT', `/api/groups/${groupId}/settings`, { turnTimeoutMin: 45, maxHeld: 5 });
    expect(put.status).toBe(200);
    expect(put.json.settings.turnTimeoutMin).toBe(45);

    const del = await api('DELETE', `/api/groups/${groupId}/settings`);
    expect(del.status).toBe(200);
    expect(del.json.settings.turnTimeoutMin).toBe(30);
  });

  it('exposes status, hold, halt, release', async () => {
    const s1 = await api('GET', `/api/groups/${groupId}/status`);
    expect(s1.json.status.hold).toBe('active');
    expect(s1.json.status.settings).toBeDefined();

    await api('POST', `/api/groups/${groupId}/hold`);
    const s2 = await api('GET', `/api/groups/${groupId}/status`);
    expect(s2.json.status.hold).toBe('held');

    await api('POST', `/api/groups/${groupId}/halt`);
    const s3 = await api('GET', `/api/groups/${groupId}/status`);
    expect(s3.json.status.hold).toBe('halted');

    await api('POST', `/api/groups/${groupId}/release`);
    const s4 = await api('GET', `/api/groups/${groupId}/status`);
    expect(s4.json.status.hold).toBe('active');
  });

  it('implements ?queue=1 (202 + position) and the queue endpoints', async () => {
    // Hold the room so posts queue deterministically.
    await api('POST', `/api/groups/${groupId}/hold`);
    const q1 = await api('POST', `/api/groups/${groupId}/messages?queue=1`, { text: 'queued one' });
    expect(q1.status).toBe(202);
    expect(q1.json.queued).toBe(true);
    expect(q1.json.position).toBe(1);

    const q2 = await api('POST', `/api/groups/${groupId}/messages`, { text: 'queued two' });
    expect(q2.json.position).toBe(2);

    const list = await api('GET', `/api/groups/${groupId}/queue`);
    expect(list.json.queue.map((q: any) => q.text)).toEqual(['queued one', 'queued two']);

    const clear = await api('DELETE', `/api/groups/${groupId}/queue`);
    expect(clear.json.cleared).toBe(2);
  });

  it('rejects an invalid timeoutMin override with 400', async () => {
    const r = await api('POST', `/api/groups/${groupId}/messages?timeoutMin=9999`, { text: 'hi' });
    expect(r.status).toBe(400);
  });

  it('returns failures and retries them', async () => {
    const f = await api('GET', `/api/groups/${groupId}/failures`);
    expect(f.status).toBe(200);
    expect(f.json.failures).toEqual([]);

    const r404 = await api('POST', `/api/groups/${groupId}/failures/rfail_nope/retry`);
    expect(r404.status).toBe(404);
  });

  it('a normal message still runs the turn inline', async () => {
    const r = await api('POST', `/api/groups/${groupId}/messages`, { text: 'hello @coder' });
    expect(r.status).toBe(200);
    expect(r.json.queued).toBe(false);
    expect(r.json.replies.length).toBeGreaterThan(0);
    expect(r.json.timedOut).toBe(false);
    expect(r.json.failures).toEqual([]);
  });
});
