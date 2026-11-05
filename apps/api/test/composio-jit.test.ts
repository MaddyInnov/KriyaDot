// SPDX-License-Identifier: Apache-2.0
// Just-in-time connection data in composio_list_actions: when the bot
// asks about ONE toolkit (toolkitSlug), the tool answers with either the
// toolkit's actions (connectionStatus 'ready') or a connectionNeeded
// card naming exactly what stands in the way — instead of an empty,
// unexplained list. Without toolkitSlug the behavior is unchanged.
//
// Zero real network: the Composio client is an injected mock.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createComposioListActionsTool } from '../src/composio-tools.js';
import type { ComposioClient, ComposioConnectedAccount } from '../src/composio.js';
import type { ToolContext } from '@mvp/agent-runtime';

const CTX: ToolContext = { sessionId: 's1', botId: 'bot-1' };

function makeMockClient(overrides: Partial<ComposioClient> = {}) {
  const accounts = [
    { id: 'ca_canva1', toolkitSlug: 'canva', toolkitName: 'Canva', status: 'ACTIVE' },
    { id: 'ca_gmail1', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE' },
  ] as ComposioConnectedAccount[];
  const client: ComposioClient = {
    validateApiKey: async () => ({ ok: true }),
    // Catalog: canva + gmail + linkedin. tiktok deliberately absent.
    listApps: async () => [
      { appId: 'canva', name: 'Canva' },
      { appId: 'gmail', name: 'Gmail' },
      { appId: 'linkedin', name: 'LinkedIn' },
    ],
    createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
    listConnectedAccounts: async () => accounts.map((a) => ({ ...a })),
    getConnectedAccount: async () => null,
    deleteConnectedAccount: async () => {},
    revokeConnectedAccount: async () => {},
    listTools: async (_k, slug) =>
      slug === 'canva'
        ? [
            {
              slug: 'CANVA_EXPORT_DESIGN',
              name: 'Export design',
              description: 'Export a Canva design',
              inputParameters: { type: 'object', properties: {} },
            },
          ]
        : slug === 'gmail'
          ? [
              {
                slug: 'GMAIL_LIST_MESSAGES',
                name: 'List messages',
                description: 'List Gmail messages',
                inputParameters: { type: 'object', properties: {} },
              },
            ]
          : [],
    executeTool: async () => ({ successful: true }),
    ...overrides,
  };
  return { client, accounts };
}

describe('composio_list_actions just-in-time connection data', () => {
  let dir: string;
  let mock: ReturnType<typeof makeMockClient>;

  function makeTool(key: string | undefined, extra: object = {}) {
    return createComposioListActionsTool({
      dataDir: dir,
      getApiKey: () => key,
      client: mock.client,
      ...extra,
    });
  }

  function enable(botId: string, apps: Record<string, boolean>) {
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ [botId]: apps }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'composio-jit-'));
    mock = makeMockClient();
  });

  it('no API key + slug → platform connectionNeeded, legacy fields kept', async () => {
    const tool = makeTool(undefined);
    const result = (await tool.handler({ toolkitSlug: 'canva' }, CTX)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(false);
    expect(result.accounts).toEqual([]);
    expect(result.connectionNeeded).toMatchObject({
      kind: 'platform_not_configured',
      appSlug: 'canva',
      appName: 'Canva',
      botId: 'bot-1',
      action: { type: 'setup_platform', href: '/accounts?app=canva&setup=platform' },
    });
  });

  it('no API key, no slug → platform connectionNeeded for Composio apps with the bare setup href', async () => {
    const tool = makeTool(undefined);
    const result = (await tool.handler({}, CTX)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(false);
    expect(result.accounts).toEqual([]);
    expect(result.connectionNeeded).toMatchObject({
      kind: 'platform_not_configured',
      appSlug: '',
      appName: 'Composio apps',
      action: { type: 'setup_platform', href: '/accounts?setup=platform' },
    });
  });

  it('validates the toolkitSlug charset like other args', async () => {
    const tool = makeTool('k');
    await expect(tool.handler({ toolkitSlug: 'CANVA' }, CTX)).rejects.toThrow(/toolkitSlug/);
    await expect(tool.handler({ toolkitSlug: 'canva!' }, CTX)).rejects.toThrow(/toolkitSlug/);
    await expect(tool.handler({ toolkitSlug: 'a'.repeat(65) }, CTX)).rejects.toThrow(/toolkitSlug/);
  });

  it('slug absent from the catalog → not_in_catalog', async () => {
    const tool = makeTool('k');
    enable('bot-1', { tiktok: true });
    const result = (await tool.handler({ toolkitSlug: 'tiktok' }, CTX)) as Record<string, unknown>;
    expect(result.connected).toBe(true);
    expect(result.accounts).toEqual([]);
    expect(result.connectionNeeded).toMatchObject({
      kind: 'not_in_catalog',
      appSlug: 'tiktok',
      action: { type: 'open_connected_apps', href: '/accounts?app=tiktok' },
    });
    expect(result.connectionStatus).toBeUndefined();
  });

  it('in catalog but no account → account_not_connected', async () => {
    const tool = makeTool('k');
    enable('bot-1', { linkedin: true });
    const result = (await tool.handler({ toolkitSlug: 'linkedin' }, CTX)) as Record<string, unknown>;
    expect(result.accounts).toEqual([]);
    expect(result.connectionNeeded).toMatchObject({
      kind: 'account_not_connected',
      appSlug: 'linkedin',
      appName: 'LinkedIn',
      action: { type: 'connect_app', href: '/accounts?app=linkedin' },
    });
  });

  it('account connected but not enabled for the bot → not_enabled_for_bot', async () => {
    const tool = makeTool('k');
    enable('bot-1', { gmail: true }); // canva NOT enabled
    const result = (await tool.handler({ toolkitSlug: 'canva' }, CTX)) as Record<string, unknown>;
    expect(result.accounts).toEqual([]);
    expect(result.connectionNeeded).toMatchObject({
      kind: 'not_enabled_for_bot',
      appSlug: 'canva',
      botId: 'bot-1',
      action: { type: 'enable_for_bot', href: '/accounts?app=canva' },
    });
  });

  it('thread override excluding the slug also reads as not_enabled_for_bot', async () => {
    const tool = makeTool('k', { getThreadConnectorOverride: () => ['gmail'] });
    enable('bot-1', { canva: true, gmail: true });
    const result = (await tool.handler({ toolkitSlug: 'canva' }, CTX)) as Record<string, unknown>;
    expect(result.connectionNeeded).toMatchObject({ kind: 'not_enabled_for_bot', appSlug: 'canva' });
    expect(result.accounts).toEqual([]);
  });

  it('ready → actions for that toolkit only, connectionStatus ready, NO connectionNeeded', async () => {
    const tool = makeTool('k');
    enable('bot-1', { canva: true, gmail: true });
    const result = (await tool.handler({ toolkitSlug: 'canva' }, CTX)) as Record<string, unknown> & {
      accounts: Array<{ accountId: string; toolkitSlug: string; tools: Array<{ slug: string }> }>;
    };
    expect(result.connected).toBe(true);
    expect(result.connectionStatus).toBe('ready');
    expect('connectionNeeded' in result).toBe(false);
    // Gmail is also enabled with an ACTIVE account — the slug narrows to canva.
    expect(result.accounts.map((a) => a.accountId)).toEqual(['ca_canva1']);
    expect(result.accounts[0].tools.map((t) => t.slug)).toEqual(['CANVA_EXPORT_DESIGN']);
  });

  it('catalog lookup failure degrades honestly: benefit of the doubt + catalogCheck unavailable', async () => {
    mock = makeMockClient({
      listApps: async () => {
        throw new Error('catalog down');
      },
    });
    const tool = makeTool('k');
    enable('bot-1', { canva: true });
    const ready = (await tool.handler({ toolkitSlug: 'canva' }, CTX)) as Record<string, unknown>;
    expect(ready.connectionStatus).toBe('ready');
    expect(ready.catalogCheck).toBe('unavailable');
    expect('connectionNeeded' in ready).toBe(false);

    // And absence is never fabricated: an unknown slug with no account
    // reports the account gate, not not_in_catalog.
    const noAccount = (await tool.handler({ toolkitSlug: 'tiktok' }, CTX)) as Record<string, unknown>;
    expect(noAccount.catalogCheck).toBe('unavailable');
    expect(noAccount.connectionNeeded).toMatchObject({ kind: 'account_not_connected', appSlug: 'tiktok' });
  });

  it('account listing failure on the slug path throws, consistent with the no-slug path', async () => {
    mock = makeMockClient({
      listConnectedAccounts: async () => {
        throw new Error('accounts down');
      },
    });
    const tool = makeTool('k');
    await expect(tool.handler({ toolkitSlug: 'canva' }, CTX)).rejects.toThrow(/Could not list Composio accounts/);
  });

  it('no slug → behavior exactly as before (no JIT fields leak in)', async () => {
    const tool = makeTool('k');
    enable('bot-1', { gmail: true });
    const result = (await tool.handler({}, CTX)) as Record<string, unknown> & {
      accounts: Array<{ accountId: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.accounts.map((a) => a.accountId)).toEqual(['ca_gmail1']);
    expect('connectionNeeded' in result).toBe(false);
    expect('connectionStatus' in result).toBe(false);
    expect('catalogCheck' in result).toBe(false);
  });
});
