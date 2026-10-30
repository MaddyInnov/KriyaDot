// SPDX-License-Identifier: Apache-2.0
// #95 StuckBufferEvictor: dead-viewer eviction for the frame hubs.

import { describe, expect, it } from 'vitest';
import { StuckBufferEvictor } from '../src/ws-hub-util.js';

describe('StuckBufferEvictor', () => {
  it('evicts only after the buffer stays over-cap for the whole window', () => {
    const evictor = new StuckBufferEvictor(1_000, 100);
    const dead = { bufferedAmount: 500 };
    expect(evictor.observe(dead, 0)).toBe(false); // first sighting starts the clock
    expect(evictor.observe(dead, 999)).toBe(false);
    expect(evictor.observe(dead, 1_000)).toBe(true);
  });

  it('a socket that drains below the cap resets its clock', () => {
    const evictor = new StuckBufferEvictor(1_000, 100);
    const flappy = { bufferedAmount: 500 };
    expect(evictor.observe(flappy, 0)).toBe(false);
    flappy.bufferedAmount = 10; // drained — healthy again
    expect(evictor.observe(flappy, 5_000)).toBe(false);
    flappy.bufferedAmount = 500; // over cap again: clock restarts
    expect(evictor.observe(flappy, 5_500)).toBe(false);
    expect(evictor.observe(flappy, 6_500)).toBe(true);
  });

  it('healthy and unknown sockets are never evicted', () => {
    const evictor = new StuckBufferEvictor(1_000, 100);
    const ok = { bufferedAmount: 50 };
    expect(evictor.observe(ok, 0)).toBe(false);
    expect(evictor.observe(ok, 60_000)).toBe(false);
    expect(evictor.observe(null, 0)).toBe(false);
    expect(evictor.observe(undefined, 0)).toBe(false);
  });
});
