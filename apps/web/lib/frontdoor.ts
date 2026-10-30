// SPDX-License-Identifier: Apache-2.0
// Front-door client (Website Front Door build, spec Parts 4+5):
// execution placement, routine anchors/reporting, account sync hub and
// the website link flow. Types mirror the apps/api contracts exactly
// (see hidden_files/front-door-build-log.md "Fixed contracts").
//
// Fetching goes through kriyadotFetch (auth token + active-space header),
// like the routines panel. Non-2xx responses raise FrontdoorApiError
// carrying the HTTP status + the server's structured `error` code so the
// UI can special-case the documented 409 conflicts:
//   PUT /api/placement/bots/:botId → 409 { error:'run-in-flight'|'cloud-not-connected' }
//   POST /api/universal/chat (placement:'cloud') → 409 { error:'cloud-not-connected' }

'use client';

import { kriyadotFetch } from './kriyadot-api';

// ---- Placement (Part 5) ------------------------------------------------------

export type BotPlacement = 'local' | 'cloud-report' | 'cloud-only';
export type InstanceRole = 'local' | 'cloud';
export type TaskPlacement = 'local' | 'cloud';

export interface BotPlacementRecord {
  botId: string;
  placement: BotPlacement;
  /** Privacy control (Part 4): never sync this bot's history. */
  localOnly: boolean;
}

export interface PlacementOverview {
  role: InstanceRole;
  syncConfigured: boolean;
  cloudTier?: string;
  bots: BotPlacementRecord[];
}

// ---- Sync hub (Part 4) ---------------------------------------------------------

export interface SyncStatus {
  configured: boolean;
  instanceUrl?: string;
  lastPushAt?: string;
  lastPullAt?: string;
  pendingOutbox: number;
  lastError?: string;
}

export interface SyncHistorySession {
  sessionId: string;
  botId: string;
  origin: 'local' | 'cloud';
  readOnly: boolean;
  messageCount: number;
  lastMessageTs: string;
}

export interface SyncHistory {
  sessions: SyncHistorySession[];
}

// ---- Frontdoor link (Part 2 registry population) --------------------------------

export interface FrontdoorStatus {
  linked: boolean;
  frontdoorUrl?: string;
  accountId?: string;
  workspaceId?: string;
}

// ---- Routines: anchor + reporting (Part 5) ---------------------------------------

export type RoutineAnchor = 'local' | 'cloud';
export type RoutineAnchorChoice = 'auto' | RoutineAnchor;
export type ReportingMode = 'instant' | 'daily' | 'both';

export interface RoutineReporting {
  mode: ReportingMode;
  quietStart?: string;
  quietEnd?: string;
}

/** Fields the routines API carries after the front-door extension. */
export interface RoutinePlacementFields {
  anchor?: RoutineAnchor;
  anchorWarning?: boolean;
  reporting?: RoutineReporting;
}

/**
 * The anchor label strings, replicated client-side EXACTLY as the API's
 * exported label helper produces them. Do not reword — tests pin them.
 */
export function anchorLabel(anchor: RoutineAnchor): string {
  return anchor === 'cloud'
    ? 'Runs in your cloud — fires even while your PC is off'
    : 'Runs on this device — only while it\'s on';
}

/** Schedule kinds that fire on a clock (vs webhook/manual/event driven). */
const TIME_BASED_KINDS = new Set(['once', 'daily', 'cron', 'interval']);

export function isTimeBasedSchedule(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && TIME_BASED_KINDS.has(kind);
}

/**
 * True when a free-tier caveat applies: the cloud tier is free, the
 * resolved anchor is cloud, and the schedule is time-critical (a sleeping
 * free Studio can add a wake delay; Lightning Pro removes it).
 */
export function isFreeTier(cloudTier: string | null | undefined): boolean {
  return typeof cloudTier === 'string' && cloudTier.toLowerCase().includes('free');
}

export function showFreeTierCaveat(input: {
  cloudTier?: string | null;
  resolvedAnchor: RoutineAnchor;
  scheduleKind?: string | null;
}): boolean {
  return (
    input.resolvedAnchor === 'cloud' &&
    isTimeBasedSchedule(input.scheduleKind) &&
    isFreeTier(input.cloudTier)
  );
}

/**
 * Client-side mirror of the API's anchor resolution, used BEFORE save
 * (after save the API response's `anchor` field is authoritative):
 *  - an explicit choice wins;
 *  - Automatic: time-based schedule + cloud connected → cloud;
 *    time-based without cloud → local;
 *    non-time-based (manual/webhook/event) → the bot's placement executor.
 */
export function resolveAnchorPreview(input: {
  choice: RoutineAnchorChoice;
  scheduleKind?: string | null;
  cloudConnected: boolean;
  /** Executor side implied by the bot's placement ('cloud' for cloud-report/cloud-only). */
  botExecutor?: RoutineAnchor;
}): RoutineAnchor {
  if (input.choice === 'local' || input.choice === 'cloud') return input.choice;
  if (isTimeBasedSchedule(input.scheduleKind)) return input.cloudConnected ? 'cloud' : 'local';
  return input.botExecutor ?? 'local';
}

/**
 * The honest warning case: a time-based routine anchored locally because
 * no cloud is connected — it only fires while this PC is on.
 */
export function anchorWarningPreview(input: {
  resolvedAnchor: RoutineAnchor;
  scheduleKind?: string | null;
  cloudConnected: boolean;
}): boolean {
  return (
    input.resolvedAnchor === 'local' &&
    isTimeBasedSchedule(input.scheduleKind) &&
    !input.cloudConnected
  );
}

/** Executor side implied by a bot placement value. */
export function executorForPlacement(placement: BotPlacement | undefined): RoutineAnchor {
  return placement === 'cloud-report' || placement === 'cloud-only' ? 'cloud' : 'local';
}

// ---- Placement conflict copy ------------------------------------------------------

/** Inline copy for the documented placement 409 conflicts. */
export function placementConflictMessage(code: string | undefined): string | null {
  if (code === 'run-in-flight') return 'Stop the current run or wait for it to finish';
  if (code === 'cloud-not-connected') return 'Connect your cloud first — cloud placement needs a connected cloud instance.';
  return null;
}

// ---- API ---------------------------------------------------------------------------

export class FrontdoorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'FrontdoorApiError';
  }
}

async function fdJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, init);
  if (!res.ok) {
    let code: string | undefined;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string' && body.message) message = body.message;
      else if (code) message = code;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new FrontdoorApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const getPlacement = (): Promise<PlacementOverview> => fdJson('/api/placement');

export const updateBotPlacement = (
  botId: string,
  patch: { placement?: BotPlacement; localOnly?: boolean },
): Promise<BotPlacementRecord> =>
  fdJson(`/api/placement/bots/${encodeURIComponent(botId)}`, jsonInit('PUT', patch));

export const getSyncStatus = (): Promise<SyncStatus> => fdJson('/api/sync/status');

export const postSyncTarget = (input: { instanceUrl: string; linkToken: string }): Promise<unknown> =>
  fdJson('/api/sync/target', jsonInit('POST', input));

export const postSyncLinkToken = (): Promise<{ token: string }> =>
  fdJson('/api/sync/link-token', { method: 'POST' });

export const getSyncHistory = (): Promise<SyncHistory> => fdJson('/api/sync/history');

/** One message of a synced (cloud-origin) session, served read-only from the sync store. */
export interface SyncSessionMessage {
  id: number;
  role: string;
  content: string;
  ts: string;
}

export const getSyncSessionMessages = (
  sessionId: string,
): Promise<{ ok: boolean; sessionId: string; messages: SyncSessionMessage[] }> =>
  fdJson(`/api/sync/sessions/${encodeURIComponent(sessionId)}/messages`);

export const getFrontdoorStatus = (): Promise<FrontdoorStatus> => fdJson('/api/frontdoor/status');

export const postFrontdoorLink = (input: {
  frontdoorUrl: string;
  code: string;
  instanceUrl: string;
}): Promise<FrontdoorStatus> => fdJson('/api/frontdoor/link', jsonInit('POST', input));

/**
 * PATCH a routine's anchor/reporting. `anchor: null` clears an explicit
 * override back to Automatic (server re-resolves the default).
 */
export const patchRoutinePlacement = (
  routineId: string,
  patch: { anchor?: RoutineAnchor | null; reporting?: RoutineReporting },
): Promise<{ ok: boolean; routine: RoutinePlacementFields & Record<string, unknown> }> =>
  fdJson(`/api/routines/${encodeURIComponent(routineId)}`, jsonInit('PATCH', patch));
