// SPDX-License-Identifier: Apache-2.0
// W12 route plumbing: (b) widget list round-trips neverExpire/expiresAt,
// (c) update settings round-trip applyWhenIdle + the idle status route.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IdleAutoUpdater,
  WidgetCoordinator,
  WidgetStore,
  type UpdateStatus,
} from '@mvp/agent-runtime';
import { createWidgetRouter } from '../src/widget-routes.js';
import { createSelfUpdateRouter } from '../src/self-update-routes.js';

let dataDir: string;
let server: ReturnType<express.Express['listen']>;
let base: string;

async function listen(app: express.Express) {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'w12-routes-'));
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('widget routes — neverExpire round-trip (W12b)', () => {
  it('GET /widgets serializes expiresAt=null + neverExpire for eternal cards, a timestamp for normal ones', async () => {
    const store = new WidgetStore(dataDir, { ttlMs: 1000 });
    const coordinator = new WidgetCoordinator(store);
    await coordinator.raise({
      sessionId: 's',
      botId: 'b',
      kind: 'buttons',
      payload: { kind: 'buttons', question: 'Eternal?', options: [{ id: 'a', label: 'A' }] },
      interactive: true,
      neverExpire: true,
    });
    await coordinator.raise({
      sessionId: 's',
      botId: 'b',
      kind: 'buttons',
      payload: { kind: 'buttons', question: 'Normal?', options: [{ id: 'a', label: 'A' }] },
      interactive: true,
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createWidgetRouter({ store, coordinator, audit: () => undefined }));
    await listen(app);
    const res = (await (await fetch(`${base}/api/widgets?sessionId=s`)).json()) as {
      widgets: Array<{ payload: { question?: string }; expiresAt: number | null; neverExpire: boolean }>;
    };
    const eternal = res.widgets.find((w) => w.payload.question === 'Eternal?');
    const normal = res.widgets.find((w) => w.payload.question === 'Normal?');
    expect(eternal?.expiresAt).toBeNull();
    expect(eternal?.neverExpire).toBe(true);
    expect(typeof normal?.expiresAt).toBe('number');
    expect(normal?.neverExpire).toBe(false);
    store.close();
  });
});

describe('self-update routes — applyWhenIdle + idle status (W12c)', () => {
  it('PUT /settings forwards applyWhenIdle; GET /idle reports the gate state', async () => {
    let settings = { autoCheck: true, checkIntervalHours: 24, applyWhenIdle: false };
    const status = (): UpdateStatus => ({
      state: 'ready',
      currentVersion: '0.1.0',
      latest: null,
      asset: null,
      downloadedPath: '/x/installer',
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      lastCheckedAt: null,
      lastError: null,
      previousInstaller: null,
      platform: 'linux',
      arch: 'x64',
    });
    const saved: Array<Record<string, unknown>> = [];
    const fakeUpdater = {
      getStatus: async () => status(),
      checkNow: async () => status(),
      download: async () => status(),
      install: async () => ({ ...status(), state: 'installing' as const }),
      getSettings: async () => ({ ...settings }),
      saveSettings: async (s: Partial<typeof settings>) => {
        saved.push(s as Record<string, unknown>);
        settings = { ...settings, ...s };
        return { ...settings };
      },
    };
    const idleUpdater = new IdleAutoUpdater({
      source: fakeUpdater,
      isBusy: () => false,
      now: () => Date.now(),
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/updates',
      createSelfUpdateRouter(fakeUpdater as never, { idleUpdater }),
    );
    await listen(app);

    const put = (await (
      await fetch(`${base}/api/updates/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applyWhenIdle: true }),
      })
    ).json()) as { settings: { applyWhenIdle: boolean } };
    expect(put.settings.applyWhenIdle).toBe(true);
    expect(saved[0]).toMatchObject({ applyWhenIdle: true });

    const idle = (await (await fetch(`${base}/api/updates/idle`)).json()) as {
      idle: { applyWhenIdle: boolean; pendingUpdate: boolean; idleThresholdMs: number };
    };
    expect(idle.idle.applyWhenIdle).toBe(true);
    expect(idle.idle.pendingUpdate).toBe(true);
    expect(idle.idle.idleThresholdMs).toBe(10 * 60 * 1000);
  });

  it('GET /idle is 404 when no idle updater is wired', async () => {
    const fakeUpdater = {
      getStatus: async () => ({}),
      getSettings: async () => ({ autoCheck: true, checkIntervalHours: 24, applyWhenIdle: false }),
      saveSettings: async (s: unknown) => s,
    };
    const app = express();
    app.use(express.json());
    app.use('/api/updates', createSelfUpdateRouter(fakeUpdater as never));
    await listen(app);
    const res = await fetch(`${base}/api/updates/idle`);
    expect(res.status).toBe(404);
  });
});
