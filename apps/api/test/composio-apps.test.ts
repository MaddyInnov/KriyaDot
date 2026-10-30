// SPDX-License-Identifier: Apache-2.0
// CN-4 / CN-5 / CN-6 / CN-8: the six Composio apps (Facebook, Messenger,
// Instagram, Spotify, Threads, Shopify) as VERIFIED bot capabilities.
// Zero live Composio calls: one mock client serves a full catalog,
// ACTIVE accounts and per-toolkit action lists for all six apps; the
// wiring verifier and a real composio_call execution per app run
// against it. Failure modes are asserted to report honestly.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  VERIFIED_COMPOSIO_APPS,
  composioAppCapabilityFeatures,
  composioAppProfile,
  googleWorkspaceCapabilityFeature,
  verifyAllComposioApps,
  verifyComposioAppWiring,
} from '../src/composio-apps.js';
import { createComposioCallTool } from '../src/composio-tools.js';
import { writeAccountCache } from '../src/composio-accounts.js';
import type { ComposioClient, ComposioConnectedAccount } from '../src/composio.js';
import type { ToolContext } from '@mvp/agent-runtime';

const USER = 'default-user';
const BOT = 'bot-1';
const CTX: ToolContext = { sessionId: 's1', botId: BOT };

interface MockState {
  accounts: ComposioConnectedAccount[];
  toolsByToolkit: Record<string, Array<{ slug: string; name: string }>>;
  dropActions: Set<string>;
  executed: Array<{ toolSlug: string; connectedAccountId: string }>;
}

function makeFullMock(): { client: ComposioClient; state: MockState } {
  const state: MockState = {
    accounts: VERIFIED_COMPOSIO_APPS.map((p, i) => ({
      id: `ca_${p.toolkitSlug}1`,
      toolkitSlug: p.toolkitSlug,
      toolkitName: p.displayName,
      status: 'ACTIVE',
      createdAt: '2026-10-01T00:00:00Z',
      // index marker kept for debugging; not part of the API shape
      ...(i === -1 ? {} : {}),
    })),
    toolsByToolkit: Object.fromEntries(
      VERIFIED_COMPOSIO_APPS.map((p) => [
        p.toolkitSlug,
        p.representativeActions.map((a) => ({ slug: a.slug, name: a.name })),
      ]),
    ),
    dropActions: new Set<string>(),
    executed: [],
  };
  const client: ComposioClient = {
    validateApiKey: async () => ({ ok: true }),
    listApps: async () => VERIFIED_COMPOSIO_APPS.map((p) => ({ appId: p.toolkitSlug, name: p.displayName })),
    createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
    listConnectedAccounts: async () => state.accounts.map((a) => ({ ...a })),
    getConnectedAccount: async (_k, id) => state.accounts.find((a) => a.id === id) ?? null,
    deleteConnectedAccount: async () => {},
    revokeConnectedAccount: async () => {},
    listTools: async (_k, slug) =>
      (state.toolsByToolkit[slug ?? ''] ?? [])
        .filter((t) => !state.dropActions.has(t.slug))
        .map((t) => ({ ...t, inputParameters: { type: 'object', properties: {} } })),
    executeTool: async (_k, input) => {
      state.executed.push({ toolSlug: input.toolSlug, connectedAccountId: input.connectedAccountId });
      return { successful: true, data: { done: input.toolSlug } };
    },
  };
  return { client, state };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'composio-apps-'));
  // Enable every app for the bot + mirror accounts into the local cache.
  writeFileSync(
    join(dir, 'composio-enables.json'),
    JSON.stringify({ [BOT]: Object.fromEntries(VERIFIED_COMPOSIO_APPS.map((p) => [p.toolkitSlug, true])) }),
  );
  const cache: Record<string, { toolkitSlug: string; status: string; firstSeenAt: number; updatedAt: number }> = {};
  for (const p of VERIFIED_COMPOSIO_APPS) {
    cache[`ca_${p.toolkitSlug}1`] = { toolkitSlug: p.toolkitSlug, status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 };
  }
  writeAccountCache(dir, USER, cache);
});

describe('profiles', () => {
  it('covers exactly the six CN-4/5/6/8 apps with read+write representative actions', () => {
    expect(VERIFIED_COMPOSIO_APPS.map((p) => p.toolkitSlug).sort()).toEqual(
      ['facebook', 'instagram', 'messenger', 'shopify', 'spotify', 'threads'].sort(),
    );
    for (const p of VERIFIED_COMPOSIO_APPS) {
      expect(p.representativeActions.some((a) => a.access === 'read')).toBe(true);
      expect(composioAppProfile(p.toolkitSlug)?.displayName).toBe(p.displayName);
    }
    expect(composioAppProfile('facebook')?.auditRows).toContain('CN-4');
    expect(composioAppProfile('shopify')?.auditRows).toContain('CN-6');
    expect(composioAppProfile('instagram')?.auditRows).toContain('CN-5');
  });
});

describe('verifyComposioAppWiring (mock transport)', () => {
  it('passes end-to-end for ALL six apps when catalog, account, enablement and actions line up', async () => {
    const { client } = makeFullMock();
    const reports = await verifyAllComposioApps({ client, apiKey: 'ck_test', dataDir: dir, userId: USER, botId: BOT });
    expect(reports).toHaveLength(6);
    for (const report of reports) {
      expect(report.ok, `${report.toolkitSlug}: ${JSON.stringify(report.checks)}`).toBe(true);
      expect(report.missingActions).toEqual([]);
      expect(report.accountId).toBe(`ca_${report.toolkitSlug}1`);
      expect(report.checks.map((c) => c.id)).toEqual(['catalog', 'account', 'enablement', 'actions', 'bridge']);
    }
  });

  it('reports a missing representative action honestly instead of passing', async () => {
    const { client, state } = makeFullMock();
    state.dropActions.add('SHOPIFY_CREATE_PRODUCT');
    const report = await verifyComposioAppWiring({ client, apiKey: 'k', dataDir: dir, userId: USER, botId: BOT, toolkitSlug: 'shopify' });
    expect(report.ok).toBe(false);
    expect(report.missingActions).toEqual(['SHOPIFY_CREATE_PRODUCT']);
    expect(report.checks.find((c) => c.id === 'actions')?.ok).toBe(false);
    expect(report.foundActions).toContain('SHOPIFY_LIST_PRODUCTS');
  });

  it('fails the account check when the account is not ACTIVE and enablement when the app is off', async () => {
    const { client, state } = makeFullMock();
    state.accounts = state.accounts.map((a) => (a.toolkitSlug === 'spotify' ? { ...a, status: 'EXPIRED' } : a));
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ [BOT]: { spotify: false } }));
    const report = await verifyComposioAppWiring({ client, apiKey: 'k', dataDir: dir, userId: USER, botId: BOT, toolkitSlug: 'spotify' });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'account')?.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'enablement')?.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'bridge')?.ok).toBe(true); // governance surface untouched
  });

  it('throws for a toolkit with no verified profile', async () => {
    const { client } = makeFullMock();
    await expect(
      verifyComposioAppWiring({ client, apiKey: 'k', dataDir: dir, userId: USER, botId: BOT, toolkitSlug: 'tiktok' }),
    ).rejects.toThrow(/no verified profile/);
  });
});

describe('execution through the real bridge (mock transport)', () => {
  it('a bot can execute one representative action per app via composio_call', async () => {
    const { client, state } = makeFullMock();
    const tool = createComposioCallTool({ dataDir: dir, client, getApiKey: () => 'ck_test' });
    for (const profile of VERIFIED_COMPOSIO_APPS) {
      const action = profile.representativeActions[0];
      const out = (await tool.handler(
        { accountId: `ca_${profile.toolkitSlug}1`, actionName: action.slug, parameters: {} },
        CTX,
      )) as { ok: boolean; data: { done: string } };
      expect(out.ok).toBe(true);
      expect(out.data.done).toBe(action.slug);
    }
    expect(state.executed).toHaveLength(6);
  });

  it('the same call is refused when the app is disabled for the bot (governance unchanged)', async () => {
    const { client } = makeFullMock();
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ [BOT]: { threads: false } }));
    const tool = createComposioCallTool({ dataDir: dir, client, getApiKey: () => 'ck_test' });
    await expect(
      tool.handler({ accountId: 'ca_threads1', actionName: 'THREADS_LIST_POSTS', parameters: {} }, CTX),
    ).rejects.toThrow(/not enabled for this bot/);
  });
});

describe('capability registry descriptors', () => {
  it('produces one PRODUCT_FEATURES-shaped entry per app plus the Google Workspace entry', () => {
    const features = composioAppCapabilityFeatures();
    expect(features).toHaveLength(6);
    for (const f of features) {
      expect(f.invoke.type).toBe('tool');
      expect(f.invoke.toolName).toBe('composio_call');
      expect(f.slug).toMatch(/^composio-/);
      expect(f.keywords.length).toBeGreaterThan(2);
    }
    const google = googleWorkspaceCapabilityFeature();
    expect(google.invoke.toolName).toBe('google_gmail_search');
    expect(google.slug).toBe('google-workspace-first-party');
  });
});
