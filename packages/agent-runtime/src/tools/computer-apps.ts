// SPDX-License-Identifier: Apache-2.0
// "Open app" computer tool: launch a desktop application by name.
//
//   computer_open_app — launch a desktop app (e.g. "whatsapp", "notepad")
//                       [MUTATING → require-approval]
//
// Trust model (never weakened):
//   - Launching a process is mutating: the tool is approval-gated via the
//     same computerUsePolicyRules() mechanism as click/type/key (see
//     computer.ts). Nothing here bypasses governance.
//   - No shell string interpolation anywhere: every launch goes through
//     spawn with an argv array, so a hostile app name cannot inject
//     commands. The app name is additionally restricted to a safe
//     character set and resolved through a fixed alias map before any
//     OS call is made.
//   - No new native dependencies: uses node:child_process only (robotjs
//     is deliberately NOT introduced).
//   - The launcher is injectable (AppLauncher) so tests never spawn real
//     processes; the default wiring detaches the child and unrefs it so
//     the API process never waits on the launched app.

import { spawn } from 'node:child_process';
import type { ToolContext, ToolDefinition } from '../types.js';

/** Canonical tool name for the open-app action. */
export const OPEN_APP_TOOL_NAME = 'computer_open_app';

/** Maximum length of the raw app-name input (defense-in-depth). */
const MAX_APP_NAME_CHARS = 120;

/**
 * Characters the app name may contain. Deliberately excludes shell
 * metacharacters (& | ; < > $ ` \ " ' ( ) ! *) so the name can never
 * break out of an argv slot, even on the Windows cmd path.
 */
const SAFE_APP_NAME_PATTERN = /^[a-zA-Z0-9 ._:+\-/]+$/;

/** One launch candidate: an OS command plus its argv (no shell). */
export interface LaunchAttempt {
  command: string;
  args: string[];
  /** Human-readable label for the result report. */
  label: string;
}

/** Minimal launcher interface — injectable so tests never spawn processes. */
export interface AppLauncher {
  launch(attempt: LaunchAttempt): Promise<void>;
}

/** Default launcher: detached spawn; the child is unref'd (fire-and-forget). */
export class ChildProcessAppLauncher implements AppLauncher {
  async launch(attempt: LaunchAttempt): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(attempt.command, attempt.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => reject(err));
      // 'spawn' event confirms the OS accepted the launch; unref so the
      // API process never waits on the launched app.
      child.on('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}

interface AppAlias {
  /** URI schemes to try first (Windows/macOS), e.g. "whatsapp:". */
  uris?: string[];
  /** Executable / binary names, e.g. "WhatsApp.exe". */
  exes?: string[];
  /** macOS application names for `open -a`, e.g. "WhatsApp". */
  macNames?: string[];
  /** Linux binary/desktop names, e.g. "whatsapp". */
  linuxNames?: string[];
}

/**
 * Alias map: normalized user input → per-OS launch targets.
 * Kept intentionally small and conservative; unknown names fall through
 * to a direct attempt (see resolveLaunchAttempts).
 */
export const APP_ALIASES: Readonly<Record<string, AppAlias>> = {
  whatsapp: { uris: ['whatsapp:'], exes: ['WhatsApp.exe'], macNames: ['WhatsApp'], linuxNames: ['whatsapp'] },
  chrome: { exes: ['chrome.exe'], macNames: ['Google Chrome'], linuxNames: ['google-chrome', 'chromium'] },
  firefox: { exes: ['firefox.exe'], macNames: ['Firefox'], linuxNames: ['firefox'] },
  edge: { exes: ['msedge.exe'], macNames: ['Microsoft Edge'], linuxNames: ['microsoft-edge'] },
  notepad: { exes: ['notepad.exe'], macNames: ['TextEdit'], linuxNames: ['gedit', 'mousepad'] },
  calculator: { exes: ['calc.exe'], macNames: ['Calculator'], linuxNames: ['gnome-calculator'] },
  vscode: { uris: ['vscode:'], exes: ['Code.exe'], macNames: ['Visual Studio Code'], linuxNames: ['code'] },
  code: { uris: ['vscode:'], exes: ['Code.exe'], macNames: ['Visual Studio Code'], linuxNames: ['code'] },
  spotify: { uris: ['spotify:'], exes: ['Spotify.exe'], macNames: ['Spotify'], linuxNames: ['spotify'] },
  telegram: { exes: ['Telegram.exe'], macNames: ['Telegram'], linuxNames: ['telegram-desktop'] },
  discord: { exes: ['Discord.exe'], macNames: ['Discord'], linuxNames: ['discord'] },
  slack: { exes: ['slack.exe'], macNames: ['Slack'], linuxNames: ['slack'] },
  teams: { uris: ['msteams:'], exes: ['Teams.exe'], macNames: ['Microsoft Teams'], linuxNames: ['teams'] },
  zoom: { uris: ['zoommtg:'], exes: ['Zoom.exe'], macNames: ['zoom.us'], linuxNames: ['zoom'] },
  outlook: { uris: ['outlook:'], exes: ['OUTLOOK.EXE'], macNames: ['Microsoft Outlook'] },
  word: { exes: ['WINWORD.EXE'], macNames: ['Microsoft Word'] },
  excel: { exes: ['EXCEL.EXE'], macNames: ['Microsoft Excel'] },
  powerpoint: { exes: ['POWERPNT.EXE'], macNames: ['Microsoft PowerPoint'] },
  terminal: { exes: ['wt.exe'], macNames: ['Terminal'], linuxNames: ['gnome-terminal', 'x-terminal-emulator'] },
  safari: { macNames: ['Safari'] },
  finder: { macNames: ['Finder'] },
  facetime: { uris: ['facetime:'], macNames: ['FaceTime'] },
  mail: { uris: ['mailto:'], macNames: ['Mail'], linuxNames: ['thunderbird'] },
  notes: { macNames: ['Notes'] },
  photos: { macNames: ['Photos'] },
  music: { macNames: ['Music'] },
  files: { exes: ['explorer.exe'], macNames: ['Finder'], linuxNames: ['nautilus', 'dolphin'] },
  settings: { uris: ['ms-settings:'], exes: ['control.exe'], macNames: ['System Settings'] },
};

/**
 * Normalize free-form user input ("WhatsApp Desktop", "  CHROME ") to an
 * alias key. Strips common suffixes so "open whatsapp desktop" resolves.
 */
export function normalizeAppName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+(desktop|app|application)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate the raw app name. Throws on empty, over-long, or unsafe input
 * (input validation, consistent with the other computer tools).
 */
export function validateAppName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('"app" must be a non-empty app name (e.g. "whatsapp")');
  if (name.length > MAX_APP_NAME_CHARS) {
    throw new Error(`"app" too long (${name.length} > ${MAX_APP_NAME_CHARS} chars)`);
  }
  if (!SAFE_APP_NAME_PATTERN.test(name)) {
    throw new Error(`"app" contains unsafe characters; use a plain app name like "whatsapp"`);
  }
  return name;
}

export type LaunchPlatform = 'win32' | 'darwin' | 'linux';

/**
 * Build the ordered list of launch candidates for an app on a platform.
 * Pure function (no I/O) — fully unit-testable.
 */
export function resolveLaunchAttempts(app: string, platform: LaunchPlatform): LaunchAttempt[] {
  const key = normalizeAppName(app);
  const alias = APP_ALIASES[key];
  const attempts: LaunchAttempt[] = [];

  if (platform === 'win32') {
    // URI schemes first (most reliable for Store apps like WhatsApp).
    for (const uri of alias?.uris ?? []) {
      attempts.push({ command: 'cmd', args: ['/c', 'start', '', uri], label: `URI scheme ${uri}` });
    }
    for (const exe of alias?.exes ?? []) {
      attempts.push({ command: 'cmd', args: ['/c', 'start', '', exe], label: `start ${exe}` });
    }
    if (!alias) {
      // Unknown name: let Windows resolve it (PATH / App Paths / URI).
      attempts.push({ command: 'cmd', args: ['/c', 'start', '', app], label: `start ${app}` });
    }
  } else if (platform === 'darwin') {
    for (const macName of alias?.macNames ?? []) {
      attempts.push({ command: 'open', args: ['-a', macName], label: `open -a "${macName}"` });
    }
    if (!alias) {
      const titleCase = app.charAt(0).toUpperCase() + app.slice(1);
      attempts.push({ command: 'open', args: ['-a', titleCase], label: `open -a "${titleCase}"` });
    }
  } else {
    for (const bin of alias?.linuxNames ?? []) {
      attempts.push({ command: bin, args: [], label: `binary ${bin}` });
    }
    if (!alias) {
      attempts.push({ command: app, args: [], label: `binary ${app}` });
    }
  }

  return attempts;
}

export interface OpenAppResult {
  launched: boolean;
  app: string;
  /** Which candidate succeeded (when launched). */
  via?: string;
  /** Every candidate tried, in order (for the failure report). */
  attempted: string[];
  /** Error message (when not launched). */
  error?: string;
}

export interface OpenAppToolOptions {
  launcher?: AppLauncher;
  /** Override process.platform (tests). */
  platform?: LaunchPlatform;
}

/**
 * Build the computer_open_app ToolDefinition. The handler never throws
 * unhandled: launch failures are returned as { launched: false, ... }
 * (input validation errors still throw, like the other computer tools).
 */
export function createOpenAppTool(opts: OpenAppToolOptions = {}): ToolDefinition {
  const launcher = opts.launcher ?? new ChildProcessAppLauncher();
  const platform = opts.platform ?? (process.platform as LaunchPlatform);

  return {
    name: OPEN_APP_TOOL_NAME,
    description:
      'Launch a desktop application by name (e.g. "whatsapp", "notepad", "chrome"). ' +
      'Use when the user asks to open an app. MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name, e.g. "whatsapp", "notepad", "chrome"' },
      },
      required: ['app'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const app = validateAppName(args['app']);
      const attempts = resolveLaunchAttempts(app, platform);
      const attempted = attempts.map((a) => a.label);

      let lastError: string | undefined;
      for (const attempt of attempts) {
        try {
          await launcher.launch(attempt);
          const result: OpenAppResult = { launched: true, app, via: attempt.label, attempted };
          return result;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      const result: OpenAppResult = {
        launched: false,
        app,
        attempted,
        error: lastError ?? 'no launch candidates available for this platform',
      };
      return result;
    },
  };
}
