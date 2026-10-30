// SPDX-License-Identifier: Apache-2.0
// Tests for the unified Store catalog helpers (ADD-1): the deterministic
// category classifier, the client-side merge of the existing feeds,
// search/category filtering, featured ordering, and install routing.

import { describe, expect, it } from 'vitest';
import {
  classifyStoreCategory,
  featuredItems,
  filterStoreItems,
  groupByCategory,
  installDescriptorFor,
  mergeStoreCatalog,
  visibleCategories,
  type StoreItem,
} from './store-catalog';

describe('classifyStoreCategory', () => {
  it('classifies clear cases from name + description + tags', () => {
    expect(
      classifyStoreCategory({
        name: 'Meeting Scribe',
        description: 'Turns meeting transcripts into structured notes.',
        tags: ['productivity', 'notes'],
        kind: 'bot',
      }),
    ).toBe('office');
    expect(
      classifyStoreCategory({
        name: 'SQL Tuner',
        description: 'Reviews SQL queries and suggests indexes.',
        tags: ['data', 'sql'],
        kind: 'bot',
      }),
    ).toBe('code');
    expect(
      classifyStoreCategory({
        name: 'Data Visualization',
        description: 'Choosing the right chart and keeping it honest.',
        tags: ['data', 'charts'],
        kind: 'skill',
      }),
    ).toBe('design');
    expect(
      classifyStoreCategory({
        name: 'Expense parser',
        description: 'Parse expenses from notes into a CSV ledger.',
        tags: ['finance', 'data'],
        kind: 'workflow',
      }),
    ).toBe('biz');
    expect(
      classifyStoreCategory({
        name: 'Clinic Intake',
        description: 'Patient intake for a medical clinic.',
        tags: ['health'],
        kind: 'bot',
      }),
    ).toBe('sci-health');
    expect(
      classifyStoreCategory({
        name: 'Blog Posts',
        description: 'Structure and voice for writing a blog.',
        tags: ['writing', 'blog'],
        kind: 'skill',
      }),
    ).toBe('studio');
  });

  it('weighs keyword hits instead of first-match (PDF beats a lone data tag)', () => {
    expect(
      classifyStoreCategory({
        name: 'PDF Processing',
        description: 'Extract text and tables from PDF documents reliably.',
        tags: ['data', 'documents'],
        kind: 'skill',
      }),
    ).toBe('office');
  });

  it('honours an explicit category that names a Store category', () => {
    expect(
      classifyStoreCategory({ name: 'X', description: 'git git git', explicitCategory: 'Office' }),
    ).toBe('office');
    expect(
      classifyStoreCategory({ name: 'X', description: '', explicitCategory: 'productivity' }),
    ).toBe('prod');
  });

  it('is deterministic and falls back to prod', () => {
    const input = { name: 'Thing', description: 'A plain helper.' };
    expect(classifyStoreCategory(input)).toBe('prod');
    expect(classifyStoreCategory(input)).toBe(classifyStoreCategory(input));
  });
});

const catalog: StoreItem[] = mergeStoreCatalog({
  marketplace: [
    {
      id: 'meeting-scribe',
      kind: 'bot',
      name: 'Meeting Scribe',
      version: '1.0.0',
      creator: 'mvp-labs',
      description: 'Structured meeting notes from transcripts.',
      license: 'Apache-2.0',
      priceCents: 0,
      tags: ['productivity', 'notes'],
      untrusted: false,
      payload: { tools: ['web_search'], skills: [], mcpServers: [] },
    },
    {
      id: 'sql-tuner',
      kind: 'bot',
      name: 'SQL Tuner',
      version: '1.0.0',
      creator: 'dataforge',
      description: 'Reviews SQL queries for performance.',
      license: 'MIT',
      priceCents: 499,
      tags: ['data', 'sql'],
      untrusted: true,
    },
    {
      id: 'postgres-local',
      kind: 'mcp-server',
      name: 'Local Postgres',
      version: '1.0.0',
      creator: 'dataforge',
      description: 'MCP server exposing a local Postgres database.',
      license: 'MIT',
      priceCents: 0,
      tags: ['data', 'mcp', 'database'],
      untrusted: true,
      payload: { command: 'npx', requiredEnv: ['POSTGRES_URL'] },
    },
  ],
  plugins: [
    {
      id: 'notes-plugin',
      name: 'Notes Bridge',
      version: '0.2.0',
      description: 'Syncs meeting notes to an external service.',
      kinds: ['tool'],
      permissions: { network: true },
      enabled: true,
      sourceType: 'dir',
    },
  ],
  userSkills: [
    {
      name: 'csv-cleaning',
      description: 'Tidy messy CSV files.',
      version: '1.0.0',
      status: 'disabled',
      source: 'user',
    },
    {
      name: 'active-helper',
      description: 'Helps with git commits.',
      version: '1.0.0',
      status: 'active',
      source: 'user',
    },
  ],
  mcpDirectory: [
    {
      id: 'fetch-dir',
      name: 'Web Fetch',
      description: 'Fetch web pages as markdown.',
      category: 'web',
      permissions: ['network'],
      installed: true,
    },
    {
      id: 'fs-dir',
      name: 'Filesystem',
      description: 'Scoped file access.',
      category: 'files',
      permissions: ['filesystem'],
      installed: false,
    },
  ],
});

describe('mergeStoreCatalog', () => {
  it('merges all four feeds into one catalog with namespaced ids', () => {
    expect(catalog).toHaveLength(3 + 1 + 2 + 2);
    expect(catalog.map((i) => i.id)).toContain('marketplace:bot:meeting-scribe');
    expect(catalog.map((i) => i.id)).toContain('plugin:plugin:notes-plugin');
    expect(catalog.map((i) => i.id)).toContain('user-skill:skill:csv-cleaning');
    expect(catalog.map((i) => i.id)).toContain('mcp-directory:mcp-server:fs-dir');
  });

  it('gives every item a category from the taxonomy', () => {
    const valid = new Set(['office', 'studio', 'design', 'code', 'biz', 'prod', 'sci-health']);
    for (const item of catalog) {
      expect(valid.has(item.category)).toBe(true);
      expect(item.categoryLabel.length).toBeGreaterThan(0);
    }
    expect(catalog.find((i) => i.sourceId === 'meeting-scribe')?.category).toBe('office');
    expect(catalog.find((i) => i.sourceId === 'postgres-local')?.category).toBe('code');
  });

  it('reflects real installed state per source', () => {
    expect(catalog.find((i) => i.sourceId === 'notes-plugin')?.installed).toBe(true);
    expect(catalog.find((i) => i.sourceId === 'active-helper')?.installed).toBe(true);
    expect(catalog.find((i) => i.sourceId === 'csv-cleaning')?.installed).toBe(false);
    expect(catalog.find((i) => i.sourceId === 'fetch-dir')?.installed).toBe(true);
    expect(catalog.find((i) => i.sourceId === 'fs-dir')?.installed).toBe(false);
  });

  it('surfaces permissions for the detail view', () => {
    const pg = catalog.find((i) => i.sourceId === 'postgres-local');
    expect(pg?.permissions.join(' ')).toContain('POSTGRES_URL');
    expect(pg?.permissions.join(' ')).toMatch(/approval/i);
    const plugin = catalog.find((i) => i.sourceId === 'notes-plugin');
    expect(plugin?.permissions.join(' ')).toMatch(/network/i);
  });

  it('marks a bounded featured set, trusted before third-party', () => {
    const featured = featuredItems(catalog);
    expect(featured.length).toBeGreaterThan(0);
    expect(featured.length).toBeLessThanOrEqual(6);
    expect(featured[0]?.sourceId).toBeDefined();
    const scribeIdx = catalog.findIndex((i) => i.sourceId === 'meeting-scribe' && i.featured);
    expect(scribeIdx).toBeGreaterThanOrEqual(0); // free + trusted ranks in
  });
});

describe('filterStoreItems / grouping', () => {
  it('searches name + description + keywords across all kinds', () => {
    expect(filterStoreItems(catalog, { q: 'sql' }).map((i) => i.sourceId)).toContain('sql-tuner');
    expect(filterStoreItems(catalog, { q: 'postgres database' }).map((i) => i.sourceId)).toEqual([
      'postgres-local',
    ]);
    expect(filterStoreItems(catalog, { q: 'meeting notes' }).length).toBeGreaterThanOrEqual(1);
    expect(filterStoreItems(catalog, { q: 'nonexistent-zzz' })).toEqual([]);
  });

  it('filters by category and kind', () => {
    const office = filterStoreItems(catalog, { category: 'office' });
    expect(office.length).toBeGreaterThan(0);
    expect(office.every((i) => i.category === 'office')).toBe(true);
    const mcps = filterStoreItems(catalog, { kind: 'mcp-server' });
    expect(mcps.map((i) => i.sourceId).sort()).toEqual(['fetch-dir', 'fs-dir', 'postgres-local']);
  });

  it('only shows categories that have items, in taxonomy order', () => {
    const visible = visibleCategories(catalog);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(7);
    const groups = groupByCategory(catalog);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(catalog.length);
  });
});

describe('installDescriptorFor — installs route into the existing flows', () => {
  it('routes marketplace bots to the marketplace install endpoint', () => {
    const scribe = catalog.find((i) => i.sourceId === 'meeting-scribe')!;
    expect(installDescriptorFor(scribe)).toEqual({
      flow: 'marketplace-install',
      entryId: 'meeting-scribe',
      gated: false,
    });
  });

  it('routes marketplace MCP servers through the gated approval flow', () => {
    const pg = catalog.find((i) => i.sourceId === 'postgres-local')!;
    expect(installDescriptorFor(pg)).toEqual({
      flow: 'marketplace-install',
      entryId: 'postgres-local',
      gated: true,
    });
  });

  it('routes disabled user skills to the skills-panel enable flow', () => {
    const csv = catalog.find((i) => i.sourceId === 'csv-cleaning')!;
    expect(installDescriptorFor(csv)).toEqual({ flow: 'skill-enable', skillName: 'csv-cleaning' });
  });

  it('routes MCP directory entries to the directory install flow', () => {
    const fs = catalog.find((i) => i.sourceId === 'fs-dir')!;
    expect(installDescriptorFor(fs)).toEqual({
      flow: 'mcp-directory-install',
      directoryId: 'fs-dir',
    });
  });

  it('reports installed items as having no install action', () => {
    const plugin = catalog.find((i) => i.sourceId === 'notes-plugin')!;
    expect(installDescriptorFor(plugin)).toEqual({ flow: 'none-installed' });
    const active = catalog.find((i) => i.sourceId === 'active-helper')!;
    expect(installDescriptorFor(active)).toEqual({ flow: 'none-installed' });
  });

  it('sends a hypothetical uninstalled plugin to the Plugins approval tab', () => {
    const ghost: StoreItem = {
      ...catalog.find((i) => i.sourceId === 'notes-plugin')!,
      installed: false,
    };
    expect(installDescriptorFor(ghost)).toEqual({ flow: 'plugin-approval', tab: 'plugins' });
  });
});
