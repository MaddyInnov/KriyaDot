// SPDX-License-Identifier: Apache-2.0
// Per-bot private MCP isolation (W9 engines pack):
// - two bots with same-named private servers get SEPARATE processes
// - cross-bot tool listing/calling is refused
// - bot deletion kills its processes and drops its configs
// - config change tears down the process; next call respawns with new config
// - shutdown (close) tears down everything
// All against a mock connectFn — no real MCP servers are spawned.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PerBotMcpManager,
  privateMcpKey,
  type PrivateMcpServer,
} from '../src/mcp-private.js';
import type { LazyMcpConnector } from '../src/mcp-directory.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const dirs: string[] = [];
const managers: PerBotMcpManager[] = [];

interface SpawnRecord {
  botId: string;
  label: string;
  command?: string;
  closed: boolean;
}

function makeManager(): { manager: PerBotMcpManager; spawns: SpawnRecord[] } {
  const spawns: SpawnRecord[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-private-test-'));
  dirs.push(dataDir);
  const connectFn = vi.fn(async (server: PrivateMcpServer): Promise<LazyMcpConnector> => {
    const record: SpawnRecord = {
      botId: server.botId,
      label: server.label,
      command: server.config.command,
      closed: false,
    };
    spawns.push(record);
    return {
      async listTools(): Promise<ToolDefinition[]> {
        const mk = (tool: string): ToolDefinition => ({
          name: `mcp:${server.label}:${tool}`,
          description: `${tool} for ${server.botId}`,
          parameters: { type: 'object', properties: {} },
          handler: async (args: Record<string, unknown>) => ({
            servedBy: server.botId,
            label: server.label,
            args,
          }),
        });
        // 'fetch' covers directory installs; 'call' covers the generic stub
        // name used for custom installs without declared tools.
        return [mk('fetch'), mk('call')];
      },
      async close() {
        record.closed = true;
      },
    };
  });
  const manager = new PerBotMcpManager({ dataDir, connectFn });
  managers.push(manager);
  return { manager, spawns };
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ctx = (botId: string): ToolContext => ({ sessionId: 's1', botId });

describe('PerBotMcpManager isolation', () => {
  it('two bots with same-named private servers get separate processes', async () => {
    const { manager, spawns } = makeManager();
    const a = manager.installFromDirectory('bot-a', 'fetch');
    const b = manager.installFromDirectory('bot-b', 'fetch');
    expect(a.label).toBe('fetch');
    expect(b.label).toBe('fetch');
    expect(a.id).not.toBe(b.id);

    // Nothing spawns at install time (lazy).
    expect(spawns).toHaveLength(0);

    const defsA = manager.toolDefinitions('bot-a');
    const fetchA = defsA.find((d) => d.name === 'mcp:fetch:fetch');
    expect(fetchA).toBeDefined();
    const resultA = (await fetchA!.handler({ url: 'https://x' }, ctx('bot-a'))) as { servedBy: string };
    expect(resultA.servedBy).toBe('bot-a');
    expect(spawns).toHaveLength(1);
    expect(spawns[0].botId).toBe('bot-a');

    const defsB = manager.toolDefinitions('bot-b');
    const fetchB = defsB.find((d) => d.name === 'mcp:fetch:fetch');
    const resultB = (await fetchB!.handler({}, ctx('bot-b'))) as { servedBy: string };
    expect(resultB.servedBy).toBe('bot-b');

    // Separate processes, keyed per bot.
    expect(spawns).toHaveLength(2);
    expect(manager.connectedKeys().sort()).toEqual(
      [privateMcpKey('bot-a', a.id), privateMcpKey('bot-b', b.id)].sort(),
    );
    // A second call from bot-a reuses its own process.
    await fetchA!.handler({}, ctx('bot-a'));
    expect(spawns).toHaveLength(2);
  });

  it('cross-bot calls are refused and tools are not listed for other bots', async () => {
    const { manager } = makeManager();
    manager.installFromDirectory('bot-a', 'fetch');
    // Bot B has no private servers: nothing listed.
    expect(manager.toolNamesForBot('bot-b')).toEqual([]);
    // Even holding bot A's definition, bot B cannot call it.
    const defsA = manager.toolDefinitions('bot-a');
    const fetchA = defsA.find((d) => d.name === 'mcp:fetch:fetch')!;
    await expect(fetchA.handler({}, ctx('bot-b'))).rejects.toThrow(/belongs to bot "bot-a"/);
    // And bot B's own listing never contains bot A's server tools.
    manager.install('bot-b', 'notes', { kind: 'stdio', command: 'fake-notes' });
    const namesB = manager.toolNamesForBot('bot-b');
    expect(namesB).not.toContain('mcp:fetch:fetch');
  });

  it('same label is allowed for different bots but rejected twice for one bot', () => {
    const { manager } = makeManager();
    manager.install('bot-a', 'dup', { kind: 'stdio', command: 'x' });
    expect(() => manager.install('bot-a', 'dup', { kind: 'stdio', command: 'x' })).toThrow(/already has/);
    expect(() => manager.install('bot-b', 'dup', { kind: 'stdio', command: 'x' })).not.toThrow();
  });

  it('deleting a bot kills its processes and drops its configs, leaving other bots untouched', async () => {
    const { manager, spawns } = makeManager();
    const a = manager.installFromDirectory('bot-a', 'fetch');
    const b = manager.installFromDirectory('bot-b', 'fetch');
    const defsA = manager.toolDefinitions('bot-a');
    await defsA.find((d) => d.name === 'mcp:fetch:fetch')!.handler({}, ctx('bot-a'));
    const defsB = manager.toolDefinitions('bot-b');
    await defsB.find((d) => d.name === 'mcp:fetch:fetch')!.handler({}, ctx('bot-b'));
    expect(spawns).toHaveLength(2);

    const removed = await manager.removeAllForBot('bot-a');
    expect(removed).toBe(1);
    expect(spawns.find((s) => s.botId === 'bot-a')?.closed).toBe(true);
    expect(spawns.find((s) => s.botId === 'bot-b')?.closed).toBe(false);
    expect(manager.isConnected('bot-a', a.id)).toBe(false);
    expect(manager.isConnected('bot-b', b.id)).toBe(true);
    expect(manager.listForBot('bot-a')).toEqual([]);
    expect(manager.listForBot('bot-b')).toHaveLength(1);
    expect(manager.toolNamesForBot('bot-a')).toEqual([]);
  });

  it('config change tears down the process; the next call respawns with the new config', async () => {
    const { manager, spawns } = makeManager();
    const s = manager.install('bot-a', 'custom', { kind: 'stdio', command: 'old-cmd', args: ['v1'] });
    const def = manager.toolDefinitions('bot-a').find((d) => d.name.startsWith('mcp:custom:'))!;
    await manager.ensureConnected('bot-a', s.id);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].command).toBe('old-cmd');

    const updated = await manager.updateConfig('bot-a', s.id, {
      kind: 'stdio',
      command: 'new-cmd',
      args: ['v2'],
    });
    expect(updated.config.command).toBe('new-cmd');
    // Old process killed synchronously by the config change.
    expect(spawns[0].closed).toBe(true);
    expect(manager.isConnected('bot-a', s.id)).toBe(false);

    await def.handler({}, ctx('bot-a'));
    expect(spawns).toHaveLength(2);
    expect(spawns[1].command).toBe('new-cmd');
  });

  it('disabling a server disconnects it and hides its tools', async () => {
    const { manager, spawns } = makeManager();
    const s = manager.installFromDirectory('bot-a', 'fetch');
    await manager.ensureConnected('bot-a', s.id);
    expect(manager.isConnected('bot-a', s.id)).toBe(true);
    await manager.setEnabled('bot-a', s.id, false);
    expect(manager.isConnected('bot-a', s.id)).toBe(false);
    expect(spawns[0].closed).toBe(true);
    expect(manager.toolNamesForBot('bot-a')).toEqual([]);
    await expect(manager.ensureConnected('bot-a', s.id)).rejects.toThrow(/disabled/);
  });

  it('close() tears down every bot process on shutdown', async () => {
    const { manager, spawns } = makeManager();
    manager.installFromDirectory('bot-a', 'fetch');
    manager.installFromDirectory('bot-b', 'fetch');
    for (const botId of ['bot-a', 'bot-b']) {
      const def = manager.toolDefinitions(botId).find((d) => d.name === 'mcp:fetch:fetch')!;
      await def.handler({}, ctx(botId));
    }
    expect(spawns).toHaveLength(2);
    await manager.close();
    expect(spawns.every((s) => s.closed)).toBe(true);
    expect(manager.connectedKeys()).toEqual([]);
    // close() already ran; drop from afterEach tracking to avoid double-close noise.
    managers.splice(managers.indexOf(manager), 1);
  });
});
