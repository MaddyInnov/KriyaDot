// SPDX-License-Identifier: Apache-2.0
// Per-person browser hold (§1.4): registry semantics + the check wired into
// PerBotComputerManager's per-bot layer (the tool-entry choke point).

import { describe, expect, it } from 'vitest';
import {
  BrowserHeldError,
  BrowserHoldRegistry,
  PerBotComputerManager,
  type OSScreenLayer,
} from '../src/index.js';

class RecordingLayer implements OSScreenLayer {
  readonly calls: string[] = [];
  async displaySize() {
    return { width: 800, height: 600 };
  }
  async screenshot() {
    this.calls.push('screenshot');
    return { png: new Uint8Array(), width: 800, height: 600 };
  }
  async click() {}
  async type() {}
  async key() {}
  async keyChord() {}
  async scroll() {}
  async drag() {}
  async move() {}
}

describe('BrowserHoldRegistry', () => {
  it('hold blocks with a "held by <person>" error naming the holder', () => {
    const reg = new BrowserHoldRegistry();
    reg.hold({ profileId: 'bot-a', personId: 'p1', personName: 'Ash' });
    expect(() => reg.assertNotHeld('bot-a')).toThrowError(BrowserHeldError);
    expect(() => reg.assertNotHeld('bot-a')).toThrow(/held by Ash/);
    expect(() => reg.assertNotHeld('bot-b')).not.toThrow();
  });

  it('another person cannot take or release someone else\'s hold', () => {
    const reg = new BrowserHoldRegistry();
    reg.hold({ profileId: 'bot-a', personId: 'p1' });
    expect(() => reg.hold({ profileId: 'bot-a', personId: 'p2' })).toThrow(BrowserHeldError);
    expect(() => reg.release('bot-a', { personId: 'p2' })).toThrow(BrowserHeldError);
    expect(reg.get('bot-a')?.personId).toBe('p1');
  });

  it('the holder can release; force release overrides', () => {
    const reg = new BrowserHoldRegistry();
    reg.hold({ profileId: 'bot-a', personId: 'p1' });
    expect(reg.release('bot-a', { personId: 'p1' })?.personId).toBe('p1');
    expect(reg.get('bot-a')).toBeUndefined();
    reg.hold({ profileId: 'bot-a', personId: 'p2' });
    expect(reg.release('bot-a', { force: true })?.personId).toBe('p2');
    expect(reg.release('bot-a')).toBeUndefined();
  });

  it('re-hold by the same person refreshes without duplicating', () => {
    const reg = new BrowserHoldRegistry({ clock: () => 1000 });
    reg.hold({ profileId: 'bot-a', personId: 'p1', reason: 'first' });
    const again = reg.hold({ profileId: 'bot-a', personId: 'p1', reason: 'second' });
    expect(reg.list()).toHaveLength(1);
    expect(again.heldAt).toBe(1000);
    expect(again.reason).toBe('second');
  });
});

describe('PerBotComputerManager hold check', () => {
  it('bot actions are blocked while held and resume after release', async () => {
    const holds = new BrowserHoldRegistry();
    const backend = new RecordingLayer();
    const mgr = new PerBotComputerManager({
      browserHolds: holds,
      browserProfileRoot: '/tmp/browser-hold-test-profiles',
      createBackend: () => backend,
    });
    const layer = mgr.getLayer('bot-a', { surface: 'browser' });
    await layer.screenshot();
    expect(backend.calls).toEqual(['screenshot']);

    holds.hold({ profileId: 'bot-a', personId: 'p1', personName: 'Ash' });
    await expect(layer.screenshot()).rejects.toThrow(/held by Ash/);
    expect(backend.calls).toEqual(['screenshot']); // backend never invoked

    holds.release('bot-a', { personId: 'p1' });
    await layer.screenshot();
    expect(backend.calls).toEqual(['screenshot', 'screenshot']);
  });

  it('a hold on one profile does not block another bot', async () => {
    const holds = new BrowserHoldRegistry();
    const mgr = new PerBotComputerManager({
      browserHolds: holds,
      browserProfileRoot: '/tmp/browser-hold-test-profiles',
      createBackend: () => new RecordingLayer(),
    });
    holds.hold({ profileId: 'bot-a', personId: 'p1' });
    await expect(mgr.getLayer('bot-b', { surface: 'browser' }).screenshot()).resolves.toBeDefined();
  });
});
