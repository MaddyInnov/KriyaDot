// SPDX-License-Identifier: Apache-2.0
// Sandboxed GUI-automation (computer use) tools.
//
// Tools:
//   computer_screenshot — capture the screen (read-only; auto-allowed by policy)
//   computer_click      — click at (x, y)                    [MUTATING → require-approval]
//   computer_type       — type text                          [MUTATING → require-approval]
//   computer_key        — press a named key                   [MUTATING → require-approval]
//   computer_open_app   — launch a desktop app                [MUTATING → require-approval]
//   computer_scroll     — scroll at (x, y) by direction/amount
//                         or (deltaX, deltaY)                 [MUTATING → require-approval]
//   computer_drag       — drag from (x1, y1) to (x2, y2)      [MUTATING → require-approval]
//   computer_move       — move the mouse to (x, y), no click  [MUTATING → require-approval]
//
// Trust model (never weakened):
//   - The OS layer sits behind the OSScreenLayer interface. Tests and the
//     default wiring use MockOSScreenLayer; a real OS adapter (robotjs,
//     nut.js, platform accessibility APIs) is injected by the host and
//     requires explicit OS-level permission grants (see docs/founder-setup.d/workstream-d.md).
//   - The open-app tool launches processes via node:child_process (no new
//     native deps); the launcher is injectable so tests never spawn real
//     processes, and the app name is sanitized + resolved through a fixed
//     alias map (see computer-apps.ts).
//   - Approval gating flows through the governance pattern: the runtime
//     evaluates every tool call against policy BEFORE the handler runs.
//     computerUsePolicyRules() declares explicit require-approval rules for
//     the seven mutating actions (screenshot stays allow), so gating is
//     deterministic even if the global default policy changes. Nothing here
//     bypasses governance — deny-by-default still applies to everything
//     unmatched.
//   - Input validation is defense-in-depth on top of governance: click
//     coordinates are bounds-checked against the display, typed text is
//     length-capped, keys are allowlisted, and app names are restricted to
//     a safe character set.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '../types.js';
import {
  OPEN_APP_TOOL_NAME,
  createOpenAppTool,
  type AppLauncher,
  type LaunchPlatform,
} from './computer-apps.js';

/** Display geometry in physical pixels. */
export interface DisplaySize {
  width: number;
  height: number;
}

export interface Screenshot {
  /** PNG-encoded image bytes. */
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * OS automation layer. Implementations must be sandboxed by the host
 * (dedicated VM/container or an explicit user-consent session) — this
 * interface deliberately carries no credential or session concept.
 */
export interface OSScreenLayer {
  displaySize(): Promise<DisplaySize>;
  screenshot(): Promise<Screenshot>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
  /**
   * Scroll at (x, y). deltaX/deltaY are wheel deltas in pixels:
   * positive deltaY scrolls down, positive deltaX scrolls right.
   */
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  /** Smooth drag from (x1, y1) to (x2, y2) with the given button held. */
  drag(x1: number, y1: number, x2: number, y2: number, opts: DragOptions): Promise<void>;
  /** Move the mouse cursor to (x, y) without clicking. */
  move(x: number, y: number): Promise<void>;
}

/** Options for OSScreenLayer.drag (resolved with defaults by the tool layer). */
export interface DragOptions {
  button: 'left' | 'right' | 'middle';
  /** Number of interpolated pointer moves between start and end. */
  steps: number;
}

/** Real input actions reported to host audit hooks. */
export type RealOSAction = 'click' | 'type' | 'key' | 'scroll' | 'drag' | 'move';

/**
 * 1×1 transparent PNG fixture (base64). The mock returns real PNG bytes so
 * consumers (image pipelines, the web client) can decode the shape.
 */
const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fixturePng(): Uint8Array {
  return new Uint8Array(Buffer.from(FIXTURE_PNG_BASE64, 'base64'));
}

/**
 * Mock OS layer for tests and dry runs: records every call, performs no
 * real input, and returns the fixture PNG for screenshots. Reported display
 * geometry is 1920×1080.
 */
export type MockOSAction = 'click' | 'type' | 'key' | 'screenshot' | 'scroll' | 'drag' | 'move';

export class MockOSScreenLayer implements OSScreenLayer {
  readonly calls: Array<{ action: MockOSAction; args: Record<string, unknown> }> = [];
  readonly displayWidth = 1920;
  readonly displayHeight = 1080;

  async displaySize(): Promise<DisplaySize> {
    return { width: this.displayWidth, height: this.displayHeight };
  }

  async screenshot(): Promise<Screenshot> {
    this.calls.push({ action: 'screenshot', args: {} });
    return { png: fixturePng(), width: this.displayWidth, height: this.displayHeight };
  }

  async click(x: number, y: number): Promise<void> {
    this.calls.push({ action: 'click', args: { x, y } });
  }

  async type(text: string): Promise<void> {
    this.calls.push({ action: 'type', args: { text } });
  }

  async key(name: string): Promise<void> {
    this.calls.push({ action: 'key', args: { name } });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    this.calls.push({ action: 'scroll', args: { x, y, deltaX, deltaY } });
  }

  async drag(x1: number, y1: number, x2: number, y2: number, opts: DragOptions): Promise<void> {
    this.calls.push({ action: 'drag', args: { x1, y1, x2, y2, button: opts.button, steps: opts.steps } });
  }

  async move(x: number, y: number): Promise<void> {
    this.calls.push({ action: 'move', args: { x, y } });
  }

  /** Calls of one action, in order. */
  callsOf(action: MockOSAction): Record<string, unknown>[] {
    return this.calls.filter((c) => c.action === action).map((c) => c.args);
  }
}

/** Canonical tool names for computer use. */
export const COMPUTER_TOOL_NAMES = {
  screenshot: 'computer_screenshot',
  click: 'computer_click',
  type: 'computer_type',
  key: 'computer_key',
  openApp: OPEN_APP_TOOL_NAME,
  scroll: 'computer_scroll',
  drag: 'computer_drag',
  move: 'computer_move',
} as const;

/** Mouse buttons the computer_drag tool accepts. */
export const COMPUTER_DRAG_BUTTONS: ReadonlySet<string> = new Set(['left', 'right', 'middle']);

/** Scroll directions the computer_scroll tool accepts. */
export const COMPUTER_SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);

/** Wheel pixels per "notch" when scrolling by direction+amount. */
const SCROLL_NOTCH_PX = 120;
/** Hard caps on wheel deltas (pixels) to avoid runaway scrolls. */
const MAX_SCROLL_DELTA = 2000;
/** Default scroll amount (notches) when only a direction is given. */
const DEFAULT_SCROLL_AMOUNT = 3;
/** Default/max interpolation steps for smooth drags. */
const DEFAULT_DRAG_STEPS = 20;
const MAX_DRAG_STEPS = 100;

const MAX_TYPE_CHARS = 2000;

/** Keys the computer_key tool accepts (conservative allowlist; no chord parsing in the MVP). */
export const COMPUTER_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * Explicit governance rules for computer use. The integrator merges these
 * into bot/global policy (bot rules are prepended, first match wins):
 * mutating actions → require-approval, screenshot → allow. This makes the
 * approval gate deterministic and auditable rather than relying on the
 * default-effect fallback.
 */
export function computerUsePolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'computer-use-require-approval',
      toolPattern: '^computer_(click|type|key|open_app|scroll|drag|move)$',
      effect: 'require-approval',
      reason: 'Computer-use mutating actions (click/type/key/open_app/scroll/drag/move) always need human approval',
    },
    {
      id: 'type-login-require-approval',
      toolPattern: '^type_login$',
      effect: 'require-approval',
      reason: 'type_login types saved credentials and always needs human approval',
    },
    {
      id: 'computer-use-screenshot-allow',
      toolPattern: '^computer_screenshot$',
      effect: 'allow',
      reason: 'Screenshots are read-only observation',
    },
  ];
}

function intArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`"${key}" must be a number`);
  }
  return v;
}

/**
 * Bounds-check one coordinate pair against the display. Throws (consistent
 * with the click tool) rather than clamping: silent clamping would move the
 * pointer somewhere the model did not intend.
 */
function assertInDisplay(x: number, y: number, width: number, height: number, what: string): void {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(`${what} (${x}, ${y}) is outside the ${width}×${height} display`);
  }
}

function screenshotTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.screenshot,
    description:
      'Capture a screenshot of the sandboxed display. Returns { width, height, pngBase64 }. Read-only.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args, _ctx) => {
      const shot = await os.screenshot();
      return {
        width: shot.width,
        height: shot.height,
        pngBase64: Buffer.from(shot.png).toString('base64'),
      };
    },
  };
}

function clickTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.click,
    mutating: true,
    description:
      'Click at display coordinates (x, y) in physical pixels. MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal pixel coordinate' },
        y: { type: 'number', description: 'Vertical pixel coordinate' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    handler: async (args, _ctx) => {
      const x = intArg(args, 'x');
      const y = intArg(args, 'y');
      const { width, height } = await os.displaySize();
      assertInDisplay(x, y, width, height, 'click');
      await os.click(Math.floor(x), Math.floor(y));
      return { clicked: { x: Math.floor(x), y: Math.floor(y) } };
    },
  };
}

function typeTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.type,
    mutating: true,
    description:
      'Type text into the focused element of the sandboxed display (max 2000 chars). MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (args, _ctx) => {
      const text = String(args['text'] ?? '');
      if (!text) throw new Error('"text" must be non-empty');
      if (text.length > MAX_TYPE_CHARS) {
        throw new Error(`"text" too long (${text.length} > ${MAX_TYPE_CHARS} chars)`);
      }
      await os.type(text);
      return { typedChars: text.length };
    },
  };
}

function keyTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.key,
    mutating: true,
    description:
      `Press a named key (${[...COMPUTER_KEY_ALLOWLIST].join(', ')}). MUTATING: requires human approval via governance.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Key name from the allowlist' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args, _ctx) => {
      const name = String(args['name'] ?? '');
      if (!COMPUTER_KEY_ALLOWLIST.has(name)) {
        throw new Error(`key "${name}" is not in the allowlist`);
      }
      await os.key(name);
      return { pressed: name };
    },
  };
}

export interface ComputerUseToolsOptions {
  /**
   * OS automation layer. Defaults to MockOSScreenLayer (safe: records
   * calls, performs no real input). A real adapter is injected by the host.
   */
  os?: OSScreenLayer;
  /**
   * App launcher for computer_open_app. Defaults to ChildProcessAppLauncher
   * (spawns detached via node:child_process). Inject a mock in tests.
   */
  appLauncher?: AppLauncher;
  /** Override process.platform for the open-app tool (tests). */
  platform?: LaunchPlatform;
}

/**
 * Resolve the scroll tool's two accepted arg forms to pixel wheel deltas.
 * Form 1: { direction, amount? } — amount is notches (default 3, 1..50).
 * Form 2: { deltaX?, deltaY? } — raw pixel deltas, at least one non-zero.
 * Exactly one form must be used; direction+delta mixing is rejected.
 */
function resolveScrollDeltas(args: Record<string, unknown>): { deltaX: number; deltaY: number } {
  const direction = args['direction'];
  const hasDeltaX = args['deltaX'] !== undefined;
  const hasDeltaY = args['deltaY'] !== undefined;

  if (direction !== undefined) {
    if (typeof direction !== 'string' || !COMPUTER_SCROLL_DIRECTIONS.has(direction)) {
      throw new Error(
        `"direction" must be one of ${[...COMPUTER_SCROLL_DIRECTIONS].join(', ')}`,
      );
    }
    if (hasDeltaX || hasDeltaY) {
      throw new Error('use either { direction, amount } or { deltaX, deltaY }, not both');
    }
    const rawAmount = args['amount'] ?? DEFAULT_SCROLL_AMOUNT;
    if (typeof rawAmount !== 'number' || !Number.isInteger(rawAmount) || rawAmount < 1 || rawAmount > 50) {
      throw new Error('"amount" must be an integer between 1 and 50');
    }
    const px = rawAmount * SCROLL_NOTCH_PX;
    switch (direction) {
      case 'up':
        return { deltaX: 0, deltaY: -px };
      case 'down':
        return { deltaX: 0, deltaY: px };
      case 'left':
        return { deltaX: -px, deltaY: 0 };
      default:
        return { deltaX: px, deltaY: 0 }; // right
    }
  }

  const deltaX = hasDeltaX ? intArg(args, 'deltaX') : 0;
  const deltaY = hasDeltaY ? intArg(args, 'deltaY') : 0;
  if (deltaX === 0 && deltaY === 0) {
    throw new Error('scroll needs a non-zero amount: { direction, amount } or { deltaX, deltaY }');
  }
  if (Math.abs(deltaX) > MAX_SCROLL_DELTA || Math.abs(deltaY) > MAX_SCROLL_DELTA) {
    throw new Error(`scroll deltas are capped at ±${MAX_SCROLL_DELTA} pixels`);
  }
  return { deltaX, deltaY };
}

function scrollTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.scroll,
    mutating: true,
    description:
      'Scroll the element under (x, y) — use after a screenshot to navigate lists, menus, and pages. ' +
      'Either { direction: up|down|left|right, amount? } (amount = notches, default 3) ' +
      'or { deltaX?, deltaY? } (pixel wheel deltas; positive deltaY scrolls down). ' +
      'MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal pixel coordinate of the scroll target' },
        y: { type: 'number', description: 'Vertical pixel coordinate of the scroll target' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Scroll notches (1-50, default 3); with direction only' },
        deltaX: { type: 'number', description: 'Horizontal wheel delta in pixels' },
        deltaY: { type: 'number', description: 'Vertical wheel delta in pixels (positive = down)' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    handler: async (args, _ctx) => {
      const x = intArg(args, 'x');
      const y = intArg(args, 'y');
      const { width, height } = await os.displaySize();
      assertInDisplay(x, y, width, height, 'scroll target');
      const { deltaX, deltaY } = resolveScrollDeltas(args);
      await os.scroll(Math.floor(x), Math.floor(y), deltaX, deltaY);
      return { scrolled: { x: Math.floor(x), y: Math.floor(y), deltaX, deltaY } };
    },
  };
}

function dragTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.drag,
    mutating: true,
    description:
      'Drag the mouse from (x1, y1) to (x2, y2) with a button held — for sliders, drag-and-drop, ' +
      'text selection, and window moves. button is left|right|middle (default left); ' +
      'steps is the smoothness (1-100, default 20). MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'number', description: 'Start horizontal pixel coordinate' },
        y1: { type: 'number', description: 'Start vertical pixel coordinate' },
        x2: { type: 'number', description: 'End horizontal pixel coordinate' },
        y2: { type: 'number', description: 'End vertical pixel coordinate' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        steps: { type: 'number', description: 'Interpolated pointer moves (1-100, default 20)' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    handler: async (args, _ctx) => {
      const x1 = intArg(args, 'x1');
      const y1 = intArg(args, 'y1');
      const x2 = intArg(args, 'x2');
      const y2 = intArg(args, 'y2');
      const { width, height } = await os.displaySize();
      assertInDisplay(x1, y1, width, height, 'drag start');
      assertInDisplay(x2, y2, width, height, 'drag end');
      const buttonRaw = args['button'] ?? 'left';
      if (typeof buttonRaw !== 'string' || !COMPUTER_DRAG_BUTTONS.has(buttonRaw)) {
        throw new Error(`"button" must be one of ${[...COMPUTER_DRAG_BUTTONS].join(', ')}`);
      }
      const button = buttonRaw as 'left' | 'right' | 'middle';
      const stepsRaw = args['steps'] ?? DEFAULT_DRAG_STEPS;
      if (typeof stepsRaw !== 'number' || !Number.isInteger(stepsRaw) || stepsRaw < 1 || stepsRaw > MAX_DRAG_STEPS) {
        throw new Error(`"steps" must be an integer between 1 and ${MAX_DRAG_STEPS}`);
      }
      const opts: DragOptions = { button, steps: stepsRaw };
      await os.drag(Math.floor(x1), Math.floor(y1), Math.floor(x2), Math.floor(y2), opts);
      return {
        dragged: {
          x1: Math.floor(x1),
          y1: Math.floor(y1),
          x2: Math.floor(x2),
          y2: Math.floor(y2),
          button,
          steps: stepsRaw,
        },
      };
    },
  };
}

function moveTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.move,
    mutating: true,
    description:
      'Move the mouse cursor to (x, y) without clicking — for hovers, tooltips, and positioning ' +
      'before a drag. MUTATING: requires human approval via governance (same policy as the other ' +
      'computer tools).',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal pixel coordinate' },
        y: { type: 'number', description: 'Vertical pixel coordinate' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    handler: async (args, _ctx) => {
      const x = intArg(args, 'x');
      const y = intArg(args, 'y');
      const { width, height } = await os.displaySize();
      assertInDisplay(x, y, width, height, 'move target');
      await os.move(Math.floor(x), Math.floor(y));
      return { moved: { x: Math.floor(x), y: Math.floor(y) } };
    },
  };
}

/** Build the eight computer-use ToolDefinitions. */
export function createComputerUseTools(opts: ComputerUseToolsOptions = {}): ToolDefinition[] {
  const os = opts.os ?? new MockOSScreenLayer();
  return [
    screenshotTool(os),
    clickTool(os),
    typeTool(os),
    keyTool(os),
    createOpenAppTool({ launcher: opts.appLauncher, platform: opts.platform }),
    scrollTool(os),
    dragTool(os),
    moveTool(os),
  ];
}

/**
 * Register the computer-use tools into a tool registry
 * (Map<string, ToolDefinition> — what AgentRuntime expects and what
 * apps/api/src/tool-registry.ts builds). Name collisions throw so a
 * duplicate registration can never silently shadow the approval-gated
 * definitions.
 */
export function registerComputerUseTool(
  registry: Map<string, ToolDefinition>,
  opts: ComputerUseToolsOptions = {},
): void {
  for (const tool of createComputerUseTools(opts)) {
    if (registry.has(tool.name)) {
      throw new Error(`tool name collision: "${tool.name}" is already registered`);
    }
    registry.set(tool.name, tool);
  }
}

// Re-export the context type for handler authors.
export type { ToolContext };

// Re-export the open-app building blocks (alias map, launcher interface,
// attempt resolver) for hosts and tests.
export {
  APP_ALIASES,
  OPEN_APP_TOOL_NAME,
  ChildProcessAppLauncher,
  createOpenAppTool,
  normalizeAppName,
  resolveLaunchAttempts,
  validateAppName,
} from './computer-apps.js';
export type { AppLauncher, LaunchAttempt, LaunchPlatform, OpenAppResult } from './computer-apps.js';
