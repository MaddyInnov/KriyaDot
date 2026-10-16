// SPDX-License-Identifier: Apache-2.0
// API tests for BYO VPS (OpenMausBot parity P1 #24): profile persistence
// (no secrets on disk), the trust/mismatch flows, and the route contracts.
// All SSH is faked — zero network, zero paid API usage.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecureVault } from '@mvp/vault';
import {
  VpsConnectionPool,
  fingerprintSha256,
} from '@mvp/agent-runtime';
import type {
  BotConfig,
  SshClientLike,
  SshConnectRequest,
} from '@mvp/agent-runtime';
import {
  deleteVpsProfile,
  loadVpsProfiles,
  resolveVpsProfile,
  saveVpsDefaultProfile,
  saveVpsProfile,
  vpsProfilesPath,
} from '../src/vps-profiles.js';
import { registerVpsRoutes } from '../src/vps-routes.js';

const FAKE_KEY = Buffer.from('api-test-host-key');
const FAKE_FP = fingerprintSha256(FAKE_KEY);

function bots(): BotConfig[] {
  return [
    { id: 'scout', name: 'Scout', description: '', systemPrompt: '', provider: 'groq', model: 'm', skills: [], tools: [], mcpServers: [] },
  ];
}

// Minimal fake SSH client for route tests.
function fakeClient(): SshClientLike {
  return {
    alive: true,
    async exec(command: string) {
      if (command.includes('uname -srm')) {
        return { stdout: 'Linux 6.8.0 x86_64\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('command -v xdotool')) {
        return { stdout: '/usr/bin/xdotool\n/usr/bin/import\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
    close() {},
  };
}

function fakeFactory(seen: SshConnectRequest[], key: Buffer = FAKE_KEY) {
  return async (req: SshConnectRequest): Promise<SshClientLike> => {
    seen.push(req);
    if (!req.verifyHostKey(key, 'ssh-rsa')) {
      throw new Error('Handshake failed: hostVerifier returned false');
    }
    return fakeClient();
  };
}

function makePool(seen: SshConnectRequest[], key?: Buffer): VpsConnectionPool {
  return new VpsConnectionPool({
    resolvePrivateKey: (ref: string) =>
      ref === 'vps-key-test' ? 'PEM-DATA' : undefined,
    createSshClient: fakeFactory(seen, key),
    sleep: async () => undefined,
  });
}

// ---------------------------------------------------------------------------
// Profile persistence
// ---------------------------------------------------------------------------

describe('vps-profiles overlay', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vps-profiles-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves and resolves per-bot profiles with a default fallback', () => {
    saveVpsProfile(dir, 'scout', { host: 'a.example.com', user: 'u', privateKeyRef: 'k' });
    saveVpsDefaultProfile(dir, { host: 'd.example.com', user: 'u', privateKeyRef: 'k' });
    expect(resolveVpsProfile(dir, 'scout')?.host).toBe('a.example.com');
    expect(resolveVpsProfile(dir, 'coder')?.host).toBe('d.example.com');
    expect(resolveVpsProfile(dir, 'scout')?.port).toBe(22);
  });

  it('never persists secret material', () => {
    saveVpsProfile(dir, 'scout', { host: 'h', user: 'u', privateKeyRef: 'k' });
    expect(() =>
      saveVpsProfile(dir, 'scout', { host: 'h', user: 'u', privateKeyRef: 'k', password: 'x' }),
    ).toThrow(/never be stored/);
    expect(() =>
      saveVpsProfile(dir, 'scout', { host: 'h', user: 'u', privateKey: 'PEM' }),
    ).toThrow(/never be stored/);
    const raw = readFileSync(vpsProfilesPath(dir), 'utf8');
    expect(raw).not.toMatch(/PRIVATE KEY/);
    expect(raw).not.toContain('"password"');
  });

  it('deletes profiles and drops invalid entries on load', () => {
    saveVpsProfile(dir, 'scout', { host: 'a.example.com', user: 'u', privateKeyRef: 'k' });
    expect(deleteVpsProfile(dir, 'scout')).toBe(true);
    expect(deleteVpsProfile(dir, 'scout')).toBe(false);
    expect(resolveVpsProfile(dir, 'scout')).toBeUndefined();
  });

  it('writes the overlay file with 0600 permissions', () => {
    saveVpsProfile(dir, 'scout', { host: 'a.example.com', user: 'u', privateKeyRef: 'k' });
    const mode = statSync(vpsProfilesPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('VPS routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void };
  let seen: SshConnectRequest[];
  let pool: VpsConnectionPool;

  const buildApp = (key?: Buffer) => {
    seen = [];
    pool = makePool(seen, key);
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerVpsRoutes(router, {
      bots: bots(),
      dataDir: dir,
      pool,
      audit: () => undefined,
      errorBody: (error: string, detail?: string) => ({ error, ...(detail ? { detail } : {}) }),
    });
    app.use('/api', router);
    return app;
  };

  const listen = async (app: express.Express) => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as {
        close(cb: () => void): void;
      };
    });
    const port = (server as unknown as { address(): AddressInfo | null }).address()?.port;
    baseUrl = `http://127.0.0.1:${port}`;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vps-routes-'));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) await pool.closeAll().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const post = (path: string, body: unknown = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('PUT/GET round-trips a profile and never echoes the private key', async () => {
    await listen(buildApp());
    const putRes = await put('/api/bots/scout/vps', {
      host: 'vps.example.com',
      user: 'bot',
      authMethod: 'key',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { profile: { privateKeyRef: string } };
    expect(putBody.profile.privateKeyRef).toBe('vps-ssh-key-scout');

    // The key landed in the vault, not in the profile file.
    const vault = new SecureVault(dir, 'default-user', 'vps');
    expect(vault.get('vps-ssh-key-scout')?.value).toContain('BEGIN OPENSSH PRIVATE KEY');
    const file = loadVpsProfiles(dir);
    expect(JSON.stringify(file)).not.toContain('BEGIN OPENSSH PRIVATE KEY');

    const getRes = await fetch(`${baseUrl}/api/bots/scout/vps`);
    const getBody = (await getRes.json()) as { profile: Record<string, unknown> };
    expect(getBody.profile.privateKeyRef).toBe('vps-ssh-key-scout');
    expect(JSON.stringify(getBody)).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('rejects passwords and bad profiles with 400', async () => {
    await listen(buildApp());
    const bad = await put('/api/bots/scout/vps', {
      host: 'vps.example.com',
      user: 'bot',
      authMethod: 'key',
      password: 'nope',
    });
    expect(bad.status).toBe(400);
    const badHost = await put('/api/bots/scout/vps', {
      host: 'https://evil.example.com/x',
      user: 'bot',
      privateKeyRef: 'k',
    });
    expect(badHost.status).toBe(400);
  });

  it('404s unknown bots and 400s invalid ids', async () => {
    await listen(buildApp());
    expect((await fetch(`${baseUrl}/api/bots/ghost/vps`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/bots/..../vps`)).status).toBe(400);
  });

  it('test without a trust pin returns 409 trustRequired with the fingerprint', async () => {
    await listen(buildApp());
    await put('/api/bots/scout/vps', {
      host: 'vps.example.com',
      user: 'bot',
      authMethod: 'key',
      privateKeyRef: 'vps-key-test',
    });
    const res = await post('/api/bots/scout/vps/test');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { trustRequired: boolean; fingerprint: string };
    expect(body.trustRequired).toBe(true);
    expect(body.fingerprint).toBe(FAKE_FP);
  });

  it('trust flow connects, persists the fingerprint, and test reports OS + tools', async () => {
    await listen(buildApp());
    await put('/api/bots/scout/vps', {
      host: 'vps.example.com',
      user: 'bot',
      authMethod: 'key',
      privateKeyRef: 'vps-key-test',
    });
    const connRes = await post('/api/bots/scout/vps/connect', { trustFingerprint: true });
    expect(connRes.status).toBe(200);
    const connBody = (await connRes.json()) as { status: string; fingerprint?: string };
    expect(connBody.status).toBe('connected');

    // The TOFU pin was persisted — a fresh profile load has it.
    expect(loadVpsProfiles(dir).profiles['scout']?.fingerprint).toBe(FAKE_FP);

    const testRes = await post('/api/bots/scout/vps/test');
    expect(testRes.status).toBe(200);
    const testBody = (await testRes.json()) as {
      os: { os: string; arch: string };
      desktopTools: { xdotool: boolean; screenshot: boolean };
      fingerprint: string;
    };
    expect(testBody.os.os).toBe('Linux');
    expect(testBody.os.arch).toBe('x86_64');
    expect(testBody.desktopTools.xdotool).toBe(true);
    expect(testBody.desktopTools.screenshot).toBe(true);
    expect(testBody.fingerprint).toBe(FAKE_FP);
  });

  it('fingerprint mismatch is a 409 hard stop', async () => {
    // Server presents FAKE_KEY but the profile pins a different key.
    await listen(buildApp(Buffer.from('different-host-key')));
    await put('/api/bots/scout/vps', {
      host: 'vps.example.com',
      user: 'bot',
      authMethod: 'key',
      privateKeyRef: 'vps-key-test',
      fingerprint: FAKE_FP,
    });
    const res = await post('/api/bots/scout/vps/connect');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toMatch(/mismatch/i);
    expect(body.detail).toMatch(/man-in-the-middle/i);
  });

  it('status + disconnect round-trip', async () => {
    await listen(buildApp());
    await put('/api/bots/scout/vps', {
      host: 'vps.example.com',
      user: 'bot',
      authMethod: 'key',
      privateKeyRef: 'vps-key-test',
      fingerprint: FAKE_FP,
    });
    await post('/api/bots/scout/vps/connect');
    const st = (await (await fetch(`${baseUrl}/api/bots/scout/vps/status`)).json()) as {
      status: string;
    };
    expect(st.status).toBe('connected');
    const dc = await post('/api/bots/scout/vps/disconnect');
    expect(dc.status).toBe(200);
    const st2 = (await (await fetch(`${baseUrl}/api/bots/scout/vps/status`)).json()) as {
      status: string;
    };
    expect(st2.status).toBe('disconnected');
  });

  it('DELETE removes the profile', async () => {
    await listen(buildApp());
    await put('/api/bots/scout/vps', {
      host: 'vps.example.com',
      user: 'bot',
      privateKeyRef: 'vps-key-test',
    });
    const del = await fetch(`${baseUrl}/api/bots/scout/vps`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(loadVpsProfiles(dir).profiles['scout']).toBeUndefined();
  });

  it('global default profile backs bots without their own', async () => {
    await listen(buildApp());
    await put('/api/vps/default', {
      host: 'default.example.com',
      user: 'bot',
      privateKeyRef: 'vps-key-test',
      fingerprint: FAKE_FP,
    });
    const res = await post('/api/bots/scout/vps/test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { os: { os: string } };
    expect(body.os.os).toBe('Linux');
    expect(seen[0].host).toBe('default.example.com');
  });
});
