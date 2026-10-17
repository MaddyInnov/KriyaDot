// SPDX-License-Identifier: Apache-2.0

import type { ApprovalMode } from './approval-modes.js';
export type { ApprovalMode };
import type { ProvenanceNote } from './provenance.js';
export type { ProvenanceNote };
import type { ComputerSurface } from './tools/computer-surfaces.js';
export type { ComputerSurface };
import type { WidgetAnswer, WidgetHost, WidgetPayload } from './widgets.js';
export type { WidgetAnswer, WidgetHost, WidgetPayload };
import type { CredentialProposer } from './credential-proposals.js';
export type { CredentialProposer };

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
  /**
   * Spend cap reached (OpenMausBot parity P1 #21). Emitted instead of
   * 'error' when the spend-cap gate (or the per-turn budget) blocks a
   * provider call BEFORE it runs. The host push-notifies the user on
   * this event; clients render it as an error-style message.
   */
  | {
      type: 'spend_cap_reached';
      message: string;
      /** Which cap tripped: 'spend-cap' (global/per-bot) or 'turn-budget'. */
      capKind: 'spend-cap' | 'turn-budget';
    }
  | { type: 'approval_required'; approvalId: string; call: ToolCall }
  /**
   * Peer-approval card raised for a bot→bot call (ask_bot / message_bot /
   * delegate-to-another-bot). Emitted when the card is raised (the sender
   * bot is now "waiting on user") and again when it is decided.
   */
  | {
      type: 'peer_approval_required';
      cardId: string;
      senderBotId: string;
      senderBotName: string;
      targetBotId: string;
      targetBotName: string;
      actionType: 'ask' | 'message' | 'delegate';
      preview: string;
      /** Origin chain of the sender's turn (P1 #13) — shown on the card. */
      provenance?: ProvenanceNote;
    }
  | { type: 'peer_approval_decided'; cardId: string; decision: 'allowed' | 'denied' | 'expired' }
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
    }
  /**
   * Interactive widget raised for this turn (OpenMausBot parity P1 #15).
   * Emitted when a widget is raised: interactive widgets (from
   * `ask_user_question`) pause the turn until answered; display widgets
   * (from a tool result's `widget` attachment) render inline.
   */
  | {
      type: 'widget';
      widgetId: string;
      sessionId: string;
      /** Validated widget payload (same shapes the web client renders). */
      widget: WidgetPayload;
      expiresAt: number;
      /** True when the turn pauses for a human answer. */
      interactive: boolean;
    }
  /**
   * Emitted when an interactive widget is answered, expires, or the wait
   * is aborted. `answered:false` + `expired:true` means the TTL ran out.
   */
  | {
      type: 'widget_answered';
      widgetId: string;
      answer: { answered: boolean; value?: unknown; expired?: boolean; answeredAt: number };
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
  /**
   * Provenance of the turn's triggering message (OpenMausBot parity P1
   * #13). Set by the runtime from RunTurnOptions.provenance. Lets tools —
   * e.g. the peer-approval gate — see the origin chain of the content that
   * started this turn.
   */
  provenance?: ProvenanceNote;
  /**
   * Conversation (session) this turn belongs to (OpenMausBot parity P1
   * #14). Lets tools resolve per-conversation overrides — e.g. a pinned
   * computer surface for this chat. Set by the runtime from
   * RunTurnOptions.conversationId.
   */
  conversationId?: string;
  /**
   * Interactive widgets (OpenMausBot parity P1 #15). Set by the runtime
   * when the host passed a WidgetCoordinator: tools can raise widgets
   * (ask_user_question pauses the turn for a human answer) and await
   * answers through this per-turn host. Undefined → no interactive UI is
   * attached; tools must fall back to their best judgment.
   */
  widget?: WidgetHost;
  /**
   * AbortSignal for this turn (same signal the runtime passes as
   * RunTurnOptions.signal). Tools that block on the human (e.g.
   * ask_user_question's awaitAnswer) reject when it aborts.
   */
  signal?: AbortSignal;
  /**
   * Credential/profile proposal host (OpenMausBot parity: profile/
   * credential proposal cards). When set, the `request_credential` tool
   * raises a proposal card and awaits the user's supplied value; unset →
   * the tool falls back to directing the user to Settings → Vault.
   * Set by the runtime from its credential proposer (host-wired).
   */
  credentialProposer?: CredentialProposer;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  /**
   * True when the tool writes files, executes shell/commands, commits or
   * pushes, sends messages externally, spawns subagents/delegates, or
   * otherwise changes state outside the process. Authoritative for the
   * plan-mode gate and the sandbox read-only enforcement in runtime.ts.
   * Read-only tools (read_file, glob, web_search, ...) leave this unset.
   */
  mutating?: boolean;
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

/**
 * Per-model inference options (Codync parity: model options in bot editor).
 * Not all options apply to all models — the UI only shows supported ones
 * (see AgentModel.supports* flags from agent-models.ts).
 */
export interface ModelOptions {
  /** Reasoning effort for models that support it (OpenAI reasoning_effort). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Prefer the fastest/lowest-latency variant. */
  fastMode?: boolean;
  /** Sampling temperature (0-2). */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
}

/**
 * Per-bot voice-call settings (Codync parity: realtime voice calls).
 * Provider ids: 'mock' (offline, zero-cost default), 'groq', 'openai'
 * (both key-gated BYOK). Unset → mock.
 */
export interface VoiceSettings {
  /** STT provider for voice calls. */
  sttProvider?: 'mock' | 'groq' | 'openai';
  /** TTS provider for voice calls. */
  ttsProvider?: 'mock' | 'groq' | 'openai';
  /** Provider-specific TTS voice id (e.g. 'alloy', 'Fritz-PlayAI'). */
  ttsVoice?: string;
  /** Client-side auto VAD instead of push-to-talk. */
  autoVad?: boolean;
  /** VAD sensitivity 1–10 (higher = more sensitive). */
  vadSensitivity?: number;
}

export interface BotConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider: string;
  model: string;
  /** Per-model inference options (reasoning effort, fast mode, etc.). */
  modelOptions?: ModelOptions;
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
  /**
   * Durable memory keeper (Engram parity): when true (default), the keeper
   * automatically extracts durable facts from completed turns into the
   * bot's TieredMemoryStore. Set false to disable automatic extraction
   * for this bot (manual memory_store tool still works).
   */
  memoryKeeper?: boolean;
  /**
   * Memory fabric (Atomic parity): when true, a background reflection pass
   * runs every 50 turns for this bot — reviewing its memories, proposing
   * new lessons/procedures, and flagging contradictions. Opt-in; default
   * false. The pass is low-priority and never blocks chat.
   */
  memoryReflection?: boolean;
  /**
   * Memory fabric: when true, the keeper distills turns with the bot's own
   * model (costs tokens) instead of the zero-cost heuristic, and also
   * extracts lessons and procedures. Default false.
   */
  memoryLiveDistill?: boolean;
  /**
   * Push notification preference (Codync parity):
   * - 'all' (default): "done" + "failed" + "needs you" pushes.
   * - 'approvals': only "needs you" (approval requested) pushes.
   * - 'none': no pushes for this bot.
   */
  notifications?: 'all' | 'approvals' | 'none';
  /** Per-bot voice-call settings (STT/TTS providers, TTS voice, VAD). */
  voice?: VoiceSettings;
  /**
   * Approval mode (Atomic parity):
   * - 'plan' (default 'auto'): the agent presents a step-by-step plan and
   *   waits for human approval before acting.
   * - 'auto': low-risk actions proceed under policy; risky ones raise
   *   approval cards.
   * - 'bypass': DANGEROUS — all approvals auto-granted. Explicit per-bot
   *   opt-in only; the catastrophic-command denylist still applies.
   */
  approvalMode?: ApprovalMode;
  /**
   * Chief of Staff (chief-of-staff.ts): when true, the bot gets the chief
   * section (roster + delegation doctrine + incidents/escalations +
   * team-setup rules) injected into its system prompt on every turn, and
   * may use the chief-only tools (coordinate_bots, propose_team_setup,
   * create_bot, propose_bot_deletion, raise_escalation, retry_thread).
   * The host enforces at most one chief per team.
   */
  chiefOfStaff?: boolean;
  /**
   * Sections the chief is the primary contact for (e.g. ['support']).
   * Rendered in the chief prompt header; empty/absent = 'general'.
   */
  managedSections?: string[];
  /**
   * "Works on" computer surface (OpenMausBot parity P1 #14): which computer
   * the bot's computer_* tools drive. 'auto' (default) picks the best
   * available backend (docker → playwright → local); 'local' = the machine
   * KriyaDot runs on; 'docker' = isolated container sandbox; 'browser' =
   * Playwright browser surface; 'off' disables computer tools for this bot.
   * A per-conversation pin can override this for one chat.
   */
  computerSurface?: ComputerSurface;
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
      /**
       * Native CLI drivers (OpenMausBot parity): stable key for CLI session
       * resume (the runtime passes its sessionId). Absent = one-shot turn.
       */
      sessionKey?: string;
      /**
       * Native CLI drivers: KriyaDot approval mode, mapped onto the CLI's
       * own permission flags before spawn. Defaults to 'auto'.
       */
      approvalMode?: ApprovalMode;
      /**
       * Native CLI drivers: tool executions the CLI performed itself,
       * surfaced as stream events (observation only — the runtime must NOT
       * re-execute them). Absent = events are dropped.
       */
      onCliToolEvent?: (e: CliToolStreamEvent) => void;
    },
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }>;
  listModels(): Promise<ModelInfo[]>;
}

/**
 * Tool activity observed from a native CLI driver (OpenMausBot parity).
 * These describe tools the CLI executed ITSELF inside its own process —
 * they are already done (or blocked by the kill-switch) and must never be
 * re-executed by the runtime. `tool_denied` is emitted when the
 * catastrophic-command kill-switch fires.
 */
export type CliToolStreamEvent =
  | { kind: 'tool_call'; call: ToolCall; cliId: string }
  | { kind: 'tool_result'; call: ToolCall; cliId: string; result: unknown; denied?: boolean }
  | { kind: 'tool_denied'; call: ToolCall; cliId: string; denied: true };

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
