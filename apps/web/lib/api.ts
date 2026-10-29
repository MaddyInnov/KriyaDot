// SPDX-License-Identifier: Apache-2.0
// Typed client for the MVP API. ALL API calls go through getApiBase() so one
// frontend codebase works in three contexts:
//  - Tauri desktop: window.__TAURI__ is present → http://127.0.0.1:4567
//    (the sidecar API; CORS allows any origin in the MVP)
//  - Local dev: NEXT_PUBLIC_API_URL (e.g. http://localhost:4000)
//  - Docker/server: '' → same-origin (the API serves the frontend)

export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __TAURI__?: unknown };
    if (w.__TAURI__) return 'http://127.0.0.1:4567';
  }
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && env.length > 0) return env;
  return '';
}

// ---- Auth (bearer bootstrap) --------------------------------------------------
// Every API call must send `Authorization: Bearer <token>`. The token comes
// from GET /api/auth/bootstrap (no auth header needed; the server only serves
// it to allowlisted/absent Origin) and is stored IN MEMORY ONLY — a
// module-level variable, never localStorage.
//
// All requests funnel through authedFetch() below, which awaits the single
// shared bootstrap promise so concurrent early calls each wait for the token
// exactly once. If bootstrap fails, callers surface the blocking
// "Cannot reach the KriyaDot API" state.

let authToken: string | null = null;
let bootstrapPromise: Promise<string> | null = null;

/** The in-memory bootstrap token (null until bootstrap completes). */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Bootstrap the API token. The first call fires the request; every later or
 * concurrent call awaits the same promise — the token is fetched exactly
 * once. Rejects when the API is unreachable.
 */
export function ensureApiReady(): Promise<string> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      let res: Response;
      try {
        res = await fetch(`${getApiBase()}/api/auth/bootstrap`);
      } catch (err) {
        throw new Error(
          `Cannot reach the KriyaDot API (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (!res.ok) {
        throw new Error(`Cannot reach the KriyaDot API (HTTP ${res.status} ${res.statusText})`);
      }
      const data = (await res.json().catch(() => ({}))) as { token?: unknown };
      if (typeof data.token !== 'string' || data.token.length === 0) {
        throw new Error('Cannot reach the KriyaDot API (bootstrap returned no token)');
      }
      authToken = data.token;
      return authToken;
    })();
  }
  return bootstrapPromise;
}

/** Forget the cached token/promise (retry button on the unreachable-API screen). */
export function resetApiBootstrap(): void {
  bootstrapPromise = null;
  authToken = null;
}

/** Merge `Authorization: Bearer <token>` into init headers (any HeadersInit shape). */
function withAuthHeader(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * Central fetch for every API call in the web app: waits for the bootstrap
 * token, then sends the request with the Authorization header attached.
 * SSE streams also go through here — fetch-based streaming carries headers;
 * EventSource cannot, so EventSource must not be used for API streams.
 */
export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await ensureApiReady();
  return fetch(`${getApiBase()}${path}`, withAuthHeader(init, token));
}

// ---- Shared types (mirror the API wire shapes) ----------------------------

export type BotPolicyEffect = 'allow' | 'deny' | 'require-approval';

export interface BotPolicyRule {
  id: string;
  toolPattern: string;
  effect: BotPolicyEffect;
  reason?: string;
}

export interface BotPolicy {
  rules: BotPolicyRule[];
}

export interface BotConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider: string;
  model: string;
  /** Multiplayer layer (W7): owning person id; unset = the default user. */
  ownerId?: string;
  /** AI failover (W1): backup provider/model for hard usage-limit failures. */
  backupProvider?: string;
  backupModel?: string;
  modelOptions?: ModelOptions;
  skills: string[];
  tools: string[];
  mcpServers: string[];
  policy?: BotPolicy;
  persona?: string | null;
  /** Per-bot workspace (Octop-style isolation); unset = global workspace. */
  workspace?: string;
  /** Bot avatar picture URL (chat polish item 8): /api/bots/:id/avatar when set. */
  avatarUrl?: string;
  /** Per-bot voice-call settings (STT/TTS providers, TTS voice, VAD). */
  voice?: VoiceSettings;
  /** Approval mode (Atomic parity): 'plan' | 'auto' | 'bypass'. Default 'auto'. */
  approvalMode?: 'plan' | 'auto' | 'bypass';
  /** Chief of Staff: prompt injection + chief-only tools enabled. */
  chiefOfStaff?: boolean;
  /** Sections the chief is the primary contact for. */
  managedSections?: string[];
}

export interface VoiceSettings {
  sttProvider?: 'mock' | 'groq' | 'openai';
  ttsProvider?: 'mock' | 'groq' | 'openai';
  ttsVoice?: string;
  autoVad?: boolean;
  vadSensitivity?: number;
}

export interface PersonaInfo {
  type: string;
  name: string;
  traits: string[];
  communicationStyle: string;
}

// ---- Red-team robustness (defensive testing harness; Pro surface) --------

export type RedteamVerdict = 'blocked' | 'succeeded';

export interface RedteamToolCallAttempt {
  name: string;
  args: Record<string, unknown>;
  outcome: 'executed' | 'denied' | 'approval-required';
}

export interface RedteamTranscriptTurn {
  role: 'attacker' | 'bot';
  text: string;
  toolCalls?: RedteamToolCallAttempt[];
}

export interface RedteamAttackResult {
  attackId: string;
  category: string;
  name: string;
  verdict: RedteamVerdict;
  matchedSignals: string[];
  transcript: RedteamTranscriptTurn[];
  durationMs: number;
  hardeningNote: string;
}

export interface RedteamReport {
  reportId: string;
  botId: string;
  botName: string;
  suite: string;
  ts: number;
  score: number;
  total: number;
  blocked: number;
  succeeded: number;
  results: RedteamAttackResult[];
}

export const getRedteamReports = (botId: string): Promise<{ ok: boolean; botId: string; reports: RedteamReport[] }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/redteam/reports`);

export const runRedteamSuite = (botId: string, suite = 'core'): Promise<{ ok: boolean; report: RedteamReport }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/redteam/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suite }),
  });

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

export interface RateLimitSnapshot {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
  resetAt?: string;
}

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; call: ToolCall; approvalRequired: boolean; approvalId?: string }
  | { type: 'tool_result'; call: ToolCall; result: unknown; denied?: boolean }
  | { type: 'done'; usage: TokenUsage | null }
  | { type: 'error'; message: string }
  | { type: 'interrupted'; reason: string }
  | { type: 'approval_required'; approvalId: string; call: ToolCall }
  /**
   * Peer-approval card raised for a bot→bot call (OpenMausBot parity).
   * Emitted when the card is raised (sender is "waiting on user") and when
   * it is decided. Rendered as an inline peer card with Allow / Deny /
   * Always-allow.
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
    }
  | { type: 'peer_approval_decided'; cardId: string; decision: 'allowed' | 'denied' | 'expired' }
  /**
   * Non-fatal informational notice from the server (e.g. "queued behind an
   * in-flight turn"). Rendered inline; never aborts the turn.
   */
  | { type: 'notice'; kind?: string; message: string }
  /** AI failover (W1): primary provider hit a hard limit; turn continues on the backup. Once per turn. */
  | {
      type: 'failover';
      fromProvider: string;
      fromModel: string;
      toProvider: string;
      toModel: string;
      reason: string;
      message: string;
    }
  /** Near-limit warning (W1): observed usage crossed the warning threshold. */
  | {
      type: 'usage_warning';
      providerId: string;
      providerName: string;
      usedPercent: number;
      source: 'rate-limit' | 'spend-cap' | 'error';
      message: string;
    }
  /** A queued message started its turn on this stream (queue-at-boundary). */
  | { type: 'queued_turn_start'; queueId?: string }
  /**
   * Live step line (W8a): the running turn's current step. Rendered as a
   * slim line under the streaming message; also mirrored server-side in
   * the turn-state registry behind GET /api/chat/now.
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
   * Streaming TTS (W8h): one synthesized sentence of the reply, in
   * sentence order, while the turn is still running (voice reply on).
   */
  | { type: 'audio_chunk'; seq: number; text: string; mimeType: string; audioBase64: string }
  /** A `/goal` run was started from this chat (W8f). */
  | { type: 'goal_started'; goal: GroupGoalSummary }
  /**
   * Rich inline card. `widget` is validated client-side against the widget
   * schema (components/widgets) — invalid payloads render as an error block,
   * never raw. Interactive widgets (buttons/select/input/confirm) carry the
   * server stream `widgetId` so answers can be POSTed back; `expiresAt`
   * disables the answer UI once the answer window closes, and `interactive`
   * marks whether the widget is answerable at all.
   */
  | {
      type: 'widget';
      widgetId: string;
      sessionId: string;
      widget: unknown;
      expiresAt: number | null;
      neverExpire?: boolean;
      interactive: boolean;
    }
  /**
   * Answer state for an interactive widget: the server's authoritative
   * resolution (user answered, another client answered, or the widget
   * expired unanswered). Applied to the widget chat block by `widgetId`.
   */
  | {
      type: 'widget_answered';
      widgetId: string;
      answer: { answered: boolean; value?: unknown; expired?: boolean; answeredAt: number };
    }
  /**
   * Live code-writing event for the code session view. Emitted after a
   * write_file tool executes successfully. The UI animates `after`
   * streaming in as a diff against `before`.
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
      done: boolean;
      botId: string;
      botName: string;
    };

export interface ApprovalRecord {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  actor: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
  provenance?: string;
  /** W12: epoch ms expiry, null for never-expire approvals. */
  expiresAt?: number | null;
  /** W12: true when the approval never expires ("No expiry"). */
  neverExpire?: boolean;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  sessionId?: string;
  action: string;
  toolName?: string;
  decision?: string;
  detail?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  /** True when the model is free to call (catalog free:true / :free / -free suffix). */
  free?: boolean;
}

/**
 * Flat model catalog entry from GET /api/models. Prices are PUBLIC
 * LIST-PRICE ESTIMATES, not live billing — see the API's pricing.ts.
 */
export interface ModelPriceInfo {
  providerId: string;
  id: string;
  name: string;
  contextLength?: number;
  free: boolean;
  inputPer1M?: number;
  outputPer1M?: number;
  estimated: boolean;
  /** 'catalog' (shipped presets) or 'models.dev' (refreshed catalog). */
  source?: 'catalog' | 'models.dev';
}

export interface ProviderInfo {
  id: string;
  name: string;
  api: string;
  configured: boolean;
  models: ModelInfo[];
  /** Latest rate-limit/quota snapshot from response headers (null when unknown). */
  rateLimit: RateLimitSnapshot | null;
  /** Near-limit warning (W1): only when observed usage crosses the threshold; null otherwise / no data. */
  usageWarning?: { usedPercent: number; message: string; source: 'rate-limit' } | null;
  /** Subscription/CLI bridge: 'claude' | 'codex'. Set only on bridge presets. */
  bridge?: 'claude' | 'codex';
  /** Bridge only: a matching CLI or credential file was detected on this machine. */
  detected?: boolean;
  /** Bridge only: Connect consent granted (token readable in memory). */
  connected?: boolean;
  /** Local provider (Ollama): on-machine, no API key ever required. */
  local?: boolean;
}

export interface WorkflowNodeDef {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
}

/** Branch label on edges leaving an 'if' node ('true'/'false' outcome). */
export type WorkflowEdgeBranch = 'true' | 'false';

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNodeDef[];
  edges: [string, string, WorkflowEdgeBranch?][];
}

export interface NodeState {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'paused' | 'skipped';
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  approvalId?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: 'running' | 'paused' | 'succeeded' | 'failed';
  nodeStates: Record<string, NodeState>;
  input: unknown;
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  /** Attached by GET /api/workflows/runs (list) for the health chip. */
  healthScore?: HealthScore;
  /** Attached by GET /api/workflows/runs/:runId (detail). */
  health?: RunHealth;
}

// ---- Run health (features #2/#5) --------------------------------------------

export type HealthScore = 'good' | 'needs-work' | 'poor';

export interface HealthFinding {
  signal: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  fix: string;
  nodeId?: string;
}

export interface RunHealth {
  runId: string;
  workflowId: string;
  score: HealthScore;
  findings: HealthFinding[];
  latencyMs: number | null;
  failedNodes: number;
  generatedAt: number;
}

export interface TurnHealth {
  botId: string;
  sessionId?: string;
  score: HealthScore;
  findings: HealthFinding[];
  generatedAt: number;
}

export interface RegressionAlert {
  id: string;
  scopeKind: 'workflow' | 'bot';
  scopeId: string;
  metric: 'latency-p50' | 'error-rate' | 'cost-per-run';
  metricLabel: string;
  baseline: number;
  current: number;
  changePct: number;
  changeUnit: 'percent' | 'points';
  baselineSamples: number;
  currentSamples: number;
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
}

export interface RegressionsPayload {
  generatedAt: number;
  windowDays: number;
  thresholdPct: number;
  minSamples: number;
  regressions: RegressionAlert[];
}

export const getRunHealth = (runId: string): Promise<RunHealth> =>
  apiJson(`/api/health/runs/${encodeURIComponent(runId)}`);

export const getTurnHealth = (botId?: string): Promise<TurnHealth[]> =>
  apiJson(`/api/health/turns${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`);

export const getRegressions = (): Promise<RegressionsPayload> => apiJson('/api/health/regressions');

export interface PreviewResult {
  verdict: 'ready' | 'warning' | 'blocked';
  bot: string;
  provider: string;
  model: string;
  keyConfigured: boolean;
  skills: string[];
  tools: Array<{ name: string; effect: string }>;
  mcpServers: string[];
  nextActions: string[];
}

// ---- Fetch helpers ----------------------------------------------------------

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return authedFetch(path, init);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

export const getBots = (): Promise<BotConfig[]> => apiJson('/api/bots');

// ---- Chat thread branching -------------------------------------------------

export interface ChatThreadMessage {
  id: number;
  role: string;
  content: string;
  ts: string;
}

export interface ChatThreadBranch {
  id: string;
  title: string;
  botId: string;
  branchedFrom: string;
  fromMessageId: number;
  copiedMessages: number;
  createdAt: string;
}

/** Verbatim message log for a chat thread, with the stable ids branching needs. */
export const getChatThreadMessages = (
  threadId: string,
): Promise<{ ok: boolean; threadId: string; messages: ChatThreadMessage[] }> =>
  apiJson(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`);

/** Branch a thread at a message; returns the new thread. */
export const branchChatThread = (
  threadId: string,
  fromMessageId: number,
  opts?: { title?: string; botId?: string },
): Promise<{ ok: boolean; thread: ChatThreadBranch }> =>
  apiJson(`/api/chat/threads/${encodeURIComponent(threadId)}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromMessageId, ...(opts?.title ? { title: opts.title } : {}), ...(opts?.botId ? { botId: opts.botId } : {}) }),
  });

/** One version in a thread's branch family (root = version 1). */
export interface ChatThreadVersion {
  id: string;
  title: string;
  branchedFrom: string | null;
  createdAt: number;
  version: number;
  isRoot: boolean;
}

/** Branch family of a thread: root + all descendant branches, versioned. */
export const getChatThreadBranches = (
  threadId: string,
): Promise<{ ok: boolean; root: string; threads: ChatThreadVersion[] }> =>
  apiJson(`/api/chat/threads/${encodeURIComponent(threadId)}/branches`);

// ---- Session share links (Octomind parity) ----------------------------------

/** Publish a session transcript as a public page; returns its /p/<slug> path. */
export const shareSession = (
  sessionId: string,
): Promise<{ ok: boolean; slug: string; path: string; title: string; messages: number }> =>
  apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/share`, { method: 'POST' });

// ---- Full-text message search (OpenMausBot parity) --------------------------

/** One message-search hit. snippet wraps matched terms in \u0001..\u0002. */
export interface MessageSearchResult {
  messageId: number;
  sessionId: string;
  botId: string;
  role: string;
  ts: string;
  snippet: string;
  rank: number;
  title?: string;
}

/** Full-text search across chat sessions. */
export const searchMessages = (
  q: string,
  opts?: { botId?: string; sessionId?: string; limit?: number },
): Promise<{ ok: boolean; results: MessageSearchResult[] }> => {
  const params = new URLSearchParams({ q });
  if (opts?.botId) params.set('botId', opts.botId);
  if (opts?.sessionId) params.set('sessionId', opts.sessionId);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiJson(`/api/search/messages?${params.toString()}`);
};

/** Rebuild the full-text message index from all stored messages. */
export const rebuildMessageSearchIndex = (): Promise<{ ok: boolean; indexed: number }> =>
  apiJson('/api/search/messages/rebuild', { method: 'POST' });

// ---- Slack-style reply threads ---------------------------------------------

export interface MessageThread {
  id: string;
  sessionId: string;
  threadSessionId: string;
  rootMessageId: number;
  rootClientId: string | null;
  createdAt: string;
}

export interface MessageThreadSummary extends MessageThread {
  replyCount: number;
  lastReplyAt: string | null;
  unread: boolean;
}

export interface MessageThreadMessage {
  id: number;
  role: string;
  content: string;
  ts: string;
  threadId?: string | null;
  threadRootId?: string | null;
}

/** Create a reply thread anchored to a root message (forks the session). */
export const createMessageThread = (
  sessionId: string,
  rootMessageId: number,
  opts?: { rootClientId?: string; botId?: string },
): Promise<{ ok: boolean; thread: MessageThread; created: boolean }> =>
  apiJson(`/api/chat/${encodeURIComponent(sessionId)}/message-threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootMessageId,
      ...(opts?.rootClientId ? { rootClientId: opts.rootClientId } : {}),
      ...(opts?.botId ? { botId: opts.botId } : {}),
    }),
  });

/** List thread summaries for a session (reply counts + unread flags). */
export const getMessageThreads = (
  sessionId: string,
): Promise<{ ok: boolean; threads: MessageThreadSummary[] }> =>
  apiJson(`/api/chat/${encodeURIComponent(sessionId)}/message-threads`);

/** Get a thread's messages. */
export const getMessageThread = (
  sessionId: string,
  threadId: string,
): Promise<{ ok: boolean; thread: MessageThread; messages: MessageThreadMessage[] }> =>
  apiJson(`/api/chat/${encodeURIComponent(sessionId)}/message-threads/${encodeURIComponent(threadId)}`);

/** Mark a thread as read. */
export const markMessageThreadRead = (sessionId: string, threadId: string): Promise<{ ok: boolean }> =>
  apiJson(`/api/chat/${encodeURIComponent(sessionId)}/message-threads/${encodeURIComponent(threadId)}/read`, {
    method: 'POST',
  });

/**
 * Reply in a thread. Returns the thread's forked session id — drive the
 * agent turn through the normal streamChat() with sessionId set to it.
 */
export const replyInMessageThread = (
  sessionId: string,
  threadId: string,
  content: string,
): Promise<{ ok: boolean; threadId: string; threadSessionId: string }> =>
  apiJson(
    `/api/chat/${encodeURIComponent(sessionId)}/message-threads/${encodeURIComponent(threadId)}/reply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    },
  );

// ---- Message reactions (Codync parity) -------------------------------------

export interface MessageReaction {
  emoji: string;
  userId: string;
  createdAt: string;
}

/** Common emoji options for the reaction picker. */
export const REACTION_EMOJIS = ['👍', '👎', '❤️', '😂', '🎉', '👀', '😮', '😢', '🙏'] as const;

/** What a reaction resolved, when it decided a pending card (W8b). */
export interface ReactionResolution {
  kind: 'approval' | 'widget';
  id: string;
  verdict: 'approved' | 'denied';
  source: 'reaction';
}

/**
 * Toggle a reaction on a message (adds if absent, removes if present).
 * W8b: pass `target` ({approvalId} or {widgetId}) when the message
 * carries a pending question/approval card — an added 👍/👎 then
 * resolves the card through the same decision path as clicking it,
 * and the response carries `resolved`.
 */
export const toggleMessageReaction = (
  sessionId: string,
  messageId: string | number,
  emoji: string,
  target?: { approvalId?: string; widgetId?: string },
): Promise<{ ok: boolean; reactions: MessageReaction[]; added: boolean; resolved?: ReactionResolution }> =>
  apiJson(`/api/chat/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(String(messageId))}/reactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji, ...(target ?? {}) }),
  });

// ---- Chat "Now", sign-in requests, direct-chat goals (W8) ------------------

/** One bot's live turn state (W8a) — what it is doing right now. */
export interface CurrentTurnState {
  botId: string;
  botName?: string;
  sessionId: string;
  step: string;
  stepIndex?: number;
  stepTotal?: number;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
}

/** GET /api/chat/now — live turn state for every busy bot (or one bot). */
export const fetchChatNow = (botId?: string): Promise<{ ok: boolean; turns: CurrentTurnState[] }> =>
  apiJson(`/api/chat/now${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`);

/** A pending sign-in request card in a bot's chat (W8d). */
export interface SignInRequest {
  id: string;
  botId: string;
  sessionId: string;
  cliId: string;
  url?: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  settledAt?: number;
}

export const createSignInRequest = (input: {
  botId: string;
  sessionId: string;
  cliId: string;
  url?: string;
}): Promise<{ ok: boolean; request: SignInRequest }> =>
  apiJson('/api/chat/sign-in-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

export const listSignInRequests = (filter: {
  botId?: string;
  sessionId?: string;
}): Promise<{ ok: boolean; requests: SignInRequest[] }> => {
  const qs = new URLSearchParams();
  if (filter.botId) qs.set('botId', filter.botId);
  if (filter.sessionId) qs.set('sessionId', filter.sessionId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiJson(`/api/chat/sign-in-requests${suffix}`);
};

/** Minimal group-goal shape the chat renders (full record: Teams → Goals). */
export interface GroupGoalSummary {
  id: string;
  title: string;
  status: string;
  coordinatorBotId: string;
  workerBotIds: string[];
  maxTurns: number;
  summary?: string | null;
  sessionId?: string | null;
}

/** GET /api/group-goals/:id — status of one goal run (W8f chat card). */
export const fetchGroupGoal = (
  goalId: string,
): Promise<{ ok: boolean; goal: GroupGoalSummary; turns: Array<{ turnNumber: number; decision: string }> }> =>
  apiJson(`/api/group-goals/${encodeURIComponent(goalId)}`);

/** Batch-fetch reactions for a list of message ids. */
export const getMessageReactions = (
  sessionId: string,
  messageIds: Array<string | number>,
): Promise<{ ok: boolean; byMessageId: Record<string, MessageReaction[]> }> =>
  apiJson(
    `/api/chat/${encodeURIComponent(sessionId)}/messages/reactions?ids=${messageIds.map((id) => encodeURIComponent(String(id))).join(',')}`,
  );

// ---- Bot roster import/export ----------------------------------------------

export interface RosterReportItem {
  id: string;
  reason: string;
}

export interface RosterImportReport {
  ok: boolean;
  imported: string[];
  skipped: RosterReportItem[];
  errors: RosterReportItem[];
}

/** Download the full bot+team roster as a JSON file. */
export const exportBotRoster = async (): Promise<void> => {
  const res = await apiFetch('/api/bots/export');
  if (!res.ok) throw new Error(`API ${res.status}: export failed`);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(cd);
  const filename = match?.[1] ?? 'kriyadot-bot-roster.json';
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

/** Import a roster manifest; returns the per-id import report. */
export const importBotRoster = (manifest: unknown): Promise<RosterImportReport> =>
  apiJson('/api/bots/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
export const setBotWorkspace = (botId: string, workspace: string | null): Promise<{ ok: boolean; botId: string; workspace: string | null; root: string | null }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/workspace`, {
    method: 'PUT',
    body: JSON.stringify({ workspace }),
  });
export const getPersonas = (): Promise<{ ok: boolean; personas: PersonaInfo[] }> => apiJson('/api/personas');
export const setBotPersona = (botId: string, persona: string | null): Promise<{ ok: boolean; botId: string; persona: string | null; name: string | null }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/persona`, {
    method: 'PUT',
    body: JSON.stringify({ persona }),
  });

// ---- Per-bot model + options (Codync parity: model picker) ----------------

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
  supportsReasoningEffort?: boolean;
  supportsFastMode?: boolean;
  supportsTemperature?: boolean;
}

export interface ModelOptions {
  reasoningEffort?: 'low' | 'medium' | 'high';
  fastMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export const getAgentModels = (agentId: string): Promise<{ ok: boolean; agentId: string; models: AgentModel[] }> =>
  apiJson(`/api/agents/${encodeURIComponent(agentId)}/models`);

export const setBotModel = (
  botId: string,
  model: string | null,
  modelOptions: ModelOptions | null,
  backup?: { backupProvider?: string | null; backupModel?: string | null },
): Promise<{
  ok: boolean;
  botId: string;
  model?: string;
  modelOptions?: ModelOptions;
  backupProvider?: string;
  backupModel?: string;
}> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/model`, {
    method: 'PUT',
    body: JSON.stringify({ model, modelOptions, ...(backup ?? {}) }),
  });

export const setBotVoice = (
  botId: string,
  voice: VoiceSettings,
): Promise<{ ok: boolean; botId: string; voice: VoiceSettings }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/voice`, {
    method: 'PUT',
    body: JSON.stringify({ voice }),
  });

export type ApprovalMode = 'plan' | 'auto' | 'bypass';

export const setBotApprovalMode = (
  botId: string,
  approvalMode: ApprovalMode,
): Promise<{ ok: boolean; botId: string; approvalMode: ApprovalMode }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/approval-mode`, {
    method: 'PUT',
    body: JSON.stringify({ approvalMode }),
  });

export const getBotApprovalMode = (
  botId: string,
): Promise<{ ok: boolean; botId: string; approvalMode: ApprovalMode }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/approval-mode`);
export const getProviders = (): Promise<ProviderInfo[]> => apiJson('/api/providers');
export const getModels = (freeOnly = false): Promise<ModelPriceInfo[]> =>
  apiJson(`/api/models${freeOnly ? '?freeOnly=1' : ''}`);

/** models.dev catalog cache info (OpenMausBot parity P1 #23). */
export interface ModelsCatalogInfo {
  fetchedAt: string | null;
  ageMs: number | null;
  ageLabel: string;
  providerCount: number;
  modelCount: number;
}
export const getModelsCatalogInfo = (): Promise<ModelsCatalogInfo> =>
  apiJson('/api/models/catalog-info');
export const refreshModelsCatalog = (): Promise<ModelsCatalogInfo & { ok: boolean }> =>
  apiJson('/api/models/refresh', { method: 'POST' });
export function updateBotPolicy(botId: string, rules: BotPolicyRule[]): Promise<{ ok: boolean; botId: string; policy: BotPolicy }> {
  return apiJson(`/api/bots/${encodeURIComponent(botId)}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
}

export function getApprovals(status?: string): Promise<ApprovalRecord[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiJson(`/api/approvals${q}`);
}

export function decideApproval(
  id: string,
  decision: 'approved' | 'denied',
  note?: string,
): Promise<ApprovalRecord> {
  return apiJson(`/api/approvals/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, note }),
  });
}

/**
 * "Always allow this tool" — appends a persistent allow rule for one tool
 * to the bot's governance policy so future calls skip the approval card.
 */
export function allowTool(
  botId: string,
  tool: string,
): Promise<{ ok: boolean; botId: string; tool: string }> {
  return apiJson(`/api/bots/${encodeURIComponent(botId)}/allow-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool }),
  });
}

// ---- Interactive widgets (OpenMausBot parity: AskUserQuestion) ----------------

/**
 * Post an interactive widget's answer.
 * POST /api/widgets/:id/answer with { value } -> { ok: true, widget }.
 * Answer value shapes:
 * - buttons/select: { selected: string[] (option ids), freeText?: string }
 * - input: { text: string }
 * - confirm: { confirmed: boolean }
 */
export function answerWidget(widgetId: string, value: unknown): Promise<{ ok: boolean }> {
  return apiJson(`/api/widgets/${encodeURIComponent(widgetId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

// ---- Peer approvals (OpenMausBot parity) ------------------------------------

export interface PeerApprovalCard {
  id: string;
  senderBotId: string;
  senderBotName: string;
  targetBotId: string;
  targetBotName: string;
  actionType: 'ask' | 'message' | 'delegate';
  preview: string;
  sessionId: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired' | 'dismissed';
  createdAt: number;
  expiresAt: number | null;
  neverExpire?: boolean;
  decidedAt?: number;
  decidedBy?: string;
  /** Origin chain of the sender's turn (P1 #13) — shown as a security note. */
  provenance?: import('../components/provenance-chip').ProvenanceNoteDto;
}

export interface PeerGrant {
  senderBotId: string;
  targetBotId: string;
  actionType: 'ask' | 'message' | 'delegate';
  grantedAt: number;
  grantedBy?: string;
}

export type PeerDecision = 'allow' | 'deny' | 'always-allow';

export interface CredentialProposal {
  id: string;
  botId: string;
  sessionId: string;
  key: string;
  label: string;
  reason: string;
  status: 'pending' | 'fulfilled' | 'denied' | 'expired';
  createdAt: number;
  expiresAt: number | null;
  neverExpire?: boolean;
}

/** Credential proposal cards: a bot needs a secret it doesn't have. */
export async function getCredentialProposals(status?: string): Promise<CredentialProposal[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await apiJson<{ ok: boolean; cards: CredentialProposal[] }>(`/api/credential-proposals${q}`);
  return res.cards;
}

/** Supply the value (goes straight to the vault) or deny the card. */
export async function decideCredentialProposal(
  id: string,
  decision: 'fulfill' | 'deny',
  value?: string,
): Promise<CredentialProposal> {
  const res = await apiJson<{ ok: boolean; card: CredentialProposal }>(
    `/api/credential-proposals/${encodeURIComponent(id)}`,
    {
      method: 'POST',
      body: JSON.stringify({ decision, ...(value !== undefined ? { value } : {}) }),
    },
  );
  return res.card;
}

export async function getPeerApprovals(status?: string): Promise<PeerApprovalCard[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await apiJson<{ ok: boolean; cards: PeerApprovalCard[] }>(`/api/peer-approvals${q}`);
  return res.cards;
}

export async function decidePeerApproval(
  id: string,
  decision: PeerDecision,
  decidedBy?: string,
): Promise<PeerApprovalCard> {
  const res = await apiJson<{ ok: boolean; card: PeerApprovalCard }>(
    `/api/peer-approvals/${encodeURIComponent(id)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, decidedBy }),
    },
  );
  return res.card;
}

export async function getPeerGrants(): Promise<PeerGrant[]> {
  const res = await apiJson<{ ok: boolean; grants: PeerGrant[] }>('/api/peer-grants');
  return res.grants;
}

export function revokePeerGrant(
  senderBotId: string,
  targetBotId: string,
  actionType: PeerGrant['actionType'],
): Promise<{ ok: boolean; revoked: boolean }> {
  return apiJson('/api/peer-grants', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senderBotId, targetBotId, actionType }),
  });
}

// ---- Proactive account watching (W5) ---------------------------------------
// Watch rules poll a connected app, triage new items with a cheap helper
// model, and surface only flagged items as "needs you" inbox entries.

export type WatchAppId = 'gmail' | 'slack' | 'github' | 'stripe' | 'googlecalendar';
export type WatchKind =
  | 'needs-reply'
  | 'payment-failed'
  | 'review-requested'
  | 'meeting-conflict'
  | 'mention'
  | 'custom';
export type WatchItemStatus = 'new' | 'actioned' | 'dismissed';

export interface WatchRuleState {
  ruleId: string;
  cursorId: string | null;
  cursorTs: number | null;
  lastPollAt: number | null;
  lastSurfacedAt: number | null;
  lastError: string | null;
  capBlocked: boolean;
  updatedAt: number;
}

export interface WatchRule {
  id: string;
  name: string;
  botId: string;
  userId: string;
  app: WatchAppId;
  accountId: string;
  kind: WatchKind;
  instruction: string;
  intervalMinutes: number;
  enabled: boolean;
  dailyCap: number;
  timezone: string;
  channelId?: string;
  repo?: string;
  calendarId?: string;
  createdAt: number;
  updatedAt: number;
  state?: WatchRuleState | null;
}

export interface WatchItem {
  id: string;
  ruleId: string;
  sourceItemId: string;
  app: WatchAppId;
  sourceKind: string;
  summary: string;
  fields: Record<string, string>;
  urgency: 'low' | 'medium' | 'high';
  reason: string;
  suggestedAction: string;
  status: WatchItemStatus;
  draftText?: string;
  draftRef?: string;
  itemTs: number | null;
  surfacedAt: number;
  updatedAt: number;
}

export interface WatchRun {
  id: number;
  ruleId: string;
  startedAt: number;
  listed: number;
  checked: number;
  surfaced: number;
  skippedCatchUp: number;
  capBlocked: number;
  note?: string;
  error?: string;
}

export interface WatchRuleInput {
  name?: string;
  botId?: string;
  app: WatchAppId;
  accountId: string;
  kind: WatchKind;
  instruction?: string;
  intervalMinutes?: number;
  enabled?: boolean;
  dailyCap?: number;
  timezone?: string;
  channelId?: string;
  repo?: string;
  calendarId?: string;
}

const watchJsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function getWatchRules(): Promise<WatchRule[]> {
  const res = await apiJson<{ rules: WatchRule[] }>('/api/watch-rules');
  return res.rules;
}

export async function createWatchRule(input: WatchRuleInput): Promise<WatchRule> {
  const res = await apiJson<{ rule: WatchRule }>('/api/watch-rules', watchJsonInit('POST', input));
  return res.rule;
}

export async function updateWatchRule(id: string, patch: Partial<WatchRuleInput>): Promise<WatchRule> {
  const res = await apiJson<{ rule: WatchRule }>(
    `/api/watch-rules/${encodeURIComponent(id)}`,
    watchJsonInit('PATCH', patch),
  );
  return res.rule;
}

export async function deleteWatchRule(id: string): Promise<void> {
  await apiJson(`/api/watch-rules/${encodeURIComponent(id)}`, watchJsonInit('DELETE'));
}

export async function runWatchRuleNow(id: string): Promise<{ checked: number; surfaced: number }> {
  const res = await apiJson<{ result: { checked: number; surfaced: number } }>(
    `/api/watch-rules/${encodeURIComponent(id)}/run-now`,
    watchJsonInit('POST'),
  );
  return res.result;
}

export async function getWatchItems(status?: WatchItemStatus): Promise<WatchItem[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await apiJson<{ items: WatchItem[] }>(`/api/watch-items${q}`);
  return res.items;
}

export async function dismissWatchItem(id: string): Promise<WatchItem> {
  const res = await apiJson<{ item: WatchItem }>(
    `/api/watch-items/${encodeURIComponent(id)}/dismiss`,
    watchJsonInit('POST'),
  );
  return res.item;
}

export async function draftWatchItem(id: string): Promise<WatchItem> {
  const res = await apiJson<{ item: WatchItem }>(
    `/api/watch-items/${encodeURIComponent(id)}/draft`,
    watchJsonInit('POST'),
  );
  return res.item;
}

export async function getWatchRuns(ruleId?: string): Promise<WatchRun[]> {
  const q = ruleId ? `?ruleId=${encodeURIComponent(ruleId)}` : '';
  const res = await apiJson<{ runs: WatchRun[] }>(`/api/watch-runs${q}`);
  return res.runs;
}

// ---- Custom slash commands --------------------------------------------------

export interface SlashCommand {
  description: string;
  prompt: string;
}

export function getSlashCommands(): Promise<{ ok: boolean; commands: Record<string, SlashCommand> }> {
  return apiJson('/api/slash-commands');
}

export function saveSlashCommand(
  name: string,
  command: SlashCommand,
): Promise<{ ok: boolean; commands: Record<string, SlashCommand> }> {
  return apiJson('/api/slash-commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...command }),
  });
}

export function deleteSlashCommand(name: string): Promise<{ ok: boolean; deleted: string }> {
  return apiJson(`/api/slash-commands/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function getAudit(limit = 100): Promise<AuditEntry[]> {
  return apiJson(`/api/audit?limit=${limit}`);
}

// ---- Collaborative Pages ----------------------------------------------------

export interface Page {
  id: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface PageVersion {
  id: string;
  pageId: string;
  version: number;
  title: string;
  content: string;
  createdAt: number;
  createdBy: string;
}

export interface PageComment {
  id: string;
  pageId: string;
  author: string;
  text: string;
  createdAt: number;
  resolved: boolean;
}

export interface PageMention {
  id: string;
  pageId: string;
  mentioned: string;
  isBot: boolean;
  context: string;
  author: string;
  status: 'pending' | 'done' | 'failed';
  createdAt: number;
}

export interface PageDetail extends Page {
  comments: PageComment[];
  mentions: PageMention[];
}

export const listPages = (): Promise<Page[]> => apiJson('/api/pages');

export function createPage(input: { title: string; content?: string; createdBy?: string }): Promise<Page> {
  return apiJson('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export const getPage = (id: string): Promise<PageDetail> =>
  apiJson(`/api/pages/${encodeURIComponent(id)}`);

export function updatePage(
  id: string,
  input: { title?: string; content?: string; updatedBy?: string },
): Promise<Page> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deletePage(id: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export const listPageVersions = (id: string): Promise<PageVersion[]> =>
  apiJson(`/api/pages/${encodeURIComponent(id)}/versions`);

export function restorePageVersion(id: string, versionId: string): Promise<Page> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/restore/${encodeURIComponent(versionId)}`, {
    method: 'POST',
  });
}

export function addPageComment(
  id: string,
  input: { author: string; text: string },
): Promise<PageComment> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function resolvePageComment(
  id: string,
  commentId: string,
  resolved: boolean,
): Promise<PageComment> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  });
}

export function deletePageComment(id: string, commentId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
}

export function addPageMention(
  id: string,
  input: { mentioned: string; context?: string; author?: string },
): Promise<PageMention> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/mentions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// ---- Public page publishing (W3) ---------------------------------------------

export interface PagePublicationStatus {
  published: boolean;
  slug?: string;
  /** Public URL path on this KriyaDot server, e.g. /p/<slug>. */
  path?: string;
  publishedAt?: number;
  views?: number;
}

export function publishPage(id: string): Promise<PagePublicationStatus & { title?: string }> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/publish`, { method: 'POST' });
}

export function unpublishPage(id: string): Promise<{ published: boolean }> {
  return apiJson(`/api/pages/${encodeURIComponent(id)}/publish`, { method: 'DELETE' });
}

export const getPagePublication = (id: string): Promise<PagePublicationStatus> =>
  apiJson(`/api/pages/${encodeURIComponent(id)}/publication`);

export function saveProviderKey(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
  headers?: Record<string, string>,
): Promise<{ ok: boolean }> {
  return apiJson('/api/providers/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, apiKey, baseUrl, headers }),
  });
}

export function removeProviderKey(providerId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/providers/keys/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
}

export function connectBridge(bridgeId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/providers/bridges/${encodeURIComponent(bridgeId)}/connect`, {
    method: 'POST',
  });
}

export function disconnectBridge(bridgeId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/providers/bridges/${encodeURIComponent(bridgeId)}/disconnect`, {
    method: 'DELETE',
  });
}

// ---- Native CLI in-app sign-in (OpenMausBot parity) ------------------------

export interface CliLoginStatus {
  cliId: string;
  cliPresent: boolean;
  credentialsPresent: boolean;
  signedIn: boolean;
  accountHint?: string;
  expired?: boolean;
}

export interface CliSessionInfo {
  id: string;
  title: string;
  updatedAt: number;
  cliId: string;
}

export function getCliAuthStatus(): Promise<{ ok: boolean; clis: CliLoginStatus[] }> {
  return apiJson('/api/cli-auth/status');
}

export function startCliLogin(cliId: string): Promise<{ ok: boolean; loginId: string; url: string }> {
  return apiJson(`/api/cli-auth/${encodeURIComponent(cliId)}/login`, { method: 'POST' });
}

export function pollCliLogin(
  cliId: string,
  loginId: string,
): Promise<{ ok: boolean; status: 'waiting' | 'done' | 'failed' | 'cancelled'; url?: string; reason?: string }> {
  return apiJson(`/api/cli-auth/${encodeURIComponent(cliId)}/login/${encodeURIComponent(loginId)}`);
}

export function cancelCliLogin(cliId: string, loginId: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/cli-auth/${encodeURIComponent(cliId)}/login/${encodeURIComponent(loginId)}/cancel`, {
    method: 'POST',
  });
}

export function listCliSessions(cliId: string): Promise<{ ok: boolean; sessions: CliSessionInfo[] }> {
  return apiJson(`/api/cli-auth/${encodeURIComponent(cliId)}/sessions`);
}

export const getWorkflows = (): Promise<WorkflowDefinition[]> => apiJson('/api/workflows');

export function runWorkflow(
  id: string,
  input?: unknown,
  idempotencyKey?: string,
): Promise<{ runId: string }> {
  return apiJson(`/api/workflows/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, idempotencyKey }),
  });
}

export const getRuns = (): Promise<WorkflowRun[]> => apiJson('/api/workflows/runs');
export const getRun = (runId: string): Promise<WorkflowRun> =>
  apiJson(`/api/workflows/runs/${encodeURIComponent(runId)}`);

/** n8n node that had no KriyaDot mapping during import (imported as a placeholder). */
export interface UnmappedN8nNode {
  n8nType: string;
  name: string;
  reason: string;
}

export interface N8nImportResult {
  workflow: WorkflowDefinition;
  unmapped: UnmappedN8nNode[];
}

/** Import a standard n8n workflow export JSON; registers it server-side. */
export function importN8nWorkflow(n8nJson: unknown): Promise<N8nImportResult> {
  return apiJson('/api/workflows/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n8nJson }),
  });
}

/** Export a workflow definition in n8n format (best-effort reverse mapping). */
export function exportN8nWorkflow(id: string): Promise<unknown> {
  return apiJson(`/api/workflows/${encodeURIComponent(id)}/export-n8n`);
}

export function dryRun(botId: string, message: string): Promise<PreviewResult> {
  return apiJson('/api/dry-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId, message }),
  });
}

export interface PolicySimulationResult {
  toolName: string;
  botId: string;
  effect: 'allow' | 'require-approval' | 'deny';
  actionClass: string;
  matchedRuleId?: string;
  reason: string;
  wouldCreateApproval: boolean;
  hardFloor?: { tier: 'catastrophic' | 'destructive'; reason: string; patternId: string };
  denylist?: boolean;
  simulated: true;
}

/** Side-effect-free policy dry-run: what WOULD the policy do for this tool call? */
export function simulatePolicy(
  toolName: string,
  args: Record<string, unknown>,
  botId?: string,
): Promise<PolicySimulationResult> {
  return apiJson('/api/policy/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolName, args, botId }),
  });
}

export interface ActionRegistryEntry {
  name: string;
  description: string;
  parameters: unknown;
}

/** Read-only action registry: every tool the agent can call. */
export function getActionRegistry(): Promise<{ tools: ActionRegistryEntry[] }> {
  return apiJson('/api/tools');
}

// ---- SSE --------------------------------------------------------------------

export interface ChatRequest {
  botId: string;
  message: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  /** Reasoning effort for models that support it (low/medium/high). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Turn-scoped model override (chat polish): applies to THIS turn only.
   * The chat route already accepts a per-request `model`; the page sends
   * the turn model as both `model` and `modelOverride` so the server can
   * distinguish a one-turn override from the bot's saved model. */
  modelOverride?: string;
  /** Attached file IDs (from /api/files/upload). */
  fileIds?: string[];
  /** Sandbox mode: read-only | workspace-write | danger-full-access. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Steering mode: 'interrupt' (default) aborts in-flight turn; 'queue' waits for boundary. */
  queueMode?: 'interrupt' | 'queue';
  /** Session auto-approve: skip approval cards for this turn (audited). */
  autoApprove?: boolean;
  /** Streaming TTS (W8h): synthesize the reply sentence-by-sentence while it streams. */
  voiceReply?: boolean;
  /** Plan mode: read-only exploration, mutating tools denied. */
  planMode?: boolean;
  /** Fail-closed max spend in USD for this turn. */
  maxBudgetUsd?: number;
  /** AbortSignal to cancel the stream client-side (Stop button). */
  signal?: AbortSignal;
}

/** Event yielded when a message is queued instead of starting a turn. */
export interface QueuedEvent {
  type: 'queued';
  queueId: string;
  position: number;
  sessionId: string;
}

/** POST /api/chat and yield each SSE `data:` payload as a parsed StreamEvent. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent | QueuedEvent> {
  const { signal, ...body } = req;
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`Chat failed (${res.status}): ${detail || res.statusText}`);
  }
  // Queue-at-boundary: server returns JSON { queued: true } instead of SSE.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const data = (await res.json()) as { queued?: boolean; id?: string; position?: number; sessionId?: string };
    if (data.queued) {
      yield { type: 'queued', queueId: data.id ?? '', position: data.position ?? 0, sessionId: data.sessionId ?? '' };
    }
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          yield JSON.parse(line.slice('data: '.length)) as StreamEvent;
        }
      }
    }
  }
}

/** SSE of workflow run updates for one run. */
export async function* streamRunUpdates(runId: string): AsyncGenerator<WorkflowRun> {
  const res = await apiFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/stream`);
  if (!res.ok || !res.body) throw new Error(`Run stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          yield JSON.parse(line.slice('data: '.length)) as WorkflowRun;
        }
      }
    }
  }
}

/** File upload for chat attachments. */
export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  extracted?: {
    units?: number;
    unitLabel?: string;
    truncated?: boolean;
    charCount?: number;
  };
  extractFailed?: boolean;
}

/** File-type icon for attachment chips. */
export function fileTypeIcon(name: string, mimeType: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const mt = mimeType.toLowerCase();
  if (mt === 'application/pdf' || ext === 'pdf') return '📕';
  if (ext === 'docx' || ext === 'doc') return '📘';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return '📊';
  if (ext === 'pptx' || ext === 'ppt') return '📙';
  if (mt.startsWith('image/')) return '🖼️';
  if (mt.startsWith('audio/')) return '🎵';
  if (mt.startsWith('video/')) return '🎬';
  if (['txt', 'md'].includes(ext)) return '📝';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
  return '📄';
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  // Read as base64
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data: prefix
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await apiFetch('/api/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      data,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${detail || res.statusText}`);
  }
  return (await res.json()) as UploadedFile;
}

export async function deleteUploadedFile(id: string): Promise<void> {
  const res = await apiFetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}

/** Bot-to-bot conversation sheets. */
export interface BotExchangeDto {
  id: string;
  sourceBotId: string;
  targetBotId: string;
  type: 'ask' | 'message';
  text: string;
  reply?: string;
  status: 'pending' | 'completed' | 'failed';
  detail?: string;
  createdAt: string;
  completedAt?: string;
  /** Provenance note (P1 #13): origin + relay path, shown as a "via" chip. */
  provenance?: import('../components/provenance-chip').ProvenanceNoteDto;
}

export interface BotPeerDto {
  peerId: string;
  exchangeCount: number;
  lastAt: string;
}

export async function fetchBotConversation(
  botId: string,
  otherBotId: string,
  limit = 200,
): Promise<BotExchangeDto[]> {
  const res = await apiFetch(
    `/api/bots/${encodeURIComponent(botId)}/conversations/${encodeURIComponent(otherBotId)}?limit=${limit}`,
  );
  if (!res.ok) throw new Error(`Conversation sheet failed (${res.status})`);
  const body = (await res.json()) as { exchanges: BotExchangeDto[] };
  return body.exchanges;
}

export async function fetchBotPeers(botId: string): Promise<BotPeerDto[]> {
  const res = await apiFetch(`/api/bots/${encodeURIComponent(botId)}/conversations`);
  if (!res.ok) throw new Error(`Peers failed (${res.status})`);
  const body = (await res.json()) as { peers: BotPeerDto[] };
  return body.peers;
}

export interface DetectedAgentDto {
  id: string;
  name: string;
  bin: string;
  path: string;
  version: string | null;
  acpCompatible: boolean;
  homepage: string;
}

export interface AgentListEntryDto extends Partial<DetectedAgentDto> {
  id: string;
  name: string;
  installed: boolean;
  bins?: string[];
  installHint?: string;
  installHintWindows?: string;
  homepage: string;
  acpCompatible: boolean;
}

export async function fetchDetectedAgents(): Promise<{ agents: DetectedAgentDto[]; scannedAt: number }> {
  const res = await apiFetch('/api/agents/detected');
  if (!res.ok) throw new Error(`Detected agents failed (${res.status})`);
  return res.json();
}

export async function fetchAllAgents(): Promise<{ agents: AgentListEntryDto[]; scannedAt: number }> {
  const res = await apiFetch('/api/agents');
  if (!res.ok) throw new Error(`Agents list failed (${res.status})`);
  return res.json();
}

export async function rescanAgents(): Promise<{ agents: DetectedAgentDto[]; scannedAt: number }> {
  const res = await apiFetch('/api/agents/rescan', { method: 'POST' });
  if (!res.ok) throw new Error(`Rescan failed (${res.status})`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Fusion mode (planner + parallel workers + fused synthesis)           */
/* ------------------------------------------------------------------ */

export interface FusionSubtaskDto {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
}

export interface FusionPlanDto {
  subtasks: FusionSubtaskDto[];
  rationale?: string;
}

export interface FusionWorkerResultDto {
  subtaskId: string;
  title: string;
  output: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
}

export type FusionRunStatus = 'running' | 'completed' | 'aborted_budget' | 'failed';

export interface FusionRunDto {
  runId: string;
  botId: string;
  botName: string;
  task: string;
  status: FusionRunStatus;
  plan: FusionPlanDto | null;
  workerResults: FusionWorkerResultDto[];
  fused: string | null;
  fallbackSingleAgent: boolean;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type FusionStreamEvent =
  | { type: 'snapshot'; run: FusionRunDto }
  | { type: 'plan_created'; plan: FusionPlanDto }
  | { type: 'plan_failed'; reason: string }
  | { type: 'worker_started'; subtaskId: string; title: string }
  | { type: 'worker_done'; subtaskId: string; title: string; ok: boolean }
  | { type: 'fusion_started'; workerCount: number }
  | { type: 'done'; result: {
      task: string;
      status: FusionRunStatus;
      plan: FusionPlanDto | null;
      workerResults: FusionWorkerResultDto[];
      fused: string;
      fallbackSingleAgent: boolean;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      costUsd?: number;
      error?: string;
    } }
  | { type: 'error'; message: string };

export async function startFusionRun(input: {
  botId: string;
  task: string;
  maxSubtasks?: number;
  maxConcurrency?: number;
  maxBudgetUsd?: number;
}): Promise<{ ok: boolean; runId: string }> {
  const res = await apiFetch('/api/fusion/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`Fusion run failed to start (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

export async function getFusionRun(runId: string): Promise<{ ok: boolean; run: FusionRunDto }> {
  return apiJson(`/api/fusion/runs/${encodeURIComponent(runId)}`);
}

export async function listFusionRuns(limit = 50): Promise<{ ok: boolean; runs: FusionRunDto[] }> {
  return apiJson(`/api/fusion/runs?limit=${limit}`);
}

/**
 * Subscribe to a fusion run's SSE progress stream. Returns an unsubscribe
 * function. Uses fetch + reader (EventSource can't send headers, and the
 * fetch pattern matches the chat stream implementation).
 */
export function streamFusionRun(
  runId: string,
  onEvent: (e: FusionStreamEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const controller = new AbortController();
  let buffer = '';
  const dispatch = (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as FusionStreamEvent);
        } catch {
          // ignore malformed frame
        }
      }
    }
  };
  (async () => {
    try {
      // Fetch-based streaming: EventSource cannot send the Authorization
      // header, so the token is attached here via authedFetch.
      const res = await authedFetch(`/api/fusion/runs/${encodeURIComponent(runId)}/stream`, {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Fusion stream failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        dispatch(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return () => controller.abort();
}

// ---------------------------------------------------------------------------
// Eval harnesses (Atomic Agent parity)
// ---------------------------------------------------------------------------

export type EvalRubricDto =
  | { type: 'contains'; keywords: string[]; caseSensitive?: boolean }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'tool_used'; tool: string | string[] }
  | { type: 'llm_judge'; criteria: string; threshold?: number; model?: string };

export interface EvalCaseDto {
  id: string;
  name: string;
  input: string;
  rubrics: EvalRubricDto[];
  passThreshold?: number;
  setupMemories?: string[];
  timeoutMs?: number;
}

export interface EvalSuiteDto {
  id: string;
  name: string;
  description?: string;
  cases: EvalCaseDto[];
}

export interface EvalRubricResultDto {
  rubric: EvalRubricDto;
  score: number;
  detail: string;
}

export interface EvalCaseResultDto {
  caseId: string;
  name: string;
  passed: boolean;
  score: number;
  rubricResults: EvalRubricResultDto[];
  response: string;
  toolsUsed: string[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  error?: string;
  durationMs: number;
}

export interface EvalRunDto {
  runId: string;
  suiteId: string;
  suiteName: string;
  botId: string;
  botName: string;
  status: 'running' | 'completed' | 'aborted_budget' | 'failed';
  score: number | null;
  passed: number | null;
  failed: number | null;
  caseResults: EvalCaseResultDto[] | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type EvalStreamEvent =
  | { type: 'snapshot'; run: EvalRunDto }
  | { type: 'run_started'; suiteId: string; suiteName: string; caseCount: number }
  | { type: 'case_started'; caseId: string; name: string; index: number; total: number }
  | { type: 'case_done'; result: EvalCaseResultDto }
  | { type: 'done'; report: unknown }
  | { type: 'error'; message: string };

export async function listEvalSuites(): Promise<{ ok: boolean; suites: EvalSuiteDto[] }> {
  return apiJson('/api/evals');
}

export async function saveEvalSuite(suite: EvalSuiteDto): Promise<{ ok: boolean; suite: EvalSuiteDto }> {
  const res = await apiFetch('/api/evals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(suite),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { errors?: string[]; error?: string };
      detail = body.errors?.join('; ') ?? body.error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`Saving eval suite failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

export async function deleteEvalSuite(id: string): Promise<{ ok: boolean; deleted: boolean }> {
  return apiJson(`/api/evals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function startEvalRun(input: {
  suiteId: string;
  botId: string;
  maxConcurrency?: number;
  maxBudgetUsd?: number;
  providerId?: string;
  model?: string;
  judgeProviderId?: string;
  judgeModel?: string;
}): Promise<{ ok: boolean; runId: string }> {
  const res = await apiFetch(`/api/evals/${encodeURIComponent(input.suiteId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`Eval run failed to start (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

export async function listEvalRuns(limit = 50, suiteId?: string): Promise<{ ok: boolean; runs: EvalRunDto[] }> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (suiteId) q.set('suiteId', suiteId);
  return apiJson(`/api/evals/runs?${q.toString()}`);
}

export async function getEvalRun(runId: string): Promise<{ ok: boolean; run: EvalRunDto }> {
  return apiJson(`/api/evals/runs/${encodeURIComponent(runId)}`);
}

/**
 * Subscribe to an eval run's SSE progress stream. Returns an unsubscribe
 * function. Same fetch + reader pattern as the fusion stream.
 */
export function streamEvalRun(
  runId: string,
  onEvent: (e: EvalStreamEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const controller = new AbortController();
  let buffer = '';
  const dispatch = (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as EvalStreamEvent);
        } catch {
          // ignore malformed frame
        }
      }
    }
  };
  (async () => {
    try {
      // Fetch-based streaming: EventSource cannot send the Authorization
      // header, so the token is attached here via authedFetch.
      const res = await authedFetch(`/api/evals/runs/${encodeURIComponent(runId)}/stream`, {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Eval stream failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        dispatch(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return () => controller.abort();
}

// ---- Chief of Staff (/api/teams/chief, /sections, /proposals, /incidents) --

export interface ChiefInfo {
  ok: boolean;
  chiefBotId: string | null;
  managedSections: string[];
}

export interface ChiefProposalOpDto {
  action: 'create' | 'update' | 'delete';
  key?: string;
  botId?: string;
  fields?: Record<string, unknown>;
}

export interface ChiefProposalDto {
  id: string;
  kind: 'team-setup' | 'create-bot' | 'delete-bot';
  createdByBotId: string;
  reason: string;
  operations: ChiefProposalOpDto[];
  status: 'pending' | 'approved' | 'rejected';
  suggestion?: boolean;
  newTeams?: string[];
  createdAt: string;
  decidedAt?: string;
}

export interface ChiefIncidentDto {
  id: string;
  kind: 'incident' | 'escalation';
  chiefBotId: string;
  targetBotId?: string;
  targetBotName?: string;
  threadId?: string;
  summary: string;
  detail?: string;
  attempts: number;
  status: 'open' | 'triaged' | 'resolved';
  createdAt: string;
  updatedAt: string;
}

export const getChief = (): Promise<ChiefInfo> => apiJson('/api/teams/chief');

export const setChief = (botId: string | null): Promise<ChiefInfo> =>
  apiJson('/api/teams/chief', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botId }),
  });

export const getChiefSections = (): Promise<{ ok: boolean; sections: string[] }> =>
  apiJson('/api/teams/sections');

export const setChiefSections = (sections: string[]): Promise<{ ok: boolean; sections: string[] }> =>
  apiJson('/api/teams/sections', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sections }),
  });

export const listChiefProposals = (status?: string): Promise<{ ok: boolean; proposals: ChiefProposalDto[] }> =>
  apiJson(`/api/teams/proposals${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const approveChiefProposal = (id: string): Promise<{ ok: boolean; proposal: ChiefProposalDto; applied: string[] }> =>
  apiJson(`/api/teams/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST' });

export const rejectChiefProposal = (id: string, note?: string): Promise<{ ok: boolean; proposal: ChiefProposalDto }> =>
  apiJson(`/api/teams/proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  });

export const listChiefIncidents = (status?: string, kind?: string): Promise<{ ok: boolean; incidents: ChiefIncidentDto[] }> => {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (kind) q.set('kind', kind);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiJson(`/api/teams/incidents${suffix}`);
};

export const resolveChiefIncident = (id: string, note?: string): Promise<{ ok: boolean; incident: ChiefIncidentDto }> =>
  apiJson(`/api/teams/incidents/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  });

export const retryChiefIncident = (id: string): Promise<{ ok: boolean; incidentId: string; attempts: number; incident: ChiefIncidentDto }> =>
  apiJson(`/api/teams/incidents/${encodeURIComponent(id)}/retry`, { method: 'POST' });

// ---------------------------------------------------------------------------
// ACP sessions (OpenMausBot parity P1 #26 — ACP completion)
// ---------------------------------------------------------------------------

export interface AcpSessionDto {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  agentName: string;
  status: 'active' | 'busy' | 'closed' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface AcpTranscriptEventDto {
  seq: number;
  type: 'user' | 'agent' | 'tool_call' | 'tool_result' | 'system' | 'error';
  text: string;
  untrusted: boolean;
  toolCallId?: string;
  toolName?: string;
  ts: string;
}

export type AcpPromptStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'tool_call'; toolCall: { toolCallId: string; name: string; args: Record<string, unknown> } }
  | { type: 'tool_result'; toolCallId: string; approved: boolean }
  | { type: 'done'; text: string }
  | { type: 'error'; kind: string; message: string }
  | { type: 'cancelled' };

export const listAcpSessions = (): Promise<{ ok: boolean; sessions: AcpSessionDto[] }> =>
  apiJson('/api/acp');

export interface AcpEngineDto {
  id: string;
  name: string;
  command: string;
  args: string[];
  authId: string | null;
  models: Array<{ id: string; name: string; default?: boolean }>;
  notes: string;
  installed: boolean;
}

/** Built-in ACP engine presets (W9: GitHub Copilot CLI, OpenCode) + detection. */
export const listAcpEngines = (): Promise<{ ok: boolean; engines: AcpEngineDto[] }> =>
  apiJson('/api/acp/engines');

export const createAcpSession = (input: { command?: string; args?: string[]; label?: string; engine?: string }): Promise<{ ok: boolean; session: AcpSessionDto }> =>
  apiJson('/api/acp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

export const getAcpSession = (id: string): Promise<{ ok: boolean; session: AcpSessionDto; transcript: AcpTranscriptEventDto[] }> =>
  apiJson(`/api/acp/${encodeURIComponent(id)}`);

export const resumeAcpSession = (id: string): Promise<{ ok: boolean; session: AcpSessionDto }> =>
  apiJson(`/api/acp/${encodeURIComponent(id)}/resume`, { method: 'POST' });

export const cancelAcpPrompt = (id: string): Promise<{ ok: boolean; cancelled: boolean }> =>
  apiJson(`/api/acp/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

export const closeAcpSession = (id: string): Promise<{ ok: boolean }> =>
  apiJson(`/api/acp/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Stream an ACP prompt as SSE. Returns an unsubscribe function.
 * Fetch + reader pattern (EventSource can't send the Authorization header).
 */
export function streamAcpPrompt(
  sessionId: string,
  text: string,
  onEvent: (e: AcpPromptStreamEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const controller = new AbortController();
  let buffer = '';
  const dispatch = (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as AcpPromptStreamEvent);
        } catch {
          // ignore malformed frame
        }
      }
    }
  };
  (async () => {
    try {
      const res = await authedFetch(`/api/acp/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`ACP prompt failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        dispatch(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return () => controller.abort();
}

// ---- Chat polish: pins, text assist (OpenMausBot §1.1/§1.2/§2.6) -----------

export interface PinnedChatMessage {
  threadId: string;
  messageId: string;
  text?: string;
  role?: string;
  pinnedAt: number;
  pinnedBy: string;
}

export const listPinnedMessages = (threadId: string): Promise<{ ok: boolean; pins: PinnedChatMessage[] }> =>
  apiJson(`/api/chat-ux/threads/${encodeURIComponent(threadId)}/pins`);

export const pinChatMessage = (
  threadId: string, messageId: string | number, opts?: { text?: string; role?: string },
): Promise<{ ok: boolean; pin: PinnedChatMessage }> =>
  apiJson(`/api/chat-ux/threads/${encodeURIComponent(threadId)}/pins`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: String(messageId), ...(opts ?? {}) }),
  });

export const unpinChatMessage = (threadId: string, messageId: string | number): Promise<{ ok: boolean }> =>
  apiJson(`/api/chat-ux/threads/${encodeURIComponent(threadId)}/pins/${encodeURIComponent(String(messageId))}`, { method: 'DELETE' });

/** POST /api/text-assist/polish — polish composer draft text (cheap model). */
export const polishComposerText = (text: string): Promise<{ ok: boolean; text: string; changed: boolean }> =>
  apiJson('/api/text-assist/polish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });

/** POST /api/text-assist/skill — composer insertion text for a skill. */
export const skillInsertionText = (skillId: string): Promise<{ ok: boolean; skillId: string; text: string }> =>
  apiJson('/api/text-assist/skill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skillId }),
  });

/** PUT /api/bots/:id/avatar — set (data URL) or clear (null) a bot picture. */
export const setBotAvatar = (
  botId: string, avatar: string | null,
): Promise<{ ok: boolean; botId: string; avatarUrl: string | null }> =>
  apiJson(`/api/bots/${encodeURIComponent(botId)}/avatar`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar }),
  });
