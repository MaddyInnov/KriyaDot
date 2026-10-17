// SPDX-License-Identifier: Apache-2.0
// Tests for queue-at-boundary steering (ChatQueueStore).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatQueueError, ChatQueueStore, MAX_QUEUE_DEPTH_PER_SESSION } from '../src/chat-queue.js';

function freshStore(): ChatQueueStore {
  return new ChatQueueStore(mkdtempSync(join(tmpdir(), 'chat-queue-test-')));
}

describe('ChatQueueStore', () => {
  it('enqueues and returns 1-based position', () => {
    const q = freshStore();
    const a = q.enqueue({ sessionId: 's1', botId: 'b1', message: 'first' });
    expect(a.position).toBe(1);
    const b = q.enqueue({ sessionId: 's1', botId: 'b1', message: 'second' });
    expect(b.position).toBe(2);
    expect(a.id).not.toBe(b.id);
  });

  it('drains FIFO via nextForSession + markStarted', () => {
    const q = freshStore();
    q.enqueue({ sessionId: 's1', botId: 'b1', message: 'first' });
    q.enqueue({ sessionId: 's1', botId: 'b1', message: 'second' });
    q.enqueue({ sessionId: 's2', botId: 'b1', message: 'other-session' });

    const n1 = q.nextForSession('s1');
    expect(n1?.message).toBe('first');
    q.markStarted(n1!.id);

    const n2 = q.nextForSession('s1');
    expect(n2?.message).toBe('second');

    // Other session unaffected.
    expect(q.nextForSession('s2')?.message).toBe('other-session');
    // Started messages are no longer returned.
    q.markStarted(n2!.id);
    expect(q.nextForSession('s1')).toBeUndefined();
  });

  it('lists and removes queued messages', () => {
    const q = freshStore();
    const { id } = q.enqueue({ sessionId: 's1', botId: 'b1', message: 'hello' });
    expect(q.list('s1')).toHaveLength(1);
    expect(q.list()).toHaveLength(1);
    expect(q.remove(id)).toBe(true);
    expect(q.remove(id)).toBe(false);
    expect(q.list('s1')).toHaveLength(0);
  });

  it('persists across store instances (restart recovery)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-queue-persist-'));
    const q1 = new ChatQueueStore(dir);
    q1.enqueue({ sessionId: 's1', botId: 'b1', message: 'survives restart' });
    // Simulate restart: new store on the same dir.
    const q2 = new ChatQueueStore(dir);
    expect(q2.nextForSession('s1')?.message).toBe('survives restart');
  });

  it('resetStarted moves crashed turns back to queued', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-queue-crash-'));
    const q1 = new ChatQueueStore(dir);
    const { id } = q1.enqueue({ sessionId: 's1', botId: 'b1', message: 'crashed mid-turn' });
    const next = q1.nextForSession('s1')!;
    expect(next.id).toBe(id);
    q1.markStarted(id);
    expect(q1.nextForSession('s1')).toBeUndefined(); // stuck in started

    // Simulate restart recovery.
    const q2 = new ChatQueueStore(dir);
    q2.resetStarted();
    expect(q2.nextForSession('s1')?.message).toBe('crashed mid-turn');
  });

  it('round-trips all turn options', () => {
    const q = freshStore();
    q.enqueue({
      sessionId: 's1',
      botId: 'b1',
      message: 'full opts',
      provider: 'groq',
      model: 'llama-3.3-70b',
      taskType: 'code',
      autoApprove: true,
      planMode: true,
      maxBudgetUsd: 0.5,
      sandboxMode: 'read-only',
    });
    const n = q.nextForSession('s1')!;
    expect(n.provider).toBe('groq');
    expect(n.model).toBe('llama-3.3-70b');
    expect(n.taskType).toBe('code');
    expect(n.autoApprove).toBe(true);
    expect(n.planMode).toBe(true);
    expect(n.maxBudgetUsd).toBe(0.5);
    expect(n.sandboxMode).toBe('read-only');
  });

  it('rejects the 51st queued message per session with a 429 (L6)', () => {
    const q = freshStore();
    for (let i = 0; i < MAX_QUEUE_DEPTH_PER_SESSION; i++) {
      q.enqueue({ sessionId: 's1', botId: 'b1', message: `m${i}` });
    }
    // A different session is unaffected by s1's full queue.
    expect(() => q.enqueue({ sessionId: 's2', botId: 'b1', message: 'ok' })).not.toThrow();
    try {
      q.enqueue({ sessionId: 's1', botId: 'b1', message: 'one too many' });
      expect.unreachable('expected ChatQueueError');
    } catch (err) {
      expect(err).toBeInstanceOf(ChatQueueError);
      expect((err as ChatQueueError).statusCode).toBe(429);
    }
    // Draining one slot makes room again.
    q.markStarted(q.nextForSession('s1')!.id);
    expect(q.enqueue({ sessionId: 's1', botId: 'b1', message: 'fits now' }).position).toBe(
      MAX_QUEUE_DEPTH_PER_SESSION,
    );
  });

  it('rejects oversize messages with a 400 (L6, consistent with /chat L5)', () => {
    const q = freshStore();
    try {
      q.enqueue({ sessionId: 's1', botId: 'b1', message: 'x'.repeat(200_001) });
      expect.unreachable('expected ChatQueueError');
    } catch (err) {
      expect(err).toBeInstanceOf(ChatQueueError);
      expect((err as ChatQueueError).statusCode).toBe(400);
    }
    expect(q.enqueue({ sessionId: 's1', botId: 'b1', message: 'x'.repeat(200_000) }).position).toBe(1);
  });
});
