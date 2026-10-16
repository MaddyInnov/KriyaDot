// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { SelfUpdateManager, UpdateStatus, UpdateSettings } from '@mvp/agent-runtime';
import { createSelfUpdateRouter } from '../src/self-update-routes.js';

function fakeStatus(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    state: 'idle',
    currentVersion: '0.1.0-alpha',
    latest: null,
    asset: null,
    downloadedPath: null,
    downloadedBytes: 0,
    totalBytes: 0,
    progress: 0,
    lastCheckedAt: null,
    lastError: null,
    previousInstaller: null,
    platform: 'linux',
    arch: 'x64',
    ...over,
  };
}

function makeUpdater(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const updater = {
    getStatus: async () => fakeStatus(),
    checkNow: async () => {
      calls.push('checkNow');
      return fakeStatus({ state: 'available' });
    },
    download: async () => {
      calls.push('download');
      return fakeStatus({ state: 'ready' });
    },
    install: async () => {
      calls.push('install');
      return fakeStatus({ state: 'installing' });
    },
    getSettings: async () => ({ autoCheck: true, checkIntervalHours: 24 }),
    saveSettings: async (s: Partial<UpdateSettings>) => {
      calls.push(`saveSettings:${JSON.stringify(s)}`);
      return { autoCheck: true, checkIntervalHours: 24, ...s };
    },
    ...over,
  };
  return { updater: updater as unknown as SelfUpdateManager, calls };
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function req(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('self-update routes', () => {
  let base = '';
  let server: { close: (cb?: () => void) => void } | null = null;
  let calls: string[] = [];

  async function boot(over: Partial<Record<string, unknown>> = {}) {
    const m = makeUpdater(over);
    calls = m.calls;
    const app = express();
    app.use(express.json());
    app.use('/api/updates', createSelfUpdateRouter(m.updater));
    const l = await listen(app);
    server = l.server;
    base = l.base;
  }

  afterEach(() => {
    if (server) {
      const s = server;
      server = null;
      return new Promise<void>((resolve) => s.close(() => resolve()));
    }
    return undefined;
  });

  it('GET /status returns the manager status', async () => {
    await boot();
    const { status, json } = await req(base, 'GET', '/api/updates/status');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect((json.status as UpdateStatus).currentVersion).toBe('0.1.0-alpha');
  });

  it('POST /check triggers a check and returns the new status', async () => {
    await boot();
    const { status, json } = await req(base, 'POST', '/api/updates/check');
    expect(status).toBe(200);
    expect((json.status as UpdateStatus).state).toBe('available');
    expect(calls).toContain('checkNow');
  });

  it('POST /download forwards to the manager (consent-gated there)', async () => {
    await boot();
    const { status, json } = await req(base, 'POST', '/api/updates/download');
    expect(status).toBe(200);
    expect((json.status as UpdateStatus).state).toBe('ready');
    expect(calls).toContain('download');
  });

  it('POST /download returns 409 when the manager refuses (no consent state)', async () => {
    await boot({
      download: async () => {
        throw new Error('No update is available to download. Run a check first.');
      },
    });
    const { status, json } = await req(base, 'POST', '/api/updates/download');
    expect(status).toBe(409);
    expect(json.ok).toBe(false);
    expect(String(json.error)).toMatch(/No update is available/);
  });

  it('POST /install returns 409 when nothing is ready', async () => {
    await boot({
      install: async () => {
        throw new Error('No downloaded update is ready to install.');
      },
    });
    const { status, json } = await req(base, 'POST', '/api/updates/install');
    expect(status).toBe(409);
    expect(json.ok).toBe(false);
  });

  it('PUT /settings saves and GET /settings reads', async () => {
    await boot();
    const put = await req(base, 'PUT', '/api/updates/settings', {
      autoCheck: false,
      checkIntervalHours: 48,
    });
    expect(put.status).toBe(200);
    expect((put.json.settings as UpdateSettings).autoCheck).toBe(false);
    expect((put.json.settings as UpdateSettings).checkIntervalHours).toBe(48);

    const get = await req(base, 'GET', '/api/updates/settings');
    expect((get.json.settings as UpdateSettings).checkIntervalHours).toBe(24);
  });

  it('scrubs absolute paths from error messages', async () => {
    await boot({
      checkNow: async () => {
        throw new Error('boom at /home/hatch/secret/place');
      },
    });
    const { status, json } = await req(base, 'POST', '/api/updates/check');
    expect(status).toBe(500);
    expect(String(json.error)).not.toContain('/home/hatch');
  });
});
