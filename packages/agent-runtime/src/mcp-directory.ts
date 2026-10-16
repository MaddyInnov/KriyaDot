// SPDX-License-Identifier: Apache-2.0
// Lazy MCP directory (OpenMausBot parity P1 #22).
//
// A curated, in-app directory of MCP servers. Installing an entry registers
// its config WITHOUT spawning anything: no package is fetched and no
// process starts until a bot actually calls one of the server's tools, at
// which point the server connects on demand (lazy startup). Disabled servers
// never spawn.
//
// The directory declares each server's tool surface up front so the agent
// tool registry can list `mcp:<server>:<tool>` stubs. The stub handler
// connects the real server on first call and delegates — tool schemas then
// come from the live server (with the existing TOFU pin/approval machinery
// in mcp.ts applying as usual).

import { MCPClient, mcpToolName } from './mcp.js';
import type { ToolContext, ToolDefinition } from './types.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

export interface MCPDirectoryToolDecl {
  name: string;
  description: string;
}

export interface MCPDirectoryEntry {
  /** Stable id, e.g. "filesystem". Also the default install label. */
  id: string;
  name: string;
  description: string;
  category: 'files' | 'web' | 'dev' | 'data' | 'browser' | 'ai';
  kind: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** Env vars the server needs (shown before install; never stored here). */
  needsEnv?: string[];
  /** Human-readable permission surface shown in the UI. */
  permissions: string[];
  /** Declared tool surface used to register lazy stubs. */
  tools: MCPDirectoryToolDecl[];
}

// Curated directory. Original descriptions; commands are the servers'
// standard published invocations.
export const MCP_DIRECTORY: MCPDirectoryEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and organize files in folders you approve at install time.',
    category: 'files',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    permissions: ['read local files', 'write local files'],
    tools: [
      { name: 'read_file', description: 'Read a file from disk.' },
      { name: 'write_file', description: 'Write a file to disk.' },
      { name: 'list_directory', description: 'List files in a directory.' },
      { name: 'create_directory', description: 'Create a directory.' },
      { name: 'move_file', description: 'Move or rename a file.' },
      { name: 'search_files', description: 'Search files by name pattern.' },
      { name: 'get_file_info', description: 'File size and modification info.' },
    ],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch web pages and convert them to readable text for the agent.',
    category: 'web',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    permissions: ['network access'],
    tools: [{ name: 'fetch', description: 'Fetch a URL and return its content as markdown.' }],
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Inspect and operate on git repositories: status, diff, log, commits.',
    category: 'dev',
    kind: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    permissions: ['execute git commands', 'read/write repository files'],
    tools: [
      { name: 'git_status', description: 'Show the working-tree status.' },
      { name: 'git_diff', description: 'Show changes between commits or the working tree.' },
      { name: 'git_log', description: 'Show commit history.' },
      { name: 'git_commit', description: 'Create a commit.' },
      { name: 'git_add', description: 'Stage files.' },
      { name: 'git_branch', description: 'List or create branches.' },
    ],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A persistent knowledge graph the agent can store entities and facts in.',
    category: 'ai',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    permissions: ['local knowledge-graph storage'],
    tools: [
      { name: 'create_entities', description: 'Create entities in the knowledge graph.' },
      { name: 'create_relations', description: 'Create relations between entities.' },
      { name: 'add_observations', description: 'Add observations to entities.' },
      { name: 'read_graph', description: 'Read the whole knowledge graph.' },
      { name: 'search_nodes', description: 'Search entities by name.' },
    ],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage local SQLite databases with read and write queries.',
    category: 'data',
    kind: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    permissions: ['read/write local SQLite databases'],
    tools: [
      { name: 'read_query', description: 'Run a SELECT query.' },
      { name: 'write_query', description: 'Run an INSERT/UPDATE/DELETE query.' },
      { name: 'create_table', description: 'Create a table.' },
      { name: 'list_tables', description: 'List tables in the database.' },
      { name: 'describe_table', description: 'Show a table schema.' },
    ],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning tool for breaking down hard problems.',
    category: 'ai',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    permissions: [],
    tools: [{ name: 'sequentialthinking', description: 'Think through a problem step by step.' }],
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Current time and timezone conversions.',
    category: 'ai',
    kind: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    permissions: [],
    tools: [
      { name: 'get_current_time', description: 'Get the current time in a timezone.' },
      { name: 'convert_time', description: 'Convert a time between timezones.' },
    ],
  },
  {
    id: 'playwright',
    name: 'Playwright Browser',
    description: 'Drive a real browser: navigate, click, type, and screenshot pages.',
    category: 'browser',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    permissions: ['control a browser', 'network access'],
    tools: [
      { name: 'browser_navigate', description: 'Navigate to a URL.' },
      { name: 'browser_snapshot', description: 'Capture the page accessibility snapshot.' },
      { name: 'browser_click', description: 'Click an element.' },
      { name: 'browser_type', description: 'Type into an element.' },
      { name: 'browser_screenshot', description: 'Take a page screenshot.' },
    ],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search via the Brave Search API.',
    category: 'web',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    needsEnv: ['BRAVE_API_KEY'],
    permissions: ['network access'],
    tools: [
      { name: 'brave_web_search', description: 'Search the web.' },
      { name: 'brave_local_search', description: 'Search local businesses and places.' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Work with GitHub repos, issues, and pull requests as your GitHub user.',
    category: 'dev',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    needsEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    permissions: ['network access', 'act as your GitHub user'],
    tools: [
      { name: 'create_or_update_file', description: 'Create or update a file in a repo.' },
      { name: 'search_repositories', description: 'Search GitHub repositories.' },
      { name: 'create_issue', description: 'Open an issue.' },
      { name: 'list_issues', description: 'List issues in a repo.' },
      { name: 'create_pull_request', description: 'Open a pull request.' },
    ],
  },
];

export function getDirectoryEntry(id: string): MCPDirectoryEntry | undefined {
  return MCP_DIRECTORY.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------
// Installed-server store
// ---------------------------------------------------------------------------

export type InstalledServerKind = 'stdio' | 'http';

export interface InstalledMcpServerConfig {
  kind: InstalledServerKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  oauth?: boolean;
}

export interface InstalledMcpServer {
  id: string;
  /** Directory entry id, or null for custom installs. */
  directoryId: string | null;
  /** Registry label: the `<server>` segment of `mcp:<server>:<tool>`. */
  label: string;
  config: InstalledMcpServerConfig;
  enabled: boolean;
  createdAt: string;
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function validateServerLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `Invalid MCP server label "${label}": use 1-64 chars, letters/numbers/_/-, starting with a letter or number.`,
    );
  }
}

export function validateServerConfig(config: InstalledMcpServerConfig): void {
  if (config.kind === 'stdio') {
    if (!config.command || typeof config.command !== 'string' || !config.command.trim()) {
      throw new Error('MCP server config needs a "command" for stdio servers.');
    }
  } else if (config.kind === 'http') {
    if (!config.url || typeof config.url !== 'string') {
      throw new Error('MCP server config needs a "url" for http servers.');
    }
    try {
      const u = new URL(config.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
    } catch {
      throw new Error(`Invalid MCP server URL "${config.url}".`);
    }
  } else {
    throw new Error('MCP server kind must be "stdio" or "http".');
  }
}

export class LazyMcpServerStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_installed_servers (
        id TEXT PRIMARY KEY,
        directory_id TEXT,
        label TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_server_bots (
        server_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (server_id, bot_id)
      );
    `);
  }

  private rowToServer(row: {
    id: string;
    directory_id: string | null;
    label: string;
    kind: string;
    config_json: string;
    enabled: number;
    created_at: string;
  }): InstalledMcpServer {
    const parsed = JSON.parse(row.config_json) as InstalledMcpServerConfig;
    return {
      id: row.id,
      directoryId: row.directory_id,
      label: row.label,
      config: { ...parsed, kind: row.kind as InstalledServerKind },
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    };
  }

  install(directoryId: string | null, label: string, config: InstalledMcpServerConfig): InstalledMcpServer {
    validateServerLabel(label);
    validateServerConfig(config);
    const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO mcp_installed_servers (id, directory_id, label, kind, config_json, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(id, directoryId, label, config.kind, JSON.stringify(config), createdAt);
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
        throw new Error(`An MCP server labeled "${label}" is already installed.`);
      }
      throw err;
    }
    return { id, directoryId, label, config, enabled: true, createdAt };
  }

  get(id: string): InstalledMcpServer | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_installed_servers WHERE id = ?').get(id) as
      | Parameters<LazyMcpServerStore['rowToServer']>[0]
      | undefined;
    return row ? this.rowToServer(row) : undefined;
  }

  list(): InstalledMcpServer[] {
    const rows = this.db.prepare('SELECT * FROM mcp_installed_servers ORDER BY created_at ASC').all() as Array<
      Parameters<LazyMcpServerStore['rowToServer']>[0]
    >;
    return rows.map((r) => this.rowToServer(r));
  }

  setEnabled(id: string, enabled: boolean): void {
    const res = this.db.prepare('UPDATE mcp_installed_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (res.changes === 0) throw new Error(`Unknown MCP server "${id}".`);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM mcp_server_bots WHERE server_id = ?').run(id);
    const res = this.db.prepare('DELETE FROM mcp_installed_servers WHERE id = ?').run(id);
    if (res.changes === 0) throw new Error(`Unknown MCP server "${id}".`);
  }

  /** Per-bot override. Default (no row) = enabled for all bots. */
  setBotEnabled(serverId: string, botId: string, enabled: boolean): void {
    if (!this.get(serverId)) throw new Error(`Unknown MCP server "${serverId}".`);
    this.db
      .prepare(
        `INSERT INTO mcp_server_bots (server_id, bot_id, enabled) VALUES (?, ?, ?)
         ON CONFLICT (server_id, bot_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(serverId, botId, enabled ? 1 : 0);
  }

  clearBotOverride(serverId: string, botId: string): void {
    this.db.prepare('DELETE FROM mcp_server_bots WHERE server_id = ? AND bot_id = ?').run(serverId, botId);
  }

  isBotAllowed(serverId: string, botId: string): boolean {
    const row = this.db
      .prepare('SELECT enabled FROM mcp_server_bots WHERE server_id = ? AND bot_id = ?')
      .get(serverId, botId) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  botOverrides(serverId: string): Array<{ botId: string; enabled: boolean }> {
    const rows = this.db
      .prepare('SELECT bot_id, enabled FROM mcp_server_bots WHERE server_id = ?')
      .all(serverId) as Array<{ bot_id: string; enabled: number }>;
    return rows.map((r) => ({ botId: r.bot_id, enabled: r.enabled === 1 }));
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Lazy manager: stubs in the registry, real connect on first tool call
// ---------------------------------------------------------------------------

export type McpServerHealth = 'stopped' | 'starting' | 'running' | 'error';

/** Minimal surface the manager needs from a connected MCP client. */
export interface LazyMcpConnector {
  listTools(): Promise<ToolDefinition[]>;
  close(): Promise<void>;
}

export type LazyMcpConnectFn = (server: InstalledMcpServer) => Promise<LazyMcpConnector>;

export interface LazyMcpManagerOptions {
  dataDir: string;
  /** Test seam: build a connected client for the server config. */
  connectFn?: LazyMcpConnectFn;
  /** Passed through to the default real-client connector (TOFU pinning). */
  pinDbPath?: string;
}

function defaultConnectFn(pinDbPath?: string): LazyMcpConnectFn {
  return async (server: InstalledMcpServer): Promise<LazyMcpConnector> => {
    const client = new MCPClient({ serverName: server.label, pinDbPath });
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

interface ConnectedEntry {
  connector: LazyMcpConnector;
  tools: Map<string, ToolDefinition>;
}

export class LazyMcpManager {
  readonly store: LazyMcpServerStore;
  private readonly connectFn: LazyMcpConnectFn;
  private readonly connected = new Map<string, ConnectedEntry>();
  private readonly health = new Map<string, { status: McpServerHealth; lastError: string | null }>();
  private readonly connecting = new Map<string, Promise<ConnectedEntry>>();
  /** Exact stub names this manager has placed in the shared registry. */
  private readonly stubNames = new Set<string>();

  constructor(options: LazyMcpManagerOptions) {
    this.store = new LazyMcpServerStore(`${options.dataDir.replace(/\/$/, '')}/mcp-directory.db`);
    this.connectFn = options.connectFn ?? defaultConnectFn(options.pinDbPath);
  }

  // -- installation ----------------------------------------------------------

  installFromDirectory(entryId: string, label?: string): InstalledMcpServer {
    const entry = getDirectoryEntry(entryId);
    if (!entry) throw new Error(`Unknown MCP directory entry "${entryId}".`);
    const finalLabel = (label ?? entry.id).trim();
    const installed = this.store.install(entry.id, finalLabel, {
      kind: entry.kind,
      command: entry.command,
      args: entry.args,
    });
    return installed;
  }

  installCustom(label: string, config: InstalledMcpServerConfig): InstalledMcpServer {
    return this.store.install(null, label.trim(), config);
  }

  uninstall(id: string): void {
    void this.disconnect(id).catch(() => undefined);
    this.store.remove(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.store.setEnabled(id, enabled);
    if (!enabled) void this.disconnect(id).catch(() => undefined);
  }

  setBotEnabled(serverId: string, botId: string, enabled: boolean): void {
    this.store.setBotEnabled(serverId, botId, enabled);
  }

  clearBotOverride(serverId: string, botId: string): void {
    this.store.clearBotOverride(serverId, botId);
  }

  list(): InstalledMcpServer[] {
    return this.store.list();
  }

  status(id: string): { status: McpServerHealth; lastError: string | null } {
    return this.health.get(id) ?? { status: 'stopped', lastError: null };
  }

  directoryWithInstallState(): Array<MCPDirectoryEntry & { installed: boolean; serverId: string | null }> {
    const installed = this.store.list();
    return MCP_DIRECTORY.map((entry) => {
      const match = installed.find((s) => s.directoryId === entry.id);
      return { ...entry, installed: !!match, serverId: match ? match.id : null };
    });
  }

  // -- lazy connection -------------------------------------------------------

  private setHealth(id: string, status: McpServerHealth, lastError: string | null = null): void {
    this.health.set(id, { status, lastError });
  }

  async ensureConnected(id: string): Promise<ConnectedEntry> {
    const server = this.store.get(id);
    if (!server) throw new Error(`Unknown MCP server "${id}".`);
    if (!server.enabled) throw new Error(`MCP server "${server.label}" is disabled.`);
    const existing = this.connected.get(id);
    if (existing) return existing;
    const inFlight = this.connecting.get(id);
    if (inFlight) return inFlight;
    const p = (async (): Promise<ConnectedEntry> => {
      this.setHealth(id, 'starting');
      try {
        const connector = await this.connectFn(server);
        const defs = await connector.listTools();
        const tools = new Map<string, ToolDefinition>();
        for (const def of defs) tools.set(def.name, def);
        const entry: ConnectedEntry = { connector, tools };
        this.connected.set(id, entry);
        this.setHealth(id, 'running');
        return entry;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setHealth(id, 'error', message);
        throw new Error(`MCP server "${server.label}" failed to start: ${message}`);
      } finally {
        this.connecting.delete(id);
      }
    })();
    this.connecting.set(id, p);
    return p;
  }

  /** Manually warm a server (connect now instead of on first tool call). */
  async warmUp(id: string): Promise<void> {
    await this.ensureConnected(id);
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.connected.get(id);
    this.connected.delete(id);
    this.connecting.delete(id);
    this.setHealth(id, 'stopped');
    if (entry) await entry.connector.close().catch(() => undefined);
  }

  /** Find the real (post-connect) tool def for a stub tool name. */
  private async realToolDef(server: InstalledMcpServer, registeredName: string): Promise<ToolDefinition> {
    const entry = await this.ensureConnected(server.id);
    // Real defs are registered as `mcp:<label>:<tool>` by MCPClient when
    // constructed with serverName — match directly first.
    const direct = entry.tools.get(registeredName);
    if (direct) return direct;
    // Fallback: match by trailing tool segment (SDK version differences).
    const tail = registeredName.split(':').pop() ?? registeredName;
    for (const def of entry.tools.values()) {
      if (def.name === tail || def.name.endsWith(`:${tail}`)) return def;
    }
    throw new Error(`MCP server "${server.label}" has no tool "${tail}".`);
  }

  /**
   * Tool definitions for the agent registry. Enabled installed servers get
   * lazy stubs named `mcp:<label>:<tool>`; the handler connects the real
   * server on first call and delegates. Disabled servers (or servers the
   * bot is not allowed) are simply absent.
   */
  stubToolDefinitions(botId?: string): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const server of this.store.list()) {
      if (!server.enabled) continue;
      if (botId && !this.store.isBotAllowed(server.id, botId)) continue;
      const directoryEntry = server.directoryId ? getDirectoryEntry(server.directoryId) : undefined;
      const declared = directoryEntry?.tools ?? [{ name: 'call', description: `Call ${server.label}` }];
      for (const tool of declared) {
        const registeredName = mcpToolName(server.label, tool.name);
        defs.push({
          name: registeredName,
          description: `${tool.description} [MCP server "${server.label}" — starts on first use]`,
          parameters: { type: 'object', properties: {}, additionalProperties: true },
          handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> => {
            const current = this.store.get(server.id);
            if (!current) throw new Error(`MCP server "${server.label}" was uninstalled.`);
            if (!current.enabled) throw new Error(`MCP server "${server.label}" is disabled.`);
            if (!this.store.isBotAllowed(server.id, ctx.botId)) {
              throw new Error(`MCP server "${server.label}" is not enabled for this bot.`);
            }
            const real = await this.realToolDef(current, registeredName);
            return real.handler(args, ctx);
          },
        });
      }
    }
    return defs;
  }

  /**
   * Reconcile lazy stub defs with a shared tool registry (called at boot and
   * after install/enable/disable/uninstall). Removes stubs whose server is
   * gone or disabled, adds stubs for newly enabled servers. Name collisions
   * with non-lazy tools are never overwritten.
   */
  syncRegistry(registry: Map<string, ToolDefinition>): void {
    const wanted = new Map<string, ToolDefinition>();
    for (const def of this.stubToolDefinitions()) wanted.set(def.name, def);
    // Remove only stubs this manager previously placed (never seed MCP tools
    // or anything else that happens to share the mcp: prefix).
    for (const name of [...this.stubNames]) {
      if (!wanted.has(name)) {
        if (registry.get(name) && this.stubNames.has(name)) registry.delete(name);
        this.stubNames.delete(name);
      }
    }
    for (const [name, def] of wanted) {
      if (!registry.has(name)) {
        registry.set(name, def);
        this.stubNames.add(name);
      }
    }
  }

  async close(): Promise<void> {
    const ids = [...this.connected.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
    this.store.close();
  }
}
