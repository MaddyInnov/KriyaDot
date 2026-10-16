// SPDX-License-Identifier: Apache-2.0
// Client helpers for the Laya-inspired Activity surfaces: Spaces, Daily
// Briefing, Omni summary, cost breakdown, and MCP tool scopes.
//
// Defensive by design: sibling agents are still building these endpoints.
// Every reader that the UI calls goes through `optionalJson`, which returns
// `null` when the endpoint is missing (404) or unreachable — panels render
// an EmptyState in that case instead of an error.
//
// The active space id is persisted in localStorage under `kriyadot:space` and
// sent on every request as the `X-KriyaDot-Space` header via `kriyadotFetch`.

'use client';

import { getApiBase } from './api';

export const SPACE_STORAGE_KEY = 'kriyadot:space';
export const SPACE_HEADER = 'X-KriyaDot-Space';

// ---- Active-space persistence ------------------------------------------------

/** Pure: build a headers record carrying X-KriyaDot-Space (testable, no DOM). */
export function spaceHeaders(
  spaceId: string | null,
  extra?: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (spaceId) h[SPACE_HEADER] = spaceId;
  return h;
}

export function getActiveSpaceId(): string | null {
  try {
    return localStorage.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveSpaceId(id: string | null): void {
  try {
    if (id) localStorage.setItem(SPACE_STORAGE_KEY, id);
    else localStorage.removeItem(SPACE_STORAGE_KEY);
  } catch {
    // ignore (private mode etc.)
  }
}

// ---- Fetch wrapper ------------------------------------------------------------

export class EndpointMissingError extends Error {
  constructor(public readonly path: string) {
    super(`Endpoint not available: ${path}`);
    this.name = 'EndpointMissingError';
  }
}

function withSpaceHeader(init?: RequestInit): RequestInit {
  const spaceId = getActiveSpaceId();
  const headers = spaceHeaders(spaceId, {
    ...(init?.headers as Record<string, string> | undefined),
  });
  return { ...init, headers };
}

/** fetch that always carries the active-space header (when a space is set). */
export async function kriyadotFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getApiBase()}${path}`, withSpaceHeader(init));
}

async function kriyadotJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, init);
  if (!res.ok) {
    if (res.status === 404) throw new EndpointMissingError(path);
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Defensive reader for not-yet-built endpoints: returns `null` when the
 * endpoint is missing (404) or the network fails. Callers show an empty
 * state in that case, never an error box.
 */
export async function optionalJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return await kriyadotJson<T>(path, init);
  } catch (err) {
    if (err instanceof EndpointMissingError) return null;
    if (err instanceof TypeError) return null; // network unreachable
    throw err;
  }
}

// ---- Spaces -------------------------------------------------------------------

export interface Space {
  id: string;
  name: string;
  modelOverride?: string | null;
  workspaceOverride?: string | null;
  paused?: boolean;
}

export const listSpaces = (): Promise<Space[]> => kriyadotJson('/api/spaces');

export function createSpace(name: string): Promise<Space> {
  return kriyadotJson('/api/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function patchSpace(
  id: string,
  patch: Partial<Pick<Space, 'name' | 'modelOverride' | 'workspaceOverride' | 'paused'>>,
): Promise<Space> {
  return kriyadotJson(`/api/spaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function deleteSpace(id: string): Promise<{ ok: boolean }> {
  return kriyadotJson(`/api/spaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- Daily briefing -------------------------------------------------------------

export interface BriefingItem {
  id?: string;
  title: string;
  detail?: string;
  ts?: number;
  kind?: string;
}

export interface Briefing {
  generatedAt: number;
  overnight: BriefingItem[];
  calendar: BriefingItem[];
  approvals: BriefingItem[];
  /**
   * Notes changed since the previous briefing (feature interconnection).
   * Optional so the panel keeps working against briefing backends that do
   * not emit it yet.
   */
  notes?: BriefingItem[];
  /** Recent workflow runs (feature interconnection). Same optional rule. */
  workflows?: BriefingItem[];
  summary?: string;
  /**
   * Health regression alerts (feature #5). Optional so the panel keeps
   * working against briefing backends that do not emit it yet — the panel
   * also falls back to GET /api/health/regressions directly.
   */
  regressions?: RegressionAlert[];
}

export const getBriefing = (): Promise<Briefing | null> => optionalJson('/api/briefing');

// ---- Run health: regression alerts ----------------------------------------------

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

export const getRegressions = (): Promise<RegressionsPayload | null> =>
  optionalJson('/api/health/regressions');

// ---- Omni rolling summary --------------------------------------------------------

export interface OmniSummary {
  attention: BriefingItem[];
  recent: BriefingItem[];
  period: BriefingItem[];
  milestones: BriefingItem[];
  pins: BriefingItem[];
  versions: Array<{ id: string; createdAt: number; label?: string }>;
}

export const getOmniSummary = (versionId?: string): Promise<OmniSummary | null> =>
  optionalJson(`/api/summary/omni${versionId ? `?version=${encodeURIComponent(versionId)}` : ''}`);

// ---- Cost breakdown ----------------------------------------------------------------

export interface FeatureCost {
  feature: string;
  tokens: number;
  cost: number;
}

export interface StepCost {
  step: string;
  tokens: number;
  cost: number;
}

export interface CostCap {
  feature: string;
  cap: number;
  used: number;
  exceeded: boolean;
}

export interface UsageBreakdown {
  byFeature: FeatureCost[];
  byStep: StepCost[];
  caps: CostCap[];
}

export const getUsageBreakdown = async (
  period: 'week' | 'month' = 'month',
): Promise<UsageBreakdown | null> => {
  const b = await optionalJson<{ byFeature?: FeatureCost[]; byStep?: StepCost[] }>(
    `/api/billing/usage/breakdown?period=${period}`,
  );
  if (b === null) return null;
  // Caps live on a separate endpoint and are reported in USD cents.
  const rawCaps = await optionalJson<
    { feature: string; capCents: number | null; spentCents: number; capExceeded: boolean }[]
  >('/api/billing/usage/caps');
  const caps: CostCap[] = (Array.isArray(rawCaps) ? rawCaps : [])
    .filter((c) => c.capCents !== null)
    .map((c) => ({
      feature: c.feature,
      cap: (c.capCents ?? 0) / 100,
      used: c.spentCents / 100,
      exceeded: c.capExceeded,
    }));
  return { byFeature: b.byFeature ?? [], byStep: b.byStep ?? [], caps };
};

// ---- MCP tool scopes -----------------------------------------------------------------

export interface McpToolScopes {
  read: boolean;
  write: boolean;
  egress: boolean;
}

export interface McpTool {
  id: string;
  name: string;
  scopes: McpToolScopes;
}

export const getMcpTools = (): Promise<McpTool[] | null> => optionalJson('/api/mcp/tools');

export function patchMcpToolScopes(
  id: string,
  scopes: McpToolScopes,
): Promise<McpTool> {
  return kriyadotJson(`/api/mcp/tools/${encodeURIComponent(id)}/scopes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scopes),
  });
}

// ---- MCP OAuth (connector sign-in) --------------------------------------------------

export interface McpOAuthServerStatus {
  server: string;
  url?: string;
  oauth: boolean;
  connected: boolean;
  expiresAt?: number;
  hasRefreshToken: boolean;
}

export interface McpOAuthProbe {
  ok: boolean;
  server?: string;
  url: string;
  requiresOAuth: boolean;
  signedOut: boolean;
  connected: boolean;
  authorizationServers?: string[];
  scopesSupported?: string[];
  detail: string;
}

export const getMcpOAuthStatus = (): Promise<{ ok: boolean; servers: McpOAuthServerStatus[] }> =>
  kriyadotJson('/api/mcp/oauth/status');

export const startMcpOAuth = (
  server: string,
  opts?: { scope?: string; display?: string },
): Promise<{ ok: boolean; server: string; authUrl: string; state: string }> => {
  const q = new URLSearchParams({ server });
  if (opts?.scope) q.set('scope', opts.scope);
  if (opts?.display) q.set('display', opts.display);
  return kriyadotJson(`/api/mcp/oauth/start?${q.toString()}`);
};

export const probeMcpOAuth = (server: string): Promise<McpOAuthProbe> =>
  kriyadotJson('/api/mcp/oauth/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server }),
  });

export const completeMcpOAuthManual = (
  code: string,
  state: string,
): Promise<{ ok: boolean; server: string; expiresAt: number }> =>
  kriyadotJson('/api/mcp/oauth/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
  });

export const revokeMcpOAuth = (server: string): Promise<{ ok: boolean; server: string }> =>
  kriyadotJson(`/api/mcp/oauth/${encodeURIComponent(server)}`, { method: 'DELETE' });

// ---- Processing rules (firing log UI hook, read-only for now) ------------------------

export interface RuleFiring {
  id?: string | number;
  ruleId?: string;
  ruleName?: string;
  itemId?: string;
  itemKind?: string;
  action?: string;
  status?: string;
  ts?: number;
  reason?: string;
  detail?: unknown;
}

export function getRuleFirings(params?: {
  rule?: string;
  status?: string;
  since?: string;
}): Promise<RuleFiring[] | null> {
  const q = new URLSearchParams();
  if (params?.rule) q.set('ruleId', params.rule);
  if (params?.status) q.set('status', params.status);
  if (params?.since) q.set('since', params.since);
  const qs = q.toString();
  return optionalJson(`/api/processing-rules/firing-log${qs ? `?${qs}` : ''}`);
}

export interface ProcessingRule {
  id: string;
  name: string;
  enabled: boolean;
  match?: unknown;
  actions?: unknown[];
  createdAt?: number;
  updatedAt?: number;
}

export function getProcessingRules(): Promise<ProcessingRule[] | null> {
  return optionalJson('/api/processing-rules');
}

// ---- Entity tracing (lite) -------------------------------------------------------

export interface EntityTraceMatch {
  source: 'knowledge-base' | 'memory';
  chunkId?: string;
  documentId?: string;
  documentTitle?: string;
  atomId?: string;
  botId?: string;
  text?: string;
  fact?: string;
  score?: number;
}

export interface EntityTraceResult {
  entity: string;
  summary?: string;
  summaryKind?: 'extractive' | 'generated';
  matches: EntityTraceMatch[];
  counts?: { knowledgeBase?: number; memory?: number };
}

export function traceEntityApi(params: {
  q: string;
  botId?: string;
  topK?: number;
}): Promise<EntityTraceResult | null> {
  const q = new URLSearchParams();
  q.set('q', params.q);
  if (params.botId) q.set('botId', params.botId);
  if (params.topK) q.set('topK', String(params.topK));
  return optionalJson(`/api/entities/trace?${q.toString()}`);
}

// ---- Companion (phone → PC remote control) ---------------------------------------

export interface CompanionDevice {
  id: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number;
  online: boolean;
}

export interface CompanionQr {
  ok: boolean;
  qrPayload: string;
  /** 'lan' (QR encodes host:port) or 'hosted' (QR encodes KRIYADOT_PUBLIC_URL). */
  mode?: 'lan' | 'hosted';
  /** Human label for the server the QR points at. */
  serverLabel?: string;
}

export interface CompanionCode {
  ok: boolean;
  ott: string;
  qrPayload: string;
  expiresAt: number;
  /** 'lan' (QR encodes host:port) or 'hosted' (QR encodes KRIYADOT_PUBLIC_URL). */
  mode?: 'lan' | 'hosted';
  /** Human label for the server the QR points at. */
  serverLabel?: string;
}

/**
 * Pairing QR payload for the companion app (e.g.
 * "kriyadot://pair?host=192.168.1.5&port=4000&token=ABC123").
 * Throws EndpointMissingError (404) when the companion service is not up —
 * callers show a "companion service unavailable" state in that case.
 */
export function getCompanionQr(): Promise<CompanionQr> {
  return kriyadotJson('/api/companion/pairing/qr');
}

/** Request a fresh 6-digit one-time pairing code (+ its QR payload). */
export function requestCompanionCode(): Promise<CompanionCode> {
  return kriyadotJson('/api/companion/pairing/code', { method: 'POST' });
}

/** Pending on-phone pairing approvals, if the server exposes them. */
export interface CompanionPendingPairing {
  token: string;
  deviceName?: string;
  platform?: string;
  requestedAt?: number;
}

export function getCompanionPending(): Promise<{ ok: boolean; pending: CompanionPendingPairing[] } | null> {
  return optionalJson('/api/companion/pairing/pending');
}

export function approveCompanionPairing(token: string): Promise<{ ok: boolean }> {
  return kriyadotJson('/api/companion/pairing/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export function rejectCompanionPairing(token: string): Promise<{ ok: boolean }> {
  return kriyadotJson('/api/companion/pairing/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export function listCompanionDevices(): Promise<{ ok: boolean; devices: CompanionDevice[] }> {
  return kriyadotJson('/api/companion/devices');
}

export function revokeCompanionDevice(id: string): Promise<{ ok: boolean }> {
  return kriyadotJson(`/api/companion/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- Feature interconnection (P2-E) --------------------------------------------

export type AttachmentKind = 'note' | 'page';

export interface NoteAttachment {
  id: string;
  kind: AttachmentKind;
  refId: string;
  title: string;
  botId?: string;
  sessionId?: string;
  createdAt: number;
}

export function listNoteAttachments(filter?: {
  botId?: string;
  sessionId?: string;
}): Promise<{ ok: boolean; attachments: NoteAttachment[] }> {
  const q = new URLSearchParams();
  if (filter?.botId) q.set('botId', filter.botId);
  if (filter?.sessionId) q.set('sessionId', filter.sessionId);
  const qs = q.toString();
  return kriyadotJson(`/api/note-attachments${qs ? `?${qs}` : ''}`);
}

export function attachNote(input: {
  kind: AttachmentKind;
  refId: string;
  botId?: string;
  sessionId?: string;
}): Promise<{ ok: boolean; attachment: NoteAttachment }> {
  return kriyadotJson('/api/note-attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function detachNote(id: string): Promise<{ ok: boolean }> {
  return kriyadotJson(`/api/note-attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface BotRoutine {
  id: string;
  name: string;
  botId: string;
  prompt: string;
  sessionId?: string;
  enabled: boolean;
  createdAt: number;
}

export function listBotRoutines(): Promise<{ ok: boolean; routines: BotRoutine[] }> {
  return kriyadotJson('/api/bot-routines');
}

export function createBotRoutine(input: {
  botId: string;
  name?: string;
  prompt: string;
  sessionId?: string;
}): Promise<{ ok: boolean; routine: BotRoutine & { secret: string } }> {
  return kriyadotJson('/api/bot-routines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteBotRoutine(id: string): Promise<{ ok: boolean }> {
  return kriyadotJson(`/api/bot-routines/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface PeerApproval {
  id: string;
  fromBotId: string;
  toBotId: string;
  task: string;
  sessionId: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  governanceApprovalId: string;
  createdAt: number;
  decidedAt?: number;
}

export function listPeerApprovals(status?: string): Promise<{ ok: boolean; approvals: PeerApproval[] }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return kriyadotJson(`/api/peer-approvals${qs}`);
}

export function decidePeerApproval(id: string, decision: 'approve' | 'deny'): Promise<{ ok: boolean }> {
  return kriyadotJson(`/api/peer-approvals/${encodeURIComponent(id)}/${decision}`, { method: 'POST' });
}
