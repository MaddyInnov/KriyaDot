// SPDX-License-Identifier: Apache-2.0
// Loopback API auth (C1): the API binds to 127.0.0.1, which any website open
// in the user's browser can reach. A per-boot bearer token plus a CORS
// allowlist stop drive-by websites from controlling the agent host.
//
// Token model:
//   - On every server start, ensureLoopbackToken() mints a fresh 32-byte
//     token and persists it at <dataDir>/.api-token (mode 0600). Local
//     clients (the TUI, scripts) read that file; the browser UI fetches it
//     from GET /api/auth/bootstrap (Origin-gated, see below).
//   - requireLoopbackAuth(token) enforces `Authorization: Bearer <token>`
//     on every route except the exempt prefixes listed below (each exemption
//     has its own auth or is intentionally public).
//   - Browser-initiated WebSockets can't set Authorization headers, so
//     issueWsTicket()/consumeWsTicket() provide single-use, expiring tickets
//     that an already-authed HTTP client fetches first (e.g. the phone watch
//     flow in phone.ts).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireLoopbackAuth when the bearer token checked out. */
      loopbackAuthed?: boolean;
    }
  }
}

const TOKEN_FILENAME = '.api-token';

/**
 * Mint a fresh token for this server boot and persist it (mode 0600) so
 * local clients can pick it up. Persistence is best-effort: if the file
 * cannot be written the server still boots and the token is returned.
 */
export function ensureLoopbackToken(dataDir: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const file = path.join(dataDir, TOKEN_FILENAME);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch (err) {
      console.warn(
        `[loopback-auth] could not chmod ${file} to 0600: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[loopback-auth] could not persist API token at ${file} — local file-based clients (TUI) will not work: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// CORS allowlist
// ---------------------------------------------------------------------------

/** Base allowlist for browser clients. */
export const CORS_ALLOWLIST: string[] = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

/** Base list plus KRIYADOT_CORS_ORIGINS (comma-separated, trimmed). */
export function getCorsAllowlist(): string[] {
  const extra = (process.env.KRIYADOT_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...CORS_ALLOWLIST, ...extra];
}

/**
 * True when the origin is allowed. An absent origin means a non-browser
 * client (curl, TUI, Android, Tauri sidecar) — allowed here because CORS is
 * not auth; the bearer token enforces auth.
 */
export function isOriginAllowed(origin: string | null | undefined): boolean {
  if (origin === undefined || origin === null || origin === '') return true;
  return getCorsAllowlist().includes(origin);
}

/** `origin` callback for the `cors` package: deny evil origins. */
export function corsOriginFn(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  try {
    cb(null, isOriginAllowed(origin));
  } catch (err) {
    cb(err instanceof Error ? err : new Error(String(err)));
  }
}

// ---------------------------------------------------------------------------
// Bearer-token middleware
// ---------------------------------------------------------------------------

/**
 * Path prefixes exempt from the loopback bearer token. Each has its own
 * auth or is intentionally public:
 *   - /api/companion       device-token requireAuth on every route (Android
 *                           companion pairing uses an OTT flow under it)
 *   - /api/remote-screen   device-token auth on routes; the Android app uses
 *                           it for the approval-gated screen viewer
 *   - /api/hooks           HMAC-verified public webhook ingress (GitHub etc.)
 *   - /api/health          read-only status
 *   - /.well-known         public A2A agent-card discovery
 *   - /api/auth/bootstrap issues the token itself (Origin-gated, not token-
 *                           gated — that would be a chicken-and-egg)
 *   - any path outside /api and /worktrees: the bundled web UI's static
 *     assets (the page must load so the browser can call /api/auth/bootstrap),
 *     /_kriyadot/ (read-only meter), /webhooks (per-trigger secret auth),
 *     /p/<slug> (W3 public page publishing — serves ONLY content the user
 *     explicitly published, under an unguessable slug; see public-pages.ts).
 *     /worktrees stays protected.
 *   - WebSocket upgrade paths below: browsers can't send Authorization
 *     headers on WS handshakes. They authenticate in-protocol (device token
 *     for /api/phone/ws and /api/companion/ws, governance approval tickets
 *     for /api/remote-screen/ws, call token for /api/voice/calls/ws, one-time
 *     WS tickets from loopback-auth for browser watchers on /api/phone/ws),
 *     and Origin is validated on every upgrade in index.ts. (Upgrades bypass
 *     Express middleware entirely, so these entries are documentation —
 *     requests on them never reach this middleware.)
 */
export const LOOPBACK_AUTH_EXEMPT_PATHS: string[] = [
  '/api/companion',
  '/api/remote-screen',
  '/api/hooks',
  '/api/health',
  '/.well-known',
  '/api/auth/bootstrap',
  // Enterprise SSO surface (OIDC authorize/callback, LDAP login, captcha):
  // pre-auth by nature — the IdP redirect cannot carry the loopback token.
  // Its own mechanisms are the auth: OIDC state + PKCE + JWKS-verified
  // id_token, LDAP bind, captcha after repeated failures.
  '/api/auth/sso',
  // Bridge federation peer protocol: remote KriyaDot instances cannot hold
  // the loopback token; every inbound call carries a signed Ed25519
  // envelope verified by the federation service. Local federation admin
  // routes (/api/federation/identity, /invites, /peers…) stay gated.
  '/api/federation/inbound',
  // WebSocket upgrade paths (see comment above — in-protocol auth applies):
  '/api/phone/ws',
  '/api/companion/ws',
  '/api/remote-screen/ws',
  '/api/voice/calls/ws',
  '/api/computer/ws',
];

function pathIsExempt(reqPath: string): boolean {
  if (LOOPBACK_AUTH_EXEMPT_PATHS.some((p) => reqPath === p || reqPath.startsWith(`${p}/`))) return true;
  // The bundled web UI: web-assets.ts serves static frontend assets for every
  // non-/api path, and the page must load WITHOUT a token — the browser
  // fetches the token from /api/auth/bootstrap after the page loads. Also
  // exempt /_kriyadot/ (read-only status meter, like /api/health) and
  // /webhooks (per-trigger x-webhook-secret auth, like /api/hooks).
  // /worktrees stays protected (API surface, mounted outside /api).
  if (!reqPath.startsWith('/api') && !reqPath.startsWith('/worktrees')) return true;
  return false;
}

/**
 * Express middleware: requires `Authorization: Bearer <token>` (constant-
 * time compare) on every non-exempt route. Sets `req.loopbackAuthed = true`
 * on success.
 */
export function requireLoopbackAuth(token: string) {
  const expected = Buffer.from(token, 'utf8');
  return function loopbackAuth(req: Request, res: Response, next: NextFunction): void {
    if (pathIsExempt(req.path)) {
      next();
      return;
    }
    const auth = req.headers.authorization;
    let provided = '';
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      provided = auth.slice('Bearer '.length).trim();
    }
    let ok = false;
    if (provided.length > 0 && provided.length === token.length) {
      ok = crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), expected);
    }
    if (!ok) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    req.loopbackAuthed = true;
    next();
  };
}

/**
 * GET /api/auth/bootstrap handler factory. Returns the token ONLY when the
 * Origin header is absent (non-browser client) or in the allowlist. Browsers
 * always send a non-allowlisted Origin for cross-site fetches, and top-level
 * navigations can't exfiltrate the response body, so an evil site cannot
 * steal the token this way. Exempt from requireLoopbackAuth.
 */
export function createBootstrapHandler(token: string) {
  return function authBootstrap(_req: Request, res: Response): void {
    const origin = _req.headers.origin;
    if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined)) {
      res.status(403).json({ ok: false, error: 'origin_not_allowed' });
      return;
    }
    res.json({ ok: true, token });
  };
}

/**
 * Validate a browser WebSocket upgrade credential from the query string.
 * Browsers can't set Authorization headers on WS handshakes, so the web UI
 * appends the per-boot loopback token as `?token=` (see
 * apps/web/lib/voice-call-client.ts). Also accepts a single-use `?ticket=`
 * (issueWsTicket). The token compare is constant-time; the ticket path is
 * constant-time inside consumeWsTicket.
 */
export function validateWsQueryToken(params: URLSearchParams, loopbackToken: string): boolean {
  const token = params.get('token');
  if (typeof token === 'string' && token.length > 0 && token.length === loopbackToken.length) {
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(loopbackToken, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  const ticket = params.get('ticket');
  return typeof ticket === 'string' && ticket.length > 0 && consumeWsTicket(ticket);
}

// ---------------------------------------------------------------------------
// One-time WebSocket tickets (for browser-initiated sockets)
// ---------------------------------------------------------------------------

interface WsTicketEntry {
  expires: number;
}

const wsTickets = new Map<string, WsTicketEntry>();
let wsSweepTimer: ReturnType<typeof setInterval> | null = null;

function scheduleWsSweep(): void {
  if (wsSweepTimer) return;
  wsSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [t, e] of wsTickets) {
      if (e.expires <= now) wsTickets.delete(t);
    }
  }, 60_000);
  // Never keep the process alive just for the ticket sweep.
  if (typeof wsSweepTimer.unref === 'function') wsSweepTimer.unref();
}

/** Issue a single-use WS ticket (default 60s TTL). The caller must already hold the loopback bearer token. */
export function issueWsTicket(ttlMs = 60_000): string {
  const ticket = crypto.randomBytes(24).toString('base64url');
  wsTickets.set(ticket, { expires: Date.now() + ttlMs });
  scheduleWsSweep();
  return ticket;
}

/**
 * Consume a ticket. Returns true exactly once, before expiry. Constant-time
 * key lookup so ticket guesses can't be probed by timing.
 */
export function consumeWsTicket(ticket: unknown): boolean {
  if (typeof ticket !== 'string' || ticket.length === 0) return false;
  const provided = Buffer.from(ticket, 'utf8');
  let matchedKey: string | null = null;
  for (const key of wsTickets.keys()) {
    const candidate = Buffer.from(key, 'utf8');
    if (candidate.length === provided.length && crypto.timingSafeEqual(candidate, provided)) {
      matchedKey = key;
    }
  }
  if (matchedKey === null) return false;
  // Single-use: delete on first consume regardless of outcome.
  const entry = wsTickets.get(matchedKey);
  wsTickets.delete(matchedKey);
  return entry !== undefined && entry.expires > Date.now();
}
