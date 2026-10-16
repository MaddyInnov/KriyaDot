// SPDX-License-Identifier: Apache-2.0
// Sandboxed GUI-automation (computer use) tools.
//
// Tools:
//   computer_screenshot — capture the screen (read-only; auto-allowed by policy)
//   computer_click      — click at (x, y)          [MUTATING → require-approval]
//   computer_type       — type text                [MUTATING → require-approval]
//   computer_key        — press a named key         [MUTATING → require-approval]
//   computer_open_app   — launch a desktop app      [MUTATING → require-approval]
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
//     the four mutating actions (screenshot stays allow), so gating is
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
}

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
export class MockOSScreenLayer implements OSScreenLayer {
  readonly calls: Array<{ action: 'click' | 'type' | 'key' | 'screenshot'; args: Record<string, unknown> }> = [];
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

  /** Calls of one action, in order. */
  callsOf(action: 'click' | 'type' | 'key' | 'screenshot'): Record<string, unknown>[] {
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
} as const;

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
      toolPattern: '^computer_(click|type|key|open_app)$',
      effect: 'require-approval',
      reason: 'Computer-use mutating actions (click/type/key/open_app) always need human approval',
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
      if (x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(`click (${x}, ${y}) is outside the ${width}×${height} display`);
      }
      await os.click(Math.floor(x), Math.floor(y));
      return { clicked: { x: Math.floor(x), y: Math.floor(y) } };
    },
  };
}

function typeTool(os: OSScreenLayer): ToolDefinition {
  return {
    name: COMPUTER_TOOL_NAMES.type,
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

/** Build the five computer-use ToolDefinitions. */
export function createComputerUseTools(opts: ComputerUseToolsOptions = {}): ToolDefinition[] {
  const os = opts.os ?? new MockOSScreenLayer();
  return [
    screenshotTool(os),
    clickTool(os),
    typeTool(os),
    keyTool(os),
    createOpenAppTool({ launcher: opts.appLauncher, platform: opts.platform }),
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
