// SPDX-License-Identifier: Apache-2.0
// Published-bot routes (see published-bots.ts for the store).
//
// HOST WIRING (index.ts):
//   import { createPublishedBotsRouter } from './published-bots-routes.js';
//   app.use('/api/published-bots', createPublishedBotsRouter({
//     dataDir: config.dataDir, getBots: () => seed.bots,
//     audit: (a, f) => governance.audit(a, f),
//   }));
//
//   POST   /              { botId, orgId?, visibility?, allowedGroupIds? }
//   GET    /              ?orgId=  → entries the caller may view
//   POST   /:id/install   { name? } → creates a copy in the live roster
//   DELETE /:id           → unpublish (publisher only)
// Identity: x-user-id header; org from body/query or x-org-id header.

import { join } from 'node:path';
import express, { type Router } from 'express';
import { TenancyExtrasStore } from '@mvp/tenancy';
import type { BotConfig } from '@mvp/agent-runtime';
import { appendRosterImport } from './bot-roster-routes.js';
import { PublishedBotStore, canViewPublished, makeInstalledCopy } from './published-bots.js';

export interface PublishedBotsDeps {
  dataDir: string;
  getBots: () => BotConfig[];
  tenancyDbPath?: string;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function callerOf(req: express.Request): string {
  const h = req.header('x-user-id');
  return typeof h === 'string' && h ? h : 'default-user';
}

function err(res: express.Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

export function createPublishedBotsRouter(deps: PublishedBotsDeps): Router {
  const router = express.Router();
  const store = new PublishedBotStore(deps.dataDir);
  const extras = new TenancyExtrasStore(deps.tenancyDbPath ?? join(deps.dataDir, 'tenancy.db'));

  function viewer(req: express.Request, orgId: string): { userId: string; orgId: string; groupIds: string[] } {
    const userId = callerOf(req);
    let groupIds: string[] = [];
    try {
      groupIds = extras.groupsForUser(orgId, userId).map((g) => g.id);
    } catch {
      groupIds = [];
    }
    return { userId, orgId, groupIds };
  }

  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown; orgId?: unknown; visibility?: unknown; allowedGroupIds?: unknown };
    const bot = deps.getBots().find((b) => b.id === body.botId);
    if (!bot) return err(res, 404, `unknown bot "${String(body.botId)}"`);
    const orgId = typeof body.orgId === 'string' && body.orgId ? body.orgId : req.header('x-org-id') || 'default-org';
    const visibility = ['org', 'groups', 'private'].includes(String(body.visibility)) ? (body.visibility as 'org' | 'groups' | 'private') : 'org';
    const entry = store.publish({
      bot,
      orgId,
      publishedBy: callerOf(req),
      visibility,
      allowedGroupIds: Array.isArray(body.allowedGroupIds) ? (body.allowedGroupIds as string[]) : [],
    });
    deps.audit?.('bots.published', { actor: callerOf(req), detail: { botId: bot.id, publishedId: entry.id, orgId } });
    res.status(201).json({ ok: true, published: entry });
  });

  router.get('/', (req, res) => {
    const orgId = typeof req.query.orgId === 'string' && req.query.orgId ? req.query.orgId : req.header('x-org-id') || 'default-org';
    const v = viewer(req, orgId);
    res.json({ ok: true, published: store.list().filter((e) => canViewPublished(e, v)) });
  });

  router.post('/:id/install', (req, res) => {
    const entry = store.get(req.params.id);
    if (!entry) return err(res, 404, 'unknown published bot');
    const v = viewer(req, entry.orgId);
    if (!canViewPublished(entry, v)) return err(res, 403, 'this template is not visible to you');
    const bots = deps.getBots();
    const body = (req.body ?? {}) as { name?: unknown };
    const copy = makeInstalledCopy(entry.snapshot, new Set(bots.map((b) => b.id)), typeof body.name === 'string' && body.name ? body.name : undefined);
    bots.push(copy);
    appendRosterImport(copy, deps.dataDir);
    deps.audit?.('bots.published_installed', { actor: v.userId, detail: { publishedId: entry.id, newBotId: copy.id } });
    res.status(201).json({ ok: true, bot: copy });
  });

  router.delete('/:id', (req, res) => {
    const entry = store.get(req.params.id);
    if (!entry) return err(res, 404, 'unknown published bot');
    if (entry.publishedBy !== callerOf(req)) return err(res, 403, 'only the publisher can unpublish');
    store.unpublish(entry.id);
    deps.audit?.('bots.unpublished', { actor: callerOf(req), detail: { publishedId: entry.id } });
    res.json({ ok: true });
  });

  return router;
}
