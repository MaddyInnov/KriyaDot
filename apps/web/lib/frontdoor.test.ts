// SPDX-License-Identifier: Apache-2.0
// Front-door pure helpers: anchor label strings are pinned EXACTLY to the
// API's exported label helper; anchor resolution mirrors the server rule.

import { describe, expect, it } from 'vitest';
import {
  anchorLabel,
  anchorWarningPreview,
  executorForPlacement,
  isFreeTier,
  isTimeBasedSchedule,
  placementConflictMessage,
  resolveAnchorPreview,
  showFreeTierCaveat,
} from './frontdoor';

describe('anchorLabel (exact server strings)', () => {
  it('cloud label', () => {
    expect(anchorLabel('cloud')).toBe('Runs in your cloud — fires even while your PC is off');
  });
  it('local label', () => {
    expect(anchorLabel('local')).toBe("Runs on this device — only while it's on");
  });
});

describe('isTimeBasedSchedule', () => {
  it('time-based kinds', () => {
    for (const k of ['once', 'daily', 'cron', 'interval']) expect(isTimeBasedSchedule(k)).toBe(true);
  });
  it('non-time-based kinds', () => {
    for (const k of ['event', 'limit-reset', null, undefined, '']) expect(isTimeBasedSchedule(k)).toBe(false);
  });
});

describe('resolveAnchorPreview', () => {
  it('automatic + time-based + cloud connected → cloud (the anchor rule default)', () => {
    expect(
      resolveAnchorPreview({ choice: 'auto', scheduleKind: 'daily', cloudConnected: true }),
    ).toBe('cloud');
    expect(
      resolveAnchorPreview({ choice: 'auto', scheduleKind: 'cron', cloudConnected: true }),
    ).toBe('cloud');
  });
  it('automatic + time-based + no cloud → local', () => {
    expect(
      resolveAnchorPreview({ choice: 'auto', scheduleKind: 'daily', cloudConnected: false }),
    ).toBe('local');
  });
  it('automatic + non-time-based → bot placement executor', () => {
    expect(
      resolveAnchorPreview({ choice: 'auto', scheduleKind: 'event', cloudConnected: true, botExecutor: 'cloud' }),
    ).toBe('cloud');
    expect(
      resolveAnchorPreview({ choice: 'auto', scheduleKind: null, cloudConnected: true }),
    ).toBe('local');
  });
  it('explicit choice wins over the default', () => {
    expect(
      resolveAnchorPreview({ choice: 'local', scheduleKind: 'daily', cloudConnected: true }),
    ).toBe('local');
    expect(
      resolveAnchorPreview({ choice: 'cloud', scheduleKind: 'event', cloudConnected: false }),
    ).toBe('cloud');
  });
});

describe('anchorWarningPreview', () => {
  it('warns only for local + time-based + no cloud', () => {
    expect(
      anchorWarningPreview({ resolvedAnchor: 'local', scheduleKind: 'daily', cloudConnected: false }),
    ).toBe(true);
    expect(
      anchorWarningPreview({ resolvedAnchor: 'local', scheduleKind: 'daily', cloudConnected: true }),
    ).toBe(false);
    expect(
      anchorWarningPreview({ resolvedAnchor: 'cloud', scheduleKind: 'daily', cloudConnected: false }),
    ).toBe(false);
    expect(
      anchorWarningPreview({ resolvedAnchor: 'local', scheduleKind: 'event', cloudConnected: false }),
    ).toBe(false);
  });
});

describe('free-tier caveat', () => {
  it('isFreeTier matches free tiers only', () => {
    expect(isFreeTier('free')).toBe(true);
    expect(isFreeTier('Lightning Free')).toBe(true);
    expect(isFreeTier('pro')).toBe(false);
    expect(isFreeTier(undefined)).toBe(false);
  });
  it('shows for free tier + cloud anchor + time-critical schedule', () => {
    expect(
      showFreeTierCaveat({ cloudTier: 'free', resolvedAnchor: 'cloud', scheduleKind: 'daily' }),
    ).toBe(true);
    expect(
      showFreeTierCaveat({ cloudTier: 'pro', resolvedAnchor: 'cloud', scheduleKind: 'daily' }),
    ).toBe(false);
    expect(
      showFreeTierCaveat({ cloudTier: 'free', resolvedAnchor: 'local', scheduleKind: 'daily' }),
    ).toBe(false);
    expect(
      showFreeTierCaveat({ cloudTier: 'free', resolvedAnchor: 'cloud', scheduleKind: 'event' }),
    ).toBe(false);
  });
});

describe('placementConflictMessage', () => {
  it('maps the documented 409 codes', () => {
    expect(placementConflictMessage('run-in-flight')).toBe(
      'Stop the current run or wait for it to finish',
    );
    expect(placementConflictMessage('cloud-not-connected')).toContain('Connect your cloud first');
    expect(placementConflictMessage('something-else')).toBeNull();
    expect(placementConflictMessage(undefined)).toBeNull();
  });
});

describe('executorForPlacement', () => {
  it('cloud placements execute in the cloud', () => {
    expect(executorForPlacement('cloud-report')).toBe('cloud');
    expect(executorForPlacement('cloud-only')).toBe('cloud');
    expect(executorForPlacement('local')).toBe('local');
    expect(executorForPlacement(undefined)).toBe('local');
  });
});
