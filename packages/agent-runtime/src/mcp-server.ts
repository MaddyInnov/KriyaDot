// SPDX-License-Identifier: Apache-2.0
/**
 * Platform MCP server (Phase 3, workstream D): exposes the platform's own
 * tools — and bot invocation — to EXTERNAL MCP clients over stdio and
 * HTTP+SSE, using the official `@modelcontextprotocol/sdk`.
 *
 * ## Trust / approval contract (read this before wiring)
 *
 * Every `tools/call` passes through the platform governance policy BEFORE
 * anything executes (same classify→evaluate semantics as `AgentRuntime`):
 *
 * - `allow`            → the tool executes immediately.
 * - `require-approval` → the call is NOT executed. The server returns a
 *   structured `approval_required` response carrying an `approvalId` and
 *   registers the call as pending. A human approves out-of-band via the
 *   host's approval inbox, which must call
 *   `PlatformMcpServer.decideApproval(approvalId, 'approved' | 'denied')`.
 *   The client then RE-ISSUES the identical `tools/call`; the server
 *   consumes the single-use, argument-bound grant and executes. Grants
 *   expire (default 10 min). There is deliberately NO `approve` tool on
 *   the MCP surface — a client must never be able to approve itself.
 * - `deny` (or a governance error) → stays denied. The call never
 *   executes and the response is a structured `denied` error. No retry
 *   handshake can lift a denial.
 *
 * Tool results are tagged as untrusted data (same provenance floor as the
 * runtime's tool output) before being handed to the external client.
 *
 * ## Coordinator wiring
 *
 * ```ts
 * const server = new PlatformMcpServer({
 *   tools: toolProviderFromRegistry(toolRegistry), // Map<string, ToolDefinition>
 *   governance,                                    // GovernanceGateway
 *   botId: 'support-bot',
 *   chat: { handler: async (message, ctx) => runBotTurn(message, ctx) },
 * });
 * await server.serveStdio();            // for MCP clients over stdio
 * const http = await server.serveHttp({ port: 0 }); // HTTP+SSE, ephemeral port
 * // host approval inbox: server.decideApproval(approvalId, 'approved');
 * await http.close();
 * ```
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { GovernanceGateway } from './governance.js';
import { tagUntrustedToolOutput } from './runtime.js';
import type { ToolCall, ToolContext, ToolDefinition } from './types.js';
import type { McpToolAnnotations } from './mcp.js';
import {
  describeScope,
  isToolAllowedByFilter,
  requiredScopeForTool,
  type McpScopeStore,
  type McpServerToolFilter,
} from './mcp-scopes.js';
import type { TelemetryResourceProvider } from './telemetry.js';

/** Minimal tool description the MCP server needs (a subset of ToolDefinition). */
export interface PlatformToolDef {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool arguments. */
  parameters: Record<string, unknown>;
  /**
   * True when the tool mutates state (same flag as ToolDefinition).
   * Drives the MCP annotations emitted on tools/list (#57a).
   */
  mutating?: boolean;
  /** Explicit idempotence knowledge, when the tool author knows it (#57a). */
  idempotent?: boolean;
  /** Full annotation override; wins over the derived hints when set. */
  annotations?: McpToolAnnotations;
}

/**
 * Derive MCP tool annotations (#57a) from the internal mutating metadata:
 * readOnlyHint = not mutating, destructiveHint = mutating, idempotentHint
 * from explicit knowledge — falling back to `true` for read-only tools
 * (a tool that cannot mutate is safe to retry). An explicit
 * `def.annotations` replaces the derived set wholesale.
 */
export function annotationsForTool(def: PlatformToolDef): McpToolAnnotations {
  if (def.annotations) return def.annotations;
  const mutating = def.mutating === true;
  const annotations: McpToolAnnotations = {
    readOnlyHint: !mutating,
    destructiveHint: mutating,
  };
  if (def.idempotent !== undefined) annotations.idempotentHint = def.idempotent;
  else if (!mutating) annotations.idempotentHint = true;
  return annotations;
}

/**
 * Tool-provider interface the coordinator implements. `listTools` supplies
 * the tools to expose; `callTool` executes one. The coordinator wires the
 * real platform registry via `toolProviderFromRegistry`.
 */
export interface ToolProvider {
  listTools(): PlatformToolDef[] | Promise<PlatformToolDef[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
}

/** Adapt plain ToolDefinitions (e.g. from the platform tool registry). */
export function toolProviderFromDefinitions(defs: Iterable<ToolDefinition>): ToolProvider {
  const list = [...defs];
  return {
    listTools: () =>
      list.map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.parameters,
        ...(d.mutating !== undefined ? { mutating: d.mutating } : {}),
      })),
    callTool: async (name, args) => {
      const def = list.find((d) => d.name === name);
      if (!def) throw new Error(`Unknown tool: "${name}"`);
      const record = (args ?? {}) as Record<string, unknown>;
      // Handlers get a synthetic MCP context; the coordinator may enrich it.
      return def.handler(record, { sessionId: 'mcp', botId: 'mcp' });
    },
  };
}

/** Adapt the platform's `Map<string, ToolDefinition>` registry directly. */
export function toolProviderFromRegistry(registry: Map<string, ToolDefinition>): ToolProvider {
  return toolProviderFromDefinitions(registry.values());
}

/** Bot-invocation hook: runs one platform bot turn for the `chat` tool. */
export type ChatHandler = (message: string, ctx: ToolContext) => Promise<unknown>;

export interface PlatformMcpServerOptions {
  tools: ToolProvider;
  /** Only classify/evaluate/audit are used; approvals resolve via decideApproval. */
  governance: Pick<GovernanceGateway, 'classify' | 'evaluate' | 'audit'>;
  /** Bot id used in the ToolContext handed to governance. */
  botId: string;
  sessionId?: string;
  /** When set, a `chat` tool is exposed that runs a platform bot turn. */
  chat?: { handler: ChatHandler; description?: string };
  serverInfo?: { name: string; version: string };
  /** TTL for a granted approval before the re-call handshake expires. */
  approvalTtlMs?: number;
  /**
   * Per-tool scope toggles (see mcp-scopes.ts). When set, every tools/call
   * is checked against the tool's REQUIRED scope before governance runs:
   * a disabled scope denies the call with a clear `scope_denied` error.
   * Unset → no scope enforcement (all tools behave as before).
   */
  scopes?: McpScopeStore;
  /**
   * Per-server tool filter with wildcards (Octomind parity #55): when
   * set, tools the filter does not expose are omitted from tools/list
   * and refused on tools/call (as if unknown). Unset → full surface.
   */
  toolFilter?: McpServerToolFilter;
  /**
   * Runtime telemetry ("eyes for your AI"). When set, the server exposes
   * telemetry as READ-ONLY MCP resources under `kriyadot://telemetry/*`
   * (summary, runs, per-bot aggregates) so connected assistants — and the
   * platform's own bots — can diagnose from real measurements instead of
   * guessing. Read-only: only resources/list and resources/read are
   * registered; no tools are added and nothing can mutate telemetry.
   * This is distinct from MCP tool scopes (permissions); it is about
   * telemetry data.
   */
  telemetry?: TelemetryResourceProvider;
}

export interface ServeHandle {
  close(): Promise<void>;
}

export interface HttpServeHandle extends ServeHandle {
  /** Base URL of the SSE endpoint, e.g. http://127.0.0.1:PORT/sse */
  url: string;
  port: number;
}

const CHAT_TOOL_NAME = 'chat';
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

interface PendingApproval {
  approvalId: string;
  /** `${toolName}\n${stableArgs}` — grants are argument-bound. */
  key: string;
  call: ToolCall;
  createdAt: number;
}

/** Deterministic JSON key order so identical args hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return textResult(JSON.stringify(payload, null, 2), isError);
}

export function coerceInputSchema(parameters: Record<string, unknown> | undefined): Tool['inputSchema'] {
  if (
    parameters &&
    typeof parameters === 'object' &&
    (parameters as { type?: unknown }).type === 'object'
  ) {
    return parameters as Tool['inputSchema'];
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}

function newApprovalId(): string {
  return `mcp_appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class PlatformMcpServer {
  private readonly tools: ToolProvider;
  private readonly governance: Pick<GovernanceGateway, 'classify' | 'evaluate' | 'audit'>;
  private readonly botId: string;
  private readonly sessionId: string;
  private readonly chat?: { handler: ChatHandler; description?: string };
  private readonly serverInfo: { name: string; version: string };
  private readonly approvalTtlMs: number;
  private readonly scopeStore?: McpScopeStore;
  private readonly toolFilter?: McpServerToolFilter;
  private readonly telemetry?: TelemetryResourceProvider;
  private readonly servers = new Set<Server>();

  /** approvalId → pending call awaiting a human decision. */
  private readonly pending = new Map<string, PendingApproval>();
  /** argument-bound grant key → { approvalId, expiresAt } (single-use). */
  private readonly grants = new Map<string, { approvalId: string; expiresAt: number }>();

  constructor(opts: PlatformMcpServerOptions) {
    this.tools = opts.tools;
    this.governance = opts.governance;
    this.botId = opts.botId;
    this.sessionId = opts.sessionId ?? 'mcp';
    this.chat = opts.chat;
    this.serverInfo = opts.serverInfo ?? { name: 'mvp-platform-mcp', version: '0.1.0' };
    this.approvalTtlMs = opts.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.scopeStore = opts.scopes;
    this.toolFilter = opts.toolFilter;
    this.telemetry = opts.telemetry;
  }

  /**
   * All tool definitions exposed over MCP (provider tools + the optional
   * `chat` tool). Public so the settings API can list tools with their
   * scopes; the protocol handler uses the same source.
   */
  async listToolDefs(): Promise<PlatformToolDef[]> {
    const defs = await this.tools.listTools();
    return this.chat ? [...defs, this.chatToolDef()] : defs;
  }

  private ctx(): ToolContext {
    return { sessionId: this.sessionId, botId: this.botId };
  }

  private audit(entry: { type: string; call?: ToolCall; detail?: unknown }): void {
    try {
      const res = this.governance.audit({
        ...entry,
        sessionId: this.sessionId,
        botId: this.botId,
        ts: new Date().toISOString(),
      });
      if (res instanceof Promise) res.catch(() => undefined);
    } catch {
      // Audit must never break tool dispatch.
    }
  }

  private chatToolDef(): PlatformToolDef {
    return {
      name: CHAT_TOOL_NAME,
      // A bot turn can mutate the world through the bot's own tools.
      mutating: true,
      description:
        this.chat?.description ??
        'Run one turn with the platform bot and return its reply. Subject to the same governance approval policy as every other tool.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The user message to send to the bot.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    };
  }

  private async listMcpTools(): Promise<Tool[]> {
    const all = await this.listToolDefs();
    return all
      .filter((d) => isToolAllowedByFilter(this.toolFilter, d.name))
      .map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: coerceInputSchema(d.parameters),
        // #57a: annotations derived from the internal mutating metadata.
        annotations: annotationsForTool(d),
      }));
  }

  private toolKnown(name: string, defs: PlatformToolDef[]): boolean {
    if (defs.some((d) => d.name === name)) return true;
    return this.chat !== undefined && name === CHAT_TOOL_NAME;
  }

  private async executeTool(name: string, args: unknown): Promise<CallToolResult> {
    try {
      let result: unknown;
      if (name === CHAT_TOOL_NAME && this.chat) {
        const message = (args as { message?: unknown } | null)?.message;
        if (typeof message !== 'string' || message.length === 0) {
          return jsonResult(
            { status: 'error', code: 'invalid_arguments', message: 'chat requires a non-empty "message" string.' },
            true,
          );
        }
        result = await this.chat.handler(message, this.ctx());
      } else {
        result = await this.tools.callTool(name, args);
      }
      // Provenance floor: external clients see tool output tagged as
      // untrusted data, never as instructions.
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return textResult(tagUntrustedToolOutput(name, text));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ status: 'error', code: 'tool_error', tool: name, message }, true);
    }
  }

  private async handleCallTool(name: string, args: unknown): Promise<CallToolResult> {
    const defs = await this.tools.listTools();
    if (!isToolAllowedByFilter(this.toolFilter, name)) {
      return jsonResult(
        { status: 'error', code: 'tool_filtered', message: `Tool "${name}" is filtered out for this server.` },
        true,
      );
    }
    if (!this.toolKnown(name, defs)) {
      return jsonResult(
        { status: 'error', code: 'unknown_tool', message: `Unknown tool: "${name}"` },
        true,
      );
    }
    const call: ToolCall = {
      id: `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      args: (args ?? {}) as Record<string, unknown>,
    };
    // Scope gate (mcp-scopes.ts): the tool's REQUIRED scope toggle must be
    // ON, otherwise the call is denied here — before grants, governance, or
    // execution — with a clear, actionable error.
    if (this.scopeStore) {
      const required = requiredScopeForTool(name);
      const toggles = this.scopeStore.get(name);
      if (!toggles[required]) {
        this.audit({ type: 'mcp.tool.scope_denied', call, detail: { requiredScope: required } });
        return jsonResult(
          {
            status: 'denied',
            code: 'scope_denied',
            tool: name,
            requiredScope: required,
            message:
              `Tool "${name}" requires the "${required}" scope (${describeScope(required)}), ` +
              `which is currently disabled. Enable it via PATCH /api/mcp/tools/${encodeURIComponent(name)}/scopes ` +
              `with { "${required}": true }.`,
          },
          true,
        );
      }
      // Domain-bound egress (#122): when the tool's egress is bound to a
      // domain allowlist, the call's destination must be on it
      // (fail-closed when the destination cannot be determined).
      if (required === 'egress') {
        const egress = this.scopeStore.checkEgress(name, call.args);
        if (!egress.granted) {
          this.audit({ type: 'mcp.tool.domain_denied', call, detail: { host: egress.host ?? null, reason: egress.reason ?? '' } });
          return jsonResult(
            {
              status: 'denied',
              code: 'domain_denied',
              tool: name,
              requiredScope: 'egress',
              message:
                `Tool "${name}" egress denied: ${egress.reason}. ` +
                `Adjust the binding via PATCH /api/mcp/tools/${encodeURIComponent(name)}/scopes with { "domains": [...] }.`,
            },
            true,
          );
        }
      }
    }

    const key = `${name}\n${stableStringify(call.args)}`;

    // 0. Single-use grant from a prior human approval? Consume and execute.
    const grant = this.grants.get(key);
    if (grant && grant.expiresAt > Date.now()) {
      this.grants.delete(key);
      this.pending.delete(grant.approvalId);
      this.audit({ type: 'mcp.tool.approval_consumed', call, detail: { approvalId: grant.approvalId } });
      const res = await this.executeTool(name, args);
      this.audit({ type: 'mcp.tool.executed', call, detail: { via: 'approval_grant' } });
      return res;
    } else if (grant) {
      this.grants.delete(key);
      this.pending.delete(grant.approvalId);
    }

    // 1. Governance gate — classify → evaluate, exactly like the runtime.
    let decision: 'allow' | 'deny' | 'require-approval';
    let reason: string | undefined;
    let gatewayApprovalId: string | undefined;
    try {
      const classified = await this.governance.classify(call, this.ctx());
      const evaluated = await this.governance.evaluate(call, this.ctx());
      decision = evaluated.decision ?? classified;
      reason = evaluated.reason;
      gatewayApprovalId = evaluated.approvalId;
    } catch (err) {
      decision = 'deny';
      reason = `governance error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 2. Deny stays denied — no handshake can lift it.
    if (decision === 'deny') {
      this.audit({ type: 'mcp.tool.denied', call, detail: { reason } });
      return jsonResult(
        {
          status: 'denied',
          tool: name,
          reason: reason ?? 'denied by governance policy',
          note: 'Denials are final for this call. Ask the platform operator to change the policy if this tool should be usable.',
        },
        true,
      );
    }

    // 3. Require-approval: NEVER execute silently. Register pending and tell
    //    the client how to complete the handshake.
    if (decision === 'require-approval') {
      const approvalId = gatewayApprovalId ?? newApprovalId();
      this.pending.set(approvalId, { approvalId, key, call, createdAt: Date.now() });
      this.audit({ type: 'mcp.tool.approval_requested', call, detail: { approvalId, reason } });
      return jsonResult({
        status: 'approval_required',
        approvalId,
        tool: name,
        arguments: call.args,
        reason: reason ?? 'tool requires human approval per governance policy',
        howToApprove:
          'A human must approve via the host approval inbox (PlatformMcpServer.decideApproval). ' +
          'After approval, RE-ISSUE this exact tools/call with identical arguments; the server ' +
          'consumes the single-use grant and executes. Grants expire after ' +
          `${Math.round(this.approvalTtlMs / 1000)}s.`,
      });
    }

    // 4. Allowed → execute.
    const res = await this.executeTool(name, args);
    this.audit({ type: 'mcp.tool.executed', call });
    return res;
  }

  /**
   * Host-side approval handshake. Records a human decision for a pending
   * approval. An 'approved' decision mints a single-use, argument-bound
   * grant: the client's next identical tools/call executes; any other call
   * does not. Returns false when the approvalId is unknown.
   */
  decideApproval(approvalId: string, decision: 'approved' | 'denied'): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    if (decision === 'approved') {
      this.grants.set(pending.key, { approvalId, expiresAt: Date.now() + this.approvalTtlMs });
    } else {
      this.pending.delete(approvalId);
    }
    return true;
  }

  /** Build a fresh protocol Server per connection (SSE serves many clients). */
  private createProtocolServer(): Server {
    const server = new Server(this.serverInfo, {
      capabilities: { tools: {}, ...(this.telemetry ? { resources: {} } : {}) },
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.listMcpTools(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.handleCallTool(request.params.name, request.params.arguments),
    );
    // Telemetry is exposed as READ-ONLY resources only — no tools, no
    // mutation surface. Unset → no telemetry capability is advertised.
    if (this.telemetry) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => this.listTelemetryResources());
      server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
        this.readTelemetryResource(request.params.uri),
      );
    }
    return server;
  }

  /**
   * The `kriyadot://telemetry/*` resource surface: an aggregate summary, the
   * recent-runs list, and per-bot aggregates, plus URI templates for
   * addressing a single run or bot. All application/json, all read-only.
   */
  private listTelemetryResources(): {
    resources: Array<{ uri: string; name: string; description: string; mimeType: string }>;
    resourceTemplates: Array<{ uriTemplate: string; name: string; description: string; mimeType: string }>;
  } {
    const base = 'kriyadot://telemetry';
    return {
      resources: [
        {
          uri: `${base}/summary`,
          name: 'Runtime telemetry summary',
          description:
            'Aggregated runtime health: run counts, latency percentiles (p50/p95), error/retry rates, token totals and cost. Read-only.',
          mimeType: 'application/json',
        },
        {
          uri: `${base}/runs`,
          name: 'Recent telemetry runs',
          description:
            'Newest-first bot turns and workflow runs with per-step latencies, error/retry counts, and token cost. Read-only.',
          mimeType: 'application/json',
        },
        {
          uri: `${base}/bots`,
          name: 'Per-bot telemetry',
          description:
            'Aggregated runs, error rates, latency, tokens and cost per bot (workflow runs key as workflow:<id>). Read-only.',
          mimeType: 'application/json',
        },
      ],
      resourceTemplates: [
        {
          uriTemplate: `${base}/runs/{id}`,
          name: 'Telemetry run detail',
          description: 'Full step-level record for one run id. Read-only.',
          mimeType: 'application/json',
        },
        {
          uriTemplate: `${base}/bots/{id}`,
          name: 'Bot telemetry detail',
          description: 'Aggregated telemetry for one bot id. Read-only.',
          mimeType: 'application/json',
        },
      ],
    };
  }

  /** Read one `kriyadot://telemetry/*` resource. Unknown URIs are errors. */
  private readTelemetryResource(uri: string): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } {
    const tel = this.telemetry;
    if (!tel) {
      throw new McpError(ErrorCode.InvalidRequest, 'telemetry is not configured on this server');
    }
    const base = 'kriyadot://telemetry/';
    if (!uri.startsWith(base)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown telemetry resource: ${uri}`);
    }
    const rest = uri.slice(base.length);
    let payload: unknown;
    if (rest === 'summary') {
      payload = tel.summary();
    } else if (rest === 'runs') {
      payload = tel.listRuns(100);
    } else if (rest === 'bots') {
      payload = tel.listBots();
    } else if (rest.startsWith('runs/')) {
      payload = tel.getRun(decodeURIComponent(rest.slice('runs/'.length)));
      if (payload === null || payload === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `unknown telemetry run: ${uri}`);
      }
    } else if (rest.startsWith('bots/')) {
      payload = tel.getBotSummary(decodeURIComponent(rest.slice('bots/'.length)));
      if (payload === null || payload === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `unknown telemetry bot: ${uri}`);
      }
    } else {
      throw new McpError(ErrorCode.InvalidParams, `unknown telemetry resource: ${uri}`);
    }
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
    };
  }

  /** Attach to any SDK transport (stdio, SSE, in-memory, ...). */
  async connect(transport: Transport): Promise<Server> {
    const server = this.createProtocolServer();
    await server.connect(transport);
    this.servers.add(server);
    return server;
  }

  /** Serve over stdio (for MCP clients that spawn this process). */
  async serveStdio(): Promise<ServeHandle> {
    const server = await this.connect(new StdioServerTransport());
    return {
      close: async () => {
        this.servers.delete(server);
        await server.close();
      },
    };
  }

  /**
   * Serve over HTTP with the SSE transport (legacy SSE, matching the
   * platform's existing MCP client which speaks SSE/streamable HTTP).
   * GET {ssePath} opens an SSE session; POST {messagePath}?sessionId=...
   * carries client messages.
   */
  async serveHttp(opts?: {
    port?: number;
    ssePath?: string;
    messagePath?: string;
  }): Promise<HttpServeHandle> {
    const ssePath = opts?.ssePath ?? '/sse';
    const messagePath = opts?.messagePath ?? '/messages';
    const transports = new Map<string, SSEServerTransport>();
    const self = this;

    const httpServer: HttpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        try {
          if (url.pathname === ssePath && req.method === 'GET') {
            const transport = new SSEServerTransport(messagePath, res);
            transports.set(transport.sessionId, transport);
            res.on('close', () => {
              transports.delete(transport.sessionId);
            });
            await self.connect(transport);
            return;
          }
          if (url.pathname === messagePath && req.method === 'POST') {
            const sessionId = url.searchParams.get('sessionId') ?? '';
            const transport = transports.get(sessionId);
            if (!transport) {
              res.writeHead(400).end('unknown or expired SSE session');
              return;
            }
            await transport.handlePostMessage(req, res);
            return;
          }
          res.writeHead(404).end('not found');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) res.writeHead(500);
          res.end(`mcp server error: ${message}`);
        }
      },
    );

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(opts?.port ?? 0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : (opts?.port ?? 0);

    return {
      url: `http://127.0.0.1:${port}${ssePath}`,
      port,
      close: async () => {
        for (const t of transports.values()) {
          try {
            await t.close();
          } catch {
            // ignore per-transport close errors
          }
        }
        for (const s of this.servers) {
          try {
            await s.close();
          } catch {
            // ignore
          }
        }
        this.servers.clear();
        await new Promise<void>((resolve, reject) => {
          httpServer.close((e) => (e ? reject(e) : resolve()));
        });
      },
    };
  }

  /** Close every protocol server attached via connect(). */
  async close(): Promise<void> {
    for (const s of this.servers) {
      try {
        await s.close();
      } catch {
        // ignore
      }
    }
    this.servers.clear();
  }
}

// ---------------------------------------------------------------------------
// Five builtin MCP servers (Octomind parity #52)
// ---------------------------------------------------------------------------
//
// The platform's builtin surface used to be ONE server (`mvp-platform-mcp`)
// exposing everything. The suite splits that same surface into five
// logical servers by concern, each an independent PlatformMcpServer with
// its own name, independently listable/connectable, all built by the same
// factory (this section) over ONE shared ToolProvider:
//
//   core          — general platform tools (the default bucket)
//   orchestration — delegation, teams, workflows, scheduling, MCP admin
//   runtime       — memory, checkpoints, recall, verify, telemetry tools
//                   (and the telemetry RESOURCES, which are runtime data)
//   agent         — the `chat` bot-invocation tool + user-interaction and
//                   web tools the agent persona drives
//   local         — local machine surface: files, shell, git, computer
//
// Partitioning is by tool NAME (see builtinServerForTool) and is total:
// every tool lands in exactly one server. Backward compatibility:
// PlatformMcpServer itself is unchanged — the existing single-server
// construction keeps working and exposes the full surface; the suite is
// additive. `createBuiltinMcpServer(opts, 'core')` is the closest analog
// of the old entry when a host wants just the core partition.

export const BUILTIN_MCP_SERVER_IDS = ['core', 'orchestration', 'runtime', 'agent', 'local'] as const;

export type BuiltinMcpServerId = (typeof BUILTIN_MCP_SERVER_IDS)[number];

const ORCHESTRATION_TOOL_RE =
  /^(delegate|delegate_|ask_bot|message_bot|coordinate_bots|create_bot|propose_|raise_escalation|retry_thread|run_workflow|workflow|schedule_|thread_schedule|mcp_manage|spawn_|subagent)/i;
const RUNTIME_TOOL_RE =
  /^(memory_|recall|recall_|checkpoint|verify|verify_|usage|telemetry|session_|health|hindsight|distill)/i;
const LOCAL_TOOL_RE =
  /^(run_command|shell|exec|git_|computer_|local:|read_file|write_file|edit_file|create_file|delete_file|remove_file|list_dir|list_files|glob|grep|apply_patch|patch_file|move_file|copy_file)/i;
const AGENT_TOOL_RE =
  /^(chat$|ask_user_question|request_credential|web_search|web_fetch|fetch|search_|browser_)/i;

/** Which builtin server a tool name belongs to. Total + deterministic. */
export function builtinServerForTool(toolName: string): BuiltinMcpServerId {
  const name = toolName.trim();
  if (ORCHESTRATION_TOOL_RE.test(name)) return 'orchestration';
  if (RUNTIME_TOOL_RE.test(name)) return 'runtime';
  if (LOCAL_TOOL_RE.test(name)) return 'local';
  if (AGENT_TOOL_RE.test(name)) return 'agent';
  return 'core';
}

/** Partition tool defs by builtin server id; every id key is present. */
export function partitionToolDefs(
  defs: readonly PlatformToolDef[],
): Record<BuiltinMcpServerId, PlatformToolDef[]> {
  const out: Record<BuiltinMcpServerId, PlatformToolDef[]> = {
    core: [],
    orchestration: [],
    runtime: [],
    agent: [],
    local: [],
  };
  for (const def of defs) out[builtinServerForTool(def.name)].push(def);
  return out;
}

/** A ToolProvider view exposing only one partition of a shared provider. */
export function partitionedToolProvider(provider: ToolProvider, id: BuiltinMcpServerId): ToolProvider {
  return {
    listTools: async () => {
      const all = await provider.listTools();
      return all.filter((d) => builtinServerForTool(d.name) === id);
    },
    callTool: async (name, args) => {
      if (builtinServerForTool(name) !== id) {
        throw new Error(`Tool "${name}" is not served by the "${id}" builtin MCP server.`);
      }
      return provider.callTool(name, args);
    },
  };
}

/** The five-server suite: one PlatformMcpServer per builtin id. */
export interface PlatformMcpServerSuite {
  /** The serverSet: every builtin server by id. */
  servers: Record<BuiltinMcpServerId, PlatformMcpServer>;
  get(id: BuiltinMcpServerId): PlatformMcpServer;
  ids(): BuiltinMcpServerId[];
  /** Tool defs listed by one server (its partition only). */
  listToolDefs(id: BuiltinMcpServerId): Promise<PlatformToolDef[]>;
  closeAll(): Promise<void>;
}

/**
 * Build the five-server suite from the same options the single server
 * takes. Governance, bot/session identity, scopes and the tool filter are
 * shared across all five; the `chat` tool lands on `agent` only, and
 * telemetry resources on `runtime` only. Server names default to
 * `<base>-<id>` (e.g. `mvp-platform-mcp-core`).
 */
export function createPlatformMcpServerSuite(opts: PlatformMcpServerOptions): PlatformMcpServerSuite {
  const baseName = opts.serverInfo?.name ?? 'mvp-platform-mcp';
  const baseVersion = opts.serverInfo?.version ?? '0.1.0';
  const servers = {} as Record<BuiltinMcpServerId, PlatformMcpServer>;
  for (const id of BUILTIN_MCP_SERVER_IDS) {
    servers[id] = new PlatformMcpServer({
      ...opts,
      tools: partitionedToolProvider(opts.tools, id),
      chat: id === 'agent' ? opts.chat : undefined,
      telemetry: id === 'runtime' ? opts.telemetry : undefined,
      serverInfo: { name: `${baseName}-${id}`, version: baseVersion },
    });
  }
  return {
    servers,
    get: (id) => servers[id],
    ids: () => [...BUILTIN_MCP_SERVER_IDS],
    listToolDefs: (id) => servers[id].listToolDefs(),
    closeAll: async () => {
      await Promise.all(Object.values(servers).map((s) => s.close()));
    },
  };
}

/**
 * Build ONE builtin server from the suite by id. Note the single-server
 * PlatformMcpServer construction remains the backward-compatible default
 * (full surface); this helper is for hosts that want one partition only.
 */
export function createBuiltinMcpServer(
  opts: PlatformMcpServerOptions,
  id: BuiltinMcpServerId,
): PlatformMcpServer {
  return createPlatformMcpServerSuite(opts).get(id);
}
