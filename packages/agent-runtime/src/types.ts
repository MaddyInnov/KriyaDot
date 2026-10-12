// SPDX-License-Identifier: Apache-2.0

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; call: ToolCall; approvalRequired: boolean; approvalId?: string }
  | { type: 'tool_result'; call: ToolCall; result: unknown; denied?: boolean }
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; message: string }
  | { type: 'interrupted'; reason: string }
  | { type: 'approval_required'; approvalId: string; call: ToolCall }
  | { type: 'queued_turn_start'; queueId: string; message: string }
  | { type: 'notice'; kind: string; message: string }
  /**
   * Live code-writing event for the code session view. Emitted AFTER a
   * write_file tool executes successfully (approval gates already passed).
   * The UI animates `after` streaming in as a diff against `before`.
   */
  | {
      type: 'code_write';
      call: ToolCall;
      /** Workspace-relative path. */
      file: string;
      /** Content before the write, or null for a new file. */
      before: string | null;
      /** Full new content (server-truncated to 256KB). */
      after: string;
      /** Always true today (single-shot per write); reserved for chunked streaming. */
      done: boolean;
      botId: string;
      botName: string;
    };

export interface ToolContext {
  sessionId: string;
  botId: string;
  /**
   * Persistent E2B sandbox ID for this turn (Dot environments). When set,
   * `run_command` executes inside the persistent sandbox instead of a fresh
   * ephemeral one. Undefined → normal ephemeral sandbox behavior.
   */
  persistentSandboxId?: string;
  /**
   * Per-turn workspace override (Spaces feature). When set, tool calls in
   * this turn resolve their workspace from this value (same semantics as a
   * per-bot workspace) instead of the bot's configured workspace.
   * Set by the runtime from RunTurnOptions.workspaceOverride.
   */
  spaceWorkspaceOverride?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * One per-bot governance rule. Same first-match-wins semantics as the
 * governance package's PolicyRule: `toolPattern` is compiled as a
 * case-insensitive RegExp and matched against the tool name.
 */
export interface BotPolicyRule {
  id: string;
  toolPattern: string;
  effect: 'allow' | 'deny' | 'require-approval';
  reason?: string;
}

/**
 * Per-bot governance policy. When present, its rules are PREPENDED to the
 * global policy before evaluation (first match wins), so bot rules can
 * tighten OR loosen the global floor for that bot only. Absent → the global
 * policy applies unchanged.
 */
export interface BotPolicy {
  rules: BotPolicyRule[];
}

/**
 * Sandbox mode (Codex-style orthogonal trust dial).
 * - 'read-only': agent can only read files and search; no writes, no execution.
 * - 'workspace-write': agent can write files in the workspace and run sandboxed commands (default).
 * - 'danger-full-access': agent can do anything the tools allow (approvals still apply).
 * This is orthogonal to the approval policy (allow/require-approval/deny).
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface BotConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider: string;
  model: string;
  skills: string[];
  tools: string[];
  mcpServers: string[];
  policy?: BotPolicy;
  /** Sandbox mode for this bot (default: 'workspace-write'). */
  sandboxMode?: SandboxMode;
  /** MBTI persona template (e.g. 'INTJ'); null/undefined = no persona. */
  persona?: string | null;
  /**
   * Per-bot workspace (Octop-style isolation). Optional.
   * - unset/empty → the bot uses the global workspaceDir (backward compatible).
   * - relative (e.g. "coder") → resolved against <dataDir>/workspaces.
   * - absolute → must be inside the server data directory.
   */
  workspace?: string;
  /**
   * ACP (Agent Client Protocol) delegation target (Octop parity). When set,
   * `delegate` with `via: 'acp'` spawns this command and speaks ACP over
   * stdio instead of using the built-in subagent. Example:
   * `{ command: 'opencode', args: ['acp'] }`.
   */
  acp?: { command: string; args?: string[] };
  /**
   * Fast message-router keywords (message-router.ts): optional per-bot
   * persona/topic keywords that bias routeMessage() toward this bot.
   * Example: `['billing', 'invoice', 'refund']` for a billing bot.
   */
  routeKeywords?: string[];
}

export interface LLMProvider {
  readonly providerId: string;
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: {
      model: string;
      onToken?: (t: string) => void;
      signal?: AbortSignal;
      /** Fired on each provider-level retry (attempt ≥ 1) of the request. */
      onRetry?: (attempt: number, error: Error) => void;
      /** Reasoning effort for models that support it (OpenAI reasoning_effort). */
      reasoningEffort?: 'low' | 'medium' | 'high';
    },
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }>;
  listModels(): Promise<ModelInfo[]>;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  /** True when the model is free to call (catalog free:true / ':free' / '-free' suffix). */
  free?: boolean;
}

/**
 * Internal extension: the runtime tracks which tool calls an assistant message
 * produced so history can be re-serialized for providers (OpenAI tool_calls,
 * Anthropic tool_use blocks). The public ChatMessage contract is unchanged;
 * SessionStore persists this in a dedicated column.
 */
export type RichMessage = ChatMessage & { toolCalls?: ToolCall[] };

export function getMessageToolCalls(msg: ChatMessage): ToolCall[] | undefined {
  return (msg as RichMessage).toolCalls;
}

export function withToolCalls(msg: ChatMessage, toolCalls: ToolCall[]): RichMessage {
  return { ...msg, toolCalls };
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
