// SPDX-License-Identifier: Apache-2.0
// HTTP + SSE client for the KriyaDot API (apps/api), purpose-built for the
// headless CLI. Mirrors the TUI's client surface: POST /api/chat streams
// `data: {...}\n\n` SSE events; everything else is plain JSON.
import { randomUUID } from 'node:crypto';

export interface BotSummary {
  id: string;
  name: string;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface ModelInfo {
  providerId: string;
  id: string;
  name: string;
  free?: boolean;
  [key: string]: unknown;
}

export interface ThreadSummary {
  id: string;
  botId: string;
  title: string | null;
  createdAt: string;
  messageCount: number;
  lastMessageTs: string | null;
}

export interface ThreadMessage {
  id: number;
  role: string;
  content: string;
}

export interface RoutineSummary {
  id: string;
  name: string;
  botId: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface RoutineRunSummary {
  id: string;
  routineId: string;
  status: string;
  startedAt?: number;
  finishedAt?: number;
  [key: string]: unknown;
}

export interface McpServerInfo {
  id: string;
  label?: string;
  enabled?: boolean;
  health?: { status?: string; lastError?: string };
  [key: string]: unknown;
}

export interface PauseState {
  ok?: boolean;
  paused: boolean;
  pausedAt?: number | null;
  pausedBy?: string | null;
  reason?: string | null;
  resumedAt?: number | null;
  resumedBy?: string | null;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  [key: string]: unknown;
}

export type ChatEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; name: string; approvalRequired: boolean }
  | { type: 'tool_result'; name: string; denied?: boolean }
  | { type: 'approval_required'; approvalId: string; name: string }
  | { type: 'done'; usage?: TokenUsage }
  | { type: 'spend_cap_reached'; message: string }
  | { type: 'error'; message: string }
  | { type: 'interrupted'; reason: string }
  | { type: 'notice'; kind: string; message: string }
  | { type: 'unknown'; raw: unknown };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Parse one raw SSE `data:` payload into a ChatEvent (never throws). */
export function parseChatEvent(data: string): ChatEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { type: 'unknown', raw: data };
  }
  if (typeof raw !== 'object' || raw === null) return { type: 'unknown', raw };
  const ev = raw as { type?: string; [k: string]: unknown };
  const call = ev.call as { name?: unknown } | undefined;
  const name = typeof call?.name === 'string' ? call.name : 'tool';
  switch (ev.type) {
    case 'token':
      return { type: 'token', content: typeof ev.content === 'string' ? ev.content : '' };
    case 'tool_call':
      return { type: 'tool_call', name, approvalRequired: ev.approvalRequired === true };
    case 'tool_result':
      return { type: 'tool_result', name, denied: ev.denied === true };
    case 'approval_required':
      return { type: 'approval_required', approvalId: String(ev.approvalId ?? ''), name };
    case 'done':
      return { type: 'done', usage: ev.usage as TokenUsage | undefined };
    case 'spend_cap_reached':
      // Spend-cap / usage-limit hard stop (resumable — see exits.ts, 75).
      // The API emits this right before the terminal 'error' event.
      return {
        type: 'spend_cap_reached',
        message: typeof ev.message === 'string' ? ev.message : 'Spend cap reached',
      };
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
    default:
      return { type: 'unknown', raw };
  }
}

export interface ChatRequest {
  botId: string;
  message: string;
  sessionId?: string;
  model?: string;
  providerId?: string;
  autoApprove?: boolean;
}

export interface ChatCallbacks {
  onEvent: (ev: ChatEvent) => void;
}

export class KriyaDotApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/api${path.startsWith('/') ? path : `/${path}`}`;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), { ...init, headers: { ...this.authHeaders(), ...init?.headers } });
    } catch (err) {
      throw new Error(
        `Cannot reach KriyaDot API at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        if (typeof body?.error === 'string') detail = body.error;
        else if (typeof body?.message === 'string') detail = body.message;
      } catch {
        // ignore — keep statusText
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

  listModels(): Promise<ModelInfo[]> {
    return this.request<ModelInfo[]>('/models');
  }

  listThreads(opts: { botId?: string; limit?: number } = {}): Promise<ThreadSummary[]> {
    const params = new URLSearchParams();
    if (opts.botId) params.set('botId', opts.botId);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const q = params.toString();
    return this.request<{ ok: boolean; threads: ThreadSummary[] }>(`/chat/threads${q ? `?${q}` : ''}`).then(
      (r) => r.threads,
    );
  }

  threadMessages(threadId: string): Promise<ThreadMessage[]> {
    return this.request<{ ok: boolean; messages: ThreadMessage[] }>(
      `/chat/threads/${encodeURIComponent(threadId)}/messages`,
    ).then((r) => r.messages);
  }

  branchThread(
    threadId: string,
    opts: { fromMessageId: number; title?: string },
  ): Promise<{ id: string; title: string; botId: string }> {
    return this.request<{ ok: boolean; thread: { id: string; title: string; botId: string } }>(
      `/chat/threads/${encodeURIComponent(threadId)}/branch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromMessageId: opts.fromMessageId, ...(opts.title ? { title: opts.title } : {}) }),
      },
    ).then((r) => r.thread);
  }

  /** Delete a chat thread (W1). */
  deleteThread(threadId: string): Promise<void> {
    return this.request<{ ok: boolean }>(`/chat/threads/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
    }).then(() => undefined);
  }

  /** List runs for a routine (W1). */
  listRoutineRuns(routineId: string, limit = 20): Promise<RoutineRunSummary[]> {
    return this.request<{ ok: boolean; runs: RoutineRunSummary[] }>(
      `/routines/${encodeURIComponent(routineId)}/runs?limit=${limit}`,
    ).then((r) => r.runs);
  }

  /** Import a team from a markdown doc (G1). */
  importTeamMarkdown(markdown: string): Promise<{ id: string; name: string }> {
    return this.request<{ ok: boolean; team: { id: string; name: string } }>('/teams/import-markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown }),
    }).then((r) => r.team);
  }

  /** Export a team as markdown (G1). */
  exportTeamMarkdown(teamId: string): Promise<string> {
    return this.request<{ ok: boolean; markdown: string }>(
      `/teams/${encodeURIComponent(teamId)}/export-markdown`,
    ).then((r) => r.markdown);
  }

  /** Apply a kriyadot.team.json manifest (G5). */
  importTeamManifest(manifest: unknown): Promise<{ id: string; name: string }> {
    return this.request<{ ok: boolean; team: { id: string; name: string } }>('/teams/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest }),
    }).then((r) => r.team);
  }

  listRoutines(): Promise<RoutineSummary[]> {
    return this.request<{ ok: boolean; routines: RoutineSummary[] }>('/routines').then((r) => r.routines);
  }

  runRoutineNow(routineId: string): Promise<string> {
    return this.request<{ ok: boolean; runId: string }>(`/routines/${encodeURIComponent(routineId)}/run-now`, {
      method: 'POST',
    }).then((r) => r.runId);
  }

  listMcpServers(): Promise<McpServerInfo[]> {
    return this.request<McpServerInfo[]>('/mcp/servers');
  }

  /** Global pause state (W14d): mirrors GET /api/system/pause-state. */
  getPauseState(): Promise<PauseState> {
    return this.request<PauseState>('/system/pause-state');
  }

  /** Pause all new KriyaDot work: POST /api/system/pause. */
  pauseSystem(): Promise<PauseState> {
    return this.request<PauseState>('/system/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'cli' }),
    });
  }

  /** Resume after a global pause: POST /api/system/resume. */
  resumeSystem(): Promise<PauseState> {
    return this.request<PauseState>('/system/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'cli' }),
    });
  }

  async decideApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void> {
    await this.request(`/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
  }

  /**
   * POST /api/chat and stream SSE events through the callback. Resolves when
   * the stream ends; rejects on network failure. The caller aborts via the
   * returned controller to cancel a turn.
   */
  async sendChat(req: ChatRequest, cb: ChatCallbacks): Promise<AbortController> {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(this.url('/chat'), {
          method: 'POST',
          headers: { ...this.authHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            botId: req.botId,
            message: req.message,
            sessionId: req.sessionId ?? randomUUID(),
            ...(req.model ? { model: req.model } : {}),
            ...(req.providerId ? { providerId: req.providerId } : {}),
            ...(req.autoApprove ? { autoApprove: true } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          let detail = res.statusText;
          try {
            const body = (await res.json()) as { error?: string };
            if (typeof body?.error === 'string') detail = body.error;
          } catch {
            // ignore
          }
          throw new ApiError(`API ${res.status}: ${detail}`, res.status);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
              const t = line.trim();
              if (t.startsWith('data:')) cb.onEvent(parseChatEvent(t.slice(5).trim()));
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        cb.onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return controller;
  }
}
