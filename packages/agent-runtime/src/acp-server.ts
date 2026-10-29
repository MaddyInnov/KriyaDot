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
import type { BotConfig, StreamEvent, ToolCall, ToolContext } from './types.js';

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
  private rl?: ReturnType<typeof createInterface>;
  private stopped = false;

  constructor(deps: AcpServerDeps) {
    this.deps = deps;
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
    for (const controller of this.controllers.values()) controller.abort();
    this.rl?.close();
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
              loadSession: false,
              promptCapabilities: { image: false, audio: false, embeddedContext: true },
              mcpCapabilities: { http: false, sse: false },
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
        this.respond(id, { sessionId });
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
    try {
      await this.deps.runtime.runTurn({
        bot: this.deps.bot,
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
