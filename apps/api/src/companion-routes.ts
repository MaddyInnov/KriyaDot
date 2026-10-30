// SPDX-License-Identifier: Apache-2.0
// REST routes for the KriyaDot companion app (phone → PC remote control).
// Mounted by routes.ts as router.use('/companion', companionRouter) →
// effective paths /api/companion/*. The WebSocket push channel
// (/api/companion/ws) is handled by CompanionHub.handleUpgrade, wired to the
// HTTP server's 'upgrade' event in index.ts.
//
// Auth: every route except the two pairing entry points requires a device
// Bearer token (issued once at pairing exchange, stored as SHA-256 hash).
// Every remote action is audit-logged via the injected audit() (namespace
// `companion.*`).
//
// Platform surfaces reused (not reimplemented):
// - approvals: governance.listApprovals/getApproval/decide (+ idResolver for
//   runtime-issued approval ids, preference learning, MCP close-the-loop —
//   mirroring the /api/approvals route in routes.ts)
// - briefing: BriefingStore.latest()
// - activity: OmniStore 'recent' layer (the Omni panel's activity feed),
//   falling back to the live governance audit feed when empty
// - runs: in-flight chat turns (runControls), queued chat messages
//   (ChatQueueStore), workflow runs (WorkflowRunner, read-only)
// - chat: POST /chat/send proxies to the local /api/chat SSE endpoint so the
//   phone gets the exact same streaming contract as the web UI; the app may
//   also call /api/chat directly — that route accepts the companion Bearer
//   token (see routes.ts).

import os from 'node:os';
import type { Request, Response, Router, NextFunction } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';
import { botWorkspacePath } from './bot-workspace-alloc.js';
import { BriefingStore } from './briefing.js';
import { CompanionHub, CompanionStore, type CompanionAudit } from './companion.js';
import type { DecideApprovalBody } from './types.js';

// ---------------------------------------------------------------------------
// Dependency interfaces (structural — the real platform objects satisfy them,
// and tests can pass light stubs)
// ---------------------------------------------------------------------------

export interface ApprovalView {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  actor: string;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
  provenance?: string;
}

export interface AuditView {
  id: number | string;
  ts: number;
  action: string;
  actor?: string;
  toolName?: string;
  detail?: unknown;
}

export interface CompanionGovernance {
  listApprovals(status?: string): ApprovalView[];
  getApproval(id: string): ApprovalView | undefined;
  decide(id: string, decision: 'approved' | 'denied', opts?: { note?: string; decidedBy?: string }): ApprovalView;
  listAudit(limit: number): AuditView[];
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  status: string;
}

export interface CompanionWorkflowRunner {
  listRuns(workflowId?: string): WorkflowRunView[];
  getRun(id: string): WorkflowRunView | undefined;
}

export interface QueuedView {
  id: string;
  sessionId: string;
  botId: string;
  message: string;
  status: string;
  createdAt: number;
}

export interface CompanionChatQueue {
  list(sessionId?: string): QueuedView[];
  remove(id: string): boolean;
}

export interface OmniItemView {
  id: string;
  title: string;
  detail?: string;
  ts?: number;
  kind?: string;
  createdAt: number;
}

export interface CompanionOmni {
  listItems(layer?: string): OmniItemView[];
}

/** Live chat-turn controls owned by createRouter (the /api/chat handler). */
export interface CompanionRunControls {
  activeTurns(): Array<{ sessionId: string; botId: string; startedAt: number }>;
  /** Abort the in-flight turn for a session (web UI "Stop" semantics). */
  abortTurn(sessionId: string): boolean;
}

export interface CompanionRouteDeps {
  store: CompanionStore;
  hub: CompanionHub;
  audit: CompanionAudit;
  /** LAN IP embedded in the QR pairing payload (LAN mode). */
  lanIp: string;
  /** API port embedded in the QR pairing payload (LAN mode). */
  port: number;
  /**
   * Public base URL for hosted deployments (e.g. "https://kriyadot.example.com").
   * When set, pairing QR payloads encode this URL so phones pair over the
   * internet; when unset, pairing stays LAN-only. From KRIYADOT_PUBLIC_URL.
   */
  publicBaseUrl?: string;
  version: string;
  /** Local URL of the chat SSE endpoint, for the /chat/send proxy. */
  localChatUrl: string;
  /**
   * Per-boot loopback token, presented as the Bearer on the proxy's inner
   * call to /api/chat (which is loopback-auth protected). The proxy route
   * itself is authenticated by the companion device token; without this
   * credential the inner call is rejected by the auth middleware.
   */
  localChatToken?: string;
  governance: CompanionGovernance;
  /** Resolves runtime-issued approval ids to real gateway ids. */
  idResolver: { resolveApprovalId(id: string): string };
  workflowRunner: CompanionWorkflowRunner;
  workflowLabel?: (workflowId: string) => string | undefined;
  chatQueueStore: CompanionChatQueue;
  omniStore: CompanionOmni;
  /** dataDir for the BriefingStore (same DB the briefing routes use). */
  dataDir: string;
  runControls: CompanionRunControls;
  /** Live bot roster accessor — the same source the web UI's GET /api/bots reads. */
  getBots: () => BotConfig[];
  mcpServer?: { decideApproval(approvalId: string, decision: 'approved' | 'denied'): void };
  recordPreference?: (botId: string, toolName: string, decision: 'approved' | 'denied') => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First non-internal IPv4 address for the QR pairing payload. */
export function getLanIp(): string {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.address) return a.address;
    }
  }
  return '127.0.0.1';
}

export function buildQrPayload(host: string, port: number, ott: string): string {
  return `kriyadot://pair?host=${encodeURIComponent(host)}&port=${port}&token=${encodeURIComponent(ott)}`;
}

/**
 * Hosted-mode QR payload: the phone connects to a public base URL over the
 * internet instead of a LAN host:port.
 *   kriyadot://pair?url=https%3A%2F%2Fkriyadot.example.com&token=<ott>
 */
export function buildHostedQrPayload(publicBaseUrl: string, ott: string): string {
  return `kriyadot://pair?url=${encodeURIComponent(publicBaseUrl)}&token=${encodeURIComponent(ott)}`;
}

export type PairingMode = 'lan' | 'hosted';

/** Which QR flavor pairing responses should encode. Hosted wins when configured. */
export function pairingMode(deps: Pick<CompanionRouteDeps, 'publicBaseUrl'>): PairingMode {
  return deps.publicBaseUrl ? 'hosted' : 'lan';
}

/** Human label for the server the QR payload points at (shown in the web UI). */
export function pairingServerLabel(deps: Pick<CompanionRouteDeps, 'publicBaseUrl' | 'lanIp' | 'port'>): string {
  return deps.publicBaseUrl ?? `${deps.lanIp}:${deps.port}`;
}

/** QR payload + mode for a fresh OTT, honoring the hosted/LAN configuration. */
export function buildPairingPayload(
  deps: Pick<CompanionRouteDeps, 'publicBaseUrl' | 'lanIp' | 'port'>,
  ott: string,
): { qrPayload: string; mode: PairingMode; serverLabel: string } {
  const mode = pairingMode(deps);
  const qrPayload =
    mode === 'hosted'
      ? buildHostedQrPayload(deps.publicBaseUrl as string, ott)
      : buildQrPayload(deps.lanIp, deps.port, ott);
  return { qrPayload, mode, serverLabel: pairingServerLabel(deps) };
}

function err(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown';
}

const DEVICE_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

interface AuthedRequest extends Request {
  companionDevice?: { id: string; name: string };
}

function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const token = m?.[1]?.trim();
  return token ? token : undefined;
}

function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim();
  return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Approval';
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    let s: string;
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
    if (s.length > 120) s = `${s.slice(0, 117)}...`;
    parts.push(`${k}=${s}`);
    if (parts.join('; ').length > 300) break;
  }
  return parts.join('; ');
}

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : def;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), max);
}

// ---------------------------------------------------------------------------
// Runs (unified view over chat turns, queued messages, workflow runs)
// ---------------------------------------------------------------------------

export interface CompanionRunItem {
  id: string;
  kind: 'chat-turn' | 'queued-message' | 'workflow-run';
  label: string;
  state: string;
  detail: string;
}

function collectRuns(deps: CompanionRouteDeps): CompanionRunItem[] {
  const items: CompanionRunItem[] = [];
  const seenSessions = new Set<string>();
  for (const t of deps.runControls.activeTurns()) {
    seenSessions.add(t.sessionId);
    items.push({
      id: t.sessionId,
      kind: 'chat-turn',
      label: t.botId,
      state: deps.store.isSessionPaused(t.sessionId) ? 'paused' : 'running',
      detail: `chat session ${t.sessionId}`,
    });
  }
  for (const sid of deps.store.listPausedSessions()) {
    if (seenSessions.has(sid)) continue;
    seenSessions.add(sid);
    items.push({
      id: sid,
      kind: 'chat-turn',
      label: 'session',
      state: 'paused',
      detail: `chat session ${sid} (paused from companion)`,
    });
  }
  for (const q of deps.chatQueueStore.list()) {
    items.push({
      id: q.id,
      kind: 'queued-message',
      label: q.botId,
      state: 'queued',
      detail: q.message.slice(0, 140),
    });
  }
  try {
    for (const r of deps.workflowRunner.listRuns()) {
      if (r.status !== 'running' && r.status !== 'paused') continue;
      const label = deps.workflowLabel?.(r.workflowId) ?? r.workflowId;
      items.push({
        id: r.id,
        kind: 'workflow-run',
        label,
        state: r.status,
        detail: `workflow ${r.workflowId}`,
      });
    }
  } catch {
    // Workflow listing must never break the companion status view.
  }
  return items;
}

type RunTarget =
  | { kind: 'turn'; sessionId: string }
  | { kind: 'paused-session'; sessionId: string }
  | { kind: 'queued'; queue: QueuedView }
  | { kind: 'workflow'; run: WorkflowRunView };

function resolveRunTarget(deps: CompanionRouteDeps, id: string): RunTarget | undefined {
  if (deps.runControls.activeTurns().some((t) => t.sessionId === id)) {
    return { kind: 'turn', sessionId: id };
  }
  if (deps.store.isSessionPaused(id)) {
    return { kind: 'paused-session', sessionId: id };
  }
  const queued = deps.chatQueueStore.list().find((q) => q.id === id);
  if (queued) return { kind: 'queued', queue: queued };
  try {
    const run = deps.workflowRunner.getRun(id);
    if (run) return { kind: 'workflow', run };
  } catch {
    // ignore
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerCompanionRoutes(router: Router, deps: CompanionRouteDeps): void {
  const { store, hub, audit } = deps;
  const briefingStore = new BriefingStore(deps.dataDir);

  /** Device-token auth. Pairing entry points are registered without it. */
  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    const device = token ? store.findDeviceByToken(token) : undefined;
    if (!device) {
      audit('companion.auth_failed', {
        actor: 'api',
        toolName: 'companion',
        detail: { ip: clientIp(req), path: req.path },
      });
      err(res, 401, 'unauthorized', 'A valid companion device token is required.');
      return;
    }
    store.touchDevice(device.id);
    req.companionDevice = { id: device.id, name: device.name };
    next();
  };

  const deviceOf = (req: AuthedRequest): { id: string; name: string } =>
    req.companionDevice ?? { id: 'unknown', name: 'unknown' };

  // ---- Pairing (no auth — this is how a device earns its token) -------------

  const mintCode = (req: Request, res: Response): void => {
    const ip = clientIp(req);
    if (!store.rateLimiter.allow(ip)) {
      audit('companion.pair_rate_limited', { actor: 'api', toolName: 'companion', detail: { ip } });
      err(res, 429, 'rate_limited', 'Too many pairing attempts. Try again later.');
      return;
    }
    const rec = store.requestPairingOTT();
    const { qrPayload, mode, serverLabel } = buildPairingPayload(deps, rec.ott);
    audit('companion.pair_requested', {
      actor: 'api',
      toolName: 'companion',
      detail: { expiresAt: rec.expiresAt, ip, mode },
    });
    res.json({ ok: true, ott: rec.ott, qrPayload, expiresAt: rec.expiresAt, mode, serverLabel });
  };

  router.post('/pairing/code', mintCode);
  // GET variant for the web UI: renders the QR directly from qrPayload.
  router.get('/pairing/qr', (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!store.rateLimiter.allow(ip)) {
      audit('companion.pair_rate_limited', { actor: 'api', toolName: 'companion', detail: { ip } });
      err(res, 429, 'rate_limited', 'Too many pairing attempts. Try again later.');
      return;
    }
    const rec = store.requestPairingOTT();
    const { qrPayload, mode, serverLabel } = buildPairingPayload(deps, rec.ott);
    audit('companion.qr_requested', {
      actor: 'api',
      toolName: 'companion',
      detail: { expiresAt: rec.expiresAt, ip, mode },
    });
    res.json({ ok: true, qrPayload, expiresAt: rec.expiresAt, mode, serverLabel });
  });

  router.post('/pairing/exchange', (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!store.rateLimiter.allow(ip)) {
      audit('companion.pair_rate_limited', { actor: 'api', toolName: 'companion', detail: { ip } });
      err(res, 429, 'rate_limited', 'Too many pairing attempts. Try again later.');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = store.exchangePairing({ ott: body.ott, deviceName: body.deviceName, platform: body.platform });
    if (!result.ok) {
      audit('companion.pair_failed', { actor: 'api', toolName: 'companion', detail: { reason: result.error, ip } });
      err(res, 400, result.error);
      return;
    }
    audit('companion.paired', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: result.deviceId, ip },
    });
    // The raw token and push key are shown exactly once, here. The server
    // keeps only the token's hash (the push key is retained to seal pushes).
    res.json({ ok: true, deviceToken: result.token, deviceId: result.deviceId, pushKey: result.pushKey });
  });

  // ---- Push registration -----------------------------------------------------

  /**
   * Register the device's FCM registration token so the server can push
   * "done" / "needs you" notifications when the app is backgrounded.
   * Device-authenticated; a device may only register its own token.
   */
  router.post('/devices/:id/fcm-token', requireAuth, (req: AuthedRequest, res: Response) => {
    const me = deviceOf(req);
    if (req.params.id !== me.id) {
      err(res, 403, 'forbidden', 'A device can only register its own push token.');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ok = store.setFcmToken(me.id, typeof body.fcmToken === 'string' ? body.fcmToken : '');
    if (!ok) {
      err(res, 400, 'invalid_token', 'A valid FCM registration token is required.');
      return;
    }
    audit('companion.fcm_registered', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: me.id },
    });
    res.json({ ok: true });
  });

  /**
   * Platform-aware push registration: { token, platform: 'ios'|'android' }.
   * iOS tokens route to APNs, Android tokens to FCM. Same device-auth rule.
   */
  router.post('/devices/:id/push-token', requireAuth, (req: AuthedRequest, res: Response) => {
    const me = deviceOf(req);
    if (req.params.id !== me.id) {
      err(res, 403, 'forbidden', 'A device can only register its own push token.');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const platform = body.platform === 'ios' ? 'ios' : body.platform === 'android' ? 'android' : undefined;
    if (!platform) {
      err(res, 400, 'invalid_platform', 'platform must be "ios" or "android".');
      return;
    }
    const token = typeof body.token === 'string' ? body.token : typeof body.fcmToken === 'string' ? body.fcmToken : '';
    const ok = store.setPushToken(me.id, token, platform);
    if (!ok) {
      err(res, 400, 'invalid_token', 'A valid push registration token is required.');
      return;
    }
    audit('companion.push_registered', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: me.id, platform },
    });
    res.json({ ok: true });
  });

  // ---- Devices --------------------------------------------------------------

  router.get('/devices', requireAuth, (_req: Request, res: Response) => {
    const devices = store.listDevices().map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      online: hub.isConnected(d.id),
    }));
    res.json({ ok: true, devices });
  });

  router.delete('/devices/:id', requireAuth, (req: AuthedRequest, res: Response) => {
    const id = req.params.id;
    if (!DEVICE_ID_RE.test(id)) {
      err(res, 400, 'invalid_device_id');
      return;
    }
    hub.dropDevice(id); // force-disconnect live push sockets first
    const removed = store.revoke(id);
    if (!removed) {
      err(res, 404, 'device_not_found');
      return;
    }
    audit('companion.unpaired', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: id, revokedBy: deviceOf(req).id },
    });
    res.json({ ok: true });
  });

  // ---- Status + runs ---------------------------------------------------------

  const runSummary = (): { runs: CompanionRunItem[]; pendingApprovals: number } => {
    const runs = collectRuns(deps);
    let pendingApprovals = 0;
    try {
      pendingApprovals = deps.governance.listApprovals('pending').length;
    } catch {
      // Status must never fail because approvals are unreadable.
    }
    return { runs, pendingApprovals };
  };

  router.get('/status', requireAuth, (_req: Request, res: Response) => {
    const { runs, pendingApprovals } = runSummary();
    res.json({
      ok: true,
      server: { name: 'KriyaDot', version: deps.version },
      runs,
      activeRuns: runs.length,
      pendingApprovals,
    });
  });

  router.get('/runs', requireAuth, (_req: Request, res: Response) => {
    res.json({ ok: true, runs: collectRuns(deps) });
  });

  // ---- Approvals ---------------------------------------------------------------

  const mapApproval = (a: ApprovalView): Record<string, unknown> => ({
    id: a.id,
    title: humanizeToolName(a.toolName),
    kind: 'approval',
    detail: summarizeArgs(a.args),
    sessionId: a.sessionId,
    botId: a.botId,
    toolName: a.toolName,
    args: a.args,
    status: a.status,
    provenance: a.provenance,
    ts: a.ts,
    createdAt: new Date(a.ts).toISOString(),
  });

  router.get('/approvals', requireAuth, (_req: Request, res: Response) => {
    try {
      const pending = deps.governance.listApprovals('pending');
      res.json({ ok: true, approvals: pending.map(mapApproval) });
    } catch (e) {
      err(res, 500, 'approvals_unavailable', e instanceof Error ? e.message : String(e));
    }
  });

  const decideApproval = (decision: 'approved' | 'denied') => (req: AuthedRequest, res: Response): void => {
    const device = deviceOf(req);
    const body = (req.body ?? {}) as Partial<DecideApprovalBody>;
    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : undefined;
    try {
      const realId = deps.idResolver.resolveApprovalId(req.params.id);
      const existing = deps.governance.getApproval(realId);
      if (!existing) {
        err(res, 404, 'approval_not_found', `Unknown approval "${req.params.id}"`);
        return;
      }
      if (existing.status !== 'pending') {
        err(res, 409, 'approval_not_pending', `Approval "${req.params.id}" is already ${existing.status}`);
        return;
      }
      const decided = deps.governance.decide(realId, decision, { note, decidedBy: `companion:${device.id}` });
      // Preference learning (mirrors the /api/approvals route): never breaks the decision.
      try {
        deps.recordPreference?.(existing.botId, existing.toolName, decision);
      } catch {
        // ignore
      }
      // Close the loop for approvals that originated from external MCP clients.
      if (deps.mcpServer) {
        try {
          deps.mcpServer.decideApproval(realId, decision);
        } catch {
          // The gateway decision above is authoritative.
        }
      }
      audit('companion.approval_decided', {
        actor: 'api',
        toolName: 'companion',
        detail: { deviceId: device.id, approvalId: realId, decision, note: note ?? null },
      });
      hub.broadcast({ type: 'approval', event: 'decided', approval: mapApproval(decided) });
      res.json({ ok: true, approval: mapApproval(decided) });
    } catch (e) {
      err(res, 500, 'approval_decision_failed', e instanceof Error ? e.message : String(e));
    }
  };

  router.post('/approvals/:id/approve', requireAuth, decideApproval('approved'));
  router.post('/approvals/:id/deny', requireAuth, decideApproval('denied'));

  // ---- Run controls -------------------------------------------------------------
  //
  // Targets:
  // - chat-turn (in-flight turn or paused session): pause aborts the turn and
  //   marks the session so no new turn may start (423) until resumed; cancel
  //   aborts the turn and clears the pause mark; resume clears the mark.
  // - queued-message: cancel dequeues it (pause/resume are meaningless).
  // - workflow-run: read-only here — the platform has no remote pause/cancel
  //   primitive; runs paused for approval resume when their approval is
  //   decided via the approvals endpoints above.

  const notSupported = (res: Response, detail: string): void => err(res, 409, 'not_supported', detail);

  router.post('/runs/:id/pause', requireAuth, (req: AuthedRequest, res: Response) => {
    const device = deviceOf(req);
    const id = req.params.id;
    const target = resolveRunTarget(deps, id);
    if (!target) {
      err(res, 404, 'run_not_found', `Unknown run "${id}"`);
      return;
    }
    if (target.kind === 'workflow') {
      notSupported(
        res,
        'Workflow runs cannot be paused from the companion. Runs paused for approval resume when their approval is decided.',
      );
      return;
    }
    if (target.kind === 'queued') {
      notSupported(res, 'Queued messages cannot be paused; cancel removes them from the queue.');
      return;
    }
    const abortedTurn = target.kind === 'turn' ? deps.runControls.abortTurn(target.sessionId) : false;
    store.pauseSession(id);
    audit('companion.run_paused', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: device.id, sessionId: id, abortedTurn },
    });
    res.json({ ok: true, id, state: 'paused' });
  });

  router.post('/runs/:id/resume', requireAuth, (req: AuthedRequest, res: Response) => {
    const device = deviceOf(req);
    const id = req.params.id;
    const target = resolveRunTarget(deps, id);
    if (!target) {
      err(res, 404, 'run_not_found', `Unknown run "${id}"`);
      return;
    }
    if (target.kind === 'workflow') {
      notSupported(
        res,
        'Workflow runs cannot be resumed from the companion. Runs paused for approval resume when their approval is decided.',
      );
      return;
    }
    if (target.kind === 'queued') {
      notSupported(res, 'Queued messages are not pausable; they run when their session turn starts.');
      return;
    }
    const wasPaused = store.resumeSession(id);
    audit('companion.run_resumed', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: device.id, sessionId: id, wasPaused },
    });
    res.json({ ok: true, id, state: 'running', wasPaused });
  });

  router.post('/runs/:id/cancel', requireAuth, (req: AuthedRequest, res: Response) => {
    const device = deviceOf(req);
    const id = req.params.id;
    const target = resolveRunTarget(deps, id);
    if (!target) {
      err(res, 404, 'run_not_found', `Unknown run "${id}"`);
      return;
    }
    if (target.kind === 'workflow') {
      notSupported(res, 'Workflow runs cannot be cancelled from the companion in this MVP.');
      return;
    }
    if (target.kind === 'queued') {
      const removed = deps.chatQueueStore.remove(target.queue.id);
      audit('companion.run_cancelled', {
        actor: 'api',
        toolName: 'companion',
        detail: { deviceId: device.id, kind: 'queued-message', queueId: target.queue.id, removed },
      });
      res.json({ ok: true, id, cancelled: removed });
      return;
    }
    const abortedTurn = target.kind === 'turn' ? deps.runControls.abortTurn(target.sessionId) : false;
    const wasPaused = store.resumeSession(id); // cancel clears the pause mark
    audit('companion.run_cancelled', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: device.id, kind: 'chat-turn', sessionId: id, abortedTurn, wasPaused },
    });
    res.json({ ok: true, id, cancelled: true });
  });

  // ---- Chat -----------------------------------------------------------------------
  //
  // Thin proxy over the local /api/chat SSE endpoint: the phone gets the exact
  // same streaming contract as the web UI (token events, approval_required,
  // done/error, `: ping` heartbeats; JSON {ok, queued} when a turn is
  // in-flight and queueMode=queue), authenticated by the companion device
  // token at this layer. The app may also call /api/chat directly — that
  // route accepts the companion Bearer token (see routes.ts).

  router.post('/chat/send', requireAuth, async (req: AuthedRequest, res: Response) => {
    const device = deviceOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.botId !== 'string' || !body.botId) {
      err(res, 400, 'botId is required');
      return;
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      err(res, 400, 'message is required');
      return;
    }
    audit('companion.chat_send', {
      actor: 'api',
      toolName: 'companion',
      detail: {
        deviceId: device.id,
        botId: body.botId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        messageLength: (body.message as string).length,
        via: 'companion-proxy',
      },
    });
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(deps.localChatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(deps.localChatToken ? { Authorization: `Bearer ${deps.localChatToken}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      err(res, 502, 'chat_unavailable', e instanceof Error ? e.message : String(e));
      return;
    }
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    try {
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const onClose = (): void => {
          reader.cancel().catch(() => {
            // ignore
          });
        };
        req.on('close', onClose);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) {
              await new Promise<void>((resolve) => res.once('drain', resolve));
            }
          }
        } finally {
          req.off('close', onClose);
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // Client went away or the upstream broke mid-stream; nothing to do.
    } finally {
      res.end();
    }
  });

  // ---- Bots -------------------------------------------------------------------------
  //
  // Bot roster for the companion app's chat picker. Same shape as the web UI's
  // GET /api/bots: the live bot configs (seed/bots.json + roster imports) with
  // the resolved workspacePath per bot. The app persists its selection and
  // sends it as botId in the chat request; an empty array means the roster is
  // unavailable (the app shows "No bots available").

  router.get('/bots', requireAuth, (_req: Request, res: Response) => {
    res.json(
      deps.getBots().map((bot) => ({
        ...bot,
        workspacePath: botWorkspacePath(bot, deps.dataDir),
      })),
    );
  });

  // ---- Activity --------------------------------------------------------------------
  //
  // The Omni 'recent' layer is the platform's activity feed (fed by the
  // OmniCollector from audit/approvals/workflow runs). When it is empty
  // (fresh boot, collector hasn't ticked yet) fall back to the live audit
  // feed so the phone always has something truthful to show.

  router.get('/activity', requireAuth, (req: Request, res: Response) => {
    const limit = clampLimit(req.query.limit, 50, 200);
    try {
      const items = deps.omniStore.listItems('recent').slice(0, limit);
      if (items.length > 0) {
        res.json({
          ok: true,
          source: 'omni',
          activity: items.map((it) => ({
            id: it.id,
            text: it.title,
            kind: it.kind ?? 'activity',
            detail: it.detail,
            ts: it.ts ?? it.createdAt,
            createdAt: new Date(it.ts ?? it.createdAt).toISOString(),
          })),
        });
        return;
      }
    } catch {
      // Fall through to the audit feed.
    }
    try {
      const entries = deps.governance.listAudit(limit);
      res.json({
        ok: true,
        source: 'audit',
        activity: entries.map((e) => ({
          id: String(e.id),
          text: [e.action, e.toolName, e.actor].filter(Boolean).join(' — '),
          kind: 'audit',
          ts: e.ts,
          createdAt: new Date(e.ts).toISOString(),
        })),
      });
    } catch (e) {
      err(res, 500, 'activity_unavailable', e instanceof Error ? e.message : String(e));
    }
  });

  // ---- Briefing ---------------------------------------------------------------------

  router.get('/briefing', requireAuth, (_req: Request, res: Response) => {
    try {
      const latest = briefingStore.latest();
      if (!latest) {
        err(res, 404, 'no_briefing', 'No briefing generated yet.');
        return;
      }
      const payload = latest.payload;
      const body =
        payload.summary ??
        [...payload.overnight, ...payload.calendar, ...payload.approvals]
          .slice(0, 10)
          .map((it) => `• ${it.title}`)
          .join('\n');
      res.json({
        ok: true,
        briefing: {
          title: 'Daily briefing',
          body,
          generatedAt: new Date(payload.generatedAt).toISOString(),
          ts: payload.generatedAt,
        },
        // Raw payload for future app versions; the lenient client ignores it.
        payload,
      });
    } catch (e) {
      err(res, 500, 'briefing_unavailable', e instanceof Error ? e.message : String(e));
    }
  });
}
