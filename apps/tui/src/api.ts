// SPDX-License-Identifier: Apache-2.0
// HTTP + SSE client for the KriyaDot API (apps/api). Mirrors what the web
// client uses: POST /chat with `data: {...}\n\n` SSE events.
import { readFileSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';

/** Filename the API writes its per-boot loopback bearer token to (apps/api/src/loopback-auth.ts). */
export const LOOPBACK_TOKEN_FILENAME = '.api-token';

/**
 * Resolve the API's data dir the same way apps/api's loadConfig() does:
 * DATA_DIR env (KRIYADOT_DATA_DIR accepted as an alias), else ./data under
 * the current working directory.
 */
export function resolveApiDataDir(): string {
  const fromEnv = process.env.KRIYADOT_DATA_DIR ?? process.env.DATA_DIR;
  return fromEnv ? resolvePath(fromEnv) : resolvePath(process.cwd(), 'data');
}

/** Thrown when the loopback API token file can't be read. */
export class LoopbackTokenError extends Error {
  constructor(dataDir: string) {
    super(
      `API token not found — is the KriyaDot API running? (looked for ${joinPath(dataDir, LOOPBACK_TOKEN_FILENAME)})`,
    );
    this.name = 'LoopbackTokenError';
  }
}

/**
 * Read the per-boot bearer token the API writes to <dataDir>/.api-token.
 * Throws LoopbackTokenError when the file is missing or unreadable.
 */
export function readLoopbackToken(dataDir: string = resolveApiDataDir()): string {
  let raw: string;
  try {
    raw = readFileSync(joinPath(dataDir, LOOPBACK_TOKEN_FILENAME), 'utf8');
  } catch {
    throw new LoopbackTokenError(dataDir);
  }
  const token = raw.trim();
  if (!token) throw new LoopbackTokenError(dataDir);
  return token;
}
export interface BotSummary {
  id: string;
  name: string;
  model?: string;
  provider?: string;
  workspacePath?: string;
  [key: string]: unknown;
}

export interface ModelInfo {
  providerId: string;
  id: string;
  name: string;
  free: boolean;
  [key: string]: unknown;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  status: string;
  createdAt: number;
  healthScore?: number;
  [key: string]: unknown;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  createdAt: number;
  toolName?: string;
  [key: string]: unknown;
}

export type ChatEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; call: { name: string; [k: string]: unknown }; approvalRequired: boolean }
  | { type: 'tool_result'; call: { name: string; [k: string]: unknown }; denied?: boolean }
  | { type: 'approval_required'; approvalId: string; call: { name: string; arguments?: unknown; [k: string]: unknown } }
  | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number; [k: string]: unknown } }
  | { type: 'error'; message: string }
  | { type: 'interrupted'; reason: string }
  | { type: 'notice'; kind: string; message: string }
  | { type: 'thinking'; content: string }
  | { type: 'queued_turn_start'; queueId: string; message: string }
  | { type: 'unknown'; raw: unknown };

/** CA-4 checkpoint wire shape (mirrors apps/api Checkpoint). */
export interface CheckpointInfo {
  id: string;
  sessionId: string;
  createdAt: number;
  files: Record<string, string | null>;
  historyLength: number;
  label: string;
}

/** CA-30 session-diff wire shape (checkpoints-routes GET /sessions/:id/diff). */
export interface SessionDiffResult {
  ok: boolean;
  sessionId: string;
  checkpointCount: number;
  files: Array<{ path: string; status: string; added: number; removed: number; touches: number }>;
  totals: { added: number; removed: number };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Parse the raw SSE `data:` payload into a ChatEvent (never throws). */
export function parseChatEvent(data: string): ChatEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { type: 'unknown', raw: data };
  }
  if (typeof raw !== 'object' || raw === null) return { type: 'unknown', raw };
  const ev = raw as { type?: string; [k: string]: unknown };
  switch (ev.type) {
    case 'token':
      return { type: 'token', content: typeof ev.content === 'string' ? ev.content : '' };
    case 'tool_call':
      return {
        type: 'tool_call',
        call: (ev.call ?? { name: 'tool' }) as { name: string; [k: string]: unknown },
        approvalRequired: ev.approvalRequired === true,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        call: (ev.call ?? { name: 'tool' }) as { name: string; [k: string]: unknown },
        denied: ev.denied === true,
      };
    case 'approval_required':
      return {
        type: 'approval_required',
        approvalId: String(ev.approvalId ?? ''),
        call: (ev.call ?? { name: 'tool' }) as { name: string; arguments?: unknown; [k: string]: unknown },
      };
    case 'done':
      return { type: 'done', usage: ev.usage as { inputTokens?: number; outputTokens?: number; [k: string]: unknown } | undefined };
    case 'error':
      return { type: 'error', message: typeof ev.message === 'string' ? ev.message : 'Unknown error' };
    case 'interrupted':
      return { type: 'interrupted', reason: typeof ev.reason === 'string' ? ev.reason : '' };
    case 'notice':
      return {
        type: 'notice',
        kind: typeof ev.kind === 'string' ? ev.kind : 'info',
        message: typeof ev.message === 'string' ? ev.message : '',
      };
    case 'thinking':
    case 'reasoning':
      // Reasoning/thinking stream (#186): some providers emit these as
      // separate deltas; content may arrive as `content` or `delta`.
      return {
        type: 'thinking',
        content:
          typeof ev.content === 'string' ? ev.content : typeof ev.delta === 'string' ? ev.delta : '',
      };
    case 'queued_turn_start':
      return {
        type: 'queued_turn_start',
        queueId: typeof ev.queueId === 'string' ? ev.queueId : '',
        message: typeof ev.message === 'string' ? ev.message : '',
      };
    default:
      return { type: 'unknown', raw };
  }
}

export interface ChatCallbacks {
  onEvent: (ev: ChatEvent) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export class KriyaDotApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/api${path.startsWith('/') ? path : `/${path}`}`;
  }

  /** Authorization header for the loopback bearer token (empty when no token — e.g. /health probe). */
  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        ...init,
        headers: { ...this.authHeaders(), ...init?.headers },
      });
    } catch (err) {
      throw new Error(`Cannot reach KriyaDot API at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) detail = body.error.message;
      } catch {
        // ignore
      }
      throw new ApiError(`API ${res.status}: ${detail}`, res.status);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    try {
      const h = await this.request<{ ok: boolean }>('/health');
      return h.ok === true;
    } catch {
      return false;
    }
  }

  listBots(): Promise<BotSummary[]> {
    return this.request<BotSummary[]>('/bots');
  }

  listModels(freeOnly = false): Promise<ModelInfo[]> {
    return this.request<ModelInfo[]>(`/models${freeOnly ? '?freeOnly=1' : ''}`);
  }

  async setBotModel(botId: string, model: string): Promise<void> {
    await this.request(`/bots/${encodeURIComponent(botId)}/model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  }

  listWorkflows(): Promise<WorkflowSummary[]> {
    return this.request<WorkflowSummary[]>('/workflows');
  }

  listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
    return this.request<WorkflowRunSummary[]>('/workflows/runs');
  }

  listAudit(limit = 30): Promise<AuditEntry[]> {
    return this.request<AuditEntry[]>(`/audit?limit=${limit}`);
  }

  async getBotMemory(botId: string): Promise<string> {
    const r = await this.request<{ content?: string }>(`/bots/${encodeURIComponent(botId)}/memory`);
    return r.content ?? '';
  }

  // -- Checkpoints (CA-4) + session diff (CA-30) --------------------------
  async listCheckpoints(sessionId: string): Promise<CheckpointInfo[]> {
    const r = await this.request<{ ok: boolean; checkpoints: CheckpointInfo[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
    );
    return r.checkpoints;
  }

  async restoreCheckpoint(id: string, mode: 'code' | 'conversation' | 'both'): Promise<{ ok: boolean; restoredFiles: string[]; messagesRemoved: number }> {
    return this.request(`/checkpoints/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  async sessionDiff(sessionId: string): Promise<SessionDiffResult> {
    return this.request<SessionDiffResult>(`/sessions/${encodeURIComponent(sessionId)}/diff`);
  }

  async decideApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void> {
    await this.request(`/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
  }

  /**
   * POST /chat and stream SSE events. Resolves when the server closes the
   * stream; rejects on network failure. Caller aborts via the returned
   * controller to cancel a turn.
   */
  async sendChat(
    opts: { botId: string; message: string; sessionId?: string; model?: string },
    cb: ChatCallbacks,
  ): Promise<AbortController> {
    const controller = new AbortController();
    (async () => {
      let res: Response;
      try {
        res = await fetch(this.url('/chat'), {
          method: 'POST',
          headers: { ...this.authHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            botId: opts.botId,
            message: opts.message,
            sessionId: opts.sessionId,
            model: opts.model,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          cb.onDone();
          return;
        }
        cb.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!res.ok || !res.body) {
        cb.onError(new ApiError(`Chat failed: ${res.status} ${res.statusText}`, res.status));
        return;
      }
      try {
        await pumpSse(res.body, cb.onEvent);
        cb.onDone();
      } catch (err) {
        if (controller.signal.aborted) {
          cb.onDone();
          return;
        }
        cb.onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return controller;
  }
}

/** Read an SSE byte stream and invoke onEvent for each `data:` frame. */
export async function pumpSse(body: ReadableStream<Uint8Array>, onEvent: (ev: ChatEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          onEvent(parseChatEvent(payload));
        }
        // Heartbeat comments (lines starting with ':') are ignored.
      }
    }
  }
  // Trailing partial frame.
  const rest = buffer.trim();
  if (rest.startsWith('data:')) {
    const payload = rest.slice(5).trim();
    if (payload && payload !== '[DONE]') onEvent(parseChatEvent(payload));
  }
}
