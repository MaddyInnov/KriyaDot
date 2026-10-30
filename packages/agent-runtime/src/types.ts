// SPDX-License-Identifier: Apache-2.0

import type { ApprovalMode } from './approval-modes.js';
export type { ApprovalMode };
import type { ProvenanceNote } from './provenance.js';
export type { ProvenanceNote };
import type { ComputerProvider, ComputerSurface } from './tools/computer-surfaces.js';
export type { ComputerProvider, ComputerSurface };
import type { WidgetAnswer, WidgetHost, WidgetPayload } from './widgets.js';
export type { WidgetAnswer, WidgetHost, WidgetPayload };
import type { CredentialProposer } from './credential-proposals.js';
export type { CredentialProposer };
import type { ExecutionPolicyConfig } from './execution-policy.js';
export type { ExecutionPolicyConfig };

/**
 * A native media attachment on a user message (Octomind parity #38):
 * the raw bytes ride the message so vision-capable provider drivers can
 * serialize them as native content parts (OpenAI `image_url`/`video_url`,
 * Anthropic base64 image blocks) instead of the model only ever seeing
 * OCR text or a "preview not available" note. Drivers whose wire format
 * has no part for a media kind degrade to the text content alone.
 * Persisted verbatim by the session store (media_items column).
 */
export interface MessageMedia {
  kind: 'image' | 'video';
  /** MIME type, e.g. 'image/png', 'video/mp4'. */
  mediaType: string;
  /** Base64-encoded bytes (no data-URI prefix). */
  dataBase64: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** Native media attachments (#38). Only meaningful on user messages. */
  media?: MessageMedia[];
  /**
   * Provider-native output items (Octomind parity #34): the raw output
   * items a provider driver produced for this message — e.g. OpenAI
   * Responses reasoning items, Anthropic thinking blocks, or tool-use
   * blocks in the provider's own shape — preserved verbatim so a resumed
   * session can replay them to the provider instead of reconstructing
   * (and losing) them from the flattened text content.
   *
   * Driver contract: a driver that receives native items from its
   * provider attaches them, unmodified, to the assistant message it
   * returns (the runtime persists them via SessionStore). On resume the
   * driver reads `nativeItems` back off the stored assistant messages
   * (SessionStore returns them verbatim) and replays them to the
   * provider in place of / alongside the text content, in stored order.
   * Items are opaque to everything except the originating driver:
   * never summarize, transform, or cross providers with them.
   */
  nativeItems?: unknown[];
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
  /**
   * Prompt-cache buckets (closure #137): tokens read from / written to
   * the provider's prompt cache, when the driver reports them
   * (Anthropic cache_read/cache_creation, OpenAI cached_tokens). Absent
   * means the provider reported none. usage.ts's CacheAwareTokenUsage is
   * the same shape; costOfUsage prices these buckets when present.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
   * Live step line (W8a): the turn's current step, mirrored from the
   * runtime's TurnStateRegistry on every change. Backward compatible —
   * older clients ignore unknown event types. `stepIndex`/`stepTotal`
   * are present when known (provider iteration / max iterations).
   */
  | {
      type: 'step';
      botId: string;
      sessionId: string;
      step: string;
      stepIndex?: number;
      stepTotal?: number;
      startedAt: number;
      elapsedMs: number;
    }
  /**
   * Streaming TTS (W8h): one synthesized sentence of the assistant's
   * reply, emitted in sentence order while the turn is still running
   * when voice reply is enabled. Audio rides as base64 (SSE is text).
   */
  | {
      type: 'audio_chunk';
      seq: number;
      text: string;
      mimeType: string;
      audioBase64: string;
    }
  /**
   * AI failover (W1): the primary provider hit a hard usage limit and the
   * turn switched to the backup provider/model. Emitted at most ONCE per
   * turn; the turn then continues on the backup. Also mirrored as a
   * `notice` with kind 'failover' for clients that only render notices,
   * and audited as `turn.failover` (visible in Activity).
   */
  | {
      type: 'failover';
      fromProvider: string;
      fromModel: string;
      toProvider: string;
      toModel: string;
      reason: string;
      message: string;
    }
  /**
   * Near-limit warning (W1): observed usage for a provider crossed the
   * warning threshold (rate-limit headers or spend figures). `usedPercent`
   * is only ever set from real observed data — providers that expose no
   * usage data never produce this event.
   */
  | {
      type: 'usage_warning';
      providerId: string;
      providerName: string;
      usedPercent: number;
      source: 'rate-limit' | 'spend-cap' | 'error';
      message: string;
    }
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
      /** Epoch ms expiry, or null for a never-expire card (W12). */
      expiresAt: number | null;
      /** W12: true when the card never expires (render "No expiry"). */
      neverExpire?: boolean;
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
   * Commit attribution line for git_commit (Octomind parity small
   * item): copied from the bot's `commitAttribution` config by the
   * runtime each turn. Absent → commits carry no attribution.
   */
  commitAttribution?: string;
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
   * Guardrails-as-code (Octomind parity): tools already executed in
   * this session (oldest first), maintained by the runtime as RICH
   * entries ({ name, argDigest, argSummary } — see history-entry.ts) so
   * argument-qualified `requiresHistory` conditions can match; legacy
   * name-only strings remain acceptable. The governance adapter
   * forwards it so policy rules with a `requiresHistory` condition can
   * match ("allow X only after Y ran"). Absent → history conditions
   * never match (fail-closed for conditional allows, and conditional
   * denies simply don't fire).
   */
  sessionToolHistory?: (string | import('./history-entry.js').SessionToolHistoryEntry)[];
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
  /**
   * Guardrails-as-code (Octomind parity): argument matching. The rule only
   * matches when the named argument's value (stringified when not a
   * string) matches `pattern` (RegExp, case-sensitive — argument values
   * are data, not names). Absent → the rule matches on the tool name alone
   * (previous behavior).
   */
  argPattern?: { arg: string; pattern: string };
  /**
   * Guardrails-as-code (Octomind parity): session-history condition. The
   * rule only matches when at least `minCount` (default 1) earlier tool
   * calls in THIS session match `toolPattern` — e.g. "allow git_push only
   * after verify_changes ran". Absent → no history condition.
   */
  requiresHistory?: { toolPattern: string; minCount?: number };
}

/**
 * Per-bot governance policy. When present, its rules are PREPENDED to the
 * global policy before evaluation (first match wins), so bot rules can
 * tighten OR loosen the global floor for that bot only. Absent → the global
 * policy applies unchanged.
 */
export interface BotPolicy {
  rules: BotPolicyRule[];
  /**
   * Opt-in policy snapshot mode (#70): when true, the session's
   * effective policy is captured immutably at its first tool call and
   * used for the whole session (mid-session policy edits apply from
   * the next session). Default/absent = live evaluation (KriyaDot's
   * deliberate default — see governance policy-snapshot.ts).
   */
  policySnapshot?: boolean;
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
  /** Nucleus sampling cutoff (0-1). */
  topP?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /**
   * Vision fallback model (§2.12 #128): when a chat turn carries an image
   * attachment and the bot's primary model is not vision-capable, the turn
   * routes to this model instead (same provider unless written as
   * "provider/model"). Unset → no auto-upgrade; the image is described by
   * metadata/OCR only.
   */
  visionModel?: string;
  /**
   * DeepSeek thinking selection (ENGINES pack): 'chat' pins the fast chat
   * model, 'reasoner' pins the reasoning model. Only honored by the
   * DeepSeek drivers (API preset + `dsh` ACP harness); other providers
   * ignore it. The explicit bot model still wins when it already names a
   * DeepSeek model — see providers/deepseek.ts.
   */
  deepseekMode?: 'chat' | 'reasoner';
  /**
   * Local-model reply timeout in ms (ENGINES pack): how long the local
   * drivers (ollama / llamacpp / lmstudio) wait for a reply before the
   * request aborts. Local inference can be slow to first token, so this
   * is separate from the cloud per-call timeout. Honored by the local
   * drivers when the chat call carries no explicit timeoutMs.
   */
  replyTimeoutMs?: number;
}

/**
 * Structured output enforcement (Octomind parity): ask the provider to
 * constrain the model's final response. `json_schema` carries a full JSON
 * Schema the response must conform to; `json_object` only guarantees
 * syntactically valid JSON. Drivers with native support (OpenAI-compatible
 * `response_format`) send it on the wire; other drivers get a schema
 * instruction plus a runtime-side JSON validity check with one corrective
 * retry.
 */
export type StructuredOutputSpec =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      /** Schema name (required by some providers; defaults to 'response'). */
      name?: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };

/**
 * End-of-turn validator (Octomind parity): a declared check that runs
 * automatically when a turn is about to finish. A failure injects the
 * validator's output as the next instruction instead of ending the turn
 * (bounded retries). `command` validators run an argv array (no shell) in
 * the bot's workspace; `builtin: 'verify-changes'` runs the project's own
 * checks via the verify tool machinery.
 */
export interface TurnValidatorSpec {
  name: string;
  command?: string[];
  builtin?: 'verify-changes';
  /**
   * Semantic criterion (closure #28): when set (and no command/builtin),
   * the validator is judged through the calibrated evaluate seam
   * (runEvaluateValidator) instead of a shell command.
   */
  criterion?: string;
  /** Per-validator timeout; default 120s. */
  timeoutMs?: number;
}

/**
 * One stage of an in-turn layer pipeline (Octomind parity). Stages run
 * around the main turn loop with their own prompt and (optionally) model:
 * `prepare` stages transform/augment the user message before the loop;
 * `review` stages see the draft final answer and may return a revised
 * answer (their full output replaces the draft when non-empty).
 */
export interface LayerStageSpec {
  name: string;
  /**
   * Stage kind (#41 depth): 'prepare' shapes the request before the
   * main loop; 'execute' runs in the prepare phase with tool intent;
   * 'review' may revise the draft answer; 'verify' runs in the review
   * phase as a checker. (Originally only prepare/review existed.)
   */
  kind: 'prepare' | 'review' | 'execute' | 'verify';
  /** Stage system prompt (its job description). */
  prompt: string;
  /** Purpose profile or explicit model for this stage; default: turn model. */
  model?: string;
  providerId?: string;
  /** What the stage receives: the user message, the draft answer, or both. */
  inputMode?: 'user' | 'draft' | 'user+draft';
  /** How the stage output is applied: note (system note), replace (draft), append. Default by kind. */
  outputMode?: 'note' | 'replace' | 'append';
  /** Persona/role label prepended to the stage prompt by the runtime. */
  role?: string;
  /** Purpose profile name whose model resolves this stage when `model` is unset. */
  profile?: string;
}

/**
 * Per-bot voice-call settings (Codync parity: realtime voice calls).
 * Provider ids: 'mock' (offline, zero-cost default), 'groq', 'openai'
 * (both key-gated BYOK), plus the OMB-parity TTS breadth providers
 * 'elevenlabs', 'fish', 'chatterbox', 'system' (all key/local-gated;
 * bot-voice.ts stores them through the @mvp/voice provider registry).
 * Unset → mock. Note: live voice CALLS still accept only mock/groq/
 * openai (voice-call.ts VOICE_CALL_PROVIDERS); the extra ids drive
 * spoken replies / TTS rendering.
 */
export interface VoiceSettings {
  /** STT provider for voice calls. */
  sttProvider?: 'mock' | 'groq' | 'openai';
  /** TTS provider for voice calls. */
  ttsProvider?: 'mock' | 'groq' | 'openai' | 'elevenlabs' | 'fish' | 'chatterbox' | 'system';
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
  /**
   * Multiplayer layer (W7): the person who owns this bot (PeopleStore id,
   * see people.ts). The bot's approvals, questions and run results are
   * addressed to the owner. Absent → the default user ("You",
   * DEFAULT_PERSON_ID) — single-user installs behave exactly as before.
   */
  ownerId?: string;
  /**
   * AI failover (W1): backup provider/model used automatically when the
   * primary provider fails with a hard usage-limit / quota error mid-turn.
   * Unset → the runtime falls back to the next eligible provider from
   * routing (catalog order, free-only guard respected).
   */
  backupProvider?: string;
  backupModel?: string;
  /** Per-model inference options (reasoning effort, fast mode, etc.). */
  modelOptions?: ModelOptions;
  /**
   * Prompt-cache warming (#137): on cache-capable providers (Anthropic),
   * a background CacheWarmer keeps this bot's system-prompt cache warm so
   * turns start with cache-read pricing. `true` = default 5-minute
   * interval; `{ intervalMs }` = custom (>= 60s). Absent/false = off.
   * The host (apps/api) instantiates warmers from this field at startup.
   */
  cacheWarm?: boolean | { intervalMs?: number };
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
  acp?: { command?: string; args?: string[]; engine?: string };
  /**
   * Claude account profile (ENGINES pack, multiple Claude accounts): the
   * id of a named profile from the engine-accounts store. The profile
   * points at its own credential dir (CLAUDE_CONFIG_DIR-style isolation),
   * so two bots can run on two different Claude logins. Absent → the
   * machine's default Claude login. Paths/labels only — never secrets.
   */
  accountProfile?: string;
  /**
   * Per-engine homes (ENGINES pack): when true, engine processes spawned
   * for this bot SHARE the user's real home directory instead of the
   * isolated <dataDir>/engine-homes/<botId>/<engineId> home. Default
   * false (isolated) for ACP/CLI engine spawns that go through the
   * engine-home env shaping (providers/engine-homes.ts).
   */
  sharedEngineHome?: boolean;
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
   * Chief host restriction (item 15): when true, this (chief) bot's own
   * turns have ONLY scheduling/delegation tools — no fs/browser/MCP.
   * Enforced via conversation-mode tool filtering in the runtime.
   */
  chiefHostRestricted?: boolean;
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
  /**
   * Configured computer provider: 'auto'|'mock'|'playwright'|'desktop'|'docker'.
   * Resolution order: this per-bot config → env opt-ins → auto (mock).
   * Reported (with its source) by the computer view/API. Absent → 'auto'.
   */
  computerProvider?: ComputerProvider;
  /**
   * Supervisor verify-gate (Octomind parity): when true, a turn that used
   * mutating tools may not end on an unverified completion claim — a
   * separate cheap-model supervisor checks the final claim against the
   * runtime evidence collected this turn (tool results) and can reject it,
   * sending the bot back to work (bounded rejections per turn). Default
   * false; the host may also enable it globally via env.
   */
  supervisorVerifyGate?: boolean;
  /**
   * Autonomous execution-loop policy (closure ADD-4, execution-policy.ts):
   * attempt → verify → retry-differently → escalate, with a material-change
   * rule for retries, a per-step attempt bound, and an attempt ledger.
   * Default ON for Universal Chat and Chief-of-Staff-led turns, OFF
   * elsewhere; `enabled: false` is an explicit opt-out, `enabled: true`
   * opts any bot in, and the numeric/verify fields tune the policy.
   */
  executionPolicy?: ExecutionPolicyConfig;
  /**
   * End-of-turn validators (Octomind parity): declared checks run
   * automatically before a turn may finish; failures are injected as the
   * next instruction (bounded retries). Skill-declared validators are
   * added on top of these.
   */
  validators?: TurnValidatorSpec[];
  /**
   * In-turn layers (Octomind parity): optional stage pipeline around the
   * main turn loop — `prepare` stages shape the request, `review` stages
   * may revise the draft answer. Each stage has its own prompt and model.
   * Absent → single-stage turns (previous behavior).
   */
  layers?: LayerStageSpec[];
  /**
   * Project instruction files (Octomind parity): when not false, the
   * runtime loads AGENTS.md-style files from the bot's workspace into the
   * system prompt each turn. Default true (only active when the host
   * supplies a workspace resolver).
   */
  projectInstructions?: boolean;
  /**
   * Semantic discovery (Octomind parity): when true, skills whose intent
   * embedding decisively matches the user's message are auto-activated
   * for the turn (deterministic policy with abstain-on-tie). Default
   * false — skills otherwise activate via read_skill as before.
   */
  autoActivateSkills?: boolean;
  /**
   * Memory scope (closure #74): learned-memory atoms are stamped with
   * this project id / role set at distillation time, and recall filters
   * to atoms in scope (project + role-filtered retrieval). Unset → the
   * bot's memory is unscoped (every atom visible), as before.
   */
  memoryScope?: { projectId?: string; roles?: string[] };
  /**
   * Hindsight (Octomind parity): when true, a cheap-model retrospective
   * runs after tool-using turns and stores one lesson atom in memory.
   * Default false.
   */
  hindsight?: boolean;
  /**
   * Recite (Octomind parity): in plan mode, after the human approves the
   * plan the bot must first recite the resolved checklist back (verified
   * against the approved plan) before executing. Default false.
   */
  recitePlan?: boolean;
  /**
   * Commit attribution (Octomind parity): appended to git commit messages
   * this bot creates (e.g. "Co-authored-by: KriyaDot Bot <bot@kriyadot>").
   * Absent → no attribution line.
   */
  commitAttribution?: string;
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
      /** Sampling temperature (0-2), when the driver supports it. */
      temperature?: number;
      /** Nucleus sampling cutoff (0-1), when the driver supports it. */
      topP?: number;
      /** Max output tokens, when the driver supports it. */
      maxTokens?: number;
      /** Per-call request timeout in ms (purpose-profile knob). */
      timeoutMs?: number;
      /**
       * Local-model reply timeout in ms (ENGINES pack): fallback timeout
       * used by the local drivers (ollama / llamacpp / lmstudio) when
       * `timeoutMs` is absent. Threaded from bot modelOptions by the host.
       */
      replyTimeoutMs?: number;
      /**
       * DeepSeek thinking selection (ENGINES pack): threaded from bot
       * modelOptions; only the DeepSeek drivers honor it.
       */
      deepseekMode?: 'chat' | 'reasoner';
      /** Per-call retry budget override (purpose-profile knob). */
      maxRetries?: number;
      /**
       * Structured output enforcement (Octomind parity): constrain the
       * response to JSON / a JSON Schema. Drivers without native support
       * ignore this on the wire; the runtime still validates the result.
       */
      responseFormat?: StructuredOutputSpec;
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
  ): Promise<{
    content: string;
    toolCalls: ToolCall[];
    usage: TokenUsage;
    /**
     * Provider-native output items (#34): the driver's raw output items
     * for this reply, preserved verbatim. The runtime copies them onto
     * the persisted assistant message so a resumed session replays them
     * to the originating provider instead of the flattened text.
     */
    nativeItems?: unknown[];
  }>;
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
 * SessionStore persists this in a dedicated column. Provider-native output
 * items (#34) ride on ChatMessage.nativeItems itself and are likewise
 * persisted by SessionStore in a dedicated column.
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
  const out: TokenUsage = {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  // Cache buckets (#137) survive aggregation when either side has them.
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    out.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  }
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
    out.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  }
  return out;
}
