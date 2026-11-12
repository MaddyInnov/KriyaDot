// SPDX-License-Identifier: Apache-2.0
// B2 — multi-user roles as the license/Pro gate.
//
// Covers both tenancy routers (apps/api/src/tenancy.ts and
// tenancy-depth-routes.ts) in all three gate states:
//   OFF (default)            → behaviour is exactly pre-B2, even with a
//                              garbage license string configured: the
//                              gate must not fire at all.
//   ON + no / Free / invalid → each gated capability refuses with
//     license                  403 { code: 'multi_user_requires_pro',
//                              error: <license taxonomy>, … } while
//                              reads, removals and revocations stay open.
//   ON + Pro license         → every gated capability works as today.
//
// License fixtures are minted HERE with a throwaway Ed25519 keypair
// generated at test start (the pattern from
// brand-license-installations.test.ts). No private key is committed
// anywhere; the production code path verifies against the key injected
// via deps, defaulting to the embedded DEV public key in license.ts.

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { TenantStore } from '@mvp/tenancy';
import type { AppConfig } from '../src/config.js';
import { registerTenancyRoutes } from '../src/tenancy.js';
import { createTenancyDepthRouter } from '../src/tenancy-depth-routes.js';
import { MULTI_USER_PRO_CODE, type LicensePayload } from '../src/license.js';

const OWNER_TOKEN = 'test-owner-token';
const JWT_SECRET = 'pro-gate-test-secret';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const FUTURE = Date.now() + 365 * 24 * 3600 * 1000;

function mintLicense(payload: LicensePayload, key = privateKey): string {
  const signed = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = cryptoSign(null, Buffer.from(signed, 'ascii'), key).toString('base64url');
  return `${signed}.${sig}`;
}
const proLicense = (): string => mintLicense({ org: 'acme', features: ['multi-user'], expiresAt: FUTURE, seats: 10 });
const freeLicense = (): string => mintLicense({ org: 'acme', features: ['sso', 'white-label'], expiresAt: FUTURE, seats: 1 });

interface ApiResult {
  status: number;
  json: any;
}

describe('tenancy router — B2 Pro gate', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  // Mutable gate inputs: the routers read them per request, which is
  // exactly how a test flips OFF→ON without rebooting the server.
  let env: Record<string, string>;
  let currentLicense: string | null;

  const gateOn = (license: string | null): void => {
    env.KRIYADOT_LICENSE_REQUIRED = '1';
    currentLicense = license;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tenancy-pro-gate-'));
    env = {};
    currentLicense = null;
    const governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerTenancyRoutes(router, {
      config: { dataDir: dir } as AppConfig,
      governance,
      loopbackToken: OWNER_TOKEN,
      licenseGate: {
        env: env as NodeJS.ProcessEnv,
        loadLicense: () => currentLicense,
        publicKeyB64: PUB_B64,
      },
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  async function api(method: string, path: string, body?: unknown, userId?: string): Promise<ApiResult> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OWNER_TOKEN}`,
        ...(userId ? { 'x-user-id': userId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function createOrg(name: string, user = 'alice'): Promise<string> {
    const r = await api('POST', '/orgs', { name }, user);
    expect(r.status).toBe(201);
    return r.json.org.id as string;
  }

  function expectProRefusal(r: ApiResult, error: string): void {
    expect(r.status).toBe(403);
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(MULTI_USER_PRO_CODE);
    expect(r.json.error).toBe(error);
    expect(r.json.feature).toBe('multi-user');
    expect(r.json.requiredTier).toBe('pro');
    expect(r.json.message).toContain('Pro license');
  }

  it('OFF (default): full multi-user flow works — second org, invite, accept, role assignment', async () => {
    const id = await createOrg('Acme');
    await createOrg('Second', 'alice'); // beyond the personal org: ungated while OFF
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'viewer' }, 'alice');
    expect(inv.status).toBe(201);
    const acc = await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'victor');
    expect(acc.status).toBe(201);
    expect((await api('PUT', `/orgs/${id}/members/victor`, { role: 'member' }, 'alice')).status).toBe(200);
  });

  it('OFF: a garbage license string changes nothing (no checks fire)', async () => {
    currentLicense = 'not-a-license.at-all';
    const id = await createOrg('Acme');
    await createOrg('Second', 'alice');
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'member' }, 'alice');
    expect(inv.status).toBe(201);
  });

  it('ON + no license: the first (personal) org is allowed; the second is refused as Pro', async () => {
    gateOn(null);
    const id = await createOrg('Personal');
    expect(id).toBeTruthy();
    expectProRefusal(await api('POST', '/orgs', { name: 'Second' }, 'alice'), 'license_required');
  });

  it('ON + no license: inviting a member is refused as Pro', async () => {
    gateOn(null);
    const id = await createOrg('Personal');
    expectProRefusal(
      await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'member' }, 'alice'),
      'license_required',
    );
  });

  it('ON + no license: accepting an invite minted while OFF is refused (no pre-gate bypass)', async () => {
    const id = await createOrg('Acme');
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'member' }, 'alice');
    expect(inv.status).toBe(201);
    gateOn(null);
    expectProRefusal(await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'victor'), 'license_required');
    expect((await api('GET', '/orgs', undefined, 'victor')).json).toEqual([]);
  });

  it('ON + no license: assigning a role is refused as Pro', async () => {
    const id = await createOrg('Acme');
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'viewer' }, 'alice');
    await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'victor');
    gateOn(null);
    expectProRefusal(await api('PUT', `/orgs/${id}/members/victor`, { role: 'member' }, 'alice'), 'license_required');
  });

  it('ON + no license: reads, member removal and invite revocation stay open', async () => {
    const id = await createOrg('Acme');
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'member' }, 'alice');
    await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'victor');
    await api('POST', `/orgs/${id}/invites`, { email: 'z@example.com', role: 'member' }, 'alice');
    gateOn(null);
    expect((await api('GET', `/orgs/${id}/members`, undefined, 'alice')).status).toBe(200);
    expect((await api('DELETE', `/orgs/${id}/members/victor`, undefined, 'alice')).status).toBe(200);
    expect((await api('DELETE', `/orgs/${id}/invites/z@example.com`, undefined, 'alice')).status).toBe(200);
  });

  it('ON + Free license (valid, no multi-user feature): refused as feature-not-included', async () => {
    gateOn(freeLicense());
    const id = await createOrg('Personal');
    expectProRefusal(
      await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'member' }, 'alice'),
      'license_feature_not_included',
    );
  });

  it('ON + expired Pro license: refused as expired', async () => {
    gateOn(mintLicense({ org: 'acme', features: ['multi-user'], expiresAt: Date.now() - 1000, seats: 10 }));
    const id = await createOrg('Personal');
    expectProRefusal(
      await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'member' }, 'alice'),
      'license_expired',
    );
  });

  it('ON + Pro-shaped license signed by the wrong key: refused as bad-signature', async () => {
    const other = generateKeyPairSync('ed25519');
    gateOn(mintLicense({ org: 'acme', features: ['multi-user'], expiresAt: FUTURE, seats: 10 }, other.privateKey));
    await createOrg('Personal');
    expectProRefusal(await api('POST', '/orgs', { name: 'Second' }, 'alice'), 'license_bad_signature');
  });

  it('ON + Pro license: the full multi-user flow works exactly as with the gate off', async () => {
    gateOn(proLicense());
    const id = await createOrg('Acme');
    await createOrg('Second', 'alice');
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'viewer' }, 'alice');
    expect(inv.status).toBe(201);
    expect((await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'victor')).status).toBe(201);
    expect((await api('PUT', `/orgs/${id}/members/victor`, { role: 'admin' }, 'alice')).status).toBe(200);
  });

  it('GET /orgs/license-status reports off / on-without-Pro / on-with-Pro honestly', async () => {
    const off = await api('GET', '/orgs/license-status', undefined, 'alice');
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ gateEnabled: false, allowed: true, feature: 'multi-user', requiredTier: 'pro' });
    expect(off.json.code).toBeUndefined();
    expect(off.json.message).toBeUndefined();

    gateOn(null);
    const denied = await api('GET', '/orgs/license-status', undefined, 'alice');
    expect(denied.json).toMatchObject({ gateEnabled: true, allowed: false, code: MULTI_USER_PRO_CODE, error: 'license_required' });
    expect(denied.json.message).toContain('Pro license');

    gateOn(proLicense());
    const allowed = await api('GET', '/orgs/license-status', undefined, 'alice');
    expect(allowed.json).toMatchObject({ gateEnabled: true, allowed: true });
    expect(allowed.json.code).toBeUndefined();
  });
});

describe('tenancy-depth router — B2 Pro gate', () => {
  let orgId: string;
  let base: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let env: Record<string, string>;
  let currentLicense: string | null;

  const gateOn = (license: string | null): void => {
    env.KRIYADOT_LICENSE_REQUIRED = '1';
    currentLicense = license;
  };

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tenancy-depth-pro-gate-'));
    const dbPath = join(dir, 'tenancy.db');
    const tenants = new TenantStore(dbPath);
    orgId = tenants.createOrg('Acme', 'boss-1').id;
    tenants.addMember(orgId, 'mem-1', 'member');
    env = {};
    currentLicense = null;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/tenancy',
      createTenancyDepthRouter({
        tenancyDbPath: dbPath,
        jwtSecret: JWT_SECRET,
        loopbackToken: OWNER_TOKEN,
        licenseGate: { env: env as NodeJS.ProcessEnv, loadLicense: () => currentLicense, publicKeyB64: PUB_B64 },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api/tenancy`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  const call = async (method: string, path: string, user: string, body?: unknown): Promise<ApiResult> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, 'x-user-id': user },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json() };
  };

  it('OFF (default): role templates, template invites, groups and group members all work', async () => {
    expect((await call('POST', `/orgs/${orgId}/role-templates`, 'boss-1', { name: 'Support', role: 'member' })).status).toBe(201);
    expect((await call('POST', `/orgs/${orgId}/invites/from-template`, 'boss-1', { email: 'n@x.co', template: 'Support' })).status).toBe(201);
    const g = await call('POST', `/orgs/${orgId}/groups`, 'boss-1', { name: 'Data' });
    expect(g.status).toBe(201);
    expect((await call('POST', `/orgs/${orgId}/groups/${g.json.group.id}/members`, 'boss-1', { userId: 'mem-1' })).status).toBe(200);
  });

  it('ON + no license: each gated depth capability refuses as Pro; quotas stay open', async () => {
    // Fixtures minted while OFF so the ON-state attempts are pure gate checks.
    await call('POST', `/orgs/${orgId}/role-templates`, 'boss-1', { name: 'Support', role: 'member' });
    const g = await call('POST', `/orgs/${orgId}/groups`, 'boss-1', { name: 'Data' });
    gateOn(null);
    for (const attempt of [
      () => call('POST', `/orgs/${orgId}/role-templates`, 'boss-1', { name: 'Ops', role: 'viewer' }),
      () => call('POST', `/orgs/${orgId}/invites/from-template`, 'boss-1', { email: 'n@x.co', template: 'Support' }),
      () => call('POST', `/orgs/${orgId}/groups`, 'boss-1', { name: 'More' }),
      () => call('POST', `/orgs/${orgId}/groups/${g.json.group.id}/members`, 'boss-1', { userId: 'mem-1' }),
    ]) {
      const r = await attempt();
      expect(r.status).toBe(403);
      expect(r.json.code).toBe(MULTI_USER_PRO_CODE);
      expect(r.json.requiredTier).toBe('pro');
    }
    // Not a membership-expanding write: quota configuration is ungated.
    expect((await call('PUT', `/orgs/${orgId}/quotas/mem-1`, 'boss-1', { storageBytes: 100, monthlyTokens: 50 })).status).toBe(200);
  });

  it('ON + Pro license: the gated depth capabilities work', async () => {
    gateOn(proLicense());
    expect((await call('POST', `/orgs/${orgId}/role-templates`, 'boss-1', { name: 'Support', role: 'member' })).status).toBe(201);
    expect((await call('POST', `/orgs/${orgId}/invites/from-template`, 'boss-1', { email: 'n@x.co', template: 'Support' })).status).toBe(201);
    const g = await call('POST', `/orgs/${orgId}/groups`, 'boss-1', { name: 'Data' });
    expect(g.status).toBe(201);
    expect((await call('POST', `/orgs/${orgId}/groups/${g.json.group.id}/members`, 'boss-1', { userId: 'mem-1' })).status).toBe(200);
  });
});
