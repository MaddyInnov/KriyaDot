// SPDX-License-Identifier: Apache-2.0
// #173 co-driving attribution on the chat queue: writerId + codrive mode
// round-trip through the store, and per-session writer listing works.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatQueueStore } from '../src/chat-queue.js';

function freshStore(): ChatQueueStore {
  return new ChatQueueStore(mkdtempSync(join(tmpdir(), 'chat-queue-codrive-')));
}

describe('ChatQueueStore co-driving (#173)', () => {
  it('round-trips writerId + codrive on queued messages', () => {
    const q = freshStore();
    q.enqueue({ sessionId: 's1', botId: 'b1', message: 'from alice', writerId: 'alice', codrive: true });
    q.enqueue({ sessionId: 's1', botId: 'b1', message: 'anonymous' });
    const first = q.nextForSession('s1');
    expect(first?.writerId).toBe('alice');
    expect(first?.codrive).toBe(true);
    q.markStarted(first!.id);
    const second = q.nextForSession('s1');
    expect(second?.writerId).toBeUndefined();
    expect(second?.codrive).toBeUndefined();
  });

  it('lists distinct co-driving writers per session', () => {
    const q = freshStore();
    q.enqueue({ sessionId: 's1', botId: 'b1', message: 'a', writerId: 'alice', codrive: true });
    q.enqueue({ sessionId: 's1', botId: 'b1', message: 'b', writerId: 'bob', codrive: true });
    q.enqueue({ sessionId: 's1', botId: 'b1', message: 'a2', writerId: 'alice', codrive: true });
    q.enqueue({ sessionId: 's2', botId: 'b1', message: 'c', writerId: 'carol', codrive: true });
    expect(q.writersForSession('s1')).toEqual(['alice', 'bob']);
    expect(q.writersForSession('s2')).toEqual(['carol']);
  });
});
