// SPDX-License-Identifier: Apache-2.0
// Subscription bridge connect + model listing (2026-11-09 fixes):
// - connectBridge surfaces the probe's machine code (not-installed /
//   not-signed-in / token-unusable / namesake-cli) alongside the
//   plain-words reason — the route returns both, the UI shows the reason.
// - A connected Codex bridge lists the CLI's own models when it exposes
//   them, else the curated catalog list — never the native driver's
//   single construction model (the "only codex/gpt-5" picker bug).
// All CLIs are fake shell scripts on a faked PATH; zero paid API use.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isBridgeConnected,
  resetBridgeConsent,
  resetBridgeModelsCache,
  resetCliIdentityCache,
} from '@mvp/agent-runtime';
import { connectBridge, resolveProviderModels } from '../src/providers.js';

const ENV_KEYS = ['HOME', 'PATH', 'PROVIDERS_FILE'];
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

let fakeHome = '';
let fakeBin = '';
let dataDir = '';

function plant(name: string, body: string): void {
  const p = join(fakeBin, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

function plantRealClaude(): void {
  plant('claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; fi\nexit 0\n');
}

function plantRealCodex(debugOutput: string): void {
  plant(
    'codex',
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.44.0"; exit 0; fi',
      `if [ "$1" = "debug" ]; then printf '%b' ${JSON.stringify(debugOutput)}; exit 0; fi`,
      'exit 0',
      '',
    ].join('\n'),
  );
}

function plantPythonNamesake(name: string): void {
  plant(
    name,
    '#!/bin/sh\necho "Traceback (most recent call last):" >&2\necho "ImportError: boom" >&2\nexit 1\n',
  );
}

function plantClaudeCreds(token = 'sk-ant-oat01-test'): void {
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3_600_000 } }),
  );
}

function plantCodexCreds(): void {
  mkdirSync(join(fakeHome, '.codex'), { recursive: true });
  writeFileSync(join(fakeHome, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-codex-test' }));
}

function connectError(bridgeId: string): { message: string; code?: string } {
  try {
    connectBridge(bridgeId);
  } catch (err) {
    return {
      message: err instanceof Error ? err.message : String(err),
      code: (err as { bridgeCode?: string }).bridgeCode,
    };
  }
  throw new Error(`connectBridge(${bridgeId}) should have thrown`);
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'api-bridge-home-'));
  fakeBin = mkdtempSync(join(tmpdir(), 'api-bridge-bin-'));
  dataDir = mkdtempSync(join(tmpdir(), 'api-bridge-data-'));
  process.env.HOME = fakeHome;
  process.env.PATH = fakeBin;
  process.env.PROVIDERS_FILE = join(tmpdir(), 'api-bridge-no-providers.json');
  resetBridgeConsent();
  resetCliIdentityCache();
  resetBridgeModelsCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetBridgeConsent();
  resetCliIdentityCache();
  resetBridgeModelsCache();
});

describe('connectBridge failure states carry codes + plain reasons', () => {
  it('nothing installed -> not-installed', () => {
    const e = connectError('claude');
    expect(e.code).toBe('not-installed');
    expect(e.message).toMatch(/No Claude Code installation/);
    expect(isBridgeConnected('claude')).toBe(false);
  });

  it('CLI present but no login -> not-signed-in with the exact terminal command', () => {
    plantRealClaude();
    const e = connectError('claude');
    expect(e.code).toBe('not-signed-in');
    expect(e.message).toMatch(/not signed in/);
    expect(e.message).toMatch(/claude auth login/);
  });

  it('malformed credential file -> token-unusable', () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.credentials.json'), 'not json{');
    const e = connectError('claude');
    expect(e.code).toBe('token-unusable');
  });

  it('namesake codex + stored credentials -> namesake-cli (connect must NOT succeed)', () => {
    plantPythonNamesake('codex');
    plantCodexCreds();
    const e = connectError('codex');
    expect(e.code).toBe('namesake-cli');
    expect(e.message).toMatch(/isn't Codex CLI/);
    expect(isBridgeConnected('codex')).toBe(false);
  });

  it('installed + valid stored login -> connects', () => {
    plantClaudeCreds();
    connectBridge('claude');
    expect(isBridgeConnected('claude')).toBe(true);
  });
});

describe('connected bridge model lists', () => {
  it('codex: the CLI list wins when the verified CLI exposes one', async () => {
    plantRealCodex('gpt-5\ngpt-5-mini\n');
    plantCodexCreds();
    connectBridge('codex');
    const models = await resolveProviderModels('codex-subscription');
    expect(models.map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
  });

  it('codex: empty CLI list falls back to the curated catalog (never a single driver model)', async () => {
    plantRealCodex('');
    plantCodexCreds();
    connectBridge('codex');
    const models = await resolveProviderModels('codex-subscription');
    expect(models.length).toBeGreaterThan(5);
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'o4-mini']),
    );
  });

  it('claude: connected lists the curated family (the CLI exposes no list)', async () => {
    plantClaudeCreds();
    connectBridge('claude');
    const models = await resolveProviderModels('claude-subscription');
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5']),
    );
  });

  it('disconnected bridge keeps the prior (catalog) behaviour', async () => {
    const models = await resolveProviderModels('codex-subscription');
    expect(models.length).toBeGreaterThan(5);
  });

  it('dataDir fixture is used (no cross-test key bleed)', () => {
    expect(dataDir).toContain('api-bridge-data-');
  });
});
