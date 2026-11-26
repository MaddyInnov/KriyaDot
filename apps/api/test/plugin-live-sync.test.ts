// SPDX-License-Identifier: Apache-2.0
// A9 residual 3: hot-installed plugins' hook-bus and channel-provider
// registrations go LIVE on install — no restart, no reload. Real HTTP
// against a real PluginManager + a real HookBus + the real messaging
// registry, using the shipped demo hook/channel plugins (real child
// processes over stdio). Covers: install → hook fires / channel visible;
// uninstall → both gone; reinstall → exactly one registration; disable /
// enable toggling; and the C-1 gate — a plugin whose installed tree
// drifts from its install baseline registers NOTHING after the
// loadAll() re-verification marks it broken.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginManager } from '@mvp/plugins';
import { HookBus } from '@mvp/agent-runtime';
import { createPluginLiveSync, createPluginRouter, type PluginLiveSyncHandle } from '../src/plugin-routes.js';
import { getMessageProvider, listMessageProviders } from '../src/messaging.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', '..', '..', 'packages', 'plugins', 'examples');
const demo = (name: string) => join(EXAMPLES, name);

let manager: PluginManager;
let dataDir: string;
let bus: HookBus;
let liveSync: PluginLiveSyncHandle;
let server: { close(cb: () => void): void } | undefined;
let baseUrl = '';

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'plugin-live-sync-'));
  manager = new PluginManager({ dataDir, approveInstall: () => true });
  bus = new HookBus();
  liveSync = createPluginLiveSync({ manager, hookBus: bus });
  const app = express();
  app.use(express.json());
  app.use('/api', createPluginRouter({ manager, liveSync }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  baseUrl = `http://127.0.0.1:${(server as unknown as { address(): { port: number } }).address().port}`;
});

afterEach(async () => {
  liveSync.dispose();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(baseUrl + path, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

const install = (name: string) =>
  api('/api/plugins/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'dir', path: demo(name) }),
  });

const uninstall = (id: string) => api(`/api/plugins/${id}`, { method: 'DELETE' });

async function emitTurnEnding(): Promise<{ injections: string[]; errors: unknown[] }> {
  const result = await bus.emit('turn.ending', { sessionId: 's', botId: 'b', finalContent: 'x', toolsExecuted: 0 });
  return result as unknown as { injections: string[]; errors: unknown[] };
}

describe('live hook registration (A9 residual 3)', () => {
  it('hot install → hook fires without restart; uninstall → gone; reinstall → exactly one', async () => {
    expect(bus.handlerCount('turn.ending')).toBe(0);

    const installed = await install('demo-hook');
    expect(installed.status).toBe(201);
    // Registered on the running bus by the install mutation itself.
    expect(bus.handlerCount('turn.ending')).toBe(1);
    expect(liveSync.hookPluginIds()).toEqual(['demo-hook']);
    const fired = await emitTurnEnding();
    expect(fired.errors).toEqual([]);
    expect(fired.injections).toHaveLength(1);
    expect(fired.injections[0]).toContain('footer');

    const removed = await uninstall('demo-hook');
    expect(removed.status).toBe(200);
    expect(bus.handlerCount('turn.ending')).toBe(0);
    expect(liveSync.hookPluginIds()).toEqual([]);
    const afterRemove = await emitTurnEnding();
    expect(afterRemove.injections).toEqual([]);

    // Reinstall: exactly one handler, exactly one injection — no doubles.
    const reinstalled = await install('demo-hook');
    expect(reinstalled.status).toBe(201);
    expect(bus.handlerCount('turn.ending')).toBe(1);
    const refired = await emitTurnEnding();
    expect(refired.injections).toHaveLength(1);

    // A redundant sync is a no-op (idempotent diff).
    const again = liveSync.sync();
    expect(again.hooksAdded).toEqual([]);
    expect(again.hooksRemoved).toEqual([]);
    expect(bus.handlerCount('turn.ending')).toBe(1);
  });

  it('disable deregisters the hook and enable re-registers it, once', async () => {
    await install('demo-hook');
    expect(bus.handlerCount('turn.ending')).toBe(1);

    const disabled = await api('/api/plugins/demo-hook/disable', { method: 'POST' });
    expect(disabled.status).toBe(200);
    expect(bus.handlerCount('turn.ending')).toBe(0);
    expect((await emitTurnEnding()).injections).toEqual([]);

    const enabled = await api('/api/plugins/demo-hook/enable', { method: 'POST' });
    expect(enabled.status).toBe(200);
    expect(bus.handlerCount('turn.ending')).toBe(1);
    expect((await emitTurnEnding()).injections).toHaveLength(1);
  });
});

describe('live channel registration (A9 residual 3)', () => {
  it('hot install → provider listed + usable; uninstall → gone; reinstall → single entry', async () => {
    expect(listMessageProviders()).not.toContain('plugin-demo-channel');

    const installed = await install('demo-channel');
    expect(installed.status).toBe(201);
    expect(listMessageProviders()).toContain('plugin-demo-channel');
    expect(liveSync.channelProviderIds()).toEqual(['plugin-demo-channel']);

    // The registered provider actually works through the registry.
    const provider = getMessageProvider('plugin-demo-channel', dataDir) as unknown as {
      send(to: string, text: string): Promise<{ ok: boolean }>;
      poll(): Promise<Array<{ text?: string }>>;
    };
    expect((await provider.send('room-1', 'hello')).ok).toBe(true);
    const polled = await provider.poll();
    expect(polled).toHaveLength(1);
    expect(polled[0]?.text).toBe('echo: hello');

    const removed = await uninstall('demo-channel');
    expect(removed.status).toBe(200);
    expect(listMessageProviders()).not.toContain('plugin-demo-channel');
    expect(liveSync.channelProviderIds()).toEqual([]);
    expect(() => getMessageProvider('plugin-demo-channel', dataDir)).toThrow(/Unknown message provider/);

    const reinstalled = await install('demo-channel');
    expect(reinstalled.status).toBe(201);
    // Exactly one registry entry under the provider id after the cycle.
    expect(listMessageProviders().filter((id) => id === 'plugin-demo-channel')).toHaveLength(1);
    expect(liveSync.channelProviderIds()).toEqual(['plugin-demo-channel']);
  });
});

describe('C-1 integrity gate on the live path', () => {
  it('a plugin whose tree drifts after install is deregistered once loadAll marks it broken, and a broken plugin registers nothing', async () => {
    await install('demo-hook');
    await install('demo-channel');
    expect(bus.handlerCount('turn.ending')).toBe(1);
    expect(listMessageProviders()).toContain('plugin-demo-channel');

    // Drift: rewrite both installed entry files behind the manager's back.
    const hookRec = manager.get('demo-hook')!;
    writeFileSync(join(hookRec.dir, 'index.js'), 'console.log("drifted");\n');
    const channelRec = manager.get('demo-channel')!;
    writeFileSync(join(channelRec.dir, 'index.js'), 'console.log("drifted");\n');

    // The C-1 gate: loadAll re-verifies the trees against the install
    // baselines and marks both plugins broken (listed, never served).
    const report = manager.loadAll();
    expect(report.failed.map((f) => f.id).sort()).toEqual(['demo-channel', 'demo-hook']);

    // The next live sync (what every mutation triggers) removes every
    // registration the drifted plugins held.
    const result = liveSync.sync();
    expect(result.hooksRemoved).toEqual(['demo-hook']);
    expect(result.channelsRemoved).toEqual(['plugin-demo-channel']);
    expect(bus.handlerCount('turn.ending')).toBe(0);
    expect(listMessageProviders()).not.toContain('plugin-demo-channel');
    expect((await emitTurnEnding()).injections).toEqual([]);

    // And a fresh sync handle over the broken manager registers nothing.
    const bus2 = new HookBus();
    const handle2 = createPluginLiveSync({ manager, hookBus: bus2 });
    const fresh = handle2.sync();
    expect(fresh.hooksAdded).toEqual([]);
    expect(fresh.channelsAdded).toEqual([]);
    expect(bus2.handlerCount('turn.ending')).toBe(0);
    handle2.dispose();
  });

  it('router-owned handle (hookBus dep, no shared liveSync) also goes live on install', async () => {
    // Second app whose router owns its handle — the test/host idiom.
    const bus2 = new HookBus();
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', createPluginRouter({ manager, hookBus: bus2 }));
    const srv2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv2.once('listening', () => r()));
    const port2 = (srv2.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/api/plugins/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'dir', path: demo('demo-hook') }),
      });
      expect(res.status).toBe(201);
      expect(bus2.handlerCount('turn.ending')).toBe(1);
      const del = await fetch(`http://127.0.0.1:${port2}/api/plugins/demo-hook`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(bus2.handlerCount('turn.ending')).toBe(0);
    } finally {
      srv2.close();
    }
  });
});
