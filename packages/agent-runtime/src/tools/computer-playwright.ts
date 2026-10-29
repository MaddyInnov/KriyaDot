// SPDX-License-Identifier: Apache-2.0
// Playwright-backed OS layer — the browser window is the "display".
//
// This is the open-dots-style computer runtime option: instead of driving
// the physical desktop (robotjs + screenshot-desktop, see computer-real.ts),
// the agent drives a REAL Chromium browser launched by Playwright. This is
// valuable where the robotjs route is impractical: Playwright is pure
// JavaScript (no C++ toolchain / node-gyp like robotjs) and it bundles its
// own browser, so `npm install playwright && npx playwright install
// chromium` is the whole install story. It is also the natural fit for
// browser-automation tasks (the agent's "computer" IS the browser).
//
// SAFETY: this layer is NEVER selected by default. selectOSLayer() returns
// it only when COMPUTER_USE_PLAYWRIGHT=1 is set in the environment. Like
// the real foreground layer, every mutating tool call (click/type/key/scroll/drag/move)
// still flows through governance (computerUsePolicyRules() →
// require-approval) before the handler runs — the approval gate is
// orthogonal to which OS layer is active.
//
// The `playwright` package is OPTIONAL and lazy-loaded on first use, so
// merely importing this module (or enabling the env var without the package
// installed) never crashes the process at startup. The first real action
// throws a clear install error instead.
//
// Install (on the machine running the API server):
//   npm install playwright
//   npx playwright install chromium        # downloads the browser build
//
// Env:
//   COMPUTER_USE_PLAYWRIGHT=1      — opt in to this layer
//   COMPUTER_PLAYWRIGHT_VIEWPORT   — "WIDTHxHEIGHT", default "1280x720"
//   COMPUTER_PLAYWRIGHT_URL        — optional page to open at startup
//   COMPUTER_PLAYWRIGHT_HEADLESS   — "1" (default) or "0" (visible window)
//
// W4: when the host supplies a per-bot `profileDir` (PerBotComputerManager
// does, keyed by bot id), the layer launches a PERSISTENT context
// (chromium.launchPersistentContext) bound to that directory, so a bot's
// cookies/localStorage/logins survive browser restarts, API restarts and
// idle teardown. Without a profileDir the launch stays ephemeral.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import type {
  ClickOptions,
  DisplaySize,
  DragOptions,
  OSScreenLayer,
  RealOSAction,
  Screenshot,
} from './computer.js';
import { formatChord, type ChordModifier } from './computer-keys.js';

// ESM-safe require for the optional playwright dependency.
const requireOptional = createRequire(import.meta.url);

/** Env var that opts into the Playwright browser layer. Mock is the default. */
export const COMPUTER_USE_PLAYWRIGHT_ENV = 'COMPUTER_USE_PLAYWRIGHT';
export const COMPUTER_PLAYWRIGHT_VIEWPORT_ENV = 'COMPUTER_PLAYWRIGHT_VIEWPORT';
export const COMPUTER_PLAYWRIGHT_URL_ENV = 'COMPUTER_PLAYWRIGHT_URL';
export const COMPUTER_PLAYWRIGHT_HEADLESS_ENV = 'COMPUTER_PLAYWRIGHT_HEADLESS';

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/** Map our COMPUTER_KEY_ALLOWLIST names to Playwright keyboard key names. */
const PLAYWRIGHT_KEY_MAP: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Space: ' ',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
};

/** Map our canonical chord modifiers to Playwright keyboard key names. */
const PLAYWRIGHT_MODIFIER_MAP: Record<ChordModifier, string> = {
  ctrl: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
};

/** Map a canonical chord final key to its Playwright keyboard key name. */
function mapPlaywrightChordKey(key: string): string {
  const mapped = PLAYWRIGHT_KEY_MAP[key];
  if (mapped) return mapped;
  if (/^[a-z0-9]$/.test(key)) return key; // letters/digits press as themselves
  if (/^F([1-9]|1[0-2])$/.test(key)) return key; // 'F1'..'F12'
  throw new Error(`no Playwright mapping for chord key "${key}"`);
}

/**
 * Minimal page-shaped backend. Playwright-Page-shaped; injectable so tests
 * never need the real `playwright` package or a browser.
 */
export interface PlaywrightPageBackend {
  /** Current viewport, or null if unknown. */
  viewportSize(): { width: number; height: number } | null;
  /** Navigate the page. */
  goto(url: string): Promise<void>;
  /** Capture the page as PNG bytes. */
  screenshot(): Promise<Uint8Array>;
  /** Click at viewport (CSS-pixel) coordinates. */
  mouseClick(
    x: number,
    y: number,
    opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number },
  ): Promise<void>;
  /** Move the mouse to viewport coordinates (no click). */
  mouseMove(x: number, y: number): Promise<void>;
  /** Hold a mouse button down at the current position. */
  mouseDown(button?: 'left' | 'right' | 'middle'): Promise<void>;
  /** Release a mouse button at the current position. */
  mouseUp(button?: 'left' | 'right' | 'middle'): Promise<void>;
  /** Dispatch a wheel event at (x, y); positive deltaY scrolls down. */
  mouseWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  /** Type text into the focused element. */
  keyboardType(text: string): Promise<void>;
  /** Press a key by Playwright key name. */
  keyboardPress(key: string): Promise<void>;
  /**
   * Press a chord: hold each modifier down in order, press the final key,
   * release the modifiers in reverse order.
   */
  keyboardChord(modifiers: ChordModifier[], key: string): Promise<void>;
  /** Tear the browser down. */
  close(): Promise<void>;
}

/** Raw Playwright page shape the backend wrapper consumes (structural). */
export interface PlaywrightRawPage {
  viewportSize(): { width: number; height: number } | null;
  goto(url: string): Promise<void>;
  screenshot(opts: { type: 'png' }): Promise<Buffer>;
  mouse: {
    click(
      x: number,
      y: number,
      opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number },
    ): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
    down(opts?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
    up(opts?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
}

/** Raw Playwright browser-context shape (ephemeral or persistent). */
export interface PlaywrightRawContext {
  newPage(): Promise<PlaywrightRawPage>;
  close(): Promise<void>;
}

/** Raw Playwright browser shape. */
export interface PlaywrightRawBrowser {
  newContext(opts: { viewport: { width: number; height: number } }): Promise<PlaywrightRawContext>;
  close(): Promise<void>;
}

/**
 * The slice of Playwright's `chromium` launcher this module uses.
 * `launchPersistentContext` is the W4 persistence path: the returned
 * context is bound to a per-bot user-data directory on disk, so cookies,
 * localStorage and logins survive context/browser/process restarts.
 * Tests inject a file-backed fake implementing this shape — the real
 * `playwright` package is never loaded in tests.
 */
export interface PlaywrightChromiumLike {
  launch(opts: { headless: boolean }): Promise<PlaywrightRawBrowser>;
  launchPersistentContext(
    userDataDir: string,
    opts: { headless: boolean; viewport: { width: number; height: number } },
  ): Promise<PlaywrightRawContext>;
}

export interface PlaywrightOSLayerOptions {
  /**
   * Page factory. Defaults to a lazy Playwright Chromium launch on first
   * use (so construction is cheap and side-effect free). Tests inject a
   * fake; hosts may inject a page attached to an existing browser.
   * When set, it wins over `profileDir`/`chromium`.
   */
  pageFactory?: () => Promise<PlaywrightPageBackend>;
  /**
   * W4: persistent browser profile directory (per bot). When set (and no
   * pageFactory is injected), the browser launches via
   * `launchPersistentContext(profileDir)` so cookies/localStorage/logins
   * persist across restarts. Closing the layer closes the context but
   * KEEPS this directory — only an explicit profile wipe deletes it.
   */
  profileDir?: string;
  /**
   * Chromium launcher override (tests inject a fake). Defaults to the
   * lazily-required real `playwright` package's chromium.
   */
  chromium?: PlaywrightChromiumLike;
  /**
   * Page to open once at startup. Defaults to COMPUTER_PLAYWRIGHT_URL.
   * Skipped when the injected pageFactory is used without wanting it —
   * no: the URL is honoured for injected factories too, on first use.
   */
  startUrl?: string;
  /**
   * Audit hook: called AFTER every mutating action (click/type/key/scroll/drag/move).
   * The host wires this to the governance audit trail. Screenshots are
   * read-only and audited as tool calls by the runtime like any other
   * tool execution.
   */
  onRealAction?: (action: RealOSAction, detail: Record<string, unknown>) => void;
}

/** Parse "WIDTHxHEIGHT"; falls back to 1280×720 on garbage. */
export function parsePlaywrightViewport(raw: string | undefined): { width: number; height: number } {
  if (raw) {
    const m = /^(\d{2,5})x(\d{2,5})$/i.exec(raw.trim());
    if (m) {
      const width = Number(m[1]);
      const height = Number(m[2]);
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return { ...DEFAULT_VIEWPORT };
}

/** Load the real Playwright chromium launcher (lazy; clear error if absent). */
export function loadPlaywrightChromium(): PlaywrightChromiumLike {
  try {
    const playwright = requireOptional('playwright') as { chromium: PlaywrightChromiumLike };
    return playwright.chromium;
  } catch (err) {
    throw new Error(
      'COMPUTER_USE_PLAYWRIGHT=1 is set but the "playwright" package is not installed. ' +
        'Install it and a browser build: npm install playwright && npx playwright install chromium. ' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Wrap a raw Playwright page + a close function as a PlaywrightPageBackend. */
export function wrapPlaywrightPage(
  page: PlaywrightRawPage,
  close: () => Promise<void>,
): PlaywrightPageBackend {
  return {
    viewportSize: () => page.viewportSize(),
    goto: (url) => page.goto(url),
    screenshot: async () => new Uint8Array(await page.screenshot({ type: 'png' })),
    mouseClick: (x, y, opts) =>
      page.mouse.click(x, y, {
        button: opts?.button ?? 'left',
        clickCount: opts?.clickCount ?? 1,
      }),
    mouseMove: (x, y) => page.mouse.move(x, y),
    mouseDown: (button) => page.mouse.down({ button: button ?? 'left' }),
    mouseUp: (button) => page.mouse.up({ button: button ?? 'left' }),
    mouseWheel: (x, y, deltaX, deltaY) => page.mouse.move(x, y).then(() => page.mouse.wheel(deltaX, deltaY)),
    keyboardType: (text) => page.keyboard.type(text),
    keyboardPress: (key) => page.keyboard.press(key),
    keyboardChord: async (modifiers, key) => {
      const mappedMods = modifiers.map((m) => PLAYWRIGHT_MODIFIER_MAP[m]);
      const mappedKey = mapPlaywrightChordKey(key);
      // Explicit down/up sequencing: modifiers down in order, press
      // the key, modifiers up in reverse. Never leave one held.
      for (const m of mappedMods) await page.keyboard.down(m);
      try {
        await page.keyboard.press(mappedKey);
      } finally {
        for (const m of [...mappedMods].reverse()) await page.keyboard.up(m);
      }
    },
    close,
  };
}

function launchOpts(): { headless: boolean; viewport: { width: number; height: number } } {
  return {
    headless: process.env[COMPUTER_PLAYWRIGHT_HEADLESS_ENV] !== '0',
    viewport: parsePlaywrightViewport(process.env[COMPUTER_PLAYWRIGHT_VIEWPORT_ENV]),
  };
}

/** Ephemeral backend: launch() + newContext() — nothing survives close. */
export async function createEphemeralPageBackend(
  chromium: PlaywrightChromiumLike,
): Promise<PlaywrightPageBackend> {
  const { headless, viewport } = launchOpts();
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    return wrapPlaywrightPage(page, () => browser.close());
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

/**
 * W4 persistent backend: launchPersistentContext(profileDir). The context
 * owns its browser; closing the backend closes the CONTEXT (flushing
 * cookies/localStorage to the profile directory) and deliberately keeps
 * the directory on disk — persistence is the point. Only an explicit
 * profile wipe (PerBotComputerManager.wipeBrowserProfile) deletes it.
 */
export async function createPersistentPageBackend(
  chromium: PlaywrightChromiumLike,
  profileDir: string,
): Promise<PlaywrightPageBackend> {
  if (!profileDir) throw new Error('createPersistentPageBackend: profileDir is required');
  mkdirSync(profileDir, { recursive: true });
  const { headless, viewport } = launchOpts();
  const context = await chromium.launchPersistentContext(profileDir, { headless, viewport });
  try {
    const page = await context.newPage();
    return wrapPlaywrightPage(page, () => context.close());
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Default lazy page factory: launches Playwright Chromium on first use.
 * require('playwright') happens lazily, so the module loads fine without
 * the package installed. With `profileDir` set, every (re)launch is a
 * persistent context bound to that directory (W4 per-bot profiles);
 * without it, launches are ephemeral (pre-W4 behavior). The cached
 * backend is dropped when it is closed, so a close → reuse cycle
 * relaunches instead of handing back a dead page.
 */
export function lazyPlaywrightPageFactory(
  opts: { profileDir?: string; chromium?: PlaywrightChromiumLike } = {},
): () => Promise<PlaywrightPageBackend> {
  let cached: PlaywrightPageBackend | null = null;
  return async () => {
    if (cached) return cached;
    const chromium = opts.chromium ?? loadPlaywrightChromium();
    const backend = opts.profileDir
      ? await createPersistentPageBackend(chromium, opts.profileDir)
      : await createEphemeralPageBackend(chromium);
    const innerClose = backend.close.bind(backend);
    backend.close = async () => {
      if (cached === backend) cached = null;
      await innerClose();
    };
    cached = backend;
    return cached;
  };
}

/**
 * Playwright-backed OSScreenLayer: the browser window is the display.
 * Constructing is cheap and side-effect free; the browser launches lazily
 * on the first screenshot or input action.
 */
export class PlaywrightOSScreenLayer implements OSScreenLayer {
  private readonly pageFactory: () => Promise<PlaywrightPageBackend>;
  private readonly startUrl?: string;
  private readonly onRealAction?: PlaywrightOSLayerOptions['onRealAction'];
  /** W4: persistent profile directory for this layer, when configured. */
  readonly profileDir?: string;
  private started = false;
  private backendPromise: Promise<PlaywrightPageBackend> | null = null;
  private backend: PlaywrightPageBackend | null = null;

  constructor(opts: PlaywrightOSLayerOptions = {}) {
    this.profileDir = opts.profileDir;
    this.pageFactory =
      opts.pageFactory ??
      lazyPlaywrightPageFactory({ profileDir: opts.profileDir, chromium: opts.chromium });
    this.startUrl = opts.startUrl ?? process.env[COMPUTER_PLAYWRIGHT_URL_ENV];
    this.onRealAction = opts.onRealAction;
  }

  private async page(): Promise<PlaywrightPageBackend> {
    if (!this.backendPromise) {
      this.backendPromise = (async () => {
        const p = await this.pageFactory();
        this.backend = p;
        return p;
      })();
    }
    let p: PlaywrightPageBackend;
    try {
      p = await this.backendPromise;
    } catch (err) {
      // A failed launch must not poison the layer; the next call retries.
      this.backendPromise = null;
      throw err;
    }
    if (!this.started) {
      this.started = true;
      if (this.startUrl) await p.goto(this.startUrl);
    }
    return p;
  }

  /**
   * Close the browser/context. For a persistent profile this flushes
   * state to `profileDir` and KEEPS the directory (W4) — the next layer
   * for the same bot relaunches against the same profile. Safe to call
   * when never launched (no-op) and idempotent. The layer may be reused
   * after close: the next action relaunches.
   */
  async close(): Promise<void> {
    const pending = this.backendPromise;
    this.backendPromise = null;
    this.backend = null;
    this.started = false;
    if (!pending) return;
    const p = await pending.catch(() => null);
    if (p) await p.close().catch(() => undefined);
  }

  /** Alias for close() — PerBotComputerManager's teardown checks kill() first. */
  async kill(): Promise<void> {
    await this.close();
  }

  async displaySize(): Promise<DisplaySize> {
    const v = (await this.page()).viewportSize();
    return v ?? { ...DEFAULT_VIEWPORT };
  }

  async screenshot(): Promise<Screenshot> {
    const p = await this.page();
    const png = await p.screenshot();
    const { width, height } = await this.displaySize();
    return { png, width, height };
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    const button = opts.button ?? 'left';
    const clicks = opts.clicks ?? 1;
    await (await this.page()).mouseClick(x, y, { button, clickCount: clicks });
    this.onRealAction?.('click', { x, y, button, clicks, at: Date.now(), backend: 'playwright' });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await (await this.page()).mouseWheel(x, y, deltaX, deltaY);
    this.onRealAction?.('scroll', { x, y, deltaX, deltaY, at: Date.now(), backend: 'playwright' });
  }

  async drag(x1: number, y1: number, x2: number, y2: number, opts: DragOptions): Promise<void> {
    const p = await this.page();
    const steps = Math.max(1, Math.floor(opts.steps));
    await p.mouseMove(x1, y1);
    await p.mouseDown(opts.button);
    try {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await p.mouseMove(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t));
      }
    } finally {
      await p.mouseUp(opts.button);
    }
    this.onRealAction?.('drag', { x1, y1, x2, y2, button: opts.button, steps, at: Date.now(), backend: 'playwright' });
  }

  async move(x: number, y: number): Promise<void> {
    await (await this.page()).mouseMove(x, y);
    this.onRealAction?.('move', { x, y, at: Date.now(), backend: 'playwright' });
  }

  async type(text: string): Promise<void> {
    await (await this.page()).keyboardType(text);
    this.onRealAction?.('type', { chars: text.length, at: Date.now(), backend: 'playwright' });
  }

  async key(name: string): Promise<void> {
    const mapped = PLAYWRIGHT_KEY_MAP[name];
    if (!mapped) throw new Error(`no Playwright mapping for key "${name}"`);
    await (await this.page()).keyboardPress(mapped);
    this.onRealAction?.('key', { name, at: Date.now(), backend: 'playwright' });
  }

  async keyChord(modifiers: ChordModifier[], key: string): Promise<void> {
    await (await this.page()).keyboardChord(modifiers, key);
    this.onRealAction?.('key', {
      chord: formatChord({ modifiers, key }),
      modifiers: [...modifiers],
      key,
      at: Date.now(),
      backend: 'playwright',
    });
  }
}

/** True when the Playwright browser layer is selected (for status endpoints). */
export function isPlaywrightOSLayerActive(): boolean {
  return process.env[COMPUTER_USE_PLAYWRIGHT_ENV] === '1';
}
