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

import { createRequire } from 'node:module';
import type { DisplaySize, DragOptions, OSScreenLayer, RealOSAction, Screenshot } from './computer.js';

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
};

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
  mouseClick(x: number, y: number): Promise<void>;
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
  /** Tear the browser down. */
  close(): Promise<void>;
}

export interface PlaywrightOSLayerOptions {
  /**
   * Page factory. Defaults to a lazy Playwright Chromium launch on first
   * use (so construction is cheap and side-effect free). Tests inject a
   * fake; hosts may inject a page attached to an existing browser.
   */
  pageFactory?: () => Promise<PlaywrightPageBackend>;
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

/**
 * Default lazy page factory: launches Playwright Chromium on first use.
 * require('playwright') happens lazily, so the module loads fine without
 * the package installed.
 */
export function lazyPlaywrightPageFactory(): () => Promise<PlaywrightPageBackend> {
  let cached: PlaywrightPageBackend | null = null;
  return async () => {
    if (cached) return cached;
    let playwright: {
      chromium: {
        launch(opts: { headless: boolean }): Promise<{
          newContext(opts: { viewport: { width: number; height: number } }): Promise<{
            newPage(): Promise<{
              viewportSize(): { width: number; height: number } | null;
              goto(url: string): Promise<void>;
              screenshot(opts: { type: 'png' }): Promise<Buffer>;
              mouse: {
                click(x: number, y: number): Promise<void>;
                move(x: number, y: number): Promise<void>;
                wheel(deltaX: number, deltaY: number): Promise<void>;
                down(opts?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
                up(opts?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
              };
              keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
            }>;
          }>;
          close(): Promise<void>;
        }>;
      };
    };
    try {
      playwright = requireOptional('playwright') as typeof playwright;
    } catch (err) {
      throw new Error(
        'COMPUTER_USE_PLAYWRIGHT=1 is set but the "playwright" package is not installed. ' +
          'Install it and a browser build: npm install playwright && npx playwright install chromium. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const headless = process.env[COMPUTER_PLAYWRIGHT_HEADLESS_ENV] !== '0';
    const viewport = parsePlaywrightViewport(process.env[COMPUTER_PLAYWRIGHT_VIEWPORT_ENV]);
    const browser = await playwright.chromium.launch({ headless });
    try {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      cached = {
        viewportSize: () => page.viewportSize(),
        goto: (url) => page.goto(url),
        screenshot: async () => new Uint8Array(await page.screenshot({ type: 'png' })),
        mouseClick: (x, y) => page.mouse.click(x, y),
        mouseMove: (x, y) => page.mouse.move(x, y),
        mouseDown: (button) => page.mouse.down({ button: button ?? 'left' }),
        mouseUp: (button) => page.mouse.up({ button: button ?? 'left' }),
        mouseWheel: (x, y, deltaX, deltaY) => page.mouse.move(x, y).then(() => page.mouse.wheel(deltaX, deltaY)),
        keyboardType: (text) => page.keyboard.type(text),
        keyboardPress: (key) => page.keyboard.press(key),
        close: () => browser.close(),
      };
      return cached;
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw err;
    }
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
  private started = false;

  constructor(opts: PlaywrightOSLayerOptions = {}) {
    this.pageFactory = opts.pageFactory ?? lazyPlaywrightPageFactory();
    this.startUrl = opts.startUrl ?? process.env[COMPUTER_PLAYWRIGHT_URL_ENV];
    this.onRealAction = opts.onRealAction;
  }

  private async page(): Promise<PlaywrightPageBackend> {
    const p = await this.pageFactory();
    if (!this.started) {
      this.started = true;
      if (this.startUrl) await p.goto(this.startUrl);
    }
    return p;
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

  async click(x: number, y: number): Promise<void> {
    await (await this.page()).mouseClick(x, y);
    this.onRealAction?.('click', { x, y, at: Date.now(), backend: 'playwright' });
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
}

/** True when the Playwright browser layer is selected (for status endpoints). */
export function isPlaywrightOSLayerActive(): boolean {
  return process.env[COMPUTER_USE_PLAYWRIGHT_ENV] === '1';
}
