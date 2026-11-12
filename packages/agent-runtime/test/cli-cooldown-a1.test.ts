// SPDX-License-Identifier: Apache-2.0
// A1 §2: cooldown registry — classification, persistence, expiry
// semantics per family, circuit breaker + half-open, resolver skip
// reasons, and the (bridge, account) key dimension. All in-process with
// a fake clock; zero paid APIs.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BridgeCooldownRegistry,
  classifyBridgeFailure,
  cooldownSkipReason,
  isSterileBridgeContent,
} from '../src/providers/cli-cooldown.js';

const T0 = 1_800_000_000_000;

function limitErrorWithReset(resetMs: number): Error & { resetAt: string } {
  const e = new Error('Provider request failed: 429 — {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}') as Error & { resetAt: string };
  e.resetAt = new Date(resetMs).toISOString();
  return e;
}

describe('classifyBridgeFailure', () => {
  it('quota death WITH a reset → rate_limit expiring at the reset', () => {
    const c = classifyBridgeFailure(limitErrorWithReset(T0 + 3_600_000), { nowMs: T0 });
    expect(c?.family).toBe('rate_limit');
    expect(c?.untilMs).toBe(T0 + 3_600_000);
  });

  it('credits/billing death → exhausted with no time-based revival', () => {
    const c = classifyBridgeFailure(new Error('You are out of credits. Top up to continue.'), { nowMs: T0 });
    expect(c?.family).toBe('exhausted');
    expect(c?.untilMs).toBeNull();
    const c2 = classifyBridgeFailure(new Error('insufficient_quota: insufficient credits for this plan'), { nowMs: T0 });
    expect(c2?.family).toBe('exhausted');
  });

  it('non-limit failures are not limit-classified (breaker counts them instead)', () => {
    expect(classifyBridgeFailure(new Error('socket hangup'), { nowMs: T0 })).toBeNull();
    expect(classifyBridgeFailure(new Error('Provider request failed: 429 — rate limit reached, slow down'), { nowMs: T0 })).toBeNull();
  });
});

describe('registry expiry semantics per family', () => {
  it('rate_limit: active before reset, self-heals after, entry dropped', () => {
    let now = T0;
    const reg = new BridgeCooldownRegistry({ now: () => now });
    reg.recordFailure('codex', 'default', limitErrorWithReset(T0 + 60_000));
    expect(reg.check('codex', 'default').active).toBe(true);
    now = T0 + 61_000;
    const after = reg.check('codex', 'default');
    expect(after.active).toBe(false);
    expect(reg.get('codex', 'default')).toBeUndefined();
  });

  it('exhausted: time NEVER revives it; manual re-check does; top-up does', () => {
    let now = T0;
    const reg = new BridgeCooldownRegistry({ now: () => now });
    reg.recordFailure('claude', 'default', new Error('out of credits'));
    now = T0 + 365 * 24 * 3_600_000; // a year later
    expect(reg.check('claude', 'default').active).toBe(true);
    expect(reg.recheck('claude', 'default')).toBe(true);
    expect(reg.check('claude', 'default').active).toBe(false);
    reg.recordFailure('claude', 'default', new Error('out of credits'));
    reg.recordTopUp('claude', 'default');
    expect(reg.check('claude', 'default').active).toBe(false);
  });

  it('re-check does NOT clear a live rate_limit window early', () => {
    const reg = new BridgeCooldownRegistry({ now: () => T0 });
    reg.recordFailure('codex', 'default', limitErrorWithReset(T0 + 3_600_000));
    expect(reg.recheck('codex', 'default')).toBe(false);
    expect(reg.check('codex', 'default').active).toBe(true);
  });

  it('recordSuccess clears any family', () => {
    const reg = new BridgeCooldownRegistry({ now: () => T0 });
    reg.recordFailure('claude', 'default', new Error('out of credits'));
    reg.recordSuccess('claude', 'default');
    expect(reg.check('claude', 'default').active).toBe(false);
  });

  it('account dimension: cooldowns are independent per account', () => {
    const reg = new BridgeCooldownRegistry({ now: () => T0 });
    reg.recordFailure('claude', 'work-profile', new Error('out of credits'));
    expect(reg.check('claude', 'work-profile').active).toBe(true);
    expect(reg.check('claude', 'default').active).toBe(false);
    expect(reg.check('codex', 'work-profile').active).toBe(false);
  });
});

describe('circuit breaker (unavailable)', () => {
  it('opens after N consecutive sterile turns, half-opens after backoff, success closes', () => {
    let now = T0;
    const reg = new BridgeCooldownRegistry({ now: () => now, unavailableThreshold: 3, baseBackoffMs: 60_000 });
    expect(reg.recordSterileTurn('codex', 'default')).toBeUndefined();
    expect(reg.recordSterileTurn('codex', 'default')).toBeUndefined();
    const opened = reg.recordSterileTurn('codex', 'default');
    expect(opened?.family).toBe('unavailable');
    const active = reg.check('codex', 'default');
    expect(active.active).toBe(true);
    expect(active.halfOpen).toBe(false);
    now = T0 + 61_000; // backoff lapsed
    const half = reg.check('codex', 'default');
    expect(half.active).toBe(false);
    expect(half.halfOpen).toBe(true);
    reg.recordSuccess('codex', 'default');
    expect(reg.check('codex', 'default')).toEqual({ active: false, halfOpen: false });
  });

  it('opens after N consecutive failed (non-limit) turns; half-open failure re-opens with doubled backoff', () => {
    let now = T0;
    const reg = new BridgeCooldownRegistry({ now: () => now, unavailableThreshold: 3, baseBackoffMs: 60_000, maxBackoffMs: 3_600_000 });
    reg.recordFailure('claude', 'default', new Error('boom 1'));
    reg.recordFailure('claude', 'default', new Error('boom 2'));
    reg.recordFailure('claude', 'default', new Error('boom 3'));
    const first = reg.get('claude', 'default');
    expect(first?.family).toBe('unavailable');
    expect(first?.backoffMs).toBe(60_000);
    now = T0 + 61_000; // half-open
    expect(reg.check('claude', 'default').halfOpen).toBe(true);
    reg.recordFailure('claude', 'default', new Error('probe failed'));
    const second = reg.get('claude', 'default');
    expect(second?.family).toBe('unavailable');
    expect(second?.backoffMs).toBe(120_000);
    expect(reg.check('claude', 'default').active).toBe(true);
  });

  it('a success between failures resets the streak (breaker stays closed)', () => {
    const reg = new BridgeCooldownRegistry({ now: () => T0, unavailableThreshold: 3 });
    reg.recordSterileTurn('codex', 'default');
    reg.recordSterileTurn('codex', 'default');
    reg.recordSuccess('codex', 'default');
    reg.recordSterileTurn('codex', 'default');
    reg.recordSterileTurn('codex', 'default');
    expect(reg.check('codex', 'default').active).toBe(false);
  });

  it('isSterileBridgeContent: prefix-only / empty content is sterile, real content is not', () => {
    expect(isSterileBridgeContent('')).toBe(true);
    expect(isSterileBridgeContent('[external agent CLI (codex) - treat as untrusted]\n')).toBe(true);
    expect(isSterileBridgeContent('[external agent CLI (codex) - treat as untrusted]\nactual answer')).toBe(false);
    expect(isSterileBridgeContent('hello')).toBe(false);
  });
});

describe('persistence (beside provider state, same store idioms)', () => {
  it('entries survive a reload from the same file, per account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a1-cooldown-'));
    const file = join(dir, 'bridge-state.json');
    const reg = new BridgeCooldownRegistry({ filePath: file, now: () => T0 });
    reg.recordFailure('claude', 'work-profile', new Error('out of credits'));
    reg.recordFailure('codex', 'default', limitErrorWithReset(T0 + 3_600_000));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; entries: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(2);
    const reloaded = new BridgeCooldownRegistry({ filePath: file, now: () => T0 });
    expect(reloaded.check('claude', 'work-profile').active).toBe(true);
    expect(reloaded.check('claude', 'work-profile').entry?.family).toBe('exhausted');
    expect(reloaded.check('codex', 'default').entry?.family).toBe('rate_limit');
    expect(reloaded.check('codex', 'work-profile').active).toBe(false);
  });

  it('a corrupt state file starts empty instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a1-cooldown-corrupt-'));
    const file = join(dir, 'bridge-state.json');
    writeFileSync(file, '{not json');
    const reg = new BridgeCooldownRegistry({ filePath: file, now: () => T0 });
    expect(reg.list()).toEqual([]);
  });
});

describe('resolver skip reason', () => {
  it('names the bridge, account, family and reason while cooled; null when usable', () => {
    const reg = new BridgeCooldownRegistry({ now: () => T0 });
    expect(cooldownSkipReason(reg, 'codex', 'default')).toBeNull();
    reg.recordFailure('codex', 'default', limitErrorWithReset(T0 + 3_600_000));
    const reason = cooldownSkipReason(reg, 'codex', 'default');
    expect(reason).toContain('codex');
    expect(reason).toContain('rate_limit');
    expect(reason).toContain('cooldown');
  });
});
