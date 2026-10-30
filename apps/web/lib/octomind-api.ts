// SPDX-License-Identifier: Apache-2.0
/**
 * API client for the Octomind-parity web surfaces. Every call degrades
 * gracefully: endpoints being built by the API workstream may be absent
 * (404) — callers get a typed error with `status` so panels can show an
 * honest "endpoint not available yet" state instead of crashing.
 *
 * Shapes (reconciled with the API workstream's landed modules):
 *  - Chat commands: POST /api/sessions/:id/commands {command: "/info …"}
 *      → { ok, handled, command, reply, data? }
 *    (apps/api/src/session-commands-routes.ts; /role and /skill are not
 *    in that service's KNOWN set, so those commands surface its honest
 *    400 until a role/skill dispatch lands.)
 *    Fallbacks used where a pre-existing endpoint already serves the data
 *    (/api/sessions/:id/context, /api/sessions/:id/share, /api/status).
 *  - Human accounting: GET /api/human-accounting?sessionId=… (new) with
 *    fallback to the existing GET /api/accounting/human (global/by-bot).
 *  - Discovery: POST /api/discovery/search {query} → {results:[{kind,…}]}
 *    or grouped {bots, skills, capabilities, mcp}.
 *  - Workflows (apps/api/src/workflow-surface-routes.ts):
 *      POST /api/workflows/import {content, format} → { workflow, … };
 *      GET /api/workflows/:id/export?format=json|toml → { format, content };
 *      POST /api/workflows/:id/dry-run {} → { plan, spawned: false } and
 *      POST /api/workflows/dry-run {definition} for unregistered defs.
 *  - Bot layers: PUT /api/bots/:id/layers {layers} (per-field bot settings
 *    pattern, like /persona, /model, /voice). No generic bot-update
 *    endpoint exists today, so there is no second fallback — a 404 is
 *    reported verbatim to the editor.
 *  - Cloud: /api/cloud/lightning/{connect,status,disconnect,deploy,usage,plans}
 *    per apps/api/src/cloud-routes.ts (mounted under /api).
 */
import { authedFetch, getChatThreadMessages, shareSession } from './api';

export class OctoApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function octoJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new OctoApiError(res.status, `API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const isAbsent = (err: unknown): boolean =>
  err instanceof OctoApiError && (err.status === 404 || err.status === 501);

// ---- Chat commands ---------------------------------------------------------

export interface ChatCommandResponse {
  ok?: boolean;
  handled?: boolean;
  command?: string;
  /** Human one-liner from the session-command service. */
  reply?: string;
  /** Structured payload from the session-command service. */
  data?: unknown;
  result?: unknown;
  payload?: unknown;
  text?: string;
  [key: string]: unknown;
}

/** Run a built-in chat command: POST /api/sessions/:id/commands {command:"/name args"}. */
export function runChatCommand(input: {
  sessionId: string;
  botId?: string;
  command: string;
  args?: string;
}): Promise<ChatCommandResponse> {
  const text = `/${input.command}${input.args ? ` ${input.args}` : ''}`;
  const q = input.botId ? `?botId=${encodeURIComponent(input.botId)}` : '';
  return octoJson(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/commands${q}`,
    jsonInit('POST', { command: text, text }),
  );
}

/** GET /api/sessions/:id/context — the pre-existing context inspector. */
export function getSessionContext(sessionId: string): Promise<Record<string, unknown>> {
  return octoJson(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
}

/**
 * GET /api/sessions/:id/analyze — local session viewer payload.
 * Real shape: { ok, handled, command:'analyze', reply, data: { sessionId,
 * botId, localOnly, uploaded:false, summary, context, transcript[] } }.
 */
export function getSessionAnalyze(sessionId: string): Promise<Record<string, unknown>> {
  return octoJson(`/api/sessions/${encodeURIComponent(sessionId)}/analyze`);
}

export interface SessionAnalyzeFallback {
  source: 'analyze-endpoint' | 'local-fallback';
  context: Record<string, unknown> | null;
  messages: Array<{ id: number; role: string; content: string; ts: string }>;
}

/**
 * /analyze viewer data (#170): prefer the new endpoint; fall back to the
 * pre-existing local context + thread-messages endpoints. All local API —
 * nothing is uploaded anywhere.
 */
export async function loadSessionAnalyze(sessionId: string): Promise<SessionAnalyzeFallback & { payload?: Record<string, unknown> }> {
  try {
    const raw = await getSessionAnalyze(sessionId);
    const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
    const transcript = Array.isArray(data.transcript) ? data.transcript : [];
    const messages = transcript
      .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
      .map((m) => ({
        id: typeof m.id === 'number' ? m.id : 0,
        role: typeof m.role === 'string' ? m.role : 'message',
        content: typeof m.content === 'string' ? m.content : '',
        ts: typeof m.ts === 'string' ? m.ts : '',
      }));
    const { transcript: _t, ...rest } = data;
    return { source: 'analyze-endpoint', payload: rest, context: (data.context as Record<string, unknown>) ?? rest, messages };
  } catch (err) {
    if (!isAbsent(err)) throw err;
  }
  const [context, thread] = await Promise.all([
    getSessionContext(sessionId).catch(() => null),
    getChatThreadMessages(sessionId).catch(() => null),
  ]);
  return { source: 'local-fallback', context, messages: thread?.messages ?? [] };
}

export { shareSession };

/** Unified /status (#178): workflow runs + jobs + monitors + shell jobs. */
export function getUnifiedStatus(): Promise<Record<string, unknown>> {
  return octoJson('/api/status');
}

// ---- Human accounting (#47) -------------------------------------------------

export async function getHumanAccounting(sessionId?: string): Promise<Record<string, unknown>> {
  const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  try {
    return await octoJson<Record<string, unknown>>(`/api/human-accounting${q}`);
  } catch (err) {
    if (!isAbsent(err)) throw err;
    // Existing global/by-bot endpoint (apps/api/src/human-accounting.ts).
    return octoJson<Record<string, unknown>>('/api/accounting/human');
  }
}

// ---- Discovery (#166) --------------------------------------------------------

export function discoverySearch(query: string): Promise<unknown> {
  // Real shape (discovery-routes.ts): { intent, kinds?, topK?, minScore? }.
  // query/q are sent too so either spelling works against other builds.
  return octoJson('/api/discovery/search', jsonInit('POST', { intent: query, query, q: query }));
}

// ---- Workflows: import / export / dry-run (#143/#151) ------------------------

export function importWorkflowFile(input: {
  format: 'json' | 'toml';
  content: string;
  filename?: string;
}): Promise<{ ok?: boolean; workflow?: Record<string, unknown>; [key: string]: unknown }> {
  // Real shape (workflow-surface-routes.ts): POST /api/workflows/import {content, format}.
  return octoJson('/api/workflows/import', jsonInit('POST', { content: input.content, format: input.format }));
}

/** Export one workflow as a kriyadot.workflow file; returns the file text. */
export async function exportWorkflowFile(id: string, format: 'json' | 'toml'): Promise<string> {
  const res = await authedFetch(
    `/api/workflows/${encodeURIComponent(id)}/export?format=${format}`,
  );
  if (!res.ok) throw new OctoApiError(res.status, `API ${res.status}: export failed`);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = (await res.json()) as { content?: string; workflow?: unknown };
    if (typeof body.content === 'string') return body.content;
    return JSON.stringify(body.workflow ?? body, null, 2);
  }
  return res.text();
}

export function dryRunWorkflowById(id: string): Promise<unknown> {
  return octoJson(`/api/workflows/${encodeURIComponent(id)}/dry-run`, jsonInit('POST', {}));
}

export function dryRunWorkflowDefinition(definition: unknown): Promise<unknown> {
  return octoJson('/api/workflows/dry-run', jsonInit('POST', { definition }));
}

// ---- Bot layers (#41) --------------------------------------------------------

export interface LayerStage {
  name: string;
  kind: 'prepare' | 'review' | string;
  prompt?: string;
  /** Role for this stage (new in the parity build; older stages omit it). */
  role?: string;
  model?: string;
  providerId?: string;
  inputMode?: 'user' | 'draft' | 'user+draft' | string;
  /** Output mode (new: stages previously had output fixed by kind). */
  outputMode?: string;
}

/**
 * Save BotConfig.layers via the per-field bot-settings pattern
 * (PUT /api/bots/:id/layers {layers}). Returns which route accepted it so
 * the editor can report the truth. Throws the last error when no route
 * accepts layers yet (the API currently drops unknown fields elsewhere —
 * there is no generic bot-update endpoint to fall back to).
 */
export async function setBotLayers(
  botId: string,
  layers: LayerStage[],
): Promise<{ ok: boolean; via: string; layers?: LayerStage[] }> {
  const res = await octoJson<{ ok?: boolean; layers?: LayerStage[] }>(
    `/api/bots/${encodeURIComponent(botId)}/layers`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layers }) },
  );
  return { ok: res.ok !== false, via: 'PUT /api/bots/:id/layers', ...(res.layers ? { layers: res.layers } : {}) };
}

// ---- Cloud (Lightning) --------------------------------------------------------

export const cloudConnect = (userId: string, apiKey: string): Promise<Record<string, unknown>> =>
  octoJson('/api/cloud/lightning/connect', jsonInit('POST', { userId, apiKey }));

export const cloudStatus = (): Promise<Record<string, unknown>> =>
  octoJson('/api/cloud/lightning/status');

export const cloudDisconnect = (): Promise<Record<string, unknown>> =>
  octoJson('/api/cloud/lightning/disconnect', { method: 'POST' });

export const cloudDeploy = (body: { repoUrl?: string; ollama?: unknown } = {}): Promise<Record<string, unknown>> =>
  octoJson('/api/cloud/lightning/deploy', jsonInit('POST', body));

export const cloudStudio = (action: 'ensure' | 'start' | 'stop'): Promise<Record<string, unknown>> =>
  octoJson(`/api/cloud/lightning/studio/${action}`, { method: 'POST' });

export const cloudUsage = (): Promise<Record<string, unknown>> =>
  octoJson('/api/cloud/lightning/usage');

export const cloudPlans = (): Promise<Record<string, unknown>> =>
  octoJson('/api/cloud/lightning/plans');
