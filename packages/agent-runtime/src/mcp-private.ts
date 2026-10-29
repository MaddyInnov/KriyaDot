// SPDX-License-Identifier: Apache-2.0
// Per-bot private MCP servers (W9 engines pack).
//
// The lazy MCP directory (mcp-directory.ts) installs SHARED servers: one
// process serves every bot that is allowed to use it. A bot's OWN servers
// are different: a server a bot configures for itself (its own command, its
// own env, its own credentials-adjacent config) must be visible to that bot
// only. This module owns that lifecycle:
//
// - Storage: `mcp-private.db`, rows keyed (bot_id, server_id); labels are
//   unique PER BOT, so two bots may both run a private server labeled
//   "fetch" without colliding.
// - Processes: connections are keyed `${botId}::${serverId}` — two bots
//   with same-named private servers get SEPARATE processes, always.
// - Boundary: tool definitions are minted per bot (`toolDefinitions(botId)`)
//   and every handler re-checks `ctx.botId` against the owning bot at call
//   time, so even a leaked definition cannot be called by another bot.
// - Teardown: `removeAllForBot(botId)` is the bot-deletion hook (wired in
//   the API's bot-delete paths); `updateConfig()` disconnects the running
//   process so the next call respawns with the new config; `close()`
//   tears everything down on shutdown.
//
// Nothing spawns at install time: processes start lazily on first tool
// call, mirroring LazyMcpManager.

import { MCPClient, mcpToolName } from './mcp.js';
import {
  getDirectoryEntry,
  validateServerConfig,
  validateServerLabel,
  type InstalledMcpServer,
  type InstalledMcpServerConfig,
  type LazyMcpConnector,
} from './mcp-directory.js';
import type { ToolContext, ToolDefinition } from './types.js';
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export interface PrivateMcpServer extends InstalledMcpServer {
  botId: string;
}

export type PrivateMcpConnectFn = (server: PrivateMcpServer) => Promise<LazyMcpConnector>;

function defaultConnectFn(pinDbPath?: string): PrivateMcpConnectFn {
  return async (server: PrivateMcpServer): Promise<LazyMcpConnector> => {
    const client = new MCPClient({ serverName: server.label, pinDbPath, elicitation: 'widget' });
    if (server.config.kind === 'http') {
      await client.connectHttp(server.config.url as string);
    } else {
      await client.connectStdio({
        command: server.config.command as string,
        args: server.config.args,
        env: server.config.env,
      });
    }
    return client;
  };
}

interface Row {
  bot_id: string;
  id: string;
  directory_id: string | null;
  label: string;
  kind: string;
  config_json: string;
  enabled: number;
  created_at: string;
}

/** SQLite store for per-bot private MCP server configs. */
export class PerBotMcpStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_mcp_servers (
        bot_id TEXT NOT NULL,
        id TEXT NOT NULL,
        directory_id TEXT,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, id),
        UNIQUE (bot_id, label)
      );
    `);
  }

  private rowToServer(row: Row): PrivateMcpServer {
    const parsed = JSON.parse(row.config_json) as InstalledMcpServerConfig;
    return {
      botId: row.bot_id,
      id: row.id,
      directoryId: row.directory_id,
      label: row.label,
      config: { ...parsed, kind: row.kind as InstalledMcpServerConfig['kind'] },
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    };
  }

  install(
    botId: string,
    directoryId: string | null,
    label: string,
    config: InstalledMcpServerConfig,
  ): PrivateMcpServer {
    validateServerLabel(label);
    validateServerConfig(config);
    const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO bot_mcp_servers (bot_id, id, directory_id, label, kind, config_json, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(botId, id, directoryId, label, config.kind, JSON.stringify(config), createdAt);
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
        throw new Error(`Bot "${botId}" already has a private MCP server labeled "${label}".`);
      }
      throw err;
    }
    return { botId, id, directoryId, label, config, enabled: true, createdAt };
  }

  get(botId: string, id: string): PrivateMcpServer | undefined {
    const row = this.db
      .prepare('SELECT * FROM bot_mcp_servers WHERE bot_id = ? AND id = ?')
      .get(botId, id) as unknown as Row | undefined;
    return row ? this.rowToServer(row) : undefined;
  }

  getByLabel(botId: string, label: string): PrivateMcpServer | undefined {
    const row = this.db
      .prepare('SELECT * FROM bot_mcp_servers WHERE bot_id = ? AND label = ?')
      .get(botId, label) as unknown as Row | undefined;
    return row ? this.rowToServer(row) : undefined;
  }

  listForBot(botId: string): PrivateMcpServer[] {
    const rows = this.db
      .prepare('SELECT * FROM bot_mcp_servers WHERE bot_id = ? ORDER BY created_at ASC')
      .all(botId) as unknown as Row[];
    return rows.map((r) => this.rowToServer(r));
  }

  listBotIds(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT bot_id FROM bot_mcp_servers').all() as unknown as Array<{
      bot_id: string;
    }>;
    return rows.map((r) => r.bot_id);
  }

  updateConfig(botId: string, id: string, config: InstalledMcpServerConfig): PrivateMcpServer {
    validateServerConfig(config);
    const existing = this.get(botId, id);
    if (!existing) throw new Error(`Unknown private MCP server "${id}" for bot "${botId}".`);
    this.db
      .prepare('UPDATE bot_mcp_servers SET kind = ?, config_json = ? WHERE bot_id = ? AND id = ?')
      .run(config.kind, JSON.stringify(config), botId, id);
    return { ...existing, config };
  }

  setEnabled(botId: string, id: string, enabled: boolean): void {
    const res = this.db
      .prepare('UPDATE bot_mcp_servers SET enabled = ? WHERE bot_id = ? AND id = ?')
      .run(enabled ? 1 : 0, botId, id);
    if (res.changes === 0) throw new Error(`Unknown private MCP server "${id}" for bot "${botId}".`);
  }

  remove(botId: string, id: string): void {
    const res = this.db.prepare('DELETE FROM bot_mcp_servers WHERE bot_id = ? AND id = ?').run(botId, id);
    if (res.changes === 0) throw new Error(`Unknown private MCP server "${id}" for bot "${botId}".`);
  }

  removeAllForBot(botId: string): number {
    const res = this.db.prepare('DELETE FROM bot_mcp_servers WHERE bot_id = ?').run(botId);
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Manager: per-bot process lifecycle + tool boundary
// ---------------------------------------------------------------------------

interface ConnectedEntry {
  connector: LazyMcpConnector;
  tools: Map<string, ToolDefinition>;
}

export interface PerBotMcpManagerOptions {
  dataDir: string;
  /** Test seam: build a connected client for the server config. */
  connectFn?: PrivateMcpConnectFn;
  pinDbPath?: string;
}

/** Process-registry key: bot and server are BOTH part of the identity. */
export function privateMcpKey(botId: string, serverId: string): string {
  return `${botId}::${serverId}`;
}

export class PerBotMcpManager {
  readonly store: PerBotMcpStore;
  private readonly connectFn: PrivateMcpConnectFn;
  private readonly connected = new Map<string, ConnectedEntry>();
  private readonly connecting = new Map<string, Promise<ConnectedEntry>>();

  constructor(options: PerBotMcpManagerOptions) {
    this.store = new PerBotMcpStore(`${options.dataDir.replace(/\/$/, '')}/mcp-private.db`);
    this.connectFn = options.connectFn ?? defaultConnectFn(options.pinDbPath);
  }

  // -- installation --------------------------------------------------------

  install(botId: string, label: string, config: InstalledMcpServerConfig): PrivateMcpServer {
    return this.store.install(botId, null, label.trim(), config);
  }

  installFromDirectory(botId: string, entryId: string, label?: string): PrivateMcpServer {
    const entry = getDirectoryEntry(entryId);
    if (!entry) throw new Error(`Unknown MCP directory entry "${entryId}".`);
    return this.store.install(botId, entry.id, (label ?? entry.id).trim(), {
      kind: entry.kind,
      command: entry.command,
      args: entry.args,
    });
  }

  listForBot(botId: string): PrivateMcpServer[] {
    return this.store.listForBot(botId);
  }

  getForBot(botId: string, serverId: string): PrivateMcpServer | undefined {
    return this.store.get(botId, serverId);
  }

  /** Change a server's config: the running process (if any) is torn down; the next tool call respawns with the new config. */
  async updateConfig(
    botId: string,
    serverId: string,
    config: InstalledMcpServerConfig,
  ): Promise<PrivateMcpServer> {
    const updated = this.store.updateConfig(botId, serverId, config);
    await this.disconnect(botId, serverId);
    return updated;
  }

  async setEnabled(botId: string, serverId: string, enabled: boolean): Promise<void> {
    this.store.setEnabled(botId, serverId, enabled);
    if (!enabled) await this.disconnect(botId, serverId);
  }

  async remove(botId: string, serverId: string): Promise<void> {
    await this.disconnect(botId, serverId);
    this.store.remove(botId, serverId);
  }

  /**
   * Bot-deletion hook: kill every process the bot owns and drop its
   * configs. Wired to the API's bot-delete paths; safe to call for bots
   * with no private servers.
   */
  async removeAllForBot(botId: string): Promise<number> {
    const servers = this.store.listForBot(botId);
    await Promise.all(servers.map((s) => this.disconnect(botId, s.id)));
    return this.store.removeAllForBot(botId);
  }

  // -- lazy per-bot connections ---------------------------------------------

  isConnected(botId: string, serverId: string): boolean {
    return this.connected.has(privateMcpKey(botId, serverId));
  }

  /** Keys of live processes, for tests/diagnostics: `${botId}::${serverId}`. */
  connectedKeys(): string[] {
    return [...this.connected.keys()];
  }

  async ensureConnected(botId: string, serverId: string): Promise<ConnectedEntry> {
    const server = this.store.get(botId, serverId);
    if (!server) throw new Error(`Unknown private MCP server "${serverId}" for bot "${botId}".`);
    if (!server.enabled) throw new Error(`Private MCP server "${server.label}" is disabled.`);
    const key = privateMcpKey(botId, serverId);
    const existing = this.connected.get(key);
    if (existing) return existing;
    const inFlight = this.connecting.get(key);
    if (inFlight) return inFlight;
    const p = (async (): Promise<ConnectedEntry> => {
      try {
        const connector = await this.connectFn(server);
        const defs = await connector.listTools();
        const tools = new Map<string, ToolDefinition>();
        for (const def of defs) tools.set(def.name, def);
        const entry: ConnectedEntry = { connector, tools };
        this.connected.set(key, entry);
        return entry;
      } finally {
        this.connecting.delete(key);
      }
    })();
    this.connecting.set(key, p);
    return p;
  }

  async disconnect(botId: string, serverId: string): Promise<void> {
    const key = privateMcpKey(botId, serverId);
    const entry = this.connected.get(key);
    this.connected.delete(key);
    this.connecting.delete(key);
    if (entry) await entry.connector.close().catch(() => undefined);
  }

  /** Tear down every process owned by one bot (shutdown of that bot / delete). */
  async disconnectBot(botId: string): Promise<void> {
    const keys = [...this.connected.keys()].filter((k) => k.startsWith(`${botId}::`));
    await Promise.all(keys.map((k) => this.disconnect(botId, k.slice(botId.length + 2))));
  }

  async close(): Promise<void> {
    const keys = [...this.connected.keys()];
    await Promise.all(
      keys.map((k) => {
        const sep = k.indexOf('::');
        return this.disconnect(k.slice(0, sep), k.slice(sep + 2));
      }),
    );
    this.store.close();
  }

  // -- tool boundary ---------------------------------------------------------

  private async realToolDef(server: PrivateMcpServer, registeredName: string): Promise<ToolDefinition> {
    const entry = await this.ensureConnected(server.botId, server.id);
    const direct = entry.tools.get(registeredName);
    if (direct) return direct;
    const tail = registeredName.split(':').pop() ?? registeredName;
    for (const def of entry.tools.values()) {
      if (def.name === tail || def.name.endsWith(`:${tail}`)) return def;
    }
    throw new Error(`Private MCP server "${server.label}" has no tool "${tail}".`);
  }

  /**
   * Tool definitions for ONE bot: only that bot's enabled private servers.
   * Handlers enforce the boundary again at call time (`ctx.botId` must be
   * the owning bot), so a definition that leaks into another bot's turn
   * still cannot be called by it.
   */
  toolDefinitions(botId: string): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const server of this.store.listForBot(botId)) {
      if (!server.enabled) continue;
      const directoryEntry = server.directoryId ? getDirectoryEntry(server.directoryId) : undefined;
      const declared = directoryEntry?.tools ?? [{ name: 'call', description: `Call ${server.label}` }];
      for (const tool of declared) {
        const registeredName = mcpToolName(server.label, tool.name);
        defs.push({
          name: registeredName,
          description: `${tool.description} [Private MCP server "${server.label}" of bot "${botId}" — starts on first use]`,
          parameters: { type: 'object', properties: {}, additionalProperties: true },
          handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> => {
            if (ctx.botId !== botId) {
              throw new Error(
                `Private MCP server "${server.label}" belongs to bot "${botId}" and cannot be used by bot "${ctx.botId}".`,
              );
            }
            const current = this.store.get(botId, server.id);
            if (!current) throw new Error(`Private MCP server "${server.label}" was removed.`);
            if (!current.enabled) throw new Error(`Private MCP server "${server.label}" is disabled.`);
            const real = await this.realToolDef(current, registeredName);
            return real.handler(args, ctx);
          },
        });
      }
    }
    return defs;
  }

  /** Tool names visible to a bot (its own private servers only). */
  toolNamesForBot(botId: string): string[] {
    return this.toolDefinitions(botId).map((d) => d.name);
  }
}
