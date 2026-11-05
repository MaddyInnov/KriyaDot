// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionNeededCard, connectionNeededFromToolResult } from './connection-needed-card';

function structured(kind: string, actionType: string, href: string) {
  return {
    connectionNeeded: {
      kind,
      appSlug: 'canva',
      appName: 'Canva',
      message: 'Canva needs attention.',
      action: { type: actionType, href },
    },
  };
}

describe('connectionNeededFromToolResult — (A) structured', () => {
  it('extracts platform_not_configured', () => {
    const data = connectionNeededFromToolResult(
      'composio_list_actions',
      structured('platform_not_configured', 'setup_platform', '/accounts?setup=platform'),
    );
    expect(data).toEqual({
      kind: 'platform_not_configured',
      appSlug: 'canva',
      appName: 'Canva',
      message: 'Canva needs attention.',
      action: { type: 'setup_platform', href: '/accounts?setup=platform' },
    });
  });

  it('extracts not_in_catalog', () => {
    const data = connectionNeededFromToolResult(
      'composio_list_actions',
      structured('not_in_catalog', 'open_connected_apps', '/accounts?app=canva'),
    );
    expect(data?.kind).toBe('not_in_catalog');
    expect(data?.appSlug).toBe('canva');
    expect(data?.action).toEqual({ type: 'open_connected_apps', href: '/accounts?app=canva' });
  });

  it('extracts account_not_connected', () => {
    const data = connectionNeededFromToolResult(
      'composio_list_actions',
      structured('account_not_connected', 'connect_app', '/accounts?app=canva'),
    );
    expect(data?.kind).toBe('account_not_connected');
    expect(data?.action).toEqual({ type: 'connect_app', href: '/accounts?app=canva' });
  });

  it('extracts not_enabled_for_bot (with botId)', () => {
    const result = structured('not_enabled_for_bot', 'enable_for_bot', '/accounts?app=canva');
    (result.connectionNeeded as Record<string, unknown>).botId = 'bot-1';
    const data = connectionNeededFromToolResult('composio_list_actions', result);
    expect(data?.kind).toBe('not_enabled_for_bot');
    expect(data?.botId).toBe('bot-1');
    expect(data?.action).toEqual({ type: 'enable_for_bot', href: '/accounts?app=canva' });
  });

  it('accepts the minimum viable payload (kind + href only)', () => {
    const data = connectionNeededFromToolResult('composio_list_actions', {
      connectionNeeded: { kind: 'account_not_connected', action: { href: '/accounts?app=canva' } },
    });
    expect(data?.kind).toBe('account_not_connected');
    expect(data?.appSlug).toBe('');
    expect(data?.action.href).toBe('/accounts?app=canva');
    // Action type is inferred from the kind when absent.
    expect(data?.action.type).toBe('connect_app');
  });

  it('returns null for malformed structured payloads', () => {
    expect(connectionNeededFromToolResult('composio_list_actions', { connectionNeeded: 'nope' })).toBeNull();
    expect(connectionNeededFromToolResult('composio_list_actions', { connectionNeeded: null })).toBeNull();
    expect(
      connectionNeededFromToolResult('composio_list_actions', {
        connectionNeeded: { action: { href: '/accounts' } },
      }),
    ).toBeNull();
    expect(
      connectionNeededFromToolResult('composio_list_actions', {
        connectionNeeded: { kind: 'bogus_kind', action: { href: '/accounts' } },
      }),
    ).toBeNull();
    expect(
      connectionNeededFromToolResult('composio_list_actions', {
        connectionNeeded: { kind: 'account_not_connected', action: {} },
      }),
    ).toBeNull();
    expect(
      connectionNeededFromToolResult('composio_list_actions', {
        connectionNeeded: { kind: 'account_not_connected' },
      }),
    ).toBeNull();
  });
});

describe('connectionNeededFromToolResult — (B) error text', () => {
  it('maps "Composio is not connected" to platform_not_configured', () => {
    for (const tool of ['composio_call', 'composio_list_actions']) {
      const data = connectionNeededFromToolResult(tool, { error: 'Composio is not connected.' });
      expect(data?.kind).toBe('platform_not_configured');
      expect(data?.appSlug).toBe('');
      expect(data?.action).toEqual({ type: 'setup_platform', href: '/accounts?setup=platform' });
    }
  });

  it('maps "app ... is not enabled for this bot" with the captured slug', () => {
    const data = connectionNeededFromToolResult('composio_call', {
      error: 'app "canva" is not enabled for this bot',
    });
    expect(data?.kind).toBe('not_enabled_for_bot');
    expect(data?.appSlug).toBe('canva');
    expect(data?.action).toEqual({ type: 'enable_for_bot', href: '/accounts?app=canva' });
  });

  it('maps "unknown Composio account" to a generic account_not_connected', () => {
    const data = connectionNeededFromToolResult('composio_list_actions', {
      error: 'unknown Composio account: acct_123',
    });
    expect(data?.kind).toBe('account_not_connected');
    expect(data?.appSlug).toBe('');
    expect(data?.action.href).toBe('/accounts');
  });

  it('ignores unmatched error text', () => {
    expect(connectionNeededFromToolResult('composio_call', { error: 'rate limited, try later' })).toBeNull();
    expect(connectionNeededFromToolResult('composio_call', { error: '' })).toBeNull();
  });
});

describe('connectionNeededFromToolResult — ignored / malformed inputs', () => {
  it('ignores non-Composio tools even when the payload matches', () => {
    expect(
      connectionNeededFromToolResult(
        'publish_page',
        structured('account_not_connected', 'connect_app', '/accounts?app=canva'),
      ),
    ).toBeNull();
    expect(connectionNeededFromToolResult('notes_save', { error: 'Composio is not connected.' })).toBeNull();
    expect(
      connectionNeededFromToolResult('some_tool', { error: 'app "canva" is not enabled for this bot' }),
    ).toBeNull();
  });

  it('returns null (never throws) for malformed results', () => {
    expect(connectionNeededFromToolResult('composio_call', null)).toBeNull();
    expect(connectionNeededFromToolResult('composio_call', undefined)).toBeNull();
    expect(connectionNeededFromToolResult('composio_call', 'Composio is not connected')).toBeNull();
    expect(connectionNeededFromToolResult('composio_call', 42)).toBeNull();
    expect(connectionNeededFromToolResult('composio_call', {})).toBeNull();
    expect(connectionNeededFromToolResult('composio_call', { error: 123 })).toBeNull();
    expect(connectionNeededFromToolResult('composio_list_actions', [])).toBeNull();
  });
});

describe('ConnectionNeededCard', () => {
  it('renders the title and primary button href/label for account_not_connected', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConnectionNeededCard, {
        data: {
          kind: 'account_not_connected',
          appSlug: 'canva',
          appName: 'Canva',
          message: 'Connect Canva to let this bot use it.',
          action: { type: 'connect_app', href: '/accounts?app=canva' },
        },
      }),
    );
    expect(html).toContain('Connect Canva to continue');
    expect(html).toContain('Connect Canva to let this bot use it.');
    expect(html).toContain('href="/accounts?app=canva"');
    expect(html).toContain('Connect Canva');
    expect(html).toContain('connection-needed-card');
  });
});
