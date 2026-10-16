// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerComposioRoutes, COMPOSIO_KEY_NAME } from '../src/composio.js';
import type { ComposioClient } from '../src/composio.js';
import { SecureVault } from '@mvp/vault';

// Zero paid API usage: every Composio HTTP call goes through this mock.
const VALID_KEY = 'ak_valid-test-key';

const mockAccounts = [
  { id: 'ca_gmail1', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ca_slack1', toolkitSlug: 'slack', toolkitName: 'Slack', status: 'ACTIVE', createdAt: '2026-01-02T00:00:00Z' },
];

const mockTools: Record<string, Array<{ slug: string; name: string; description: string; inputParameters: Record<string, unknown> }>> = {
  gmail: [
    {
      slug: 'GMAIL_SEND_EMAIL',
      name: 'Send email',
      description: 'Send an email via Gmail',
      inputParameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      slug: 'GMAIL_LIST_MESSAGES',
      name: 'List messages',
      description: 'List Gmail messages',
      inputParameters: { type: 'object', properties: { max_results: { type: 'number' } } },
    },
  ],
  slack: [
    {
      slug: 'SLACK_SEND_MESSAGE',
      name: 'Send message',
      description: 'Send a Slack message',
      inputParameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
    },
  ],
};

/** Shared mock Composio client (zero paid API usage). Exported for the account/tool tests. */
export const mockComposioClient: ComposioClient = {
  validateApiKey: async (apiKey: string) => {
    if (apiKey === VALID_KEY) return { ok: true, orgName: 'Test Org' };
    return { ok: false };
  },
  listApps: async () => [
    { appId: 'gmail', name: 'Gmail', description: 'Read and send email' },
    { appId: 'slack', name: 'Slack', description: 'Post to channels' },
  ],
  createAuthLink: async (_apiKey, opts) => ({
    redirectUrl: `https://connect.composio.dev/link/${opts.toolkitSlug}?user=${opts.userId}`,
  }),
  listConnectedAccounts: async () => mockAccounts.map((a) => ({ ...a })),
  getConnectedAccount: async (_apiKey, nanoid) => {
    const found = mockAccounts.find((a) => a.id === nanoid);
    return found ? { ...found } : null;
  },
  deleteConnectedAccount: async (_apiKey, _nanoid) => {},
  revokeConnectedAccount: async (_apiKey, _nanoid) => {},
  listTools: async (_apiKey, toolkitSlug) =>
    (mockTools[toolkitSlug ?? ''] ?? []).map((t) => ({ ...t })),
  executeTool: async (_apiKey, input) => {
    if (input.toolSlug === 'GMAIL_SEND_EMAIL_FAIL') {
      return { successful: false, error: 'quota exceeded' };
    }
    return { successful: true, data: { echoed: input.args, via: input.connectedAccountId } };
  },
};

const mockClient: ComposioClient = mockComposioClient;

const bots = [{ id: 'bot-1', name: 'Helper' }, { id: 'bot-2', name: 'Coder' }] as unknown as import('../src/routes.js').RouteDeps['bots'];

describe('composio routes', () => {
  let dir: string;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  const audit = vi.fn();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'composio-'));
    audit.mockClear();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerComposioRoutes(router, {
      config: { dataDir: dir } as unknown as import('../src/config.js').AppConfig,
      governance: { audit } as unknown as import('@mvp/governance').GovernanceGateway,
      bots,
      composioClient: mockClient,
    });
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
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  function vaultHasKey(): boolean {
    return new SecureVault(dir, 'default-user', 'default-user').list().some((s) => s.name === COMPOSIO_KEY_NAME);
  }

  it('status is { connected: false } with no key configured', async () => {
    const { status, json } = await call('GET', '/composio/status');
    expect(status).toBe(200);
    expect(json).toEqual({ connected: false });
  });

  it('app list is graceful with no key configured (no 500)', async () => {
    const { status, json } = await call('GET', '/composio/apps');
    expect(status).toBe(200);
    expect(json).toEqual({ connected: false, apps: [] });
  });

  it('per-bot toggle without a key is a graceful 400 with connected:false', async () => {
    const { status, json } = await call('POST', '/composio/apps/gmail', { botId: 'bot-1', enabled: true });
    expect(status).toBe(400);
    expect(json.connected).toBe(false);
    expect(json.error).toBeTruthy();
  });

  it('connect rejects a missing/empty apiKey with 400', async () => {
    for (const body of [{}, { apiKey: '' }, { apiKey: '   ' }]) {
      const { status, json } = await call('POST', '/composio/connect', body);
      expect(status).toBe(400);
      expect(json.connected).toBe(false);
    }
    expect(vaultHasKey()).toBe(false);
  });

  it('connect rejects an invalid key with 401 and stores nothing', async () => {
    const { status, json } = await call('POST', '/composio/connect', { apiKey: 'ak_wrong' });
    expect(status).toBe(401);
    expect(json.connected).toBe(false);
    expect(vaultHasKey()).toBe(false);
    const { json: statusJson } = await call('GET', '/composio/status');
    expect(statusJson.connected).toBe(false);
  });

  it('connect validates, stores the key in the vault, and never returns it', async () => {
    const { status, json } = await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    expect(status).toBe(200);
    expect(json).toEqual({ connected: true });
    // The raw response must not contain the key value.
    expect(JSON.stringify(json)).not.toContain(VALID_KEY);
    expect(vaultHasKey()).toBe(true);
    const { json: statusJson } = await call('GET', '/composio/status');
    expect(statusJson).toEqual({ connected: true });
    expect(audit).toHaveBeenCalledWith(
      'composio.connected',
      expect.objectContaining({ toolName: 'composio' }),
    );
    // Audit detail must never carry the key.
    for (const c of audit.mock.calls) {
      expect(JSON.stringify(c)).not.toContain(VALID_KEY);
    }
  });

  it('reconnecting replaces the existing key without error', async () => {
    await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    const { status, json } = await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    expect(status).toBe(200);
    expect(json.connected).toBe(true);
  });

  it('lists apps once connected', async () => {
    await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    const { status, json } = await call('GET', '/composio/apps');
    expect(status).toBe(200);
    expect(json.connected).toBe(true);
    const apps = json.apps as { appId: string; name: string }[];
    expect(apps.map((a) => a.appId).sort()).toEqual(['gmail', 'slack']);
    expect(apps.map((a) => a.name)).toContain('Gmail');
  });

  it('enables an app per bot and reports it via ?botId', async () => {
    await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    const { status, json } = await call('POST', '/composio/apps/gmail', { botId: 'bot-1', enabled: true });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, botId: 'bot-1', appId: 'gmail', enabled: true });
    const { json: listed } = await call('GET', '/composio/apps?botId=bot-1');
    const apps = listed.apps as { appId: string; enabled: boolean }[];
    expect(apps.find((a) => a.appId === 'gmail')?.enabled).toBe(true);
    expect(apps.find((a) => a.appId === 'slack')?.enabled).toBe(false);
    // Independent per bot: bot-2 still disabled.
    const { json: listed2 } = await call('GET', '/composio/apps?botId=bot-2');
    expect((listed2.apps as { appId: string; enabled: boolean }[]).every((a) => a.enabled === false)).toBe(true);
  });

  it('disables an app per bot', async () => {
    await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    await call('POST', '/composio/apps/gmail', { botId: 'bot-1', enabled: true });
    const { status, json } = await call('POST', '/composio/apps/gmail', { botId: 'bot-1', enabled: false });
    expect(status).toBe(200);
    expect(json.enabled).toBe(false);
    const { json: listed } = await call('GET', '/composio/apps?botId=bot-1');
    expect((listed.apps as { appId: string; enabled: boolean }[]).every((a) => a.enabled === false)).toBe(true);
  });

  it('toggle validates botId, enabled, and appId', async () => {
    await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    const { status: s1 } = await call('POST', '/composio/apps/gmail', { botId: 'nope', enabled: true });
    expect(s1).toBe(404);
    const { status: s2 } = await call('POST', '/composio/apps/gmail', { botId: 'bot-1', enabled: 'yes' });
    expect(s2).toBe(400);
    const { status: s3 } = await call('POST', '/composio/apps/nope', { botId: 'bot-1', enabled: true });
    expect(s3).toBe(404);
  });

  it('disconnect forgets the key and degrades gracefully again', async () => {
    await call('POST', '/composio/connect', { apiKey: VALID_KEY });
    const { status, json } = await call('DELETE', '/composio/connect');
    expect(status).toBe(200);
    expect(json).toEqual({ connected: false });
    expect(vaultHasKey()).toBe(false);
    const { json: statusJson } = await call('GET', '/composio/status');
    expect(statusJson.connected).toBe(false);
    const { json: appsJson } = await call('GET', '/composio/apps');
    expect(appsJson).toEqual({ connected: false, apps: [] });
    // Idempotent: disconnecting twice is fine.
    const again = await call('DELETE', '/composio/connect');
    expect(again.status).toBe(200);
  });
});
