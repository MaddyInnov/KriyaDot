// SPDX-License-Identifier: Apache-2.0
//
// Federation / bridge — REST API (mounted at /api/federation).
//
//   Local (loopback-token authenticated by the global API middleware):
//     GET    /federation/identity                 → this instance's public identity
//     POST   /federation/invites                  → create an invite payload to share
//     POST   /federation/accept                   → accept a remote invite (TRUST ACTION)
//     GET    /federation/peers                    → linked peers + tunnel policies
//     PUT    /federation/peers/:id/policy         → update my tunnel policy toward a peer
//     DELETE /federation/peers/:id                → unlink (stops all access, both ways
//                                                   as far as this side is concerned)
//     GET    /federation/peers/:id/experts        → signed proxy: the peer's exposed bots
//     POST   /federation/peers/:id/experts/:botId/chat
//                                                 → signed proxy: run a turn ON THE PEER;
//                                                   only a session stub is stored locally
//     GET    /federation/stubs                    → local remote-session stubs
//
//   Inbound (Ed25519-signature authenticated; NO loopback token — the host
//   must exempt /api/federation/inbound from requireLoopbackAuth, see the
//   wiring note in the parent report):
//     POST   /federation/inbound/handshake        → completes a link (invite code + sig)
//     GET    /federation/inbound/experts          → my bots exposed to the calling peer
//     POST   /federation/inbound/chat             → run a turn against an exposed bot HERE
//     POST   /federation/inbound/workspace/read   → capability-gated workspace read
//
// Security model (enforced here + packages/agent-runtime/src/federation.ts):
//   - POST /accept is an outward trust action: it runs ONLY behind the API's
//     normal auth (the global loopback bearer middleware covers every
//     /api/federation/* path except /inbound), it is audit-logged BEFORE the
//     handshake is attempted (federation.accept), and the host may pass an
//     extra `authorizeLocal` gate. Accepting stores the inviter's public key
//     from the out-of-band invite payload — never from an HTTP response.
//   - Inbound requests are verified against the STORED peer key, the
//     receiving side's tunnel policy is enforced per request (exposed bots,
//     capability, rate cap), the global pause refuses inbound chat, and
//     peer turns can never satisfy a local approval: they run through
//     createRuntimePeerTurnExecutor (or a host executor), which denies
//     approval-requiring tools and reports the denial to the model instead
//     of waiting for a local human (see its comment).
//   - History is home-authoritative: outbound chat stores only a stub
//     { peerId, botId, remoteSessionId, timestamps, turnCount } locally;
//     the transcript lives only on the home instance.
//
// HOST WIRING (index.ts) — parent applies:
//   import { createFederationRouter } from './federation-routes.js';
//   app.use('/api/federation', createFederationRouter({
//     dataDir: config.dataDir,
//     instanceName: 'KriyaDot',
//     getBots: () => seed.bots,
//     runtime: agentRuntime,
//     audit: (action, fields) => governance.audit(action, fields),
//     isPaused,
//   }));
//   …and add '/api/federation/inbound' to LOOPBACK_AUTH_EXEMPT_PATHS in
//   loopback-auth.ts (inbound peers authenticate by Ed25519 signature).

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';
// Deep dist import (same pattern as computer-view.ts / index.ts): the
// federation module is new and not yet re-exported from the package root.
import {
  FederationError,
  FederationService,
  defaultTunnelPolicy,
  type PeerRecord,
  type TunnelPolicy,
} from '@mvp/agent-runtime/dist/federation.js';

export interface PeerTurnResult {
  text: string;
  /** Tools that required approval and were denied (and reported) this turn. */
  deniedTools?: string[];
}

export interface FederationRoutesDeps {
  /** Inject a pre-built service (tests). Default: file store under dataDir. */
  service?: FederationService;
  dataDir?: string;
  /** Explicit store file (wins over dataDir). */
  storePath?: string;
  instanceName?: string;
  /**
   * This instance's federation base URL as peers should call it, e.g.
   * http://203.0.113.10:4000/api/federation. When unset on accept, the
   * accept body may supply `url`; invites carry whatever is current.
   */
  publicUrl?: string;
  /** Live local bot list. */
  getBots: () => BotConfig[];
  /**
   * Execute a peer turn against a local bot. Default: the runtime executor
   * below (requires `runtime`). Tests/hosts may inject a stub executor.
   */
  executePeerTurn?: (args: {
    bot: BotConfig;
    message: string;
    sessionId: string;
    peerId: string;
  }) => Promise<PeerTurnResult>;
  /** AgentRuntime (structural subset) for the default peer-turn executor. */
  runtime?: { runTurn: (opts: never) => Promise<unknown> };
  /** Governance audit sink (governance.audit in index.ts). */
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Global pause gate (system-pause.ts pauseGate in index.ts). */
  isPaused?: () => boolean;
  /**
   * Extra local gate for trust actions (invite creation, accept, unlink,
   * policy changes). Return false → 403. The global loopback-auth
   * middleware is the primary gate; this hook lets the host demand more.
   */
  authorizeLocal?: (req: Request) => boolean;
  /** Workspace reader for the 'workspace-read' capability (confined by host). */
  readWorkspaceFile?: (args: { bot: BotConfig; path: string }) => Promise<{ content: string }>;
  fetchImpl?: typeof fetch;
}

type RunTurnShape = {
  bot: BotConfig;
  message: string;
  sessionId: string;
  onEvent: (e: { type: string; content?: string; call?: { name?: string }; denied?: boolean }) => void;
  approvalTimeoutMs: number;
  provenance: {
    origin: 'external';
    originBotId: string;
    relayPath: string[];
    timestamp: string;
    relayed: boolean;
  };
};

/**
 * Default peer-turn executor over the normal runtime.
 *
 * APPROVAL SAFETY: a remote peer is not a local user, so a peer turn must
 * never wait on — or be granted — a local approval. Two mechanisms combine:
 *   1. `approvalTimeoutMs: 0` — governance's awaitDecision resolves 'denied'
 *      immediately, so any tool that requires approval is DENIED AND
 *      REPORTED (the denial is fed back to the model as the tool result and
 *      collected into `deniedTools`), instead of minting a pending approval
 *      a peer could socially engineer a human into approving. (An audit
 *      record of the attempt may still be written, born `expired` and
 *      relayed — it is never pending or decidable. QA 2026-10-30.)
 *   2. Peer provenance (`origin: 'external'`, relayed) — the runtime's
 *      consent rule already bars auto-approve / bypass / reviewer paths
 *      from satisfying approvals on non-user-origin turns.
 * The bot's approval mode is NOT bypassed by this executor; plan-mode bots
 * stay read-only through the same governance path as local turns.
 */
export function createRuntimePeerTurnExecutor(runtime: { runTurn: (opts: RunTurnShape) => Promise<unknown> }) {
  return async (args: { bot: BotConfig; message: string; sessionId: string; peerId: string }): Promise<PeerTurnResult> => {
    let text = '';
    const deniedTools: string[] = [];
    await runtime.runTurn({
      bot: args.bot,
      message: args.message,
      sessionId: args.sessionId,
      approvalTimeoutMs: 0,
      provenance: {
        origin: 'external',
        originBotId: args.peerId,
        relayPath: [args.peerId],
        timestamp: new Date().toISOString(),
        relayed: true,
      },
      onEvent: (e) => {
        if (e.type === 'token' && typeof e.content === 'string') text += e.content;
        // One denial surfaces as BOTH an approval_required and a denied
        // tool_result event — report each denied tool once.
        if (((e.type === 'tool_result' && e.denied) || e.type === 'approval_required') && e.call?.name) {
          if (!deniedTools.includes(e.call.name)) deniedTools.push(e.call.name);
        }
      },
    });
    return { text, deniedTools };
  };
}

function errorBody(message: string, code?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(code ? { code } : {}) };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof FederationError) {
    res.status(err.status).json(errorBody(err.message, err.code));
    return;
  }
  res.status(500).json(errorBody(err instanceof Error ? err.message : String(err)));
}

function cleanPolicy(input: unknown): Partial<TunnelPolicy> {
  if (typeof input !== 'object' || input === null) return {};
  const p = input as Record<string, unknown>;
  const out: Partial<TunnelPolicy> = {};
  if (Array.isArray(p.exposedBotIds)) {
    out.exposedBotIds = p.exposedBotIds.filter((x): x is string => typeof x === 'string').slice(0, 200);
  }
  if (Array.isArray(p.capabilities)) {
    out.capabilities = p.capabilities.filter((x): x is 'chat' | 'workspace-read' => x === 'chat' || x === 'workspace-read');
  }
  if (typeof p.rateCapPerMinute === 'number' && Number.isFinite(p.rateCapPerMinute)) {
    out.rateCapPerMinute = Math.max(1, Math.min(10_000, Math.floor(p.rateCapPerMinute)));
  }
  return out;
}

declare module 'express-serve-static-core' {
  interface Request {
    federationRawBody?: string;
  }
}

export function createFederationRouter(deps: FederationRoutesDeps): Router {
  const service =
    deps.service ??
    new FederationService({
      storePath: deps.storePath ?? join(deps.dataDir ?? '.', 'federation.json'),
      name: deps.instanceName,
      publicUrl: deps.publicUrl,
      fetchImpl: deps.fetchImpl,
    });
  const executePeerTurn: FederationRoutesDeps['executePeerTurn'] =
    deps.executePeerTurn ??
    (deps.runtime ? createRuntimePeerTurnExecutor(deps.runtime as { runTurn: (opts: RunTurnShape) => Promise<unknown> }) : undefined);

  const router = express.Router();
  // Capture the exact raw body: federation signatures cover the raw bytes,
  // so re-serialised JSON can never be used for verification.
  router.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request).federationRawBody = buf.toString('utf8');
      },
    }),
  );

  const audit = (action: string, detail: unknown): void => {
    try {
      deps.audit(action, { actor: 'federation', detail });
    } catch {
      // Auditing must never break federation traffic.
    }
  };

  const localGate = (req: Request, res: Response): boolean => {
    if (deps.authorizeLocal && !deps.authorizeLocal(req)) {
      res.status(403).json(errorBody('local authorization refused this federation action', 'forbidden'));
      return false;
    }
    return true;
  };

  /**
   * Exact signed bytes for a request. When this router's own JSON parser
   * ran first, the captured raw body is authoritative. When the host's
   * global express.json() ran first (index.ts mounts it before routers),
   * the parsed body re-serialises byte-identically for our own client,
   * which always sends JSON.stringify output — that is the fallback.
   */
  const rawBodyOf = (req: Request): string => {
    if (req.federationRawBody !== undefined) return req.federationRawBody;
    if (req.body === undefined || req.body === null) return '';
    // body-parser represents a bodyless request as {} — the signed bytes
    // for those (our client's GETs) are the empty string.
    if (typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body as object).length === 0) return '';
    return JSON.stringify(req.body);
  };

  /** Verify an inbound signed request; returns the stored peer or throws. */
  const verifyInbound = (req: Request): PeerRecord => {
    const from = req.header('x-kriyadot-fed-from');
    const peer = from ? service.getPeer(from) : undefined;
    if (!peer || peer.status !== 'active') {
      throw new FederationError('unknown or unlinked federation peer', 'unknown_peer', 401);
    }
    service.verifyRequest({
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      rawBody: rawBodyOf(req),
      headers: {
        'x-kriyadot-fed-from': from,
        'x-kriyadot-fed-ts': req.header('x-kriyadot-fed-ts'),
        'x-kriyadot-fed-nonce': req.header('x-kriyadot-fed-nonce'),
        'x-kriyadot-fed-sig': req.header('x-kriyadot-fed-sig'),
      },
      publicKey: peer.publicKey,
      expectedFrom: peer.peerId,
    });
    if (!service.checkRate(peer.peerId)) {
      throw new FederationError('federation rate cap exceeded for this peer', 'rate_limited', 429);
    }
    return peer;
  };

  // ---- local routes -------------------------------------------------------

  router.get('/identity', (_req, res) => {
    res.json({ ok: true, identity: service.identity() });
  });

  router.post('/invites', (req, res) => {
    if (!localGate(req, res)) return;
    try {
      const body = (req.body ?? {}) as { policyForPeer?: unknown; expiresInMs?: unknown; url?: unknown };
      if (typeof body.url === 'string' && body.url) service.setPublicUrl(body.url);
      const { payload, invite } = service.createInvite({
        policyForPeer: cleanPolicy(body.policyForPeer),
        expiresInMs: typeof body.expiresInMs === 'number' ? body.expiresInMs : undefined,
      });
      audit('federation.invite_created', { inviteId: invite.inviteId, expiresAt: invite.expiresAt });
      res.json({ ok: true, payload, invite: { inviteId: invite.inviteId, expiresAt: invite.expiresAt } });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/accept', async (req, res) => {
    if (!localGate(req, res)) return;
    try {
      const body = (req.body ?? {}) as { payload?: unknown; url?: unknown; policy?: unknown };
      if (typeof body.payload !== 'string' || !body.payload) {
        res.status(400).json(errorBody('body.payload (invite payload string) is required', 'bad_request'));
        return;
      }
      const invite = service.parseInvitePayload(body.payload);
      // Audit BEFORE the outward handshake: the trust decision is on record
      // even if the network leg then fails.
      audit('federation.accept', { peerId: invite.instanceId, peerUrl: invite.url, via: 'invite' });
      const ownUrl = typeof body.url === 'string' && body.url ? body.url : service.identity().url;
      if (!ownUrl) {
        res.status(400).json(errorBody('this instance has no federation URL to advertise; pass body.url or configure publicUrl', 'no_public_url'));
        return;
      }
      if (ownUrl !== service.identity().url) service.setPublicUrl(ownUrl);
      const peer = service.recordPeerFromInvite(invite, cleanPolicy(body.policy));
      // Handshake: present OUR identity + the invite code, signed with OUR
      // key. The inviter verifies the signature against the presented key
      // and binds it via the single-use code (see federation.ts).
      const handshakeBody = JSON.stringify({
        inviteCode: invite.code,
        instance: { ...service.identity(), url: ownUrl },
      });
      const handshakePath = `${new URL(`${invite.url.replace(/\/+$/, '')}/inbound/handshake`).pathname}`;
      const headers = service.signRequestHeaders('POST', handshakePath, handshakeBody);
      const fetchImpl = deps.fetchImpl ?? fetch;
      let handshakeRes: globalThis.Response;
      try {
        handshakeRes = await fetchImpl(`${invite.url.replace(/\/+$/, '')}/inbound/handshake`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: handshakeBody,
        });
      } catch (err) {
        audit('federation.accept_failed', { peerId: invite.instanceId, error: err instanceof Error ? err.message : String(err) });
        res.status(502).json({ ...errorBody(`handshake to peer failed: ${err instanceof Error ? err.message : String(err)}`, 'peer_unreachable'), peer });
        return;
      }
      if (!handshakeRes.ok) {
        const detail = (await handshakeRes.json().catch(() => null)) as { error?: string } | null;
        audit('federation.accept_failed', { peerId: invite.instanceId, status: handshakeRes.status, error: detail?.error });
        res.status(502).json({ ...errorBody(`peer refused the handshake (${handshakeRes.status}): ${detail?.error ?? 'unknown'}`, 'handshake_refused'), peer });
        return;
      }
      const active = service.markPeerActive(invite.instanceId);
      audit('federation.linked', { peerId: invite.instanceId });
      res.json({ ok: true, peer: active });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/peers', (_req, res) => {
    res.json({ ok: true, peers: service.listPeers() });
  });

  router.get('/stubs', (_req, res) => {
    res.json({ ok: true, stubs: service.listStubs() });
  });

  router.put('/peers/:id/policy', (req, res) => {
    if (!localGate(req, res)) return;
    try {
      const peer = service.updatePeerPolicy(req.params.id!, cleanPolicy(req.body ?? {}));
      audit('federation.policy_updated', { peerId: peer.peerId, policy: peer.policy });
      res.json({ ok: true, peer });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/peers/:id', (req, res) => {
    if (!localGate(req, res)) return;
    const removed = service.removePeer(req.params.id!);
    if (!removed) {
      res.status(404).json(errorBody('unknown peer', 'unknown_peer'));
      return;
    }
    audit('federation.unlinked', { peerId: req.params.id });
    res.json({ ok: true, removed: true });
  });

  router.get('/peers/:id/experts', async (req, res) => {
    try {
      const peer = service.getPeer(req.params.id!);
      if (!peer || peer.status !== 'active') {
        res.status(404).json(errorBody('unknown or unlinked peer', 'unknown_peer'));
        return;
      }
      const out = await service.signedPeerRequest<{ ok: boolean; experts: unknown }>(peer, 'GET', '/inbound/experts');
      res.json({ ok: true, experts: out.experts ?? [] });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/peers/:id/experts/:botId/chat', async (req, res) => {
    try {
      const peer = service.getPeer(req.params.id!);
      if (!peer || peer.status !== 'active') {
        res.status(404).json(errorBody('unknown or unlinked peer', 'unknown_peer'));
        return;
      }
      const body = (req.body ?? {}) as { message?: unknown; sessionId?: unknown };
      if (typeof body.message !== 'string' || !body.message.trim()) {
        res.status(400).json(errorBody('body.message is required', 'bad_request'));
        return;
      }
      const botId = req.params.botId!;
      // Continue the home-side conversation when we already hold a stub.
      const prior = typeof body.sessionId === 'string' ? undefined : service.findStub(peer.peerId, botId);
      const out = await service.signedPeerRequest<{ ok: boolean; text: string; remoteSessionId: string; deniedTools?: string[] }>(
        peer,
        'POST',
        '/inbound/chat',
        {
          botId,
          message: body.message,
          ...((typeof body.sessionId === 'string' && body.sessionId) || prior
            ? { sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : prior!.remoteSessionId }
            : {}),
        },
      );
      // Home-authoritative history: store ONLY the reference stub locally.
      const stub = service.upsertStub(peer.peerId, botId, out.remoteSessionId);
      audit('federation.peer_chat', { peerId: peer.peerId, botId, remoteSessionId: out.remoteSessionId });
      res.json({ ok: true, text: out.text, deniedTools: out.deniedTools ?? [], stub });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- inbound routes (signature-authenticated) ----------------------------

  router.post('/inbound/handshake', (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        inviteCode?: unknown;
        instance?: { instanceId?: unknown; name?: unknown; url?: unknown; publicKey?: unknown };
      };
      const inst = body.instance ?? {};
      if (
        typeof body.inviteCode !== 'string' ||
        typeof inst.instanceId !== 'string' ||
        typeof inst.url !== 'string' ||
        typeof inst.publicKey !== 'string'
      ) {
        res.status(400).json(errorBody('handshake needs inviteCode and instance {instanceId,url,publicKey}', 'bad_request'));
        return;
      }
      // First-contact verification: the signature must verify against the
      // PRESENTED key (self-consistency); the invite code then binds that
      // key to this link inside completeHandshake().
      service.verifyRequest({
        method: 'POST',
        path: `${req.baseUrl}${req.path}`,
        rawBody: rawBodyOf(req),
        headers: {
          'x-kriyadot-fed-from': req.header('x-kriyadot-fed-from'),
          'x-kriyadot-fed-ts': req.header('x-kriyadot-fed-ts'),
          'x-kriyadot-fed-nonce': req.header('x-kriyadot-fed-nonce'),
          'x-kriyadot-fed-sig': req.header('x-kriyadot-fed-sig'),
        },
        publicKey: inst.publicKey,
        expectedFrom: inst.instanceId,
      });
      const peer = service.completeHandshake({
        inviteCode: body.inviteCode,
        remote: {
          instanceId: inst.instanceId,
          name: typeof inst.name === 'string' ? inst.name : inst.instanceId,
          url: inst.url,
          publicKey: inst.publicKey,
        },
      });
      audit('federation.linked', { peerId: peer.peerId, via: 'handshake' });
      res.json({ ok: true, identity: service.identity(), peerId: peer.peerId });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/inbound/experts', (req, res) => {
    try {
      const peer = verifyInbound(req);
      if (!peer.policy.capabilities.includes('chat')) {
        res.status(403).json(errorBody('chat capability is not enabled for this peer', 'capability_denied'));
        return;
      }
      const bots = deps.getBots();
      const experts = peer.policy.exposedBotIds
        .map((id) => bots.find((b) => b.id === id))
        .filter((b): b is BotConfig => Boolean(b))
        .map((b) => ({ id: b.id, name: b.name, description: b.description }));
      res.json({ ok: true, experts });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/inbound/chat', async (req, res) => {
    try {
      const peer = verifyInbound(req);
      if (deps.isPaused?.()) {
        res.status(503).json(errorBody('this instance is paused; peer turns are refused', 'paused'));
        return;
      }
      if (!peer.policy.capabilities.includes('chat')) {
        res.status(403).json(errorBody('chat capability is not enabled for this peer', 'capability_denied'));
        return;
      }
      const body = (req.body ?? {}) as { botId?: unknown; message?: unknown; sessionId?: unknown };
      if (typeof body.botId !== 'string' || typeof body.message !== 'string' || !body.message.trim()) {
        res.status(400).json(errorBody('body.botId and body.message are required', 'bad_request'));
        return;
      }
      // Tunnel policy is enforced on the RECEIVING (home) side: a peer can
      // only ever reach bots this instance chose to expose to it.
      if (!peer.policy.exposedBotIds.includes(body.botId)) {
        audit('federation.inbound_denied', { peerId: peer.peerId, botId: body.botId, reason: 'bot_not_exposed' });
        res.status(403).json(errorBody('bot is not exposed to this peer', 'bot_not_exposed'));
        return;
      }
      const bot = deps.getBots().find((b) => b.id === body.botId);
      if (!bot) {
        res.status(404).json(errorBody('unknown bot', 'unknown_bot'));
        return;
      }
      if (!executePeerTurn) {
        res.status(501).json(errorBody('no peer-turn executor configured on this instance', 'no_executor'));
        return;
      }
      // The turn EXECUTES here, on the home instance, against the local bot
      // via the normal runtime path (see executePeerTurn / approval safety).
      const requested = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : randomUUID();
      // Continuation calls pass back the home-issued id verbatim; only
      // prefix a fresh client-chosen id (keeps ids stable across turns).
      const remoteSessionId = (
        requested.startsWith(`fed_${peer.peerId}_`) ? requested : `fed_${peer.peerId}_${requested}`
      )
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 180);
      const result = await executePeerTurn({ bot, message: body.message, sessionId: remoteSessionId, peerId: peer.peerId });
      audit('federation.inbound_chat', { peerId: peer.peerId, botId: bot.id, remoteSessionId });
      res.json({ ok: true, text: result.text, remoteSessionId, deniedTools: result.deniedTools ?? [] });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/inbound/workspace/read', async (req, res) => {
    try {
      const peer = verifyInbound(req);
      if (!peer.policy.capabilities.includes('workspace-read')) {
        res.status(403).json(errorBody('workspace-read capability is not enabled for this peer', 'capability_denied'));
        return;
      }
      if (!deps.readWorkspaceFile) {
        res.status(501).json(errorBody('workspace-read is not configured on this instance', 'not_configured'));
        return;
      }
      const body = (req.body ?? {}) as { botId?: unknown; path?: unknown };
      if (typeof body.botId !== 'string' || typeof body.path !== 'string' || !peer.policy.exposedBotIds.includes(body.botId)) {
        res.status(403).json(errorBody('bot is not exposed to this peer', 'bot_not_exposed'));
        return;
      }
      const bot = deps.getBots().find((b) => b.id === body.botId);
      if (!bot) {
        res.status(404).json(errorBody('unknown bot', 'unknown_bot'));
        return;
      }
      const out = await deps.readWorkspaceFile({ bot, path: body.path });
      res.json({ ok: true, content: out.content });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

/** Re-exported for host wiring convenience. */
export { defaultTunnelPolicy };
export type { PeerRecord, TunnelPolicy };
