// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPClient } from '../src/mcp.js';
import {
  MCP_APP_MIME_TYPE,
  McpAppNonceStore,
  extractMcpAppLink,
  filterMcpAppResources,
  isMcpAppResource,
  mcpServerIdFromToolName,
} from '../src/mcp-apps.js';
import { pageWidgetFromPublishResult, validateWidgetPayload } from '../src/widgets.js';

const APP_HTML = '<!doctype html><html><body><h1>App</h1></body></html>';

interface FakeResource {
  uri: string;
  name?: string;
  mimeType?: string;
}

function makeFakeClient(resources: FakeResource[]) {
  return {
    async connect() {},
    async close() {},
    async listTools() {
      return { tools: [] };
    },
    async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
      return { ok: true, name: req.name, args: req.arguments ?? {} };
    },
    async listResources() {
      return { resources };
    },
    async readResource(req: { uri: string }) {
      const res = resources.find((r) => r.uri === req.uri);
      if (!res) throw new Error(`unknown resource: ${req.uri}`);
      return {
        contents: [{ uri: res.uri, mimeType: res.mimeType, text: APP_HTML }],
      };
    },
    getServerVersion() {
      return { name: 'fake-server', version: '1.0.0' };
    },
  } as unknown as Client;
}

const RESOURCES: FakeResource[] = [
  { uri: 'ui://dashboard', name: 'Dashboard', mimeType: MCP_APP_MIME_TYPE },
  { uri: 'ui://plain', name: 'Plain', mimeType: 'text/html' },
  { uri: 'file:///data.json', name: 'Data', mimeType: 'application/json' },
];

describe('isMcpAppResource / filterMcpAppResources', () => {
  it('recognizes ui:// HTML resources only', () => {
    expect(isMcpAppResource(RESOURCES[0])).toBe(true);
    expect(isMcpAppResource(RESOURCES[1])).toBe(true);
    expect(isMcpAppResource(RESOURCES[2])).toBe(false);
    expect(filterMcpAppResources(RESOURCES).map((r) => r.uri)).toEqual([
      'ui://dashboard',
      'ui://plain',
    ]);
  });
});

describe('extractMcpAppLink', () => {
  it('reads _meta.ui.resourceUri from the result', () => {
    const link = extractMcpAppLink({
      content: [{ type: 'text', text: 'hi' }],
      _meta: { ui: { resourceUri: 'ui://dashboard', title: 'Dash' } },
    });
    expect(link).toEqual({ resourceUri: 'ui://dashboard', title: 'Dash' });
  });

  it('reads an embedded resource content item', () => {
    const link = extractMcpAppLink({
      content: [
        {
          type: 'resource',
          resource: { uri: 'ui://panel', mimeType: MCP_APP_MIME_TYPE, name: 'Panel' },
        },
      ],
    });
    expect(link?.resourceUri).toBe('ui://panel');
  });

  it('reads a resource_link content item', () => {
    const link = extractMcpAppLink({
      content: [{ type: 'resource_link', uri: 'ui://x', name: 'X' }],
    });
    expect(link?.resourceUri).toBe('ui://x');
  });

  it('returns undefined for plain results and non-ui URIs', () => {
    expect(extractMcpAppLink({ content: [{ type: 'text', text: 'x' }] })).toBeUndefined();
    expect(extractMcpAppLink({ _meta: { ui: { resourceUri: 'https://evil.example/' } } })).toBeUndefined();
    expect(extractMcpAppLink(null)).toBeUndefined();
    expect(extractMcpAppLink('text')).toBeUndefined();
  });
});

describe('mcpServerIdFromToolName', () => {
  it('parses mcp:<server>:<tool> and rejects the legacy shape', () => {
    expect(mcpServerIdFromToolName('mcp:weather:get_forecast')).toBe('weather');
    expect(mcpServerIdFromToolName('mcp:get_forecast')).toBeUndefined();
    expect(mcpServerIdFromToolName('read_file')).toBeUndefined();
  });
});

describe('McpAppNonceStore', () => {
  it('issues, verifies (bound to server + resource), and expires nonces', () => {
    const store = new McpAppNonceStore({ ttlMs: 1000 });
    const t0 = 1_000_000;
    const rec = store.issue('weather', 'ui://dashboard', t0);
    expect(rec.expiresAt).toBe(t0 + 1000);
    expect(store.verify(rec.nonce, 'weather', 'ui://dashboard', t0 + 10)).toBe(true);
    expect(store.verify(rec.nonce, 'other', 'ui://dashboard', t0 + 10)).toBe(false);
    expect(store.verify(rec.nonce, 'weather', 'ui://other', t0 + 10)).toBe(false);
    expect(store.verify('bogus', 'weather', 'ui://dashboard', t0 + 10)).toBe(false);
    // Expired: exactly at expiry the nonce is dead.
    expect(store.verify(rec.nonce, 'weather', 'ui://dashboard', t0 + 1000)).toBe(false);
  });

  it('revoke kills a nonce immediately', () => {
    const store = new McpAppNonceStore();
    const rec = store.issue('s', 'ui://a');
    store.revoke(rec.nonce);
    expect(store.verify(rec.nonce, 's', 'ui://a')).toBe(false);
  });
});

describe('MCPClient resource access (fake server)', () => {
  it('lists app resources, reads app HTML, and calls tools by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-apps-'));
    const client = new MCPClient({
      serverName: 'fake',
      pinDbPath: join(dir, 'pins.db'),
      createClient: () => makeFakeClient(RESOURCES),
    });
    await client.connectStdio({ command: 'fake-server' });
    try {
      const apps = await client.listAppResources();
      expect(apps.map((r) => r.uri)).toEqual(['ui://dashboard', 'ui://plain']);
      const read = await client.readResource('ui://dashboard');
      expect(read.contents[0].text).toBe(APP_HTML);
      const called = (await client.callToolByName('ping', { a: 1 })) as { ok: boolean };
      expect(called.ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('widget payloads for mcp-app and page', () => {
  it('validates mcp-app payloads and rejects non-ui URIs', () => {
    const ok = validateWidgetPayload({
      kind: 'mcp-app',
      serverId: 'weather',
      resourceUri: 'ui://dashboard',
      nonce: 'abc123',
      title: 'Dash',
    });
    expect(ok.ok).toBe(true);
    const bad = validateWidgetPayload({
      kind: 'mcp-app',
      serverId: 'weather',
      resourceUri: 'https://example.com/',
      nonce: 'abc123',
    });
    expect(bad.ok).toBe(false);
  });

  it('builds a page widget only from a successful publish_page result', () => {
    const w = pageWidgetFromPublishResult('publish_page', {
      published: true,
      pageId: 'p1',
      title: 'Doc',
      slug: 's1',
      path: '/p/s1',
    });
    expect(w).toEqual({ kind: 'page', pageId: 'p1', title: 'Doc', slug: 's1', path: '/p/s1' });
    expect(pageWidgetFromPublishResult('publish_page', { published: false })).toBeUndefined();
    expect(pageWidgetFromPublishResult('other_tool', { published: true, pageId: 'p1' })).toBeUndefined();
  });
});
