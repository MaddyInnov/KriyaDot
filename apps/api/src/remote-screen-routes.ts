// SPDX-License-Identifier: Apache-2.0
// REST + WebSocket routes for remote screen viewing (phone -> PC).
// Mounted at /api/remote-screen; the WS endpoint is /api/remote-screen/ws
// (handled via handleUpgrade, wired in index.ts like /api/computer/ws).
//
// Auth: all session routes require the companion device Bearer token
// (same CompanionStore as /api/companion). The WS handshake carries
// ?sessionId=<id>&token=<deviceToken>.
//
// Flow:
//   1. POST /start            -> { sessionId, approvalId, status:'pending', wsPath }
//      (mints a governance approval; the PC owner approves in the web UI)
//   2. GET  /session/:id      -> { sessionId, status, ... }   (phone polls)
//   3. WS   /ws?sessionId&token -> {t:'ok'...} then {t:'frame', png, ...}
//   4. POST /stop {sessionId} -> { ok:true }
//   5. GET  /status           -> { active:[...] } (web UI banner, no device token)

import type { Request, Response, Router, NextFunction } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { CompanionDevice } from './companion.js';
import { acceptRawWsSocket } from './computer-view.js';
import { RemoteScreenService, REMOTE_SCREEN_TOOL } from './remote-screen.js';

/** WebSocket endpoint path (query: ?sessionId=<id>&token=<deviceToken>). */
export const REMOTE_SCREEN_WS_PATH = '/api/remote-screen/ws';

export interface RemoteScreenDeviceStore {
  findDeviceByToken(token: string): CompanionDevice | undefined;
  touchDevice(deviceId: string): void;
}

export interface RemoteScreenRouteDeps {
  store: RemoteScreenDeviceStore;
  service: RemoteScreenService;
  audit: (action: string, fields: Record<string, unknown>) => void;
  /**
   * Per-boot loopback bearer <redacted> (the PC owner's own console auth).
   * MEDIUM fix: the local web-UI routes (/status, /stop-local) previously
   * relied on the global requireLoopbackAuth middleware ordering — fragile
   * if this router is ever mounted elsewhere. They now enforce the token
   * explicitly, consistent with the device-token auth on session routes.
   * When absent, the routes fall back to the global middleware (unchanged
   * behavior in the standard index.ts wiring).
   */
  loopbackToken?: string;
}

interface AuthedRequest extends Request {
  companionDevice?: { id: string; name: string };
}

function err(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const token = m?.[1]?.trim();
  return token ? token : undefined;
}

function publicSession(s: {
  id: string;
  deviceId: string;
  deviceName: string;
  status: string;
  createdAt: number;
  approvedAt?: number;
  frames: number;
  mock: boolean;
}): Record<string, unknown> {
  return {
    sessionId: s.id,
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    status: s.status,
    createdAt: s.createdAt,
    approvedAt: s.approvedAt ?? null,
    frames: s.frames,
    mock: s.mock,
  };
}

export function createRemoteScreenRouter(deps: RemoteScreenRouteDeps): Router {
  const { store, service, audit } = deps;
  const router = express.Router();

  /** Device-token auth (mirrors /api/companion's requireAuth). */
  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    const device = token ? store.findDeviceByToken(token) : undefined;
    if (!device) {
      audit('remote-screen.auth_failed', {
        actor: 'api',
        toolName: REMOTE_SCREEN_TOOL,
        detail: { path: req.path },
      });
      err(res, 401, 'unauthorized', 'A valid companion device token is required.');
      return;
    }
    store.touchDevice(device.id);
    req.companionDevice = { id: device.id, name: device.name };
    next();
  };

  /**
   * Local-console auth: the per-boot loopback bearer <redacted> (same credential
   * the browser UI uses). Constant-time comparison; no device token needed —
   * the console IS the PC owner.
   */
  const requireLocal = (req: Request, res: Response, next: NextFunction): void => {
    const expected = deps.loopbackToken;
    if (!expected) {
      // Not wired — the global requireLoopbackAuth middleware still applies
      // in the standard index.ts mounting.
      next();
      return;
    }
    const got = bearerToken(req) ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      audit('remote-screen.auth_failed', {
        actor: 'api',
        toolName: REMOTE_SCREEN_TOOL,
        detail: { path: req.path, kind: 'loopback' },
      });
      err(res, 401, 'unauthorized', 'A valid loopback token is required.');
      return;
    }
    next();
  };

  // -- session lifecycle ----------------------------------------------------

  router.post('/start', requireAuth, (req: AuthedRequest, res: Response) => {
    const device = req.companionDevice;
    if (!device) {
      err(res, 401, 'unauthorized');
      return;
    }
    try {
      const { sessionId, approvalId, status } = service.requestSession(device.id, device.name);
      res.status(202).json({
        ok: true,
        sessionId,
        approvalId,
        status,
        wsPath: REMOTE_SCREEN_WS_PATH,
        pollMs: 2000,
        note: 'Approve "Allow screen sharing" in the KriyaDot web UI, then open the WebSocket.',
      });
    } catch (e) {
      err(res, 500, 'start_failed', e instanceof Error ? e.message : String(e));
    }
  });

  router.get('/session/:id', requireAuth, (req: AuthedRequest, res: Response) => {
    const session = service.getSession(req.params.id);
    if (!session) {
      err(res, 404, 'unknown_session');
      return;
    }
    if (session.deviceId !== req.companionDevice?.id) {
      err(res, 403, 'forbidden', 'This session belongs to a different device.');
      return;
    }
    res.json({ ok: true, session: publicSession(session) });
  });

  router.post('/stop', requireAuth, (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { sessionId?: unknown };
    if (typeof body.sessionId !== 'string' || !body.sessionId) {
      err(res, 400, 'bad_request', 'sessionId is required.');
      return;
    }
    const session = service.getSession(body.sessionId);
    if (!session) {
      err(res, 404, 'unknown_session');
      return;
    }
    if (session.deviceId !== req.companionDevice?.id) {
      err(res, 403, 'forbidden', 'This session belongs to a different device.');
      return;
    }
    service.stopSession(body.sessionId, `device:${req.companionDevice.id}`);
    res.json({ ok: true });
  });

  // -- web UI surface (loopback-authenticated; the console is the PC owner's own) ----

  /** Active sessions for the "screen sharing" banner. Terminal states excluded. */
  router.get('/status', requireLocal, (_req: Request, res: Response) => {
    const active = service.activeSessions().map((s) => ({
      sessionId: s.id,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      status: s.status,
      startedAt: s.approvedAt ?? s.createdAt,
      frames: s.frames,
      mock: s.mock,
    }));
    res.json({ ok: true, active });
  });

  /** Local console can stop a session (the banner's Stop button). */
  router.post('/stop-local', requireLocal, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { sessionId?: unknown };
    if (typeof body.sessionId !== 'string' || !body.sessionId) {
      err(res, 400, 'bad_request', 'sessionId is required.');
      return;
    }
    if (!service.stopSession(body.sessionId, 'local')) {
      err(res, 404, 'unknown_session');
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

/**
 * WebSocket upgrade handler for /api/remote-screen/ws?sessionId=<id>&token=<t>.
 * Validates the WS handshake, the device token, and that the session is
 * approved/active, then attaches the socket to the frame loop.
 */
export function createRemoteScreenUpgrade(deps: RemoteScreenRouteDeps): {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
} {
  const { store, service } = deps;
  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
      const url = new URL(req.url ?? REMOTE_SCREEN_WS_PATH, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const token = url.searchParams.get('token') ?? '';
      const device = token ? store.findDeviceByToken(token) : undefined;
      const session = sessionId ? service.getSession(sessionId) : undefined;

      const reject = (detail: string): void => {
        // Best effort: complete the handshake so we can send a JSON error.
        const sock = acceptRawWsSocket(req, socket);
        if (sock) {
          try {
            sock.sendText(JSON.stringify({ t: 'error', detail }));
            sock.close(4401);
          } catch {
            // ignore
          }
        }
      };

      if (!device || !session || session.deviceId !== device.id) {
        reject(!device ? 'unauthorized' : 'unknown_session');
        return;
      }
      const sock = acceptRawWsSocket(req, socket);
      if (!sock) return;
      try {
        service.attachViewer(sessionId, sock);
        // Dimensions ride on the first {t:'frame'}; this ack unblocks the UI.
        sock.sendText(JSON.stringify({ t: 'ok', sessionId, mock: session.mock }));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        try {
          sock.sendText(JSON.stringify({ t: 'error', detail }));
          sock.close(4401);
        } catch {
          // ignore
        }
      }
    },
  };
}
