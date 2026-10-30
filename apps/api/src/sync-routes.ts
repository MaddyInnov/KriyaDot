// SPDX-License-Identifier: Apache-2.0
// Sync hub HTTP surface (front-door Part 4), mounted under /api in index.ts.
//
// Auth model:
//   - POST /sync/link-token, POST /sync/revoke-link-token, POST /sync/target,
//     GET /sync/status: a normal verified principal (owner / SSO / tenancy
//     JWT) — these are local control operations.
//   - POST /sync/push, GET /sync/pull: the sync link token ONLY
//     (`Authorization: Bearer <linkToken>`, timing-safe hash compare).
//   - GET /sync/history: the link token OR a normal principal (the local
//     web UI reads it with its usual credential).
//
// These paths are loopback-auth exempt (see loopback-auth.ts): the link
// token is a remote credential the loopback token can never be, and every
// handler here enforces its own auth above.

import express, { type Request, type Response, type Router } from 'express';
import { resolvePrincipal, requirePrincipal, type PrincipalContext } from './principal.js';
import {
  SyncHubStore,
  mintLinkToken,
  revokeLinkToken,
  verifyLinkToken,
  type SyncPushPayload,
} from './sync-hub.js';
import {
  SyncClientEngine,
  clearSyncTarget,
  readSyncTarget,
  writeSyncTarget,
} from './sync-client.js';

export interface SyncRouteDeps {
  dataDir: string;
  store?: SyncHubStore;
  engine?: SyncClientEngine;
  loopbackToken?: string;
  jwtSecret?: string;
  /** Live local sessions (SessionStore summaries + universal sessions). */
  getLocalSessions?: () => Array<{
    sessionId: string;
    botId: string;
    messageCount: number;
    lastMessageTs: number | string | null;
  }>;
  /**
   * Apply-on-receive hook (sync-apply.ts): after a push is merged, make
   * received definitions live on this server where it is their executor.
   * Failures are logged, never failed back into the push response — the
   * merge is already durable in the sync store.
   */
  applyPush?: (payload: SyncPushPayload) => void;
}

function bearerOf(req: Request): string {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
}

function toMs(v: number | string | null | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function createSyncRouter(deps: SyncRouteDeps): Router {
  const router = express.Router();
  const store = deps.store ?? new SyncHubStore(deps.dataDir);
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };

  const linkAuthed = (req: Request): boolean => verifyLinkToken(deps.dataDir, bearerOf(req));

  // -- Link token management (principal) ------------------------------------

  router.post('/sync/link-token', (req: Request, res: Response) => {
    const principal = requirePrincipal(req, res, pctx);
    if (!principal) return;
    const token = mintLinkToken(deps.dataDir, principal.userId);
    store.setOwnerAccountId(principal.userId);
    // `token` is the field the web settings UI reads; `linkToken` is kept
    // for symmetry with the target payload. Both carry the same secret.
    res.json({ ok: true, linkToken: token, token });
  });

  router.post('/sync/revoke-link-token', (req: Request, res: Response) => {
    const principal = requirePrincipal(req, res, pctx);
    if (!principal) return;
    revokeLinkToken(deps.dataDir);
    res.json({ ok: true, revoked: true });
  });

  // -- Sync target (principal) ------------------------------------------------

  router.post('/sync/target', (req: Request, res: Response) => {
    const principal = requirePrincipal(req, res, pctx);
    if (!principal) return;
    const body = (req.body ?? {}) as { instanceUrl?: unknown; linkToken?: unknown };
    const instanceUrl = typeof body.instanceUrl === 'string' ? body.instanceUrl.trim() : '';
    const linkToken = typeof body.linkToken === 'string' ? body.linkToken.trim() : '';
    if (!instanceUrl || !linkToken) {
      res.status(400).json({ ok: false, error: 'instanceUrl and linkToken are required' });
      return;
    }
    if (!/^https?:\/\//i.test(instanceUrl)) {
      res.status(400).json({ ok: false, error: 'instanceUrl must be an http(s) URL' });
      return;
    }
    // The token lives in the 0600 sync-target.json file (the same posture
    // as .api-token / frontdoor.json); the encrypted-vault pattern is used
    // for Lightning/provider credentials, not device pairing tokens.
    writeSyncTarget(deps.dataDir, { instanceUrl, linkToken });
    res.json({ ok: true, configured: true, instanceUrl: instanceUrl.replace(/\/+$/, '') });
  });

  router.delete('/sync/target', (req: Request, res: Response) => {
    const principal = requirePrincipal(req, res, pctx);
    if (!principal) return;
    clearSyncTarget(deps.dataDir);
    res.json({ ok: true, configured: false });
  });

  router.get('/sync/status', (req: Request, res: Response) => {
    const principal = requirePrincipal(req, res, pctx);
    if (!principal) return;
    if (deps.engine) {
      res.json({ ok: true, ...deps.engine.status() });
      return;
    }
    const target = readSyncTarget(deps.dataDir);
    res.json({
      ok: true,
      configured: !!target,
      ...(target ? { instanceUrl: target.instanceUrl } : {}),
      lastPushAt: null,
      lastPullAt: null,
      pendingOutbox: store.outboxCount(),
    });
  });

  // -- Data endpoints (link token) ---------------------------------------------

  router.post('/sync/push', (req: Request, res: Response) => {
    if (!linkAuthed(req)) {
      res.status(401).json({ ok: false, error: 'invalid sync link token' });
      return;
    }
    const body = (req.body ?? {}) as SyncPushPayload;
    const accepted = store.mergePush(body);
    if (deps.applyPush) {
      try {
        deps.applyPush(body);
      } catch (err) {
        console.error('[sync] apply-on-receive failed:', err instanceof Error ? err.message : err);
      }
    }
    res.json({ ok: true, accepted, cursor: store.cursor() });
  });

  router.get('/sync/pull', (req: Request, res: Response) => {
    if (!linkAuthed(req)) {
      res.status(401).json({ ok: false, error: 'invalid sync link token' });
      return;
    }
    const out = store.pull(req.query.since);
    res.json({ ok: true, ...out });
  });

  // -- Unified history (link token OR principal) --------------------------------

  router.get('/sync/history', (req: Request, res: Response) => {
    if (!linkAuthed(req) && !resolvePrincipal(req, pctx)) {
      res.status(401).json({ ok: false, error: 'unauthenticated: a verified credential is required' });
      return;
    }
    const byId = new Map<string, Record<string, unknown>>();
    // Local live sessions first: they are the executable originals.
    for (const s of deps.getLocalSessions?.() ?? []) {
      byId.set(s.sessionId, {
        sessionId: s.sessionId,
        botId: s.botId,
        origin: 'local',
        readOnly: false,
        messageCount: s.messageCount,
        lastMessageTs: toMs(s.lastMessageTs),
      });
    }
    // Sync-store copies: anything that did not originate on THIS instance
    // is a read-only remote copy here; its stored origin label is kept.
    for (const s of store.listStoredSessions()) {
      if (byId.has(s.sessionId)) continue;
      const own = s.originInstanceId === store.instanceId;
      byId.set(s.sessionId, {
        sessionId: s.sessionId,
        botId: s.botId,
        origin: s.origin === 'cloud' ? 'cloud' : 'local',
        originInstanceId: s.originInstanceId,
        readOnly: !own,
        messageCount: s.messageCount,
        lastMessageTs: s.lastMessageTs,
      });
    }
    const sessions = [...byId.values()].sort(
      (a, b) => (Number(b.lastMessageTs ?? 0) || 0) - (Number(a.lastMessageTs ?? 0) || 0),
    );
    res.json({ ok: true, sessions });
  });

  // -- Synced session bodies (link token OR principal) ---------------------------
  // Read-only history for sessions whose live copy lives on another side:
  // the bodies come from this server's sync store, never from the live
  // session store, so reading them can never execute anything.

  router.get('/sync/sessions/:sessionId/messages', (req: Request, res: Response) => {
    if (!linkAuthed(req) && !resolvePrincipal(req, pctx)) {
      res.status(401).json({ ok: false, error: 'unauthenticated: a verified credential is required' });
      return;
    }
    const messages = store.listSessionMessages(req.params.sessionId).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ts: new Date(m.ts).toISOString(),
    }));
    res.json({ ok: true, sessionId: req.params.sessionId, messages });
  });

  return router;
}
