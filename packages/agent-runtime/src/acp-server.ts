// SPDX-License-Identifier: Apache-2.0
/**
 * ACP server mode (Octomind parity).
 *
 * KriyaDot's runtime already SPEAKS ACP as a client (acp-engines.ts —
 * it drives external ACP agents like Copilot CLI). This module is the
 * other direction: KriyaDot AS an ACP agent. Any ACP client (Zed and
 * other editors) can spawn `mvp-server acp --bot <id>` and drive the
 * bot over newline-delimited JSON-RPC 2.0 on stdio:
 *
 *   initialize        → capabilities handshake
 *   session/new       → a fresh runtime session for the bot
 *   session/prompt    → runs a turn; agent_message_chunk /
 *                       tool_call / tool_call_update stream back as
 *                       session/update notifications; resolves with a
 *                       stopReason
 *   session/cancel    → aborts the in-flight prompt for that session
 *   session/request_permission (server→client request): when the
 *                       governance gateway needs a human decision, the
 *                       client is asked with allow_once / reject_once
 *                       options — the ACP-native approval card.
 *
 * Protocol shapes follow the Agent Client Protocol (agentclientprotocol.com):
 * content blocks { type:'text', text }, sessionUpdate discriminators
 * 'agent_message_chunk' | 'tool_call' | 'tool_call_update'.
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from './runtime.js';
import type {
  AuditEntry,
  GovernanceDecision,
  GovernanceEvaluation,
  GovernanceGateway,
} from './governance.js';
import type { BotConfig, StreamEvent, ToolCall, ToolContext, ToolDefinition } from './types.js';
import {
  MCPClient,
  ElicitationRouter,
  defaultElicitationRouter,
  type ElicitationRequest,
  type ElicitationResult,
} from './mcp.js';

export const ACP_PROTOCOL_VERSION = 1;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const READ_TOOL_RE =
  /^(read|list|get|search|find|grep|glob|recall|web_search|web_fetch|view|describe|check|fetch|query|inspect)/i;

export interface AcpServerDeps {
  runtime: AgentRuntime;
  bot: BotConfig;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Create a runtime session id for session/new (host owns the store). */
  createSessionId: () => string;
  /** Log sink for diagnostics (never stdout — that is the protocol). */
  log?: (message: string) => void;
  /**
   * Host MCP-server injection (#99): the SAME Map instance the runtime
   * resolves tools from. Tools of host-provided MCP servers are
   * registered here for the session and removed at session close.
   * Without it, connected servers' tool NAMES are still recorded on
   * the session (visible in the session/new response) but cannot be
   * resolved by the runtime — the CLI host passes its registry.
   */
  toolRegistry?: Map<string, ToolDefinition>;
  /**
   * MCP client factory seam (tests inject a fake/builtin server).
   * Defaults to a real MCPClient per server config.
   */
  createMcpClient?: (server: AcpMcpServerConfig) => AcpMcpClientLike;
  /** Resolve a persisted session for session/load: existence check. */
  sessionExists?: (sessionId: string) => boolean;
  /**
   * Elicitation routing (#51): MCP servers connected into ACP sessions
   * route their elicitation/create requests through this router on the
   * 'acp' surface; the server registers its own 'acp' handler on it
   * (forwarding to the connected ACP client) for its lifetime. Defaults
   * to the process-wide defaultElicitationRouter.
   */
  elicitationRouter?: ElicitationRouter;
}

/** One host-provided MCP server entry from session/new params.mcpServers. */
export interface AcpMcpServerConfig {
  name: string;
  /** stdio transport. */
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
  /** HTTP (Streamable) transport. */
  url?: string;
  headers?: Array<{ name: string; value: string }> | Record<string, string>;
  type?: string;
}

/** The slice of MCPClient the ACP server uses (fake-able in tests). */
export interface AcpMcpClientLike {
  connectStdio(config: { command: string; args?: string[]; env?: Record<string, string> }): Promise<void>;
  connectHttp(url: string, opts?: { authToken?: string }): Promise<void>;
  listTools(): Promise<ToolDefinition[]>;
  close(): Promise<void>;
}

interface AcpSessionState {
  sessionId: string;
  cwd?: string;
  bot: BotConfig;
  mcpClients: AcpMcpClientLike[];
  mcpToolNames: string[];
}

/** Parse session/new mcpServers params into typed configs. Never throws. */
export function parseAcpMcpServers(raw: unknown): AcpMcpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpMcpServerConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' && o.name ? o.name : 'host-mcp';
    const cfg: AcpMcpServerConfig = { name };
    if (typeof o.command === 'string' && o.command) cfg.command = o.command;
    if (Array.isArray(o.args)) cfg.args = o.args.filter((a): a is string => typeof a === 'string');
    if (typeof o.url === 'string' && o.url) cfg.url = o.url;
    if (typeof o.type === 'string' && o.type) cfg.type = o.type;
    if (o.env && typeof o.env === 'object') cfg.env = o.env as AcpMcpServerConfig['env'];
    if (o.headers && typeof o.headers === 'object') cfg.headers = o.headers as AcpMcpServerConfig['headers'];
    if (cfg.command || cfg.url) out.push(cfg);
  }
  return out;
}

function envRecord(env: AcpMcpServerConfig['env']): Record<string, string> | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const e of env) if (e && typeof e.name === 'string') out[e.name] = String(e.value ?? '');
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = String(v);
  return out;
}

interface PendingPermission {
  sessionId: string;
  call: ToolCall;
}

export class AcpServer {
  private readonly deps: AcpServerDeps;
  private readonly pendingClientRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextClientRequestId = 1;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly sessions = new Map<string, AcpSessionState>();
  private rl?: ReturnType<typeof createInterface>;
  private stopped = false;
  /** Elicitation router (#51) + this server's 'acp' handler registration. */
  private readonly elicitationRouter: ElicitationRouter;
  private unregisterElicitation?: () => void;
  /** Session whose turn is currently running (elicitation target). */
  private elicitationSessionId: string | undefined;

  constructor(deps: AcpServerDeps) {
    this.deps = deps;
    this.elicitationRouter = deps.elicitationRouter ?? defaultElicitationRouter;
    // #51: forward MCP elicitation to the ACP client while a prompt is
    // running on this connection. Registered for the server's lifetime;
    // stop() unregisters. With no prompt in flight the handler declines.
    this.unregisterElicitation = this.elicitationRouter.register(
      'acp',
      (req) => this.requestElicitation(req),
    );
  }

  /**
   * Bridge one MCP elicitation request to the ACP client as an
   * `elicitation/create` client request on the active session. Any
   * transport failure, missing session, or malformed client answer
   * declines (fail closed, the MCP client's own contract).
   */
  private async requestElicitation(req: ElicitationRequest): Promise<ElicitationResult> {
    const sessionId = this.elicitationSessionId;
    if (!sessionId || this.stopped) return { action: 'decline' };
    const id = this.nextClientRequestId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pendingClientRequests.set(id, { resolve, reject });
      this.send({
        jsonrpc: '2.0',
        id,
        method: 'elicitation/create',
        params: { sessionId, message: req.message, requestedSchema: req.requestedSchema },
      });
    }).catch(() => null);
    const action = (result as { action?: unknown } | null)?.action;
    if (action === 'accept') {
      const content = (result as { content?: unknown }).content;
      return {
        action: 'accept',
        ...(content && typeof content === 'object'
          ? { content: content as Record<string, unknown> }
          : {}),
      };
    }
    if (action === 'cancel') return { action: 'cancel' };
    return { action: 'decline' };
  }

  start(): void {
    this.rl = createInterface({ input: this.deps.input, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcRequest & { result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(trimmed) as typeof msg;
      } catch {
        this.deps.log?.(`acp: unparseable line ignored`);
        return;
      }
      if (msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
        // A response to one of OUR requests (permission round-trip).
        const id = Number((msg as { id?: unknown }).id);
        const pending = this.pendingClientRequests.get(id);
        if (pending) {
          this.pendingClientRequests.delete(id);
          if (msg.error) pending.reject(new Error('client returned an error'));
          else pending.resolve(msg.result);
        }
        return;
      }
      void this.handleRequest(msg).catch((err) => {
        this.deps.log?.(`acp: handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unregisterElicitation?.();
    for (const controller of this.controllers.values()) controller.abort();
    for (const sessionId of [...this.sessions.keys()]) await this.teardownSession(sessionId);
    this.rl?.close();
  }

  /** Per-session MCP teardown (#99): close clients, unregister their tools. */
  async teardownSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    if (this.deps.toolRegistry) {
      for (const name of state.mcpToolNames) this.deps.toolRegistry.delete(name);
    }
    for (const client of state.mcpClients) {
      try { await client.close(); } catch { /* teardown is best-effort */ }
    }
  }

  /** Tool names a session's host MCP servers exposed (test/inspection seam). */
  sessionMcpTools(sessionId: string): string[] {
    return [...(this.sessions.get(sessionId)?.mcpToolNames ?? [])];
  }

  private defaultMcpClient(server: AcpMcpServerConfig): AcpMcpClientLike {
    // #51: session MCP clients route elicitation through the shared
    // router on the 'acp' surface (this server's forwarding handler).
    return new MCPClient({
      serverName: server.name,
      elicitationRouter: this.elicitationRouter,
      elicitationSurface: 'acp',
    }) as unknown as AcpMcpClientLike;
  }

  /** Connect one host MCP server and register its tools for the session. */
  private async connectMcpServer(state: AcpSessionState, server: AcpMcpServerConfig): Promise<void> {
    const client = this.deps.createMcpClient ? this.deps.createMcpClient(server) : this.defaultMcpClient(server);
    if (server.command) {
      await client.connectStdio({ command: server.command, ...(server.args ? { args: server.args } : {}), ...(envRecord(server.env) ? { env: envRecord(server.env) } : {}) });
    } else if (server.url) {
      await client.connectHttp(server.url);
    } else {
      throw new Error(`MCP server "${server.name}" has neither command nor url`);
    }
    const tools = await client.listTools();
    state.mcpClients.push(client);
    for (const tool of tools) {
      state.mcpToolNames.push(tool.name);
      if (this.deps.toolRegistry) this.deps.toolRegistry.set(tool.name, tool);
      if (!state.bot.tools.includes(tool.name)) state.bot.tools.push(tool.name);
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.stopped) return;
    this.deps.output.write(`${JSON.stringify(msg)}\n`);
  }

  private respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result } satisfies JsonRpcResponse);
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } } satisfies JsonRpcResponse);
  }

  private notify(sessionId: string, update: Record<string, unknown>): void {
    this.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  /** Ask the CLIENT for a permission decision (ACP request_permission). */
  async requestPermission(sessionId: string, call: ToolCall): Promise<boolean> {
    const id = this.nextClientRequestId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pendingClientRequests.set(id, { resolve, reject });
      this.send({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: call.id,
            title: call.name,
            kind: 'other',
            status: 'pending',
            rawInput: call.args ?? {},
          },
          options: [
            { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    }).catch(() => null);
    const outcome = (result as { outcome?: { outcome?: string; optionId?: string } } | null)?.outcome;
    return outcome?.outcome === 'selected' && outcome.optionId === 'approve';
  }

  /** Bridge for AcpGovernanceGateway: remember what an approval id is for. */
  registerPendingPermission(approvalId: string, sessionId: string, call: ToolCall): void {
    this.pendingPermissions.set(approvalId, { sessionId, call });
  }

  /** Bridge for AcpGovernanceGateway: resolve an approval via the client. */
  async resolvePermission(approvalId: string): Promise<'approved' | 'denied'> {
    const pending = this.pendingPermissions.get(approvalId);
    if (!pending) return 'denied';
    this.pendingPermissions.delete(approvalId);
    const ok = await this.requestPermission(pending.sessionId, pending.call);
    return ok ? 'approved' : 'denied';
  }

  private async handleRequest(msg: JsonRpcRequest): Promise<void> {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        if (id !== undefined) {
          this.respond(id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              // #98: session/load is implemented (history replay below).
              loadSession: true,
              promptCapabilities: { image: false, audio: false, embeddedContext: true },
              // #99: stdio + Streamable HTTP host servers are actually
              // connected (MCPClient); SSE transport is NOT supported,
              // so sse stays false — capabilities never over-claim.
              mcpCapabilities: { http: true, sse: false, stdio: true },
            },
            authMethods: [],
            agentInfo: { name: 'kriyadot', title: 'KriyaDot', version: '0.1.0' },
          });
        }
        return;
      }
      case 'session/new': {
        if (id === undefined) return;
        const sessionId = this.deps.createSessionId();
        // #99: PARSE params — cwd is recorded for the session, and
        // host-provided mcpServers are connected into it (tools are
        // registered for this session and torn down at close).
        const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd : undefined;
        const state: AcpSessionState = {
          sessionId,
          ...(cwd ? { cwd } : {}),
          bot: { ...this.deps.bot, tools: [...this.deps.bot.tools] },
          mcpClients: [],
          mcpToolNames: [],
        };
        this.sessions.set(sessionId, state);
        const mcpErrors: string[] = [];
        for (const server of parseAcpMcpServers(params?.mcpServers)) {
          try {
            await this.connectMcpServer(state, server);
          } catch (err) {
            mcpErrors.push(`${server.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.respond(id, {
          sessionId,
          ...(cwd ? { cwd } : {}),
          ...(state.mcpToolNames.length ? { _meta: { mcpTools: state.mcpToolNames } } : {}),
          ...(mcpErrors.length ? { _meta: { ...(state.mcpToolNames.length ? { mcpTools: state.mcpToolNames } : {}), mcpErrors } } : {}),
        });
        return;
      }
      case 'session/load': {
        if (id === undefined) return;
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
        if (!sessionId) {
          this.respondError(id, -32602, 'session/load requires sessionId');
          return;
        }
        // #98: restore a persisted session and replay its history as
        // session/update notifications (user/agent message chunks in
        // stored order), per ACP load-session semantics.
        let messages: Array<{ role: string; content: string }> = [];
        try {
          messages = this.deps.runtime.listThreadMessages(sessionId) as Array<{ role: string; content: string }>;
        } catch {
          messages = [];
        }
        const known = this.sessions.has(sessionId) || messages.length > 0 || (this.deps.sessionExists ? this.deps.sessionExists(sessionId) : false);
        if (!known) {
          this.respondError(id, -32602, `unknown session "${sessionId}"`);
          return;
        }
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            sessionId,
            bot: { ...this.deps.bot, tools: [...this.deps.bot.tools] },
            mcpClients: [],
            mcpToolNames: [],
          });
        }
        for (const m of messages) {
          this.notify(sessionId, {
            sessionUpdate: m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) },
          });
        }
        this.respond(id, {});
        return;
      }
      case 'session/close': {
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
        if (sessionId) await this.teardownSession(sessionId);
        if (id !== undefined) this.respond(id, {});
        return;
      }
      case 'session/prompt': {
        if (id === undefined) return;
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
        const blocks = Array.isArray(params?.prompt) ? (params!.prompt as Array<Record<string, unknown>>) : [];
        const text = blocks
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n');
        if (!sessionId || !text) {
          this.respondError(id, -32602, 'session/prompt requires sessionId and a text prompt');
          return;
        }
        const stopReason = await this.runPrompt(sessionId, text);
        this.respond(id, { stopReason });
        return;
      }
      case 'session/cancel': {
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
        this.controllers.get(sessionId)?.abort();
        return; // notification — no response
      }
      default: {
        if (id !== undefined) this.respondError(id, -32601, `method not found: ${method}`);
      }
    }
  }

  private async runPrompt(sessionId: string, text: string): Promise<string> {
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    // #51: elicitation arriving during this turn targets this session.
    this.elicitationSessionId = sessionId;
    try {
      await this.deps.runtime.runTurn({
        bot: this.sessions.get(sessionId)?.bot ?? this.deps.bot,
        message: text,
        sessionId,
        signal: controller.signal,
        onEvent: (event: StreamEvent) => {
          this.forwardEvent(sessionId, event);
        },
      });
      return controller.signal.aborted ? 'cancelled' : 'end_turn';
    } catch {
      return controller.signal.aborted ? 'cancelled' : 'end_turn';
    } finally {
      this.controllers.delete(sessionId);
      if (this.elicitationSessionId === sessionId) this.elicitationSessionId = undefined;
    }
  }

  private forwardEvent(sessionId: string, event: StreamEvent): void {
    switch (event.type) {
      case 'token':
        this.notify(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.content },
        });
        return;
      case 'tool_call':
        this.notify(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: event.call.id,
          title: event.call.name,
          kind: 'other',
          status: 'pending',
          rawInput: event.call.args ?? {},
        });
        return;
      case 'tool_result':
        this.notify(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.call.id,
          status: event.denied ? 'failed' : 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
              },
            },
          ],
        });
        return;
      case 'done': {
        // Cost/usage side-channel (#98/#179): usage events used to be
        // DROPPED here. They now go out as an ACP `usage_update`
        // session/update (spec-consistent extension): `used` is the
        // turn's total tokens; cache buckets and a USD cost are
        // included when the runtime's usage record carries them.
        const usage = event.usage as unknown as Record<string, unknown>;
        this.notify(sessionId, {
          sessionUpdate: 'usage_update',
          used: typeof usage.totalTokens === 'number' ? usage.totalTokens : 0,
          size: 0,
          ...(typeof usage.costUsd === 'number' ? { cost: { amount: usage.costUsd, currency: 'USD' } } : {}),
          _meta: {
            kriyadotUsage: {
              promptTokens: usage.promptTokens ?? null,
              completionTokens: usage.completionTokens ?? null,
              totalTokens: usage.totalTokens ?? null,
              cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : null,
              cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : null,
              costUsd: typeof usage.costUsd === 'number' ? usage.costUsd : null,
            },
          },
        });
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Governance gateway for ACP mode: reads auto-allow (mirroring the
 * platform's default policy posture); everything else becomes an ACP
 * request_permission round-trip to the client. Fail-closed: no server
 * bridge or a client error → denied.
 */
export class AcpGovernanceGateway implements GovernanceGateway {
  private readonly bridge: { server?: AcpServer };

  constructor(bridge: { server?: AcpServer }) {
    this.bridge = bridge;
  }

  classify(call: ToolCall): GovernanceDecision {
    return READ_TOOL_RE.test(call.name) ? 'allow' : 'require-approval';
  }

  async evaluate(call: ToolCall, _ctx: ToolContext): Promise<GovernanceEvaluation> {
    const decision = this.classify(call);
    if (decision === 'allow') return { decision };
    const approvalId = randomUUID();
    this.bridge.server?.registerPendingPermission(approvalId, _ctx.sessionId, call);
    return { decision, approvalId };
  }

  async awaitDecision(approvalId: string): Promise<'approved' | 'denied'> {
    if (!this.bridge.server) return 'denied';
    return this.bridge.server.resolvePermission(approvalId);
  }

  decide(): void {
    // Decisions arrive via the permission round-trip, not decide().
  }

  audit(_entry: AuditEntry): void {
    // ACP mode has no audit store of its own; the host's runtime audit
    // wiring (if any) observes turns separately.
  }

  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}
