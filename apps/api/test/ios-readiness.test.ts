// SPDX-License-Identifier: Apache-2.0
// C-13: iOS signing + APNs readiness — honest, credential-gated reporting.
// No Apple credentials exist in tests; readiness must report NOT ready
// and name the founder-owned blockers rather than faking success.

import { describe, expect, it } from 'vitest';
import { checkIosReadiness } from '../src/ios-readiness.js';

describe('checkIosReadiness', () => {
  it('with nothing configured: not ready, founder blockers named', () => {
    const r = checkIosReadiness({ env: {}, apsEnvironment: undefined, hasDevelopmentTeam: false, bundleId: undefined });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toContain('DEVELOPMENT_TEAM');
    expect(r.blockers.join(' ')).toContain('APNs');
    expect(r.blockers.join(' ')).toContain('Cannot be verified');
    // The verification item can never be auto-ok.
    expect(r.items.find((i) => i.key === 'signed-build-verification')?.ok).toBe(false);
  });
  it('entitlement + bundle + team flip their items, but verification still blocks ready', () => {
    const r = checkIosReadiness({
      env: { APNS_KEY_ID: 'KID', APNS_TEAM_ID: 'TEAM', APNS_BUNDLE_ID: 'com.kriyadot.companion', APNS_KEY_PEM: 'pem' },
      apsEnvironment: 'development', hasDevelopmentTeam: true, bundleId: 'com.kriyadot.companion',
    });
    expect(r.items.find((i) => i.key === 'development-team')?.ok).toBe(true);
    expect(r.items.find((i) => i.key === 'aps-entitlement')?.ok).toBe(true);
    expect(r.items.find((i) => i.key === 'apns-server-config')?.ok).toBe(true);
    expect(r.ready).toBe(false); // signed-build verification remains founder-gated
  });
});
