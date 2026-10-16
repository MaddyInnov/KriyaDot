// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { productAnalytics } from '@mvp/agent-runtime';
import { createAnalyticsRouter } from '../src/analytics-routes.js';
import {
  loadAnalyticsSettings,
  saveAnalyticsSettings,
  sanitizeAnalyticsSettings,
} from '../src/analytics-settings.js';

function makeApp(dataDir: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', createAnalyticsRouter({ dataDir }));
  return app;
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('analytics settings persistence', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    productAnalytics.updateSettings({ enabled: false, crashReporting: false, endpoint: '' });
    productAnalytics.clearQueue();
    productAnalytics.clearCrashes();
  });

  it('defaults to all-off when no file and no env', () => {
    const s = loadAnalyticsSettings(dataDir);
    expect(s).toEqual({ enabled: false, crashReporting: false, endpoint: '' });
  });

  it('round-trips through the file', () => {
    saveAnalyticsSettings(dataDir, { enabled: true, crashReporting: true, endpoint: 'https://x.example.com' });
    expect(loadAnalyticsSettings(dataDir)).toEqual({
      enabled: true,
      crashReporting: true,
      endpoint: 'https://x.example.com',
    });
  });

  it('sanitize rejects non-boolean and non-http endpoints', () => {
    const s = sanitizeAnalyticsSettings({ enabled: 'yes', crashReporting: 1, endpoint: 'file:///etc/passwd' });
    expect(s).toEqual({ enabled: false, crashReporting: false, endpoint: '' });
  });

  it('sanitize accepts https endpoint', () => {
    const s = sanitizeAnalyticsSettings({ enabled: true, endpoint: 'https://analytics.example.com/collect' });
    expect(s.endpoint).toBe('https://analytics.example.com/collect');
  });
});

describe('analytics routes', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-routes-test-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    productAnalytics.updateSettings({ enabled: false, crashReporting: false, endpoint: '' });
    productAnalytics.clearQueue();
    productAnalytics.clearCrashes();
  });

  it('GET /settings returns defaults (off)', async () => {
    const { server, base } = await listen(makeApp(dataDir));
    try {
      const res = await fetch(`${base}/api/analytics/settings`);
      const body = (await res.json()) as { ok: boolean; settings: object };
      expect(body.ok).toBe(true);
      expect(body.settings).toEqual({ enabled: false, crashReporting: false, endpoint: '' });
    } finally {
      server.close();
    }
  });

  it('PUT /settings persists and applies toggles', async () => {
    const { server, base } = await listen(makeApp(dataDir));
    try {
      const res = await fetch(`${base}/api/analytics/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, crashReporting: false, endpoint: '' }),
      });
      const body = (await res.json()) as { ok: boolean; settings: { enabled: boolean } };
      expect(body.ok).toBe(true);
      expect(body.settings.enabled).toBe(true);
      expect(productAnalytics.isEnabled).toBe(true);
      // persisted
      expect(loadAnalyticsSettings(dataDir).enabled).toBe(true);
    } finally {
      server.close();
    }
  });

  it('GET /events shows queued events (empty when disabled)', async () => {
    const { server, base } = await listen(makeApp(dataDir));
    try {
      productAnalytics.track('bot_created', { botId: 'x' }); // no-op: disabled
      const res = await fetch(`${base}/api/analytics/events`);
      const body = (await res.json()) as { ok: boolean; events: unknown[] };
      expect(body.ok).toBe(true);
      expect(body.events).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('GET /events shows events when enabled', async () => {
    const { server, base } = await listen(makeApp(dataDir));
    try {
      productAnalytics.updateSettings({ enabled: true });
      productAnalytics.track('bot_created', { botId: 'scout' });
      const res = await fetch(`${base}/api/analytics/events`);
      const body = (await res.json()) as { ok: boolean; events: Array<{ event: string }> };
      expect(body.events).toHaveLength(1);
      expect(body.events[0].event).toBe('bot_created');
    } finally {
      server.close();
    }
  });

  it('POST /events/clear empties the queue', async () => {
    const { server, base } = await listen(makeApp(dataDir));
    try {
      productAnalytics.updateSettings({ enabled: true });
      productAnalytics.track('bot_created', {});
      await fetch(`${base}/api/analytics/events/clear`, { method: 'POST' });
      expect(productAnalytics.queueSize).toBe(0);
    } finally {
      server.close();
    }
  });

  it('crash endpoints work', async () => {
    const { server, base } = await listen(makeApp(dataDir));
    try {
      productAnalytics.updateSettings({ crashReporting: true });
      productAnalytics.reportCrash(new Error('test crash'));
      const res = await fetch(`${base}/api/analytics/crashes`);
      const body = (await res.json()) as { ok: boolean; crashes: unknown[] };
      expect(body.crashes).toHaveLength(1);
      await fetch(`${base}/api/analytics/crashes/clear`, { method: 'POST' });
      expect(productAnalytics.getCrashes()).toEqual([]);
    } finally {
      server.close();
    }
  });
});
