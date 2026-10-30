// SPDX-License-Identifier: Apache-2.0
// #173 multi-writer co-driving on one live session (SessionCoDrive).

import { describe, expect, it } from 'vitest';
import { SessionCoDrive } from '../src/turn-scheduler.js';

describe('SessionCoDrive (#173)', () => {
  it('tracks multiple writers joined to one session', () => {
    const cd = new SessionCoDrive();
    cd.join('s1', 'alice');
    cd.join('s1', 'bob');
    cd.join('s2', 'carol');
    expect(cd.writersOf('s1')).toEqual(['alice', 'bob']);
    expect(cd.writersOf('s2')).toEqual(['carol']);
    expect(cd.leave('s1', 'alice')).toEqual(['bob']);
  });

  it('grants the write lease to exactly one writer at a time, FIFO', async () => {
    const cd = new SessionCoDrive();
    const releaseAlice = await cd.acquireWrite('s1', 'alice');
    expect(cd.activeWriter('s1')).toBe('alice');

    let bobGranted = false;
    const bobPromise = cd.acquireWrite('s1', 'bob').then((release) => {
      bobGranted = true;
      return release;
    });
    expect(cd.queuedWriters('s1')).toEqual(['bob']);
    await Promise.resolve();
    expect(bobGranted).toBe(false);

    releaseAlice();
    const releaseBob = await bobPromise;
    expect(bobGranted).toBe(true);
    expect(cd.activeWriter('s1')).toBe('bob');
    releaseBob();
    expect(cd.activeWriter('s1')).toBeUndefined();
  });

  it('the holder re-acquiring is re-entrant (no self-deadlock)', async () => {
    const cd = new SessionCoDrive();
    const first = await cd.acquireWrite('s1', 'alice');
    const second = await cd.acquireWrite('s1', 'alice');
    expect(cd.activeWriter('s1')).toBe('alice');
    second();
    first();
    expect(cd.activeWriter('s1')).toBeUndefined();
  });

  it('a holder leaving passes the lease to the next waiter', async () => {
    const cd = new SessionCoDrive();
    await cd.acquireWrite('s1', 'alice');
    const bobPromise = cd.acquireWrite('s1', 'bob');
    cd.leave('s1', 'alice');
    const releaseBob = await bobPromise;
    expect(cd.activeWriter('s1')).toBe('bob');
    releaseBob();
  });

  it('sessions are independent: a lease on one never blocks another', async () => {
    const cd = new SessionCoDrive();
    await cd.acquireWrite('s1', 'alice');
    const release = await cd.acquireWrite('s2', 'alice');
    expect(cd.activeWriter('s2')).toBe('alice');
    release();
  });
});
