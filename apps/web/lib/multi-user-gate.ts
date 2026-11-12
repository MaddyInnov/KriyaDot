// SPDX-License-Identifier: Apache-2.0
// B2 (Timon parity programme): client side of the multi-user Pro gate.
//
// The API (apps/api/src/license.ts + tenancy.ts) is the source of truth:
// GET /api/orgs/license-status reports { gateEnabled, allowed, … } and
// gated writes refuse with 403 { code: 'multi_user_requires_pro', … }.
// This module only PARSES those shapes and decides whether the Pro
// notice shows. The notice must be invisible in the default state —
// gate OFF (the shipped default) or a valid Pro license — so
// shouldShowMultiUserProNotice() is true in exactly one case:
// gateEnabled && !allowed. Zero new UI noise otherwise is a requirement,
// not a nicety: most installs never turn license enforcement on.

import { authedFetch } from './api';

/** Mirrors MULTI_USER_PRO_CODE in apps/api/src/license.ts. */
export const MULTI_USER_PRO_CODE = 'multi_user_requires_pro';

/** Mirrors MULTI_USER_PRO_MESSAGE in apps/api/src/license.ts. */
export const MULTI_USER_PRO_MESSAGE =
  'Multi-user teams require a Pro license. Add a license that includes the "multi-user" feature, or turn the license gate off (unset KRIYADOT_LICENSE_REQUIRED).';

/** Shape of GET /api/orgs/license-status (see multiUserGateStatus). */
export interface MultiUserGateStatus {
  gateEnabled: boolean;
  allowed: boolean;
  feature: string;
  requiredTier: string;
  error?: string;
  code?: string;
  message?: string;
}

/** Parse an unknown JSON value into a gate status; null when malformed. */
export function parseMultiUserGateStatus(value: unknown): MultiUserGateStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.gateEnabled !== 'boolean' || typeof v.allowed !== 'boolean') return null;
  return {
    gateEnabled: v.gateEnabled,
    allowed: v.allowed,
    feature: typeof v.feature === 'string' ? v.feature : 'multi-user',
    requiredTier: typeof v.requiredTier === 'string' ? v.requiredTier : 'pro',
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
    ...(typeof v.code === 'string' ? { code: v.code } : {}),
    ...(typeof v.message === 'string' ? { message: v.message } : {}),
  };
}

/**
 * The ONLY state in which any Pro UI may appear: the gate is switched on
 * for this instance and its license does not grant multi-user.
 */
export function shouldShowMultiUserProNotice(status: MultiUserGateStatus | null): boolean {
  return status !== null && status.gateEnabled && !status.allowed;
}

/** True when an API response is the B2 Pro refusal (403 + stable code). */
export function isMultiUserProRefusal(status: number, body: unknown): boolean {
  if (status !== 403 || typeof body !== 'object' || body === null) return false;
  return (body as Record<string, unknown>).code === MULTI_USER_PRO_CODE;
}

/** Fetch the gate status for the org/member surface; null on any failure. */
export async function fetchMultiUserGateStatus(): Promise<MultiUserGateStatus | null> {
  try {
    const res = await authedFetch('/api/orgs/license-status');
    if (!res.ok) return null;
    return parseMultiUserGateStatus(await res.json());
  } catch {
    return null;
  }
}
