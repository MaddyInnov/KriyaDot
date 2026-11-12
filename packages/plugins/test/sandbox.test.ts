// SPDX-License-Identifier: Apache-2.0
// OPEN-2 regression suite: plugin children are filesystem/network
// confined by the kernel sandbox, configured from declared permissions.
//
// These tests drive the REAL spawn path (PluginManager → rpc →
// plugin-sandbox → Landlock helper) with a probe plugin that attempts
// exactly the escapes QA confirmed live in OPEN-2:
//   - reading a canary file outside its fence (the `.api-token` repro),
//   - opening a TCP socket while declaring network:false,
// ...and the counter-proofs: own-directory read/write still works,
// a declared fs.read grant works, and a network:true plugin can still
// open sockets (grants function). Fail-closed behaviour is tested with
// the sandbox subsystem disabled by host config.
//
// Landlock-dependent tests skip (loudly, via test-context skip) on hosts
// without a kernel sandbox backend; the fail-closed tests run anywhere.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PluginManager,
  PluginSandboxUnavailableError,
  buildPluginSeatbeltProfile,
  probePluginSandbox,
  resetPluginSandboxProbe,
  validateManifest,
  type PluginSandboxReport,
} from '../src/index.js';

const CANARY_CONTENT = 'OPEN2-CANARY-SECRET';

const PROBE_PLUGIN = `'use strict';
const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function probe(cb) {
  const out = {};
  try { out.canary = fs.readFileSync(process.env.OPEN2_CANARY_PATH, 'utf8').trim(); } catch (e) { out.canaryError = e.code || e.message; }
  try {
    fs.writeFileSync(process.env.PLUGIN_DIR + '/own-write.txt', 'own-ok');
    out.ownWrite = fs.readFileSync(process.env.PLUGIN_DIR + '/own-write.txt', 'utf8');
  } catch (e) { out.ownWriteError = e.code || e.message; }
  const wd = process.env.OPEN2_WRITE_DIR;
  if (wd) {
    try { fs.writeFileSync(wd + '/grant-write.txt', 'grant-ok'); out.grantWrite = 'ok'; } catch (e) { out.grantWriteError = e.code || e.message; }
  }
  out.envDecoy = process.env.OPEN2_DECOY_SECRET ?? null;
  out.envAllowed = process.env.OPEN2_ALLOWED ?? null;
  const port = Number(process.env.OPEN2_TARGET_PORT || 0);
  if (!port) { out.sock = 'no-port'; cb(out); return; }
  const s = net.connect(port, '127.0.0.1');
  let done = false;
  const fin = (v) => { if (!done) { done = true; out.sock = v; cb(out); } };
  s.setTimeout(2500);
  s.on('connect', () => { s.end(); fin('connected'); });
  s.on('timeout', () => { s.destroy(); fin('timeout'); });
  s.on('error', (e) => fin('error:' + (e.code || e.message)));
}
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }] } }) + '\\n');
    return;
  }
  probe((result) => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n'); });
});
`;

interface ProbeResult {
  canary?: string;
  canaryError?: string;
  ownWrite?: string;
  ownWriteError?: string;
  grantWrite?: string;
  grantWriteError?: string;
  envDecoy: unknown;
  envAllowed: unknown;
  sock: string;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeProbePlugin(base: string, id: string, permissions: Record<string, unknown>): string {
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      description: 'OPEN-2 probe fixture',
      kinds: ['tool'],
      entry: 'index.js',
      permissions,
    }),
  );
  writeFileSync(join(dir, 'index.js'), PROBE_PLUGIN);
  return dir;
}

describe('plugin kernel sandbox (OPEN-2)', () => {
  let server: net.Server;
  let port = 0;
  let hits = 0;
  let canaryDir: string;
  let canaryPath: string;
  let backendAvailable = false;
  const reports: PluginSandboxReport[] = [];

  beforeAll(async () => {
    server = net.createServer((c) => {
      hits += 1;
      c.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
    canaryDir = tmp('plugins-open2-canary-');
    canaryPath = join(canaryDir, '.api-token');
    writeFileSync(canaryPath, CANARY_CONTENT);
    process.env.OPEN2_CANARY_PATH = canaryPath;
    process.env.OPEN2_TARGET_PORT = String(port);
    process.env.OPEN2_DECOY_SECRET = 'decoy-must-not-leak';
    process.env.OPEN2_ALLOWED = 'allowed-value';
    backendAvailable = (await probePluginSandbox()).backend !== null;
  });

  afterEach(() => {
    delete process.env.KRIYADOT_PLUGIN_SANDBOX;
    delete process.env.KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED;
    resetPluginSandboxProbe();
  });

  async function installAndProbe(id: string, permissions: Record<string, unknown>): Promise<ProbeResult> {
    const base = tmp('plugins-open2-src-');
    const dir = writeProbePlugin(base, id, permissions);
    const mgr = new PluginManager({
      dataDir: tmp('plugins-open2-data-'),
      approveInstall: () => true,
    });
    await mgr.install({ type: 'dir', path: dir });
    return (await mgr.callTool(id, 'probe', {})) as ProbeResult;
  }

  it('network:false plugin CANNOT read a canary outside its fence and CANNOT open a socket; own dir works; env stays scrubbed', async ({ skip }) => {
    if (!backendAvailable) skip();
    hits = 0;
    const res = await installAndProbe('probe-restrictive', {
      network: false,
      env: ['OPEN2_CANARY_PATH', 'OPEN2_TARGET_PORT', 'OPEN2_ALLOWED'],
    });
    expect(res.canary).toBeUndefined();
    expect(res.canaryError).toBe('EACCES');
    expect(res.sock.startsWith('error:')).toBe(true);
    expect(hits).toBe(0);
    expect(res.ownWrite).toBe('own-ok');
    expect(res.envDecoy).toBeNull();
    expect(res.envAllowed).toBe('allowed-value');
  }, 30_000);

  it('network:true plugin CAN open a socket, but the filesystem fence still holds', async ({ skip }) => {
    if (!backendAvailable) skip();
    hits = 0;
    const res = await installAndProbe('probe-net', {
      network: true,
      env: ['OPEN2_CANARY_PATH', 'OPEN2_TARGET_PORT', 'OPEN2_ALLOWED'],
    });
    expect(res.sock).toBe('connected');
    expect(hits).toBe(1);
    expect(res.canary).toBeUndefined();
    expect(res.canaryError).toBe('EACCES');
    expect(res.ownWrite).toBe('own-ok');
  }, 30_000);

  it('declared fs.read grant opens exactly that path; fs.write grant allows writing there (and nowhere else)', async ({ skip }) => {
    if (!backendAvailable) skip();
    const writeDir = tmp('plugins-open2-grantwrite-');
    process.env.OPEN2_WRITE_DIR = writeDir;
    try {
      const res = await installAndProbe('probe-grants', {
        network: false,
        env: ['OPEN2_CANARY_PATH', 'OPEN2_TARGET_PORT', 'OPEN2_ALLOWED', 'OPEN2_WRITE_DIR'],
        fs: { read: [canaryDir], write: [writeDir] },
      });
      expect(res.canary).toBe(CANARY_CONTENT);
      expect(res.grantWrite).toBe('ok');
      expect(existsSync(join(writeDir, 'grant-write.txt'))).toBe(true);
      expect(res.sock.startsWith('error:')).toBe(true);
    } finally {
      delete process.env.OPEN2_WRITE_DIR;
    }
  }, 30_000);

  it('reports confinement through onSandbox (landlock, network denied)', async ({ skip }) => {
    if (!backendAvailable) skip();
    const { invokePluginRpc } = await import('../src/index.js');
    const base = tmp('plugins-open2-src-');
    const dir = writeProbePlugin(base, 'probe-report', {
      network: false,
      env: ['OPEN2_CANARY_PATH', 'OPEN2_TARGET_PORT', 'OPEN2_ALLOWED'],
    });
    const { parseManifest } = await import('../src/index.js');
    const { readFileSync } = await import('node:fs');
    const manifest = parseManifest(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    reports.length = 0;
    await invokePluginRpc({ dir, manifest }, 'tools/call', { name: 'probe', args: {} }, {
      onSandbox: (r) => reports.push(r),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sandboxed).toBe(true);
    expect(reports[0]!.backend).toBe('landlock');
    expect(reports[0]!.networkDenied).toBe(true);
  }, 30_000);

  it('FAIL CLOSED: with the sandbox subsystem disabled, a restrictive plugin is refused, never run unconfined', async () => {
    process.env.KRIYADOT_PLUGIN_SANDBOX = 'off';
    resetPluginSandboxProbe();
    const base = tmp('plugins-open2-src-');
    const dir = writeProbePlugin(base, 'probe-failclosed', {
      network: false,
      env: ['OPEN2_CANARY_PATH', 'OPEN2_TARGET_PORT', 'OPEN2_ALLOWED'],
    });
    const mgr = new PluginManager({ dataDir: tmp('plugins-open2-data-'), approveInstall: () => true });
    await mgr.install({ type: 'dir', path: dir });
    await expect(mgr.callTool('probe-failclosed', 'probe', {})).rejects.toBeInstanceOf(PluginSandboxUnavailableError);
  }, 30_000);

  it('FAIL CLOSED: a maximally permissive plugin is still refused without the explicit host opt-in', async () => {
    process.env.KRIYADOT_PLUGIN_SANDBOX = 'off';
    resetPluginSandboxProbe();
    const base = tmp('plugins-open2-src-');
    const dir = writeProbePlugin(base, 'probe-permissive', {
      network: true,
      env: ['OPEN2_CANARY_PATH', 'OPEN2_TARGET_PORT', 'OPEN2_ALLOWED'],
      fs: { read: ['/'], write: ['/'] },
    });
    const mgr = new PluginManager({ dataDir: tmp('plugins-open2-data-'), approveInstall: () => true });
    await mgr.install({ type: 'dir', path: dir });
    await expect(mgr.callTool('probe-permissive', 'probe', {})).rejects.toBeInstanceOf(PluginSandboxUnavailableError);
  }, 30_000);

  it('explicit opt-in: permissive plugin + KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED=1 runs unsandboxed WITH a warning report', async () => {
    process.env.KRIYADOT_PLUGIN_SANDBOX = 'off';
    process.env.KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED = '1';
    resetPluginSandboxProbe();
    const { invokePluginRpc, parseManifest } = await import('../src/index.js');
    const { readFileSync } = await import('node:fs');
    const base = tmp('plugins-open2-src-');
    const dir = writeProbePlugin(base, 'probe-optin', {
      network: true,
      env: ['OPEN2_CANARY_PATH', 'OPEN2_TARGET_PORT', 'OPEN2_ALLOWED'],
      fs: { read: ['/'], write: ['/'] },
    });
    const manifest = parseManifest(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    const seen: PluginSandboxReport[] = [];
    const res = (await invokePluginRpc({ dir, manifest }, 'tools/call', { name: 'probe', args: {} }, {
      onSandbox: (r) => seen.push(r),
    })) as ProbeResult;
    expect(res.sock).toBe('connected');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sandboxed).toBe(false);
    expect(seen[0]!.warning).toContain('UNSANDBOXED');
  }, 30_000);
});

describe('manifest fs grants validation', () => {
  const VALID = {
    id: 'fs-test',
    name: 'FS Test',
    version: '1.0.0',
    description: 'fixture',
    kinds: ['tool'],
    entry: 'index.js',
  };

  it('accepts absolute read/write grants and round-trips them', () => {
    const m = validateManifest({ ...VALID, permissions: { fs: { read: ['/data/shared'], write: ['/data/out'] } } });
    expect(m.permissions?.fs).toEqual({ read: ['/data/shared'], write: ['/data/out'] });
  });

  it('rejects relative paths, traversal, and backslashes in grants', () => {
    expect(() => validateManifest({ ...VALID, permissions: { fs: { read: ['relative/path'] } } })).toThrow(/permissions\.fs\.read/);
    expect(() => validateManifest({ ...VALID, permissions: { fs: { read: ['/data/../etc'] } } })).toThrow(/permissions\.fs\.read/);
    expect(() => validateManifest({ ...VALID, permissions: { fs: { write: ['C:\\data'] } } })).toThrow(/permissions\.fs\.write/);
  });
});

describe('seatbelt profile generation (execution is darwin-gated)', () => {
  it('denies network by default and confines writes to the plugin dir', () => {
    const profile = buildPluginSeatbeltProfile({ pluginDir: '/plugins/demo', network: false });
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(subpath "/plugins/demo")');
  });

  it('allows network only when declared', () => {
    const profile = buildPluginSeatbeltProfile({ pluginDir: '/plugins/demo', network: true });
    expect(profile).toContain('(allow network*)');
    expect(profile).not.toContain('(deny network*)');
  });
});
