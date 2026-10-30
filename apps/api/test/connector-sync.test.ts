// SPDX-License-Identifier: Apache-2.0
// CN-10: per-connector background-sync toggle + reauth surfacing.
// The pane (permissions-pane.ts) has always persisted the toggle; these
// tests prove the sync-engine side now READS it: the gate functions, the
// engine (toggle off → sync never invoked; toggle on → runs; auth
// failure → reauth-needed state), Composio account-cache reauth
// derivation, the permissions-pane reauth fields, and the routes.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectorSyncEngine,
  deriveComposioReauth,
  getSyncState,
  isAuthError,
  isBackgroundSyncEnabled,
  listReauthNeeded,
  registerConnectorSyncRoutes,
  resolveChannelSyncEnabled,
} from '../src/connector-sync.js';
import {
  composioReauthByToolkit,
  registerPermissionsPaneRoutes,
  writeConnectorSetting,
} from '../src/permissions-pane.js';
import { writeAccountCache } from '../src/composio-accounts.js';
import type { BotConfig } from '@mvp/agent-runtime';

const OWNER_TOKEN = 'connector-sync-test-token';
const USER = 'default-user';
const BOTS = [{ id: 'bot-1', name: 'Helper', tools: [] }] as unknown as BotConfig[];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connector-sync-'));
});

function setToggle(botId: string, connectorId: string, on: boolean): void {
  writeConnectorSetting(dir, USER, botId, connectorId, { groups: {}, backgroundSync: on });
}

describe('the gate (pane store → engine read)', () => {
  it('defaults OFF and follows the pane toggle exactly', () => {
    expect(isBackgroundSyncEnabled(dir, USER, 'bot-1', 'gmail')).toBe(false);
    setToggle('bot-1', 'gmail', true);
    expect(isBackgroundSyncEnabled(dir, USER, 'bot-1', 'gmail')).toBe(true);
    setToggle('bot-1', 'gmail', false);
    expect(isBackgroundSyncEnabled(dir, USER, 'bot-1', 'gmail')).toBe(false);
    // Per-bot isolation: another bot's toggle does not leak.
    setToggle('bot-2', 'gmail', true);
    expect(isBackgroundSyncEnabled(dir, USER, 'bot-1', 'gmail')).toBe(false);
  });

  it('channel gate: unset → legacy default; explicit all-off → stopped; any-on → running', () => {
    expect(resolveChannelSyncEnabled(dir, USER, 'email', { legacyDefaultWhenUnset: true })).toBe(true);
    expect(resolveChannelSyncEnabled(dir, USER, 'email')).toBe(false);
    setToggle('bot-1', 'email', false);
    expect(resolveChannelSyncEnabled(dir, USER, 'email', { legacyDefaultWhenUnset: true })).toBe(false);
    setToggle('bot-2', 'email', true);
    expect(resolveChannelSyncEnabled(dir, USER, 'email', { legacyDefaultWhenUnset: true })).toBe(true);
  });
});

describe('ConnectorSyncEngine', () => {
  it('background tick does NOT invoke sync while the toggle is off', async () => {
    const sync = vi.fn(async () => ({ items: 3 }));
    const engine = new ConnectorSyncEngine({ dataDir: dir });
    engine.registerTarget({ connectorId: 'gmail', sync });
    const states = await engine.runBackgroundTick(USER, 'bot-1');
    expect(sync).not.toHaveBeenCalled();
    expect(states[0].status).toBe('skipped-disabled');
    setToggle('bot-1', 'gmail', true);
    const after = await engine.runBackgroundTick(USER, 'bot-1');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(after[0].status).toBe('ok');
    expect(after[0].lastOkAt).toBeTypeOf('number');
  });

  it('manual run bypasses the toggle but is recorded', async () => {
    const sync = vi.fn(async () => {});
    const engine = new ConnectorSyncEngine({ dataDir: dir });
    engine.registerTarget({ connectorId: 'slack', sync });
    const state = await engine.runManual(USER, 'bot-1', 'slack');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('ok');
    expect(getSyncState(dir, USER, 'bot-1', 'slack').totalRuns).toBe(1);
    await expect(engine.runManual(USER, 'bot-1', 'nope')).rejects.toThrow(/no sync target/);
  });

  it('an auth failure flips the connector to reauth-needed and surfaces it', async () => {
    const engine = new ConnectorSyncEngine({ dataDir: dir });
    engine.registerTarget({
      connectorId: 'gmail',
      sync: async () => {
        throw new Error('HTTP 401: token expired');
      },
    });
    setToggle('bot-1', 'gmail', true);
    const [state] = await engine.runBackgroundTick(USER, 'bot-1');
    expect(state.status).toBe('reauth-needed');
    expect(state.reauthNeeded).toBe(true);
    const reauth = listReauthNeeded(dir, USER, 'bot-1');
    expect(reauth.some((r) => r.connectorId === 'gmail' && r.source === 'sync-state')).toBe(true);
    // A later success clears the flag.
    engine.registerTarget({ connectorId: 'gmail', sync: async () => {} });
    const [fixed] = await engine.runBackgroundTick(USER, 'bot-1');
    expect(fixed.reauthNeeded).toBe(false);
    expect(listReauthNeeded(dir, USER, 'bot-1').some((r) => r.source === 'sync-state')).toBe(false);
  });

  it('a non-auth failure is recorded as error, not reauth', async () => {
    const engine = new ConnectorSyncEngine({ dataDir: dir });
    engine.registerTarget({
      connectorId: 'drive',
      sync: async () => {
        throw new Error('HTTP 500: backend exploded');
      },
    });
    const state = await engine.runManual(USER, 'bot-1', 'drive');
    expect(state.status).toBe('error');
    expect(state.reauthNeeded).toBe(false);
    expect(state.consecutiveFailures).toBe(1);
  });
});

describe('reauth derivation from the Composio account cache', () => {
  it('flags non-ACTIVE accounts per toolkit; ACTIVE accounts are silent', () => {
    writeAccountCache(dir, USER, {
      ca_1: { toolkitSlug: 'gmail', status: 'EXPIRED', firstSeenAt: 1, updatedAt: 1 },
      ca_2: { toolkitSlug: 'slack', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
      ca_3: { toolkitSlug: 'gmail', status: 'INACTIVE', firstSeenAt: 1, updatedAt: 1 },
    });
    const entries = deriveComposioReauth(dir, USER);
    expect(entries.map((e) => e.accountId).sort()).toEqual(['ca_1', 'ca_3']);
    expect(entries[0].reason).toMatch(/reconnect/i);
    const byToolkit = composioReauthByToolkit(dir, USER);
    expect(byToolkit.has('gmail')).toBe(true);
    expect(byToolkit.has('slack')).toBe(false);
  });

  it('isAuthError recognizes status codes and OAuth error shapes', () => {
    expect(isAuthError(Object.assign(new Error('nope'), { status: 401 }))).toBe(true);
    expect(isAuthError(new Error('invalid_grant: refresh token revoked'))).toBe(true);
    expect(isAuthError(new Error('HTTP 500'))).toBe(false);
  });
});

describe('routes + pane surfacing', () => {
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function mount(engine: ConnectorSyncEngine): Promise<void> {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerConnectorSyncRoutes(router, { dataDir: dir, engine, bots: BOTS, loopbackToken: OWNER_TOKEN });
    registerPermissionsPaneRoutes(router, { dataDir: dir, bots: BOTS, loopbackToken: OWNER_TOKEN });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api`;
        resolve();
      });
    });
  }

  const auth = { authorization: `Bearer ${OWNER_TOKEN}` };

  it('GET /connector-sync/states merges toggles, engine state and reauth', async () => {
    writeAccountCache(dir, USER, {
      ca_9: { toolkitSlug: 'shopify', status: 'EXPIRED', firstSeenAt: 1, updatedAt: 1 },
    });
    setToggle('bot-1', 'gmail', true);
    const engine = new ConnectorSyncEngine({ dataDir: dir });
    engine.registerTarget({ connectorId: 'gmail', sync: async () => {} });
    await mount(engine);
    const res = await fetch(`${baseUrl}/connector-sync/states?botId=bot-1`, { headers: auth });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      connectors: Array<{ connectorId: string; backgroundSyncEnabled: boolean; syncImplemented: boolean }>;
      reauthNeeded: Array<{ connectorId: string; source: string }>;
    };
    const gmail = json.connectors.find((c) => c.connectorId === 'gmail');
    expect(gmail).toMatchObject({ backgroundSyncEnabled: true, syncImplemented: true });
    expect(json.reauthNeeded.some((r) => r.connectorId === 'shopify' && r.source === 'composio-account')).toBe(true);
  });

  it('POST /connector-sync/run executes a manual sync; unknown target 404s', async () => {
    const sync = vi.fn(async () => {});
    const engine = new ConnectorSyncEngine({ dataDir: dir });
    engine.registerTarget({ connectorId: 'gmail', sync });
    await mount(engine);
    const ok = await fetch(`${baseUrl}/connector-sync/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId: 'gmail', botId: 'bot-1' }),
    });
    expect(ok.status).toBe(200);
    expect(sync).toHaveBeenCalledTimes(1);
    const missing = await fetch(`${baseUrl}/connector-sync/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId: 'nope', botId: 'bot-1' }),
    });
    expect(missing.status).toBe(404);
  });

  it('the permissions pane connector list carries reauthNeeded for Composio apps', async () => {
    // Seed the enablement store so 'gmail' appears as a pane connector.
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ 'bot-1': { gmail: true } }));
    writeAccountCache(dir, USER, {
      ca_5: { toolkitSlug: 'gmail', status: 'EXPIRED', firstSeenAt: 1, updatedAt: 1 },
    });
    const engine = new ConnectorSyncEngine({ dataDir: dir });
    await mount(engine);
    const res = await fetch(`${baseUrl}/permissions/connectors?botId=bot-1`, { headers: auth });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { connectors: Array<{ id: string; reauthNeeded: boolean; reauthReason?: string }> };
    const gmail = json.connectors.find((c) => c.id === 'gmail');
    expect(gmail?.reauthNeeded).toBe(true);
    expect(gmail?.reauthReason).toMatch(/EXPIRED/);
    const email = json.connectors.find((c) => c.id === 'email');
    expect(email?.reauthNeeded).toBe(false);
  });
});
