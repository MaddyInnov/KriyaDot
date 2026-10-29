// SPDX-License-Identifier: Apache-2.0
// Standalone engine installs (ENGINES pack): manifest validation,
// checksum-mismatch rejection, approve-hook denial by default, install
// into a tmp dataDir with a stubbed fetch serving fixture archives
// (zip + tar.gz), detection preference for the installed build, and the
// audit-logged HTTP route. Zero real network.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectAcpEngines } from '@mvp/agent-runtime';
import {
  createEngineInstallsRouter,
  ENGINE_INSTALL_MANIFEST,
  extractZipBuffer,
  installEngine,
  installedEnginePath,
  readActiveInstall,
  validateEngineInstallManifest,
  type EngineInstallManifestEntry,
} from '../src/engine-installs.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Build a minimal stored-method zip (the installer's reader ignores CRCs; the archive SHA-256 is the integrity gate). */
function buildStoredZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdOffset = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function fixtureManifest(archiveBuf: Buffer, archive: 'zip' | 'tar.gz', pin?: string): EngineInstallManifestEntry[] {
  const key = `${process.platform}-${process.arch}`;
  return [
    {
      id: 'fakeengine',
      name: 'Fake Engine',
      version: '9.9.9',
      executable: 'fakeengine',
      assets: {
        [key]: { url: 'https://example.invalid/fakeengine-{version}.bin', sha256: pin ?? sha256(archiveBuf), archive },
      },
      notes: 'test fixture',
    },
  ];
}

function fetchServing(buf: Buffer): typeof fetch {
  return (async () =>
    new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as unknown as typeof fetch;
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'engine-installs-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('manifest validation', () => {
  it('the shipped manifest validates and only lists engines with real standalone artifacts', () => {
    expect(validateEngineInstallManifest(ENGINE_INSTALL_MANIFEST)).toEqual([]);
    const ids = ENGINE_INSTALL_MANIFEST.map((e) => e.id);
    expect(ids).toContain('opencode');
    expect(ids).toContain('antigravity');
    // Cline is npm-only (needs Node) — it must NOT claim a standalone build.
    expect(ids).not.toContain('cline');
  });

  it('flags non-https urls, bad pins, and duplicate ids', () => {
    const bad: EngineInstallManifestEntry[] = [
      {
        id: 'x',
        name: 'X',
        version: '1.0.0',
        executable: 'x',
        assets: { 'linux-x64': { url: 'http://insecure.example/x.zip', sha256: 'zz', archive: 'zip' } },
        notes: '',
      },
      {
        id: 'x',
        name: 'X2',
        version: '1.0.0',
        executable: 'x',
        assets: { 'linux-x64': { url: 'https://example.com/x.zip', sha256: null, archive: 'zip' } },
        notes: '',
      },
    ];
    const errors = validateEngineInstallManifest(bad);
    expect(errors.some((e) => /https/.test(e))).toBe(true);
    expect(errors.some((e) => /sha256/.test(e))).toBe(true);
    expect(errors.some((e) => /duplicate/.test(e))).toBe(true);
  });
});

describe('zip extraction guard', () => {
  it('rejects zip-slip entries', () => {
    const zip = buildStoredZip({ '../evil.txt': 'x' });
    expect(() => extractZipBuffer(zip, dataDir)).toThrow(/unsafe zip entry/);
  });
});

describe('installEngine', () => {
  it('denies by default when no approve hook is wired', async () => {
    const zip = buildStoredZip({ fakeengine: '#!/bin/sh\necho fake\n' });
    await expect(
      installEngine({ dataDir, engineId: 'fakeengine', manifest: fixtureManifest(zip, 'zip'), fetchImpl: fetchServing(zip) }),
    ).rejects.toThrow(/not approved/);
    expect(installedEnginePath(dataDir, 'fakeengine')).toBeNull();
  });

  it('rejects a checksum mismatch and installs nothing', async () => {
    const zip = buildStoredZip({ fakeengine: 'binary-bytes' });
    const wrongPin = sha256(Buffer.from('something else'));
    await expect(
      installEngine({
        dataDir,
        engineId: 'fakeengine',
        manifest: fixtureManifest(zip, 'zip', wrongPin),
        fetchImpl: fetchServing(zip),
        approve: () => true,
      }),
    ).rejects.toThrow(/Checksum mismatch/);
    expect(installedEnginePath(dataDir, 'fakeengine')).toBeNull();
    expect(readActiveInstall(dataDir, 'fakeengine')).toBeNull();
  });

  it('refuses an unpinned asset (fail closed)', async () => {
    const zip = buildStoredZip({ fakeengine: 'binary-bytes' });
    const manifest = fixtureManifest(zip, 'zip');
    manifest[0]!.assets[`${process.platform}-${process.arch}`]!.sha256 = null;
    await expect(
      installEngine({ dataDir, engineId: 'fakeengine', manifest, fetchImpl: fetchServing(zip), approve: () => true }),
    ).rejects.toThrow(/no verified SHA-256 pin/);
  });

  it('installs a zip fixture into <dataDir>/engines/<id>/<version> and marks it active', async () => {
    const zip = buildStoredZip({ fakeengine: '#!/bin/sh\necho fake-engine\n', 'README.txt': 'hi' });
    const result = await installEngine({
      dataDir,
      engineId: 'fakeengine',
      manifest: fixtureManifest(zip, 'zip'),
      fetchImpl: fetchServing(zip),
      approve: () => true,
    });
    expect(result.version).toBe('9.9.9');
    expect(existsSync(result.executablePath)).toBe(true);
    expect(readFileSync(result.executablePath, 'utf8')).toContain('fake-engine');
    expect(readActiveInstall(dataDir, 'fakeengine')?.version).toBe('9.9.9');
    // Detection preference: the installed build resolves for detection.
    expect(installedEnginePath(dataDir, 'fakeengine')).toBe(result.executablePath);
    const detection = detectAcpEngines({
      standalonePath: (id) => (id === 'opencode' ? installedEnginePath(dataDir, 'fakeengine') : null),
    });
    expect(detection.find((d) => d.id === 'opencode')?.path).toBe(result.executablePath);
  });

  it('installs a tar.gz fixture via system tar', async () => {
    const srcDir = join(dataDir, 'tar-src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'fakeengine'), '#!/bin/sh\necho tar-engine\n');
    const archivePath = join(dataDir, 'fixture.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', srcDir, 'fakeengine']);
    const archiveBuf = readFileSync(archivePath);
    const result = await installEngine({
      dataDir,
      engineId: 'fakeengine',
      manifest: fixtureManifest(archiveBuf, 'tar.gz'),
      fetchImpl: fetchServing(archiveBuf),
      approve: () => true,
    });
    expect(readFileSync(result.executablePath, 'utf8')).toContain('tar-engine');
  });
});

describe('engine installs routes (audit-logged)', () => {
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  const audits: Array<{ action: string; fields: unknown }> = [];

  beforeEach(async () => {
    audits.length = 0;
    const zip = buildStoredZip({ fakeengine: 'binary-bytes' });
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createEngineInstallsRouter({
        dataDir,
        audit: (action, fields) => void audits.push({ action, fields }),
        approve: () => true,
        fetchImpl: fetchServing(zip),
        manifest: fixtureManifest(zip, 'zip'),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  it('GET /engines lists the manifest with install state', async () => {
    const res = await fetch(`${baseUrl}/engines`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engines: Array<{ id: string; installedPath: string | null }> };
    expect(body.engines.map((e) => e.id)).toContain('fakeengine');
    expect(body.engines[0]?.installedPath).toBeNull();
  });

  it('POST /engines/:id/install installs and audit-logs requested + installed', async () => {
    const res = await fetch(`${baseUrl}/engines/fakeengine/install`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; install: { version: string } };
    expect(body.ok).toBe(true);
    expect(body.install.version).toBe('9.9.9');
    expect(audits.map((a) => a.action)).toEqual(['engine.install_requested', 'engine.installed']);
    expect(installedEnginePath(dataDir, 'fakeengine')).not.toBeNull();
  });

  it('POST for an unknown engine is a 404 and audit-logs the failure', async () => {
    const res = await fetch(`${baseUrl}/engines/nope/install`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(audits.map((a) => a.action)).toEqual(['engine.install_requested', 'engine.install_failed']);
  });
});
