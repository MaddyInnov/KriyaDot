// SPDX-License-Identifier: Apache-2.0
// #55: per-server tool filtering with wildcards — glob matching, deny
// precedence, and enforcement at the client + lazy-manager exposure
// points. Exact-name patterns (no `*`) keep working as plain toggles.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  McpServerFilterSet,
  filterToolNames,
  isToolAllowedByFilter,
  matchToolPattern,
  parseServerToolFilter,
} from '../src/mcp-scopes.js';
import { MCPClient } from '../src/mcp.js';
import { LazyMcpManager, type LazyMcpConnector } from '../src/mcp-directory.js';
import type { ToolDefinition } from '../src/types.js';

describe('matchToolPattern', () => {
  it('supports * globs, anchored to the whole name', () => {
    expect(matchToolPattern('read_*', 'read_file')).toBe(true);
    expect(matchToolPattern('read_*', 'write_file')).toBe(false);
    expect(matchToolPattern('*', 'anything_at_all')).toBe(true);
    expect(matchToolPattern('mcp:*:fetch', 'mcp:web:fetch')).toBe(true);
    expect(matchToolPattern('*_file', 'read_file')).toBe(true);
    expect(matchToolPattern('read*file', 'read_file')).toBe(true);
    expect(matchToolPattern('read', 'read_file')).toBe(false); // anchored
  });

  it('treats patterns without * as exact names and regex chars literally', () => {
    expect(matchToolPattern('read_file', 'read_file')).toBe(true);
    expect(matchToolPattern('read_file', 'read_file2')).toBe(false);
    expect(matchToolPattern('a.b', 'a.b')).toBe(true);
    expect(matchToolPattern('a.b', 'axb')).toBe(false);
    expect(matchToolPattern('', 'x')).toBe(false);
  });
});

describe('isToolAllowedByFilter / filterToolNames', () => {
  it('deny wins over allow', () => {
    const filter = { allow: ['*'], deny: ['delete_*', 'run_command'] };
    expect(isToolAllowedByFilter(filter, 'read_file')).toBe(true);
    expect(isToolAllowedByFilter(filter, 'delete_file')).toBe(false);
    expect(isToolAllowedByFilter(filter, 'run_command')).toBe(false);
  });

  it('a non-empty allow list gates; an empty/absent one allows all not denied', () => {
    expect(isToolAllowedByFilter({ allow: ['read_*'] }, 'read_file')).toBe(true);
    expect(isToolAllowedByFilter({ allow: ['read_*'] }, 'write_file')).toBe(false);
    expect(isToolAllowedByFilter({ allow: [] }, 'write_file')).toBe(true);
    expect(isToolAllowedByFilter({}, 'write_file')).toBe(true);
    expect(isToolAllowedByFilter(undefined, 'write_file')).toBe(true);
    expect(filterToolNames({ deny: ['*_write'] }, ['a_read', 'b_write', 'c_read'])).toEqual(['a_read', 'c_read']);
  });

  it('parseServerToolFilter validates shapes', () => {
    expect(parseServerToolFilter({ allow: ['a*'] })).toEqual({ allow: ['a*'] });
    expect(() => parseServerToolFilter({ allow: 'a*' })).toThrow();
    expect(() => parseServerToolFilter({ deny: [42] })).toThrow();
    expect(() => parseServerToolFilter('nope')).toThrow();
  });

  it('McpServerFilterSet keys filters per server', () => {
    const set = new McpServerFilterSet();
    set.set('fs', { allow: ['read_*'] });
    expect(set.allows('fs', 'read_file')).toBe(true);
    expect(set.allows('fs', 'write_file')).toBe(false);
    expect(set.allows('other', 'write_file')).toBe(true);
    expect(set.exposedNames('fs', ['read_file', 'write_file'])).toEqual(['read_file']);
    set.clear('fs');
    expect(set.allows('fs', 'write_file')).toBe(true);
  });
});

// -- enforcement: MCPClient -------------------------------------------------

interface FakeTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

function fakeSdkClient(tools: FakeTool[]): Client {
  return {
    async connect() {},
    async close() {},
    async listTools() {
      return { tools };
    },
    async callTool(req: { name: string }) {
      return { ok: true, name: req.name };
    },
    getServerVersion() {
      return { name: 'fake', version: '1' };
    },
  } as unknown as Client;
}

describe('MCPClient toolFilter enforcement (#55)', () => {
  it('filtered tools are never registered; callToolByName refuses them too', async () => {
    const client = new MCPClient({
      createClient: () =>
        fakeSdkClient([
          { name: 'read_file', inputSchema: { type: 'object', properties: {} } },
          { name: 'secret_get', inputSchema: { type: 'object', properties: {} } },
        ]),
      toolFilter: { deny: ['secret_*'] },
    });
    await client.connectStdio({ command: 'fake' });
    const defs = await client.listTools();
    expect(defs.map((d) => d.name)).toEqual(['mcp:read_file']);
    await expect(client.callToolByName('secret_get', {})).rejects.toThrow(/filtered out/);
    await expect(client.callToolByName('read_file', {})).resolves.toEqual({ ok: true, name: 'read_file' });
    await client.close();
  });
});

// -- enforcement: LazyMcpManager ---------------------------------------------

const dirs: string[] = [];
const managers: LazyMcpManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('LazyMcpManager toolFilter enforcement (#55)', () => {
  it('applies the persisted per-server filter to stubs and to connected tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-filter-test-'));
    dirs.push(dir);
    const connector: LazyMcpConnector = {
      async listTools(): Promise<ToolDefinition[]> {
        return ['read_file', 'write_file'].map((name) => ({
          name: `mcp:filesystem:${name}`,
          description: name,
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ called: name }),
        }));
      },
      async close() {},
    };
    const connectSpy = vi.fn(async () => connector);
    const m = new LazyMcpManager({ dataDir: dir, healthCheckIntervalMs: 0, connectFn: connectSpy });
    managers.push(m);
    const server = m.installFromDirectory('filesystem');
    m.store.setToolFilter('filesystem', { allow: ['read_*'] });

    // Stub surface: only the read stub is registered.
    const stubs = m.stubToolDefinitions();
    expect(stubs.map((d) => d.name)).toEqual(['mcp:filesystem:read_file']);

    // The filter persists in the store (survives a store reopen).
    expect(m.store.getToolFilter('filesystem')).toEqual({ allow: ['read_*'] });

    // Connected surface: the write tool is not reachable through a stub.
    const stub = stubs[0]!;
    await expect(stub.handler({}, { sessionId: 's', botId: 'b' })).resolves.toEqual({ called: 'read_file' });
    expect(server.label).toBe('filesystem');
  });
});
