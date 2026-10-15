// SPDX-License-Identifier: Apache-2.0
// Tests for the subscription/CLI bridge (MausBot parity):
// - CLI detection with a fake HOME and PATH
// - consent gating (no consent -> token never resolves, even when the CLI is present)
// - credential loading from fake credential files
// - a chat turn through the bridged provider with mocked HTTP

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeConnectable,
  detectCliBridge,
  detectCliBridges,
  grantBridgeConsent,
  isBridgeConnected,
  loadBridgeToken,
  resetBridgeConsent,
  revokeBridgeConsent,
} from '../src/providers/cli-bridge.js';
import { resolveApiKey, getProviderPreset } from '../src/providers/catalog.js';
import { createProvider } from '../src/providers/factory.js';

const ENV_KEYS = ['HOME', 'PATH', 'PROVIDERS_FILE'];
let savedEnv: Record<string, string | undefined> = {};
let fakeHome: string;
let fakeBin: string;

function plantClaudeCredentials(home: string, token = 'sk-ant-oat01-test-token'): void {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'rt', expiresAt: 9999999999999 } }),
  );
}

function plantCodexCredentials(home: string, key = 'sk-test-codex-key'): void {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key }));
}

function plantCli(binDir: string, name: string): void {
  const p = join(binDir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  fakeHome = mkdtempSync(join(tmpdir(), 'bridge-home-'));
  fakeBin = mkdtempSync(join(tmpdir(), 'bridge-bin-'));
  process.env.HOME = fakeHome;
  process.env.PATH = fakeBin; // no claude/codex binaries unless planted
  process.env.PROVIDERS_FILE = join(tmpdir(), 'bridge-test-no-such-providers.json');
  resetBridgeConsent();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetBridgeConsent();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('detection', () => {
  it('detects nothing on a bare machine', () => {
    const found = detectCliBridges();
    expect(found).toHaveLength(2);
    expect(found.every((d) => d.detected === false)).toBe(true);
    expect(detectCliBridge('claude').credentialsPresent).toBe(false);
  });

  it('detects the Claude CLI from its credential file', () => {
    plantClaudeCredentials(fakeHome);
    const d = detectCliBridge('claude');
    expect(d.credentialsPresent).toBe(true);
    expect(d.cliPresent).toBe(false);
    expect(d.detected).toBe(true);
    expect(detectCliBridge('codex').detected).toBe(false);
  });

  it('detects the Codex CLI from its binary on PATH', () => {
    plantCli(fakeBin, 'codex');
    const d = detectCliBridge('codex');
    expect(d.cliPresent).toBe(true);
    expect(d.credentialsPresent).toBe(false);
    expect(d.detected).toBe(true);
  });

  it('accepts explicit homeDir/pathDirs overrides', () => {
    plantClaudeCredentials(fakeHome);
    const d = detectCliBridge('claude', { homeDir: '/nonexistent', pathDirs: [] });
    expect(d.detected).toBe(false);
  });
});

describe('consent gating', () => {
  it('no consent -> provider hidden even when the CLI is present', () => {
    plantClaudeCredentials(fakeHome);
    plantCodexCredentials(fakeHome);
    expect(detectCliBridge('claude').detected).toBe(true);
    expect(isBridgeConnected('claude')).toBe(false);
    expect(resolveApiKey('claude-subscription')).toBeUndefined();
    expect(resolveApiKey('codex-subscription')).toBeUndefined();
  });

  it('grant -> token resolves; revoke -> gone again', () => {
    plantClaudeCredentials(fakeHome, 'sk-ant-oat01-abc');
    grantBridgeConsent('claude');
    expect(isBridgeConnected('claude')).toBe(true);
    expect(resolveApiKey('claude-subscription')).toBe('sk-ant-oat01-abc');
    revokeBridgeConsent('claude');
    expect(isBridgeConnected('claude')).toBe(false);
    expect(resolveApiKey('claude-subscription')).toBeUndefined();
  });

  it('consent without a credential file still resolves nothing', () => {
    grantBridgeConsent('codex');
    expect(resolveApiKey('codex-subscription')).toBeUndefined();
  });

  it('bridge presets never fall back to env vars', () => {
    plantClaudeCredentials(fakeHome);
    process.env.CLAUDE_SUBSCRIPTION_TOKEN = 'env-should-not-win';
    grantBridgeConsent('claude');
    // The token comes from the CLI credential file, not the env var.
    expect(resolveApiKey('claude-subscription')).toBe('sk-ant-oat01-test-token');
    delete process.env.CLAUDE_SUBSCRIPTION_TOKEN;
  });
});

describe('credential loading', () => {
  it('reads the Claude OAuth token shape', () => {
    plantClaudeCredentials(fakeHome, 'sk-ant-oat01-x');
    grantBridgeConsent('claude');
    expect(loadBridgeToken('claude', fakeHome)).toBe('sk-ant-oat01-x');
  });

  it('reads the Codex API-key shape', () => {
    plantCodexCredentials(fakeHome, 'sk-codex-y');
    grantBridgeConsent('codex');
    expect(loadBridgeToken('codex', fakeHome)).toBe('sk-codex-y');
  });

  it('reads the Codex OAuth token shape', () => {
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'chatgpt-oauth-z' } }),
    );
    grantBridgeConsent('codex');
    expect(loadBridgeToken('codex', fakeHome)).toBe('chatgpt-oauth-z');
  });

  it('returns undefined for malformed credential files', () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.credentials.json'), 'not json{');
    grantBridgeConsent('claude');
    expect(loadBridgeToken('claude', fakeHome)).toBeUndefined();
  });
});

describe('bridgeConnectable', () => {
  it('reports not-ok when nothing is detected', () => {
    const r = bridgeConnectable('claude');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No Claude Code/i);
  });

  it('reports not-ok when the CLI exists but no login is stored', () => {
    plantCli(fakeBin, 'claude');
    const r = bridgeConnectable('claude');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no stored login/i);
  });

  it('reports ok when credentials are readable, without recording consent', () => {
    plantClaudeCredentials(fakeHome);
    const r = bridgeConnectable('claude');
    expect(r.ok).toBe(true);
    expect(isBridgeConnected('claude')).toBe(false);
  });
});

describe('bridged chat turn', () => {
  it('sends the subscription token as a Bearer credential with the oauth beta header', async () => {
    plantClaudeCredentials(fakeHome, 'sk-ant-oat01-chat');
    grantBridgeConsent('claude');

    const anthropicBody = JSON.stringify({
      content: [{ type: 'text', text: 'hello from subscription' }],
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(anthropicBody, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createProvider('claude-subscription');
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'claude-sonnet-4-5' });

    expect(result.content).toBe('hello from subscription');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-chat');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('codex-subscription uses the OpenAI-compatible Bearer driver', async () => {
    plantCodexCredentials(fakeHome, 'sk-codex-chat');
    grantBridgeConsent('codex');

    const sse = ['data: {"choices":[{"index":0,"delta":{"content":"yo"}}]}', '', 'data: [DONE]', ''].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createProvider('codex-subscription');
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-5' });

    expect(result.content).toBe('yo');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.openai.com');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-codex-chat');
  });

  it('createProvider throws a clear not-connected error without consent', () => {
    plantClaudeCredentials(fakeHome);
    expect(() => createProvider('claude-subscription')).toThrow(/not connected/i);
  });

  it('catalog exposes the bridge presets with the bridge flag', () => {
    expect(getProviderPreset('claude-subscription')?.bridge).toBe('claude');
    expect(getProviderPreset('codex-subscription')?.bridge).toBe('codex');
    expect(getProviderPreset('groq')?.bridge).toBeUndefined();
  });
});
