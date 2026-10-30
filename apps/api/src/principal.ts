// SPDX-License-Identifier: Apache-2.0
// Authoritative principal resolution (OPEN-1 fix).
//
// Before this module, tenancy-scoped surfaces (orgs, vault, brand, cloud
// credentials, Composio, installations, KB) took the caller's identity
// from the client-supplied `x-user-id` header. Anyone able to reach those
// routes could act as any user — including minting admin invites as
// another org's owner (see QA-REPORT-2026-10-30.md, OPEN-1).
//
// Now there is exactly one place identity is decided, and it only trusts
// credentials the server itself issued or verified:
//
//   1. Tenancy JWT — `Authorization: Bearer <HS256 JWT>` verified with the
//      deployment secret (KRIYADOT_TENANCY_JWT_SECRET / deps.jwtSecret).
//      The subject (`sub`) is the identity; `orgId` claim binds the org.
//   2. SSO session token — the opaque token issued by the OIDC/LDAP login
//      flow (auth-sso.ts SessionTokenStore, shared instance for the data
//      dir). The stored record's userId is the identity.
//   3. Loopback owner — the per-boot owner token, either already verified
//      by requireLoopbackAuth (`req.loopbackAuthed`) or presented directly
//      as the bearer when a router is mounted standalone. The owner is the
//      root of trust of a single-owner local install, and ONLY under this
//      principal may `x-user-id` select an acting profile (the local
//      multi-profile UI). That path is explicit: the returned principal is
//      kind 'owner' and `assertedProfile` records that the profile came
//      from the header.
//
// For non-owner principals `x-user-id` (and `x-org-id`, body `actor`, …)
// is IGNORED for identity: a tenancy-JWT or SSO caller can only ever act
// as its own verified subject. When no credential verifies, resolution
// returns null and tenancy-scoped routes must deny (401).

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { tenancyJwtFromHeader } from '@mvp/tenancy';
import { getSharedSsoSessionStore } from './auth-sso.js';

export type PrincipalKind = 'owner' | 'tenancy-jwt' | 'sso-session';

export interface Principal {
  kind: PrincipalKind;
  /** The verified (or owner-asserted) user id every scope check must use. */
  userId: string;
  /** Org the credential is bound to, when it carries one (JWT claim / SSO record). */
  orgId?: string;
  email?: string;
  /** True when userId came from the owner's `x-user-id` profile assertion. */
  assertedProfile: boolean;
}

export interface PrincipalContext {
  /** Data dir (locates the shared SSO session store). */
  dataDir?: string;
  /** Per-boot loopback owner token, when the host wires it. */
  loopbackToken?: string;
  /** Tenancy JWT secret; defaults to env KRIYADOT_TENANCY_JWT_SECRET. */
  jwtSecret?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by resolvePrincipal()/principalMiddleware on first resolution. */
      principal?: Principal | null;
    }
  }
}

/** Same shape @mvp/tenancy enforces for stored user ids. */
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_USER_ID = 'default-user';

function bearerOf(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return '';
  return auth.slice('Bearer '.length).trim();
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The owner's explicit profile assertion: a syntactically valid
 * `x-user-id` header. Returns null when absent/invalid (the owner then
 * acts as DEFAULT_USER_ID). Never consulted for non-owner principals.
 */
function assertedProfileOf(req: Request): string | null {
  const h = req.header('x-user-id');
  if (typeof h !== 'string') return null;
  const v = h.trim();
  return USER_ID_PATTERN.test(v) ? v : null;
}

/**
 * Resolve the request's principal from verified credentials only.
 * Result is memoized on the request. Returns null when nothing verifies.
 */
export function resolvePrincipal(req: Request, ctx: PrincipalContext): Principal | null {
  if (req.principal !== undefined) return req.principal;
  const principal = resolveUncached(req, ctx);
  req.principal = principal;
  return principal;
}

function resolveUncached(req: Request, ctx: PrincipalContext): Principal | null {
  const bearer = bearerOf(req);

  // 1. Tenancy JWT (verified HS256; sub is the identity).
  const secret = ctx.jwtSecret ?? process.env.KRIYADOT_TENANCY_JWT_SECRET ?? '';
  if (secret && bearer) {
    const claims = tenancyJwtFromHeader(req.headers.authorization, secret);
    if (claims) {
      return { kind: 'tenancy-jwt', userId: claims.sub, orgId: claims.orgId, assertedProfile: false };
    }
  }

  // 2. SSO session token (server-issued, hash-stored, TTL-bound).
  if (bearer && ctx.dataDir && !(ctx.loopbackToken && safeEqual(bearer, ctx.loopbackToken))) {
    const record = getSharedSsoSessionStore(ctx.dataDir).resolve(bearer);
    if (record) {
      return {
        kind: 'sso-session',
        userId: record.userId,
        orgId: record.orgId,
        email: record.email,
        assertedProfile: false,
      };
    }
  }

  // 3. Loopback owner. `loopbackAuthed` is set by requireLoopbackAuth in
  // the assembled server; the direct bearer comparison covers routers
  // mounted standalone (tests, embedded hosts) that were given the token.
  const isOwner =
    req.loopbackAuthed === true ||
    (bearer !== '' && ctx.loopbackToken !== undefined && safeEqual(bearer, ctx.loopbackToken));
  if (isOwner) {
    const asserted = assertedProfileOf(req);
    return {
      kind: 'owner',
      userId: asserted ?? DEFAULT_USER_ID,
      assertedProfile: asserted !== null,
    };
  }

  return null;
}

/**
 * Resolve or deny: sends 401 and returns null when no principal verifies.
 * Tenancy-scoped handlers call this first.
 */
export function requirePrincipal(req: Request, res: Response, ctx: PrincipalContext): Principal | null {
  const principal = resolvePrincipal(req, ctx);
  if (!principal) {
    res.status(401).json({ ok: false, error: 'unauthenticated: a verified credential is required' });
    return null;
  }
  return principal;
}

/**
 * Router-level guard: resolves the principal once and 401s before any
 * handler runs when nothing verifies. For routers that are entirely
 * tenancy-scoped (cloud, KB, org library, published bots, …).
 */
export function principalMiddleware(ctx: PrincipalContext) {
  return function principalGuard(req: Request, res: Response, next: NextFunction): void {
    if (!requirePrincipal(req, res, ctx)) return;
    next();
  };
}

/**
 * The org a request may act on: a credential-bound org (JWT/SSO) always
 * wins and the client-supplied org (header/body/query) is ignored; the
 * owner may select an org explicitly. Returns undefined when a bound
 * principal's org conflicts with an explicitly requested one — callers
 * treat that as "no access", never as the requested org.
 */
export function effectiveOrgId(principal: Principal, requested?: string | null): string | undefined {
  if (principal.orgId) {
    if (requested && requested !== principal.orgId) return undefined;
    return principal.orgId;
  }
  return requested ?? undefined;
}
