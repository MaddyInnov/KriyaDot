// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createZipArchive } from '../../plugins/src/zip.js';
import { parseMcpbBundle, importMcpbBundle, McpbError, McpbImportDenied } from '../src/mcpb.js';
import { LazyMcpServerStore } from '../src/mcp-directory.js';
import { openDb } from '../src/sqlite.js';

const MANIFEST = {
  manifest_version: '0.3',
  name: 'Fixture Notes Server',
  version: '1.0.0',
  description: 'Fixture .mcpb server',
  author: { name: 'Fixture' },
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { NOTES_TOKEN: '${user_config.api_key}' } },
  },
  user_config: { api_key: { type: 'string', sensitive: true } },
  tools: [{ name: 'list_notes', description: 'List notes' }],
};

function fixtureMcpb(): Buffer {
  return createZipArchive([
    { name: 'manifest.json', data: JSON.stringify(MANIFEST) },
    { name: 'server/index.js', data: '// fixture server (never executed in tests)\n' },
  ]);
}

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('CA-33 .mcpb importer', () => {
  it('parses a fixture bundle and maps it to a lazy MCP server config', () => {
    const b = parseMcpbBundle(fixtureMcpb());
    expect(b.label).toBe('fixture-notes-server');
    expect(b.config).toMatchObject({ kind: 'stdio', command: 'node' });
    // env NAMES only — never values — become requiredEnv
    expect(b.config.requiredEnv).toEqual(expect.arrayContaining(['NOTES_TOKEN', 'api_key']));
    expect(b.files).toContain('server/index.js');
  });

  it('rejects a bundle without manifest.json and a manifest without mcp_config', () => {
    expect(() => parseMcpbBundle(createZipArchive([{ name: 'x.txt', data: 'hi' }]))).toThrow(McpbError);
    const bad = createZipArchive([{ name: 'manifest.json', data: JSON.stringify({ name: 'Bad', server: {} }) }]);
    expect(() => parseMcpbBundle(bad)).toThrow(/mcp_config/);
  });

  it('is deny-by-default without an approval hook, and registers through the store when approved', async () => {
    await expect(importMcpbBundle(fixtureMcpb())).rejects.toBeInstanceOf(McpbImportDenied);
    await expect(importMcpbBundle(fixtureMcpb(), { approve: () => false })).rejects.toBeInstanceOf(McpbImportDenied);

    dir = mkdtempSync(join(tmpdir(), 'mcpb-test-'));
    const store = new LazyMcpServerStore(join(dir, 'mcp.db'));
    const audits: string[] = [];
    const { installed } = await importMcpbBundle(fixtureMcpb(), {
      approve: () => true,
      store,
      audit: (a) => audits.push(a),
    });
    expect(installed?.label).toBe('fixture-notes-server');
    expect(store.findByLabel('fixture-notes-server')?.config.command).toBe('node');
    expect(audits).toContain('mcpb.import.approved');
    store.close();
    void openDb;
  });
});
