// SPDX-License-Identifier: Apache-2.0
// Timon parity A2 at the API layer:
// - listProviders surfaces the five new manifest bridges through the
//   SAME data path as the original three: a bridge preset row with a
//   per-account list (machine default), an honest null usage gauge, and
//   pin state — no API-side special-casing per bridge.
// - With a fake `grok` shim + credential file, the grok bridge detects,
//   reports the account signed in, and Connect succeeds; a namesake
//   shim makes Connect fail with the plain-words reason.
// - CLI path pins (A8 machinery) work for a new bridge id.
// Zero paid APIs: fake CLI shims in temp bin dirs only.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isBridgeConnected,
  resetBridgeConsent,
  resetBridgeUsageCache,
  resetCliIdentityCache,
  resetCliPathPins,
} from '@mvp/agent-runtime';
import { connectBridge, listProviders, recheckBridgeAccount, setStoredCliPathPin } from '../src/providers.js';

let dataDir = '';
let binDir = '';
let fakeHome = '';
const savedHome = process.env.HOME;
const savedPath = process.env.PATH;

function plant(name: string, lines: string[]): string {
  const p = join(binDir, name);
  writeFileSync(p, ['#!/bin/sh', ...lines, ''].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'a2-api-data-'));
  binDir = mkdtempSync(join(tmpdir(), 'a2-api-bin-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'a2-api-home-'));
  process.env.HOME = fakeHome;
  process.env.PATH = binDir;
  resetBridgeUsageCache();
  resetCliIdentityCache();
  resetCliPathPins();
  resetBridgeConsent();
});

afterEach(() => {
  resetBridgeUsageCache();
  resetCliIdentityCache();
  resetCliPathPins();
  resetBridgeConsent();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

describe('A2 bridges in listProviders', () => {
  it('lists all five new bridges with account rows and honest null gauges', async () => {
    const infos = await listProviders(dataDir);
    for (const [providerId, bridge] of [
      ['copilot-subscription', 'copilot'],
      ['grok-subscription', 'grok'],
      ['kimi-subscription', 'kimi'],
      ['pi-subscription', 'pi'],
      ['hermes-subscription', 'hermes'],
    ] as const) {
      const info = infos.find((p) => p.id === providerId);
      expect(info, providerId).toBeDefined();
      expect(info!.bridge).toBe(bridge);
      expect(info!.detected).toBe(false); // bare machine: nothing planted
      expect(info!.connected).toBe(false);
      expect(info!.bridgeAccounts).toHaveLength(1);
      const acct = info!.bridgeAccounts![0]!;
      expect(acct.accountId).toBe('default');
      expect(acct.usage.utilisationPercent).toBeNull();
      expect(acct.usage.source).toBe('cli-unavailable');
      expect(acct.cooldown).toBeNull();
      expect(info!.models.length).toBeGreaterThan(0);
    }
    // The original three still list exactly as before.
    for (const providerId of ['claude-subscription', 'codex-subscription', 'opencode-subscription']) {
      expect(infos.find((p) => p.id === providerId)).toBeDefined();
    }
  });

  it('a planted grok shim + login detects, signs the account in, and Connect succeeds', async () => {
    plant('grok', ['echo "grok 0.1.0"', 'exit 0']);
    mkdirSync(join(fakeHome, '.grok'), { recursive: true });
    writeFileSync(join(fakeHome, '.grok', 'auth.json'), '{"token":"shape-only"}');
    const infos = await listProviders(dataDir);
    const grok = infos.find((p) => p.id === 'grok-subscription')!;
    expect(grok.detected).toBe(true);
    expect(grok.bridgeAccounts![0]!.signedIn).toBe(true);
    // New bridges expose no usage surface: even detected + signed in,
    // the gauge is the honest null (source no-surface).
    expect(grok.bridgeAccounts![0]!.usage.utilisationPercent).toBeNull();
    expect(grok.bridgeAccounts![0]!.usage.source).toBe('no-surface');

    connectBridge('grok');
    expect(isBridgeConnected('grok')).toBe(true);
    const infos2 = await listProviders(dataDir);
    expect(infos2.find((p) => p.id === 'grok-subscription')!.connected).toBe(true);

    // Manual re-check (A1) works for the new bridge id too.
    const state = recheckBridgeAccount(dataDir, 'grok');
    expect(state.accountId).toBe('default');
    expect(state.utilisationPercent).toBeNull();
  });

  it('a namesake grok shim makes Connect fail plainly instead of connecting a stranger', () => {
    plant('grok', [
      'echo "Traceback (most recent call last):"',
      'echo "ModuleNotFoundError: No module named x"',
      'exit 1',
    ]);
    mkdirSync(join(fakeHome, '.grok'), { recursive: true });
    writeFileSync(join(fakeHome, '.grok', 'auth.json'), '{"token":"shape-only"}');
    expect(() => connectBridge('grok')).toThrow(/isn't Grok CLI/);
    expect(isBridgeConnected('grok')).toBe(false);
  });

  it('CLI path pins (A8) accept a new bridge id and report a bad pin plainly', () => {
    const exe = plant('kimi', ['echo "kimi 1.2.0"', 'exit 0']);
    const ok = setStoredCliPathPin(dataDir, 'kimi', exe);
    expect(ok.cliPath).toBe(exe);
    expect(ok.cliPathError).toBeUndefined();
    const bad = setStoredCliPathPin(dataDir, 'kimi', join(binDir, 'no-such-kimi'));
    expect(bad.cliPathError).toMatch(/doesn't point to a file/);
    expect(() => setStoredCliPathPin(dataDir, 'nope', exe)).toThrow(/Unknown bridge/);
  });
});
