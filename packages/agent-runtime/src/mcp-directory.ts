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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCPClient, mcpToolName } from './mcp.js';
import { didYouMeanSuffix } from './tool-hints.js';
import {
  isToolAllowedByFilter,
  parseServerToolFilter,
  type McpServerToolFilter,
} from './mcp-scopes.js';
import type { ToolContext, ToolDefinition } from './types.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

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
    // The official Fetch MCP server is a Python package run via uvx
    // (like mcp-server-git below). The previously listed npm package
    // '@modelcontextprotocol/server-fetch' does not exist — npx 404'd
    // on every install/boot (QA 2026-10-30).
    command: 'uvx',
    args: ['mcp-server-fetch'],
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
  /**
   * Environment gating (Octomind parity #123): env keys this server
   * needs in order to work (e.g. an API token). A server whose required
   * keys are missing is SKIPPED — it gets no registry stubs and is never
   * spawned — instead of failing at call time. A key counts as present
   * when it is set (non-empty) in the host environment OR in this
   * config's own `env` record. Directory installs inherit the entry's
   * `needsEnv` as `requiredEnv`.
   */
  requiredEnv?: string[];
}

/** Env source for requiredEnv checks: a plain key→value record. */
export type McpEnvSource = Record<string, string | undefined>;

/**
 * The `requiredEnv` keys a server config is missing (#123). Shared
 * helper: the lazy manager gates on it, and host surfaces use it to
 * explain WHY a server is skipped. A key is satisfied by a non-empty
 * value in `env` (default process.env) or in the config's `env` record.
 */
export function missingRequiredEnv(
  config: InstalledMcpServerConfig,
  env: McpEnvSource = process.env,
): string[] {
  const required = config.requiredEnv ?? [];
  return required.filter((key) => {
    const fromEnv = env[key];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return false;
    const fromConfig = config.env?.[key];
    if (typeof fromConfig === 'string' && fromConfig.trim()) return false;
    return true;
  });
}

/** True when the server must be skipped because required env keys are missing (#123). */
export function isEnvGated(config: InstalledMcpServerConfig, env: McpEnvSource = process.env): boolean {
  return missingRequiredEnv(config, env).length > 0;
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
    this.db = openDb(dbPath);
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
      CREATE TABLE IF NOT EXISTS mcp_server_tool_filters (
        label TEXT PRIMARY KEY,
        filter_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_active_capabilities (
        server_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        activations INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // -- active-capability set (Octomind parity #140) -------------------------
  //
  // The set of capabilities (MCP servers) that have been activated in
  // this workspace, persisted so the LRU order survives restarts: a
  // server that was used recently keeps its place across a reboot, and
  // a long-idle one is the first eviction candidate when the manager
  // re-opens. Connection state itself is NOT persisted (a restart has
  // no live connections); what persists is the usage bookkeeping the
  // eviction policy reads.

  /** Record (or refresh) a server's activation in the persistent set. */
  recordActivation(serverId: string, label: string, atMs: number): void {
    this.db
      .prepare(
        `INSERT INTO mcp_active_capabilities (server_id, label, last_used_at, activations)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(server_id) DO UPDATE SET
           label = excluded.label,
           last_used_at = excluded.last_used_at,
           activations = mcp_active_capabilities.activations + 1`,
      )
      .run(serverId, label, atMs);
  }

  /** Refresh a server's last-used timestamp without counting an activation. */
  touchActiveCapability(serverId: string, atMs: number): void {
    this.db
      .prepare('UPDATE mcp_active_capabilities SET last_used_at = ? WHERE server_id = ?')
      .run(atMs, serverId);
  }

  /** The persisted active-capability set, most-recently-used first. */
  listActiveCapabilities(): Array<{
    serverId: string;
    label: string;
    lastUsedAt: number;
    activations: number;
  }> {
    const rows = this.db
      .prepare(
        'SELECT server_id, label, last_used_at, activations FROM mcp_active_capabilities ORDER BY last_used_at DESC',
      )
      .all() as unknown as Array<{
      server_id: string;
      label: string;
      last_used_at: number;
      activations: number;
    }>;
    return rows.map((r) => ({
      serverId: r.server_id,
      label: r.label,
      lastUsedAt: r.last_used_at,
      activations: r.activations,
    }));
  }

  /** Drop a server from the persistent active set (uninstall / eviction bookkeeping). */
  removeActiveCapability(serverId: string): void {
    this.db.prepare('DELETE FROM mcp_active_capabilities WHERE server_id = ?').run(serverId);
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

  /** Look up an installed server by its registry label. */
  findByLabel(label: string): InstalledMcpServer | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_installed_servers WHERE label = ?').get(label) as
      | Parameters<LazyMcpServerStore['rowToServer']>[0]
      | undefined;
    return row ? this.rowToServer(row) : undefined;
  }

  /**
   * Replace an installed server's config in place (used by the override
   * file layer, #54). Label/directory/createdAt are preserved.
   */
  updateConfig(id: string, config: InstalledMcpServerConfig): InstalledMcpServer {
    validateServerConfig(config);
    const res = this.db
      .prepare('UPDATE mcp_installed_servers SET kind = ?, config_json = ? WHERE id = ?')
      .run(config.kind, JSON.stringify(config), id);
    if (res.changes === 0) throw new Error(`Unknown MCP server "${id}".`);
    return this.get(id)!;
  }

  /** Persist a per-server tool filter (#55), keyed by server label. */
  setToolFilter(label: string, filter: McpServerToolFilter): void {
    const clean = parseServerToolFilter(filter);
    this.db
      .prepare(
        `INSERT INTO mcp_server_tool_filters (label, filter_json) VALUES (?, ?)
         ON CONFLICT (label) DO UPDATE SET filter_json = excluded.filter_json`,
      )
      .run(label, JSON.stringify(clean));
  }

  getToolFilter(label: string): McpServerToolFilter | undefined {
    const row = this.db.prepare('SELECT filter_json FROM mcp_server_tool_filters WHERE label = ?').get(label) as
      | { filter_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return parseServerToolFilter(JSON.parse(row.filter_json));
    } catch {
      return undefined;
    }
  }

  clearToolFilter(label: string): void {
    this.db.prepare('DELETE FROM mcp_server_tool_filters WHERE label = ?').run(label);
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
// MCP override files (Octomind parity #54)
// ---------------------------------------------------------------------------
//
// A workspace can drop `mcp-<name>.json` files into its config dir (the
// host passes `<workspaceDir>/.kriyadot/` — the same dir that holds the
// guardrails `policy.json`). The format matches the seed `mcp.json`
// format (JSON, since the tree's MCP config is JSON): the file body is
// either a bare server config —
//
//   { "command": "uvx", "args": ["mcp-server-fetch"], "env": { "X": "1" } }
//   { "url": "https://mcp.example.com/mcp", "oauth": true }
//
// — or the seed-shaped wrapper `{ "mcpServers": { "<name>": { ... } } }`.
// An optional `"enabled": false` field disables the server.
//
// Layering: the override is merged OVER the installed server's config,
// per top-level field — a field present in the override wins, fields it
// omits keep the base value. When no server labeled `<name>` is
// installed yet, a COMPLETE override config auto-binds: the server is
// installed (persisted) from the override alone. An incomplete override
// for an unknown server is an error, not a silent skip.

export interface McpServerOverride {
  /** Server label taken from the file name (`mcp-<name>.json` → `<name>`). */
  name: string;
  /** Partial config; only the fields the file actually sets. */
  config: Partial<InstalledMcpServerConfig>;
  enabled?: boolean;
  sourcePath: string;
}

const OVERRIDE_FILE_RE = /^mcp-(.+)\.json$/;
const OVERRIDE_CONFIG_FIELDS = ['kind', 'command', 'args', 'env', 'url', 'oauth', 'requiredEnv'] as const;

/** Parse one override file body (already JSON-parsed) for server `name`. */
export function parseMcpOverride(name: string, body: unknown, sourcePath = ''): McpServerOverride {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`MCP override "${sourcePath || name}" must be a JSON object.`);
  }
  let raw = body as Record<string, unknown>;
  // Seed-shaped wrapper: { mcpServers: { <name>: {...} } }.
  if (typeof raw.mcpServers === 'object' && raw.mcpServers !== null) {
    const inner = (raw.mcpServers as Record<string, unknown>)[name];
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
      throw new Error(`MCP override "${sourcePath}" has no "mcpServers.${name}" entry matching its file name.`);
    }
    raw = inner as Record<string, unknown>;
  }
  const config: Partial<InstalledMcpServerConfig> = {};
  for (const field of OVERRIDE_CONFIG_FIELDS) {
    if (raw[field] !== undefined) {
      (config as Record<string, unknown>)[field] = raw[field];
    }
  }
  // A bare stdio/http config without an explicit kind: infer it from the
  // discriminating field, matching how the seed loader reads mcp.json.
  if (config.kind === undefined) {
    if (typeof config.url === 'string') config.kind = 'http';
    else if (typeof config.command === 'string') config.kind = 'stdio';
  }
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  return { name, config, enabled, sourcePath };
}

/** Discover + parse every `mcp-<name>.json` override in a config dir. Missing dir → no overrides. */
export function loadMcpOverrideFiles(configDir: string): McpServerOverride[] {
  if (!configDir || !existsSync(configDir)) return [];
  const out: McpServerOverride[] = [];
  for (const file of readdirSync(configDir).sort()) {
    const m = OVERRIDE_FILE_RE.exec(file);
    if (!m) continue;
    const name = m[1]!;
    const sourcePath = join(configDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
    } catch (err) {
      throw new Error(
        `MCP override file "${sourcePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    out.push(parseMcpOverride(name, parsed, sourcePath));
  }
  return out;
}

/**
 * Layer an override config over a base config, per top-level field:
 * every field the override sets wins; omitted fields keep base values.
 */
export function mergeServerConfig(
  base: InstalledMcpServerConfig,
  override: Partial<InstalledMcpServerConfig>,
): InstalledMcpServerConfig {
  const merged: InstalledMcpServerConfig = { ...base };
  const target = merged as unknown as Record<string, unknown>;
  for (const field of OVERRIDE_CONFIG_FIELDS) {
    if (override[field] !== undefined) {
      target[field] = override[field];
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Lazy manager: stubs in the registry, real connect on first tool call
// ---------------------------------------------------------------------------

/**
 * Health probe interval (Octomind parity #56): connected servers are
 * probed every 120 s by default.
 */
export const MCP_HEALTH_CHECK_INTERVAL_MS = 120_000;

/**
 * Server health. `failed` (#56) is TERMINAL: the server failed a probe
 * AND its single auto-restart attempt failed. Failed servers leave the
 * probe set (they are disconnected) but remain installed/listed with
 * their failure reason, and can be revived by a manual restart.
 */
export type McpServerHealth = 'stopped' | 'starting' | 'running' | 'error' | 'failed';

/** Minimal surface the manager needs from a connected MCP client. */
export interface LazyMcpConnector {
  listTools(): Promise<ToolDefinition[]>;
  close(): Promise<void>;
  /** Optional liveness probe for the health monitor. */
  ping?: () => Promise<void>;
}

export type LazyMcpConnectFn = (server: InstalledMcpServer) => Promise<LazyMcpConnector>;

/** Extended per-server health record (Octomind parity: MCP health monitor). */
export interface McpServerHealthRecord {
  status: McpServerHealth;
  lastError: string | null;
  /** Successful automatic restarts since this manager started. */
  restarts: number;
  /** ISO timestamp of the last completed health probe, when any. */
  lastCheckAt: string | null;
}

export interface LazyMcpManagerOptions {
  dataDir: string;
  /** Test seam: build a connected client for the server config. */
  connectFn?: LazyMcpConnectFn;
  /** Passed through to the default real-client connector (TOFU pinning). */
  pinDbPath?: string;
  /**
   * Health monitor (Octomind parity #56): probe connected servers every
   * interval and auto-restart dead ones. Default
   * MCP_HEALTH_CHECK_INTERVAL_MS (120s); 0 disables the timer
   * (checkHealthOnce stays callable, e.g. from tests).
   */
  healthCheckIntervalMs?: number;
  /** Per-probe timeout. Default 5s. */
  healthPingTimeoutMs?: number;
  /** Restart a server whose probe fails (default true). */
  autoRestart?: boolean;
  /**
   * Workspace config dir holding `mcp-<name>.json` override files (#54).
   * When set, overrides are discovered and applied (layered + auto-bind)
   * during construction. Unset → no override layer (previous behavior).
   */
  overrideConfigDir?: string;
  /** Clock injection for health timestamps (tests); default Date.now. */
  now?: () => number;
  /**
   * Env source for `requiredEnv` gating (#123); default process.env.
   * Tests inject a plain record.
   */
  env?: McpEnvSource;
  /**
   * Soft cap on simultaneously ACTIVE (connected) capabilities
   * (Octomind parity #140). When a new activation would exceed the cap,
   * the least-recently-used IDLE connection (no in-flight tool calls)
   * is evicted (disconnected). Busy connections are never evicted, so
   * the cap is soft: if every active server is mid-call the new one
   * still connects. Default DEFAULT_MAX_ACTIVE_MCP_CAPABILITIES.
   */
  maxActiveCapabilities?: number;
}

/**
 * Default soft cap on simultaneously active MCP capabilities (#140).
 */
export const DEFAULT_MAX_ACTIVE_MCP_CAPABILITIES = 8;

/** One entry of the manager's active-capability view (#140). */
export interface ActiveCapabilityInfo {
  serverId: string;
  label: string;
  /** Epoch ms of last activation or completed tool call. */
  lastUsedAt: number;
  /** Activations recorded in the persistent set (survives restarts). */
  activations: number;
  /** Tool calls currently executing against this server (refcount). */
  inFlight: number;
  /** Whether the server currently holds a live connection. */
  connected: boolean;
}

function defaultConnectFn(pinDbPath?: string): LazyMcpConnectFn {
  return async (server: InstalledMcpServer): Promise<LazyMcpConnector> => {
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

interface ConnectedEntry {
  connector: LazyMcpConnector;
  tools: Map<string, ToolDefinition>;
}

export class LazyMcpManager {
  readonly store: LazyMcpServerStore;
  private readonly connectFn: LazyMcpConnectFn;
  private readonly connected = new Map<string, ConnectedEntry>();
  private readonly health = new Map<string, McpServerHealthRecord>();
  private readonly connecting = new Map<string, Promise<ConnectedEntry>>();
  /** Exact stub names this manager has placed in the shared registry. */
  private readonly stubNames = new Set<string>();
  private readonly healthPingTimeoutMs: number;
  private readonly autoRestart: boolean;
  private readonly nowFn: () => number;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** Env source for requiredEnv gating (#123). */
  private readonly envSource: McpEnvSource;
  /** Soft cap on active (connected) capabilities (#140). */
  readonly maxActiveCapabilities: number;
  /** In-flight tool-call refcounts per server id (#140 eviction guard). */
  private readonly inFlight = new Map<string, number>();
  /** Last-used timestamps (epoch ms) per server id, seeded from the persistent set (#140). */
  private readonly lastUsedAt = new Map<string, number>();

  constructor(options: LazyMcpManagerOptions) {
    this.store = new LazyMcpServerStore(`${options.dataDir.replace(/\/$/, '')}/mcp-directory.db`);
    this.connectFn = options.connectFn ?? defaultConnectFn(options.pinDbPath);
    this.healthPingTimeoutMs = options.healthPingTimeoutMs ?? 5_000;
    this.autoRestart = options.autoRestart ?? true;
    this.nowFn = options.now ?? (() => Date.now());
    this.envSource = options.env ?? process.env;
    this.maxActiveCapabilities = Math.max(1, options.maxActiveCapabilities ?? DEFAULT_MAX_ACTIVE_MCP_CAPABILITIES);
    // #140: seed LRU order from the persistent active set so eviction
    // order is stable across restarts.
    for (const row of this.store.listActiveCapabilities()) {
      this.lastUsedAt.set(row.serverId, row.lastUsedAt);
    }
    const interval = options.healthCheckIntervalMs ?? MCP_HEALTH_CHECK_INTERVAL_MS;
    if (interval > 0) this.startHealthMonitor(interval);
    if (options.overrideConfigDir) {
      // #54: override files layer over (and can auto-bind) installed
      // servers at boot. Malformed overrides fail loud — a silently
      // ignored override would run a server with the wrong config.
      this.applyOverrideFiles(options.overrideConfigDir);
    }
  }

  private nowIso(): string {
    return new Date(this.nowFn()).toISOString();
  }

  // -- env gating (Octomind parity #123) -------------------------------------

  /**
   * The requiredEnv keys this server is missing, or [] when it may run.
   * Gated servers are skipped entirely: no stubs are registered for
   * them and ensureConnected refuses to spawn them — the capability is
   * absent, not call-time-broken.
   */
  envGate(server: InstalledMcpServer): { gated: boolean; missing: string[] } {
    const missing = missingRequiredEnv(server.config, this.envSource);
    return { gated: missing.length > 0, missing };
  }

  // -- active-capability set: LRU + refcount eviction (#140) -----------------

  /**
   * The active-capability set: every server with persistent usage
   * bookkeeping, most-recently-used first, annotated with live
   * connection/refcount state.
   */
  activeCapabilities(): ActiveCapabilityInfo[] {
    const persisted = new Map(this.store.listActiveCapabilities().map((r) => [r.serverId, r]));
    const ids = new Set<string>([...persisted.keys(), ...this.connected.keys()]);
    const out: ActiveCapabilityInfo[] = [];
    for (const id of ids) {
      const server = this.store.get(id);
      const row = persisted.get(id);
      out.push({
        serverId: id,
        label: server?.label ?? row?.label ?? id,
        lastUsedAt: this.lastUsedAt.get(id) ?? row?.lastUsedAt ?? 0,
        activations: row?.activations ?? 0,
        inFlight: this.inFlight.get(id) ?? 0,
        connected: this.connected.has(id),
      });
    }
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** Mark a server active (just connected): persist + refresh LRU position. */
  private activateCapability(server: InstalledMcpServer): void {
    const at = this.nowFn();
    this.lastUsedAt.set(server.id, at);
    this.store.recordActivation(server.id, server.label, at);
  }

  /** Refresh a server's LRU position after a completed tool call. */
  private touchCapability(serverId: string): void {
    const at = this.nowFn();
    this.lastUsedAt.set(serverId, at);
    this.store.touchActiveCapability(serverId, at);
  }

  /**
   * Evict least-recently-used IDLE connections until the connected set
   * is within the soft cap. The just-activated server and any server
   * with in-flight calls are never evicted; if nothing is evictable
   * the cap is exceeded (soft) rather than breaking a live call.
   */
  private async evictOverCap(protectedId: string): Promise<void> {
    while (this.connected.size > this.maxActiveCapabilities) {
      let victim: string | null = null;
      let victimAt = Number.POSITIVE_INFINITY;
      for (const id of this.connected.keys()) {
        if (id === protectedId) continue;
        if ((this.inFlight.get(id) ?? 0) > 0) continue;
        const at = this.lastUsedAt.get(id) ?? 0;
        if (at < victimAt) {
          victimAt = at;
          victim = id;
        }
      }
      if (!victim) return;
      await this.disconnect(victim).catch(() => undefined);
    }
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
      // #123: the directory's declared needsEnv becomes the install's
      // requiredEnv, so a token-less server is skipped, not broken.
      ...(entry.needsEnv?.length ? { requiredEnv: [...entry.needsEnv] } : {}),
    });
    return installed;
  }

  installCustom(label: string, config: InstalledMcpServerConfig): InstalledMcpServer {
    return this.store.install(null, label.trim(), config);
  }

  // -- add / remove (Octomind parity #53) ------------------------------------
  //
  // addServer/removeServer are the live counterparts of install/uninstall:
  // they PERSIST through the same store the API uses (LazyMcpServerStore,
  // <dataDir>/mcp-directory.db) AND connect/disconnect the server in this
  // running manager, so a mid-session add is usable immediately and
  // survives a restart (a fresh manager over the same dataDir lists it).

  /**
   * Add a server: persist it, then connect it live. Provide either a
   * `directoryId` (config from the curated directory, optionally patched
   * per-field by `config`) or a full custom `config`. When the live
   * connect fails the server STAYS persisted (health records the error)
   * and the error propagates — the install is durable either way.
   * `connect: false` persists only (the classic lazy install).
   */
  async addServer(input: {
    label?: string;
    directoryId?: string;
    config?: InstalledMcpServerConfig;
    connect?: boolean;
  }): Promise<InstalledMcpServer> {
    let installed: InstalledMcpServer;
    if (input.directoryId) {
      const entry = getDirectoryEntry(input.directoryId);
      if (!entry) throw new Error(`Unknown MCP directory entry "${input.directoryId}".`);
      const base: InstalledMcpServerConfig = {
        kind: entry.kind,
        command: entry.command,
        args: entry.args,
        ...(entry.needsEnv?.length ? { requiredEnv: [...entry.needsEnv] } : {}),
      };
      const merged = input.config ? mergeServerConfig(base, input.config) : base;
      installed = this.store.install(entry.id, (input.label ?? entry.id).trim(), merged);
    } else if (input.config) {
      if (!input.label) throw new Error('addServer needs a "label" for a custom server config.');
      installed = this.store.install(null, input.label.trim(), input.config);
    } else {
      throw new Error('addServer needs either a "directoryId" or a "config".');
    }
    if (input.connect !== false) {
      await this.ensureConnected(installed.id);
    }
    return installed;
  }

  /**
   * Remove a server by id OR label: disconnect it live, then delete the
   * persisted record. Returns false when nothing matches (idempotent —
   * safe to call from cleanup paths).
   */
  async removeServer(idOrLabel: string): Promise<boolean> {
    const server = this.store.get(idOrLabel) ?? this.store.findByLabel(idOrLabel);
    if (!server) return false;
    await this.disconnect(server.id).catch(() => undefined);
    this.health.delete(server.id);
    this.lastUsedAt.delete(server.id);
    this.store.removeActiveCapability(server.id);
    try {
      this.store.remove(server.id);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Manual restart (also the revival path for a terminally `failed`
   * server, #56): drop any connection and reconnect from the persisted
   * config. On success the health record is `running` again.
   */
  async restartServer(id: string): Promise<McpServerHealthRecord> {
    await this.dropConnection(id);
    await this.ensureConnected(id);
    return this.status(id);
  }

  // -- override files (Octomind parity #54) ----------------------------------

  /**
   * Discover `mcp-<name>.json` files in `configDir` and apply them:
   * layered over the installed server labeled `<name>` (override wins
   * per-field, persisted via updateConfig; a connected server is
   * disconnected so the new config takes effect on next use), or — when
   * no such server is installed — auto-bound by installing the override
   * as a new server (the override must then be a complete config).
   * Returns one entry per applied override.
   */
  applyOverrideFiles(
    configDir: string,
  ): Array<{ label: string; action: 'installed' | 'updated'; server: InstalledMcpServer }> {
    const applied: Array<{ label: string; action: 'installed' | 'updated'; server: InstalledMcpServer }> = [];
    for (const override of loadMcpOverrideFiles(configDir)) {
      const existing = this.store.findByLabel(override.name);
      if (existing) {
        const merged = mergeServerConfig(existing.config, override.config);
        const updated = this.store.updateConfig(existing.id, merged);
        if (override.enabled !== undefined && override.enabled !== existing.enabled) {
          this.store.setEnabled(existing.id, override.enabled);
        }
        // Config changed under a live connection: drop it; the next
        // tool call reconnects with the layered config.
        if (this.connected.has(existing.id)) {
          void this.dropConnection(existing.id).catch(() => undefined);
        }
        applied.push({ label: override.name, action: 'updated', server: this.store.get(existing.id) ?? updated });
      } else {
        // Auto-bind: the override alone must be a complete, valid config.
        const candidate = override.config as InstalledMcpServerConfig;
        validateServerLabel(override.name);
        validateServerConfig(candidate);
        const installed = this.store.install(null, override.name, candidate);
        if (override.enabled === false) this.store.setEnabled(installed.id, false);
        applied.push({ label: override.name, action: 'installed', server: this.store.get(installed.id) ?? installed });
      }
    }
    return applied;
  }

  uninstall(id: string): void {
    void this.disconnect(id).catch(() => undefined);
    this.lastUsedAt.delete(id);
    this.store.removeActiveCapability(id);
    this.store.remove(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.store.setEnabled(id, enabled);
    if (!enabled) void this.disconnect(id).catch(() => undefined);
  }

  setBotEnabled(serverId: string, botId: string, enabled: boolean): void {
    this.store.setBotEnabled(serverId, botId, enabled);
  }

  /**
   * Auto-bind safety rule (Octomind parity small item): intent-driven
   * layers may REQUEST that a server be bound to a bot by label, but a
   * bind happens ONLY on an exact, case-sensitive label match against
   * an installed, enabled server. Fuzzy/semantic near-matches never
   * bind — binding the wrong server would hand a bot real tools (and
   * potentially credentials) it was never meant to have. Returns the
   * bound server, or null when there is no exact match.
   */
  autoBindExact(botId: string, label: string): InstalledMcpServer | null {
    const exact = this.store.list().filter((s) => s.label === label && s.enabled);
    if (exact.length !== 1) return null; // none, or ambiguous duplicates
    const server = exact[0]!;
    if (!this.store.isBotAllowed(server.id, botId)) {
      this.store.setBotEnabled(server.id, botId, true);
    }
    return server;
  }

  clearBotOverride(serverId: string, botId: string): void {
    this.store.clearBotOverride(serverId, botId);
  }

  list(): InstalledMcpServer[] {
    return this.store.list();
  }

  status(id: string): McpServerHealthRecord {
    return (
      this.health.get(id) ?? { status: 'stopped', lastError: null, restarts: 0, lastCheckAt: null }
    );
  }

  // -- health monitor --------------------------------------------------------

  /** Start the periodic health probe (idempotent). The timer is unref'd. */
  startHealthMonitor(intervalMs = MCP_HEALTH_CHECK_INTERVAL_MS): void {
    if (this.healthTimer || intervalMs <= 0) return;
    this.healthTimer = setInterval(() => {
      void this.checkHealthOnce().catch(() => undefined);
    }, intervalMs);
    this.healthTimer.unref?.();
  }

  stopHealthMonitor(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** Drop a connection WITHOUT touching the health record. */
  private async dropConnection(id: string): Promise<void> {
    const entry = this.connected.get(id);
    this.connected.delete(id);
    this.connecting.delete(id);
    if (entry) await entry.connector.close().catch(() => undefined);
  }

  /**
   * One health sweep: probe every connected server; a failed probe
   * marks the server 'error', drops the connection, and (when
   * autoRestart is on) makes exactly one reconnect attempt. When that
   * attempt also fails the server enters the TERMINAL `failed` state
   * (#56): it is disconnected (so it leaves the probe set — this sweep
   * iterates `connected` only), stays installed and listed with its
   * failure reason in `lastError`, and can be revived manually via
   * restartServer()/warmUp(). With autoRestart off a failed probe is a
   * plain 'error' (no restart was attempted, so nothing is terminal).
   */
  async checkHealthOnce(): Promise<void> {
    for (const id of [...this.connected.keys()]) {
      const entry = this.connected.get(id);
      if (!entry) continue;
      const ping = entry.connector.ping;
      const record = this.status(id);
      if (!ping) {
        this.health.set(id, { ...record, lastCheckAt: this.nowIso() });
        continue;
      }
      try {
        await Promise.race([
          ping.call(entry.connector),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`health probe timed out after ${this.healthPingTimeoutMs}ms`)),
              this.healthPingTimeoutMs,
            ),
          ),
        ]);
        this.health.set(id, {
          status: 'running',
          lastError: null,
          restarts: record.restarts,
          lastCheckAt: this.nowIso(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.health.set(id, {
          status: 'error',
          lastError: message,
          restarts: record.restarts,
          lastCheckAt: this.nowIso(),
        });
        await this.dropConnection(id);
        if (this.autoRestart) {
          try {
            await this.ensureConnected(id);
            const after = this.status(id);
            this.health.set(id, { ...after, restarts: record.restarts + 1 });
          } catch (restartErr) {
            // Terminal Failed (#56): probe failed AND the single
            // auto-restart attempt failed. ensureConnected recorded an
            // 'error'; promote it with the restart failure as the reason.
            const reason = restartErr instanceof Error ? restartErr.message : String(restartErr);
            this.health.set(id, {
              status: 'failed',
              lastError: `health probe failed (${message}); auto-restart failed: ${reason}`,
              restarts: record.restarts,
              lastCheckAt: this.nowIso(),
            });
          }
        }
      }
    }
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
    const prev = this.health.get(id);
    this.health.set(id, {
      status,
      lastError,
      restarts: prev?.restarts ?? 0,
      lastCheckAt: prev?.lastCheckAt ?? null,
    });
  }

  async ensureConnected(id: string): Promise<ConnectedEntry> {
    const server = this.store.get(id);
    if (!server) throw new Error(`Unknown MCP server "${id}".`);
    if (!server.enabled) throw new Error(`MCP server "${server.label}" is disabled.`);
    // Env gating (#123) backstop: stubs already hide gated servers, but
    // a direct warmUp/restart must not spawn one either.
    const gate = this.envGate(server);
    if (gate.gated) {
      throw new Error(
        `MCP server "${server.label}" is skipped: missing required env ${gate.missing.join(', ')} (declared via requiredEnv). Set the missing key(s) to enable this server.`,
      );
    }
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
        // Per-server wildcard filter (#55): filtered-out tools are not
        // exposed from this server at all. Patterns match the RAW tool
        // name (`read_file`), not the registered `mcp:<label>:<tool>`.
        const filter = this.store.getToolFilter(server.label);
        for (const def of defs) {
          const rawName = def.name.startsWith(`mcp:${server.label}:`)
            ? def.name.slice(`mcp:${server.label}:`.length)
            : (def.name.split(':').pop() ?? def.name);
          if (!isToolAllowedByFilter(filter, rawName)) continue;
          tools.set(def.name, def);
        }
        const entry: ConnectedEntry = { connector, tools };
        this.connected.set(id, entry);
        this.setHealth(id, 'running');
        // Active-capability set (#140): record the activation, then
        // evict LRU idle connections if the soft cap is exceeded.
        this.activateCapability(server);
        await this.evictOverCap(id);
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
    throw new Error(
      `MCP server "${server.label}" has no tool "${tail}".${didYouMeanSuffix(
        tail,
        [...entry.tools.values()].map((d) => d.name.split(':').pop() ?? d.name),
      )}`,
    );
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
      // Env gating (#123): a server missing required env keys is
      // skipped — absent from the registry rather than failing per call.
      if (this.envGate(server).gated) continue;
      if (botId && !this.store.isBotAllowed(server.id, botId)) continue;
      const directoryEntry = server.directoryId ? getDirectoryEntry(server.directoryId) : undefined;
      const declaredAll = directoryEntry?.tools ?? [{ name: 'call', description: `Call ${server.label}` }];
      // Per-server wildcard filter (#55) applies to the stub surface too.
      const filter = this.store.getToolFilter(server.label);
      const declared = declaredAll.filter((t) => isToolAllowedByFilter(filter, t.name));
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
            // Refcount (#140): while a call is in flight this server is
            // never an eviction victim; completion refreshes its LRU
            // position.
            this.inFlight.set(server.id, (this.inFlight.get(server.id) ?? 0) + 1);
            try {
              const real = await this.realToolDef(current, registeredName);
              try {
                return await real.handler(args, ctx);
              } catch (err) {
                // Dead-connection smell: drop + reconnect + retry exactly
                // once (health auto-restart on the call path).
                const message = err instanceof Error ? err.message : String(err);
                if (!/not connected|connection closed|econnreset|epipe|socket hang up|transport.*closed/i.test(message)) {
                  throw err;
                }
                await this.dropConnection(server.id);
                const revived = await this.realToolDef(current, registeredName);
                return revived.handler(args, ctx);
              }
            } finally {
              const remaining = (this.inFlight.get(server.id) ?? 1) - 1;
              if (remaining <= 0) this.inFlight.delete(server.id);
              else this.inFlight.set(server.id, remaining);
              this.touchCapability(server.id);
            }
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
    this.stopHealthMonitor();
    const ids = [...this.connected.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
    this.store.close();
  }
}
