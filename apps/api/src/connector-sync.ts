// SPDX-License-Identifier: Apache-2.0
// Connector background-sync engine (Muse parity audit §4.12: CN-10).
//
// The Slice-1 Permissions pane (permissions-pane.ts) already persists a
// per-(bot, connector) background-sync toggle in
// permissions-connector-settings.json — but until this module NOTHING
// READ it: the toggle was a recorded preference, not a gate. This module
// is the sync-engine side:
//
//   isBackgroundSyncEnabled()   the gate every background sync consults
//                               (pane value; default OFF for opt-in
//                               connector sync targets).
//   resolveChannelSyncEnabled() the gate for SHARED channel pollers
//                               (one poller serves every bot — the email
//                               IMAP poller in messaging.ts): explicit
//                               user settings win; when the user has
//                               never touched the toggle, a legacy
//                               default preserves pre-CN-10 behaviour so
//                               existing installs do not silently stop
//                               syncing. messaging.ts wires this into
//                               its poll loop (checked every tick).
//   ConnectorSyncEngine         a registry of sync targets. Background
//                               ticks run a target ONLY when its toggle
//                               is on; manual runs (user pressed "sync
//                               now") bypass the toggle but are recorded
//                               the same way. Every outcome is persisted
//                               to connector-sync-state[.user].json:
//                               ok / error / skipped-disabled /
//                               reauth-needed, with counts.
//   Reauth surfacing            two sources, one view:
//                               (a) a sync (or any recorded run) failing
//                               with an auth-shaped error flips the
//                               connector's state to reauth-needed;
//                               (b) Composio connected accounts whose
//                               cached status is not ACTIVE (EXPIRED /
//                               INACTIVE / …) are derived into
//                               reauth-needed entries for their toolkit
//                               from composio-accounts' local cache — no
//                               live call needed. The Permissions pane
//                               GET /connectors response also carries
//                               `reauthNeeded` per Composio app (see
//                               permissions-pane.ts), and the routes
//                               below expose the full picture.
//
// Routes (register-style; host mounts under /api):
//   GET  /connector-sync/states[?botId=]  → toggles + state + reauth view
//   POST /connector-sync/run              → { connectorId, botId } manual run
//
// Identity: routes resolve the verified principal exactly like the
// Composio / permissions routes (principal.ts).

import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { readConnectorSettings } from './permissions-pane.js';
import { readAccountCache } from './composio-accounts.js';
import { principalMiddleware, resolvePrincipal, type PrincipalContext } from './principal.js';

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The pane toggle for one (bot, connector). Default OFF: background sync
 * is opt-in per connector. This is THE read the pane's write side was
 * missing — every sync target must consult it before a background run.
 */
export function isBackgroundSyncEnabled(
  dataDir: string,
  userId: string,
  botId: string,
  connectorId: string,
): boolean {
  try {
    return readConnectorSettings(dataDir, userId)[botId]?.[connectorId]?.backgroundSync === true;
  } catch {
    return false;
  }
}

/**
 * Gate for a sync shared across bots (channel pollers). Semantics:
 *   - no setting recorded for this connector on any bot → `legacyDefault`
 *     (callers pass true to preserve pre-CN-10 behaviour, e.g. the email
 *     poller that has always run when IMAP is configured);
 *   - settings exist → enabled iff AT LEAST ONE bot has it on (a shared
 *     poller cannot run for one bot only; turning it off for every bot
 *     stops it — that is the toggle actually gating).
 */
export function resolveChannelSyncEnabled(
  dataDir: string,
  userId: string,
  connectorId: string,
  opts: { legacyDefaultWhenUnset?: boolean } = {},
): boolean {
  let anyRecorded = false;
  let anyEnabled = false;
  try {
    for (const perBot of Object.values(readConnectorSettings(dataDir, userId))) {
      const setting = perBot?.[connectorId];
      if (setting) {
        anyRecorded = true;
        if (setting.backgroundSync === true) anyEnabled = true;
      }
    }
  } catch {
    // Corrupt settings read as "never touched" — fall to the legacy default.
  }
  if (!anyRecorded) return opts.legacyDefaultWhenUnset ?? false;
  return anyEnabled;
}

// ---------------------------------------------------------------------------
// Persisted sync state
// ---------------------------------------------------------------------------

export type ConnectorSyncStatus = 'never' | 'ok' | 'error' | 'skipped-disabled' | 'reauth-needed';

export interface ConnectorSyncState {
  connectorId: string;
  botId: string;
  status: ConnectorSyncStatus;
  /** Epoch ms of the last attempted run (background or manual). */
  lastRunAt?: number;
  /** Epoch ms of the last successful run. */
  lastOkAt?: number;
  lastError?: string;
  reauthNeeded: boolean;
  reauthReason?: string;
  consecutiveFailures: number;
  totalRuns: number;
}

const SYNC_STATE_FILE = 'connector-sync-state';

function sanitizeNamespace(ns: string): string {
  return ns.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'user';
}

function syncStatePath(dataDir: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeNamespace(userId)}`;
  return path.join(dataDir, `${SYNC_STATE_FILE}${suffix}.json`);
}

type SyncStateFileShape = Record<string, ConnectorSyncState>; // key: `${botId}::${connectorId}`

function stateKey(botId: string, connectorId: string): string {
  return `${botId}::${connectorId}`;
}

export function readSyncStates(dataDir: string, userId: string): SyncStateFileShape {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStatePath(dataDir, userId), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SyncStateFileShape;
  } catch {
    // Missing or corrupt → empty (never 500).
  }
  return {};
}

function writeSyncStates(dataDir: string, userId: string, states: SyncStateFileShape): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = syncStatePath(dataDir, userId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(states, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function getSyncState(
  dataDir: string,
  userId: string,
  botId: string,
  connectorId: string,
): ConnectorSyncState {
  return (
    readSyncStates(dataDir, userId)[stateKey(botId, connectorId)] ?? {
      connectorId,
      botId,
      status: 'never',
      reauthNeeded: false,
      consecutiveFailures: 0,
      totalRuns: 0,
    }
  );
}

function saveSyncState(dataDir: string, userId: string, state: ConnectorSyncState): ConnectorSyncState {
  const all = readSyncStates(dataDir, userId);
  all[stateKey(state.botId, state.connectorId)] = state;
  writeSyncStates(dataDir, userId, all);
  return state;
}

// ---------------------------------------------------------------------------
// Reauth derivation
// ---------------------------------------------------------------------------

/** Auth-shaped failure detector: HTTP 401/403, OAuth grant errors, expired tokens. */
export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return /401|403|unauthor|invalid_grant|token.*(expired|revoked)|reauth/i.test(String(err ?? ''));
  }
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  if (e.status === 401 || e.status === 403) return true;
  const text = `${typeof e.code === 'string' ? e.code : ''} ${typeof e.message === 'string' ? e.message : ''}`;
  return /401|403|unauthor|invalid_grant|token.*(expired|revoked)|reauth/i.test(text);
}

export interface ReauthEntry {
  connectorId: string;
  /** Composio account id when the source is a connected account. */
  accountId?: string;
  reason: string;
  source: 'sync-state' | 'composio-account';
}

/**
 * Derive reauth-needed entries from the local Composio account cache:
 * any cached account whose status is not ACTIVE needs the user to
 * reconnect it. Pure file read — no live Composio call.
 */
export function deriveComposioReauth(dataDir: string, userId: string): ReauthEntry[] {
  const out: ReauthEntry[] = [];
  try {
    for (const [accountId, record] of Object.entries(readAccountCache(dataDir, userId))) {
      if (record.status && record.status !== 'ACTIVE') {
        out.push({
          connectorId: record.toolkitSlug,
          accountId,
          reason: `Connected account status is ${record.status} — reconnect it in Accounts to restore access.`,
          source: 'composio-account',
        });
      }
    }
  } catch {
    // Cache unreadable → no derived entries (never throw on a status read).
  }
  return out;
}

/** The merged reauth view: persisted sync-state flags + derived account flags. */
export function listReauthNeeded(dataDir: string, userId: string, botId?: string): ReauthEntry[] {
  const out: ReauthEntry[] = [];
  for (const state of Object.values(readSyncStates(dataDir, userId))) {
    if (!state.reauthNeeded) continue;
    if (botId && state.botId !== botId) continue;
    out.push({
      connectorId: state.connectorId,
      reason: state.reauthReason ?? 'Authentication failed during background sync — reconnect this connector.',
      source: 'sync-state',
    });
  }
  out.push(...deriveComposioReauth(dataDir, userId));
  return out;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface ConnectorSyncTarget {
  connectorId: string;
  /** One sync pass. Throw on failure; auth-shaped errors flip reauth state. */
  sync: (ctx: { botId: string; userId: string; manual: boolean }) => Promise<{ items?: number } | void>;
}

export interface ConnectorSyncEngineDeps {
  dataDir: string;
  now?: () => number;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
}

export class ConnectorSyncEngine {
  private readonly targets = new Map<string, ConnectorSyncTarget>();
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorSyncEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  registerTarget(target: ConnectorSyncTarget): void {
    this.targets.set(target.connectorId, target);
  }

  registeredConnectorIds(): string[] {
    return [...this.targets.keys()];
  }

  private async execute(
    target: ConnectorSyncTarget,
    userId: string,
    botId: string,
    manual: boolean,
  ): Promise<ConnectorSyncState> {
    const prev = getSyncState(this.deps.dataDir, userId, botId, target.connectorId);
    const now = this.now();
    try {
      await target.sync({ botId, userId, manual });
      const state: ConnectorSyncState = {
        ...prev,
        status: 'ok',
        lastRunAt: now,
        lastOkAt: now,
        lastError: undefined,
        reauthNeeded: false,
        reauthReason: undefined,
        consecutiveFailures: 0,
        totalRuns: prev.totalRuns + 1,
      };
      return saveSyncState(this.deps.dataDir, userId, state);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const auth = isAuthError(err);
      const state: ConnectorSyncState = {
        ...prev,
        status: auth ? 'reauth-needed' : 'error',
        lastRunAt: now,
        lastError: message,
        reauthNeeded: auth ? true : prev.reauthNeeded,
        reauthReason: auth
          ? `Sync failed with an authentication error (${message}) — reconnect this connector.`
          : prev.reauthReason,
        consecutiveFailures: prev.consecutiveFailures + 1,
        totalRuns: prev.totalRuns + 1,
      };
      saveSyncState(this.deps.dataDir, userId, state);
      try {
        this.deps.audit?.(auth ? 'connector_sync.reauth_needed' : 'connector_sync.failed', {
          actor: userId,
          toolName: 'connector-sync',
          detail: { connectorId: target.connectorId, botId, error: message },
        });
      } catch {
        // Audit must never break sync.
      }
      return state;
    }
  }

  /**
   * One background tick for one bot: run every registered target whose
   * pane toggle is ON; record `skipped-disabled` for the rest WITHOUT
   * invoking their sync (the toggle actually gates).
   */
  async runBackgroundTick(userId: string, botId: string): Promise<ConnectorSyncState[]> {
    const out: ConnectorSyncState[] = [];
    for (const target of this.targets.values()) {
      if (!isBackgroundSyncEnabled(this.deps.dataDir, userId, botId, target.connectorId)) {
        const prev = getSyncState(this.deps.dataDir, userId, botId, target.connectorId);
        // The gate stopped this run. Only a never-run target changes
        // status (to skipped-disabled); a target with history keeps its
        // last real outcome — the toggle gates execution, not memory.
        out.push(
          prev.status === 'never'
            ? saveSyncState(this.deps.dataDir, userId, { ...prev, status: 'skipped-disabled' })
            : prev,
        );
        continue;
      }
      out.push(await this.execute(target, userId, botId, false));
    }
    return out;
  }

  /** Manual "sync now": bypasses the toggle (user intent), still recorded. */
  async runManual(userId: string, botId: string, connectorId: string): Promise<ConnectorSyncState> {
    const target = this.targets.get(connectorId);
    if (!target) throw new Error(`no sync target registered for connector "${connectorId}"`);
    return this.execute(target, userId, botId, true);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ConnectorSyncRouteDeps {
  dataDir: string;
  engine: ConnectorSyncEngine;
  bots: Array<{ id: string }>;
  loopbackToken?: string;
  jwtSecret?: string;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function registerConnectorSyncRoutes(router: Router, deps: ConnectorSyncRouteDeps): void {
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
  function callerOf(req: Request): string {
    const userId = resolvePrincipal(req, pctx)?.userId;
    if (!userId) throw new Error('unauthenticated');
    return userId;
  }

  const r = express.Router();
  r.use(principalMiddleware(pctx));

  // GET /connector-sync/states[?botId=] — toggles + last-run state + the
  // merged reauth view for every connector the pane or engine knows.
  r.get('/states', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const botId = typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : deps.bots[0]?.id ?? 'default';
    const settings = readConnectorSettings(deps.dataDir, userId);
    const connectorIds = new Set<string>([
      ...deps.engine.registeredConnectorIds(),
      ...Object.keys(settings[botId] ?? {}),
      ...deriveComposioReauth(deps.dataDir, userId).map((e) => e.connectorId),
    ]);
    const connectors = [...connectorIds].sort().map((connectorId) => ({
      connectorId,
      botId,
      backgroundSyncEnabled: isBackgroundSyncEnabled(deps.dataDir, userId, botId, connectorId),
      syncImplemented: deps.engine.registeredConnectorIds().includes(connectorId),
      state: getSyncState(deps.dataDir, userId, botId, connectorId),
    }));
    res.json({ ok: true, botId, connectors, reauthNeeded: listReauthNeeded(deps.dataDir, userId, botId) });
  });

  // POST /connector-sync/run { connectorId, botId } — manual sync now.
  r.post('/run', async (req: Request, res: Response) => {
    const userId = callerOf(req);
    const body = (req.body ?? {}) as { connectorId?: unknown; botId?: unknown };
    if (typeof body.connectorId !== 'string' || !body.connectorId) {
      res.status(400).json(errorBody('connectorId is required'));
      return;
    }
    const botId = typeof body.botId === 'string' && body.botId ? body.botId : deps.bots[0]?.id ?? 'default';
    if (deps.bots.length > 0 && !deps.bots.some((b) => b.id === botId)) {
      res.status(404).json(errorBody(`unknown bot: ${botId}`));
      return;
    }
    try {
      const state = await deps.engine.runManual(userId, botId, body.connectorId);
      try {
        deps.audit?.('connector_sync.manual_run', {
          actor: userId,
          toolName: 'connector-sync',
          detail: { connectorId: body.connectorId, botId, status: state.status },
        });
      } catch {
        // Audit must never break the run response.
      }
      res.json({ ok: true, state });
    } catch (err) {
      res.status(404).json(errorBody(err instanceof Error ? err.message : 'sync failed'));
    }
  });

  router.use('/connector-sync', r);
}
