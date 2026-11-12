// SPDX-License-Identifier: Apache-2.0
// A6 at the API layer: bridge-account registry routes (CRUD, rename,
// set-default, removal semantics), per-account sign-in via the cli-auth
// flow (fake manager seam via the process-wide account store), bot
// bridge-account persistence, and the Providers surface carrying real
// account ids with per-account probe env. Zero paid APIs; temp dirs
// only, cleaned up per test.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getBridgeAccountStore,
  resetBridgeAccountStore,
  resetBridgeCooldownRegistry,
  resetBridgeUsageCache,
  resetCliIdentityCache,
  type BotConfig,
} from '@mvp/agent-runtime';
import {
  createBridgeAccountsRouter,
  loadBridgeAccountStore,
} from '../src/bridge-accounts-routes.js';
import { createCliAuthRouter } from '../src/cli-auth-routes.js';
import { applyBotModels, saveBotModel } from '../src/bot-models.js';
import { listProviders } from '../src/providers.js';

let dataDir: string;
let homeDir: string;
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';
const audits: Array<{ action: string }> = [];

const bots: BotConfig[] = [
  {
    id: 'bot-a',
    name: 'Bot A',
    description: '',
    systemPrompt: '',
    provider: 'claude-subscription',
    model: 'sonnet',
    skills: [],
    tools: [],
    mcpServers: [],
    bridgeAccounts: { claude: 'work-login' },
  },
];

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  audits.length = 0;
  resetBridgeAccountStore();
  resetBridgeCooldownRegistry();
  resetBridgeUsageCache();
  resetCliIdentityCache();
  dataDir = mkdtempSync(join(tmpdir(), 'a6-api-'));
  homeDir = mkdtempSync(join(tmpdir(), 'a6-api-home-'));
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createBridgeAccountsRouter({
      dataDir,
      bots,
      homeDir,
      audit: (action) => void audits.push({ action }),
    }),
  );
  await new Promise<void>((resolve) => {
    const s = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      server = s as unknown as { close(cb: () => void): void };
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  resetBridgeAccountStore();
});

describe('bridge account registry routes', () => {
  it('starts with only the machine default per bridge, isolatable with the honest OpenCode note', async () => {
    const { status, json } = await api('GET', '/api/bridge-accounts');
    expect(status).toBe(200);
    const bridges = json.bridges as Array<{ bridgeId: string; isolatable: boolean; isolationNote: string; accounts: Array<{ accountId: string; machineDefault: boolean }> }>;
    expect(bridges.map((b) => b.bridgeId)).toEqual(['claude', 'codex', 'opencode']);
    for (const b of bridges) {
      expect(b.isolatable).toBe(true);
      expect(b.accounts).toHaveLength(1);
      expect(b.accounts[0]!.accountId).toBe('default');
      expect(b.accounts[0]!.machineDefault).toBe(true);
    }
    expect(bridges.find((b) => b.bridgeId === 'opencode')!.isolationNote).toMatch(/NOT the login/);
  });

  it('add account: creates a managed config dir, persists, and the runtime store sees it', async () => {
    const { status, json } = await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Work Login' });
    expect(status).toBe(201);
    const account = json.account as { accountId: string; label: string; configDir: string; createdByUs: boolean; signedIn: boolean };
    expect(account.accountId).toBe('work-login');
    expect(account.createdByUs).toBe(true);
    expect(account.signedIn).toBe(false);
    expect(existsSync(account.configDir)).toBe(true);
    // Persisted to bridge-accounts.json and loaded into the shared store.
    expect(existsSync(join(dataDir, 'bridge-accounts.json'))).toBe(true);
    expect(getBridgeAccountStore().get('claude', 'work-login')?.label).toBe('Work Login');
    expect(loadBridgeAccountStore(dataDir).get('claude', 'work-login')?.configDir).toBe(account.configDir);
    expect(audits.map((a) => a.action)).toContain('bridge_accounts.created');
    const list = await api('GET', '/api/bridge-accounts');
    const claude = (list.json.bridges as Array<{ bridgeId: string; accounts: Array<{ accountId: string }> }>).find((b) => b.bridgeId === 'claude')!;
    expect(claude.accounts.map((a) => a.accountId)).toEqual(['default', 'work-login']);
  });

  it('two accounts sign in independently: a credential file in one dir does not sign in the other', async () => {
    const a = await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Work Login' });
    const b = await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Play Login' });
    const workDir = (a.json.account as { configDir: string }).configDir;
    const playDir = (b.json.account as { configDir: string }).configDir;
    // Simulate the CLI completing sign-in for WORK only.
    writeFileSync(join(workDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
    const list = await api('GET', '/api/bridge-accounts');
    const claude = (list.json.bridges as Array<{ bridgeId: string; accounts: Array<{ accountId: string; signedIn: boolean }> }>).find((x) => x.bridgeId === 'claude')!;
    const byId = new Map(claude.accounts.map((x) => [x.accountId, x.signedIn]));
    expect(byId.get('work-login')).toBe(true);
    expect(byId.get('play-login')).toBe(false);
    expect(byId.get('default')).toBe(false);
    void playDir;
  });

  it('rename + set-default + resolve for a bot', async () => {
    await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Work Login' });
    const renamed = await api('PATCH', '/api/bridge-accounts/claude/work-login', { label: 'Work (new)' });
    expect(renamed.status).toBe(200);
    expect((renamed.json.account as { label: string }).label).toBe('Work (new)');
    const def = await api('POST', '/api/bridge-accounts/claude/work-login/default');
    expect(def.status).toBe(200);
    expect(def.json.userDefault).toBe('work-login');
    // The bot names work-login itself → resolve returns it + its spawn env.
    const resolved = await api('GET', '/api/bridge-accounts/resolve/bot-a/claude');
    expect(resolved.status).toBe(200);
    expect((resolved.json.account as { accountId: string }).accountId).toBe('work-login');
    expect((resolved.json.spawnEnv as Record<string, string>).CLAUDE_CONFIG_DIR).toContain('work-login');
  });

  it('remove: machine default is unremovable (400); managed dir deleted only on explicit request', async () => {
    const del = await api('DELETE', '/api/bridge-accounts/claude/default');
    expect(del.status).toBe(400);
    expect(String(del.json.error)).toMatch(/cannot be removed/);

    const a = await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Work Login' });
    const dir = (a.json.account as { configDir: string }).configDir;
    // Without deleteConfigDir: registry entry gone, dir left in place.
    const r1 = await api('DELETE', '/api/bridge-accounts/claude/work-login');
    expect(r1.status).toBe(200);
    expect(r1.json.configDirDeleted).toBe(false);
    expect(String(r1.json.configDirNote)).toMatch(/NOT deleted/);
    expect(existsSync(dir)).toBe(true);
    expect(getBridgeAccountStore().get('claude', 'work-login')).toBeUndefined();

    // Recreate, then remove WITH the flag → dir deleted.
    await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Work Login' });
    const r2 = await api('DELETE', '/api/bridge-accounts/claude/work-login?deleteConfigDir=1');
    expect(r2.json.configDirDeleted).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('remove: a user-supplied external config dir is NEVER deleted, even with the flag', async () => {
    const external = mkdtempSync(join(tmpdir(), 'a6-external-'));
    const a = await api('POST', '/api/bridge-accounts', { bridgeId: 'codex', label: 'Ext', configDir: external });
    expect(a.status).toBe(201);
    expect((a.json.account as { createdByUs: boolean }).createdByUs).toBe(false);
    const r = await api('DELETE', '/api/bridge-accounts/codex/ext?deleteConfigDir=1');
    expect(r.json.configDirDeleted).toBe(false);
    expect(String(r.json.configDirNote)).toMatch(/never deletes those/);
    expect(existsSync(external)).toBe(true);
    rmSync(external, { recursive: true, force: true });
  });
});

describe('bot bridge-account persistence (bot-models)', () => {
  it('saveBotModel stores per-bridge picks, applies at boot, and clears per bridge', () => {
    const localBots: BotConfig[] = [
      { id: 'b1', name: 'B', description: '', systemPrompt: '', provider: 'claude-subscription', model: 'sonnet', skills: [], tools: [], mcpServers: [] },
    ];
    saveBotModel(dataDir, localBots, 'b1', undefined, undefined, {
      bridgeAccounts: { claude: 'work-login', codex: 'default' },
    });
    expect(localBots[0]!.bridgeAccounts).toEqual({ claude: 'work-login', codex: 'default' });
    // Boot application onto a fresh bot object.
    const fresh: BotConfig[] = [
      { id: 'b1', name: 'B', description: '', systemPrompt: '', provider: 'claude-subscription', model: 'sonnet', skills: [], tools: [], mcpServers: [] },
    ];
    applyBotModels(fresh, dataDir);
    expect(fresh[0]!.bridgeAccounts).toEqual({ claude: 'work-login', codex: 'default' });
    // Clear one bridge pick; the other survives.
    saveBotModel(dataDir, localBots, 'b1', undefined, undefined, { bridgeAccounts: { claude: null } });
    expect(localBots[0]!.bridgeAccounts).toEqual({ codex: 'default' });
    // Hostile keys are dropped by the sanitizer.
    saveBotModel(dataDir, localBots, 'b1', undefined, undefined, { bridgeAccounts: { evil: 'x' } });
    expect(localBots[0]!.bridgeAccounts).toEqual({ codex: 'default' });
  });
});

describe('cli-auth routes: per-account sign-in state', () => {
  it('status for one account probes ITS credential file; unknown account 404s; login for unknown account 404s', async () => {
    // Mount the cli-auth router on the same app shape the host uses.
    const app2 = express();
    app2.use(express.json());
    app2.use('/api/cli-auth', createCliAuthRouter());
    const srv = app2.listen(0);
    await new Promise<void>((r) => srv.once('listening', r));
    const base2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const a = await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Work Login' });
      const dir = (a.json.account as { configDir: string }).configDir;
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
      const res = await fetch(`${base2}/api/cli-auth/status?cliId=claude&accountId=work-login`);
      const json = (await res.json()) as { clis: Array<{ accountId: string; credentialsPresent: boolean; signedIn: boolean }> };
      expect(res.status).toBe(200);
      expect(json.clis[0]!.accountId).toBe('work-login');
      expect(json.clis[0]!.credentialsPresent).toBe(true);
      expect(json.clis[0]!.signedIn).toBe(true);
      const missing = await fetch(`${base2}/api/cli-auth/status?cliId=claude&accountId=nope`);
      expect(missing.status).toBe(404);
      const login = await fetch(`${base2}/api/cli-auth/claude/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'nope' }),
      });
      expect(login.status).toBe(404);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('providers surface carries real accounts', () => {
  it('listProviders lists the stored account with label/default flags and its own cooldown key space', async () => {
    await api('POST', '/api/bridge-accounts', { bridgeId: 'claude', label: 'Work Login' });
    await api('POST', '/api/bridge-accounts/claude/work-login/default');
    mkdirSync(join(dataDir), { recursive: true });
    const infos = await listProviders(dataDir);
    const claude = infos.find((p) => p.bridge === 'claude');
    expect(claude).toBeDefined();
    const accounts = claude!.bridgeAccounts ?? [];
    const ids = accounts.map((a) => a.accountId);
    expect(ids).toContain('default');
    expect(ids).toContain('work-login');
    const work = accounts.find((a) => a.accountId === 'work-login')!;
    expect(work.label).toBe('Work Login');
    expect(work.isUserDefault).toBe(true);
    expect(work.machineDefault).toBe(false);
    expect(work.signedIn).toBe(false);
    const def = accounts.find((a) => a.accountId === 'default')!;
    expect(def.machineDefault).toBe(true);
    expect(def.configDir).toBeNull();
  });
});
