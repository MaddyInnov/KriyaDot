// SPDX-License-Identifier: Apache-2.0
// Connected Apps registry + aggregate read model.
//
// Zero real network: the Composio client is an injected mock whose
// fixture catalog MUST include canva, whatsapp, instagram, linkedin and
// gmail — and deliberately EXCLUDES tiktok, proving an absent featured
// app is reported not_in_catalog rather than dressed up as connectable.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureVault } from '@mvp/vault';
import {
  FEATURED_APPS,
  buildConnectedAppsView,
  classifyConnectionNeed,
  connectedAppCapabilityFeatures,
  featuredAppDefinition,
  registerConnectedAppsRoutes,
  type ConnectedAppEntry,
  type ConnectedAppsDeps,
} from '../src/connected-apps.js';
import { COMPOSIO_KEY_NAME, type ComposioClient } from '../src/composio.js';
import { writeAccountCache } from '../src/composio-accounts.js';
import type { LazyMcpManager } from '@mvp/agent-runtime';

const OWNER_TOKEN = 'test-owner-token';
const VALID_KEY = 'ak_valid-test-key';
const USER = 'default-user';

const bots = [
  { id: 'bot-1', name: 'Helper' },
  { id: 'bot-2', name: 'Coder' },
] as unknown as ConnectedAppsDeps['bots'];

// Fixture catalog: canva, whatsapp, instagram, linkedin, gmail (+ one
// non-featured app, trello). tiktok is deliberately EXCLUDED.
const catalogApps = [
  { appId: 'canva', name: 'Canva', description: 'Design anything', categories: ['design'] },
  { appId: 'whatsapp', name: 'WhatsApp', description: 'Business messaging' },
  { appId: 'instagram', name: 'Instagram', description: 'Professional accounts' },
  { appId: 'linkedin', name: 'LinkedIn', description: 'Professional network' },
  { appId: 'gmail', name: 'Gmail', description: 'Read and send email' },
  { appId: 'trello', name: 'Trello', description: 'Boards and cards', categories: ['productivity'] },
];

const liveAccounts = [
  { id: 'ca_insta1', toolkitSlug: 'instagram', toolkitName: 'Instagram', status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ca_gmail1', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE', createdAt: '2026-01-02T00:00:00Z' },
  { id: 'ca_gmail2', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'EXPIRED', createdAt: '2026-01-03T00:00:00Z' },
];

function makeMockClient(overrides: Partial<ComposioClient> = {}): ComposioClient {
  return {
    validateApiKey: async (apiKey: string) => ({ ok: apiKey === VALID_KEY }),
    listApps: async () => catalogApps.map((a) => ({ ...a })),
    createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
    listConnectedAccounts: async () => liveAccounts.map((a) => ({ ...a })),
    getConnectedAccount: async () => null,
    deleteConnectedAccount: async () => {},
    revokeConnectedAccount: async () => {},
    listTools: async () => [],
    executeTool: async () => ({ successful: true }),
    ...overrides,
  };
}

function makeDeps(dir: string, overrides: Partial<ConnectedAppsDeps> = {}): ConnectedAppsDeps {
  return {
    config: { dataDir: dir } as unknown as ConnectedAppsDeps['config'],
    governance: { audit: vi.fn() } as unknown as ConnectedAppsDeps['governance'],
    bots,
    loopbackToken: OWNER_TOKEN,
    composioClient: makeMockClient(),
    ...overrides,
  };
}

function seedPlatformKey(dir: string): void {
  new SecureVault(dir, USER, USER).create(COMPOSIO_KEY_NAME, VALID_KEY, 'Composio API key (test)');
}

/** Seed enables + account-cache labels + a connected WhatsApp channel. */
function seedLocalState(dir: string): void {
  writeFileSync(
    join(dir, 'composio-enables.json'),
    JSON.stringify({ 'bot-1': { gmail: true, instagram: true, canva: false } }),
  );
  writeAccountCache(dir, USER, {
    ca_insta1: { toolkitSlug: 'instagram', status: 'ACTIVE', label: 'Creator account', firstSeenAt: 1, updatedAt: 1 },
    ca_gmail1: { toolkitSlug: 'gmail', status: 'ACTIVE', label: 'Work Gmail', firstSeenAt: 1, updatedAt: 1 },
    ca_gmail2: { toolkitSlug: 'gmail', status: 'EXPIRED', firstSeenAt: 1, updatedAt: 1 },
  });
  writeFileSync(
    join(dir, 'channel-connections.json'),
    JSON.stringify({
      connections: {
        whatsapp: { providerId: 'whatsapp', status: 'connected', connectedAt: '2026-01-05T00:00:00.000Z', settings: {} },
      },
    }),
  );
}

function byId(view: { apps: ConnectedAppEntry[] }, id: string): ConnectedAppEntry {
  const entry = view.apps.find((a) => a.id === id);
  if (!entry) throw new Error(`entry ${id} missing; got ${view.apps.map((a) => a.id).join(', ')}`);
  return entry;
}

describe('FEATURED_APPS definitions', () => {
  it('covers exactly the 16 required slugs with honest starter prompts', () => {
    expect(FEATURED_APPS.map((f) => f.slug).sort()).toEqual(
      [
        'canva', 'facebook', 'figma', 'github', 'gmail', 'googlecalendar', 'googledrive',
        'instagram', 'linkedin', 'notion', 'shopify', 'slack', 'tiktok', 'whatsapp',
        'youtube', 'zoom',
      ].sort(),
    );
    for (const f of FEATURED_APPS) {
      expect(f.capabilities.length).toBeGreaterThanOrEqual(2);
      expect(f.capabilities.length).toBeLessThanOrEqual(4);
      expect(f.starterTasks.length).toBeGreaterThanOrEqual(2);
      expect(f.starterTasks.length).toBeLessThanOrEqual(3);
      for (const task of f.starterTasks) {
        // Every starter prompt must route through real action discovery
        // and forbid invented actions.
        expect(task.prompt).toContain('composio_list_actions');
        expect(task.prompt).toContain('use only an action it returns');
      }
    }
    expect(featuredAppDefinition('CANVA')?.name).toBe('Canva');
  });

  it('whatsapp notes clearly distinguish Business/API use from personal use', () => {
    const wa = featuredAppDefinition('whatsapp');
    expect(wa?.notes).toContain('Business');
    expect(wa?.notes).toContain('not your personal WhatsApp account');
    expect(wa?.category).toBe('messaging');
  });

  it('featured categories match the required mapping', () => {
    const expected: Record<string, string> = {
      canva: 'design-media', whatsapp: 'messaging', instagram: 'social', linkedin: 'social',
      gmail: 'productivity', googlecalendar: 'productivity', googledrive: 'productivity',
      slack: 'messaging', github: 'development', notion: 'productivity', youtube: 'social',
      tiktok: 'social', facebook: 'social', figma: 'design-media', shopify: 'work', zoom: 'work',
    };
    for (const [slug, category] of Object.entries(expected)) {
      expect(featuredAppDefinition(slug)?.category, slug).toBe(category);
    }
  });
});

describe('classifyConnectionNeed (pure, precedence)', () => {
  const base = {
    platformConfigured: true, inCatalog: true, hasActiveAccount: true,
    enabledForBot: true, appSlug: 'gmail', appName: 'Gmail', botId: 'bot-1',
  };

  it('platform beats everything, with the setup href', () => {
    const need = classifyConnectionNeed({ ...base, platformConfigured: false, inCatalog: false, hasActiveAccount: false, enabledForBot: false });
    expect(need).toMatchObject({
      kind: 'platform_not_configured', appSlug: 'gmail', botId: 'bot-1',
      action: { type: 'setup_platform', href: '/accounts?app=gmail&setup=platform' },
    });
  });

  it('catalog beats account and enablement', () => {
    const need = classifyConnectionNeed({ ...base, inCatalog: false, hasActiveAccount: false, enabledForBot: false });
    expect(need).toMatchObject({
      kind: 'not_in_catalog',
      action: { type: 'open_connected_apps', href: '/accounts?app=gmail' },
    });
  });

  it('account beats enablement', () => {
    const need = classifyConnectionNeed({ ...base, hasActiveAccount: false, enabledForBot: false });
    expect(need).toMatchObject({
      kind: 'account_not_connected',
      action: { type: 'connect_app', href: '/accounts?app=gmail' },
    });
  });

  it('enablement is the last gate', () => {
    const need = classifyConnectionNeed({ ...base, enabledForBot: false });
    expect(need).toMatchObject({
      kind: 'not_enabled_for_bot',
      action: { type: 'enable_for_bot', href: '/accounts?app=gmail' },
    });
  });

  it('all gates passed → ready', () => {
    expect(classifyConnectionNeed(base)).toEqual({ kind: 'ready' });
  });
});

describe('connectedAppCapabilityFeatures', () => {
  it('covers featured slugs not already covered, with honest invoke text', () => {
    const features = connectedAppCapabilityFeatures();
    const slugs = features.map((f) => f.slug);
    // facebook / instagram / shopify are covered by composio-apps.ts.
    expect(slugs).not.toContain('composio-facebook');
    expect(slugs).not.toContain('composio-instagram');
    expect(slugs).not.toContain('composio-shopify');
    expect(slugs.sort()).toEqual(
      [
        'composio-canva', 'composio-figma', 'composio-github', 'composio-gmail',
        'composio-googlecalendar', 'composio-googledrive', 'composio-linkedin',
        'composio-notion', 'composio-slack', 'composio-tiktok', 'composio-whatsapp',
        'composio-youtube', 'composio-zoom',
      ].sort(),
    );
    for (const f of features) {
      expect(f.invoke.type).toBe('tool');
      expect(f.invoke.toolName).toBe('composio_call');
      expect(f.invoke.description).toContain('composio_list_actions');
      expect(f.invoke.description).toContain('approval-gated');
      expect(f.invoke.description).toContain('Connected Apps');
      expect(f.invoke.description).toContain('per-bot enablement');
    }
  });
});

describe('buildConnectedAppsView', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'connected-apps-'));
  });

  it('without a platform key: featured apps are needs_platform_setup, value still visible', async () => {
    const view = await buildConnectedAppsView(makeDeps(dir), USER);
    expect(view.platform).toEqual({ configured: false });
    const canva = byId(view, 'canva');
    expect(canva.status).toBe('needs_platform_setup');
    expect(canva.accounts).toEqual([]);
    expect(canva.capabilities.length).toBeGreaterThanOrEqual(2);
    expect(canva.starterTasks.length).toBeGreaterThanOrEqual(2);
    expect(byId(view, 'tiktok').status).toBe('needs_platform_setup');
    // No catalog entries leak in when the platform is not configured.
    expect(view.apps.find((a) => a.id === 'trello')).toBeUndefined();
    expect(view.generatedAt).toBeGreaterThan(0);
  });

  it('merges catalog, accounts (cache labels win), enables, and native channels', async () => {
    seedPlatformKey(dir);
    seedLocalState(dir);
    const view = await buildConnectedAppsView(
      makeDeps(dir, {
        sources: { localAppStatus: async () => ({ installed: true, version: '2.0' }) },
      }),
      USER,
    );
    expect(view.platform).toEqual({ configured: true });

    // canva: in catalog, no account → available, featured metadata merged.
    const canva = byId(view, 'canva');
    expect(canva).toMatchObject({ status: 'available', featured: true, source: 'composio', composioSlug: 'canva', category: 'design-media' });
    expect(canva.description).toBe('Design anything'); // catalog description wins for the entry body
    expect(canva.capabilities.length).toBeGreaterThanOrEqual(2);
    expect(canva.enabledBotIds).toEqual([]); // canva:false for bot-1

    // instagram: ACTIVE account → connected; cache label wins.
    const instagram = byId(view, 'instagram');
    expect(instagram.status).toBe('connected');
    expect(instagram.accounts).toEqual([{ id: 'ca_insta1', label: 'Creator account', status: 'ACTIVE' }]);
    expect(instagram.enabledBotIds).toEqual(['bot-1']);
    expect(instagram.capabilities).toContain('Publish media through your connected account');

    // linkedin: in catalog, featured, no account → available.
    expect(byId(view, 'linkedin')).toMatchObject({ status: 'available', featured: true, category: 'social' });

    // gmail: ACTIVE (one EXPIRED extra account does not change that);
    // enabled for bot-1 only.
    const gmail = byId(view, 'gmail');
    expect(gmail.status).toBe('connected');
    expect(gmail.accounts).toHaveLength(2);
    expect(gmail.accounts.find((a) => a.id === 'ca_gmail1')?.label).toBe('Work Gmail');
    expect(gmail.enabledBotIds).toEqual(['bot-1']);

    // trello: non-featured catalog app → plain entry, mapped category.
    const trello = byId(view, 'trello');
    expect(trello).toMatchObject({ source: 'composio', category: 'productivity', status: 'available' });
    expect(trello.featured).toBeUndefined();
    expect(trello.capabilities).toEqual([]);

    // Native channel: WhatsApp Cloud channel from channel-connections.json.
    const channel = byId(view, 'channel:whatsapp');
    expect(channel).toMatchObject({ name: 'WhatsApp (Business channel)', source: 'native', status: 'connected' });

    // Native OAuth: google present, not connected in a fresh data dir.
    expect(byId(view, 'oauth:google')).toMatchObject({ source: 'native', status: 'available' });

    // Phone: no devices paired in a fresh data dir → available.
    expect(byId(view, 'phone')).toMatchObject({ source: 'phone', status: 'available' });
  });

  it('whatsapp entry carries business-api / channel / desktop modes', async () => {
    seedPlatformKey(dir);
    seedLocalState(dir);
    const view = await buildConnectedAppsView(
      makeDeps(dir, {
        sources: { localAppStatus: async () => ({ installed: true, version: '2.0' }) },
      }),
      USER,
    );
    const wa = byId(view, 'whatsapp');
    expect(wa.status).toBe('available'); // in catalog, no ACTIVE account
    expect(wa.notes).toContain('not your personal WhatsApp account');
    const modes = Object.fromEntries((wa.modes ?? []).map((m) => [m.id, m]));
    expect(modes['business-api'].status).toBe('available');
    expect(modes['channel'].status).toBe('connected'); // native channel is connected
    expect(modes['desktop'].status).toBe('on_this_computer');
    expect(modes['desktop'].detail).toContain('2.0');
    expect(wa.local).toMatchObject({ installed: true, version: '2.0' });
  });

  it('whatsapp desktop mode falls back honestly when no source knows', async () => {
    seedPlatformKey(dir);
    seedLocalState(dir);
    const view = await buildConnectedAppsView(
      makeDeps(dir, { sources: { localAppStatus: async () => undefined } }),
      USER,
    );
    const desktop = byId(view, 'whatsapp').modes?.find((m) => m.id === 'desktop');
    // Whatever the PATH check finds on this machine, the status is one of
    // the two honest outcomes and the not-detected text carries the
    // uncertainty instead of claiming a definitive absence.
    expect(['on_this_computer', 'not_installed']).toContain(desktop?.status);
    if (desktop?.status === 'not_installed') {
      expect(desktop.detail).toContain('a bot can still try to open it');
    }
  });

  it('absent featured slug (tiktok) is not_in_catalog — never a fake connect state', async () => {
    seedPlatformKey(dir);
    seedLocalState(dir);
    const view = await buildConnectedAppsView(makeDeps(dir), USER);
    const tiktok = byId(view, 'tiktok');
    expect(tiktok.status).toBe('not_in_catalog');
    expect(tiktok.accounts).toEqual([]);
    // Its value proposition is still shown.
    expect(tiktok.capabilities.length).toBeGreaterThanOrEqual(2);
    // And every other featured slug absent from the fixture catalog too.
    for (const slug of ['facebook', 'figma', 'github', 'notion', 'youtube', 'zoom', 'slack', 'googlecalendar', 'googledrive']) {
      expect(byId(view, slug).status, slug).toBe('not_in_catalog');
    }
  });

  it('catalog failure: catalogError is reported and featured apps stay available', async () => {
    seedPlatformKey(dir);
    const failing = makeMockClient({
      listApps: async () => { throw new Error('backend down'); },
    });
    const view = await buildConnectedAppsView(makeDeps(dir, { composioClient: failing }), USER);
    expect(view.platform.configured).toBe(true);
    expect(view.platform.catalogError).toContain('backend down');
    expect(byId(view, 'canva').status).toBe('available');
    // Crucially, absence is NOT claimed when the catalog never loaded.
    expect(byId(view, 'tiktok').status).toBe('available');
    expect(view.apps.find((a) => a.id === 'trello')).toBeUndefined();
  });

  it('merges oauth / phone / mcp source overrides and appends local apps verbatim', async () => {
    seedPlatformKey(dir);
    const localEntry: ConnectedAppEntry = {
      id: 'local:obsidian', name: 'Obsidian', category: 'local', source: 'local',
      connectionType: 'local-app', status: 'on_this_computer', accounts: [],
      enabledBotIds: [], capabilities: ['Open local vaults'], starterTasks: [],
      local: { installed: true, version: '1.8' },
    };
    const fakeManager = {
      list: () => [
        { id: 'srv-1', label: 'filesystem', config: { kind: 'stdio' }, enabled: true, directoryId: null, createdAt: '2026-01-01T00:00:00Z' },
      ],
    } as unknown as LazyMcpManager;
    const view = await buildConnectedAppsView(
      makeDeps(dir, {
        lazyMcpManager: fakeManager,
        sources: {
          oauthStatuses: async () => [
            { id: 'google', name: 'Google (Gmail + Calendar)', connected: true, expiresAt: 123, hasRefreshToken: true },
          ],
          companionDevices: async () => [{ id: 'dev-1', name: 'Pixel 9', platform: 'android' }],
          localApps: async () => [localEntry],
          now: () => 4242,
        },
      }),
      USER,
    );
    expect(view.generatedAt).toBe(4242);
    expect(byId(view, 'oauth:google')).toMatchObject({ status: 'connected', source: 'native' });
    const phone = byId(view, 'phone');
    expect(phone).toMatchObject({ status: 'connected', source: 'phone' });
    expect(phone.accounts).toEqual([{ id: 'dev-1', label: 'Pixel 9', status: 'connected' }]);
    expect(byId(view, 'mcp:srv-1')).toMatchObject({ status: 'connected', source: 'mcp', name: 'filesystem' });
    // Verbatim: the exact object the blender supplied is in the view.
    expect(view.apps[view.apps.length - 1]).toBe(localEntry);
  });

  it('without an MCP manager there are no mcp entries', async () => {
    const view = await buildConnectedAppsView(makeDeps(dir), USER);
    expect(view.apps.some((a) => a.source === 'mcp')).toBe(false);
  });
});

describe('connected-apps routes', () => {
  let dir: string;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'connected-apps-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerConnectedAppsRoutes(router, makeDeps(dir));
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  async function call(path: string, auth = true) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: auth ? { authorization: `Bearer ${OWNER_TOKEN}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it('requires a verified principal (401 without one)', async () => {
    const { status } = await call('/connected-apps', false);
    expect(status).toBe(401);
  });

  it('GET /connected-apps returns the view; need reports platform first when unconfigured', async () => {
    const viewRes = await call('/connected-apps');
    expect(viewRes.status).toBe(200);
    const apps = viewRes.json.apps as ConnectedAppEntry[];
    expect(apps.find((a) => a.id === 'canva')?.status).toBe('needs_platform_setup');
    expect((viewRes.json.platform as { configured: boolean }).configured).toBe(false);

    const needRes = await call('/connected-apps/need?slug=gmail&botId=bot-1');
    expect(needRes.status).toBe(200);
    expect(needRes.json.need).toMatchObject({ kind: 'platform_not_configured', appSlug: 'gmail' });
  });

  it('need route walks the gates against live state and returns null when ready', async () => {
    seedPlatformKey(dir);
    seedLocalState(dir);

    // ready: gmail has an ACTIVE account and is enabled for bot-1.
    const ready = await call('/connected-apps/need?slug=gmail&botId=bot-1');
    expect(ready.status).toBe(200);
    expect(ready.json.need).toBeNull();

    // not enabled for bot-2.
    const notEnabled = await call('/connected-apps/need?slug=gmail&botId=bot-2');
    expect(notEnabled.json.need).toMatchObject({ kind: 'not_enabled_for_bot', botId: 'bot-2', appName: 'Gmail' });

    // no account for canva.
    const noAccount = await call('/connected-apps/need?slug=canva');
    expect(noAccount.json.need).toMatchObject({ kind: 'account_not_connected', appSlug: 'canva' });

    // tiktok is not in the fixture catalog.
    const notInCatalog = await call('/connected-apps/need?slug=tiktok');
    expect(notInCatalog.json.need).toMatchObject({ kind: 'not_in_catalog', appSlug: 'tiktok', appName: 'TikTok' });

    // the full view agrees with the need verdicts.
    const viewRes = await call('/connected-apps');
    const apps = viewRes.json.apps as ConnectedAppEntry[];
    expect(apps.find((a) => a.id === 'gmail')?.status).toBe('connected');
    expect(apps.find((a) => a.id === 'tiktok')?.status).toBe('not_in_catalog');
  });

  it('need route validates slug and botId', async () => {
    seedPlatformKey(dir);
    expect((await call('/connected-apps/need')).status).toBe(400);
    expect((await call('/connected-apps/need?slug=gmail&botId=nope')).status).toBe(404);
  });
});
