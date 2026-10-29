// SPDX-License-Identifier: Apache-2.0
// Tenancy-depth routes: role templates, user groups + grants, per-resource
// audience, per-user quotas/usage — backed by @mvp/tenancy's
// TenancyExtrasStore (see packages/tenancy/src/index.ts).
//
// HOST WIRING (index.ts):
//   import { createTenancyDepthRouter } from './tenancy-depth-routes.js';
//   app.use('/api/tenancy', createTenancyDepthRouter({
//     tenancyDbPath: join(config.dataDir, 'tenancy.db'),
//     audit: (a, f) => governance.audit(a, f),
//   }));
//
// Routes (mounted at /api/tenancy):
//   POST /orgs/:id/role-templates { name, role, permissions? }   (admin+)
//   GET  /orgs/:id/role-templates                                (member+)
//   POST /orgs/:id/invites/from-template { email, template }     (admin+)
//   POST /orgs/:id/groups { name, memberIds? }                   (admin+)
//   GET  /orgs/:id/groups                                        (member+)
//   POST /orgs/:id/groups/:groupId/members { userId }            (admin+)
//   POST /orgs/:id/groups/:groupId/grants { resourceType, resourceId, level } (admin+)
//   PUT  /orgs/:id/audience { resourceType, resourceId, visibility, allowedGroupIds?, ownerUserId? } (admin+)
//   GET  /orgs/:id/access?userId&resourceType&resourceId&level   (member+)
//   PUT  /orgs/:id/quotas/:userId { storageBytes, monthlyTokens } (admin+)
//   GET  /orgs/:id/quotas/:userId                                (member+; self or admin)
//   POST /orgs/:id/usage/:userId { storageBytes?, monthlyTokens? } → enforces quota (402 on exceed)
//
// Identity: x-user-id header (same convention as tenancy.ts) OR a tenancy
// JWT (`Authorization: Bearer <HS256 jwt>`, secret from deps.jwtSecret /
// env KRIYADOT_TENANCY_JWT_SECRET) whose sub/orgId claims scope the call.

import { join } from 'node:path';
import express, { type Router } from 'express';
import {
  TenantStore,
  TenancyExtrasStore,
  canAct,
  canUserAccessResource,
  isRole,
  tenancyJwtFromHeader,
  type ResourceType,
  type Role,
} from '@mvp/tenancy';

export interface TenancyDepthDeps {
  dataDir?: string;
  tenancyDbPath?: string;
  jwtSecret?: string;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function err(res: express.Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

export function createTenancyDepthRouter(deps: TenancyDepthDeps): Router {
  const router = express.Router();
  const dbPath = deps.tenancyDbPath ?? join(deps.dataDir ?? '.', 'tenancy.db');
  const tenants = new TenantStore(dbPath);
  const extras = new TenancyExtrasStore(dbPath);
  const jwtSecret = deps.jwtSecret ?? process.env.KRIYADOT_TENANCY_JWT_SECRET ?? '';

  function caller(req: express.Request): { userId: string; jwtOrgId?: string } {
    if (jwtSecret) {
      const claims = tenancyJwtFromHeader(req.headers.authorization, jwtSecret);
      if (claims) return { userId: claims.sub, jwtOrgId: claims.orgId };
    }
    const h = req.header('x-user-id');
    return { userId: typeof h === 'string' && h ? h : 'default-user' };
  }

  function gate(req: express.Request, res: express.Response, required: Role): { orgId: string; userId: string; role: Role } | null {
    const orgId = req.params.id;
    const { userId, jwtOrgId } = caller(req);
    if (jwtOrgId && jwtOrgId !== orgId) {
      err(res, 403, 'JWT is scoped to a different org');
      return null;
    }
    const membership = tenants.getMembership(orgId, userId);
    if (!membership || !canAct(membership.role, required)) {
      err(res, 403, `requires the "${required}" role or higher in this org`);
      return null;
    }
    return { orgId, userId, role: membership.role };
  }

  router.post('/orgs/:id/role-templates', (req, res) => {
    const ctx = gate(req, res, 'admin');
    if (!ctx) return;
    const body = (req.body ?? {}) as { name?: unknown; role?: unknown; permissions?: unknown };
    if (!isRole(body.role)) return err(res, 400, 'role must be owner|admin|member|viewer');
    try {
      const tpl = extras.createRoleTemplate(ctx.orgId, String(body.name ?? ''), body.role, Array.isArray(body.permissions) ? (body.permissions as string[]) : []);
      deps.audit?.('tenancy.role_template_created', { actor: ctx.userId, detail: { orgId: ctx.orgId, name: tpl.name } });
      res.status(201).json({ ok: true, template: tpl });
    } catch (e) {
      err(res, 400, e instanceof Error ? e.message : 'invalid template');
    }
  });

  router.get('/orgs/:id/role-templates', (req, res) => {
    if (!gate(req, res, 'viewer')) return;
    res.json({ ok: true, templates: extras.listRoleTemplates(req.params.id) });
  });

  router.post('/orgs/:id/invites/from-template', (req, res) => {
    const ctx = gate(req, res, 'admin');
    if (!ctx) return;
    const body = (req.body ?? {}) as { email?: unknown; template?: unknown };
    const tpl = extras.getRoleTemplateByName(ctx.orgId, String(body.template ?? ''));
    if (!tpl) return err(res, 404, 'unknown role template');
    try {
      const invite = tenants.createInvite(ctx.orgId, String(body.email ?? ''), tpl.role);
      res.status(201).json({ ok: true, invite: { orgId: invite.orgId, email: invite.email, role: invite.role, token: invite.token, template: tpl.name } });
    } catch (e) {
      err(res, 400, e instanceof Error ? e.message : 'invalid invite');
    }
  });

  router.post('/orgs/:id/groups', (req, res) => {
    const ctx = gate(req, res, 'admin');
    if (!ctx) return;
    const body = (req.body ?? {}) as { name?: unknown; memberIds?: unknown };
    try {
      const group = extras.createGroup(ctx.orgId, String(body.name ?? ''), Array.isArray(body.memberIds) ? (body.memberIds as string[]) : []);
      res.status(201).json({ ok: true, group });
    } catch (e) {
      err(res, 400, e instanceof Error ? e.message : 'invalid group');
    }
  });

  router.get('/orgs/:id/groups', (req, res) => {
    if (!gate(req, res, 'viewer')) return;
    res.json({ ok: true, groups: extras.listGroups(req.params.id) });
  });

  router.post('/orgs/:id/groups/:groupId/members', (req, res) => {
    const ctx = gate(req, res, 'admin');
    if (!ctx) return;
    const group = extras.getGroup(req.params.groupId);
    if (!group || group.orgId !== ctx.orgId) return err(res, 404, 'unknown group');
    const body = (req.body ?? {}) as { userId?: unknown };
    if (typeof body.userId !== 'string' || !body.userId) return err(res, 400, 'userId is required');
    extras.addGroupMember(group.id, body.userId);
    res.json({ ok: true, group: extras.getGroup(group.id) });
  });

  router.post('/orgs/:id/groups/:groupId/grants', (req, res) => {
    const ctx = gate(req, res, 'admin');
    if (!ctx) return;
    const group = extras.getGroup(req.params.groupId);
    if (!group || group.orgId !== ctx.orgId) return err(res, 404, 'unknown group');
    const body = (req.body ?? {}) as { resourceType?: unknown; resourceId?: unknown; level?: unknown };
    if (!['bot', 'skill', 'kb'].includes(String(body.resourceType))) return err(res, 400, 'resourceType must be bot|skill|kb');
    if (typeof body.resourceId !== 'string' || !body.resourceId) return err(res, 400, 'resourceId is required');
    if (!['read', 'use'].includes(String(body.level))) return err(res, 400, 'level must be read|use');
    const grant = extras.grantToGroup({
      groupId: group.id,
      orgId: ctx.orgId,
      resourceType: body.resourceType as ResourceType,
      resourceId: body.resourceId,
      level: body.level as 'read' | 'use',
    });
    res.status(201).json({ ok: true, grant });
  });

  router.put('/orgs/:id/audience', (req, res) => {
    const ctx = gate(req, res, 'admin');
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!['bot', 'skill', 'kb'].includes(String(body.resourceType))) return err(res, 400, 'resourceType must be bot|skill|kb');
    if (!['org', 'groups', 'private'].includes(String(body.visibility))) return err(res, 400, 'visibility must be org|groups|private');
    try {
      const audience = extras.setResourceAudience({
        orgId: ctx.orgId,
        resourceType: body.resourceType as ResourceType,
        resourceId: String(body.resourceId ?? ''),
        visibility: body.visibility as 'org' | 'groups' | 'private',
        allowedGroupIds: Array.isArray(body.allowedGroupIds) ? (body.allowedGroupIds as string[]) : [],
        ownerUserId: typeof body.ownerUserId === 'string' ? body.ownerUserId : undefined,
      });
      res.json({ ok: true, audience });
    } catch (e) {
      err(res, 400, e instanceof Error ? e.message : 'invalid audience');
    }
  });

  router.get('/orgs/:id/access', (req, res) => {
    if (!gate(req, res, 'viewer')) return;
    const userId = String(req.query.userId ?? '');
    const resourceType = String(req.query.resourceType ?? '') as ResourceType;
    const resourceId = String(req.query.resourceId ?? '');
    const level = req.query.level === 'use' ? 'use' : 'read';
    const allowed = canUserAccessResource(tenants, extras, { orgId: req.params.id, userId, resourceType, resourceId, level });
    res.json({ ok: true, allowed });
  });

  router.put('/orgs/:id/quotas/:userId', (req, res) => {
    const ctx = gate(req, res, 'admin');
    if (!ctx) return;
    const body = (req.body ?? {}) as { storageBytes?: unknown; monthlyTokens?: unknown };
    const quota = extras.setQuota({
      orgId: ctx.orgId,
      userId: req.params.userId,
      storageBytes: Number(body.storageBytes ?? 0),
      monthlyTokens: Number(body.monthlyTokens ?? 0),
    });
    res.json({ ok: true, quota });
  });

  router.get('/orgs/:id/quotas/:userId', (req, res) => {
    const ctx = gate(req, res, 'viewer');
    if (!ctx) return;
    if (ctx.userId !== req.params.userId && !canAct(ctx.role, 'admin')) return err(res, 403, 'can only read your own quota');
    res.json({
      ok: true,
      quota: extras.getQuota(ctx.orgId, req.params.userId) ?? null,
      usage: extras.getUsage(ctx.orgId, req.params.userId),
    });
  });

  router.post('/orgs/:id/usage/:userId', (req, res) => {
    const ctx = gate(req, res, 'viewer');
    if (!ctx) return;
    const body = (req.body ?? {}) as { storageBytes?: unknown; monthlyTokens?: unknown };
    const delta = { storageBytes: Number(body.storageBytes ?? 0), monthlyTokens: Number(body.monthlyTokens ?? 0) };
    const check = extras.checkQuota(ctx.orgId, req.params.userId, delta);
    if (!check.ok) return err(res, 402, check.reason ?? 'quota exceeded');
    const usage = extras.recordUsage(ctx.orgId, req.params.userId, delta);
    res.json({ ok: true, usage });
  });

  return router;
}
