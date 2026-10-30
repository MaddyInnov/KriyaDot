// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerComposioRoutes } from '../src/composio.js';
import { registerComposioAccountRoutes } from '../src/composio-accounts.js';
const OWNER_TOKEN = 'test-owner-token'; // OPEN-1: requests authenticate with the loopback owner credential

import type { ComposioClient, ComposioConnectedAccount } from '../src/composio.js';

// Zero paid API usage: mutable mock so tests can simulate the OAuth
// completion (a new account appearing between two list calls).
const VALID_KEY = 'ak_valid-test-key';

function makeMockClient() {
  const state = {
    accounts: [
      { id: 'ca_gmail1', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' },
    ] as ComposioConnectedAccount[],
    revoked: [] as string[],
    deleted: [] as string[],
    links: [] as Array<{ toolkitSlug: string; userId: string; label?: string }>,
  };
  const client: ComposioClient = {
    validateApiKey: async (apiKey: string) =>
      apiKey === VALID_KEY ? { ok: true, orgName: 'Test Org' } : { ok: false },
    listApps: async () => [{ appId: 'gmail', name: 'Gmail' }],
    createAuthLink: async (_apiKey, opts) => {
      state.links.push({ ...opts });
      return { redirectUrl: `https://connect.example/link/${opts.toolkitSlug}` };
    },
    listConnectedAccounts: async () => state.accounts.map((a) => ({ ...a })),
    getConnectedAccount: async (_apiKey, nanoid) =>
      state.accounts.find((a) => a.id === nanoid) ?? null,
    deleteConnectedAccount: async (_apiKey, nanoid) => {
      // Mirror the production client: revoke first, then delete.
      state.revoked.push(nanoid);
      state.deleted.push(nanoid);
      state.accounts = state.accounts.filter((a) => a.id !== nanoid);
    },
    revokeConnectedAccount: async (_apiKey, nanoid) => {
      state.revoked.push(nanoid);
    },
    listTools: async (_apiKey, toolkitSlug) =>
      toolkitSlug === 'gmail'
        ? [
            {
              slug: 'GMAIL_SEND_EMAIL',
              name: 'Send email',
              description: 'Send an email',
              inputParameters: { type: 'object', properties: { to: { type: 'string' } } },
            },
          ]
        : [],
    executeTool: async () => ({ successful: true, data: {} }),
  };
  return { client, state };
}

const bots = [{ id: 'bot-1', name: 'Helper' }] as unknown as import('../src/routes.js').RouteDeps['bots'];

describe('composio account routes', () => {
  let dir: string;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  let mock: ReturnType<typeof makeMockClient>;
  const audit = vi.fn();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'composio-acct-'));
    audit.mockClear();
    mock = makeMockClient();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const deps = {
      config: { dataDir: dir } as unknown as import('../src/config.js').AppConfig,
      governance: { audit } as unknown as import('@mvp/governance').GovernanceGateway,
      bots,
      composioClient: mock.client,
      loopbackToken: OWNER_TOKEN,
    };
    registerComposioRoutes(router, deps);
    registerComposioAccountRoutes(router, deps);
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as {
        close(cb: () => void): void;
      };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  async function connect() {
    const { status } = await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    expect(status).toBe(200);
  }

  function enableApp(botId: string, appId: string) {
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ [botId]: { [appId]: true } }));
  }

  it('link requires a connected key', async () => {
    const { status, json } = await call('POST', '/composio/accounts/link', { toolkitSlug: 'gmail' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/not connected/i);
  });

  it('link validates the toolkit slug', async () => {
    await connect();
    const { status } = await call('POST', '/composio/accounts/link', { toolkitSlug: 'GMAIL!!' });
    expect(status).toBe(400);
  });

  it('link returns a redirect URL and records a pending flow', async () => {
    await connect();
    const { status, json } = await call('POST', '/composio/accounts/link', {
      toolkitSlug: 'gmail',
      label: 'work',
    });
    expect(status).toBe(200);
    expect(json.redirectUrl).toContain('https://connect.example/link/gmail');
    expect(mock.state.links).toHaveLength(1);
    expect(mock.state.links[0]).toMatchObject({ toolkitSlug: 'gmail', label: 'work' });

    const listed = await call('GET', '/composio/accounts');
    expect(listed.status).toBe(200);
    const pending = listed.json.pending as Array<{ toolkitSlug: string; label?: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolkitSlug: 'gmail', label: 'work' });
  });

  it('completing OAuth surfaces the new account and auto-applies the pending label', async () => {
    await connect();
    await call('POST', '/composio/accounts/link', { toolkitSlug: 'gmail', label: 'work' });
    // Simulate the user finishing OAuth at the provider.
    mock.state.accounts.push({
      id: 'ca_gmail2',
      toolkitSlug: 'gmail',
      toolkitName: 'Gmail',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    });
    const { status, json } = await call('GET', '/composio/accounts');
    expect(status).toBe(200);
    const accounts = json.accounts as Array<{ id: string; label?: string }>;
    expect(accounts.map((a) => a.id)).toContain('ca_gmail2');
    expect(accounts.find((a) => a.id === 'ca_gmail2')?.label).toBe('work');
    // Pending flow consumed.
    expect((json.pending as unknown[])).toHaveLength(0);
  });

  it('lists accounts merged with labels', async () => {
    await connect();
    const { status, json } = await call('GET', '/composio/accounts');
    expect(status).toBe(200);
    expect(json.connected).toBe(true);
    const accounts = json.accounts as Array<{ id: string; toolkitSlug: string; status: string }>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: 'ca_gmail1', toolkitSlug: 'gmail', status: 'ACTIVE' });
  });

  it('set label validates id and persists', async () => {
    await connect();
    const bad = await call('POST', '/composio/accounts/bad!!id/label', { label: 'x' });
    expect(bad.status).toBe(400);
    const missing = await call('POST', '/composio/accounts/ca_nope/label', { label: 'x' });
    expect(missing.status).toBe(404);
    const { status, json } = await call('POST', '/composio/accounts/ca_gmail1/label', { label: 'personal' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, id: 'ca_gmail1', label: 'personal' });
    const listed = await call('GET', '/composio/accounts');
    const accounts = listed.json.accounts as Array<{ id: string; label?: string }>;
    expect(accounts.find((a) => a.id === 'ca_gmail1')?.label).toBe('personal');
  });

  it('delete revokes at the provider, deletes, and audits', async () => {
    await connect();
    const { status, json } = await call('DELETE', '/composio/accounts/ca_gmail1');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, id: 'ca_gmail1' });
    expect(mock.state.revoked).toContain('ca_gmail1');
    expect(mock.state.deleted).toContain('ca_gmail1');
    expect(audit).toHaveBeenCalledWith(
      'composio.account_disconnected',
      expect.objectContaining({ detail: { accountId: 'ca_gmail1' } }),
    );
    const listed = await call('GET', '/composio/accounts');
    expect((listed.json.accounts as unknown[])).toHaveLength(0);
  });

  it('tools endpoint returns the toolkit catalog for the account', async () => {
    await connect();
    const { status, json } = await call('GET', '/composio/accounts/ca_gmail1/tools');
    expect(status).toBe(200);
    const tools = json.tools as Array<{ slug: string }>;
    expect(tools.map((t) => t.slug)).toContain('GMAIL_SEND_EMAIL');
    expect(json.account).toMatchObject({ id: 'ca_gmail1', toolkitSlug: 'gmail' });
  });

  it('tools endpoint enforces the per-bot enable toggle (403 when disabled)', async () => {
    await connect();
    const denied = await call('GET', '/composio/accounts/ca_gmail1/tools?botId=bot-1');
    expect(denied.status).toBe(403);
    enableApp('bot-1', 'gmail');
    const allowed = await call('GET', '/composio/accounts/ca_gmail1/tools?botId=bot-1');
    expect(allowed.status).toBe(200);
  });

  it('tools endpoint 404s unknown bots and accounts', async () => {
    await connect();
    enableApp('bot-1', 'gmail');
    const noBot = await call('GET', '/composio/accounts/ca_gmail1/tools?botId=nope');
    expect(noBot.status).toBe(404);
    const noAcct = await call('GET', '/composio/accounts/ca_nope/tools');
    expect(noAcct.status).toBe(404);
  });

  it('never exposes the API key in any account response', async () => {
    await connect();
    await call('POST', '/composio/accounts/link', { toolkitSlug: 'gmail' });
    const bodies = [
      await call('GET', '/composio/accounts'),
      await call('GET', '/composio/accounts/ca_gmail1/tools'),
    ];
    for (const { json } of bodies) {
      expect(JSON.stringify(json)).not.toContain(VALID_KEY);
    }
  });
});
