// SPDX-License-Identifier: Apache-2.0
// Computer-use setup model (ADD-5 items 1–2): honest per-platform
// permission checks, the setup-required layer (tools answer with the
// setup prompt, never a silent mock), adapter selection, the explainer's
// foreground truth, and the self-test through the adapter seam.

import { afterEach, describe, expect, it } from 'vitest';
import { MockOSScreenLayer } from './computer.js';
import { RealOSScreenLayer } from './computer-real.js';
import { VerifiedOSLayer } from './computer-verify.js';
import {
  COMPUTER_USE_EXPLAINER,
  COMPUTER_USE_SETUP_PROMPT,
  ComputerUseSetupRequiredError,
  SetupRequiredOSLayer,
  detectDisplayServer,
  detectPlatformChecks,
  runComputerUseSelfTest,
  selectDesktopAdapter,
} from './computer-setup.js';

const ENV_KEYS = ['COMPUTER_USE_REAL', 'COMPUTER_USE_PLAYWRIGHT'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('explainer copy', () => {
  it('states the foreground truth plainly (own cursor, foreground, no background real-mouse control)', () => {
    expect(COMPUTER_USE_EXPLAINER.foregroundTruth).toMatch(/YOUR mouse cursor, in the foreground/);
    expect(COMPUTER_USE_EXPLAINER.foregroundTruth).toMatch(/no background mode for real mouse control/i);
  });
  it('states that setup grants no standing permission', () => {
    expect(COMPUTER_USE_EXPLAINER.approvalNote).toMatch(/does not give the agent standing permission/i);
    expect(COMPUTER_USE_EXPLAINER.approvalNote).toMatch(/still asks for your approval/i);
  });
});

describe('detectPlatformChecks', () => {
  it('macOS: accessibility / input-monitoring / screen-recording are grant-required and honestly not auto-detectable', () => {
    const report = detectPlatformChecks({ platform: 'darwin', env: {} });
    expect(report.platform).toBe('darwin');
    const ids = report.checks.map((c) => c.id);
    expect(ids).toEqual(['screen-recording', 'accessibility', 'input-monitoring']);
    for (const check of report.checks) {
      expect(check.requirement).toBe('grant-required');
      expect(check.autoDetectable).toBe(false);
      // Never a fake "granted": the process cannot probe TCC.
      expect(check.status).toBe('unknown');
      expect(check.instructions).toMatch(/System Settings/);
    }
  });

  it('Windows: no special permission required', () => {
    const report = detectPlatformChecks({ platform: 'win32', env: {} });
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ requirement: 'not-required', status: 'ok' });
  });

  it('Linux X11: input control available, no grant needed', () => {
    const report = detectPlatformChecks({ platform: 'linux', env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' } });
    expect(report.displayServer).toBe('x11');
    expect(report.checks[0]).toMatchObject({ requirement: 'not-required', status: 'ok' });
  });

  it('Linux Wayland: honestly reported as restricted (input injection blocked by design)', () => {
    const report = detectPlatformChecks({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'wayland' } });
    expect(report.displayServer).toBe('wayland');
    expect(report.checks[0]).toMatchObject({ requirement: 'restricted', status: 'restricted' });
    expect(report.checks[0]!.instructions).toMatch(/Wayland/);
  });

  it('detectDisplayServer reads session env in order', () => {
    expect(detectDisplayServer({ XDG_SESSION_TYPE: 'wayland' })).toBe('wayland');
    expect(detectDisplayServer({ XDG_SESSION_TYPE: 'x11' })).toBe('x11');
    expect(detectDisplayServer({ DISPLAY: ':0' })).toBe('x11');
    expect(detectDisplayServer({})).toBe('unknown');
  });
});

describe('SetupRequiredOSLayer', () => {
  it('every method fails with the setup prompt — nothing silently uses the mock', async () => {
    const layer = new SetupRequiredOSLayer();
    await expect(layer.screenshot()).rejects.toBeInstanceOf(ComputerUseSetupRequiredError);
    await expect(layer.click(1, 1)).rejects.toThrow(/not set up yet/);
    await expect(layer.type('x')).rejects.toThrow(COMPUTER_USE_SETUP_PROMPT.slice(0, 40));
    await expect(layer.move(1, 1)).rejects.toBeInstanceOf(ComputerUseSetupRequiredError);
    expect(layer).not.toBeInstanceOf(MockOSScreenLayer);
  });
});

describe('selectDesktopAdapter', () => {
  it('setup not completed + no env opt-in → setup-required layer with an honest reason', () => {
    const sel = selectDesktopAdapter({ setupEnabled: false, env: {} });
    expect(sel.kind).toBe('setup-required');
    expect(sel.real).toBe(false);
    expect(sel.layer).toBeInstanceOf(SetupRequiredOSLayer);
    expect(sel.reason).toMatch(/instead of a mock screen/);
  });

  it('setup enabled → the real foreground layer, screenshot-verified', () => {
    const sel = selectDesktopAdapter({
      setupEnabled: true,
      env: {},
      realDeps: { input: undefined, screenshotBackend: undefined },
    });
    expect(sel.kind).toBe('real');
    expect(sel.real).toBe(true);
    expect(sel.layer).toBeInstanceOf(VerifiedOSLayer);
    expect((sel.layer as VerifiedOSLayer).wrapped).toBeInstanceOf(RealOSScreenLayer);
    expect(sel.reason).toMatch(/setup is enabled/);
  });

  it('legacy COMPUTER_USE_REAL=1 env opt-in still selects the real layer', () => {
    const sel = selectDesktopAdapter({ setupEnabled: false, env: { COMPUTER_USE_REAL: '1' } });
    expect(sel.kind).toBe('real');
    expect(sel.reason).toMatch(/COMPUTER_USE_REAL=1/);
  });

  it('COMPUTER_USE_PLAYWRIGHT=1 wins and is not the real machine', () => {
    const sel = selectDesktopAdapter({ setupEnabled: true, env: { COMPUTER_USE_PLAYWRIGHT: '1' } });
    expect(sel.kind).toBe('playwright');
    expect(sel.real).toBe(false);
  });
});

describe('runComputerUseSelfTest', () => {
  it('screenshot + move + click at the screen centre, all recorded', async () => {
    const mock = new MockOSScreenLayer();
    const result = await runComputerUseSelfTest(mock, { now: () => 1234 });
    expect(result.ok).toBe(true);
    expect(result.at).toBe(1234);
    expect(result.steps.map((s) => s.id)).toEqual(['screenshot', 'move', 'click']);
    expect(mock.callsOf('move')[0]).toMatchObject({ x: 960, y: 540 });
    expect(mock.callsOf('click')[0]).toMatchObject({ x: 960, y: 540, button: 'left', clicks: 1 });
  });

  it('stops at a failed screenshot — never clicks blind', async () => {
    const broken = new MockOSScreenLayer();
    broken.screenshot = async () => {
      throw new Error('no screen recording permission');
    };
    const result = await runComputerUseSelfTest(broken);
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ id: 'screenshot', ok: false });
    expect(result.steps[1]!.detail).toMatch(/skipped/);
    expect(broken.callsOf('click')).toHaveLength(0);
    expect(broken.callsOf('move')).toHaveLength(0);
  });

  it('runs through the setup-required layer and reports the setup prompt as the failure', async () => {
    const result = await runComputerUseSelfTest(new SetupRequiredOSLayer());
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.detail).toMatch(/not set up yet/);
  });
});
