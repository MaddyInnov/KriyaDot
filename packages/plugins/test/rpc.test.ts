// SPDX-License-Identifier: Apache-2.0
// RPC transport guarantees: timeout and environment scrubbing, exercised
// with throwaway fixture plugins written into a temp dir.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginManager, PluginRpcTimeoutError } from '../src/index.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'plugins-rpc-test-'));
}

function writePlugin(base: string, id: string, manifestExtra: Record<string, unknown>, script: string): string {
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', description: 'fixture', kinds: ['tool'], entry: 'index.js', ...manifestExtra }),
  );
  writeFileSync(join(dir, 'index.js'), script);
  return dir;
}

const ENV_PROBE = `'use strict';
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  const result = req.method === 'tools/list'
    ? { tools: [{ name: 'env', description: 'echo env', parameters: { type: 'object', properties: {} } }] }
    : { secret: process.env.PLUGIN_TEST_SECRET ?? null, allowed: process.env.PLUGIN_TEST_ALLOWED ?? null, pluginId: process.env.PLUGIN_ID ?? null };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
});
`;

const HANGING = `'use strict';
// Never answers: used to prove the host-side timeout kills the child.
setInterval(() => {}, 1000);
`;

describe('stdio RPC transport', () => {
  const OLD_SECRET = process.env.PLUGIN_TEST_SECRET;
  const OLD_ALLOWED = process.env.PLUGIN_TEST_ALLOWED;
  afterEach(() => {
    if (OLD_SECRET === undefined) delete process.env.PLUGIN_TEST_SECRET;
    else process.env.PLUGIN_TEST_SECRET = OLD_SECRET;
    if (OLD_ALLOWED === undefined) delete process.env.PLUGIN_TEST_ALLOWED;
    else process.env.PLUGIN_TEST_ALLOWED = OLD_ALLOWED;
  });

  it('scrubs the child env: only manifest-declared variables pass through', async () => {
    process.env.PLUGIN_TEST_SECRET = 'do-not-leak';
    process.env.PLUGIN_TEST_ALLOWED = 'visible';
    const base = tmp();
    const dir = writePlugin(base, 'env-probe', { permissions: { env: ['PLUGIN_TEST_ALLOWED'] } }, ENV_PROBE);
    const mgr = new PluginManager({ dataDir: tmp(), approveInstall: () => true });
    await mgr.install({ type: 'dir', path: dir });
    const result = (await mgr.callTool('env-probe', 'env', {})) as { secret: unknown; allowed: unknown; pluginId: unknown };
    expect(result.secret).toBeNull();
    expect(result.allowed).toBe('visible');
    expect(result.pluginId).toBe('env-probe');
  });

  it('times out a hanging plugin invocation', async () => {
    const base = tmp();
    const dir = writePlugin(base, 'hanging', {}, HANGING);
    const mgr = new PluginManager({ dataDir: tmp(), approveInstall: () => true, rpcTimeoutMs: 300 });
    await mgr.install({ type: 'dir', path: dir });
    await expect(mgr.callTool('hanging', 'anything', {})).rejects.toBeInstanceOf(PluginRpcTimeoutError);
  });
});
