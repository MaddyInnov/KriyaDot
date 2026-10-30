// SPDX-License-Identifier: Apache-2.0
// Front-door handoff exchange (spec Part 3) + frontdoor link flow.
//
// Token format (fixed contract): base64url(JSON payload) + "." +
// base64url(Ed25519 signature over the payload segment).
// Payload: { v:1, iss:"kriyadot-frontdoor", accountId, email, name?,
//            instanceUrl, nonce, iat, exp } with exp-iat <= 120s.
//
// The instance verifies with the front door's PUBLIC key (env
// KRIYADOT_FRONTDOOR_PUBLIC_KEY PEM, or <dataDir>/frontdoor-pubkey.pem).
// A token is single-use: its nonce is persisted (with its exp) in
// <dataDir>/handoff-nonces.json once an exchange succeeds; replays fail.
// The accountId must equal the owner account id stored by the link flow
// in <dataDir>/frontdoor.json — that is the registry-membership check.
// On success the exchange mints the instance's normal SSO session for the
// tenancy user mapped from the email EXACTLY as the SSO callback does
// (TenancyExtrasStore.upsertExternalUser, provider 'oidc').
//
// Web-auth reality (checked apps/web/lib/api.ts): the web app keeps its
// auth token IN MEMORY ONLY (fetched from /api/auth/bootstrap) — there is
// no localStorage auth key. The /handoff page therefore stores the minted
// session token in localStorage under 'kriyadot:sessionToken' (the SSO
// session token is a first-class Bearer credential for principal.ts, so
// any surface that presents it is authenticated as the mapped user) and
// then redirects to '/', where the app boots through its normal bootstrap.

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { TenantStore, TenancyExtrasStore } from '@mvp/tenancy';
import { getSharedSsoSessionStore, type SessionTokenStore } from './auth-sso.js';
import { requirePrincipal, type PrincipalContext } from './principal.js';

export const HANDOFF_ISSUER = 'kriyadot-frontdoor';
export const HANDOFF_MAX_TTL_MS = 120_000;
/** localStorage key the /handoff page writes (see header note on web auth). */
export const HANDOFF_SESSION_STORAGE_KEY = 'kriyadot:sessionToken';

export interface HandoffPayload {
  v: 1;
  iss: string;
  accountId: string;
  email: string;
  name?: string;
  instanceUrl: string;
  nonce: string;
  iat: number;
  exp: number;
}

export class HandoffError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

function b64urlJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Resolve the front-door public key PEM: dep override → env → key file. */
export function resolveFrontdoorPublicKey(dataDir: string, override?: string): string | null {
  if (override && override.trim()) return override;
  const env = process.env.KRIYADOT_FRONTDOOR_PUBLIC_KEY;
  if (env && env.trim()) return env.replace(/\\n/g, '\n');
  try {
    const pem = fs.readFileSync(path.join(dataDir, 'frontdoor-pubkey.pem'), 'utf8');
    return pem.trim() ? pem : null;
  } catch {
    return null;
  }
}

/** Parse + verify a handoff token. Throws HandoffError(401) on any failure. */
export function verifyHandoffToken(token: string, publicKeyPem: string, now = Date.now()): HandoffPayload {
  if (typeof token !== 'string' || !token) throw new HandoffError(401, 'invalid handoff token');
  const parts = token.split('.');
  if (parts.length !== 2) throw new HandoffError(401, 'invalid handoff token');
  const [payloadSeg, sigSeg] = parts as [string, string];
  let payload: HandoffPayload;
  try {
    payload = b64urlJson(payloadSeg) as HandoffPayload;
  } catch {
    throw new HandoffError(401, 'invalid handoff token payload');
  }
  let ok = false;
  try {
    const key = createPublicKey(publicKeyPem);
    ok = cryptoVerify(null, Buffer.from(payloadSeg, 'ascii'), key, Buffer.from(sigSeg, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new HandoffError(401, 'invalid handoff signature');
  if (payload.v !== 1 || payload.iss !== HANDOFF_ISSUER) throw new HandoffError(401, 'invalid handoff issuer');
  if (typeof payload.accountId !== 'string' || !payload.accountId) throw new HandoffError(401, 'invalid handoff account');
  if (typeof payload.email !== 'string' || !payload.email) throw new HandoffError(401, 'invalid handoff email');
  if (typeof payload.nonce !== 'string' || !payload.nonce) throw new HandoffError(401, 'invalid handoff nonce');
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') throw new HandoffError(401, 'invalid handoff times');
  // Time-unit normalization: the front-door service mints iat/exp in JWT
  // convention (seconds); early test helpers used milliseconds. Accept
  // either by magnitude — anything above 1e11 is milliseconds — and
  // compare in seconds from here on.
  const toSec = (v: number): number => (v > 1e11 ? Math.floor(v / 1000) : v);
  const iatSec = toSec(payload.iat);
  const expSec = toSec(payload.exp);
  const nowSec = Math.floor(now / 1000);
  if (expSec - iatSec > HANDOFF_MAX_TTL_MS / 1000) throw new HandoffError(401, 'handoff token lifetime too long');
  if (expSec <= nowSec) throw new HandoffError(401, 'handoff token expired');
  if (iatSec > nowSec + 30) throw new HandoffError(401, 'handoff token not yet valid');
  return payload;
}

/** Sign a handoff token (used by tests and the front-door service). */
export function signHandoffToken(payload: HandoffPayload, privateKeyPem: string): string {
  const seg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = cryptoSign(null, Buffer.from(seg, 'ascii'), createPrivateKey(privateKeyPem));
  return `${seg}.${Buffer.from(sig).toString('base64url')}`;
}

// -- Used-nonce persistence ---------------------------------------------------

interface NonceFile { nonces: Record<string, number> }

function nonceFilePath(dataDir: string): string {
  return path.join(dataDir, 'handoff-nonces.json');
}

function readNonces(dataDir: string): NonceFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(nonceFilePath(dataDir), 'utf8')) as NonceFile;
    return { nonces: parsed.nonces ?? {} };
  } catch {
    return { nonces: {} };
  }
}

function isNonceUsed(dataDir: string, nonce: string, now = Date.now()): boolean {
  const { nonces } = readNonces(dataDir);
  return typeof nonces[nonce] === 'number' && nonces[nonce] > now;
}

function markNonceUsed(dataDir: string, nonce: string, exp: number): void {
  const file = readNonces(dataDir);
  const now = Date.now();
  for (const [k, v] of Object.entries(file.nonces)) if (v <= now) delete file.nonces[k];
  file.nonces[nonce] = exp;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(nonceFilePath(dataDir), JSON.stringify(file), { mode: 0o600 });
}

// -- Frontdoor link record (<dataDir>/frontdoor.json) --------------------------

export interface FrontdoorLink {
  frontdoorUrl: string;
  accountId: string;
  workspaceId: string;
  linkedAt?: number;
}

export function readFrontdoorLink(dataDir: string): FrontdoorLink | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'frontdoor.json'), 'utf8')) as FrontdoorLink;
    if (!parsed.accountId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeFrontdoorLink(dataDir: string, link: FrontdoorLink): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'frontdoor.json');
  fs.writeFileSync(file, JSON.stringify(link, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

// -- Exchange -------------------------------------------------------------------

export interface HandoffDeps {
  dataDir: string;
  publicKeyPem?: string;
  sessions?: SessionTokenStore;
  tenancyDbPath?: string;
  loopbackToken?: string;
  jwtSecret?: string;
  /** Injectable fetch for the frontdoor link call (tests). */
  fetchFn?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;
  /** Tier reported to the registry at link time (cloud status), when known. */
  getTier?: () => string | undefined;
  getName?: () => string | undefined;
}

/**
 * Exchange a verified handoff token for an SSO session. Pure-ish (file IO
 * on dataDir only) so tests can drive it without HTTP.
 */
export function exchangeHandoffToken(
  deps: HandoffDeps,
  token: string,
  now = Date.now(),
): { sessionToken: string; user: { userId: string; email: string } } {
  const publicKey = resolveFrontdoorPublicKey(deps.dataDir, deps.publicKeyPem);
  if (!publicKey) throw new HandoffError(503, 'frontdoor-not-configured');
  const payload = verifyHandoffToken(token, publicKey, now);
  const link = readFrontdoorLink(deps.dataDir);
  if (!link) throw new HandoffError(409, 'workspace-not-linked');
  if (payload.accountId !== link.accountId) throw new HandoffError(409, 'workspace-not-linked');
  if (isNonceUsed(deps.dataDir, payload.nonce, now)) throw new HandoffError(401, 'handoff token already used');

  // Map email → tenancy user EXACTLY as the SSO callback does
  // (auth-sso-routes.ts issueForUser): upsert the external user, then issue
  // a session through the shared store the principal resolver reads.
  const dbPath = deps.tenancyDbPath ?? path.join(deps.dataDir, 'tenancy.db');
  const extras = new TenancyExtrasStore(dbPath);
  // TenantStore construction mirrors the SSO router (same db file); the
  // org-membership step there only runs when a default org is configured,
  // which the handoff has no equivalent of, so orgId stays undefined.
  void new TenantStore(dbPath);
  const user = extras.upsertExternalUser({
    email: payload.email,
    name: payload.name,
    provider: 'oidc',
    externalId: payload.accountId,
  });
  const sessions = deps.sessions ?? getSharedSsoSessionStore(deps.dataDir);
  const { token: sessionToken } = sessions.issue({ userId: user.userId, email: user.email, provider: 'oidc' });
  // Consume the nonce only on a successful exchange (single-use).
  // Nonce records are compared against Date.now() (ms) — normalize a
  // seconds-based exp (the front door's JWT convention) before storing.
  markNonceUsed(deps.dataDir, payload.nonce, payload.exp > 1e11 ? payload.exp : payload.exp * 1000);
  return { sessionToken, user: { userId: user.userId, email: user.email } };
}

// -- HTTP surface -----------------------------------------------------------------

export const HANDOFF_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>KriyaDot — signing you in…</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0;">
<main><p id="msg">Signing you in to your workspace…</p></main>
<script>
(async () => {
  const msg = document.getElementById('msg');
  try {
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get('t');
    if (!token) { msg.textContent = 'Missing sign-in token. Return to the website and try again.'; return; }
    const res = await fetch('/api/handoff/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.sessionToken) {
      msg.textContent = 'Sign-in failed: ' + (data.error || ('HTTP ' + res.status)) + '. Return to the website and try again.';
      return;
    }
    // Web-auth reality (apps/web/lib/api.ts): the app's own token is an
    // in-memory bootstrap token, never localStorage. The SSO session token
    // minted here is stored under this key so it survives the redirect and
    // any surface presenting it as a Bearer credential is authenticated
    // (principal.ts accepts SSO session tokens). The app then boots
    // through its normal /api/auth/bootstrap flow at '/'.
    try { localStorage.setItem(${JSON.stringify(HANDOFF_SESSION_STORAGE_KEY)}, data.sessionToken); } catch (e) {}
    location.replace('/');
  } catch (e) {
    msg.textContent = 'Sign-in failed: ' + (e && e.message ? e.message : e);
  }
})();
</script></body></html>`;

/** GET /handoff handler (mounted at the app root in index.ts). */
export function handoffPageHandler(_req: Request, res: Response): void {
  res.type('html').send(HANDOFF_PAGE_HTML);
}

const defaultFetch = (url: string, init?: Record<string, unknown>) =>
  fetch(url, init as RequestInit) as unknown as Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export function createFrontdoorRouter(deps: HandoffDeps): Router {
  const router = express.Router();
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };

  router.post('/handoff/exchange', (req: Request, res: Response) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!token) {
      res.status(400).json({ ok: false, error: 'token is required' });
      return;
    }
    try {
      const out = exchangeHandoffToken(deps, token);
      res.json({ ok: true, sessionToken: out.sessionToken, user: out.user });
    } catch (err) {
      if (err instanceof HandoffError) {
        res.status(err.status).json({ ok: false, error: err.message });
        return;
      }
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'exchange failed' });
    }
  });

  router.post('/frontdoor/link', async (req: Request, res: Response) => {
    const principal = requirePrincipal(req, res, pctx);
    if (!principal) return;
    const body = (req.body ?? {}) as { frontdoorUrl?: unknown; code?: unknown; instanceUrl?: unknown; name?: unknown };
    const frontdoorUrl = typeof body.frontdoorUrl === 'string' ? body.frontdoorUrl.replace(/\/+$/, '') : '';
    const code = typeof body.code === 'string' ? body.code : '';
    const instanceUrl = typeof body.instanceUrl === 'string' ? body.instanceUrl : '';
    if (!frontdoorUrl || !code || !instanceUrl) {
      res.status(400).json({ ok: false, error: 'frontdoorUrl, code and instanceUrl are required' });
      return;
    }
    try {
      const fetchFn = deps.fetchFn ?? defaultFetch;
      const upstream = await fetchFn(`${frontdoorUrl}/api/registry/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          instanceUrl,
          ...(typeof body.name === 'string' && body.name ? { name: body.name } : deps.getName?.() ? { name: deps.getName() } : {}),
          ...(deps.getTier?.() ? { tier: deps.getTier() } : {}),
        }),
      });
      const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      if (!upstream.ok) {
        res.status(502).json({ ok: false, error: typeof data.error === 'string' ? data.error : `frontdoor register failed: HTTP ${upstream.status}` });
        return;
      }
      const workspace = (data.workspace ?? {}) as Record<string, unknown>;
      const accountId =
        (typeof data.accountId === 'string' && data.accountId) ||
        (typeof workspace.accountId === 'string' && workspace.accountId) ||
        '';
      const workspaceId =
        (typeof data.workspaceId === 'string' && data.workspaceId) ||
        (typeof workspace.id === 'string' && workspace.id) ||
        '';
      if (!accountId || !workspaceId) {
        res.status(502).json({ ok: false, error: 'frontdoor register response missing accountId/workspaceId' });
        return;
      }
      const link: FrontdoorLink = { frontdoorUrl, accountId, workspaceId, linkedAt: Date.now() };
      writeFrontdoorLink(deps.dataDir, link);
      res.json({ ok: true, linked: true, frontdoorUrl, accountId, workspaceId });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'frontdoor link failed' });
    }
  });

  router.get('/frontdoor/status', (req: Request, res: Response) => {
    const principal = requirePrincipal(req, res, pctx);
    if (!principal) return;
    const link = readFrontdoorLink(deps.dataDir);
    if (!link) {
      res.json({ ok: true, linked: false });
      return;
    }
    res.json({ ok: true, linked: true, frontdoorUrl: link.frontdoorUrl, accountId: link.accountId, workspaceId: link.workspaceId });
  });

  return router;
}
