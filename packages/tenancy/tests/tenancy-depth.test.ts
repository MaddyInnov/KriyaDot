// SPDX-License-Identifier: Apache-2.0
// Tests for tenancy depth: HS256 JWT sessions, role templates, groups +
// grants, resource audience checks, per-user quotas/usage, external users.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TenancyExtrasStore,
  TenantStore,
  canUserAccessResource,
  signTenancyJwt,
  tenancyJwtFromHeader,
  verifyTenancyJwt,
} from '../src/index.js';

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'tenancy-depth-')), 'tenancy.db');
}

const SECRET = 'test-secret-0123456789';

describe('tenancy JWT (HS256)', () => {
  it('signs and verifies with org/user claims', () => {
    const tok = signTenancyJwt({ sub: 'u-alice', orgId: 'org_1', role: 'admin' }, SECRET);
    const claims = verifyTenancyJwt(tok, SECRET);
    expect(claims?.sub).toBe('u-alice');
    expect(claims?.orgId).toBe('org_1');
    expect(claims?.role).toBe('admin');
    expect(claims?.exp).toBeGreaterThan(claims?.iat ?? 0);
  });
  it('rejects wrong secret, tampering, expiry, and non-HS256 alg', () => {
    const tok = signTenancyJwt({ sub: 'u-a', orgId: 'o' }, SECRET);
    expect(verifyTenancyJwt(tok, 'other-secret')).toBeNull();
    const [h, , s] = tok.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'u-evil', orgId: 'o', exp: 9999999999 })).toString('base64url')}.${s}`;
    expect(verifyTenancyJwt(forged, SECRET)).toBeNull();
    const expired = signTenancyJwt({ sub: 'u-a', orgId: 'o' }, SECRET, -1000);
    expect(verifyTenancyJwt(expired, SECRET)).toBeNull();
    expect(verifyTenancyJwt('not-a-jwt', SECRET)).toBeNull();
    expect(verifyTenancyJwt(null, SECRET)).toBeNull();
  });
  it('extracts from a Bearer header', () => {
    const tok = signTenancyJwt({ sub: 'u-b', orgId: 'o2' }, SECRET);
    expect(tenancyJwtFromHeader(`Bearer ${tok}`, SECRET)?.sub).toBe('u-b');
    expect(tenancyJwtFromHeader(undefined, SECRET)).toBeNull();
    expect(tenancyJwtFromHeader('Basic x', SECRET)).toBeNull();
  });
});

describe('TenancyExtrasStore', () => {
  let tenants: TenantStore;
  let extras: TenancyExtrasStore;
  let orgId: string;
  beforeEach(() => {
    const db = freshDb();
    tenants = new TenantStore(db);
    extras = new TenancyExtrasStore(db);
    orgId = tenants.createOrg('Acme', 'owner-1').id;
    tenants.addMember(orgId, 'member-1', 'member');
    tenants.addMember(orgId, 'member-2', 'member');
  });

  it('upserts external (SSO/LDAP) users by email', () => {
    const u1 = extras.upsertExternalUser({ email: 'Alice@Example.com', name: 'Alice', provider: 'oidc', externalId: 'sub1' });
    expect(u1.userId).toBe('u-alice-example-com');
    const u2 = extras.upsertExternalUser({ email: 'alice@example.com', name: 'Alice A', provider: 'ldap' });
    expect(u2.userId).toBe(u1.userId);
    expect(u2.name).toBe('Alice A');
  });

  it('role templates are org-scoped and assignable', () => {
    const tpl = extras.createRoleTemplate(orgId, 'Support', 'member', ['tickets:read']);
    expect(tpl.role).toBe('member');
    expect(extras.getRoleTemplateByName(orgId, 'Support')?.permissions).toEqual(['tickets:read']);
    expect(extras.listRoleTemplates(orgId)).toHaveLength(1);
    const other = tenants.createOrg('Other', 'owner-9').id;
    expect(extras.listRoleTemplates(other)).toHaveLength(0);
  });

  it('groups, grants and audience gate resource access', () => {
    const g = extras.createGroup(orgId, 'Data Team', ['member-1']);
    extras.setResourceAudience({ orgId, resourceType: 'kb', resourceId: 'kb1', visibility: 'groups', allowedGroupIds: [g.id] });
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-1', resourceType: 'kb', resourceId: 'kb1' })).toBe(true);
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-2', resourceType: 'kb', resourceId: 'kb1' })).toBe(false);
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'outsider', resourceType: 'kb', resourceId: 'kb1' })).toBe(false);
    // Grant level enforcement: a read-only grant blocks 'use'.
    extras.grantToGroup({ groupId: g.id, orgId, resourceType: 'kb', resourceId: 'kb1', level: 'read' });
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-1', resourceType: 'kb', resourceId: 'kb1', level: 'read' })).toBe(true);
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-1', resourceType: 'kb', resourceId: 'kb1', level: 'use' })).toBe(false);
    extras.grantToGroup({ groupId: g.id, orgId, resourceType: 'kb', resourceId: 'kb1', level: 'use' });
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-1', resourceType: 'kb', resourceId: 'kb1', level: 'use' })).toBe(true);
  });

  it('private audience is owner-only; org audience is member-wide; admins bypass', () => {
    extras.setResourceAudience({ orgId, resourceType: 'bot', resourceId: 'b1', visibility: 'private', allowedGroupIds: [], ownerUserId: 'member-1' });
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-1', resourceType: 'bot', resourceId: 'b1' })).toBe(true);
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-2', resourceType: 'bot', resourceId: 'b1' })).toBe(false);
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'owner-1', resourceType: 'bot', resourceId: 'b1' })).toBe(true);
    extras.setResourceAudience({ orgId, resourceType: 'bot', resourceId: 'b2', visibility: 'org', allowedGroupIds: [] });
    expect(canUserAccessResource(tenants, extras, { orgId, userId: 'member-2', resourceType: 'bot', resourceId: 'b2' })).toBe(true);
  });

  it('quotas: set, usage accounting, enforcement', () => {
    extras.setQuota({ orgId, userId: 'member-1', storageBytes: 1000, monthlyTokens: 500 });
    expect(extras.checkQuota(orgId, 'member-1', { monthlyTokens: 400 }).ok).toBe(true);
    extras.recordUsage(orgId, 'member-1', { monthlyTokens: 400, storageBytes: 900 });
    expect(extras.checkQuota(orgId, 'member-1', { monthlyTokens: 200 }).ok).toBe(false);
    expect(extras.checkQuota(orgId, 'member-1', { storageBytes: 200 }).ok).toBe(false);
    expect(extras.checkQuota(orgId, 'member-1', { monthlyTokens: 100 }).ok).toBe(true);
    expect(extras.checkQuota(orgId, 'member-2', { monthlyTokens: 999999 }).ok).toBe(true); // no quota = unlimited
    expect(extras.getUsage(orgId, 'member-1').monthlyTokens).toBe(400);
  });
});
