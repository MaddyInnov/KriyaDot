// SPDX-License-Identifier: Apache-2.0
// Permissions pane sections (Muse parity P-3..P-7): static-render tests
// over the presentational sections with fixture data, in the same style
// as devices-panel.test.tsx.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PermissionsPanel, {
  AllowancesSection,
  ConnectorsSection,
  ItemEditorSection,
  OverviewSection,
  ProtocolsSection,
  type AllowanceRow,
  type ConnectorRow,
  type PermissionsOverviewData,
  type ProtocolRow,
} from './permissions-panel';

const OVERVIEW: PermissionsOverviewData = {
  surfaces: [
    {
      id: 'chat',
      label: 'Chat',
      description: 'Tool calls while chatting.',
      defaultEffect: 'ask',
      currentEffect: 'ask',
      overridden: false,
      source: 'governance DEFAULT_POLICY.defaultEffect',
      overridable: true,
    },
    {
      id: 'purchases',
      label: 'Purchases',
      description: 'Every purchase is approved individually.',
      defaultEffect: 'ask',
      currentEffect: 'ask',
      overridden: false,
      source: 'purchases.ts safety contract',
      overridable: false,
    },
  ],
  counts: { pendingApprovals: 2, allowances: 1, itemOverrides: 1, lastingAllows: 3 },
};

const CONNECTORS: ConnectorRow[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    kind: 'composio',
    enabled: true,
    groups: [
      { id: 'read', label: 'Read & search', effect: 'allow' },
      { id: 'send', label: 'Send & publish', effect: 'ask' },
    ],
    backgroundSync: { enabled: true, implemented: false },
  },
  {
    id: 'telegram',
    name: 'telegram',
    kind: 'channel',
    enabled: true,
    groups: [{ id: 'send', label: 'Send messages', effect: 'ask' }],
    backgroundSync: { enabled: false, implemented: false },
  },
];

const ALLOWANCES: AllowanceRow[] = [
  {
    id: 'a-1',
    kind: 'recipient',
    target: 'friend@example.com',
    actions: ['send'],
    scope: { botId: 'bot-1' },
    createdAt: 1_700_000_000_000,
  },
];

const PROTOCOLS: ProtocolRow[] = [
  {
    id: 'ftp',
    label: 'FTP',
    defaultEffect: 'deny',
    policyKey: 'sandbox network default (network: false)',
    enforcement: 'sandbox',
    writable: false,
    note: 'Enforced by the sandbox.',
  },
  {
    id: 'https',
    label: 'HTTPS',
    defaultEffect: 'ask',
    policyKey: 'governance rule approval-http',
    enforcement: 'governance-policy',
    writable: false,
    note: 'Bots ask before network calls.',
  },
];

describe('permissions pane sections', () => {
  it('Overview renders surfaces, counts and the reset action', () => {
    const html = renderToStaticMarkup(
      <OverviewSection overview={OVERVIEW} onSurfaceChange={vi.fn()} onReset={vi.fn()} />,
    );
    expect(html).toContain('Overview');
    expect(html).toContain('Chat');
    expect(html).toContain('Purchases');
    expect(html).toContain('Reset approvals to defaults');
    expect(html).toContain('Waiting on you');
    expect(html).toContain('governance DEFAULT_POLICY.defaultEffect');
  });

  it('Connectors render action trees and background-sync rows', () => {
    const html = renderToStaticMarkup(
      <ConnectorsSection connectors={CONNECTORS} botId="bot-1" onGroupChange={vi.fn()} onSyncToggle={vi.fn()} />,
    );
    expect(html).toContain('Connected apps');
    expect(html).toContain('Gmail');
    expect(html).toContain('Read &amp; search');
    expect(html).toContain('Send &amp; publish');
    expect(html).toContain('Background sync');
    expect(html).toContain('no sync engine yet');
    expect(html).toContain('telegram');
  });

  it('Allowances render rows with revoke buttons and the add form', () => {
    const html = renderToStaticMarkup(
      <AllowancesSection
        allowances={ALLOWANCES}
        onRevoke={vi.fn()}
        draft={{ kind: 'recipient', target: '', actions: 'send' }}
        onDraftChange={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(html).toContain('Allowances');
    expect(html).toContain('friend@example.com');
    expect(html).toContain('Revoke');
    expect(html).toContain('Add allowance');
    expect(html).toContain('never overrides a policy denial');
  });

  it('Per-item editor renders override rows', () => {
    const html = renderToStaticMarkup(
      <ItemEditorSection
        items={[
          {
            key: 'task:task-9',
            itemKind: 'task',
            itemId: 'task-9',
            actions: { send: 'allow' },
            updatedAt: 1_700_000_000_000,
          },
        ]}
        onDelete={vi.fn()}
      />,
    );
    expect(html).toContain('Per-item permissions');
    expect(html).toContain('task:task-9');
    expect(html).toContain('Remove');
  });

  it('Protocols render read-only rows labelled with their enforcement', () => {
    const html = renderToStaticMarkup(<ProtocolsSection protocols={PROTOCOLS} />);
    expect(html).toContain('Network protocols');
    expect(html).toContain('FTP');
    expect(html).toContain('read-only');
    expect(html).toContain('enforced by sandbox');
    expect(html).toContain('governance rule approval-http');
  });

  it('container is a client component function', () => {
    expect(typeof PermissionsPanel).toBe('function');
  });
});
