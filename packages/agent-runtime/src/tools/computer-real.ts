// SPDX-License-Identifier: Apache-2.0
// REAL OS automation layer — foreground control of the actual machine.
//
// SAFETY: this layer is NEVER selected by default. selectOSLayer() returns
// the mock unless COMPUTER_USE_REAL=1 (or COMPUTER_USE_PLAYWRIGHT=1 for the
// Playwright browser layer) is set in the environment. Even then,
// every mutating tool call (click/type/key/scroll/drag/move) still flows through governance
// (computerUsePolicyRules() → require-approval) before the handler runs —
// the approval gate is orthogonal to which OS layer is active.
//
// Native dependencies are OPTIONAL and lazy-loaded on first use, so merely
// importing this module (or enabling the env var without the packages
// installed) never crashes the process at startup. The first real action
// throws a clear install error instead.
//
// Install (on the machine whose screen you want to control):
//   npm install screenshot-desktop robotjs
// NOTE: @nut-tree/nut-js was evaluated but is no longer published on npm
// (404 as of 2026-10-09); robotjs is the fallback. robotjs needs a C++
// toolchain (node-gyp) at install time. Screenshots work with
// screenshot-desktop alone.
//
// robotjs is the cross-platform input engine: it wraps X11 (Linux),
// Cocoa/CoreGraphics (macOS), and Win32 (Windows) natively, so one backend
// covers per-OS scroll (scrollMouse), drag (mouseToggle + moveMouse), and
// move (moveMouse) without platform-specific subprocess hacks.

import { createRequire } from 'node:module';
import { MockOSScreenLayer } from './computer.js';
import type {
  ClickOptions,
  DisplaySize,
  DragOptions,
  OSScreenLayer,
  RealOSAction,
  Screenshot,
} from './computer.js';
import { formatChord, type ChordModifier } from './computer-keys.js';
import { COMPUTER_USE_PLAYWRIGHT_ENV, PlaywrightOSScreenLayer } from './computer-playwright.js';

/** Mouse button names shared by the real input backends. */
export type RealMouseButton = 'left' | 'right' | 'middle';

// Re-exported from computer.js (canonical home) so existing deep imports keep working.
export type { RealOSAction };

// ESM-safe require for optional native dependencies.
const requireOptional = createRequire(import.meta.url);

/** Minimal input backend. robotjs-shaped; injectable for tests. */
export interface RealInputBackend {
  /** Move the mouse cursor to physical pixel coordinates. */
  moveMouse(x: number, y: number): Promise<void>;
  /**
   * Click the current mouse position with the given button.
   * double=true performs a double-click.
   */
  mouseClick(button: RealMouseButton, double: boolean): Promise<void>;
  /** Hold a mouse button down at the current position. */
  mouseDown(button: RealMouseButton): Promise<void>;
  /** Release a mouse button at the current position. */
  mouseUp(button: RealMouseButton): Promise<void>;
  /**
   * Scroll at (x, y). deltaX/deltaY are wheel deltas in pixels:
   * positive deltaY scrolls down, positive deltaX scrolls right.
   */
  scrollAt(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  /** Type text via the OS keyboard. */
  typeString(text: string): Promise<void>;
  /** Press a key by our allowlist name (Enter, Tab, Escape, ...). */
  pressKey(name: string): Promise<void>;
  /**
   * Press a chord: hold each modifier down in order, tap the final key,
   * release the modifiers in reverse order.
   */
  pressKeyChord(modifiers: ChordModifier[], key: string): Promise<void>;
  screenWidth(): Promise<number>;
  screenHeight(): Promise<number>;
}



/** Minimal screenshot backend. screenshot-desktop-shaped; injectable for tests. */
export interface RealScreenshotBackend {
  /** Capture the primary display; resolves with PNG bytes. */
  capture(): Promise<Uint8Array>;
}

export interface RealOSLayerDeps {
  input?: RealInputBackend;
  screenshotBackend?: RealScreenshotBackend;
  /**
   * Audit hook: called AFTER every real input action (click/type/key/
   * scroll/drag/move). The host wires this to the governance audit
   * trail. Screenshots are read-only and not reported here (they are
   * audited as tool calls by the runtime like any other tool execution).
   */
  onRealAction?: (action: RealOSAction, detail: Record<string, unknown>) => void;
}

/** Map our COMPUTER_KEY_ALLOWLIST names to robotjs key names. */
const ROBOTJS_KEY_MAP: Record<string, string> = {
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Space: 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  PrintScreen: 'printscreen',
};

/** Map our canonical chord modifiers to robotjs modifier names. */
const ROBOTJS_MODIFIER_MAP: Record<ChordModifier, string> = {
  ctrl: 'control',
  shift: 'shift',
  alt: 'alt',
  // robotjs 'command' is Cmd on macOS and the Windows key on Windows.
  meta: 'command',
};

/** Map a canonical chord final key to its robotjs key name. */
function mapRobotJsChordKey(key: string): string {
  const mapped = ROBOTJS_KEY_MAP[key];
  if (mapped) return mapped;
  if (/^[a-z0-9]$/.test(key)) return key; // letters/digits tap as themselves
  if (/^F([1-9]|1[0-2])$/.test(key)) return key.toLowerCase(); // 'f1'..'f12'
  throw new Error(`no robotjs mapping for chord key "${key}"`);
}

/**
 * Lazy robotjs backend. require() happens on first use, not at import, so
 * the module loads fine without robotjs installed.
 */
function lazyRobotJs(): RealInputBackend {
  let robot: {
    moveMouse(x: number, y: number): void;
    mouseClick(button?: string, double?: boolean): void;
    mouseToggle(down: 'down' | 'up', button?: string): void;
    keyToggle(key: string, down: 'down' | 'up'): void;
    scrollMouse(magnitude: number, direction: 'up' | 'down' | 'left' | 'right'): void;
    typeString(text: string): void;
    keyTap(key: string): void;
    getScreenSize(): { width: number; height: number };
  };
  const load = () => {
    if (!robot) {
      try {
        robot = requireOptional('robotjs') as typeof robot;
      } catch (err) {
        throw new Error(
          'COMPUTER_USE_REAL=1 is set but the "robotjs" package is not installed. ' +
            'Install it on the machine whose screen you want to control: npm install robotjs ' +
            '(requires a C++ toolchain for node-gyp). ' +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return robot;
  };
  return {
    async moveMouse(x, y) {
      load().moveMouse(x, y);
    },
    async mouseClick(button: RealMouseButton, double: boolean) {
      load().mouseClick(button, double);
    },
    async mouseDown(button) {
      load().mouseToggle('down', button);
    },
    async mouseUp(button) {
      load().mouseToggle('up', button);
    },
    async scrollAt(x, y, deltaX, deltaY) {
      const r = load();
      r.moveMouse(x, y);
      // robotjs scrolls one axis per call: split the deltas into
      // directional scrolls (magnitude is platform-dependent; the tool
      // layer already caps deltas at ±2000px).
      if (deltaY > 0) r.scrollMouse(deltaY, 'down');
      else if (deltaY < 0) r.scrollMouse(-deltaY, 'up');
      if (deltaX > 0) r.scrollMouse(deltaX, 'right');
      else if (deltaX < 0) r.scrollMouse(-deltaX, 'left');
    },
    async typeString(text) {
      load().typeString(text);
    },
    async pressKey(name) {
      const mapped = ROBOTJS_KEY_MAP[name];
      if (!mapped) throw new Error(`no robotjs mapping for key "${name}"`);
      load().keyTap(mapped);
    },
    async pressKeyChord(modifiers: ChordModifier[], key: string) {
      const r = load();
      const mappedMods = modifiers.map((m) => ROBOTJS_MODIFIER_MAP[m]);
      const mappedKey = mapRobotJsChordKey(key);
      // Modifiers down in order, tap the key, modifiers up in reverse —
      // never leave a modifier held if the tap throws.
      for (const m of mappedMods) r.keyToggle(m, 'down');
      try {
        r.keyTap(mappedKey);
      } finally {
        for (const m of [...mappedMods].reverse()) r.keyToggle(m, 'up');
      }
    },
    async screenWidth() {
      return load().getScreenSize().width;
    },
    async screenHeight() {
      return load().getScreenSize().height;
    },
  };
}

/** Lazy screenshot-desktop backend. */
function lazyScreenshotDesktop(): RealScreenshotBackend {
  const load = (): ((opts?: { format?: string }) => Promise<Buffer>) => {
    try {
      return requireOptional('screenshot-desktop') as (opts?: { format?: string }) => Promise<Buffer>;
    } catch (err) {
      throw new Error(
        'COMPUTER_USE_REAL=1 is set but the "screenshot-desktop" package is not installed. ' +
          'Install it: npm install screenshot-desktop. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  return {
    async capture() {
      const buf = await load()({ format: 'png' });
      return new Uint8Array(buf);
    },
  };
}

/**
 * Real foreground OS layer: drives the actual visible screen/keyboard.
 * Constructing is cheap and side-effect free; native modules load lazily
 * on first action.
 */
export class RealOSScreenLayer implements OSScreenLayer {
  private readonly input: RealInputBackend;
  private readonly shots: RealScreenshotBackend;
  private readonly onRealAction?: RealOSLayerDeps['onRealAction'];

  constructor(deps: RealOSLayerDeps = {}) {
    this.input = deps.input ?? lazyRobotJs();
    this.shots = deps.screenshotBackend ?? lazyScreenshotDesktop();
    this.onRealAction = deps.onRealAction;
  }

  async displaySize(): Promise<DisplaySize> {
    const [width, height] = await Promise.all([this.input.screenWidth(), this.input.screenHeight()]);
    return { width, height };
  }

  async screenshot(): Promise<Screenshot> {
    const png = await this.shots.capture();
    const { width, height } = await this.displaySize();
    return { png, width, height };
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    const button = opts.button ?? 'left';
    const clicks = opts.clicks ?? 1;
    await this.input.moveMouse(x, y);
    await this.input.mouseClick(button, clicks === 2);
    this.onRealAction?.('click', { x, y, button, clicks, at: Date.now() });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.input.scrollAt(x, y, deltaX, deltaY);
    this.onRealAction?.('scroll', { x, y, deltaX, deltaY, at: Date.now() });
  }

  async drag(x1: number, y1: number, x2: number, y2: number, opts: DragOptions): Promise<void> {
    const steps = Math.max(1, Math.floor(opts.steps));
    await this.input.moveMouse(x1, y1);
    await this.input.mouseDown(opts.button);
    try {
      // Interpolated pointer moves make the drag smooth and give the OS
      // (and drag targets) intermediate positions to react to.
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await this.input.moveMouse(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t));
      }
    } finally {
      // Never leave the button held if a move fails mid-drag.
      await this.input.mouseUp(opts.button);
    }
    this.onRealAction?.('drag', { x1, y1, x2, y2, button: opts.button, steps, at: Date.now() });
  }

  async move(x: number, y: number): Promise<void> {
    await this.input.moveMouse(x, y);
    this.onRealAction?.('move', { x, y, at: Date.now() });
  }

  async type(text: string): Promise<void> {
    await this.input.typeString(text);
    this.onRealAction?.('type', { chars: text.length, at: Date.now() });
  }

  async key(name: string): Promise<void> {
    await this.input.pressKey(name);
    this.onRealAction?.('key', { name, at: Date.now() });
  }

  async keyChord(modifiers: ChordModifier[], key: string): Promise<void> {
    await this.input.pressKeyChord(modifiers, key);
    this.onRealAction?.('key', {
      chord: formatChord({ modifiers, key }),
      modifiers: [...modifiers],
      key,
      at: Date.now(),
    });
  }
}

/** Env var that opts into REAL foreground control. Mock is the default. */
export const COMPUTER_USE_REAL_ENV = 'COMPUTER_USE_REAL';

/**
 * Select the OS layer:
 *   1. Playwright browser layer when COMPUTER_USE_PLAYWRIGHT=1
 *      (see computer-playwright.ts — browser window as the display,
 *      pure-JS install via `npm install playwright`).
 *   2. Real foreground layer when COMPUTER_USE_REAL=1
 *      (robotjs + screenshot-desktop).
 *   3. Otherwise the safe MockOSScreenLayer.
 *
 * Even with a real layer active, every mutating tool call (click/type/key/scroll/drag/move)
 * still flows through governance (computerUsePolicyRules() →
 * require-approval) before the handler runs.
 */
export function selectOSLayer(deps: RealOSLayerDeps = {}): OSScreenLayer {
  if (process.env[COMPUTER_USE_PLAYWRIGHT_ENV] === '1') {
    return new PlaywrightOSScreenLayer({ onRealAction: deps.onRealAction });
  }
  if (process.env[COMPUTER_USE_REAL_ENV] === '1') {
    return new RealOSScreenLayer(deps);
  }
  return new MockOSScreenLayer();
}

/** True when the real foreground layer is active (for status endpoints). */
export function isRealOSLayerActive(): boolean {
  return process.env[COMPUTER_USE_REAL_ENV] === '1';
}
