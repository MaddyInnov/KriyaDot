// SPDX-License-Identifier: Apache-2.0
// B2: the web side of the multi-user Pro gate — parsing the API status
// shape, the show/hide decision for the Pro notice (visible ONLY when
// the gate is on and Pro is missing), and refusal detection.

import { describe, expect, it } from 'vitest';
import {
  MULTI_USER_PRO_CODE,
  isMultiUserProRefusal,
  parseMultiUserGateStatus,
  shouldShowMultiUserProNotice,
} from './multi-user-gate';

describe('parseMultiUserGateStatus', () => {
  it('parses the off / denied / allowed shapes', () => {
    expect(parseMultiUserGateStatus({ gateEnabled: false, allowed: true, feature: 'multi-user', requiredTier: 'pro' }))
      .toMatchObject({ gateEnabled: false, allowed: true });
    expect(
      parseMultiUserGateStatus({
        gateEnabled: true,
        allowed: false,
        feature: 'multi-user',
        requiredTier: 'pro',
        error: 'license_required',
        code: MULTI_USER_PRO_CODE,
        message: 'Multi-user teams require a Pro license. …',
      }),
    ).toMatchObject({ gateEnabled: true, allowed: false, code: MULTI_USER_PRO_CODE });
  });

  it('rejects malformed values', () => {
    expect(parseMultiUserGateStatus(null)).toBeNull();
    expect(parseMultiUserGateStatus('nope')).toBeNull();
    expect(parseMultiUserGateStatus({ gateEnabled: 'yes', allowed: true })).toBeNull();
    expect(parseMultiUserGateStatus({ allowed: true })).toBeNull();
  });
});

describe('shouldShowMultiUserProNotice', () => {
  it('is true only for gate-on + Pro-missing', () => {
    expect(shouldShowMultiUserProNotice({ gateEnabled: true, allowed: false, feature: 'multi-user', requiredTier: 'pro' })).toBe(true);
    expect(shouldShowMultiUserProNotice({ gateEnabled: false, allowed: true, feature: 'multi-user', requiredTier: 'pro' })).toBe(false);
    expect(shouldShowMultiUserProNotice({ gateEnabled: true, allowed: true, feature: 'multi-user', requiredTier: 'pro' })).toBe(false);
    expect(shouldShowMultiUserProNotice(null)).toBe(false);
  });
});

describe('isMultiUserProRefusal', () => {
  it('matches the API refusal shape and nothing else', () => {
    expect(isMultiUserProRefusal(403, { ok: false, code: MULTI_USER_PRO_CODE })).toBe(true);
    expect(isMultiUserProRefusal(403, { ok: false, error: 'license_required' })).toBe(false);
    expect(isMultiUserProRefusal(200, { code: MULTI_USER_PRO_CODE })).toBe(false);
    expect(isMultiUserProRefusal(403, null)).toBe(false);
  });
});
