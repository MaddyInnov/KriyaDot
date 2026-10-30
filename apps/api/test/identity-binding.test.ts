// SPDX-License-Identifier: Apache-2.0
// OPEN-1 regression suite — QA-REPORT-2026-10-30 §9.
//
// Before the fix, swapping the `x-user-id` header let any caller act as
// another user: read their org's member list, POST an admin invite as them
// (receiving the invite token), and persist an admin membership via a third
// identity. The same header scoped cloud (Lightning) credentials, the
// Composio vault, brand, installations, and KB ownership.
//
// Identity now comes ONLY from verified credentials (apps/api/src/principal.ts):
// the loopback owner token (whose bearer may assert a local profile — the
// owner is the root of trust on a single-owner install), an HS256 tenancy
// JWT (sub = identity, orgId claim binds the org), or an SSO session token.
// These tests encode the QA repro against every rebound surface and pin the
// legitimate flows that must keep working.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantStore, signTenancyJwt } from '@mvp/tenancy';
import type { AppConfig } from '../src/config.js';
import { registerTenancyRoutes } from '../src/tenancy.js';
import { createTenancyDepthRouter } from '../src/tenancy-depth-routes.js';
import { registerVaultRoutes } from '../src/vault.js';
import { createBrandRouter } from '../src/brand.js';
import { createInstallationsRouter } from '../src/installations.js';
import { createKbRouter } from '../src/kb-routes.js';
import { createOrgLibraryRouter } from '../src/org-library.js';
import { createPublishedBotsRouter } from '../src/published-bots-routes.js';
import { createCloudLightningRouter } from '../src/cloud-routes.js';
import { FakeLightningClient, InMemoryCloudSecretStore } from '../src/cloud-lightning.js';
import { registerComposioRoutes, type ComposioClient } from '../src/composio.js';
import { getSharedSsoSessionStore } from '../src/auth-sso.js';

const OWNER_TOKEN = 'owner-loopback-token';
const JWT_SECRET = 'identity-test-secret';
const COMPOSIO_KEY = 'ak_valid-test-key';

const mockComposio: ComposioClient = {
  validateApiKey: async (apiKey: string) =>
    apiKey === COMPOSIO_KEY ? { ok: true, orgName: 'Test Org' } : { ok: false },
  listApps: async () => [],
  createAuthLink: async () => ({ redirectUrl: 'https://example.invalid/link' }),
  listConnectedAccounts: async () => [],
  getConnectedAccount: async () => null,
  deleteConnectedAccount: async () => {},
  revokeConnectedAccount: async () => {},
  listTools: async () => [],
  executeTool: async () => ({ successful: true, data: {} }),
};

interface Ctx {
  base: string;
  store: TenantStore;
  orgA: string;
  orgB: string;
  bobJwt: string;
  daveJwt: string;
  carolSso: string;
  mallorySso: string;
}

let ctx: Ctx;
let server: { close: (cb?: () => void) => void };

interface CallOpts {
  /** Full Authorization header value. */
  auth?: string;
  /** x-user-id header (client-asserted identity — must be powerless for non-owners). */
  user?: string;
  body?: unknown;
}

async function call(method: string, path: string, opts: CallOpts = {}) {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.auth ? { authorization: opts.auth } : {}),
      ...(opts.user ? { 'x-user-id': opts.user } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json, text: JSON.stringify(json) };
}

const ownerAs = (profile: string): CallOpts => ({ auth: `Bearer ${OWNER_TOKEN}`, user: profile });
const bearer = (token: string): CallOpts => ({ auth: `Bearer ${token}` });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-binding-'));
  const dbPath = join(dir, 'tenancy.db');
  const store = new TenantStore(dbPath);
  const orgA = store.createOrg('Acme', 'alice').id; // alice = owner of org A
  store.addMember(orgA, 'dave', 'member');
  const orgB = store.createOrg('Beta', 'bob').id; // bob = owner of org B only

  const sso = getSharedSsoSessionStore(dir);
  const carolSso = sso.issue({ userId: 'carol', email: 'carol@example.com', provider: 'oidc', orgId: orgB }).token;
  const mallorySso = sso.issue({ userId: 'mallory', email: 'mallory@example.com', provider: 'oidc' }).token;

  const governance = { audit: vi.fn() } as unknown as import('@mvp/governance').GovernanceGateway;
  const config = { dataDir: dir } as AppConfig;
  const bots = [{ id: 'bot-1', name: 'Helper' }] as unknown as import('../src/routes.js').RouteDeps['bots'];

  const app = express();
  app.use(express.json());
  const api = express.Router();
  registerTenancyRoutes(api, { config, governance, loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET });
  app.use('/api/tenancy-depth', createTenancyDepthRouter({ tenancyDbPath: dbPath, jwtSecret: JWT_SECRET, loopbackToken: OWNER_TOKEN }));
  registerVaultRoutes(api, { config, governance, loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET });
  app.use('/api/brand', createBrandRouter({ dataDir: dir, tenancyDbPath: dbPath, loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET }));
  app.use('/api/installations', createInstallationsRouter({ dataDir: dir, tenancyDbPath: dbPath, registrationToken: 'reg-token', loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET }));
  app.use('/api/kb', createKbRouter({ dataDir: dir, loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET }));
  app.use('/api/org-library', createOrgLibraryRouter({ dataDir: dir, getBots: () => bots, loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET }));
  app.use('/api/published-bots', createPublishedBotsRouter({ dataDir: dir, getBots: () => bots, loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET }));
  app.use('/api', createCloudLightningRouter({
    secretStore: new InMemoryCloudSecretStore(),
    client: new FakeLightningClient([{ name: 'kriyadot', state: 'running', machine: 'CPU-4', teamspace: 'me/default', publicUrl: 'https://x-8080.lightning.ai/' }]),
    healthProbe: async () => true,
    loopbackToken: OWNER_TOKEN,
    jwtSecret: JWT_SECRET,
  }));
  registerComposioRoutes(api, { config, governance, bots, composioClient: mockComposio, loopbackToken: OWNER_TOKEN, jwtSecret: JWT_SECRET });
  app.use('/api', api);

  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => srv.on('listening', r));
  server = srv as unknown as { close: (cb?: () => void) => void };
  const addr = srv.address() as AddressInfo;
  ctx = {
    base: `http://127.0.0.1:${addr.port}`,
    store,
    orgA,
    orgB,
    bobJwt: signTenancyJwt({ sub: 'bob', orgId: orgB }, JWT_SECRET),
    daveJwt: signTenancyJwt({ sub: 'dave', orgId: orgA }, JWT_SECRET),
    carolSso,
    mallorySso,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('QA repro — tenancy org takeover via x-user-id swap', () => {
  it('member list: bob (verified, org B) gets 403 on org A — header swap changes nothing', async () => {
    const plain = await call('GET', `/api/orgs/${ctx.orgA}/members`, bearer(ctx.bobJwt));
    expect(plain.status).toBe(403);
    expect(plain.json.members).toBeUndefined();
    const swapped = await call('GET', `/api/orgs/${ctx.orgA}/members`, { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(swapped.status).toBe(403);
    expect(swapped.json.members).toBeUndefined();
    // SSO principal (carol) + header swap: same denial.
    const ssoSwapped = await call('GET', `/api/orgs/${ctx.orgA}/members`, { ...bearer(ctx.carolSso), user: 'alice' });
    expect(ssoSwapped.status).toBe(403);
    // Header only, no credential at all: denied.
    const headerOnly = await call('GET', `/api/orgs/${ctx.orgA}/members`, { user: 'alice' });
    expect(headerOnly.status).toBe(403);
  });

  it('admin invite as alice: denied, no invite persisted, no token leaks', async () => {
    const attack = await call('POST', `/api/orgs/${ctx.orgA}/invites`, {
      ...bearer(ctx.bobJwt),
      user: 'alice',
      body: { email: 'mallory@example.com', role: 'admin' },
    });
    expect(attack.status).toBe(403);
    expect(attack.text).not.toContain('token');
    expect(ctx.store.listInvites(ctx.orgA)).toHaveLength(0);
  });

  it('org creation requires a verified credential (401 header-only); owner profile assertion works', async () => {
    const headerOnly = await call('POST', '/api/orgs', { user: 'alice', body: { name: 'Forged' } });
    expect(headerOnly.status).toBe(401);
    // Owner-authorized profile selection: the loopback owner may act as a
    // chosen local profile (single-owner multi-profile UI).
    const asProfile = await call('POST', '/api/orgs', { ...ownerAs('profile-2'), body: { name: 'Second Org' } });
    expect(asProfile.status).toBe(201);
    expect(ctx.store.getMembership(asProfile.json.org.id as string, 'profile-2')?.role).toBe('owner');
  });

  it('legitimate flows: owner reads members; org-B owner works in his own org; member role limits hold', async () => {
    const ownerView = await call('GET', `/api/orgs/${ctx.orgA}/members`, ownerAs('alice'));
    expect(ownerView.status).toBe(200);
    expect((ownerView.json as unknown as Array<{ userId: string }>).map((m) => m.userId)).toContain('dave');

    const bobOwn = await call('GET', `/api/orgs/${ctx.orgB}/members`, bearer(ctx.bobJwt));
    expect(bobOwn.status).toBe(200);

    const daveInvite = await call('POST', `/api/orgs/${ctx.orgA}/invites`, {
      ...bearer(ctx.daveJwt),
      body: { email: 'x@example.com', role: 'admin' },
    });
    expect(daveInvite.status).toBe(403); // members cannot invite (owner/admin only)
    const daveView = await call('GET', `/api/orgs/${ctx.orgA}/members`, bearer(ctx.daveJwt));
    expect(daveView.status).toBe(200);
  });

  it('invite accept binds the grant to the VERIFIED acceptor, never the asserted header', async () => {
    const created = await call('POST', `/api/orgs/${ctx.orgA}/invites`, {
      ...ownerAs('alice'),
      body: { email: 'whoever@example.com', role: 'admin' },
    });
    expect(created.status).toBe(201);
    const token = created.json.token as string;
    expect(typeof token).toBe('string');

    // Bob presents the (bearer) invite token but asserts he is carol via the
    // header: the membership must land on bob — the verified subject.
    const accepted = await call('POST', '/api/orgs/invites/accept', {
      ...bearer(ctx.bobJwt),
      user: 'carol',
      body: { token },
    });
    expect(accepted.status).toBe(201);
    expect(ctx.store.getMembership(ctx.orgA, 'carol')).toBeUndefined();
    expect(ctx.store.getMembership(ctx.orgA, 'bob')?.role).toBe('admin');
    // Cleanup not needed: org A state is local to this suite.
  });

  it('tenancy-depth: a JWT bound to org B cannot touch org A groups, header or not', async () => {
    const attack = await call('POST', `/api/tenancy-depth/orgs/${ctx.orgA}/groups`, {
      ...bearer(ctx.bobJwt),
      user: 'alice',
      body: { name: 'pwned' },
    });
    expect(attack.status).toBe(403);
    const groups = await call('GET', `/api/tenancy-depth/orgs/${ctx.orgA}/groups`, ownerAs('alice'));
    expect(JSON.stringify(groups.json)).not.toContain('pwned');
  });
});

describe('same swap against every rebound surface', () => {
  it('vault: secrets stay in the verified user namespace', async () => {
    const put = await call('POST', '/api/vault', { ...ownerAs('alice'), body: { name: 'tok', value: 'alice-secret' } });
    expect(put.status).toBe(201);
    const bobRead = await call('GET', '/api/vault/tok', bearer(ctx.bobJwt));
    expect(bobRead.status).not.toBe(200);
    expect(bobRead.text).not.toContain('alice-secret');
    const bobSwapped = await call('GET', '/api/vault/tok', { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(bobSwapped.status).not.toBe(200);
    expect(bobSwapped.text).not.toContain('alice-secret');
    const headerOnly = await call('GET', '/api/vault/tok', { user: 'alice' });
    expect(headerOnly.status).toBe(401);
    const bobDelete = await call('DELETE', '/api/vault/tok', { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(bobDelete.status).not.toBe(200);
    const aliceRead = await call('GET', '/api/vault/tok', ownerAs('alice'));
    expect(aliceRead.status).toBe(200);
    expect(aliceRead.json.value).toBe('alice-secret');
  });

  it('cloud: Lightning credentials are scoped to the verified caller', async () => {
    const connect = await call('POST', '/api/cloud/lightning/connect', {
      ...ownerAs('alice'),
      body: { userId: 'alice-lightning', apiKey: 'alice-cloud-key' },
    });
    expect(connect.status).toBe(200);
    const bobStatus = await call('GET', '/api/cloud/lightning/status', bearer(ctx.bobJwt));
    expect(bobStatus.json.connected).toBe(false);
    const bobSwapped = await call('GET', '/api/cloud/lightning/status', { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(bobSwapped.json.connected).toBe(false);
    const headerOnly = await call('GET', '/api/cloud/lightning/status', { user: 'alice' });
    expect(headerOnly.status).toBe(401);
    // Bob "disconnecting" as alice must not delete alice's stored pair.
    await call('POST', '/api/cloud/lightning/disconnect', { ...bearer(ctx.bobJwt), user: 'alice' });
    const aliceStatus = await call('GET', '/api/cloud/lightning/status', ownerAs('alice'));
    expect(aliceStatus.json.connected).toBe(true);
  });

  it('composio: the connected key belongs to the verified caller only', async () => {
    const connect = await call('POST', '/api/composio/connect', { ...ownerAs('alice'), body: { apiKey: COMPOSIO_KEY } });
    expect(connect.status).toBe(200);
    const bobStatus = await call('GET', '/api/composio/status', bearer(ctx.bobJwt));
    expect(bobStatus.json.connected).toBe(false);
    const bobSwapped = await call('GET', '/api/composio/status', { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(bobSwapped.json.connected).toBe(false);
    const headerOnly = await call('GET', '/api/composio/status', { user: 'alice' });
    expect(headerOnly.status).toBe(401);
  });

  it('kb: corpora are invisible to other verified users, header swap included', async () => {
    const created = await call('POST', '/api/kb', { ...ownerAs('alice'), body: { name: 'Alice KB' } });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const bobRead = await call('GET', `/api/kb/${id}`, { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(bobRead.status).not.toBe(200);
    const headerOnly = await call('GET', '/api/kb', { user: 'alice' });
    expect(headerOnly.status).toBe(401);
  });

  it('org library + published bots: private entries stay private under a swapped header', async () => {
    const entry = await call('POST', '/api/org-library', {
      ...ownerAs('alice'),
      body: { kind: 'skill', name: 'Private playbook', payload: { name: 's' } },
    });
    expect(entry.status).toBe(201);
    const entryId = entry.json.entry.id as string;
    const bobList = await call('GET', '/api/org-library', { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(JSON.stringify(bobList.json)).not.toContain('Private playbook');
    const bobRead = await call('GET', `/api/org-library/${entryId}`, { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(bobRead.status).not.toBe(200);

    const pub = await call('POST', '/api/published-bots', {
      ...ownerAs('alice'),
      body: { botId: 'bot-1', visibility: 'private' },
    });
    expect(pub.status).toBe(201);
    const pubId = pub.json.published.id as string;
    const bobInstall = await call('POST', `/api/published-bots/${pubId}/install`, { ...bearer(ctx.bobJwt), user: 'alice' });
    expect(bobInstall.status).toBe(403);
  });

  it('brand + installations: admin gates evaluate the verified subject', async () => {
    // (Bob is a genuine org owner — of org B — so the surface's any-org
    // admin rule legitimately admits him; the flaw cases are a NON-admin
    // verified user asserting an admin's name, and a header-only caller.)
    const nobodyJwt = signTenancyJwt({ sub: 'nobody', orgId: ctx.orgB }, JWT_SECRET);
    const denied = await call('PUT', '/api/brand', { ...bearer(nobodyJwt), user: 'alice', body: { name: 'Hax' } });
    expect(denied.status).toBe(403);
    const headerOnlyPut = await call('PUT', '/api/brand', { user: 'alice', body: { name: 'Hax' } });
    expect(headerOnlyPut.status).toBe(403);
    const listDenied = await call('GET', '/api/installations', { ...bearer(nobodyJwt), user: 'alice' });
    expect(listDenied.status).toBe(403);
    const brandNow = await call('GET', '/api/brand');
    expect(brandNow.json.brand?.name).not.toBe('Hax');
  });
});
