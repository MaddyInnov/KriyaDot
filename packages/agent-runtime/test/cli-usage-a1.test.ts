// SPDX-License-Identifier: Apache-2.0
// A1 §1: per-account usage gauges. Zero paid APIs — every probe runs
// against fake CLI shims (stub executables printing canned output) or
// the pure parsers. The honesty contract under test: a CLI that exposes
// no usage figure yields utilisation null ("usage unknown"), NEVER 0.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatBridgeUsage,
  parseCliUsageOutput,
  probeBridgeUsage,
  resetBridgeUsageCache,
} from '../src/providers/cli-usage.js';
import { resetCliIdentityCache } from '../src/providers/cli-bridge.js';

const NOW = 1_800_000_000_000;

afterEach(() => {
  resetBridgeUsageCache();
  resetCliIdentityCache();
});

describe('parseCliUsageOutput (pure)', () => {
  it('parses windowed JSON and picks the most-utilised window with its reset', () => {
    const reset5h = new Date(NOW + 3_600_000).toISOString();
    const out = JSON.stringify({
      loggedIn: true,
      five_hour: { utilization: 0.42, resets_at: new Date(NOW + 7_200_000).toISOString() },
      seven_day: { utilization: 0.87, resets_at: reset5h },
    });
    // seven_day is the binding window (87%) — but its reset is reset5h var name aside, check values:
    const fig = parseCliUsageOutput(out, NOW);
    expect(fig?.usedPercent).toBe(87);
    expect(fig?.resetAtMs).toBe(NOW + 3_600_000);
  });

  it('parses percent-valued JSON fields (0..100 form) and remaining→used conversion', () => {
    expect(parseCliUsageOutput(JSON.stringify({ usagePercent: 63 }), NOW)?.usedPercent).toBe(63);
    expect(parseCliUsageOutput(JSON.stringify({ remainingPercent: 25 }), NOW)?.usedPercent).toBe(75);
  });

  it('parses free text: "% used", multiple windows (max wins), ISO reset', () => {
    const iso = new Date(NOW + 5_400_000).toISOString();
    const fig = parseCliUsageOutput(`5-hour limit: 40% used\nWeekly limit: 82% used, resets at ${iso}`, NOW);
    expect(fig?.usedPercent).toBe(82);
    expect(fig?.resetAtMs).toBe(NOW + 5_400_000);
  });

  it('parses "resets in 1h 10m" relative resets', () => {
    const fig = parseCliUsageOutput('Usage: 59% used, resets in 1h 10m', NOW);
    expect(fig?.usedPercent).toBe(59);
    expect(fig?.resetAtMs).toBe(NOW + 70 * 60_000);
  });

  it('parses "% remaining" text as used = 100 − remaining', () => {
    expect(parseCliUsageOutput('You have 18% remaining on your plan limit', NOW)?.usedPercent).toBe(82);
  });

  it('returns undefined for login-only output — no fabricated figure', () => {
    // Today's real `claude auth status` shape: login JSON, no usage fields.
    expect(parseCliUsageOutput(JSON.stringify({ loggedIn: true, email: 'user@example.com' }), NOW)).toBeUndefined();
    // Today's real `codex login status` shape.
    expect(parseCliUsageOutput('Logged in using ChatGPT', NOW)).toBeUndefined();
    expect(parseCliUsageOutput('', NOW)).toBeUndefined();
    expect(parseCliUsageOutput('some unrelated 50% discount offer', NOW)).toBeUndefined();
  });
});

// ---- Fake CLI shims -------------------------------------------------------

function shimDir(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), `a1-shim-${name}-`));
  const bin = join(dir, name);
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return dir;
}

function probeWithShim(bridge: 'claude' | 'codex' | 'opencode', dir: string, home: string) {
  return probeBridgeUsage(bridge, {
    detect: { homeDir: home, pathDirs: [dir] },
    fresh: true,
  });
}

describe('probeBridgeUsage with fake CLI shims', () => {
  const home = mkdtempSync(join(tmpdir(), 'a1-home-'));

  it('claude shim WITH usage fields in auth status → gauge carries them', () => {
    const dir = shimDir('claude', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"five_hour":{"utilization":0.66,"resets_at":"2027-01-01T00:00:00.000Z"}}\'; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'));
    const g = probeWithShim('claude', dir, home);
    expect(g.source).toBe('cli-status');
    expect(g.utilisationPercent).toBe(66);
    expect(g.resetAtMs).toBe(new Date('2027-01-01T00:00:00.000Z').getTime());
    expect(g.accountId).toBe('default');
  });

  it('claude shim with TODAY\'s real auth status (login only) → honest null, not 0', () => {
    const dir = shimDir('claude', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","email":"user@example.com"}\'; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'));
    const g = probeWithShim('claude', dir, home);
    expect(g.utilisationPercent).toBeNull();
    expect(g.resetAtMs).toBeNull();
    expect(formatBridgeUsage(g)).toBe('usage unknown');
  });

  it('codex shim WITH usage lines in login status → gauge parses max window + reset', () => {
    const dir = shimDir('codex', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.142.0"; exit 0; fi',
      'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; echo "5-hour limit: 30% used"; echo "Weekly limit: 82% used, resets at 2027-01-01T00:00:00.000Z"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'));
    const g = probeWithShim('codex', dir, home);
    expect(g.utilisationPercent).toBe(82);
    expect(g.resetAtMs).toBe(new Date('2027-01-01T00:00:00.000Z').getTime());
  });

  it('codex shim with TODAY\'s real login status (account only) → honest null', () => {
    const dir = shimDir('codex', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.142.0"; exit 0; fi',
      'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'));
    const g = probeWithShim('codex', dir, home);
    expect(g.utilisationPercent).toBeNull();
    expect(g.source).toBe('cli-status');
  });

  it('opencode has NO usage surface → no-surface null without spawning', () => {
    const dir = shimDir('opencode', [
      '#!/bin/sh',
      'echo "1.0.119"; exit 0',
      '',
    ].join('\n'));
    const g = probeWithShim('opencode', dir, home);
    expect(g.source).toBe('no-surface');
    expect(g.utilisationPercent).toBeNull();
  });

  it('missing CLI → cli-unavailable null (never a zero)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'a1-empty-bin-'));
    mkdirSync(empty, { recursive: true });
    const g = probeBridgeUsage('claude', { detect: { homeDir: home, pathDirs: [empty] }, fresh: true });
    expect(g.source).toBe('cli-unavailable');
    expect(g.utilisationPercent).toBeNull();
  });

  it('account dimension: gauges are keyed per account id', () => {
    const g = probeBridgeUsage('claude', {
      accountId: 'work-profile',
      resolveFn: () => undefined,
      fresh: true,
    });
    expect(g.accountId).toBe('work-profile');
    expect(g.utilisationPercent).toBeNull();
  });
});
