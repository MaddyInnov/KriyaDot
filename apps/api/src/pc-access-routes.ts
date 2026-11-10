// SPDX-License-Identifier: Apache-2.0
// Approval-gated PC file access (2026-11-10).
//
//   GET    /pc-access/grants                 list folder grants
//   POST   /pc-access/grants                 { path | specialFolder, scope? }
//   DELETE /pc-access/grants/:id             revoke a grant
//   GET    /pc-access/special-folders        Desktop/Documents/Downloads/Home
//                                            resolved for THIS host machine
//   GET    /pc-access/requests?status=...    just-in-time request cards
//   POST   /pc-access/requests/:id           { decision: allow-once|always|deny }
//
// Grants are created ONLY here (the user in Settings) or by approving a
// request card with "always" — a bot can never grant itself access. The
// grant store + card store live in agent-runtime (PcAccessStore); this
// router is the user's management surface, mirroring
// credential-proposal-routes.ts.
//
// HOST WIRING (index.ts):
//   const pcAccessStore = new PcAccessStore(config.dataDir);
//   app.use('/api', createPcAccessRouter({
//     store: pcAccessStore,
//     audit: (action, fields) => governance.audit(action, fields),
//     botIds: () => seed.bots.map((b) => b.id),
//   }));
//   agentRuntime.setPcAccessHost({
//     grantedRoots: (botId) => pcAccessStore.grantsForBot(botId),
//     isOnceAllowed: (sessionId, p) => pcAccessStore.isOnceAllowed(sessionId, p),
//     requestAccess: async (input) => {
//       const card = pcAccessStore.requestAccess(input);
//       governance.audit('pc-access.requested', { ... });
//       return pcAccessStore.awaitOutcome(card.id);
//     },
//   });

import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import express, { type Router } from 'express';
import {
  PcAccessStore,
  SPECIAL_FOLDER_NAMES,
  canonicalizeAbsolutePath,
  resolveSpecialFolder,
  type PcAccessRequestStatus,
  type SpecialFolderName,
} from '@mvp/agent-runtime';

export interface PcAccessRouterDeps {
  store: PcAccessStore;
  audit: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
  /** Known bot ids — when provided, per-bot grant scopes are validated. */
  botIds?: () => string[];
  /** Host env/platform for special-folder resolution (tests inject). */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

const VALID_REQUEST_STATUSES = new Set([
  'pending',
  'allowed-once',
  'always-allowed',
  'denied',
  'expired',
]);

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function createPcAccessRouter(deps: PcAccessRouterDeps): Router {
  const router = express.Router();
  const { store, audit } = deps;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;

  router.get('/pc-access/grants', (_req, res) => {
    try {
      res.json({ ok: true, grants: store.listGrants() });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list PC folder grants', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/pc-access/grants', (req, res) => {
    const body = (req.body ?? {}) as {
      path?: unknown;
      specialFolder?: unknown;
      scope?: unknown;
    };
    // Resolve the target folder: an explicit special folder wins, else a
    // user-typed absolute path.
    let target: string | null = null;
    if (typeof body.specialFolder === 'string' && body.specialFolder) {
      if (!(SPECIAL_FOLDER_NAMES as readonly string[]).includes(body.specialFolder)) {
        res.status(400).json(errorBody(`Unknown specialFolder "${body.specialFolder}" — expected desktop|documents|downloads|home`));
        return;
      }
      target = resolveSpecialFolder(body.specialFolder as SpecialFolderName, env, platform);
      if (!target) {
        res.status(400).json(errorBody(`Could not resolve the ${body.specialFolder} folder on this machine`));
        return;
      }
    } else if (typeof body.path === 'string' && body.path.trim()) {
      target = body.path.trim();
    } else {
      res.status(400).json(errorBody('Body must be { path: "<absolute folder path>" } or { specialFolder: "desktop|documents|downloads|home" }'));
      return;
    }
    if (!isAbsolute(target)) {
      res.status(400).json(errorBody(`Folder path must be absolute: "${target}"`));
      return;
    }
    const canonical = canonicalizeAbsolutePath(target);
    if (!existsSync(canonical)) {
      res.status(400).json(errorBody(`Folder does not exist on this machine: "${target}"`));
      return;
    }
    if (!statSync(canonical).isDirectory()) {
      res.status(400).json(errorBody(`Not a folder: "${target}"`));
      return;
    }
    // Scope: 'all' (default) or one bot id.
    let botId: string | null = null;
    if (body.scope !== undefined && body.scope !== 'all') {
      if (typeof body.scope !== 'string' || !body.scope) {
        res.status(400).json(errorBody('"scope" must be "all" or a bot id'));
        return;
      }
      if (deps.botIds && !deps.botIds().includes(body.scope)) {
        res.status(400).json(errorBody(`Unknown bot in scope: "${body.scope}"`));
        return;
      }
      botId = body.scope;
    }
    try {
      const grant = store.addGrant({ path: canonical, botId, createdVia: 'settings' });
      audit('pc-access.grant_created', {
        actor: 'user',
        detail: { grantId: grant.id, path: grant.path, scope: grant.scope, createdVia: 'settings' },
      });
      res.json({ ok: true, grant });
    } catch (err) {
      res.status(500).json(errorBody('Failed to create PC folder grant', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/pc-access/grants/:id', (req, res) => {
    try {
      const revoked = store.revokeGrant(req.params.id);
      if (!revoked) {
        res.status(404).json(errorBody(`Unknown grant: "${req.params.id}"`));
        return;
      }
      audit('pc-access.grant_revoked', {
        actor: 'user',
        detail: { grantId: revoked.id, path: revoked.path, scope: revoked.scope },
      });
      res.json({ ok: true, grant: revoked });
    } catch (err) {
      res.status(500).json(errorBody('Failed to revoke PC folder grant', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/pc-access/special-folders', (_req, res) => {
    const folders = SPECIAL_FOLDER_NAMES.map((name) => {
      const p = resolveSpecialFolder(name, env, platform);
      return {
        name,
        path: p,
        exists: p ? existsSync(p) : false,
      };
    });
    res.json({ ok: true, folders });
  });

  router.get('/pc-access/requests', (req, res) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusParam && !VALID_REQUEST_STATUSES.has(statusParam)) {
        res.status(400).json(errorBody(`Invalid status "${statusParam}" — expected pending|allowed-once|always-allowed|denied|expired`));
        return;
      }
      const expired = store.expireStale();
      for (const id of expired) audit('pc-access.request_expired', { detail: { cardId: id } });
      res.json({ ok: true, cards: store.listRequests(statusParam as PcAccessRequestStatus | undefined) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list PC access requests', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/pc-access/requests/:id', (req, res) => {
    const body = (req.body ?? {}) as { decision?: unknown };
    if (body.decision !== 'allow-once' && body.decision !== 'always' && body.decision !== 'deny') {
      res.status(400).json(errorBody('Body must be { decision: "allow-once"|"always"|"deny" }'));
      return;
    }
    try {
      const existing = store.getRequest(req.params.id);
      if (!existing) {
        res.status(404).json(errorBody(`Unknown PC access request: "${req.params.id}"`));
        return;
      }
      const settled = store.decide(req.params.id, body.decision);
      if (!settled) {
        res.status(409).json(errorBody('This request was already decided or has expired'));
        return;
      }
      audit('pc-access.request_decided', {
        actor: 'user',
        sessionId: settled.sessionId,
        detail: {
          cardId: settled.id,
          botId: settled.botId,
          folder: settled.folder,
          action: settled.action,
          filePath: settled.filePath,
          decision: body.decision,
          status: settled.status,
        },
      });
      res.json({ ok: true, card: settled });
    } catch (err) {
      res.status(500).json(errorBody('Failed to decide PC access request', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
