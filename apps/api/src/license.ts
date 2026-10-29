// SPDX-License-Identifier: Apache-2.0
// Enterprise license gating (original code).
//
// A license is `<base64url(JSON payload)>.<base64url(Ed25519 signature)>`
// where payload = { org, features[], expiresAt, seats }. Verification uses
// the embedded production public key (or an injected key in tests).
//
// IMPORTANT — enforcement is opt-in: the requireFeature() middleware only
// blocks when KRIYADOT_LICENSE_REQUIRED=1. With the default (unset), every
// feature is open so local/single-user installs are never locked out. The
// license gates *features* only; it never fakes an SSO or any other check.
//
// Dev licenses are minted with scripts/make-license.mjs, which reads the
// signing private key from env/arg (never committed to this repo).

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Embedded Ed25519 public key (SPKI DER, base64) for license verification. */
export const LICENSE_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEALbdQH9LIHmcj25UvCYmbTeEFH/b23SlKndmsMVorsko=';

export type LicenseFeature = 'sso' | 'white-label' | 'federation' | 'ldap' | 'org-library' | string;

export interface LicensePayload {
  org: string;
  features: string[];
  /** Epoch ms. */
  expiresAt: number;
  seats: number;
}

export function licenseEnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KRIYADOT_LICENSE_REQUIRED === '1';
}

export function parseLicense(raw: unknown): { payload: LicensePayload; signed: string; signature: Buffer } | null {
  if (typeof raw !== 'string') return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const signed = raw.slice(0, dot);
  const signature = Buffer.from(raw.slice(dot + 1), 'base64url');
  try {
    const payload = JSON.parse(Buffer.from(signed, 'base64url').toString('utf8')) as LicensePayload;
    if (typeof payload.org !== 'string' || !Array.isArray(payload.features) || typeof payload.expiresAt !== 'number') {
      return null;
    }
    return { payload, signed, signature };
  } catch {
    return null;
  }
}

export interface VerifyLicenseOptions {
  /** SPKI DER base64 public key override (tests / key rotation). */
  publicKeyB64?: string;
  now?: number;
}

export type LicenseCheck =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: 'malformed' | 'bad-signature' | 'expired' };

export function verifyLicense(raw: unknown, opts: VerifyLicenseOptions = {}): LicenseCheck {
  const parsed = parseLicense(raw);
  if (!parsed) return { valid: false, reason: 'malformed' };
  try {
    const key = createPublicKey({
      key: Buffer.from(opts.publicKeyB64 ?? LICENSE_PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = cryptoVerify(null, Buffer.from(parsed.signed, 'ascii'), key, parsed.signature);
    if (!ok) return { valid: false, reason: 'bad-signature' };
  } catch {
    return { valid: false, reason: 'bad-signature' };
  }
  if (parsed.payload.expiresAt <= (opts.now ?? Date.now())) return { valid: false, reason: 'expired' };
  return { valid: true, payload: parsed.payload };
}

export function licenseHasFeature(check: LicenseCheck, feature: LicenseFeature): boolean {
  return check.valid && check.payload.features.includes(feature);
}

/** The active license string: env KRIYADOT_LICENSE first, else the loader's. */
export function loadLicenseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.KRIYADOT_LICENSE?.trim() || null;
}

export interface RequireFeatureDeps {
  /** Returns the current license string (defaults to env). */
  loadLicense?: () => string | null;
  env?: NodeJS.ProcessEnv;
  publicKeyB64?: string;
}

/**
 * Express middleware factory. When enforcement is disabled (default) this
 * is a pass-through. When enabled, requests need a valid, unexpired license
 * carrying `feature`; otherwise 403 { error: 'license_required' | ... }.
 */
export function requireFeature(feature: LicenseFeature, deps: RequireFeatureDeps = {}) {
  return function featureGate(req: Request, res: Response, next: NextFunction): void {
    const env = deps.env ?? process.env;
    if (!licenseEnforcementEnabled(env)) {
      next();
      return;
    }
    const raw = (deps.loadLicense ?? (() => loadLicenseFromEnv(env)))();
    if (!raw) {
      res.status(403).json({ ok: false, error: 'license_required', feature });
      return;
    }
    const check = verifyLicense(raw, { publicKeyB64: deps.publicKeyB64 });
    if (!check.valid) {
      res.status(403).json({ ok: false, error: `license_${check.reason.replace('-', '_')}`, feature });
      return;
    }
    if (!check.payload.features.includes(feature)) {
      res.status(403).json({ ok: false, error: 'license_feature_not_included', feature });
      return;
    }
    (req as Request & { license?: LicensePayload }).license = check.payload;
    next();
  };
}
