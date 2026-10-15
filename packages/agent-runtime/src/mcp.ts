// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolCall, ToolContext, ToolDefinition } from './types.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

export interface MCPStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Recursively sort object keys so semantically identical JSON schemas hash
 * identically regardless of key order.
 */
export function canonicalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeSchema);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeSchema((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** sha256 of the canonicalized JSON form of a tool input schema. */
export function schemaSha256(schema: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeSchema(schema)))
    .digest('hex');
}

export interface MCPSchemaPin {
  serverLabel: string;
  toolName: string;
  schemaSha256: string;
  serverVersion: string | null;
  pinnedAt: string;
}

/**
 * SQLite-backed trust-on-first-use (TOFU) pin store for MCP tool schemas.
 *
 * This lives in its OWN database file (a sibling of the session DB, wired by
 * the host), not the session store: pin history is a durable security record
 * that must survive session wipes, and its lifecycle (keyed by server label)
 * is independent of sessions.
 */
export class MCPSchemaPinStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tool_pins (
        server_label TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        schema_sha256 TEXT NOT NULL,
        server_version TEXT,
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (server_label, tool_name)
      );
    `);
  }

  getPin(serverLabel: string, toolName: string): MCPSchemaPin | undefined {
    const row = this.db
      .prepare(
        'SELECT server_label, tool_name, schema_sha256, server_version, pinned_at FROM mcp_tool_pins WHERE server_label = ? AND tool_name = ?',
      )
      .get(serverLabel, toolName) as
      | {
          server_label: string;
          tool_name: string;
          schema_sha256: string;
          server_version: string | null;
          pinned_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      serverLabel: row.server_label,
      toolName: row.tool_name,
      schemaSha256: row.schema_sha256,
      serverVersion: row.server_version,
      pinnedAt: row.pinned_at,
    };
  }

  /** Insert a new pin or replace the existing one (used on first pin and on approved drift). */
  upsertPin(serverLabel: string, toolName: string, sha256: string, serverVersion: string | null): void {
    this.db
      .prepare(
        `INSERT INTO mcp_tool_pins (server_label, tool_name, schema_sha256, server_version, pinned_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (server_label, tool_name)
         DO UPDATE SET schema_sha256 = excluded.schema_sha256,
                       server_version = excluded.server_version,
                       pinned_at = excluded.pinned_at`,
      )
      .run(serverLabel, toolName, sha256, serverVersion, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Minimal structural surface of the governance approval broker used for
 * schema-drift approvals. The real GovernanceGateway
 * (packages/governance/src/gateway.ts) satisfies this shape, but
 * agent-runtime stays decoupled from it — any implementation will do.
 */
export interface SchemaDriftApprovalBroker {
  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string; botId: string; actor: string },
  ): string;
  awaitDecision(approvalId: string, timeoutMs?: number): Promise<'approved' | 'denied'>;
}

export interface MCPClientOptions {
  /**
   * SQLite path for the TOFU pin store. When set, tool schemas are pinned
   * at first connect and drift is gated behind approval. When unset,
   * pinning is disabled and behaviour is unchanged from before.
   */
  pinDbPath?: string;
  /** Broker used to request human approval on schema drift. Without one, drifted tools fail closed (blocked). */
  approvalBroker?: SchemaDriftApprovalBroker;
  /** Identity attached to drift approval records. */
  sessionId?: string;
  botId?: string;
  actor?: string;
  /** Timeout for awaiting a drift approval decision; broker default applies when unset. */
  approvalTimeoutMs?: number;
  /** Test seam: build the underlying MCP Client (defaults to the real SDK client). */
  createClient?: () => Client;
  /**
   * Logical server name (e.g. the config key in mcp.json, like "fetch").
   * When set, tools are registered as `mcp:<server>:<tool>` so governance
   * policy can allowlist per server (see mcpServerAllowRule in
   * @mvp/governance). When unset, the legacy `mcp:<tool>` shape is kept.
   */
  serverName?: string;
}

interface MCPToolMeta {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Registered tool name for an MCP tool: `mcp:<server>:<tool>` when the
 * server is named, else the legacy `mcp:<tool>`. ':' is the segment
 * separator, so server names containing it are sanitized to '_' (documented
 * here so policy patterns like `^mcp:<server>:` stay predictable).
 */
export function mcpToolName(serverName: string | undefined, toolName: string): string {
  if (!serverName) return `mcp:${toolName}`;
  return `mcp:${serverName.replace(/:/g, '_')}:${toolName}`;
}

/**
 * Thin wrapper around an MCP client connection. MCP tools are exposed as
 * ToolDefinition with JSON-schema passthrough so the agent loop can use them
 * like any other tool. Connection failures throw catchable errors — the
 * caller decides whether to retry, warn, or abort.
 *
 * Trust-on-first-use schema pinning (opt-in via pinDbPath): at connect time
 * each tool's inputSchema is hashed (canonicalized, key-order independent)
 * and pinned. On reconnect, drifted schemas are NOT executed until a human
 * approves the change through the approval broker; denied (or broker-less)
 * drift stays blocked.
 */
export class MCPClient {
  private readonly options: MCPClientOptions;
  private readonly pinStore: MCPSchemaPinStore | null;
  private readonly serverName: string | undefined;
  private client: Client | null = null;
  private label = 'mcp';
  /** Tools blocked this process lifetime: `${serverLabel}${toolName}` for drifted-unapproved schemas. */
  private readonly blockedTools = new Set<string>();
  /** Drift keys the human already denied (or that failed closed): don't re-spam approvals on reconnect. */
  private readonly deniedDrifts = new Set<string>();

  constructor(options: MCPClientOptions = {}) {
    this.options = options;
    this.serverName = options.serverName;
    this.pinStore = options.pinDbPath ? new MCPSchemaPinStore(options.pinDbPath) : null;
  }

  /** Name this client's tools are registered under: `mcp:<server>:<tool>` or legacy `mcp:<tool>`. */
  private registeredToolName(toolName: string): string {
    return mcpToolName(this.serverName, toolName);
  }

  async connectStdio(config: MCPStdioConfig): Promise<void> {
    this.label = `mcp-stdio:${config.command}`;
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });
    await this.connectWith(transport, `stdio command "${config.command}"`);
  }

  async connectHttp(url: string, opts?: { authToken?: string }): Promise<void> {
    this.label = `mcp-http:${url}`;
    const headers: Record<string, string> = {};
    if (opts?.authToken) {
      headers['Authorization'] = `Bearer ${opts.authToken}`;
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(url),
      Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined,
    );
    await this.connectWith(transport, `HTTP endpoint ${url}`);
  }

  private async connectWith(
    transport: StdioClientTransport | StreamableHTTPClientTransport,
    what: string,
  ): Promise<void> {
    const createClient = this.options.createClient ?? (() => new Client({ name: 'mvp-agent-runtime', version: '0.1.0' }));
    const client = createClient();
    try {
      await client.connect(transport);
    } catch (err) {
      throw new Error(
        `MCP connect failed (${what}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.client = client;
    if (this.pinStore) {
      try {
        await this.syncToolPins();
      } catch (err) {
        // Fail closed: a pin store we cannot trust means we cannot trust the schemas either.
        await client.close().catch(() => undefined);
        this.client = null;
        throw new Error(
          `MCP schema pin sync failed (${this.label}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(`MCP client not connected (${this.label})`);
    return this.client;
  }

  private async fetchToolMetas(): Promise<MCPToolMeta[]> {
    const client = this.requireClient();
    let tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
    try {
      const res = await client.listTools();
      tools = res.tools as typeof tools;
    } catch (err) {
      throw new Error(
        `MCP listTools failed (${this.label}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return tools;
  }

  private get serverVersion(): string | null {
    try {
      return this.requireClient().getServerVersion()?.version ?? null;
    } catch {
      return null;
    }
  }

  private blockedKey(toolName: string): string {
    return `${this.label}${toolName}`;
  }

  /**
   * Trust-on-first-use: pin each tool's schema hash on first sight; on
   * reconnect, gate drifted schemas behind human approval. Silent when
   * nothing changed.
   */
  private async syncToolPins(): Promise<void> {
    const store = this.pinStore;
    if (!store) return;
    const metas = await this.fetchToolMetas();
    const serverVersion = this.serverVersion;
    for (const meta of metas) {
      const hash = schemaSha256(meta.inputSchema ?? {});
      const key = this.blockedKey(meta.name);
      const pin = store.getPin(this.label, meta.name);
      if (!pin) {
        store.upsertPin(this.label, meta.name, hash, serverVersion);
        continue;
      }
      if (pin.schemaSha256 === hash) {
        // No drift: silent. A revert back to the pinned schema also clears
        // any earlier block/deny state for this tool.
        this.blockedTools.delete(key);
        this.deniedDrifts.delete(key);
        continue;
      }
      // Drift detected.
      if (this.deniedDrifts.has(key)) {
        this.blockedTools.add(key);
        continue; // already denied/fail-closed: stay blocked without re-asking
      }
      const approved = await this.requestDriftApproval(this.registeredToolName(meta.name), pin, hash, serverVersion);
      if (approved) {
        store.upsertPin(this.label, meta.name, hash, serverVersion);
        this.blockedTools.delete(key);
        this.deniedDrifts.delete(key);
      } else {
        this.blockedTools.add(key);
        this.deniedDrifts.add(key);
      }
    }
  }

  /** Ask a human to bless a schema change. False = denied, timed out, or no broker (fail closed). */
  private async requestDriftApproval(
    toolName: string, // registered name (`mcp:<server>:<tool>` or legacy `mcp:<tool>`)
    previous: MCPSchemaPin,
    newHash: string,
    serverVersion: string | null,
  ): Promise<boolean> {
    const broker = this.options.approvalBroker;
    if (!broker) return false;
    const message =
      `MCP server "${this.label}" changed tool "${toolName}"'s input schema since it was first pinned` +
      (previous.serverVersion || serverVersion
        ? ` (server version ${previous.serverVersion ?? 'unknown'} -> ${serverVersion ?? 'unknown'})`
        : '') +
      `. The tool is blocked until you approve the new schema.`;
    const approvalId = broker.requestApproval(
      toolName,
      {
        reason: 'mcp-schema-drift',
        message,
        serverLabel: this.label,
        toolName,
        previousSha256: previous.schemaSha256,
        newSha256: newHash,
        previousPinnedAt: previous.pinnedAt,
      },
      {
        sessionId: this.options.sessionId ?? 'system',
        botId: this.options.botId ?? 'mcp',
        actor: this.options.actor ?? 'system',
      },
    );
    try {
      return (await broker.awaitDecision(approvalId, this.options.approvalTimeoutMs)) === 'approved';
    } catch {
      return false;
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const metas = await this.fetchToolMetas();
    return metas.map((t) => {
      const key = this.blockedKey(t.name);
      return {
        name: this.registeredToolName(t.name),
        description: t.description ?? `MCP tool ${t.name} (${this.label})`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        handler: async (args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> => {
          if (this.blockedTools.has(key)) {
            throw new Error(
              `MCP tool "${t.name}" is blocked: server "${this.label}" changed its input schema and the change was not approved.`,
            );
          }
          const client = this.requireClient();
          const call: ToolCall = { id: `mcp_${Date.now()}`, name: t.name, args };
          try {
            return await client.callTool({ name: call.name, arguments: call.args });
          } catch (err) {
            throw new Error(
              `MCP tool "${t.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      };
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
    this.pinStore?.close();
  }
}
