// SPDX-License-Identifier: Apache-2.0
// Manager lifecycle + runtime round-trips against the real demo plugins
// (real child processes over stdio, no network, no mocks of the transport).
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PluginApprovalRequired,
  PluginInstallDenied,
  PluginManager,
  PluginNotFoundError,
  createZipArchive,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', 'examples');
const demo = (name: string) => join(EXAMPLES, name);

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'plugins-test-'));
}

const approveAll = () => true;

function fixturePlugin(dir: string, manifest: Record<string, unknown>, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

describe('PluginManager install lifecycle', () => {
  it('installs from a directory, persists state, and reloads via loadAll', async () => {
    const dir = dataDir();
    const mgr = new PluginManager({ dataDir: dir, approveInstall: approveAll });
    const rec = await mgr.install({ type: 'dir', path: demo('demo-toolkit') });
    expect(rec.id).toBe('demo-toolkit');
    expect(rec.enabled).toBe(true);
    expect(existsSync(join(rec.dir, 'plugin.json'))).toBe(true);
    expect(existsSync(join(dir, 'plugins-state.json'))).toBe(true);

    const fresh = new PluginManager({ dataDir: dir, approveInstall: approveAll });
    const report = fresh.loadAll();
    expect(report.failed).toEqual([]);
    expect(report.loaded.map((p) => p.id)).toEqual(['demo-toolkit']);
  });

  it('deny-by-default: no approval hook → PluginApprovalRequired; hook=false → PluginInstallDenied', async () => {
    const noHook = new PluginManager({ dataDir: dataDir() });
    await expect(noHook.install({ type: 'dir', path: demo('demo-toolkit') })).rejects.toBeInstanceOf(PluginApprovalRequired);
    const denying = new PluginManager({ dataDir: dataDir(), approveInstall: () => false });
    await expect(denying.install({ type: 'dir', path: demo('demo-toolkit') })).rejects.toBeInstanceOf(PluginInstallDenied);
    expect(denying.list()).toEqual([]);
  });

  it('passes the manifest + source to the approval hook', async () => {
    const seen: Array<{ id: string; origin: string }> = [];
    const mgr = new PluginManager({
      dataDir: dataDir(),
      approveInstall: (manifest, source) => {
        seen.push({ id: manifest.id, origin: source.origin });
        return true;
      },
    });
    await mgr.install({ type: 'dir', path: demo('demo-skill') });
    expect(seen).toEqual([{ id: 'demo-skill', origin: demo('demo-skill') }]);
  });

  it('installs from a zip built in-test and from a URL via injected fetch', async () => {
    const dir = dataDir();
    const mgr = new PluginManager({ dataDir: dir, approveInstall: approveAll });
    const { readFileSync, readdirSync } = await import('node:fs');
    // Build a zip of demo-hook from its real files.
    const hookDir = demo('demo-hook');
    const entries = readdirSync(hookDir).map((f) => ({ name: f, data: readFileSync(join(hookDir, f)) }));
    const zip = createZipArchive(entries);
    const zipPath = join(dir, 'demo-hook.zip');
    writeFileSync(zipPath, zip);
    const fromZip = await mgr.install({ type: 'zip', path: zipPath });
    expect(fromZip.id).toBe('demo-hook');

    const urlMgr = new PluginManager({
      dataDir: dataDir(),
      approveInstall: approveAll,
      fetchFn: async (url: string) => {
        expect(url).toBe('https://example.invalid/demo-hook.zip');
        return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer };
      },
    });
    const fromUrl = await urlMgr.install({ type: 'url', url: 'https://example.invalid/demo-hook.zip' });
    expect(fromUrl.id).toBe('demo-hook');
  });

  it('rejects a package whose manifest is invalid or files are missing', async () => {
    const mgr = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll });
    const bad = fixturePlugin(join(dataDir(), 'bad'), { id: 'bad' }, {});
    await expect(mgr.install({ type: 'dir', path: bad })).rejects.toThrow(/Invalid plugin manifest/);
    const ghost = fixturePlugin(
      join(dataDir(), 'ghost'),
      { id: 'ghost', name: 'Ghost', version: '1.0.0', description: 'd', kinds: ['skill'] },
      {},
    );
    await expect(mgr.install({ type: 'dir', path: ghost })).rejects.toThrow(/SKILL\.md/);
    expect(mgr.list()).toEqual([]);
  });

  it('enable/disable gates runtime surfaces; uninstall removes dir + state', async () => {
    const mgr = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll });
    const rec = await mgr.install({ type: 'dir', path: demo('demo-toolkit') });
    mgr.setEnabled('demo-toolkit', false);
    expect(mgr.get('demo-toolkit')?.enabled).toBe(false);
    await expect(mgr.tools()).resolves.toEqual([]);
    await expect(mgr.callTool('demo-toolkit', 'wordcount', { text: 'x' })).rejects.toThrow(/disabled/);
    mgr.setEnabled('demo-toolkit', true);
    mgr.uninstall('demo-toolkit');
    expect(mgr.list()).toEqual([]);
    expect(existsSync(rec.dir)).toBe(false);
    expect(() => mgr.uninstall('demo-toolkit')).toThrow(PluginNotFoundError);
  });
});

describe('runtime round-trips (real child processes)', () => {
  it('tool plugin: tools/list is prefixed and tools/call round-trips', async () => {
    const mgr = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll });
    await mgr.install({ type: 'dir', path: demo('demo-toolkit') });
    const tools = await mgr.tools();
    expect(tools.map((t) => t.name)).toEqual(['plugin:demo-toolkit:wordcount', 'plugin:demo-toolkit:timestamp']);
    const wc = tools.find((t) => t.name.endsWith('wordcount'))!;
    const result = (await wc.handler({ text: 'one two  three' }, { sessionId: 's', botId: 'b' })) as { words: number };
    expect(result.words).toBe(3);
    const direct = (await mgr.callTool('demo-toolkit', 'timestamp', {})) as { now: number };
    expect(typeof direct.now).toBe('number');
  });

  it('hook plugin: returns a HookBus-compatible inject result', async () => {
    const mgr = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll });
    await mgr.install({ type: 'dir', path: demo('demo-hook') });
    const res = await mgr.invokeHook('demo-hook', 'turn.ending', { sessionId: 's', botId: 'b', finalContent: 'x', toolsExecuted: 0 });
    expect(res).toEqual({ inject: expect.stringContaining('footer') });
    const none = await mgr.invokeHook('demo-hook', 'session.created', { sessionId: 's', botId: 'b' });
    expect(none).toBeUndefined();
  });

  it('channel plugin: send queues an echo, poll drains it exactly once', async () => {
    const mgr = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll });
    await mgr.install({ type: 'dir', path: demo('demo-channel') });
    const provider = mgr.channelProvider('demo-channel');
    expect(provider.id).toBe('plugin-demo-channel');
    const sent = await provider.send('room-1', 'hello');
    expect(sent.ok).toBe(true);
    const first = await provider.poll();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ chatId: 'room-1', text: 'echo: hello' });
    await expect(provider.poll()).resolves.toEqual([]);
  });

  it('skill + ui descriptors come from the installed demos', async () => {
    const mgr = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll });
    await mgr.install({ type: 'dir', path: demo('demo-skill') });
    await mgr.install({ type: 'dir', path: demo('demo-ui') });
    const skill = mgr.skillDescriptor('demo-skill');
    expect(skill.name).toBe('demo-skill');
    expect(skill.description).toContain('release notes');
    expect(skill.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skill.content).toContain('# Demo Skill');
    const ui = mgr.uiDescriptor('demo-ui');
    expect(ui.title).toBe('Demo Panel');
    expect(existsSync(ui.indexFile)).toBe(true);
    expect(ui.mountPath).toBe('/plugins/demo-ui/ui/');
  });
});
