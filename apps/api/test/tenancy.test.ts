// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/tenancy.ts: role checks deny correctly (viewer
// cannot invite/assign/remove), invite lifecycle, tenant isolation leaks
// nothing, viewer responses are PII-masked, last-owner protection holds.
// Temp data dirs only — never the shared data dir.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from '../src/config.js';
import { registerTenancyRoutes } from '../src/tenancy.js';

const OWNER_TOKEN = 'test-owner-token'; // loopback owner credential (OPEN-1: tests authenticate as the owner; x-user-id then asserts the local profile)


function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'tenancy-api-'));
}

interface ApiResult {
  status: number;
  json: any;
}

describe('tenancy router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let governance: GovernanceGateway;

  beforeEach(async () => {
    dir = freshDataDir();
    governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerTenancyRoutes(router, {
      config: { dataDir: dir } as AppConfig,
      governance,
      loopbackToken: OWNER_TOKEN,
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  async function api(
    method: string,
    path: string,
    body?: unknown,
    userId?: string,
  ): Promise<ApiResult> {
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

  it('creates an org with the caller as owner and lists it', async () => {
    const id = await createOrg('Acme');
    const listed = await api('GET', '/orgs', undefined, 'alice');
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0].role).toBe('owner');
    expect(listed.json[0].org.id).toBe(id);
    // A stranger sees no orgs and is denied detail.
    expect((await api('GET', '/orgs', undefined, 'mallory')).json).toEqual([]);
    expect((await api('GET', `/orgs/${id}`, undefined, 'mallory')).status).toBe(403);
  });

  it('denies viewer from inviting, assigning roles, and removing members', async () => {
    const id = await createOrg('Acme');
    // Bring in a viewer.
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'viewer' }, 'alice');
    expect(inv.status).toBe(201);
    const acc = await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'victor');
    expect(acc.status).toBe(201);

    expect((await api('POST', `/orgs/${id}/invites`, { email: 'x@example.com', role: 'member' }, 'victor')).status).toBe(403);
    expect((await api('GET', `/orgs/${id}/invites`, undefined, 'victor')).status).toBe(403);
    expect((await api('PUT', `/orgs/${id}/members/victor`, { role: 'member' }, 'victor')).status).toBe(403);
    expect((await api('DELETE', `/orgs/${id}/members/victor`, undefined, 'victor')).status).toBe(403);
  });

  it('masks member PII for viewers', async () => {
    const id = await createOrg('Acme');
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'v@example.com', role: 'viewer' }, 'alice');
    await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'victor');
    const detail = await api('GET', `/orgs/${id}`, undefined, 'victor');
    expect(detail.status).toBe(200);
    const blob = JSON.stringify(detail.json);
    expect(blob).not.toContain('v@example.com');
    const members = await api('GET', `/orgs/${id}/members`, undefined, 'victor');
    expect(JSON.stringify(members.json)).not.toContain('v@example.com');
  });

  it('caps invite roles at the inviter rank and protects the last owner', async () => {
    const id = await createOrg('Acme');
    // Owner invites an admin, admin accepts.
    const inv = await api('POST', `/orgs/${id}/invites`, { email: 'a@example.com', role: 'admin' }, 'alice');
    await api('POST', '/orgs/invites/accept', { token: inv.json.token }, 'amy');
    // Admin cannot create another owner.
    const bad = await api('POST', `/orgs/${id}/invites`, { email: 'o@example.com', role: 'owner' }, 'amy');
    expect(bad.status).toBe(403);
    // Admin cannot demote the only owner.
    expect((await api('PUT', `/orgs/${id}/members/alice`, { role: 'member' }, 'amy')).status).toBe(400);
    // Owner promotes admin to owner, then the demotion is fine.
    expect((await api('PUT', `/orgs/${id}/members/amy`, { role: 'owner' }, 'alice')).status).toBe(200);
    expect((await api('PUT', `/orgs/${id}/members/alice`, { role: 'member' }, 'amy')).status).toBe(200);
  });

  it('revokes invites and rejects bad tokens', async () => {
    const id = await createOrg('Acme');
    await api('POST', `/orgs/${id}/invites`, { email: 'z@example.com', role: 'member' }, 'alice');
    expect((await api('DELETE', `/orgs/${id}/invites/z@example.com`, undefined, 'alice')).status).toBe(200);
    expect((await api('DELETE', `/orgs/${id}/invites/z@example.com`, undefined, 'alice')).status).toBe(404);
    expect((await api('POST', '/orgs/invites/accept', { token: 'inv_bogus' }, 'zed')).status).toBe(400);
  });

  it('exposes the tenantScope filter descriptor', async () => {
    const id = await createOrg('Acme');
    const r = await api('GET', `/orgs/${id}/scope`, undefined, 'alice');
    expect(r.status).toBe(200);
    expect(r.json.orgId).toBe(id);
    expect(r.json.filter.where).toBe('"org_id" = ?');
    expect(r.json.filter.params).toEqual([id]);
  });
});
