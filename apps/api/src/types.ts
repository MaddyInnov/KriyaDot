// SPDX-License-Identifier: Apache-2.0
// Shared DTO / wire types for the API layer. Package-owned domain types
// (BotConfig, StreamEvent, ApprovalRecord, AuditEntry, WorkflowDefinition,
// WorkflowRun) are imported from the workspace packages; these are the
// HTTP-facing shapes built on top of them.

import type { ApprovalRecord, AuditEntry } from '@mvp/governance';
import type { ModelInfo, RateLimitSnapshot, StreamEvent, StructuredOutputSpec } from '@mvp/agent-runtime';
import type { WorkflowDefinition, WorkflowRun } from '@mvp/workflows';

export interface ChatRequestBody {
  botId: string;
  message: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  /** Reasoning effort for models that support it (low/medium/high). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Structured output for the final answer (Octomind parity). */
  responseFormat?: StructuredOutputSpec;
  /** Attached file IDs (from /api/files/upload). Content is injected into the turn. */
  fileIds?: string[];
  /** Task type for Phase 3 smart model routing (only used when no model is pinned). */
  taskType?: 'code' | 'chat' | 'reasoning' | 'simple-qa';
  /** Session auto-approve: skip approval cards for this turn (audited). */
  autoApprove?: boolean;
  /** CA-21: `kriyadot run --bare` — skip all auto-discovery for this turn. */
  bare?: boolean;
  /** Plan mode: read-only exploration, mutating tools denied. */
  planMode?: boolean;
  /** Max USD spend for this turn; stops fail-closed when exceeded. */
  maxBudgetUsd?: number;
  /**
   * Per-turn sandbox mode override (Codex-style orthogonal dial).
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Steering mode for when a turn is already in-flight on this session:
   * - 'interrupt' (default): abort the in-flight turn, start this one now.
   * - 'queue': append to the session queue; runs automatically when the
   *   current turn completes (queue-at-boundary, Claude Code style).
   */
  queueMode?: 'interrupt' | 'queue';
  /**
   * Streaming TTS (W8h): when true, the assistant's reply is synthesized
   * sentence-by-sentence while it streams and `audio_chunk` events are
   * emitted on this stream in sentence order.
   */
  voiceReply?: boolean;
  /**
   * Space to run in (Spaces feature). Alternative to the `X-KriyaDot-Space`
   * request header. The space's model/workspace overrides apply to the
   * run; paused spaces reject the request with 423.
   */
  spaceId?: string;
}

export interface DecideApprovalBody {
  decision: 'approved' | 'denied';
  note?: string;
}

export interface ProviderKeyBody {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface ProviderInfo {
  id: string;
  name: string;
  api: string;
  configured: boolean;
  models: ModelInfo[];
  /** Latest rate-limit/quota snapshot captured from response headers (null when unknown). */
  rateLimit: RateLimitSnapshot | null;
  /**
   * Near-limit warning (W1): set only when observed usage data (rate-limit
   * headers) crosses the warning threshold — e.g. "Anthropic: 92% used".
   * Null when usage is below threshold or the provider exposes no usage
   * data (never fabricated).
   */
  usageWarning?: { usedPercent: number; message: string; source: 'rate-limit' } | null;
  /**
   * Subscription/CLI bridge (MausBot parity): 'claude' | 'codex' | 'opencode'. Set only on
   * bridge presets (claude-subscription / codex-subscription / opencode-subscription).
   */
  bridge?: 'claude' | 'codex' | 'opencode';
  /** Bridge only: a matching CLI or credential file was detected on this machine. */
  detected?: boolean;
  /** Bridge only: the user granted Connect consent (token readable in memory). */
  connected?: boolean;
  /**
   * Local provider (Ollama): runs on the user's own machine, no API key
   * ever required. The UI shows a "Local" badge instead of a key field.
   */
  local?: boolean;
  /**
   * Keyless lane (catalog `keyless: true` — OVHcloud anonymous, LLM7
   * anonymous, AI Horde): works with no API key at all. The UI labels
   * these honestly as shared/best-effort lanes using `limitsNote`.
   */
  keyless?: boolean;
  /** Keyless but best-effort: limits undocumented/unverified (LLM7). */
  bestEffort?: boolean;
  /** Human-honest limits copy for keyless / BYOK lanes, shown in the UI. */
  limitsNote?: string;
}

export interface RunWorkflowBody {
  input?: unknown;
  idempotencyKey?: string;
}

export interface DryRunBody {
  botId: string;
  message: string;
}

/** Body for POST /policy/simulate. */
export interface PolicySimulateBody {
  /** Optional: simulate against this bot's merged policy (bot rules + global). */
  botId?: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface ApiError {
  error: string;
  detail?: string;
}

// Re-exports so route handlers have a single import surface.
export type { ApprovalRecord, AuditEntry, ModelInfo, RateLimitSnapshot, StreamEvent, WorkflowDefinition, WorkflowRun };
