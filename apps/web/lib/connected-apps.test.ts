// SPDX-License-Identifier: Apache-2.0
// Pure-helper tests for the Connected Apps hub (W4): filtering, grouping,
// status text/tones, and the MCP merge guard.
import { describe, expect, it } from 'vitest';
import {
  categoryLabel,
  filterApps,
  groupApps,
  mergeMcpServers,
  statusLabel,
  statusTone,
  triggerKindLabel,
  type ConnectedAppEntry,
} from './connected-apps';

function app(partial: Partial<ConnectedAppEntry> & { id: string; name: string }): ConnectedAppEntry {
  return {
    category: 'productivity',
    source: 'composio',
    connectionType: 'OAuth via Composio',
    status: 'available',
    accounts: [],
    enabledBotIds: [],
    capabilities: [],
    starterTasks: [],
    ...partial,
  };
}

const canva = app({
  id: 'canva',
  name: 'Canva',
  category: 'design-media',
  featured: true,
  description: 'Design graphics and presentations',
  capabilities: ['create designs', 'export images'],
});
const gmail = app({
  id: 'gmail',
  name: 'Gmail',
  category: 'messaging',
  status: 'connected',
  description: 'Email inbox',
  capabilities: ['read email', 'send email'],
  accounts: [{ id: 'a1', label: 'work Gmail', status: 'ACTIVE' }],
});
const blender = app({
  id: 'blender',
  name: 'Blender',
  category: 'local',
  source: 'local',
  connectionType: 'Installed app',
  status: 'on_this_computer',
  capabilities: ['3d modelling'],
  local: { installed: true, version: '4.2' },
});
const notion = app({ id: 'notion', name: 'Notion', capabilities: ['pages', 'databases'] });
const apps = [canva, gmail, blender, notion];

describe('filterApps', () => {
  it('returns everything with no filters', () => {
    expect(filterApps(apps, {})).toHaveLength(4);
    expect(filterApps(apps, { query: '', category: 'all' })).toHaveLength(4);
  });

  it('searches name, description and capabilities, case-insensitively', () => {
    expect(filterApps(apps, { query: 'CANVA' }).map((a) => a.id)).toEqual(['canva']);
    expect(filterApps(apps, { query: 'inbox' }).map((a) => a.id)).toEqual(['gmail']);
    expect(filterApps(apps, { query: 'export images' }).map((a) => a.id)).toEqual(['canva']);
    expect(filterApps(apps, { query: 'send email' }).map((a) => a.id)).toEqual(['gmail']);
    expect(filterApps(apps, { query: 'nope' })).toEqual([]);
  });

  it('filters by category, featured, connected and local pseudo-filters', () => {
    expect(filterApps(apps, { category: 'design-media' }).map((a) => a.id)).toEqual(['canva']);
    expect(filterApps(apps, { category: 'featured' }).map((a) => a.id)).toEqual(['canva']);
    expect(filterApps(apps, { category: 'connected' }).map((a) => a.id)).toEqual(['gmail']);
    expect(filterApps(apps, { category: 'local' }).map((a) => a.id)).toEqual(['blender']);
  });

  it('combines query and category', () => {
    expect(filterApps(apps, { query: 'email', category: 'messaging' })).toHaveLength(1);
    expect(filterApps(apps, { query: 'email', category: 'design-media' })).toHaveLength(0);
  });
});

describe('groupApps', () => {
  it('buckets featured, connected, by-category (canonical order) and local', () => {
    const grouped = groupApps(apps);
    expect(grouped.featured.map((a) => a.id)).toEqual(['canva']);
    expect(grouped.connected.map((a) => a.id)).toEqual(['gmail']);
    expect(grouped.local.map((a) => a.id)).toEqual(['blender']);
    expect(grouped.byCategory.map((g) => g.category)).toEqual([
      'design-media',
      'messaging',
      'productivity',
      'local',
    ]);
    expect(grouped.byCategory[0].label).toBe('Design & Media');
  });

  it('sorts within buckets by name', () => {
    const grouped = groupApps([
      app({ id: 'z', name: 'Zeta', featured: true }),
      app({ id: 'a', name: 'Alpha', featured: true }),
    ]);
    expect(grouped.featured.map((a) => a.name)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('status helpers', () => {
  it('labels every status in plain words', () => {
    expect(statusLabel('connected')).toBe('Connected');
    expect(statusLabel('available')).toBe('Available');
    expect(statusLabel('needs_platform_setup')).toBe('Needs platform setup');
    expect(statusLabel('not_in_catalog')).toBe('Not in your Composio workspace');
    expect(statusLabel('on_this_computer')).toBe('On this computer');
    expect(statusLabel('not_installed')).toBe('Not installed');
  });

  it('tones map to existing chip classes', () => {
    expect(statusTone('connected')).toBe('green');
    expect(statusTone('on_this_computer')).toBe('green');
    expect(statusTone('available')).toBe('blue');
    expect(statusTone('needs_platform_setup')).toBe('amber');
    expect(statusTone('not_in_catalog')).toBe('gray');
    expect(statusTone('not_installed')).toBe('gray');
  });
});

describe('labels', () => {
  it('category and trigger labels', () => {
    expect(categoryLabel('design-media')).toBe('Design & Media');
    expect(categoryLabel('local')).toBe('On this computer');
    expect(triggerKindLabel('event')).toBe('Runs when…');
    expect(triggerKindLabel('schedule')).toBe('On a schedule');
    expect(triggerKindLabel('manual')).toBe('Manual');
  });
});

describe('mergeMcpServers', () => {
  it('adds mcp entries when the aggregate has none', () => {
    const merged = mergeMcpServers(apps, [{ id: 'fs', name: 'Filesystem' }]);
    const mcp = merged.find((a) => a.source === 'mcp');
    expect(mcp?.name).toBe('Filesystem');
    expect(mcp?.status).toBe('connected');
    expect(merged).toHaveLength(5);
  });

  it('skips merging when the aggregate already includes mcp entries', () => {
    const withMcp = [...apps, app({ id: 'mcp:x', name: 'X', source: 'mcp' })];
    expect(mergeMcpServers(withMcp, [{ id: 'fs', name: 'Filesystem' }])).toHaveLength(5);
  });

  it('ignores malformed servers', () => {
    expect(mergeMcpServers(apps, [null, {}, { name: 3 }])).toHaveLength(4);
  });
});
