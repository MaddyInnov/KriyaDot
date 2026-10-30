// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketplaceInstaller, MarketplaceRegistry } from '@mvp/marketplace';
import {
  buildStoreCatalog,
  classifyStoreCategory,
  createStoreRouter,
  type StoreItemDTO,
} from '../src/store-routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', '..', '..', 'packages', 'marketplace', 'registry', 'registry.json');

describe('classifyStoreCategory', () => {
  it('maps real registry items into the taxonomy deterministically', () => {
    expect(
      classifyStoreCategory({
        name: 'Meeting Scribe',
        description: 'Turns rough meeting transcripts into structured notes.',
        tags: ['productivity', 'notes'],
        kind: 'bot',
      }),
    ).toBe('office');
    expect(
      classifyStoreCategory({
        name: 'Local Postgres',
        description: 'MCP server exposing a local Postgres database.',
        tags: ['data', 'mcp', 'database'],
        kind: 'mcp-server',
      }),
    ).toBe('code');
    expect(classifyStoreCategory({ name: 'X', description: 'nothing special' })).toBe('prod');
  });
});

describe('store router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let installer: MarketplaceInstaller;
  let registry: MarketplaceRegistry;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'store-routes-'));
    registry = MarketplaceRegistry.fromFile(REGISTRY);
    installer = new MarketplaceInstaller(join(dir, 'marketplace'));
    const app = express();
    app.use(express.json());
    app.use(
      '/api/store',
      createStoreRouter({
        registry,
        installer,
        listPlugins: () => [
          {
            id: 'notes-bridge',
            name: 'Notes Bridge',
            version: '0.2.0',
            description: 'Syncs meeting notes to an external service.',
            kinds: ['tool'],
            permissions: { network: true },
            enabled: true,
            sourceType: 'dir',
          },
        ],
        listUserSkills: () => [
          {
            name: 'standup-helper',
            description: 'Drafts a daily standup from notes.',
            version: '1.0.0',
            status: 'disabled',
            source: 'user',
          },
        ],
        listMcpDirectory: () => [
          {
            id: 'dir-fetch',
            name: 'Directory Fetch',
            description: 'Fetch web pages.',
            category: 'web',
            permissions: ['network'],
            installed: false,
          },
        ],
        installsByCreator: (creator) => (creator === 'mvp-labs' ? 5 : 0),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/store`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  async function get(path = ''): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, json: await res.json() };
  }

  it('merges marketplace + plugins + user skills + MCP directory into one catalog', async () => {
    const { status, json } = await get();
    expect(status).toBe(200);
    const body = json as { items: StoreItemDTO[]; featuredIds: string[] };
    const registryCount = registry.count();
    expect(body.items.length).toBe(registryCount + 3);
    const sources = new Set(body.items.map((i) => i.source));
    expect(sources).toEqual(new Set(['marketplace', 'plugin', 'user-skill', 'mcp-directory']));
    expect(body.items.map((i) => i.id)).toContain('plugin:plugin:notes-bridge');
  });

  it('stamps a taxonomy category + label on every item (aggregation layer, not the registry)', async () => {
    const { json } = await get();
    const { items } = json as { items: StoreItemDTO[] };
    const valid = new Set(['office', 'studio', 'design', 'code', 'biz', 'prod', 'sci-health']);
    for (const item of items) {
      expect(valid.has(item.category)).toBe(true);
      expect(item.categoryLabel.length).toBeGreaterThan(0);
    }
    expect(items.find((i) => i.sourceId === 'meeting-scribe')?.category).toBe('office');
    expect(items.find((i) => i.sourceId === 'sql-tuner')?.category).toBe('code');
  });

  it('reports installed state from the real installer layout', async () => {
    const before = buildStoreCatalog({ registry, installer });
    expect(before.find((i) => i.sourceId === 'meeting-scribe')?.installed).toBe(false);
    const entry = registry.getById('meeting-scribe')!;
    installer.install(entry);
    const after = buildStoreCatalog({ registry, installer });
    expect(after.find((i) => i.sourceId === 'meeting-scribe')?.installed).toBe(true);
    // Plugins are installed by definition; a disabled user skill is not.
    const viaHttp = (await get()).json as { items: StoreItemDTO[] };
    expect(viaHttp.items.find((i) => i.sourceId === 'notes-bridge')?.installed).toBe(true);
    expect(viaHttp.items.find((i) => i.sourceId === 'standup-helper')?.installed).toBe(false);
    expect(viaHttp.items.find((i) => i.sourceId === 'standup-helper')?.installVia).toBe('skill-enable');
  });

  it('ranks featured by creator installs, then trusted, with a stable cap', async () => {
    const { json } = await get();
    const body = json as { items: StoreItemDTO[]; featuredIds: string[] };
    expect(body.featuredIds.length).toBe(6);
    const featured = body.items.filter((i) => i.featured);
    expect(featured.map((i) => i.id).sort()).toEqual([...body.featuredIds].sort());
    // mvp-labs has the stubbed install lead → its free trusted bot leads.
    expect(featured.some((i) => i.publisher === 'mvp-labs')).toBe(true);
  });

  it('filters server-side by search text, category and kind', async () => {
    const byQ = (await get('?q=postgres')).json as { items: StoreItemDTO[] };
    expect(byQ.items.map((i) => i.sourceId)).toContain('postgres-local');
    expect(byQ.items.every((i) => `${i.name} ${i.description}`.toLowerCase().includes('postgres'))).toBe(
      true,
    );
    const office = (await get('?category=office')).json as { items: StoreItemDTO[] };
    expect(office.items.length).toBeGreaterThan(0);
    expect(office.items.every((i) => i.category === 'office')).toBe(true);
    const bots = (await get('?kind=bot')).json as { items: StoreItemDTO[] };
    expect(bots.items.length).toBeGreaterThan(0);
    expect(bots.items.every((i) => i.kind === 'bot')).toBe(true);
  });

  it('exposes only categories that have items', async () => {
    const { json } = await get('/categories');
    const { categories } = json as { categories: Array<{ id: string; count: number }> };
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.length).toBeLessThanOrEqual(7);
    expect(categories.every((c) => c.count > 0)).toBe(true);
  });

  it('keeps install routing descriptors pointed at the existing flows', async () => {
    const { json } = await get();
    const { items } = json as { items: StoreItemDTO[] };
    expect(items.find((i) => i.sourceId === 'postgres-local')?.installVia).toBe('marketplace');
    expect(items.find((i) => i.sourceId === 'dir-fetch')?.installVia).toBe('mcp-directory');
    expect(items.find((i) => i.sourceId === 'notes-bridge')?.installVia).toBe('plugin');
    const pg = items.find((i) => i.sourceId === 'postgres-local');
    expect(pg?.permissions.join(' ')).toMatch(/approval/i);
  });
});
