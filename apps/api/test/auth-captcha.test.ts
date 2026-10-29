// SPDX-License-Identifier: Apache-2.0
// Captcha tests: issue/verify, single-use, expiry, brute-force burn, and
// the failure-threshold policy hook.

import { describe, expect, it } from 'vitest';
import {
  CaptchaStore,
  LoginFailureTracker,
  checkCaptcha,
  requireCaptcha,
  type CaptchaPolicy,
} from '../src/auth-captcha.js';

describe('CaptchaStore', () => {
  it('issues an SVG challenge and verifies the answer once', () => {
    const store = new CaptchaStore();
    const c = store.issue('K7QX2');
    expect(c.svg).toContain('<svg');
    expect(c.svg).not.toContain('K7QX2</text>'); // glyphs are split per-char
    expect(store.verify(c.id, 'k7qx2')).toBe(true); // case-insensitive
    expect(store.verify(c.id, 'K7QX2')).toBe(false); // single-use
  });

  it('rejects wrong answers and burns the captcha after max attempts', () => {
    const store = new CaptchaStore({ maxAttempts: 3 });
    const c = store.issue('ABCDE');
    expect(store.verify(c.id, 'XXXXX')).toBe(false);
    expect(store.verify(c.id, 'YYYYY')).toBe(false);
    expect(store.verify(c.id, 'ZZZZZ')).toBe(false);
    // Burned: even the right answer now fails (brute-force lockout).
    expect(store.verify(c.id, 'ABCDE')).toBe(false);
  });

  it('expires challenges after the TTL', () => {
    let now = 1_000_000;
    const store = new CaptchaStore({ ttlMs: 1000, now: () => now });
    const c = store.issue('ABCDE');
    now += 1001;
    expect(store.verify(c.id, 'ABCDE')).toBe(false);
  });

  it('random codes differ between issues', () => {
    const store = new CaptchaStore();
    const a = store.issue();
    const b = store.issue();
    expect(a.id).not.toBe(b.id);
    expect(a.svg.length).toBeGreaterThan(100);
    expect(b.svg.length).toBeGreaterThan(100);
  });
});

describe('captcha policy + failure tracker', () => {
  it('requires a captcha only after N failures (after-failures mode)', () => {
    const failures = new LoginFailureTracker();
    const policy: CaptchaPolicy = { mode: 'after-failures', threshold: 3 };
    expect(requireCaptcha(policy, failures, 'alice')).toBe(false);
    failures.recordFailure('alice');
    failures.recordFailure('alice');
    expect(requireCaptcha(policy, failures, 'alice')).toBe(false);
    failures.recordFailure('alice');
    expect(requireCaptcha(policy, failures, 'alice')).toBe(true);
    failures.clear('alice');
    expect(requireCaptcha(policy, failures, 'alice')).toBe(false);
  });

  it('always / never modes are absolute', () => {
    const failures = new LoginFailureTracker();
    expect(requireCaptcha({ mode: 'always' }, failures, 'x')).toBe(true);
    expect(requireCaptcha({ mode: 'never' }, failures, 'x')).toBe(false);
  });

  it('checkCaptcha enforces the answer when required', () => {
    const failures = new LoginFailureTracker();
    const store = new CaptchaStore();
    const policy: CaptchaPolicy = { mode: 'always' };
    const c = store.issue('PQRST');
    expect(checkCaptcha(policy, failures, store, 'k', undefined, undefined)).toEqual({ required: true, ok: false });
    const cWrong = store.issue('PQRST');
    expect(checkCaptcha(policy, failures, store, 'k', cWrong.id, 'WRONG').ok).toBe(false);
    expect(checkCaptcha(policy, failures, store, 'k', c.id, 'PQRST')).toEqual({ required: true, ok: true });
    expect(checkCaptcha({ mode: 'never' }, failures, store, 'k', undefined, undefined)).toEqual({ required: false, ok: true });
  });
});
