// SPDX-License-Identifier: Apache-2.0
// Enterprise pack tests: white-label brand store/routes (admin gate),
// Ed25519 license verify + feature gate (opt-in enforcement), and the
// local installations registry (token-gated register, admin-only list).

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { TenantStore, signTenancyJwt } from '@mvp/tenancy';
import { BrandStore, createBrandRouter } from '../src/brand.js';
import { InstallationRegistry, createInstallationsRouter, hashHostname, registerSelfInstallation } from '../src/installations.js';
import { licenseHasFeature, requireFeature, verifyLicense, type LicensePayload } from '../src/license.js';

// OPEN-1: brand/installations admin checks resolve a VERIFIED principal.
// Non-owner callers authenticate with a tenancy JWT (sub = their user id);
// the role (org owner/admin) then comes from stored memberships, never a header.
const JWT_SECRET = 'brand-inst-test-secret';
const jwtFor = (sub: string, orgId: string): string => signTenancyJwt({ sub, orgId }, JWT_SECRET);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function mintLicense(payload: LicensePayload, key = privateKey): string {
  const signed = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = cryptoSign(null, Buffer.from(signed, 'ascii'), key).toString('base64url');
  return `${signed}.${sig}`;
}
const FUTURE = Date.now() + 365 * 24 * 3600 * 1000;

describe('license verification', () => {
  it('accepts a valid license and exposes its features', () => {
    const lic = mintLicense({ org: 'org_1', features: ['sso', 'white-label'], expiresAt: FUTURE, seats: 5 });
    const check = verifyLicense(lic, { publicKeyB64: PUB_B64 });
    expect(check.valid).toBe(true);
    expect(licenseHasFeature(check, 'sso')).toBe(true);
    expect(licenseHasFeature(check, 'federation')).toBe(false);
  });
  it('rejects expired, tampered, wrong-key and malformed licenses', () => {
    const expired = mintLicense({ org: 'o', features: ['sso'], expiresAt: Date.now() - 1000, seats: 1 });
    expect(verifyLicense(expired, { publicKeyB64: PUB_B64 })).toEqual({ valid: false, reason: 'expired' });
    const good = mintLicense({ org: 'o', features: ['sso'], expiresAt: FUTURE, seats: 1 });
    const [signed] = good.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ org: 'o', features: ['sso', 'federation'], expiresAt: FUTURE, seats: 99 })).toString('base64url');
    expect(verifyLicense(`${tamperedPayload}.${good.split('.')[1]}`, { publicKeyB64: PUB_B64 }).valid).toBe(false);
    void signed;
    const other = generateKeyPairSync('ed25519');
    const wrongKey = mintLicense({ org: 'o', features: ['sso'], expiresAt: FUTURE, seats: 1 }, other.privateKey);
    expect(verifyLicense(wrongKey, { publicKeyB64: PUB_B64 })).toEqual({ valid: false, reason: 'bad-signature' });
    expect(verifyLicense('nonsense', { publicKeyB64: PUB_B64 })).toEqual({ valid: false, reason: 'malformed' });
    expect(verifyLicense(null).valid).toBe(false);
  });
});

describe('requireFeature middleware', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;
  afterEach(() => server?.close());

  async function boot(env: Record<string, string>, license: string | null): Promise<string> {
    const app = express();
    app.get('/gated', requireFeature('sso', { env: env as NodeJS.ProcessEnv, loadLicense: () => license, publicKeyB64: PUB_B64 }), (_req, res) => {
      res.json({ ok: true });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/gated`;
  }

  it('is a pass-through by default (enforcement off — locals never locked out)', async () => {
    const url = await boot({}, null);
    expect((await fetch(url)).status).toBe(200);
  });
  it('blocks when enforcement is on and the license is missing/wrong-feature', async () => {
    const env = { KRIYADOT_LICENSE_REQUIRED: '1' };
    expect((await fetch(await boot(env, null))).status).toBe(403);
    server?.close();
    const noSso = mintLicense({ org: 'o', features: ['white-label'], expiresAt: FUTURE, seats: 1 });
    expect((await fetch(await boot(env, noSso))).status).toBe(403);
    server?.close();
    const withSso = mintLicense({ org: 'o', features: ['sso'], expiresAt: FUTURE, seats: 1 });
    expect((await fetch(await boot(env, withSso))).status).toBe(200);
  });
});

describe('brand store + routes', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;
  afterEach(() => server?.close());

  it('store round-trips and validates color/logo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    const store = new BrandStore(dir);
    expect(store.get().name).toBe('KriyaDot');
    const updated = store.set({ name: 'Acme AI', primaryColor: '#112233', logoUrl: 'https://x.test/logo.png' }, 'admin-1');
    expect(updated.name).toBe('Acme AI');
    expect(new BrandStore(dir).get().primaryColor).toBe('#112233');
    expect(() => store.set({ primaryColor: 'red' }, 'a')).toThrow(/hex/);
  });

  it('PUT is admin-gated by tenancy role; GET is open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    const dbPath = join(dir, 'tenancy.db');
    const tenants = new TenantStore(dbPath);
    const org = tenants.createOrg('Acme', 'boss-1');
    void org;
    const app = express();
    app.use(express.json());
    app.use('/api/brand', createBrandRouter({ dataDir: dir, tenancyDbPath: dbPath, jwtSecret: JWT_SECRET }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/brand`;
    expect((await (await fetch(base)).json() as { brand: { name: string } }).brand.name).toBe('KriyaDot');
    const denied = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwtFor('nobody', org.id)}` }, body: JSON.stringify({ name: 'Hax' }) });
    expect(denied.status).toBe(403);
    // A bare x-user-id header no longer grants anything at all (OPEN-1).
    const spoofed = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-user-id': 'boss-1' }, body: JSON.stringify({ name: 'Hax' }) });
    expect(spoofed.status).toBe(403);
    const allowed = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwtFor('boss-1', org.id)}` }, body: JSON.stringify({ name: 'Acme AI', primaryColor: '#445566' }) });
    expect(allowed.status).toBe(200);
    expect((await (await fetch(base)).json() as { brand: { name: string } }).brand.name).toBe('Acme AI');
  });
});

describe('installations registry', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;
  afterEach(() => server?.close());

  it('self-registers with a hashed hostname and heartbeats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inst-'));
    const rec = registerSelfInstallation(dir, '1.2.3');
    expect(rec.version).toBe('1.2.3');
    expect(rec.hostnameHash.length).toBe(32);
    expect(rec.hostnameHash).toBe(hashHostname(os.hostname()));
    const again = registerSelfInstallation(dir, '1.2.4');
    expect(again.id).toBe(rec.id); // stable self id
    expect(new InstallationRegistry(dir).list()).toHaveLength(1);
  });

  it('register requires the shared token; list is admin-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inst-'));
    const dbPath = join(dir, 'tenancy.db');
    const org = new TenantStore(dbPath).createOrg('Acme', 'boss-1');
    const app = express();
    app.use(express.json());
    app.use('/api/installations', createInstallationsRouter({ dataDir: dir, tenancyDbPath: dbPath, registrationToken: 'reg-token-1', jwtSecret: JWT_SECRET }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/installations`;
    const noToken = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '1.0.0' }) });
    expect(noToken.status).toBe(401);
    const okRes = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-registration-token': 'reg-token-1' }, body: JSON.stringify({ version: '1.0.0', hostname: 'fleet-host-7' }) });
    expect(okRes.status).toBe(201);
    const created = await okRes.json() as { installation: { hostnameHash: string } };
    expect(created.installation.hostnameHash).toBe(hashHostname('fleet-host-7'));
    expect(JSON.stringify(created)).not.toContain('fleet-host-7');
    const listDenied = await fetch(base, { headers: { authorization: `Bearer ${jwtFor('nobody', org.id)}` } });
    expect(listDenied.status).toBe(403);
    const listOk = await (await fetch(base, { headers: { authorization: `Bearer ${jwtFor('boss-1', org.id)}` } })).json() as { installations: unknown[] };
    expect(listOk.installations).toHaveLength(1);
  });
});
