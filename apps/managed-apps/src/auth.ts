// SPDX-License-Identifier: Apache-2.0
// Service-token auth for the Managed Apps service.
//
// The token format is the front-door handoff contract (see
// apps/frontdoor/src/handoff.ts and apps/api/src/handoff.ts) — reused, not
// reinvented:
//   base64url(JSON payload) + "." + base64url(Ed25519 signature over the
//   payload segment)
// Payload: { v:1, iss:"kriyadot-frontdoor", accountId, email?, plan?,
//            features?, iat, exp } with iat/exp in SECONDS.
//
// Differences from the instance handoff exchange, by design: service tokens
// are bearer credentials for this API (not single-use), so there is no
// nonce and no 120-second lifetime cap — the TTL is whatever the issuer
// (the front door, or scripts/mint-token.mjs until it mints in-product)
// set. Verification still fails closed on: bad signature, wrong issuer,
// missing accountId, or an expired token.

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SERVICE_TOKEN_ISSUER = 'kriyadot-frontdoor';

export interface ServiceTokenPayload {
  v: 1;
  iss: string;
  accountId: string;
  email?: string;
  name?: string;
  plan?: string;
  features?: string[];
  iat: number;
  exp: number;
  [key: string]: unknown;
}

/** Resolve the front-door public key PEM: override → env PEM → env file. */
export function resolveFrontdoorPublicKey(opts: { pem?: string; keyFile?: string } = {}): string | null {
  const pem = opts.pem ?? process.env.MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_PEM;
  if (pem && pem.trim()) return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const file = opts.keyFile ?? process.env.MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_FILE;
  if (file && file.trim()) {
    try {
      const fromFile = readFileSync(file, 'utf8');
      return fromFile.trim() ? fromFile : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toSeconds(v: number): number {
  // JWT convention is seconds; accept millisecond magnitudes too (same
  // normalization as apps/api/src/handoff.ts).
  return v > 1e11 ? Math.floor(v / 1000) : v;
}

/**
 * Parse + verify a service token against the front-door public key.
 * Returns the payload, or null on ANY failure (callers answer 401).
 */
export function verifyServiceToken(
  token: string,
  publicKeyPem: string | null,
  nowMs: number = Date.now(),
): ServiceTokenPayload | null {
  if (!publicKeyPem || typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadSeg, sigSeg] = parts as [string, string];
  let payload: ServiceTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8')) as ServiceTokenPayload;
  } catch {
    return null;
  }
  let ok = false;
  try {
    const key = createPublicKey(publicKeyPem);
    ok = cryptoVerify(null, Buffer.from(payloadSeg, 'ascii'), key, Buffer.from(sigSeg, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return null;
  if (payload.v !== 1 || payload.iss !== SERVICE_TOKEN_ISSUER) return null;
  if (typeof payload.accountId !== 'string' || !payload.accountId) return null;
  if (typeof payload.exp !== 'number') return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (toSeconds(payload.exp) <= nowSec) return null;
  return payload;
}

/** Sign a service token (used by tests; the operator CLI is scripts/mint-token.mjs). */
export function signServiceToken(payload: ServiceTokenPayload, privateKeyPem: string): string {
  const seg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = cryptoSign(null, Buffer.from(seg, 'ascii'), createPrivateKey(privateKeyPem));
  return `${seg}.${Buffer.from(sig).toString('base64url')}`;
}

/**
 * The Composio entity id for a KriyaDot account, derived server-side ONLY:
 * 'kd_' + first 24 hex chars of sha256(accountId). Callers can never choose
 * or override this — any entity/user id in a request body or query is
 * ignored by the server.
 */
export function deriveEntityId(accountId: string): string {
  return 'kd_' + createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 24);
}
