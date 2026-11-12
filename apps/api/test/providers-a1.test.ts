// SPDX-License-Identifier: Apache-2.0
// Timon parity A1 at the API layer:
// - GET /providers data (listProviders) carries per-account bridge
//   gauges + cooldown state: a CLI exposing no usage figure reports
//   utilisation null ("usage unknown"), never a fabricated zero.
// - A recorded cooldown (persisted at <dataDir>/bridge-state.json,
//   beside providers.local.json) is surfaced on the bridge's account row.
// - The manual re-check clears exhausted cooldowns but never a live
//   rate-limit window.
// Zero paid APIs: a fake `codex` shim on PATH prints canned status.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getBridgeCooldownRegistry,
  resetBridgeCooldownRegistry,
  resetBridgeUsageCache,
  resetCliIdentityCache,
} from '@mvp/agent-runtime';
import { listProviders, recheckBridgeAccount } from '../src/providers.js';

let dataDir = '';
let binDir = '';
let fakeHome = '';
const savedHome = process.env.HOME;
const savedPath = process.env.PATH;

function quotaErrorWithReset(resetMs: number): Error & { resetAt: string } {
  const e = new Error('Provider request failed: 429 — {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}') as Error & { resetAt: string };
  e.resetAt = new Date(resetMs).toISOString();
  return e;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'a1-api-data-'));
  binDir = mkdtempSync(join(tmpdir(), 'a1-api-bin-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'a1-api-home-'));
  const shim = join(binDir, 'codex');
  writeFileSync(shim, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.142.0"; exit 0; fi',
    'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  process.env.HOME = fakeHome;
  process.env.PATH = binDir;
  resetBridgeCooldownRegistry();
  resetBridgeUsageCache();
  resetCliIdentityCache();
});

afterEach(() => {
  resetBridgeCooldownRegistry();
  resetBridgeUsageCache();
  resetCliIdentityCache();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

describe('A1 bridge accounts in listProviders', () => {
  it('reports the honest null gauge + no cooldown for a detected bridge', async () => {
    const infos = await listProviders(dataDir);
    const codex = infos.find((p) => p.id === 'codex-subscription');
    expect(codex).toBeDefined();
    expect(codex!.bridgeAccounts).toHaveLength(1);
    const acct = codex!.bridgeAccounts![0]!;
    expect(acct.accountId).toBe('default');
    // Today's real `codex login status` carries no usage figure.
    expect(acct.usage.utilisationPercent).toBeNull();
    expect(acct.usage.resetAt).toBeNull();
    expect(acct.cooldown).toBeNull();
  });

  it('surfaces a persisted exhausted cooldown on the account row; re-check clears it', async () => {
    const registry = getBridgeCooldownRegistry(join(dataDir, 'bridge-state.json'));
    registry.recordFailure('codex', 'default', new Error('You are out of credits. Top up to continue.'));
    const infos = await listProviders(dataDir);
    const acct = infos.find((p) => p.id === 'codex-subscription')!.bridgeAccounts![0]!;
    expect(acct.cooldown?.family).toBe('exhausted');
    expect(acct.cooldown?.until).toBeNull();

    const state = recheckBridgeAccount(dataDir, 'codex');
    expect(state.cleared).toBe(true);
    expect(state.cooldown).toBeNull();
    const infos2 = await listProviders(dataDir);
    expect(infos2.find((p) => p.id === 'codex-subscription')!.bridgeAccounts![0]!.cooldown).toBeNull();
  });

  it('re-check does NOT clear a live rate_limit window', async () => {
    const registry = getBridgeCooldownRegistry(join(dataDir, 'bridge-state.json'));
    registry.recordFailure('codex', 'default', quotaErrorWithReset(Date.now() + 3_600_000));
    const state = recheckBridgeAccount(dataDir, 'codex');
    expect(state.cleared).toBe(false);
    expect(state.cooldown?.family).toBe('rate_limit');
    expect(state.cooldown?.until).not.toBeNull();
  });

  it('rejects an unknown bridge id on re-check', () => {
    expect(() => recheckBridgeAccount(dataDir, 'nope')).toThrow(/Unknown bridge/);
  });
});
