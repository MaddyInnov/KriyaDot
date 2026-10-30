// SPDX-License-Identifier: Apache-2.0
// Tenancy-depth routes: role templates + template invites, groups/grants/
// audience/access, quotas/usage enforcement, JWT-scoped callers.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantStore, signTenancyJwt } from '@mvp/tenancy';
import { createTenancyDepthRouter } from '../src/tenancy-depth-routes.js';

const JWT_SECRET = 'route-test-secret';
const OWNER_TOKEN = 'test-owner-token'; // loopback owner credential (OPEN-1: tests authenticate as the owner; x-user-id then asserts the local profile)

describe('tenancy-depth routes', () => {
  let orgId: string;
  let srv: { base: string; close: () => void };
  afterEach(() => srv?.close());

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tenancy-depth-routes-'));
    const dbPath = join(dir, 'tenancy.db');
    const tenants = new TenantStore(dbPath);
    orgId = tenants.createOrg('Acme', 'boss-1').id;
    tenants.addMember(orgId, 'mem-1', 'member');
    const app = express();
    app.use(express.json());
    app.use('/api/tenancy', createTenancyDepthRouter({ tenancyDbPath: dbPath, jwtSecret: JWT_SECRET, loopbackToken: OWNER_TOKEN }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    srv = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenancy`, close: () => server.close() };
  });

  const call = (method: string, path: string, user: string, body?: unknown) =>
    fetch(`${srv.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, 'x-user-id': user },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it('role templates: admin creates, member cannot; template invite carries the role', async () => {
    expect((await call('POST', `/orgs/${orgId}/role-templates`, 'mem-1', { name: 'Support', role: 'member' })).status).toBe(403);
    const created = await call('POST', `/orgs/${orgId}/role-templates`, 'boss-1', { name: 'Support', role: 'member', permissions: ['tickets'] });
    expect(created.status).toBe(201);
    const invite = await (await call('POST', `/orgs/${orgId}/invites/from-template`, 'boss-1', { email: 'new@x.co', template: 'Support' })).json() as { invite: { role: string; token: string } };
    expect(invite.invite.role).toBe('member');
    expect(invite.invite.token).toMatch(/^inv_/);
  });

  it('groups + grants + audience drive the access check', async () => {
    const g = await (await call('POST', `/orgs/${orgId}/groups`, 'boss-1', { name: 'Data', memberIds: ['mem-1'] })).json() as { group: { id: string } };
    await call('PUT', `/orgs/${orgId}/audience`, 'boss-1', { resourceType: 'kb', resourceId: 'kb1', visibility: 'groups', allowedGroupIds: [g.group.id] });
    const yes = await (await call('GET', `/orgs/${orgId}/access?userId=mem-1&resourceType=kb&resourceId=kb1`, 'boss-1')).json() as { allowed: boolean };
    expect(yes.allowed).toBe(true);
    const no = await (await call('GET', `/orgs/${orgId}/access?userId=boss-2&resourceType=kb&resourceId=kb1`, 'boss-1')).json() as { allowed: boolean };
    expect(no.allowed).toBe(false);
  });

  it('quotas: set, read, usage accounting, 402 on exceed', async () => {
    await call('PUT', `/orgs/${orgId}/quotas/mem-1`, 'boss-1', { storageBytes: 100, monthlyTokens: 50 });
    const okUse = await call('POST', `/orgs/${orgId}/usage/mem-1`, 'mem-1', { monthlyTokens: 40 });
    expect(okUse.status).toBe(200);
    const over = await call('POST', `/orgs/${orgId}/usage/mem-1`, 'mem-1', { monthlyTokens: 20 });
    expect(over.status).toBe(402);
    const read = await (await call('GET', `/orgs/${orgId}/quotas/mem-1`, 'mem-1')).json() as { usage: { monthlyTokens: number } };
    expect(read.usage.monthlyTokens).toBe(40);
  });

  it('accepts a tenancy JWT as the caller credential and scopes it to its org', async () => {
    const jwt = signTenancyJwt({ sub: 'boss-1', orgId }, JWT_SECRET);
    const res = await fetch(`${srv.base}/orgs/${orgId}/role-templates`, { headers: { Authorization: `Bearer ${jwt}` } });
    expect(res.status).toBe(200);
    const wrongOrg = signTenancyJwt({ sub: 'boss-1', orgId: 'org_other' }, JWT_SECRET);
    const res2 = await fetch(`${srv.base}/orgs/${orgId}/role-templates`, { headers: { Authorization: `Bearer ${wrongOrg}` } });
    expect(res2.status).toBe(403);
  });
});
