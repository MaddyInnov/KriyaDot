// SPDX-License-Identifier: Apache-2.0
// Tests for the real foreground OS layer opt-in wiring.
// Native modules are never loaded: all backends are injected fakes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RealOSScreenLayer,
  selectOSLayer,
  isRealOSLayerActive,
  COMPUTER_USE_REAL_ENV,
} from './computer-real.js';
import { MockOSScreenLayer } from './computer.js';
import type { RealInputBackend, RealMouseButton, RealScreenshotBackend } from './computer-real.js';

function fakeInput(): RealInputBackend & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async moveMouse(x, y) {
      log.push(`move:${x},${y}`);
    },
    async mouseClick(button: RealMouseButton, double: boolean) {
      log.push(`click:${button}${double ? ':double' : ''}`);
    },
    async mouseDown(button) {
      log.push(`down:${button}`);
    },
    async mouseUp(button) {
      log.push(`up:${button}`);
    },
    async scrollAt(x, y, deltaX, deltaY) {
      log.push(`scroll:${x},${y},${deltaX},${deltaY}`);
    },
    async typeString(text) {
      log.push(`type:${text.length}`);
    },
    async pressKey(name) {
      log.push(`key:${name}`);
    },
    async pressKeyChord(modifiers, key) {
      log.push(`chord:${[...modifiers, key].join('+')}`);
    },
    async screenWidth() {
      return 1920;
    },
    async screenHeight() {
      return 1080;
    },
  };
}

function fakeScreenshots(): RealScreenshotBackend {
  return {
    async capture() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
  };
}

const ENV = process.env as Record<string, string | undefined>;
let saved: string | undefined;

beforeEach(() => {
  saved = ENV[COMPUTER_USE_REAL_ENV];
});

afterEach(() => {
  if (saved === undefined) delete ENV[COMPUTER_USE_REAL_ENV];
  else ENV[COMPUTER_USE_REAL_ENV] = saved;
});

describe('selectOSLayer', () => {
  it('returns the mock by default (fail-safe)', () => {
    delete ENV[COMPUTER_USE_REAL_ENV];
    expect(selectOSLayer()).toBeInstanceOf(MockOSScreenLayer);
    expect(isRealOSLayerActive()).toBe(false);
  });

  it('returns the mock for any value other than "1"', () => {
    ENV[COMPUTER_USE_REAL_ENV] = 'true';
    expect(selectOSLayer()).toBeInstanceOf(MockOSScreenLayer);
    ENV[COMPUTER_USE_REAL_ENV] = '0';
    expect(selectOSLayer()).toBeInstanceOf(MockOSScreenLayer);
  });

  it('returns the real layer when COMPUTER_USE_REAL=1', () => {
    ENV[COMPUTER_USE_REAL_ENV] = '1';
    const layer = selectOSLayer({ input: fakeInput(), screenshotBackend: fakeScreenshots() });
    expect(layer).toBeInstanceOf(RealOSScreenLayer);
    expect(isRealOSLayerActive()).toBe(true);
  });
});

describe('RealOSScreenLayer', () => {
  it('drives the injected input backend and reports real actions', async () => {
    const input = fakeInput();
    const seen: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const layer = new RealOSScreenLayer({
      input,
      screenshotBackend: fakeScreenshots(),
      onRealAction: (action, detail) => seen.push({ action, detail }),
    });

    expect(await layer.displaySize()).toEqual({ width: 1920, height: 1080 });

    const shot = await layer.screenshot();
    expect(shot.png[0]).toBe(0x89);
    expect(shot.width).toBe(1920);

    await layer.click(100, 200);
    expect(input.log).toEqual(['move:100,200', 'click:left']);

    await layer.click(300, 400, { button: 'right', clicks: 2 });
    expect(input.log).toContain('click:right:double');

    await layer.type('hello');
    expect(input.log).toContain('type:5');

    await layer.key('Enter');
    expect(input.log).toContain('key:Enter');

    await layer.keyChord(['ctrl', 'shift'], 's');
    expect(input.log).toContain('chord:ctrl+shift+s');

    // Every mutating action is reported exactly once via the audit hook.
    expect(seen.map((s) => s.action)).toEqual(['click', 'click', 'type', 'key', 'key']);
    expect(seen[0].detail).toMatchObject({ x: 100, y: 200, button: 'left', clicks: 1 });
    expect(seen[1].detail).toMatchObject({ button: 'right', clicks: 2 });
    expect(seen[4].detail).toMatchObject({ chord: 'ctrl+shift+s' });
  });

  it('throws a clear install error when native deps are missing', async () => {
    ENV[COMPUTER_USE_REAL_ENV] = '1';
    const layer = new RealOSScreenLayer(); // no injected backends → lazy require
    await expect(layer.screenshot()).rejects.toThrow(/screenshot-desktop.*not installed/);
    await expect(layer.click(1, 1)).rejects.toThrow(/robotjs.*not installed/);
  });
});
