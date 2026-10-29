// SPDX-License-Identifier: Apache-2.0
// Plugin routes: real HTTP against a real PluginManager on a temp data dir
// with the shipped demo plugins. Zero network (URL installs are covered in
// the @mvp/plugins package tests via an injected fetch).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginManager } from '@mvp/plugins';
import { buildPluginTools, createPluginRouter, registerPluginChannels } from '../src/plugin-routes.js';
import { listMessageProviders } from '../src/messaging.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', '..', '..', 'packages', 'plugins', 'examples');
const demo = (name: string) => join(EXAMPLES, name);

let manager: PluginManager;
let server: { close(cb: () => void): void } | undefined;
let baseUrl = '';
const audits: Array<{ action: string }> = [];

function makeApp(mgr: PluginManager) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createPluginRouter({ manager: mgr, audit: (action) => void audits.push({ action }) }),
  );
  return app;
}

beforeEach(async () => {
  audits.length = 0;
  manager = new PluginManager({
    dataDir: mkdtempSync(join(tmpdir(), 'plugin-routes-test-')),
    approveInstall: () => true,
  });
  const app = makeApp(manager);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const port = (server as unknown as { address(): { port: number } }).address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(baseUrl + path, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers, text };
}

const post = (path: string, data?: unknown) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

describe('plugin routes', () => {
  it('installs from a directory, lists, and uninstalls', async () => {
    const installed = await post('/api/plugins/install', { source: 'dir', path: demo('demo-toolkit') });
    expect(installed.status).toBe(201);
    expect((installed.body.plugin as { id: string }).id).toBe('demo-toolkit');
    expect(audits.map((a) => a.action)).toContain('plugin.installed');

    const list = await api('/api/plugins');
    const plugins = list.body.plugins as Array<{ id: string; enabled: boolean; kinds: string[] }>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ id: 'demo-toolkit', enabled: true, kinds: ['tool'] });

    const del = await api('/api/plugins/demo-toolkit', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await api('/api/plugins')).body.plugins as unknown[])).toHaveLength(0);
    const delAgain = await api('/api/plugins/demo-toolkit', { method: 'DELETE' });
    expect(delAgain.status).toBe(404);
  });

  it('enable/disable toggles state over HTTP', async () => {
    await post('/api/plugins/install', { source: 'dir', path: demo('demo-toolkit') });
    const disabled = await post('/api/plugins/demo-toolkit/disable');
    expect((disabled.body.plugin as { enabled: boolean }).enabled).toBe(false);
    const enabled = await post('/api/plugins/demo-toolkit/enable');
    expect((enabled.body.plugin as { enabled: boolean }).enabled).toBe(true);
    const missing = await post('/api/plugins/nope/enable');
    expect(missing.status).toBe(404);
  });

  it('rejects a bad install source', async () => {
    const bad = await post('/api/plugins/install', { source: 'carrier-pigeon', path: '/x' });
    expect(bad.status).toBe(400);
    const missing = await post('/api/plugins/install', { source: 'dir', path: '/does/not/exist' });
    expect(missing.status).toBe(400);
  });

  it('buildPluginTools exposes prefixed, callable ToolDefinitions', async () => {
    await post('/api/plugins/install', { source: 'dir', path: demo('demo-toolkit') });
    const tools = await buildPluginTools(manager);
    expect(tools.map((t) => t.name)).toEqual(['plugin:demo-toolkit:wordcount', 'plugin:demo-toolkit:timestamp']);
    const wc = tools.find((t) => t.name.endsWith('wordcount'))!;
    const out = (await wc.handler({ text: 'alpha beta' }, { sessionId: 's', botId: 'b' } as never)) as { words: number };
    expect(out.words).toBe(2);
  });

  it('registerPluginChannels bridges channel plugins into the messaging registry', async () => {
    await post('/api/plugins/install', { source: 'dir', path: demo('demo-channel') });
    const ids = registerPluginChannels(manager);
    expect(ids).toEqual(['plugin-demo-channel']);
    expect(listMessageProviders()).toContain('plugin-demo-channel');
  });

  it('serves UI assets with sandboxed headers and blocks traversal', async () => {
    await post('/api/plugins/install', { source: 'dir', path: demo('demo-ui') });
    const page = await api('/api/plugins/demo-ui/ui/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Demo Panel');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain('sandbox');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const css = await api('/api/plugins/demo-ui/ui/style.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    const traversal = await api('/api/plugins/demo-ui/ui/%2e%2e%2fplugin.json');
    expect([400, 404]).toContain(traversal.status);
    expect(traversal.text).not.toContain('"demo-ui"');
  });

  it('install denied by the approval hook surfaces as 403', async () => {
    const denying = new PluginManager({
      dataDir: mkdtempSync(join(tmpdir(), 'plugin-routes-deny-')),
      approveInstall: () => false,
    });
    const app = makeApp(denying);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'dir', path: demo('demo-toolkit') }),
      });
      expect(res.status).toBe(403);
    } finally {
      srv.close();
    }
  });
});
