// SPDX-License-Identifier: Apache-2.0
// Tests for the Playwright-backed OS layer opt-in wiring.
// The real `playwright` package is never loaded: the page backend is
// always an injected fake, and browser launch is never attempted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PlaywrightOSScreenLayer,
  parsePlaywrightViewport,
  isPlaywrightOSLayerActive,
  COMPUTER_USE_PLAYWRIGHT_ENV,
} from './computer-playwright.js';
import { selectOSLayer } from './computer-real.js';
import { MockOSScreenLayer } from './computer.js';
import type { PlaywrightPageBackend } from './computer-playwright.js';

function fakePage(): PlaywrightPageBackend & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    viewportSize: () => ({ width: 1280, height: 720 }),
    async goto(url) {
      log.push(`goto:${url}`);
    },
    async screenshot() {
      log.push('screenshot');
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    async mouseClick(x, y, opts) {
      log.push(`click:${x},${y}:${opts?.button ?? 'left'}:x${opts?.clickCount ?? 1}`);
    },
    async mouseMove(x, y) {
      log.push(`move:${x},${y}`);
    },
    async mouseDown(button) {
      log.push(`down:${button ?? 'left'}`);
    },
    async mouseUp(button) {
      log.push(`up:${button ?? 'left'}`);
    },
    async mouseWheel(x, y, deltaX, deltaY) {
      log.push(`wheel:${x},${y},${deltaX},${deltaY}`);
    },
    async keyboardType(text) {
      log.push(`type:${text.length}`);
    },
    async keyboardPress(key) {
      log.push(`press:${key}`);
    },
    async keyboardChord(modifiers, key) {
      log.push(`chord:${[...modifiers, key].join('+')}`);
    },
    async close() {
      log.push('close');
    },
  };
}

const ENV = process.env as Record<string, string | undefined>;
let saved: string | undefined;

beforeEach(() => {
  saved = ENV[COMPUTER_USE_PLAYWRIGHT_ENV];
  delete ENV[COMPUTER_USE_PLAYWRIGHT_ENV];
});

afterEach(() => {
  if (saved === undefined) delete ENV[COMPUTER_USE_PLAYWRIGHT_ENV];
  else ENV[COMPUTER_USE_PLAYWRIGHT_ENV] = saved;
});

describe('parsePlaywrightViewport', () => {
  it('parses WIDTHxHEIGHT', () => {
    expect(parsePlaywrightViewport('1600x900')).toEqual({ width: 1600, height: 900 });
  });
  it('falls back to 1280x720 on missing or garbage input', () => {
    expect(parsePlaywrightViewport(undefined)).toEqual({ width: 1280, height: 720 });
    expect(parsePlaywrightViewport('')).toEqual({ width: 1280, height: 720 });
    expect(parsePlaywrightViewport('nope')).toEqual({ width: 1280, height: 720 });
    expect(parsePlaywrightViewport('0x720')).toEqual({ width: 1280, height: 720 });
  });
});

describe('PlaywrightOSScreenLayer', () => {
  it('reports the viewport as the display size', async () => {
    const layer = new PlaywrightOSScreenLayer({ pageFactory: async () => fakePage() });
    expect(await layer.displaySize()).toEqual({ width: 1280, height: 720 });
  });

  it('screenshot returns PNG bytes and viewport geometry', async () => {
    const layer = new PlaywrightOSScreenLayer({ pageFactory: async () => fakePage() });
    const shot = await layer.screenshot();
    expect(shot.png[0]).toBe(0x89);
    expect(shot.width).toBe(1280);
    expect(shot.height).toBe(720);
  });

  it('click/type/key reach the page backend and fire the audit hook', async () => {
    const fake = fakePage();
    const actions: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const layer = new PlaywrightOSScreenLayer({
      pageFactory: async () => fake,
      onRealAction: (action, detail) => actions.push({ action, detail }),
    });
    await layer.click(100, 200);
    await layer.type('hello');
    await layer.key('Enter');
    expect(fake.log).toEqual(['click:100,200:left:x1', 'type:5', 'press:Enter']);
    expect(actions.map((a) => a.action)).toEqual(['click', 'type', 'key']);
    expect(actions[0].detail.backend).toBe('playwright');
  });

  it('maps Space to the Playwright space key and rejects unmapped keys', async () => {
    const fake = fakePage();
    const layer = new PlaywrightOSScreenLayer({ pageFactory: async () => fake });
    await layer.key('Space');
    expect(fake.log).toEqual(['press: ']);
    await expect(layer.key('F13')).rejects.toThrow('no Playwright mapping');
  });

  it('navigates to the start URL once on first use', async () => {
    const fake = fakePage();
    const layer = new PlaywrightOSScreenLayer({
      pageFactory: async () => fake,
      startUrl: 'https://example.com',
    });
    await layer.screenshot();
    await layer.screenshot();
    expect(fake.log.filter((l) => l.startsWith('goto:'))).toEqual(['goto:https://example.com']);
  });

  it('construction is side-effect free (browser launches lazily)', async () => {
    let launched = false;
    const layer = new PlaywrightOSScreenLayer({
      pageFactory: async () => {
        launched = true;
        return fakePage();
      },
    });
    expect(launched).toBe(false);
    await layer.displaySize();
    expect(launched).toBe(true);
  });
});

describe('selectOSLayer with the Playwright flag', () => {
  it('returns the Playwright layer when COMPUTER_USE_PLAYWRIGHT=1', () => {
    ENV[COMPUTER_USE_PLAYWRIGHT_ENV] = '1';
    const layer = selectOSLayer();
    expect(layer).toBeInstanceOf(PlaywrightOSScreenLayer);
  });

  it('Playwright takes priority over the real foreground layer', () => {
    const savedReal = ENV['COMPUTER_USE_REAL'];
    ENV[COMPUTER_USE_PLAYWRIGHT_ENV] = '1';
    ENV['COMPUTER_USE_REAL'] = '1';
    try {
      const layer = selectOSLayer();
      expect(layer).toBeInstanceOf(PlaywrightOSScreenLayer);
    } finally {
      if (savedReal === undefined) delete ENV['COMPUTER_USE_REAL'];
      else ENV['COMPUTER_USE_REAL'] = savedReal;
    }
  });

  it('falls back to the mock when the flag is unset', () => {
    const layer = selectOSLayer();
    expect(layer).toBeInstanceOf(MockOSScreenLayer);
  });

  it('isPlaywrightOSLayerActive reflects the env flag', () => {
    expect(isPlaywrightOSLayerActive()).toBe(false);
    ENV[COMPUTER_USE_PLAYWRIGHT_ENV] = '1';
    expect(isPlaywrightOSLayerActive()).toBe(true);
  });
});
