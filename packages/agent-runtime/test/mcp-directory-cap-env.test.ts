// SPDX-License-Identifier: Apache-2.0
// #123: requiredEnv gating for MCP servers — a server whose required
// env keys are missing is SKIPPED (no stubs, never spawned), not
// call-time-broken. Directory installs inherit needsEnv.
// #140: persistent active-capability set with a soft cap and
// LRU/refcount eviction in LazyMcpManager.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LazyMcpManager,
  isEnvGated,
  missingRequiredEnv,
  type InstalledMcpServer,
  type LazyMcpConnector,
} from '../src/mcp-directory.js';
import type { ToolDefinition } from '../src/types.js';

const dirs: string[] = [];
const managers: LazyMcpManager[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-cap-env-test-'));
  dirs.push(d);
  return d;
}

function fakeConnector(handler?: () => Promise<unknown>): LazyMcpConnector {
  return {
    async listTools(): Promise<ToolDefinition[]> {
      return [
        {
          name: 'call',
          description: 'call',
          parameters: { type: 'object', properties: {} },
          handler: async () => (handler ? handler() : { ok: true }),
        },
      ];
    },
    async close() {},
    async ping() {},
  };
}

function makeManager(
  opts: Partial<ConstructorParameters<typeof LazyMcpManager>[0]> = {},
  dataDir = freshDir(),
): LazyMcpManager {
  const m = new LazyMcpManager({
    dataDir,
    healthCheckIntervalMs: 0,
    connectFn: async () => fakeConnector(),
    env: {},
    ...opts,
  });
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const stdio = { kind: 'stdio' as const, command: 'true' };

describe('requiredEnv gating (#123)', () => {
  it('missingRequiredEnv: env source and config.env both satisfy a key', () => {
    const cfg = { ...stdio, requiredEnv: ['A_KEY', 'B_KEY'] };
    expect(missingRequiredEnv(cfg, {})).toEqual(['A_KEY', 'B_KEY']);
    expect(missingRequiredEnv(cfg, { A_KEY: 'x' })).toEqual(['B_KEY']);
    expect(missingRequiredEnv({ ...cfg, env: { B_KEY: 'v' } }, { A_KEY: 'x' })).toEqual([]);
    expect(isEnvGated(cfg, {})).toBe(true);
    expect(isEnvGated({ ...stdio }, {})).toBe(false);
    expect(missingRequiredEnv({ ...cfg, requiredEnv: ['A_KEY'] }, { A_KEY: '  ' })).toEqual(['A_KEY']);
  });

  it('a gated server gets NO stubs and ensureConnected refuses to spawn it', async () => {
    const m = makeManager();
    const s = m.installCustom('needs-key', { ...stdio, requiredEnv: ['MY_KEY'] });
    expect(m.envGate(s)).toEqual({ gated: true, missing: ['MY_KEY'] });
    expect(m.stubToolDefinitions().map((d) => d.name)).toEqual([]);
    await expect(m.ensureConnected(s.id)).rejects.toThrow(/skipped: missing required env MY_KEY/);
    expect(m.status(s.id).status).toBe('stopped');
  });

  it('the same server is live once the key is present', async () => {
    const m = makeManager({ env: { MY_KEY: 'secret' } });
    const s = m.installCustom('needs-key', { ...stdio, requiredEnv: ['MY_KEY'] });
    expect(m.envGate(s).gated).toBe(false);
    expect(m.stubToolDefinitions().map((d) => d.name)).toEqual(['mcp:needs-key:call']);
    await m.ensureConnected(s.id);
    expect(m.status(s.id).status).toBe('running');
  });

  it('directory installs inherit needsEnv as requiredEnv (github is gated without its token)', () => {
    const m = makeManager();
    const s = m.installFromDirectory('github');
    expect(s.config.requiredEnv).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(m.envGate(s).gated).toBe(true);
    expect(m.stubToolDefinitions().some((d) => d.name.startsWith('mcp:github:'))).toBe(false);
  });
});

describe('active-capability set: LRU + refcount eviction (#140)', () => {
  it('activations persist across manager restarts, LRU order intact', async () => {
    const dir = freshDir();
    let t = 1_000;
    const now = () => t;
    const m1 = makeManager({ now }, dir);
    const a = m1.installCustom('alpha', stdio);
    const b = m1.installCustom('beta', stdio);
    t = 2_000;
    await m1.ensureConnected(a.id);
    t = 3_000;
    await m1.ensureConnected(b.id);
    await m1.close();
    managers.splice(managers.indexOf(m1), 1);

    const m2 = makeManager({ now }, dir);
    const active = m2.activeCapabilities();
    expect(active.map((c) => c.label)).toEqual(['beta', 'alpha']);
    expect(active.every((c) => c.activations === 1)).toBe(true);
    expect(active.every((c) => !c.connected)).toBe(true);
  });

  it('exceeding the soft cap evicts the least-recently-used idle connection', async () => {
    let t = 0;
    const m = makeManager({ maxActiveCapabilities: 2, now: () => t });
    const a = m.installCustom('alpha', stdio);
    const b = m.installCustom('beta', stdio);
    const c = m.installCustom('gamma', stdio);
    t = 1;
    await m.ensureConnected(a.id);
    t = 2;
    await m.ensureConnected(b.id);
    t = 3;
    await m.ensureConnected(c.id);
    const byLabel = new Map(m.activeCapabilities().map((x) => [x.label, x]));
    expect(byLabel.get('alpha')!.connected).toBe(false);
    expect(byLabel.get('beta')!.connected).toBe(true);
    expect(byLabel.get('gamma')!.connected).toBe(true);
    expect(m.status(a.id).status).toBe('stopped');
  });

  it('a server with an in-flight call is never evicted (refcount), even when it is the LRU', async () => {
    let t = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = makeManager({
      maxActiveCapabilities: 2,
      now: () => t,
      connectFn: async (server: InstalledMcpServer) =>
        fakeConnector(async () => {
          if (server.label === 'alpha') await gate;
          return { ok: true };
        }),
    });
    const a = m.installCustom('alpha', stdio);
    const b = m.installCustom('beta', stdio);
    const c = m.installCustom('gamma', stdio);
    t = 1;
    await m.ensureConnected(a.id);
    t = 2;
    await m.ensureConnected(b.id);
    // Start (but do not finish) a call on alpha — the LRU server.
    const stub = m.stubToolDefinitions().find((d) => d.name === 'mcp:alpha:call')!;
    const callPromise = stub.handler({}, { sessionId: 's', botId: 'bot' } as never);
    // Let the handler reach the in-flight section.
    await new Promise((r) => setTimeout(r, 10));
    expect(m.activeCapabilities().find((x) => x.label === 'alpha')!.inFlight).toBe(1);
    t = 3;
    await m.ensureConnected(c.id);
    const byLabel = new Map(m.activeCapabilities().map((x) => [x.label, x]));
    expect(byLabel.get('alpha')!.connected).toBe(true); // busy: protected
    expect(byLabel.get('beta')!.connected).toBe(false); // idle LRU-of-the-rest: evicted
    expect(byLabel.get('gamma')!.connected).toBe(true);
    release();
    await callPromise;
    expect(m.activeCapabilities().find((x) => x.label === 'alpha')!.inFlight).toBe(0);
  });

  it('removeServer drops the server from the persistent active set', async () => {
    const m = makeManager();
    const a = m.installCustom('alpha', stdio);
    await m.ensureConnected(a.id);
    expect(m.activeCapabilities().map((c) => c.label)).toEqual(['alpha']);
    await m.removeServer('alpha');
    expect(m.activeCapabilities()).toEqual([]);
    expect(m.store.listActiveCapabilities()).toEqual([]);
  });
});
