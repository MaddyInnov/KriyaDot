// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LazyMcpManager,
  LazyMcpServerStore,
  MCP_DIRECTORY,
  getDirectoryEntry,
  validateServerConfig,
  validateServerLabel,
  type InstalledMcpServer,
  type LazyMcpConnector,
} from '../src/mcp-directory.js';
import type { ToolDefinition } from '../src/types.js';

let dir: string;
const dirs: string[] = [];
const managers: LazyMcpManager[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-dir-test-'));
  dirs.push(d);
  return d;
}

function fakeConnector(tools: Array<{ name: string; description?: string }> = []): LazyMcpConnector {
  return {
    async listTools(): Promise<ToolDefinition[]> {
      return tools.map((t) => ({
        name: `mcp:fake:${t.name}`,
        description: t.description ?? t.name,
        parameters: { type: 'object', properties: {} },
        handler: async (args) => ({ called: t.name, args }),
      }));
    },
    async close() {},
  };
}

function makeManager(connectSpy?: ReturnType<typeof vi.fn>): LazyMcpManager {
  const connectFn = connectSpy ?? vi.fn(async (_s: InstalledMcpServer) => fakeConnector([{ name: 'thing' }]));
  const m = new LazyMcpManager({ dataDir: freshDir(), connectFn });
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('MCP directory curation', () => {
  it('ships a non-empty directory with valid entries', () => {
    expect(MCP_DIRECTORY.length).toBeGreaterThan(5);
    for (const e of MCP_DIRECTORY) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.tools.length).toBeGreaterThan(0);
      if (e.kind === 'stdio') expect(e.command).toBeTruthy();
      validateServerLabel(e.id);
    }
  });

  it('resolves entries by id', () => {
    expect(getDirectoryEntry('fetch')?.name).toBe('Fetch');
    expect(getDirectoryEntry('nope')).toBeUndefined();
  });
});

describe('label/config validation', () => {
  it('rejects bad labels', () => {
    expect(() => validateServerLabel('')).toThrow();
    expect(() => validateServerLabel('has:colon')).toThrow();
    expect(() => validateServerLabel('has space')).toThrow();
    validateServerLabel('fetch-2_ok');
  });

  it('rejects bad configs', () => {
    expect(() => validateServerConfig({ kind: 'stdio' })).toThrow();
    expect(() => validateServerConfig({ kind: 'http', url: 'not-a-url' })).toThrow();
    expect(() => validateServerConfig({ kind: 'http', url: 'ftp://x' })).toThrow();
    validateServerConfig({ kind: 'stdio', command: 'npx', args: ['-y', 'x'] });
    validateServerConfig({ kind: 'http', url: 'https://example.com/mcp' });
  });
});

describe('LazyMcpServerStore', () => {
  it('installs, lists, enables/disables, removes', () => {
    dir = freshDir();
    const store = new LazyMcpServerStore(join(dir, 'mcp-directory.db'));
    const s = store.install('fetch', 'fetch', { kind: 'stdio', command: 'npx', args: ['-y', 'x'] });
    expect(s.enabled).toBe(true);
    expect(s.directoryId).toBe('fetch');
    expect(store.list()).toHaveLength(1);
    store.setEnabled(s.id, false);
    expect(store.get(s.id)?.enabled).toBe(false);
    store.remove(s.id);
    expect(store.list()).toHaveLength(0);
    expect(() => store.setEnabled(s.id, false)).toThrow();
    store.close();
  });

  it('rejects duplicate labels', () => {
    dir = freshDir();
    const store = new LazyMcpServerStore(join(dir, 'mcp-directory.db'));
    store.install(null, 'dup', { kind: 'stdio', command: 'npx' });
    expect(() => store.install(null, 'dup', { kind: 'stdio', command: 'npx' })).toThrow(/already installed/);
    store.close();
  });

  it('per-bot overrides default to allowed', () => {
    dir = freshDir();
    const store = new LazyMcpServerStore(join(dir, 'mcp-directory.db'));
    const s = store.install('fetch', 'fetch', { kind: 'stdio', command: 'npx' });
    expect(store.isBotAllowed(s.id, 'bot-a')).toBe(true);
    store.setBotEnabled(s.id, 'bot-a', false);
    expect(store.isBotAllowed(s.id, 'bot-a')).toBe(false);
    expect(store.isBotAllowed(s.id, 'bot-b')).toBe(true);
    expect(store.botOverrides(s.id)).toEqual([{ botId: 'bot-a', enabled: false }]);
    store.close();
  });
});

describe('LazyMcpManager', () => {
  it('install from directory registers config without connecting', async () => {
    const connectSpy = vi.fn(async (_s: InstalledMcpServer) => fakeConnector());
    const m = makeManager(connectSpy);
    const s = m.installFromDirectory('time');
    expect(s.directoryId).toBe('time');
    expect(s.label).toBe('time');
    expect(connectSpy).not.toHaveBeenCalled();
    expect(m.status(s.id).status).toBe('stopped');
    expect(() => m.installFromDirectory('nope')).toThrow();
  });

  it('exposes install state on the directory', () => {
    const m = makeManager();
    const before = m.directoryWithInstallState().find((e) => e.id === 'fetch');
    expect(before?.installed).toBe(false);
    const s = m.installFromDirectory('fetch');
    const after = m.directoryWithInstallState().find((e) => e.id === 'fetch');
    expect(after?.installed).toBe(true);
    expect(after?.serverId).toBe(s.id);
  });

  it('stub defs only cover enabled + bot-allowed servers, and connect lazily', async () => {
    const calls: string[] = [];
    const connectSpy = vi.fn(async (s: InstalledMcpServer) => {
      calls.push(s.label);
      return fakeConnector([{ name: 'fetch' }]);
    });
    const m = makeManager(connectSpy);
    const a = m.installFromDirectory('fetch');
    const b = m.installFromDirectory('time');
    m.setEnabled(b.id, false);
    m.setBotEnabled(a.id, 'bot-x', false);

    const defsAll = m.stubToolDefinitions();
    expect(defsAll.some((d) => d.name === 'mcp:fetch:fetch')).toBe(true);
    expect(defsAll.some((d) => d.name.startsWith('mcp:time:'))).toBe(false);

    const defsBotX = m.stubToolDefinitions('bot-x');
    expect(defsBotX.some((d) => d.name === 'mcp:fetch:fetch')).toBe(false);

    // Lazy: no connect until first call.
    expect(connectSpy).not.toHaveBeenCalled();
    const stub = defsAll.find((d) => d.name === 'mcp:fetch:fetch');
    expect(stub).toBeDefined();
    const result = await stub!.handler({ url: 'https://example.com' }, { botId: 'bot-a' } as never);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ called: 'fetch', args: { url: 'https://example.com' } });
    expect(m.status(a.id).status).toBe('running');
    // Second call reuses the connection.
    await stub!.handler({}, { botId: 'bot-a' } as never);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('connect failure marks health error and throws a clear message', async () => {
    const m = makeManager(vi.fn(async () => { throw new Error('spawn ENOENT'); }));
    const s = m.installFromDirectory('fetch');
    const stub = m.stubToolDefinitions().find((d) => d.name === 'mcp:fetch:fetch');
    await expect(stub!.handler({}, { botId: 'b' } as never)).rejects.toThrow(/failed to start/);
    const st = m.status(s.id);
    expect(st.status).toBe('error');
    expect(st.lastError).toMatch(/spawn ENOENT/);
  });

  it('disabled servers never spawn, even if the stub is invoked', async () => {
    const connectSpy = vi.fn(async (_s: InstalledMcpServer) => fakeConnector());
    const m = makeManager(connectSpy);
    const s = m.installFromDirectory('fetch');
    m.setEnabled(s.id, false);
    expect(m.stubToolDefinitions()).toHaveLength(0);
    await expect(m.ensureConnected(s.id)).rejects.toThrow(/disabled/);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('uninstall disconnects and removes', async () => {
    const closed: string[] = [];
    const m = makeManager(
      vi.fn(async (s: InstalledMcpServer) => ({
        ...fakeConnector([{ name: 'fetch' }]),
        async close() { closed.push(s.id); },
      })),
    );
    const s = m.installFromDirectory('fetch');
    await m.warmUp(s.id);
    expect(m.status(s.id).status).toBe('running');
    m.uninstall(s.id);
    expect(m.list()).toHaveLength(0);
    expect(closed).toContain(s.id);
    expect(m.status(s.id).status).toBe('stopped');
  });

  it('custom install validates config', () => {
    const m = makeManager();
    expect(() => m.installCustom('bad label!', { kind: 'stdio', command: 'npx' })).toThrow();
    const s = m.installCustom('custom-srv', { kind: 'http', url: 'https://example.com/mcp' });
    expect(s.directoryId).toBeNull();
  });

  it('syncRegistry adds, updates, and removes only its own stubs', () => {
    const m = makeManager();
    const registry = new Map<string, ToolDefinition>();
    // A seed MCP tool that happens to share the prefix must survive.
    const seedTool: ToolDefinition = {
      name: 'mcp:fetch:fetch',
      description: 'seed fetch',
      parameters: {},
      handler: async () => ({}),
    };
    registry.set(seedTool.name, seedTool);

    const s = m.installFromDirectory('time');
    m.syncRegistry(registry);
    // 'mcp:fetch:fetch' was occupied by the seed tool: no overwrite.
    expect(registry.get('mcp:fetch:fetch')).toBe(seedTool);
    expect(registry.has('mcp:time:get_current_time')).toBe(true);

    m.setEnabled(s.id, false);
    m.syncRegistry(registry);
    expect(registry.has('mcp:time:get_current_time')).toBe(false);
    expect(registry.get('mcp:fetch:fetch')).toBe(seedTool);

    m.uninstall(s.id);
    m.syncRegistry(registry);
    expect(registry.get('mcp:fetch:fetch')).toBe(seedTool);
  });
});
