// SPDX-License-Identifier: Apache-2.0
/**
 * KriyaDot Agent SDK — the versioned PUBLIC API surface of
 * `@mvp/agent-runtime` (CA-20, coding-apps parity audit).
 *
 * This module is the SDK contract. Everything re-exported or defined
 * here is the supported embedder surface; everything reachable only
 * through the package's internal index (`./index.js`) is INTERNAL and
 * may change without a version bump. Stability policy:
 *
 * - `SDK_API_VERSION` is the major contract version ('1'). Breaking
 *   changes to anything exported from this module bump it.
 * - Within a version, additions are backwards-compatible; removals
 *   and signature changes are not made.
 * - Import the SDK from the dedicated entrypoint
 *   (`@kriyadot/agent-runtime/sdk` once the coordinator adds the
 *   package `exports` entry — see SDK.md), never from deep internal
 *   paths.
 *
 * What an embedder gets:
 * - {@link SdkSessionStorage}: the external session-storage contract.
 *   Plug your own session store (Redis, Postgres, in-memory…);
 *   {@link BuiltinSessionStorage} (SQLite, via SessionStore) is the
 *   default implementation.
 * - {@link createSdkAgent}: a small embeddable agent that runs turns
 *   over any {@link LLMProvider} with typed streaming events, persisting
 *   through the storage adapter.
 * - Custom tools, two ways: plain typed {@link SdkTool} definitions,
 *   and IN-PROCESS MCP tools via {@link createInProcessMcpTools} —
 *   the definitions cross the real MCP protocol path (loopback
 *   transport, tools/list + tools/call) instead of direct dispatch.
 * - {@link AgentRuntime} re-exported for advanced hosts that want the
 *   full runtime (governance gateway, skill loader, subagents…).
 *
 * Governance: the SDK never weakens it. Mutating tools do not run
 * unless the embedder supplies an `approveToolCall` gate that allows
 * the specific call, or explicitly sets `allowMutatingTools: true`
 * (their own policy decision, made in their code — not a default).
 */

import { AgentRuntime } from './runtime.js';
import type { RunTurnOptions } from './runtime.js';
import { SessionStore } from './sessions.js';
import type { SessionRecord, SessionSummary } from './sessions.js';
import { MockProvider, scriptedBotTurn } from './providers/mock.js';
import type { MockStep } from './providers/mock.js';
import { createToolFacade } from './mcp-facade.js';
import type { ToolFacade, ToolTransport } from './mcp-facade.js';
import { McpChannelHub, allowAllChannelGate, channelGateFromClassifier } from './mcp-channels.js';
import type {
  McpChannel,
  McpChannelDescriptor,
  McpChannelEvent,
  McpChannelGate,
  McpChannelHubOptions,
  McpChannelInjector,
} from './mcp-channels.js';
import type {
  BotConfig,
  ChatMessage,
  LLMProvider,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// Versioned surface: core types + the full runtime for advanced hosts
// ---------------------------------------------------------------------------

/** SDK contract major version. Breaking SDK changes bump this. */
export const SDK_API_VERSION = '1';
/** SDK package version (semver of the SDK surface, not the app). */
export const SDK_VERSION = '1.0.0';

export { AgentRuntime, MockProvider, scriptedBotTurn };
export type { RunTurnOptions, MockStep };
export type {
  BotConfig,
  ChatMessage,
  LLMProvider,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
};
export type { SessionRecord, SessionSummary };
export { McpChannelHub, allowAllChannelGate, channelGateFromClassifier };
export type {
  McpChannel,
  McpChannelDescriptor,
  McpChannelEvent,
  McpChannelGate,
  McpChannelHubOptions,
  McpChannelInjector,
};
export type { ToolFacade, ToolTransport };

// ---------------------------------------------------------------------------
// (a) External session storage
// ---------------------------------------------------------------------------

/**
 * The external session-storage contract. An embedder's store only
 * needs these five operations; every method may be sync or async.
 * Messages are the SDK's {@link ChatMessage} shape, stored verbatim
 * and returned in insertion order. Implementations must be safe to
 * call concurrently for DIFFERENT sessions; same-session calls are
 * serialized by the agent.
 */
export interface SdkSessionStorage {
  /** Create a session for a bot; returns the new session id. */
  createSession(botId: string, opts?: { ownerPersonId?: string; projectId?: string }): Promise<string> | string;
  /** The session record, or undefined when unknown. */
  getSession(sessionId: string): Promise<SessionRecord | undefined> | SessionRecord | undefined;
  /** Append one message to a session's history (insertion order). */
  appendMessage(sessionId: string, message: ChatMessage): Promise<void> | void;
  /** Full history, oldest first. */
  getMessages(sessionId: string): Promise<ChatMessage[]>;
  /** Session summaries, most recently active first. */
  listSessions(opts?: { botId?: string; limit?: number; projectId?: string }): Promise<SessionSummary[]> | SessionSummary[];
  /** Release underlying resources (optional). */
  close?(): Promise<void> | void;
}

/**
 * The default storage implementation: the built-in SQLite
 * {@link SessionStore} (compaction, search, archives included).
 * `dbPath` may be ':memory:' for ephemeral embeds and tests.
 */
export class BuiltinSessionStorage implements SdkSessionStorage {
  readonly store: SessionStore;

  constructor(dbPath: string, opts: { historyLimit?: number } = {}) {
    this.store = new SessionStore(dbPath, { historyLimit: opts.historyLimit });
  }

  createSession(botId: string, opts: { ownerPersonId?: string; projectId?: string } = {}): string {
    return this.store.createSession(botId, opts);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.store.getSession(sessionId);
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    this.store.appendMessage(sessionId, message);
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.store.getMessages(sessionId);
  }

  listSessions(opts: { botId?: string; limit?: number; projectId?: string } = {}): SessionSummary[] {
    return this.store.listSessions(opts);
  }

  close(): void {
    this.store.close();
  }
}

// ---------------------------------------------------------------------------
// (b) Custom tools — plain typed definitions + in-process MCP
// ---------------------------------------------------------------------------

/** A custom tool definition for the SDK (the runtime ToolDefinition shape). */
export type SdkTool = ToolDefinition;

/** Define a typed custom tool. Identity helper — exists for inference + docs. */
export function defineSdkTool(tool: SdkTool): SdkTool {
  if (!tool.name?.trim()) throw new Error('defineSdkTool: name is required');
  if (typeof tool.handler !== 'function') throw new Error(`defineSdkTool(${tool.name}): handler must be a function`);
  return tool;
}

/**
 * In-process MCP custom tools (the documented, typed surface over
 * mcp-facade.ts): the given definitions are served by an in-process
 * MCP server and consumed through the real MCP client path over a
 * loopback transport — `tools/list` / `tools/call` JSON-RPC frames,
 * TOFU pinning and context epochs included — then returned as plain
 * ToolDefinitions whose names match the input definitions exactly,
 * ready to hand to {@link createSdkAgent} or AgentRuntime.
 *
 * Use this when tools must behave EXACTLY as an external MCP server's
 * tools do (schema handling, wire serialization) without a process
 * boundary — e.g. testing an MCP tool pack before publishing it as a
 * standalone server. For plain in-process tools with no protocol
 * needs, register {@link SdkTool}s directly instead (zero overhead).
 *
 * The returned facade must be closed (`facade.close()`) when done.
 */
export async function createInProcessMcpTools(
  tools: SdkTool[],
  opts: { serverInfo?: { name: string; version: string } } = {},
): Promise<{ tools: ToolDefinition[]; facade: ToolFacade }> {
  const registry = new Map(tools.map((t) => [t.name, t]));
  const facade = await createToolFacade(registry, {
    toolTransport: 'mcp',
    ...(opts.serverInfo ? { serverInfo: opts.serverInfo } : {}),
  });
  return { tools: await facade.listTools(), facade };
}

// ---------------------------------------------------------------------------
// The embeddable agent
// ---------------------------------------------------------------------------

export interface SdkAgentConfig {
  /** Any LLMProvider (MockProvider for tests; a real driver in production). */
  provider: LLMProvider;
  /** Session storage. Default: in-memory BuiltinSessionStorage. */
  storage?: SdkSessionStorage;
  /** Custom tools available to every bot run through this agent. */
  tools?: SdkTool[];
  /**
   * Governance gate for MUTATING tools. Consulted before every
   * mutating tool call with the call and context; only an explicit
   * `true` lets the call run. When unset, mutating tools are denied
   * unless `allowMutatingTools` is set.
   */
  approveToolCall?: (info: { call: ToolCall; sessionId: string; botId: string }) => Promise<boolean> | boolean;
  /**
   * Explicit embedder policy: run mutating tools without a gate.
   * Default false (fail closed). Setting this is the embedder's own
   * policy decision — the SDK default never weakens governance.
   */
  allowMutatingTools?: boolean;
  /** Max provider iterations per turn (default 8). */
  maxIterations?: number;
}

export interface SdkTurnResult {
  sessionId: string;
  content: string;
  usage: TokenUsage;
  /** Tool calls executed during the turn, in order. */
  toolCalls: ToolCall[];
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * A small embeddable agent: provider + storage adapter + tools, with
 * a typed event stream. For the full hosted runtime (governance
 * gateway, skills, MCP servers, subagents) use {@link AgentRuntime}
 * directly — this facade is the deliberately small SDK surface.
 */
export class SdkAgent {
  private readonly provider: LLMProvider;
  private readonly storage: SdkSessionStorage;
  private readonly tools = new Map<string, SdkTool>();
  private readonly approveToolCall?: SdkAgentConfig['approveToolCall'];
  private readonly allowMutatingTools: boolean;
  private readonly maxIterations: number;

  constructor(config: SdkAgentConfig) {
    this.provider = config.provider;
    this.storage = config.storage ?? new BuiltinSessionStorage(':memory:');
    for (const t of config.tools ?? []) this.registerTool(t);
    this.approveToolCall = config.approveToolCall;
    this.allowMutatingTools = config.allowMutatingTools === true;
    this.maxIterations = Math.max(1, Math.floor(config.maxIterations ?? 8));
  }

  /** Register (or replace) a custom tool at runtime. */
  registerTool(tool: SdkTool): void {
    this.tools.set(defineSdkTool(tool).name, tool);
  }

  /** Names of the tools currently registered. */
  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** The storage adapter in use (the embedder's, or the built-in default). */
  get sessionStorage(): SdkSessionStorage {
    return this.storage;
  }

  createSession(botId: string, opts: { ownerPersonId?: string; projectId?: string } = {}): Promise<string> {
    return Promise.resolve(this.storage.createSession(botId, opts));
  }

  /**
   * Run one turn: append the user message to the session (creating the
   * session when `sessionId` is omitted), call the provider with the
   * stored history + the bot's tools, execute tool calls (governance
   * gate for mutating ones), persist every message, and stream typed
   * events to `onEvent` when given.
   */
  async runTurn(input: {
    bot: BotConfig;
    message: string;
    sessionId?: string;
    onEvent?: (e: StreamEvent) => void | Promise<void>;
  }): Promise<SdkTurnResult> {
    const bot = input.bot;
    const sessionId = input.sessionId ?? (await this.createSession(bot.id));
    const emit = async (e: StreamEvent): Promise<void> => {
      if (input.onEvent) await input.onEvent(e);
    };
    const userMessage: ChatMessage = { role: 'user', content: input.message };
    await this.storage.appendMessage(sessionId, userMessage);

    const botTools = bot.tools.length > 0
      ? [...this.tools.values()].filter((t) => bot.tools.includes(t.name))
      : [...this.tools.values()];
    const executedCalls: ToolCall[] = [];
    let usage: TokenUsage = { ...ZERO_USAGE };
    let content = '';

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const history = await this.storage.getMessages(sessionId);
      const messages: ChatMessage[] = [
        { role: 'system', content: bot.systemPrompt },
        ...history,
      ];
      const result = await this.provider.chat(messages, botTools, {
        model: bot.model,
        onToken: (t) => {
          void emit({ type: 'token', content: t });
        },
      });
      usage = {
        promptTokens: usage.promptTokens + result.usage.promptTokens,
        completionTokens: usage.completionTokens + result.usage.completionTokens,
        totalTokens: usage.totalTokens + result.usage.totalTokens,
      };
      content = result.content ?? '';
      const assistantMessage: ChatMessage & { toolCalls?: ToolCall[] } = {
        role: 'assistant',
        content,
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
      };
      await this.storage.appendMessage(sessionId, assistantMessage);
      if (result.toolCalls.length === 0) break;

      for (const call of result.toolCalls) {
        const tool = this.tools.get(call.name);
        let toolResult: unknown;
        let denied = false;
        if (!tool) {
          toolResult = { error: `unknown tool "${call.name}"` };
        } else if (tool.mutating && !this.allowMutatingTools) {
          const approved = this.approveToolCall
            ? await this.approveToolCall({ call, sessionId, botId: bot.id })
            : false;
          if (!approved) {
            denied = true;
            toolResult = { error: `mutating tool "${call.name}" denied: no approval (SDK governance gate)` };
          }
        }
        if (tool && !denied && toolResult === undefined) {
          await emit({ type: 'tool_call', call, approvalRequired: false });
          try {
            toolResult = await tool.handler(call.args, { sessionId, botId: bot.id });
          } catch (err) {
            toolResult = { error: err instanceof Error ? err.message : String(err) };
          }
          executedCalls.push(call);
        }
        if (denied) await emit({ type: 'tool_call', call, approvalRequired: true });
        await emit({ type: 'tool_result', call, result: toolResult, ...(denied ? { denied: true } : {}) });
        await this.storage.appendMessage(sessionId, {
          role: 'tool',
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult ?? null),
          toolCallId: call.id,
          toolName: call.name,
        });
      }
      if (iteration === this.maxIterations - 1) content = content || '';
    }

    await emit({ type: 'done', usage });
    return { sessionId, content, usage, toolCalls: executedCalls };
  }

  async close(): Promise<void> {
    await this.storage.close?.();
  }
}

/** Create an embeddable SDK agent (see {@link SdkAgent}). */
export function createSdkAgent(config: SdkAgentConfig): SdkAgent {
  return new SdkAgent(config);
}
