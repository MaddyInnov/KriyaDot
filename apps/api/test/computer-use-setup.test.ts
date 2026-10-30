// SPDX-License-Identifier: Apache-2.0
// Real-desktop computer-use setup flow (ADD-5 items 1–2): the walk
// (explainer with the foreground truth → per-OS permission checks →
// self-test through the adapter seam, recorded → enable), the persisted
// enabled state, the permissions-pane summary, and the setup-aware
// adapter selection (enabled → real adapter path; not set up → tools
// answer with the setup prompt instead of silently using the mock).
// The self-test layer seam is injected (mock OS layer); no real machine
// is driven by these tests.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockOSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import { SetupRequiredOSLayer } from '@mvp/agent-runtime/dist/tools/computer-setup.js';
import {
  computerUsePaneSummary,
  createSetupAwareLocalLayer,
  isComputerUseEnabled,
  readComputerUseSetup,
  registerComputerUseSetupRoutes,
} from '../src/computer-use-setup.js';
import { buildOverview, type PermissionsPaneDeps } from '../src/permissions-pane.js';

const OWNER_TOKEN = 'owner' + '-token';

let dir: string;
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';
let selfTestLayer: MockOSScreenLayer;
const audit = vi.fn();

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: 'Bearer ' + OWNER_TOKEN,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'computer-use-setup-'));
  audit.mockClear();
  selfTestLayer = new MockOSScreenLayer();
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerComputerUseSetupRoutes(router, {
    dataDir: dir,
    audit,
    loopbackToken: OWNER_TOKEN,
    platform: 'linux',
    env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
    createSelfTestLayer: () => selfTestLayer,
  });
  app.use('/api', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api`;
      resolve();
    });
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('setup flow', () => {
  it('starts not-started, with the foreground-truth explainer and honest OS checks', async () => {
    const { status, json } = await req('GET', '/computer-use-setup');
    expect(status).toBe(200);
    expect(json.status).toBe('not-started');
    expect(json.enabled).toBe(false);
    expect(json.explainer.foregroundTruth).toMatch(/YOUR mouse cursor, in the foreground/);
    expect(json.explainer.foregroundTruth).toMatch(/no background mode for real mouse control/i);
    expect(json.approvalNote).toMatch(/still asks for your approval/i);
    expect(json.platform.platform).toBe('linux');
    expect(json.adapter.kind).toBe('setup-required');
  });

  it('enable is refused before a passing self-test, and self-test requires begin', async () => {
    const early = await req('POST', '/computer-use-setup/self-test');
    expect(early.status).toBe(400);
    await req('POST', '/computer-use-setup/begin');
    const enable = await req('POST', '/computer-use-setup/enable', { confirm: true });
    expect(enable.status).toBe(400);
    expect(enable.json.error).toMatch(/self-test has not passed/);
    expect(isComputerUseEnabled(dir, 'default-user')).toBe(false);
  });

  it('walks begin → self-test (recorded) → enable; state persists and the adapter flips to real', async () => {
    await req('POST', '/computer-use-setup/begin');
    expect(readComputerUseSetup(dir, 'default-user').status).toBe('in-progress');

    const test = await req('POST', '/computer-use-setup/self-test');
    expect(test.status).toBe(200);
    expect(test.json.selfTest.ok).toBe(true);
    expect(test.json.selfTest.steps.map((s: any) => s.id)).toEqual(['screenshot', 'move', 'click']);
    // The self-test really ran through the adapter seam (the mock recorded it).
    expect(selfTestLayer.callsOf('click')).toHaveLength(1);
    expect(test.json.status).toBe('ready-to-enable');
    // Recorded in the persisted state.
    expect(readComputerUseSetup(dir, 'default-user').selfTest?.ok).toBe(true);

    const enable = await req('POST', '/computer-use-setup/enable', { confirm: true });
    expect(enable.status).toBe(200);
    expect(enable.json.status).toBe('enabled');
    expect(enable.json.adapter.kind).toBe('real');
    expect(isComputerUseEnabled(dir, 'default-user')).toBe(true);
    expect(audit).toHaveBeenCalledWith('computer_use.enabled', expect.anything());

    const disable = await req('POST', '/computer-use-setup/disable');
    expect(disable.json.status).toBe('disabled');
    expect(isComputerUseEnabled(dir, 'default-user')).toBe(false);
  });

  it('a failing self-test is recorded as self-test-failed and blocks enable', async () => {
    selfTestLayer.screenshot = async () => {
      throw new Error('screen recording permission missing');
    };
    await req('POST', '/computer-use-setup/begin');
    const test = await req('POST', '/computer-use-setup/self-test');
    expect(test.json.selfTest.ok).toBe(false);
    expect(test.json.status).toBe('self-test-failed');
    expect(test.json.selfTest.steps[0].detail).toMatch(/screen recording permission missing/);
    const enable = await req('POST', '/computer-use-setup/enable', { confirm: true });
    expect(enable.status).toBe(400);
  });

  it('enable requires { confirm: true }', async () => {
    await req('POST', '/computer-use-setup/begin');
    await req('POST', '/computer-use-setup/self-test');
    const res = await req('POST', '/computer-use-setup/enable', {});
    expect(res.status).toBe(400);
  });
});

describe('setup-aware adapter selection (host composition seam)', () => {
  it('not set up: tools answer with the setup prompt, NOT a silent mock success', async () => {
    const layer = createSetupAwareLocalLayer({ dataDir: dir, userId: 'default-user', env: {} });
    await expect(layer.click(1, 1)).rejects.toThrow(/not set up yet/);
    await expect(layer.screenshot()).rejects.toThrow(/Settings → Permissions → Computer use/);
  });

  it('the delegating layer re-reads setup state per call (enable takes effect without restart)', async () => {
    const layer = createSetupAwareLocalLayer({
      dataDir: dir,
      userId: 'default-user',
      env: {},
      // Inject the mock as the "real" native backend so the enabled path
      // is exercisable without a real machine.
      realDeps: {
        input: {
          moveMouse: async () => undefined,
          mouseClick: async () => undefined,
          mouseDown: async () => undefined,
          mouseUp: async () => undefined,
          scrollAt: async () => undefined,
          typeString: async () => undefined,
          pressKey: async () => undefined,
          pressKeyChord: async () => undefined,
          screenWidth: async () => 800,
          screenHeight: async () => 600,
        },
        screenshotBackend: { capture: async () => new Uint8Array([1, 2, 3]) },
      },
    });
    await expect(layer.screenshot()).rejects.toThrow(/not set up yet/);
    // Complete setup via the routes.
    await req('POST', '/computer-use-setup/begin');
    await req('POST', '/computer-use-setup/self-test');
    await req('POST', '/computer-use-setup/enable', { confirm: true });
    // Same layer instance now reaches the real adapter (screenshot works).
    const shot = await layer.screenshot();
    expect(shot.width).toBe(800);
  });

  it('SetupRequiredOSLayer is exported for hosts that select adapters directly', () => {
    expect(new SetupRequiredOSLayer()).toBeDefined();
  });
});

describe('permissions-pane integration', () => {
  it('overview carries the computer-use surface row (not overridable) and the setup summary when wired', () => {
    const deps: PermissionsPaneDeps = {
      dataDir: dir,
      bots: [],
      listApprovals: () => [],
      computerUseStatus: (userId) => computerUsePaneSummary(dir, userId),
    };
    const overview = buildOverview(deps, 'default-user') as any;
    const surface = overview.surfaces.find((s: any) => s.id === 'computer-use');
    expect(surface).toBeDefined();
    expect(surface.overridable).toBe(false);
    expect(surface.description).toMatch(/YOUR mouse cursor, in the foreground/);
    expect(overview.computerUse).toMatchObject({ status: 'not-started', enabled: false, adapterKind: 'setup-required' });
  });

  it('pane summary reflects a completed setup', async () => {
    await req('POST', '/computer-use-setup/begin');
    await req('POST', '/computer-use-setup/self-test');
    await req('POST', '/computer-use-setup/enable', { confirm: true });
    const summary = computerUsePaneSummary(dir, 'default-user');
    expect(summary).toMatchObject({ status: 'enabled', enabled: true, selfTestOk: true, adapterKind: 'real' });
  });
});
