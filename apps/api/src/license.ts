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
//
// B2 (Timon parity programme, approved deviation — see PROGRAM-SUMMARY.md):
// multi-user roles are wired as the license/Pro gate. The wiring lives
// here and in tenancy.ts / tenancy-depth-routes.ts, and it is PACKAGING
// BEHAVIOUR ONLY: no billing, no checkout, no seat counting, and no
// enforcement-by-default. Design decisions, stated plainly:
//
//   * Flag: the SAME opt-in flag as every other license gate —
//     KRIYADOT_LICENSE_REQUIRED=1. There is deliberately no second flag
//     to discover: an operator who turns license enforcement on gets
//     all of it, and the default (unset) keeps every install exactly as
//     open as it is today. Flag-off-by-default is a hard requirement —
//     a local/single-user install must never be locked out of its own
//     org tools by an absent license, and evaluation below returns
//     before the license is even loaded when the flag is off.
//   * Tier model: this license format has NO separate tier field — the
//     signed `features[]` list IS the tier carrier (see LicensePayload).
//     "Pro" for multi-user is therefore defined as: a valid, unexpired,
//     signature-verified license whose features include 'multi-user'.
//     Mint one with scripts/make-license.mjs --features multi-user
//     (plus any other features). No new crypto, no new keypair: the
//     embedded DEV public key above stays exactly as shipped, and a
//     real production keypair remains a separate user gate.
//   * Boundary NOT crossed here: identity. This gate answers "does this
//     instance's license allow multi-user features?", never "who is
//     calling?". Caller identity stays with principal.ts (the OPEN-1
//     fix); the gate must not be read as an auth check and adds no
//     header trust of its own.

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

// ---------------------------------------------------------------------------
// Gate evaluation (shared by requireFeature and the B2 multi-user gate)
// ---------------------------------------------------------------------------

/**
 * Outcome of evaluating one feature against the current license.
 * `gated: false` means enforcement is OFF (the default): the caller must
 * proceed exactly as if no gate existed — evaluation returns before the
 * license string is loaded or verified, so off-state behaviour (and
 * timing) is indistinguishable from having no gate at all.
 * When gated and refused, `error` uses the long-standing license error
 * taxonomy: license_required | license_malformed | license_bad_signature
 * | license_expired | license_feature_not_included.
 */
export type LicenseGateEvaluation =
  | { gated: false; allowed: true }
  | { gated: true; allowed: true; payload: LicensePayload }
  | { gated: true; allowed: false; error: string; check?: LicenseCheck };

export function evaluateLicenseGate(feature: LicenseFeature, deps: RequireFeatureDeps = {}): LicenseGateEvaluation {
  const env = deps.env ?? process.env;
  if (!licenseEnforcementEnabled(env)) {
    return { gated: false, allowed: true };
  }
  const raw = (deps.loadLicense ?? (() => loadLicenseFromEnv(env)))();
  if (!raw) {
    return { gated: true, allowed: false, error: 'license_required' };
  }
  const check = verifyLicense(raw, { publicKeyB64: deps.publicKeyB64 });
  if (!check.valid) {
    return { gated: true, allowed: false, error: `license_${check.reason.replace('-', '_')}`, check };
  }
  if (!check.payload.features.includes(feature)) {
    return { gated: true, allowed: false, error: 'license_feature_not_included', check };
  }
  return { gated: true, allowed: true, payload: check.payload };
}

// ---------------------------------------------------------------------------
// B2: multi-user roles as the Pro gate (tenancy.ts / tenancy-depth-routes.ts)
// ---------------------------------------------------------------------------

/** License feature string that grants multi-user roles (the "Pro" tier). */
export const MULTI_USER_FEATURE = 'multi-user';
/** Human-facing tier name for the multi-user grant. */
export const MULTI_USER_REQUIRED_TIER = 'pro';
/** Stable machine-readable refusal code (UI + tests key off this). */
export const MULTI_USER_PRO_CODE = 'multi_user_requires_pro';
/** Honest UI copy for the refusal / status surface. One string, reused. */
export const MULTI_USER_PRO_MESSAGE =
  'Multi-user teams require a Pro license. Add a license that includes the "multi-user" feature, or turn the license gate off (unset KRIYADOT_LICENSE_REQUIRED).';

/** The 403 body for a refused multi-user capability. */
export function multiUserProRefusalBody(evaluation: LicenseGateEvaluation): Record<string, unknown> {
  return {
    ok: false,
    error: evaluation.gated && !evaluation.allowed ? evaluation.error : 'license_required',
    code: MULTI_USER_PRO_CODE,
    feature: MULTI_USER_FEATURE,
    requiredTier: MULTI_USER_REQUIRED_TIER,
    message: MULTI_USER_PRO_MESSAGE,
  };
}

/** Evaluate the multi-user gate through the standard license path. */
export function evaluateMultiUserGate(deps: RequireFeatureDeps = {}): LicenseGateEvaluation {
  return evaluateLicenseGate(MULTI_USER_FEATURE, deps);
}

/** Write the 403 Pro refusal for a denied multi-user evaluation. */
export function sendMultiUserProRefusal(res: Response, evaluation: LicenseGateEvaluation): void {
  res.status(403).json(multiUserProRefusalBody(evaluation));
}

export interface MultiUserGateStatus {
  ok: true;
  feature: typeof MULTI_USER_FEATURE;
  requiredTier: typeof MULTI_USER_REQUIRED_TIER;
  /** True only when KRIYADOT_LICENSE_REQUIRED=1. False = gate OFF (default). */
  gateEnabled: boolean;
  /** True when the capability may be used (gate off, or Pro license held). */
  allowed: boolean;
  /** License error taxonomy value when gate is on and access is refused. */
  error?: string;
  /** Stable refusal code when gate is on and access is refused. */
  code?: typeof MULTI_USER_PRO_CODE;
  /** UI copy when gate is on and access is refused; absent otherwise. */
  message?: string;
}

/**
 * Status object for the org/member UI surface (GET /orgs/license-status).
 * When the gate is OFF this reports { gateEnabled: false, allowed: true }
 * with NO message/code — the UI renders nothing at all in that state.
 */
export function multiUserGateStatus(deps: RequireFeatureDeps = {}): MultiUserGateStatus {
  const evaluation = evaluateMultiUserGate(deps);
  const base: MultiUserGateStatus = {
    ok: true,
    feature: MULTI_USER_FEATURE,
    requiredTier: MULTI_USER_REQUIRED_TIER,
    gateEnabled: evaluation.gated,
    allowed: evaluation.allowed,
  };
  if (evaluation.gated && !evaluation.allowed) {
    return { ...base, error: evaluation.error, code: MULTI_USER_PRO_CODE, message: MULTI_USER_PRO_MESSAGE };
  }
  return base;
}

/**
 * Express middleware factory. When enforcement is disabled (default) this
 * is a pass-through. When enabled, requests need a valid, unexpired license
 * carrying `feature`; otherwise 403 { error: 'license_required' | ... }.
 */
export function requireFeature(feature: LicenseFeature, deps: RequireFeatureDeps = {}) {
  return function featureGate(req: Request, res: Response, next: NextFunction): void {
    const evaluation = evaluateLicenseGate(feature, deps);
    if (!evaluation.allowed) {
      res.status(403).json({ ok: false, error: evaluation.error, feature });
      return;
    }
    if (evaluation.gated) {
      (req as Request & { license?: LicensePayload }).license = evaluation.payload;
    }
    next();
  };
}
