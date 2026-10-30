// SPDX-License-Identifier: Apache-2.0
// #53: LazyMcpManager addServer/removeServer (live + persisted).
// #54: mcp-<name>.json override files (layered, auto-binding).
// #56: 120s health interval constant + terminal Failed state.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LazyMcpManager,
  MCP_HEALTH_CHECK_INTERVAL_MS,
  loadMcpOverrideFiles,
  mergeServerConfig,
  parseMcpOverride,
  type InstalledMcpServer,
  type LazyMcpConnector,
} from '../src/mcp-directory.js';
import type { ToolDefinition } from '../src/types.js';

const dirs: string[] = [];
const managers: LazyMcpManager[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-ext-test-'));
  dirs.push(d);
  return d;
}

function fakeConnector(tools: string[] = ['thing']): LazyMcpConnector {
  return {
    async listTools(): Promise<ToolDefinition[]> {
      return tools.map((name) => ({
        name: `mcp:fake:${name}`,
        description: name,
        parameters: { type: 'object', properties: {} },
        handler: async () => ({ called: name }),
      }));
    },
    async close() {},
    async ping() {},
  };
}

function makeManager(opts: Partial<ConstructorParameters<typeof LazyMcpManager>[0]> = {}): LazyMcpManager {
  const m = new LazyMcpManager({
    dataDir: freshDir(),
    healthCheckIntervalMs: 0,
    connectFn: async () => fakeConnector(),
    ...opts,
  });
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('addServer / removeServer (#53)', () => {
  it('addServer persists AND connects live; a fresh manager over the same dataDir still lists it', async () => {
    const dataDir = freshDir();
    const connectSpy = vi.fn(async (_s: InstalledMcpServer) => fakeConnector());
    const m1 = new LazyMcpManager({ dataDir, healthCheckIntervalMs: 0, connectFn: connectSpy });
    managers.push(m1);
    const added = await m1.addServer({ label: 'custom', config: { kind: 'stdio', command: 'node', args: ['srv.js'] } });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(m1.status(added.id).status).toBe('running');
    await m1.close();
    managers.splice(managers.indexOf(m1), 1);

    // Restart: a brand-new manager over the same dataDir sees the server.
    const m2 = new LazyMcpManager({ dataDir, healthCheckIntervalMs: 0, connectFn: connectSpy });
    managers.push(m2);
    const listed = m2.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.label).toBe('custom');
    expect(listed[0]!.config).toMatchObject({ kind: 'stdio', command: 'node', args: ['srv.js'] });
  });

  it('addServer from a directory entry; removeServer disconnects live and deletes the record', async () => {
    const closed: string[] = [];
    const m = makeManager({
      connectFn: async (s: InstalledMcpServer) => ({
        ...fakeConnector(),
        async close() {
          closed.push(s.id);
        },
      }),
    });
    const added = await m.addServer({ directoryId: 'time' });
    expect(added.directoryId).toBe('time');
    expect(m.status(added.id).status).toBe('running');

    await expect(m.removeServer('time')).resolves.toBe(true); // by label
    expect(closed).toContain(added.id);
    expect(m.list()).toHaveLength(0);
    await expect(m.removeServer('time')).resolves.toBe(false); // idempotent
    await expect(m.removeServer('never-existed')).resolves.toBe(false);
  });

  it('a failed live connect still persists the install, with the error in health', async () => {
    const m = makeManager({
      connectFn: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    await expect(
      m.addServer({ label: 'broken', config: { kind: 'stdio', command: 'nope' } }),
    ).rejects.toThrow(/failed to start/);
    expect(m.list().map((s) => s.label)).toContain('broken');
    const listed = m.list().find((s) => s.label === 'broken')!;
    expect(m.status(listed.id).status).toBe('error');
    expect(m.status(listed.id).lastError).toMatch(/ENOENT/);
  });

  it('addServer with connect:false is the classic lazy install', async () => {
    const connectSpy = vi.fn(async (_s: InstalledMcpServer) => fakeConnector());
    const m = makeManager({ connectFn: connectSpy });
    const added = await m.addServer({
      label: 'lazy',
      config: { kind: 'stdio', command: 'node' },
      connect: false,
    });
    expect(connectSpy).not.toHaveBeenCalled();
    expect(m.status(added.id).status).toBe('stopped');
  });
});

describe('override files (#54)', () => {
  function configDirWith(files: Record<string, unknown>): string {
    const dir = freshDir();
    const cfg = join(dir, 'cfg');
    mkdirSync(cfg, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(cfg, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return cfg;
  }

  it('parses bare and seed-wrapped forms; kind is inferred like the seed loader', () => {
    const bare = parseMcpOverride('fetch', { command: 'npx', args: ['-y', 'x'] });
    expect(bare.config).toMatchObject({ kind: 'stdio', command: 'npx' });
    const wrapped = parseMcpOverride('api', { mcpServers: { api: { url: 'https://example.com/mcp' } } });
    expect(wrapped.config).toMatchObject({ kind: 'http', url: 'https://example.com/mcp' });
    expect(() => parseMcpOverride('api', { mcpServers: { other: {} } })).toThrow(/no "mcpServers.api"/);
  });

  it('mergeServerConfig: override wins per-field, omitted fields keep base values', () => {
    const merged = mergeServerConfig(
      { kind: 'stdio', command: 'npx', args: ['-y', 'old'], env: { A: '1' } },
      { args: ['-y', 'new'] },
    );
    expect(merged).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', 'new'], env: { A: '1' } });
  });

  it('layers an override over an installed server and persists the result', async () => {
    const cfg = configDirWith({ 'mcp-fetch.json': { args: ['-y', 'new-pkg'], env: { TOKEN: 'x' } } });
    const m = makeManager();
    const base = m.installCustom('fetch', { kind: 'stdio', command: 'npx', args: ['-y', 'old-pkg'] });
    const applied = m.applyOverrideFiles(cfg);
    expect(applied).toEqual([{ label: 'fetch', action: 'updated', server: expect.objectContaining({ id: base.id }) }]);
    expect(m.store.get(base.id)?.config).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', 'new-pkg'],
      env: { TOKEN: 'x' },
    });
  });

  it('auto-binds a server that exists only as an override file', () => {
    const cfg = configDirWith({ 'mcp-solo.json': { command: 'node', args: ['solo.js'] } });
    const m = makeManager();
    const applied = m.applyOverrideFiles(cfg);
    expect(applied[0]).toMatchObject({ label: 'solo', action: 'installed' });
    expect(m.list().map((s) => s.label)).toContain('solo');
    expect(m.store.findByLabel('solo')?.config.command).toBe('node');
  });

  it('an override with enabled:false disables the server', () => {
    const cfg = configDirWith({ 'mcp-fetch.json': { enabled: false } });
    const m = makeManager();
    const s = m.installCustom('fetch', { kind: 'stdio', command: 'npx' });
    m.applyOverrideFiles(cfg);
    expect(m.store.get(s.id)?.enabled).toBe(false);
  });

  it('an incomplete override for an unknown server is an error, not a silent skip', () => {
    const cfg = configDirWith({ 'mcp-ghost.json': { env: { A: '1' } } });
    const m = makeManager();
    expect(() => m.applyOverrideFiles(cfg)).toThrow();
    expect(m.list()).toHaveLength(0);
  });

  it('constructor overrideConfigDir applies overrides at boot; missing dir is a no-op', () => {
    const cfg = configDirWith({ 'mcp-boot.json': { url: 'https://example.com/mcp' } });
    const m = makeManager({ overrideConfigDir: cfg });
    expect(m.list().map((s) => s.label)).toContain('boot');
    expect(loadMcpOverrideFiles(join(freshDir(), 'does-not-exist'))).toEqual([]);
  });

  it('malformed JSON in an override file fails loud, naming the file', () => {
    const cfg = configDirWith({ 'mcp-bad.json': '{not json' });
    expect(() => loadMcpOverrideFiles(cfg)).toThrow(/mcp-bad\.json/);
  });
});

describe('health loop spec (#56)', () => {
  it('the spec interval constant is 120s', () => {
    expect(MCP_HEALTH_CHECK_INTERVAL_MS).toBe(120_000);
  });

  it('a failed probe + failed auto-restart lands in terminal Failed, leaves the probe set, and revives manually', async () => {
    let failConnect = false;
    let connectCalls = 0;
    const m = makeManager({
      connectFn: async () => {
        connectCalls += 1;
        if (failConnect) throw new Error('still dead');
        return {
          ...fakeConnector(),
          async ping() {
            throw new Error('connection dead');
          },
        };
      },
    });
    const server = m.installCustom('flaky', { kind: 'stdio', command: 'true' });
    await m.warmUp(server.id);
    expect(m.status(server.id).status).toBe('running');

    failConnect = true;
    await m.checkHealthOnce();
    const failed = m.status(server.id);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('auto-restart failed');
    // Still installed + listed, with the reason.
    expect(m.list().map((s) => s.label)).toContain('flaky');

    // Out of the probe set: another sweep does not retry the connect.
    const callsAfterFail = connectCalls;
    await m.checkHealthOnce();
    expect(connectCalls).toBe(callsAfterFail);
    expect(m.status(server.id).status).toBe('failed');

    // Manual restart revives it.
    failConnect = false;
    // The revived connector's ping must succeed this time.
    const revived = await m.restartServer(server.id);
    expect(revived.status).toBe('running');
  });

  it('health timestamps come from the injected clock', async () => {
    const fixed = Date.parse('2026-10-30T00:00:00.000Z');
    const m = makeManager({ now: () => fixed });
    const server = m.installCustom('clocked', { kind: 'stdio', command: 'true' });
    await m.warmUp(server.id);
    await m.checkHealthOnce();
    expect(m.status(server.id).lastCheckAt).toBe('2026-10-30T00:00:00.000Z');
  });
});
