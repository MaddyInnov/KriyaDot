// SPDX-License-Identifier: Apache-2.0
// B-10 close-out (final cut, 2026-11-26) — direct unit test for the
// runtime provider cache key.
//
// The B-10 fix (sweep 2026-11-25) folded the live CLI path pin and a
// sorted env signature into resolveProvider's cache key, but shipped
// without a direct unit test because resolveProvider is not
// injectable in the test harness. The key computation is now a pure
// exported function (buildProviderCacheKey in runtime.ts) with
// resolveProvider's behaviour unchanged; this suite pins the
// contract the fix promises:
// - unchanged inputs keep the cached instance (stable key),
// - a pin change produces a fresh key (re-pin takes effect live),
// - an env change produces a fresh key,
// - env insertion order never changes the key.

import { describe, expect, it } from 'vitest';
import { buildProviderCacheKey } from '../src/index.js';

describe('buildProviderCacheKey (B-10)', () => {
  it('is the bare providerId when nothing live is folded in', () => {
    expect(buildProviderCacheKey('claude-subscription')).toBe('claude-subscription');
    expect(buildProviderCacheKey('claude-subscription', {})).toBe('claude-subscription');
    expect(buildProviderCacheKey('claude-subscription', { env: {} })).toBe('claude-subscription');
    expect(buildProviderCacheKey('claude-subscription', { env: undefined, pin: undefined })).toBe(
      'claude-subscription',
    );
  });

  it('is stable: identical inputs produce identical keys', () => {
    const parts = { accountId: 'work', pin: '/opt/cli/pi', env: { PI_CODING_AGENT_DIR: '/a/pi-work' } };
    expect(buildProviderCacheKey('pi-subscription', parts)).toBe(
      buildProviderCacheKey('pi-subscription', { ...parts }),
    );
  });

  it('changes when the CLI path pin changes (a re-pin resolves fresh)', () => {
    const before = buildProviderCacheKey('pi-subscription', { pin: '/old/path/pi' });
    const after = buildProviderCacheKey('pi-subscription', { pin: '/new/path/pi' });
    expect(before).not.toBe(after);
    expect(before).toContain('#pin:/old/path/pi');
    expect(after).toContain('#pin:/new/path/pi');
    // Clearing the pin returns to the unpinned key.
    expect(buildProviderCacheKey('pi-subscription', { pin: undefined })).toBe('pi-subscription');
  });

  it('changes when the env changes', () => {
    const a = buildProviderCacheKey('pi-subscription', { env: { PI_CODING_AGENT_DIR: '/a/one' } });
    const b = buildProviderCacheKey('pi-subscription', { env: { PI_CODING_AGENT_DIR: '/a/two' } });
    const c = buildProviderCacheKey('pi-subscription', { env: { EXTRA: '1', PI_CODING_AGENT_DIR: '/a/one' } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('is order-insensitive in the env (insertion order never changes the key)', () => {
    const a = buildProviderCacheKey('x', { env: { B: '2', A: '1', C: '3' } });
    const b = buildProviderCacheKey('x', { env: { C: '3', A: '1', B: '2' } });
    expect(a).toBe(b);
    expect(a).toContain('#env:[["A","1"],["B","2"],["C","3"]]');
  });

  it('scopes by account id exactly when an account env is present', () => {
    const env = { PI_CODING_AGENT_DIR: '/a/pi-work' };
    expect(buildProviderCacheKey('pi-subscription', { accountId: 'work', env })).toContain('#acct:work');
    expect(buildProviderCacheKey('pi-subscription', { accountId: 'home', env })).not.toBe(
      buildProviderCacheKey('pi-subscription', { accountId: 'work', env }),
    );
    // An account id without env folds nothing in (mirrors
    // resolveProvider, which only sets both together).
    expect(buildProviderCacheKey('pi-subscription', { accountId: 'work' })).toBe('pi-subscription');
  });

  it('combines account, pin and env segments in a fixed order', () => {
    expect(
      buildProviderCacheKey('pi-subscription', {
        accountId: 'work',
        pin: '/opt/cli/pi',
        env: { PI_CODING_AGENT_DIR: '/a/pi-work' },
      }),
    ).toBe('pi-subscription#acct:work#pin:/opt/cli/pi#env:[["PI_CODING_AGENT_DIR","/a/pi-work"]]');
  });

  it('different providers never collide', () => {
    const parts = { pin: '/opt/cli/x', env: { A: '1' } };
    expect(buildProviderCacheKey('one', parts)).not.toBe(buildProviderCacheKey('two', parts));
  });
});
