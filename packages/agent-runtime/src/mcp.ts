// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolCall, ToolContext, ToolDefinition } from './types.js';
import type { McpServerToolFilter } from './mcp-scopes.js';
import { isToolAllowedByFilter } from './mcp-scopes.js';
import { validateWidgetPayload, type ButtonsWidgetPayload } from './widgets.js';
import { filterMcpAppResources, type McpAppResource } from './mcp-apps.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

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
    this.db = openDb(dbPath);
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
   * Elicitation (Octomind parity — MCP completion): how this client
   * answers server-initiated `elicitation/create` requests.
   * - 'widget': route to the calling turn's interactive widget host
   *   (the ask_user_question machinery) — the user answers in chat.
   * - a handler function: full custom routing (host-defined).
   * - unset: the capability is not advertised; servers that require
   *   elicitation get a method-not-supported error (fail-closed).
   */
  elicitation?: 'widget' | ElicitationHandler;
  /**
   * Per-surface elicitation routing (Octomind parity #51): when set,
   * elicitation requests route through this router to the handler the
   * host registered for `elicitationSurface` (or the router default).
   * Precedence in handleElicitation: function handler → router → widget
   * → decline. Setting a router also advertises the elicitation
   * capability, like the `elicitation` option does.
   */
  elicitationRouter?: ElicitationRouter;
  /** Surface name this client's elicitation requests route to (e.g. 'chat', 'cli', 'ws', 'acp'). */
  elicitationSurface?: ElicitationSurface;
  /**
   * Per-server tool filter with wildcards (Octomind parity #55, see
   * mcp-scopes.ts): applied to this server's tools when they are exposed
   * via listTools — filtered-out tools are never registered.
   */
  toolFilter?: McpServerToolFilter;
  /**
   * Logical server name (e.g. the config key in mcp.json, like "fetch").
   * When set, tools are registered as `mcp:<server>:<tool>` so governance
   * policy can allowlist per server (see mcpServerAllowRule in
   * @mvp/governance). When unset, the legacy `mcp:<tool>` shape is kept.
   */
  serverName?: string;
}

/** MCP elicitation request (server → client, mid-tool-call). */
export interface ElicitationRequest {
  message: string;
  requestedSchema: Record<string, unknown>;
}

/** MCP elicitation result: accept with content, or decline/cancel. */
export interface ElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export type ElicitationHandler = (req: ElicitationRequest) => Promise<ElicitationResult>;

// ---------------------------------------------------------------------------
// Elicitation routing (Octomind parity #51, client side)
// ---------------------------------------------------------------------------
//
// Elicitation requests arrive mid-tool-call and must be answered by
// whatever surface the user is actually looking at: the chat widget, a
// terminal prompt, the WS owner channel, an ACP client, ... The router
// is the registration point: the HOST registers one handler per surface
// name; the MCP client routes each request to the handler for its
// configured surface (or the router's default surface). No registered
// handler → decline. Headless turns register nothing and therefore
// decline by default — servers must cope without the extra data.
//
// Surface names are free-form strings; the well-known ones are exported
// as constants so hosts and workstreams agree on spelling.

export const ELICITATION_SURFACES = {
  chat: 'chat',
  cli: 'cli',
  ws: 'ws',
  acp: 'acp',
} as const;

export type ElicitationSurface = (typeof ELICITATION_SURFACES)[keyof typeof ELICITATION_SURFACES] | (string & {});

export class ElicitationRouter {
  private readonly handlers = new Map<string, ElicitationHandler>();
  private defaultSurface: string | undefined;

  /**
   * Register the handler for one surface. Re-registering replaces the
   * previous handler. Returns an unregister function.
   */
  register(surface: ElicitationSurface, handler: ElicitationHandler): () => void {
    this.handlers.set(surface, handler);
    return () => {
      if (this.handlers.get(surface) === handler) this.handlers.delete(surface);
    };
  }

  unregister(surface: ElicitationSurface): boolean {
    return this.handlers.delete(surface);
  }

  has(surface: ElicitationSurface): boolean {
    return this.handlers.has(surface);
  }

  /** Names of the surfaces with a live handler. */
  surfaces(): string[] {
    return [...this.handlers.keys()];
  }

  /** Surface used when a request does not name one. */
  setDefaultSurface(surface: ElicitationSurface | undefined): void {
    this.defaultSurface = surface;
  }

  getDefaultSurface(): string | undefined {
    return this.defaultSurface;
  }

  /**
   * Route one request: the explicitly named surface wins, then the
   * router default. Missing handler or a throwing handler → decline
   * (fail closed, same contract as MCPClient.handleElicitation).
   */
  async route(req: ElicitationRequest, surface?: ElicitationSurface): Promise<ElicitationResult> {
    const target = surface ?? this.defaultSurface;
    const handler = target ? this.handlers.get(target) : undefined;
    if (!handler) return { action: 'decline' };
    try {
      return await handler(req);
    } catch {
      return { action: 'decline' };
    }
  }
}

/**
 * Process-wide router hosts may share: register surface handlers once at
 * boot and pass this instance as `elicitationRouter` to MCPClient /
 * LazyMcpManager clients. Exported for host wiring convenience; clients
 * never consult it implicitly.
 */
export const defaultElicitationRouter = new ElicitationRouter();

// ---------------------------------------------------------------------------
// Tool annotations + context epochs (Octomind parity #57)
// ---------------------------------------------------------------------------

/**
 * MCP tool annotations (the `annotations` object on a tools/list entry).
 * Preserved verbatim on ingested tool definitions so the model plane and
 * policy layers can see read-only / destructive / idempotent hints.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/**
 * A ToolDefinition as ingested from an MCP server: the base shape plus
 * the wire annotations and the context epoch the definition belongs to.
 * (Parent integration: ToolDefinition in types.ts may grow optional
 * `annotations` / `contextEpoch` fields; the runtime ignores them today,
 * so carrying them on the object is backward compatible.)
 */
export type McpToolDefinition = ToolDefinition & {
  annotations?: McpToolAnnotations;
  contextEpoch?: number;
};

/** Error thrown when a tool call is attempted through a stale-epoch definition. */
export class McpStaleContextEpochError extends Error {
  readonly toolName: string;
  readonly definitionEpoch: number;
  readonly currentEpoch: number;

  constructor(toolName: string, definitionEpoch: number, currentEpoch: number) {
    super(
      `MCP tool "${toolName}" belongs to context epoch ${definitionEpoch}, but the server's current ` +
        `context epoch is ${currentEpoch} — its tool list changed (list_changed / restart) since this ` +
        'definition was listed. Re-list the server tools and retry with the fresh definition; ' +
        'calling through the stale shape is refused so arguments never hit a changed schema.',
    );
    this.name = 'McpStaleContextEpochError';
    this.toolName = toolName;
    this.definitionEpoch = definitionEpoch;
    this.currentEpoch = currentEpoch;
  }
}

interface MCPToolMeta {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
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
  /**
   * Context of the tool call currently executing on this connection —
   * elicitation requests arrive mid-call and route through its widget
   * host. Concurrent calls on one connection share the slot (last
   * writer wins); elicitation is rare and user-paced, so this is a
   * deliberate simplification.
   */
  private activeToolCtx: ToolContext | null = null;
  /**
   * Context epoch (Octomind parity #57b): monotonically increasing per
   * connection. Starts at 0; every observed change to the server's tool
   * list (a tools/list result whose name+schema+annotations fingerprint
   * differs from the previous one, e.g. after a list_changed
   * notification or a restart) increments it. ToolDefinitions capture
   * the epoch at listing time; invoking a definition whose epoch is no
   * longer current throws McpStaleContextEpochError.
   */
  private epoch = 0;
  private toolListFingerprint: string | null = null;

  constructor(options: MCPClientOptions = {}) {
    this.options = options;
    this.serverName = options.serverName;
    this.pinStore = options.pinDbPath ? new MCPSchemaPinStore(options.pinDbPath) : null;
    if (!this.pinStore) {
      // Fail-loud, not fail-closed: library users can still opt out, but an
      // unpinned client silently skips schema-drift protection — say so once.
      console.warn(
        '[mcp] MCPClient without pinDbPath: tool-schema drift protection is OFF. ' +
          'Pass pinDbPath (e.g. <dataDir>/mcp-pins.db) unless this is a throwaway test client.',
      );
    }
  }

  /** Name this client's tools are registered under: `mcp:<server>:<tool>` or legacy `mcp:<tool>`. */
  private registeredToolName(toolName: string): string {
    return mcpToolName(this.serverName, toolName);
  }

  async connectStdio(config: MCPStdioConfig): Promise<void> {
    this.label = `mcp-stdio:${config.command}`;
    // Never hand provider keys to untrusted MCP children: syncProviderKeysToEnv
    // mirrors decrypted keys into process.env, so strip secret-like vars here.
    // Explicit config.env may still add non-secret vars (or its own auth).
    const safeEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie|credential|private[_-]?key/i.test(k)) continue;
      if (k.endsWith('_HEADERS') || k.endsWith('_BASE_URL')) continue;
      safeEnv[k] = v;
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...safeEnv, ...(config.env ?? {}) } as Record<string, string>,
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

  /**
   * Connect over any SDK transport (Octomind parity #48 seam): the
   * in-process MCP facade uses this with an InMemoryTransport loopback
   * pair; stdio/HTTP keep their dedicated helpers. Same pin-sync and
   * elicitation wiring as every other transport.
   */
  async connectTransport(transport: Transport, label: string): Promise<void> {
    this.label = label;
    await this.connectWith(transport, label);
  }

  private async connectWith(transport: Transport, what: string): Promise<void> {
    const elicitationOn = this.options.elicitation !== undefined || this.options.elicitationRouter !== undefined;
    const createClient =
      this.options.createClient ??
      (() =>
        new Client(
          { name: 'mvp-agent-runtime', version: '0.1.0' },
          elicitationOn ? { capabilities: { elicitation: {} } } : undefined,
        ));
    const client = createClient();
    if (elicitationOn) {
      // Advertise + route server-initiated elicitation requests. A
      // custom createClient that lacks setRequestHandler simply skips
      // this (tests use the seam to observe registration).
      const anyClient = client as unknown as {
        setRequestHandler?: (schema: unknown, handler: (req: { params: unknown }) => Promise<ElicitationResult>) => void;
      };
      anyClient.setRequestHandler?.(ElicitRequestSchema, async (req) => {
        const params = (req.params ?? {}) as {
          message?: string;
          requestedSchema?: Record<string, unknown>;
        };
        return this.handleElicitation({
          message: typeof params.message === 'string' ? params.message : '',
          requestedSchema:
            params.requestedSchema && typeof params.requestedSchema === 'object'
              ? params.requestedSchema
              : {},
        });
      });
    }
    // Context epochs (#57b): a tools/list_changed notification means the
    // tool shapes may have moved — re-fetch so the fingerprint comparison
    // bumps the epoch and stale definitions start refusing calls.
    const anyClient = client as unknown as {
      setNotificationHandler?: (schema: unknown, handler: () => Promise<void>) => void;
    };
    anyClient.setNotificationHandler?.(ToolListChangedNotificationSchema, async () => {
      await this.fetchToolMetas().catch(() => undefined);
    });
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

  /** The connection's current context epoch (see the epoch note on the field). */
  get contextEpoch(): number {
    return this.epoch;
  }

  /**
   * Fingerprint one tool-list snapshot and advance the context epoch
   * when it differs from the previous snapshot. The first snapshot only
   * sets the baseline (no increment — nothing is stale yet).
   */
  private noteToolList(metas: MCPToolMeta[]): void {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          metas
            .map((m) => ({
              name: m.name,
              schema: canonicalizeSchema(m.inputSchema ?? {}),
              annotations: canonicalizeSchema(m.annotations ?? {}),
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        ),
      )
      .digest('hex');
    if (this.toolListFingerprint !== null && fingerprint !== this.toolListFingerprint) {
      this.epoch += 1;
    }
    this.toolListFingerprint = fingerprint;
  }

  /** Throw when a definition captured at `definitionEpoch` is used after the epoch moved. */
  private assertCurrentEpoch(toolName: string, definitionEpoch: number | undefined): void {
    if (definitionEpoch !== undefined && definitionEpoch !== this.epoch) {
      throw new McpStaleContextEpochError(toolName, definitionEpoch, this.epoch);
    }
  }

  private async fetchToolMetas(): Promise<MCPToolMeta[]> {
    const client = this.requireClient();
    let tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      annotations?: McpToolAnnotations;
    }>;
    try {
      const res = await client.listTools();
      tools = res.tools as typeof tools;
    } catch (err) {
      throw new Error(
        `MCP listTools failed (${this.label}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.noteToolList(tools);
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

  /**
   * Route one elicitation request. Custom handler wins; 'widget' mode
   * asks the user through the in-flight turn's widget host (a buttons
   * card: enum fields become options, everything else free text).
   * Mapping back to content is deliberately conservative: a single
   * requested property maps from the answer; multi-property schemas
   * accept a JSON object typed as free text. Anything unmappable
   * declines — the server decides how to proceed without the data.
   */
  async handleElicitation(req: ElicitationRequest): Promise<ElicitationResult> {
    const opt = this.options.elicitation;
    if (typeof opt === 'function') {
      try {
        return await opt(req);
      } catch {
        return { action: 'decline' };
      }
    }
    // Per-surface routing (#51): a host-registered handler for this
    // client's surface answers; no registration → fall through to the
    // widget path / decline (headless declines by default).
    if (this.options.elicitationRouter) {
      const routed = await this.options.elicitationRouter.route(req, this.options.elicitationSurface);
      if (routed.action !== 'decline' || this.options.elicitationSurface !== undefined) {
        return routed;
      }
      // No surface named and the router declined (no default handler):
      // keep falling through so a 'widget' configuration still works.
      if (opt !== 'widget') return routed;
    }
    if (opt !== 'widget') return { action: 'decline' };
    const ctx = this.activeToolCtx;
    const host = ctx?.widget;
    if (!host || !ctx) return { action: 'decline' };

    const schema = req.requestedSchema as {
      properties?: Record<
        string,
        { type?: string; enum?: unknown[]; description?: string }
      >;
    };
    const props = schema.properties ?? {};
    const names = Object.keys(props);
    const single = names.length === 1 ? names[0]! : undefined;
    const singleProp = single ? props[single] : undefined;
    const enumValues =
      singleProp && Array.isArray(singleProp.enum)
        ? singleProp.enum.map((v) => String(v))
        : [];
    const options = enumValues.map((v, i) => ({ id: `e${i}`, label: v }));
    const fieldHint =
      names.length > 1
        ? ` Fields needed: ${names.join(', ')}. Reply with a JSON object.`
        : single && !enumValues.length
          ? ` (${singleProp?.description ?? single})`
          : '';
    const validated = validateWidgetPayload({
      kind: 'buttons',
      title: 'Information needed',
      question: `${req.message || 'The tool needs more information.'}${fieldHint}`,
      options,
      allowFreeText: true,
    });
    if (!validated.ok) return { action: 'decline' };
    const payload = validated.payload as ButtonsWidgetPayload;
    let record: { id: string; expiresAt: number | null };
    try {
      record = await host.raise({
        kind: 'buttons',
        payload,
        title: 'Information needed',
        interactive: true,
      });
      try {
        await host.emit({
          type: 'widget',
          widgetId: record.id,
          sessionId: ctx.sessionId,
          widget: payload,
          expiresAt: record.expiresAt,
          interactive: true,
        });
      } catch {
        // Event sinks must never break the elicitation flow.
      }
    } catch {
      return { action: 'decline' };
    }
    let answer: { answered: boolean; value?: unknown };
    try {
      answer = await host.awaitAnswer(record.id, 120_000);
    } catch {
      return { action: 'decline' };
    }
    if (!answer.answered) return { action: 'decline' };
    // Interpret the answer the same way ask_user_question does.
    let selectedLabel: string | undefined;
    let freeText: string | undefined;
    const v = answer.value;
    if (Array.isArray(v) && v.length > 0) {
      const opt = options.find((o) => o.id === String(v[0]));
      selectedLabel = opt?.label ?? String(v[0]);
    } else if (typeof v === 'string') {
      freeText = v;
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.selected) && o.selected.length > 0) {
        const firstSelected = String((o.selected as unknown[])[0]);
        const opt = options.find((x) => x.id === firstSelected);
        selectedLabel = opt?.label ?? firstSelected;
      }
      if (typeof o.freeText === 'string' && o.freeText) freeText = o.freeText;
      else if (typeof o.text === 'string' && o.text) freeText = o.text;
    }
    if (!single) {
      if (freeText) {
        try {
          const parsed = JSON.parse(freeText) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { action: 'accept', content: parsed as Record<string, unknown> };
          }
        } catch {
          /* fall through to decline */
        }
      }
      return { action: 'decline' };
    }
    const type = singleProp?.type ?? 'string';
    let value: unknown;
    if (enumValues.length > 0) value = selectedLabel;
    else if (type === 'number' || type === 'integer') {
      const n = Number(freeText);
      value = Number.isFinite(n) ? n : undefined;
    } else if (type === 'boolean') {
      value = freeText !== undefined ? /^(true|yes|1)$/i.test(freeText.trim()) : selectedLabel === 'true';
    } else value = freeText ?? selectedLabel;
    if (value === undefined) return { action: 'decline' };
    return { action: 'accept', content: { [single]: value } };
  }

  async listTools(): Promise<ToolDefinition[]> {
    const metas = await this.fetchToolMetas();
    const listedEpoch = this.epoch;
    return metas
      .filter((t) => isToolAllowedByFilter(this.options.toolFilter, t.name))
      .map((t) => {
      const key = this.blockedKey(t.name);
      const def: McpToolDefinition = {
        name: this.registeredToolName(t.name),
        description: t.description ?? `MCP tool ${t.name} (${this.label})`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        // #57a: annotations survive ingestion verbatim; #57b: the def is
        // stamped with the context epoch it was listed in.
        ...(t.annotations ? { annotations: t.annotations } : {}),
        contextEpoch: listedEpoch,
        handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> => {
          this.assertCurrentEpoch(t.name, listedEpoch);
          if (this.blockedTools.has(key)) {
            throw new Error(
              `MCP tool "${t.name}" is blocked: server "${this.label}" changed its input schema and the change was not approved.`,
            );
          }
          const client = this.requireClient();
          const call: ToolCall = { id: `mcp_${Date.now()}`, name: t.name, args };
          // Elicitation requests can arrive while this call runs; give
          // the router access to the calling turn's context.
          this.activeToolCtx = ctx;
          try {
            return await client.callTool({ name: call.name, arguments: call.args });
          } catch (err) {
            throw new Error(
              `MCP tool "${t.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            if (this.activeToolCtx === ctx) this.activeToolCtx = null;
          }
        },
      };
      return def;
      });
  }

  /**
   * List the server's resources (MCP `resources/list`). Servers without
   * the resources capability fail with a catchable error.
   */
  async listResources(): Promise<McpAppResource[]> {
    const client = this.requireClient() as unknown as {
      listResources?: () => Promise<{ resources?: McpAppResource[] }>;
    };
    if (typeof client.listResources !== 'function') {
      throw new Error(`MCP resources/list is not supported by this client (${this.label})`);
    }
    const res = await client.listResources();
    return Array.isArray(res.resources) ? res.resources : [];
  }

  /** List only the MCP App UI resources (ui:// + text/html profile). */
  async listAppResources(): Promise<McpAppResource[]> {
    return filterMcpAppResources(await this.listResources());
  }

  /**
   * Read one resource (MCP `resources/read`) — the fetch path for MCP App
   * HTML. Returns the SDK result verbatim: `{ contents: [{ uri, mimeType?,
   * text? | blob? }] }`.
   */
  async readResource(uri: string): Promise<{ contents: Array<Record<string, unknown>> }> {
    const client = this.requireClient() as unknown as {
      readResource?: (params: { uri: string }) => Promise<{ contents: Array<Record<string, unknown>> }>;
    };
    if (typeof client.readResource !== 'function') {
      throw new Error(`MCP resources/read is not supported by this client (${this.label})`);
    }
    return client.readResource({ uri });
  }

  /**
   * Call a tool by its raw (unregistered) name, bypassing the ToolDefinition
   * wrapper. Used by the MCP Apps bridge, which performs its own governance
   * evaluation before delegating here. Blocked (schema-drifted) tools throw.
   */
  async callToolByName(
    name: string,
    args: Record<string, unknown>,
    opts?: { contextEpoch?: number },
  ): Promise<unknown> {
    // #57b: callers holding an epoch-stamped listing can pass it back;
    // a moved epoch refuses the call before it reaches the server.
    this.assertCurrentEpoch(name, opts?.contextEpoch);
    if (!isToolAllowedByFilter(this.options.toolFilter, name)) {
      throw new Error(`MCP tool "${name}" is filtered out for server "${this.label}" by its per-server tool filter.`);
    }
    if (this.blockedTools.has(this.blockedKey(name))) {
      throw new Error(
        `MCP tool "${name}" is blocked: server "${this.label}" changed its input schema and the change was not approved.`,
      );
    }
    const client = this.requireClient();
    try {
      return await client.callTool({ name, arguments: args });
    } catch (err) {
      throw new Error(
        `MCP tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Liveness probe used by the MCP health monitor (Octomind parity). */
  async ping(): Promise<void> {
    await this.requireClient().ping();
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
    this.pinStore?.close();
  }
}
