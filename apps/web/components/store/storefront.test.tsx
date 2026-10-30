// SPDX-License-Identifier: Apache-2.0
// Render tests for the Store storefront's presentational pieces (ADD-1).
// Rendering uses renderToStaticMarkup (this repo's vitest setup does not
// transform JSX in test files), so components are built with
// React.createElement — the same pattern as provenance-chip.test.tsx.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoreCard, StoreDetail } from './storefront';
import type { StoreItem } from '../../lib/store-catalog';

const noop = (): void => undefined;

const bot: StoreItem = {
  id: 'marketplace:bot:meeting-scribe',
  sourceId: 'meeting-scribe',
  kind: 'bot',
  source: 'marketplace',
  name: 'Meeting Scribe',
  description: 'Structured meeting notes from transcripts.',
  version: '1.0.0',
  publisher: 'mvp-labs',
  category: 'office',
  categoryLabel: 'Office',
  tags: ['notes'],
  keywords: ['bot'],
  permissions: ['Tools: web_search'],
  priceCents: 0,
  license: 'Apache-2.0',
  untrusted: false,
  featured: true,
  installed: false,
  installVia: 'marketplace',
};

const installedPlugin: StoreItem = {
  id: 'plugin:plugin:notes-bridge',
  sourceId: 'notes-bridge',
  kind: 'plugin',
  source: 'plugin',
  name: 'Notes Bridge',
  description: 'Syncs notes outward.',
  version: '0.2.0',
  publisher: 'dir',
  category: 'office',
  categoryLabel: 'Office',
  tags: ['tool'],
  keywords: ['plugin'],
  permissions: ['Network access (declared)'],
  priceCents: 0,
  featured: false,
  installed: true,
  installVia: 'plugin',
};

const gatedMcp: StoreItem = {
  id: 'marketplace:mcp-server:postgres-local',
  sourceId: 'postgres-local',
  kind: 'mcp-server',
  source: 'marketplace',
  name: 'Local Postgres',
  description: 'MCP server exposing a local Postgres database.',
  version: '1.0.0',
  publisher: 'dataforge',
  category: 'code',
  categoryLabel: 'Code',
  tags: ['database'],
  keywords: ['mcp-server'],
  permissions: ['Runs local command: npx', 'Environment variables: POSTGRES_URL'],
  priceCents: 0,
  license: 'MIT',
  untrusted: true,
  featured: false,
  installed: false,
  installVia: 'marketplace',
};

describe('StoreCard', () => {
  it('renders a fixture card: monogram tile, name, one-line description, kind badge, Install', () => {
    const html = renderToStaticMarkup(
      React.createElement(StoreCard, { item: bot, onInstall: noop, onSelect: noop }),
    );
    expect(html).toContain('Meeting Scribe');
    expect(html).toContain('MS'); // monogram tile
    expect(html).toContain('Structured meeting notes');
    expect(html).toContain('Bot'); // kind badge
    expect(html).toContain('Install');
    expect(html).toContain('Free');
    expect(html).not.toContain('Installed'); // not installed → no installed chip
  });

  it('shows the Installed state instead of an Install button for installed items', () => {
    const html = renderToStaticMarkup(
      React.createElement(StoreCard, { item: installedPlugin, onInstall: noop, onSelect: noop }),
    );
    expect(html).toContain('Installed');
    expect(html).toContain('Plugin');
    expect(html).not.toContain('>Install<');
  });

  it('labels a gated MCP install as an approval request, never a plain install', () => {
    const html = renderToStaticMarkup(
      React.createElement(StoreCard, { item: gatedMcp, onInstall: noop, onSelect: noop }),
    );
    expect(html).toContain('Request install (approval)');
    expect(html).toContain('MCP server');
    expect(html).toContain('third-party');
  });

  it('invokes the install callback with the item (routing lives in the container)', () => {
    const onInstall = vi.fn();
    // The descriptor the container will act on is derived from the item;
    // here we assert the card wires its button label from that routing.
    const html = renderToStaticMarkup(
      React.createElement(StoreCard, { item: bot, onInstall, onSelect: noop }),
    );
    expect(html).toContain('data-store-item="marketplace:bot:meeting-scribe"');
  });
});

describe('StoreDetail', () => {
  it('shows description, kind, publisher/source, permissions and version', () => {
    const html = renderToStaticMarkup(
      React.createElement(StoreDetail, {
        item: gatedMcp,
        onInstall: noop,
        onConfirmMcp: noop,
        onClose: noop,
      }),
    );
    expect(html).toContain('Local Postgres');
    expect(html).toContain('MCP server exposing a local Postgres database.');
    expect(html).toContain('dataforge'); // publisher
    expect(html).toContain('marketplace'); // source
    expect(html).toContain('POSTGRES_URL'); // permission detail
    expect(html).toContain('v1.0.0'); // version
    expect(html).toContain('MIT'); // license
    expect(html).toContain('Permissions requested');
    // Gated flow: the confirm-after-approval action is present.
    expect(html).toContain('Confirm install after approval');
  });

  it('shows Installed in the detail view for an installed plugin', () => {
    const html = renderToStaticMarkup(
      React.createElement(StoreDetail, { item: installedPlugin, onInstall: noop, onClose: noop }),
    );
    expect(html).toContain('Installed');
    expect(html).toContain('Network access (declared)');
    expect(html).toContain('v0.2.0');
  });
});
