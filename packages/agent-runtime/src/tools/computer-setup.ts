// SPDX-License-Identifier: Apache-2.0
// Real-desktop computer use: first-run setup model + adapter selection
// (closure ADD-5 items 1–2).
//
// Before this module the real OS layer was an env-var opt-in
// (COMPUTER_USE_REAL=1 in computer-real.ts) and everything else silently
// fell back to MockOSScreenLayer — so "computer use" appeared to work
// while nothing real could happen, and there was no product surface that
// explained what real control means or checked the OS permissions it
// needs. This module is the productization seam:
//
//   - COMPUTER_USE_EXPLAINER: the plain-language copy the setup flow
//     shows FIRST, including the foreground truth (below).
//   - detectPlatformChecks(): the per-OS permission grant checks,
//     detected + reported HONESTLY: without a native binding in-process
//     we cannot probe macOS TCC grants, so those report 'unknown' with
//     the exact Settings path to grant them — never a fake "granted".
//   - SetupRequiredOSLayer: the layer tools get when real-desktop setup
//     has NOT completed. Every call fails with the setup prompt instead
//     of silently driving the mock.
//   - selectDesktopAdapter(): the adapter-selection logic the host
//     composition uses — setup-enabled (or the legacy env opt-in) → the
//     real foreground layer wrapped in screenshot verification
//     (computer-verify.ts); Playwright env → the browser layer;
//     otherwise the setup-required layer.
//   - runComputerUseSelfTest(): screenshot + move + click on the screen
//     centre, through whatever adapter seam the host injects, with
//     per-step results the setup flow records.
//
// THE FOREGROUND TRUTH (stated in the UI copy and never softened): real
// mouse/keyboard control uses the user's OWN cursor, in the FOREGROUND,
// on the screen they are looking at. There is no background real-mouse
// control. Work that must stay in the background uses the API, Playwright
// or sandbox backends instead.
//
// Governance is NEVER weakened by setup: completing setup selects the
// real adapter, nothing more. Every mutating computer action still flows
// through computerUsePolicyRules() → require-approval, and setup grants
// no standing allow of any kind.

import type {
  ClickOptions,
  DisplaySize,
  DragOptions,
  OSScreenLayer,
  Screenshot,
} from './computer.js';
import type { ChordModifier } from './computer-keys.js';
import { COMPUTER_USE_PLAYWRIGHT_ENV } from './computer-playwright.js';
import {
  COMPUTER_USE_REAL_ENV,
  RealOSScreenLayer,
  selectOSLayer,
  type RealOSLayerDeps,
} from './computer-real.js';
import { VerifiedOSLayer, type ComputerVerificationRecord } from './computer-verify.js';

// ---------------------------------------------------------------------------
// Explainer copy (the setup flow's first step — plain language)
// ---------------------------------------------------------------------------

export const COMPUTER_USE_EXPLAINER = {
  headline: 'Let your agent use this computer',
  foregroundTruth:
    'Real control uses YOUR mouse cursor, in the foreground, on the screen you are looking at. ' +
    'While the agent is clicking and typing, the computer is busy doing exactly that — you will see ' +
    'the cursor move and windows change. There is no background mode for real mouse control: if you ' +
    'need the agent to keep working while you use the machine, it should use a browser window, an ' +
    'API, or the sandbox instead.',
  approvalNote:
    'Setup does not give the agent standing permission to do anything. Every click, keystroke and ' +
    'piece of typed text still asks for your approval first, one action at a time.',
  permissionNote:
    'Your operating system may ask you to grant accessibility / input permissions to the app that ' +
    'runs KriyaDot. Those grants are what let it move the mouse and type on your behalf — they are ' +
    'also why setup checks for them before anything is enabled.',
} as const;

/** The message tools answer with when real-desktop setup has not completed. */
export const COMPUTER_USE_SETUP_PROMPT =
  'Real desktop control is not set up yet, so this action was NOT performed (nothing was clicked, ' +
  'typed, or moved — and no pretend/mock screen was used instead). Ask the user to open ' +
  'Settings → Permissions → Computer use (real desktop) and finish the one-time setup: it explains ' +
  'that real control uses their own cursor in the foreground, checks the operating-system ' +
  'permissions, and runs a short self-test. Until setup is enabled, use a browser, an API, or the ' +
  'sandbox for this task.';

export class ComputerUseSetupRequiredError extends Error {
  constructor() {
    super(COMPUTER_USE_SETUP_PROMPT);
    this.name = 'ComputerUseSetupRequiredError';
  }
}

/**
 * The layer selected when real-desktop setup has not completed: every
 * method fails with the setup prompt. Deliberately NOT the mock — a
 * silent mock success is exactly the dishonesty this block removes.
 */
export class SetupRequiredOSLayer implements OSScreenLayer {
  private fail(): never {
    throw new ComputerUseSetupRequiredError();
  }
  async displaySize(): Promise<DisplaySize> {
    return this.fail();
  }
  async screenshot(): Promise<Screenshot> {
    return this.fail();
  }
  async click(_x: number, _y: number, _opts?: ClickOptions): Promise<void> {
    this.fail();
  }
  async type(_text: string): Promise<void> {
    this.fail();
  }
  async key(_name: string): Promise<void> {
    this.fail();
  }
  async keyChord(_modifiers: ChordModifier[], _key: string): Promise<void> {
    this.fail();
  }
  async scroll(_x: number, _y: number, _deltaX: number, _deltaY: number): Promise<void> {
    this.fail();
  }
  async drag(_x1: number, _y1: number, _x2: number, _y2: number, _opts: DragOptions): Promise<void> {
    this.fail();
  }
  async move(_x: number, _y: number): Promise<void> {
    this.fail();
  }
}

// ---------------------------------------------------------------------------
// Per-platform permission grant checks (detected + reported honestly)
// ---------------------------------------------------------------------------

export type ComputerUsePlatform = 'darwin' | 'win32' | 'linux' | 'other';
export type DisplayServer = 'x11' | 'wayland' | 'unknown';

export interface ComputerUsePermissionCheck {
  id: string;
  label: string;
  /** grant-required: the user must grant it in OS settings. not-required: nothing to grant. restricted: the environment blocks the capability. */
  requirement: 'grant-required' | 'not-required' | 'restricted';
  /**
   * Honest detection state. 'unknown' means this process cannot probe the
   * grant without a native binding — the check then relies on the
   * self-test exercising the capability for real.
   */
  status: 'ok' | 'needs-grant' | 'unknown' | 'restricted';
  /** Whether this process can probe the grant state directly. */
  autoDetectable: boolean;
  instructions: string;
}

export interface PlatformCheckReport {
  platform: ComputerUsePlatform;
  displayServer?: DisplayServer;
  checks: ComputerUsePermissionCheck[];
}

export function detectDisplayServer(env: NodeJS.ProcessEnv): DisplayServer {
  const session = (env['XDG_SESSION_TYPE'] ?? '').toLowerCase();
  if (session === 'wayland') return 'wayland';
  if (session === 'x11' || session === 'xorg') return 'x11';
  if (env['WAYLAND_DISPLAY']) return 'wayland';
  if (env['DISPLAY']) return 'x11';
  return 'unknown';
}

/**
 * The permission checks for a platform. Pure + injectable so the setup
 * flow (and tests) can report for any OS. Statuses are honest: macOS TCC
 * grants cannot be probed from this process (no native binding is loaded
 * until the first real action), so they report 'unknown' and the
 * self-test is what proves them.
 */
export function detectPlatformChecks(
  opts: { platform?: string; env?: NodeJS.ProcessEnv } = {},
): PlatformCheckReport {
  const raw = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (raw === 'darwin') {
    const grant = (id: string, label: string, pane: string): ComputerUsePermissionCheck => ({
      id,
      label,
      requirement: 'grant-required',
      status: 'unknown',
      autoDetectable: false,
      instructions:
        `Open System Settings → Privacy & Security → ${pane} and allow the app that runs KriyaDot. ` +
        'This process cannot read the grant state directly — the self-test below proves it by taking a real screenshot and moving the cursor.',
    });
    return {
      platform: 'darwin',
      checks: [
        grant('screen-recording', 'Screen Recording — lets the agent see your screen', 'Screen Recording'),
        grant('accessibility', 'Accessibility — lets the agent click, type and press keys', 'Accessibility'),
        grant('input-monitoring', 'Input Monitoring — lets the agent read keyboard state for shortcuts', 'Input Monitoring'),
      ],
    };
  }
  if (raw === 'win32') {
    return {
      platform: 'win32',
      checks: [
        {
          id: 'os-permissions',
          label: 'Operating-system permissions',
          requirement: 'not-required',
          status: 'ok',
          autoDetectable: true,
          instructions:
            'Windows needs no special permission for an app to control the mouse and keyboard in your own signed-in session. ' +
            'Apps running as administrator can only be controlled by a KriyaDot process that is also elevated — the self-test below shows whether control works.',
        },
      ],
    };
  }
  if (raw === 'linux') {
    const displayServer = detectDisplayServer(env);
    if (displayServer === 'wayland') {
      return {
        platform: 'linux',
        displayServer,
        checks: [
          {
            id: 'display-server',
            label: 'Display server (Wayland)',
            requirement: 'restricted',
            status: 'restricted',
            autoDetectable: true,
            instructions:
              'This session runs Wayland, which by design blocks other apps from injecting mouse/keyboard input — real foreground control will not work here. ' +
              'Log in with an X11/Xorg session for real desktop control, or keep using the browser / sandbox backends, which work fine on Wayland.',
          },
        ],
      };
    }
    return {
      platform: 'linux',
      displayServer,
      checks: [
        {
          id: 'display-server',
          label: `Display server (${displayServer === 'x11' ? 'X11' : 'not detected'})`,
          requirement: 'not-required',
          status: displayServer === 'x11' ? 'ok' : 'unknown',
          autoDetectable: true,
          instructions:
            displayServer === 'x11'
              ? 'X11 allows an app in your session to move the mouse and type — no extra grant is needed. The self-test below proves it end to end.'
              : 'No X11 DISPLAY or Wayland session was detected from this process, so input control cannot be confirmed here. The self-test below is the proof — if it fails, start KriyaDot from your desktop session (not a bare SSH/tty shell).',
        },
      ],
    };
  }
  return {
    platform: 'other',
    checks: [
      {
        id: 'platform',
        label: 'Platform support',
        requirement: 'restricted',
        status: 'unknown',
        autoDetectable: true,
        instructions: `Real desktop control is supported on macOS, Windows and Linux (X11). This process reports platform "${raw}", so the self-test result is the only honest signal.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Adapter selection (host composition)
// ---------------------------------------------------------------------------

export type DesktopAdapterKind = 'real' | 'playwright' | 'setup-required';

export interface DesktopAdapterSelection {
  kind: DesktopAdapterKind;
  layer: OSScreenLayer;
  /** Why this adapter was selected — shown in Settings, never hidden. */
  reason: string;
  /** True when the layer drives the real foreground machine. */
  real: boolean;
}

export interface SelectDesktopAdapterOptions {
  /** True once the user completed the first-run setup flow (persisted state). */
  setupEnabled: boolean;
  env?: NodeJS.ProcessEnv;
  /** Native backend injection for the real layer (tests / host seam). */
  realDeps?: RealOSLayerDeps;
  /** Screenshot-verification hook for the real layer (spans/attempts). */
  onVerification?: (record: ComputerVerificationRecord) => void;
}

/**
 * Select the desktop adapter for host composition:
 *   1. Playwright env opt-in → the browser layer (background-safe).
 *   2. Setup enabled OR the legacy COMPUTER_USE_REAL=1 env opt-in → the
 *      REAL foreground layer, wrapped in screenshot verification.
 *   3. Otherwise → SetupRequiredOSLayer: tools answer with the setup
 *      prompt instead of silently using the mock.
 */
export function selectDesktopAdapter(opts: SelectDesktopAdapterOptions): DesktopAdapterSelection {
  const env = opts.env ?? process.env;
  if (env[COMPUTER_USE_PLAYWRIGHT_ENV] === '1') {
    return {
      kind: 'playwright',
      layer: selectOSLayer(opts.realDeps ?? {}),
      reason: 'COMPUTER_USE_PLAYWRIGHT=1 — the Playwright browser layer is the desktop surface',
      real: false,
    };
  }
  const viaSetup = opts.setupEnabled;
  const viaEnv = env[COMPUTER_USE_REAL_ENV] === '1';
  if (viaSetup || viaEnv) {
    const real = new RealOSScreenLayer(opts.realDeps ?? {});
    return {
      kind: 'real',
      layer: new VerifiedOSLayer(real, { onVerification: opts.onVerification }),
      reason: viaSetup
        ? 'real-desktop setup is enabled — the real foreground adapter is active (every action still needs approval, and each is screenshot-verified)'
        : 'COMPUTER_USE_REAL=1 — the real foreground adapter is active via the environment opt-in (every action still needs approval, and each is screenshot-verified)',
      real: true,
    };
  }
  return {
    kind: 'setup-required',
    layer: new SetupRequiredOSLayer(),
    reason: 'real-desktop setup has not been completed — computer tools answer with the setup prompt instead of a mock screen',
    real: false,
  };
}

// ---------------------------------------------------------------------------
// Self-test (screenshot + move + click on a safe target)
// ---------------------------------------------------------------------------

export interface ComputerUseSelfTestStep {
  id: 'screenshot' | 'move' | 'click';
  ok: boolean;
  detail: string;
}

export interface ComputerUseSelfTestResult {
  ok: boolean;
  at: number;
  steps: ComputerUseSelfTestStep[];
}

/**
 * Run the setup self-test through the given adapter seam: capture a real
 * screenshot, move the cursor to the centre of the screen, and click
 * there once. The centre of the user's own screen during a user-started
 * setup test is the safe target — the user is watching, and the flow
 * stops at the first failed step rather than clicking blind.
 */
export async function runComputerUseSelfTest(
  layer: OSScreenLayer,
  opts: { now?: () => number } = {},
): Promise<ComputerUseSelfTestResult> {
  const now = opts.now ?? Date.now;
  const steps: ComputerUseSelfTestStep[] = [];
  const fail = (id: ComputerUseSelfTestStep['id'], err: unknown): ComputerUseSelfTestStep => ({
    id,
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  });

  let cx = 0;
  let cy = 0;
  try {
    const shot = await layer.screenshot();
    if (!shot.png || shot.png.length === 0) throw new Error('screenshot returned no image bytes');
    if (!(shot.width > 0 && shot.height > 0)) throw new Error('screenshot reported an empty display size');
    cx = Math.floor(shot.width / 2);
    cy = Math.floor(shot.height / 2);
    steps.push({ id: 'screenshot', ok: true, detail: `captured a ${shot.width}×${shot.height} screenshot` });
  } catch (err) {
    steps.push(fail('screenshot', err));
    steps.push({ id: 'move', ok: false, detail: 'skipped — the screenshot step failed, so nothing was moved or clicked' });
    steps.push({ id: 'click', ok: false, detail: 'skipped — the screenshot step failed, so nothing was moved or clicked' });
    return { ok: false, at: now(), steps };
  }
  try {
    await layer.move(cx, cy);
    steps.push({ id: 'move', ok: true, detail: `moved the cursor to the centre of the screen (${cx}, ${cy})` });
  } catch (err) {
    steps.push(fail('move', err));
    steps.push({ id: 'click', ok: false, detail: 'skipped — the move step failed, so no click was attempted' });
    return { ok: false, at: now(), steps };
  }
  try {
    await layer.click(cx, cy, { button: 'left', clicks: 1 });
    steps.push({ id: 'click', ok: true, detail: `clicked once at the centre of the screen (${cx}, ${cy})` });
  } catch (err) {
    steps.push(fail('click', err));
    return { ok: false, at: now(), steps };
  }
  return { ok: steps.every((s) => s.ok), at: now(), steps };
}
