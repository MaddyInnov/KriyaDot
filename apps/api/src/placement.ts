// SPDX-License-Identifier: Apache-2.0
// Execution placement (front-door Part 5) + automation anchors + reporting.
//
// PlacementStore (<dataDir>/placement.json): per-bot
//   { placement: 'local'|'cloud-report'|'cloud-only', localOnly: boolean }
// plus a global default for new bots. Exactly ONE side executes a bot at
// a time; flips happen at a clean boundary (no active run) and push the
// new executor flag to the user's instance through the sync client.
//
// Automation anchors: time-based routines default to the CLOUD whenever a
// cloud instance is connected (they must fire while the PC may be off);
// manual/webhook-only routines default to their bot's executor side. The
// executor gate lives in RoutineScheduler via shouldExecute (wired in
// index.ts): a server executes a routine only when the routine's anchor
// matches its role (KRIYADOT_INSTANCE_ROLE: 'cloud' | 'local', default
// 'local').
//
// Reporting: run completions on the executing side produce (a) a sync
// activity record kind 'routine-run' (pulled everywhere), (b) an instant
// notice through the host's real notifier (the same PushService callback
// pattern as notifyRoutinePaused — see index.ts wiring; deferred during
// the routine's quiet hours unless the run failed, flushed when quiet
// hours end), and (c) on the cloud role, a once-a-day digest record
// (sync activity kind 'daily-digest' + a local record here).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { requirePrincipal, type PrincipalContext } from './principal.js';
import type { BotRoutine } from './bot-routines.js';
import type { RoutineSchedule } from './routine-schedules.js';
import type { SyncHubStore } from './sync-hub.js';

export type BotPlacement = 'local' | 'cloud-report' | 'cloud-only';
export type InstanceRole = 'local' | 'cloud';
export type RoutineAnchor = 'local' | 'cloud';

export interface BotPlacementRecord {
  placement: BotPlacement;
  localOnly: boolean;
}

export const DEFAULT_PLACEMENT_RECORD: BotPlacementRecord = { placement: 'local', localOnly: false };

export function instanceRole(env: NodeJS.ProcessEnv = process.env): InstanceRole {
  return env.KRIYADOT_INSTANCE_ROLE === 'cloud' ? 'cloud' : 'local';
}

/** This server is the designated executor for a routine with this anchor. */
export function shouldExecuteForRole(anchor: RoutineAnchor | undefined, role: InstanceRole): boolean {
  const a = anchor ?? 'local';
  return role === 'cloud' ? a === 'cloud' : a !== 'cloud';
}

// ---------------------------------------------------------------------------
// PlacementStore
// ---------------------------------------------------------------------------

interface PlacementFile {
  bots: Record<string, BotPlacementRecord>;
  default?: BotPlacementRecord;
}

function validRecord(v: unknown): BotPlacementRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { placement?: unknown; localOnly?: unknown };
  const placement = r.placement === 'cloud-report' || r.placement === 'cloud-only' || r.placement === 'local' ? r.placement : 'local';
  return { placement, localOnly: r.localOnly === true };
}

export class PlacementStore {
  private readonly file: string;
  private data: PlacementFile;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'placement.json');
    this.data = { bots: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PlacementFile;
      this.data = { bots: parsed.bots ?? {}, default: parsed.default ? validRecord(parsed.default) ?? undefined : undefined };
    } catch {
      // First run — defaults apply.
    }
  }

  private persist(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  getDefault(): BotPlacementRecord {
    return this.data.default ?? { ...DEFAULT_PLACEMENT_RECORD };
  }

  setDefault(rec: Partial<BotPlacementRecord>): BotPlacementRecord {
    const cur = this.getDefault();
    const next = validRecord({ ...cur, ...rec }) ?? cur;
    this.data.default = next;
    this.persist();
    return next;
  }

  getBot(botId: string): BotPlacementRecord {
    return this.data.bots[botId] ?? this.getDefault();
  }

  /** True only when an explicit per-bot record exists. */
  hasBot(botId: string): boolean {
    return botId in this.data.bots;
  }

  setBot(botId: string, patch: Partial<BotPlacementRecord>): BotPlacementRecord {
    const next = validRecord({ ...this.getBot(botId), ...patch }) ?? this.getBot(botId);
    this.data.bots[botId] = next;
    this.persist();
    return next;
  }

  listBots(): Record<string, BotPlacementRecord> {
    return { ...this.data.bots };
  }

  isLocalOnly(botId: string): boolean {
    return this.getBot(botId).localOnly === true;
  }

  isCloudOnly(botId: string): boolean {
    return this.getBot(botId).placement === 'cloud-only';
  }
}

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

/** Every schedule-bearing routine counts as time-based for anchoring. */
export function isTimeBasedSchedule(schedule: RoutineSchedule | null | undefined): boolean {
  return !!schedule;
}

export interface AnchorResolution {
  anchor: RoutineAnchor;
  anchorWarning: boolean;
}

export function resolveRoutineAnchor(args: {
  schedule?: RoutineSchedule | null;
  explicitAnchor?: RoutineAnchor;
  botPlacement?: BotPlacement;
  cloudConnected: boolean;
}): AnchorResolution {
  const timeBased = isTimeBasedSchedule(args.schedule);
  if (args.explicitAnchor) {
    return {
      anchor: args.explicitAnchor,
      anchorWarning: args.explicitAnchor === 'local' && timeBased && !args.cloudConnected,
    };
  }
  if (timeBased) {
    return args.cloudConnected
      ? { anchor: 'cloud', anchorWarning: false }
      : { anchor: 'local', anchorWarning: true };
  }
  // Webhook/manual-only: follow the bot's executor side.
  const cloudSide = args.botPlacement === 'cloud-report' || args.botPlacement === 'cloud-only';
  return { anchor: cloudSide ? 'cloud' : 'local', anchorWarning: false };
}

/** Plain-words label for the web UI (exact strings from the spec). */
export function anchorLabel(
  routine: { anchor?: RoutineAnchor; schedule?: RoutineSchedule | null },
  cloudConnected: boolean,
): string {
  const anchor = routine.anchor ?? resolveRoutineAnchor({ schedule: routine.schedule, cloudConnected }).anchor;
  return anchor === 'cloud'
    ? 'Runs in your cloud — fires even while your PC is off'
    : "Runs on this device — only while it's on";
}

// ---------------------------------------------------------------------------
// Reporting (quiet hours, pending notices, daily digest)
// ---------------------------------------------------------------------------

export interface ReportingConfig {
  mode: 'instant' | 'daily' | 'both';
  quietStart?: string;
  quietEnd?: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateReporting(v: unknown): ReportingConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') throw new Error('reporting must be an object');
  const r = v as { mode?: unknown; quietStart?: unknown; quietEnd?: unknown };
  const mode = r.mode === 'daily' || r.mode === 'both' ? r.mode : 'instant';
  const out: ReportingConfig = { mode };
  for (const k of ['quietStart', 'quietEnd'] as const) {
    if (r[k] !== undefined) {
      if (typeof r[k] !== 'string' || !TIME_RE.test(r[k] as string)) throw new Error(`reporting.${k} must be "HH:MM" (24h)`);
      out[k] = r[k] as string;
    }
  }
  return out;
}

export function inQuietHours(reporting: ReportingConfig | undefined, date: Date): boolean {
  if (!reporting?.quietStart || !reporting?.quietEnd) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  const [sh, sm] = reporting.quietStart.split(':').map(Number);
  const [eh, em] = reporting.quietEnd.split(':').map(Number);
  const start = (sh ?? 0) * 60 + (sm ?? 0);
  const end = (eh ?? 0) * 60 + (em ?? 0);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // overnight window
}

export interface RunNotice {
  kind: 'done' | 'failed';
  botId: string;
  botName: string;
  title: string;
  body: string;
}

interface PendingNotice extends RunNotice {
  id: string;
  routineId: string;
  reporting?: ReportingConfig;
  queuedAt: number;
}

interface ReportingState {
  pending: PendingNotice[];
  lastDigestDate?: string;
  digests: Array<{ date: string; createdAt: number; payload: unknown }>;
}

export class ReportingService {
  private readonly file: string;
  private state: ReportingState;

  constructor(
    private readonly dataDir: string,
    private readonly deps: {
      /** The host's real notifier (PushService.notify in index.ts). */
      notify?: (notice: RunNotice) => Promise<unknown> | unknown;
      syncStore?: SyncHubStore;
      now?: () => number;
    } = {},
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'reporting.json');
    this.state = { pending: [], digests: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ReportingState;
      this.state = { pending: parsed.pending ?? [], digests: parsed.digests ?? [], lastDigestDate: parsed.lastDigestDate };
    } catch {
      // Fresh state.
    }
  }

  private persist(): void {
    try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  pendingCount(): number {
    return this.state.pending.length;
  }

  listDigests(): ReportingState['digests'] {
    return [...this.state.digests];
  }

  /**
   * A routine run completed on THIS (executing) side. Records the run as
   * sync activity, then sends or defers the instant notice per the
   * routine's reporting config. Failures always notify immediately.
   */
  async reportRun(args: { routine: BotRoutine; ok: boolean; error?: string; at?: number }): Promise<{ notified: boolean; deferred: boolean }> {
    const { routine, ok } = args;
    const at = args.at ?? this.now();
    try {
      this.deps.syncStore?.addActivity(
        'routine-run',
        { routineId: routine.id, routineName: routine.name, botId: routine.botId, ok, ...(args.error ? { error: args.error } : {}) },
        at,
        `routine-run-${routine.id}-${at}`,
      );
    } catch { /* activity record must never break reporting */ }
    const reporting = routine.reporting;
    const mode = reporting?.mode ?? 'instant';
    if (mode !== 'instant' && mode !== 'both') return { notified: false, deferred: false };
    const notice: RunNotice = {
      kind: ok ? 'done' : 'failed',
      botId: routine.botId,
      botName: routine.botId,
      title: ok ? `${routine.name} — done` : `${routine.name} — failed`,
      body: ok
        ? `Routine "${routine.name}" completed. Open KriyaDot to see the full result.`
        : `Routine "${routine.name}" failed${args.error ? `: ${args.error.slice(0, 200)}` : ''}. Open KriyaDot to investigate.`,
    };
    if (!ok || !inQuietHours(reporting, new Date(at))) {
      try { await this.deps.notify?.(notice); } catch { /* notifier is best-effort; the sync record is durable */ }
      return { notified: true, deferred: false };
    }
    this.state.pending.push({ ...notice, id: randomUUID(), routineId: routine.id, reporting, queuedAt: at });
    this.persist();
    return { notified: false, deferred: true };
  }

  /** Flush deferred notices whose quiet window has ended. Returns the count sent. */
  async flushPending(now = this.now()): Promise<number> {
    if (this.state.pending.length === 0) return 0;
    const keep: PendingNotice[] = [];
    let sent = 0;
    for (const p of this.state.pending) {
      if (inQuietHours(p.reporting, new Date(now))) {
        keep.push(p);
        continue;
      }
      try { await this.deps.notify?.(p); sent += 1; } catch { keep.push(p); }
    }
    this.state.pending = keep;
    this.persist();
    return sent;
  }

  /**
   * Cloud role, once per day: compose the digest of the day's
   * anchored-automation runs, store it as sync activity kind
   * 'daily-digest' (so it pulls to local) AND as a local record here.
   * Returns the digest payload, or null when already created today or
   * there were no runs to summarize.
   */
  maybeCreateDailyDigest(args: {
    date: string; // YYYY-MM-DD (caller's local day)
    runs: Array<{ routineId: string; routineName: string; status: string; error?: string | null }>;
    now?: number;
  }): { date: string; total: number; succeeded: number; failed: number; summary: string } | null {
    if (this.state.lastDigestDate === args.date) return null;
    if (args.runs.length === 0) return null;
    const succeeded = args.runs.filter((r) => r.status === 'succeeded').length;
    const failed = args.runs.filter((r) => r.status === 'failed').length;
    const names = [...new Set(args.runs.map((r) => r.routineName))].slice(0, 10);
    const payload = {
      date: args.date,
      total: args.runs.length,
      succeeded,
      failed,
      summary: `${args.runs.length} automation run(s) on ${args.date}: ${succeeded} succeeded, ${failed} failed. Routines: ${names.join(', ')}.`,
      runs: args.runs.map((r) => ({ routineId: r.routineId, routineName: r.routineName, status: r.status, ...(r.error ? { error: r.error } : {}) })),
    };
    const now = args.now ?? this.now();
    try {
      this.deps.syncStore?.addActivity('daily-digest', payload, now, `daily-digest-${args.date}`);
    } catch { /* local record below still lands */ }
    this.state.lastDigestDate = args.date;
    this.state.digests.push({ date: args.date, createdAt: now, payload });
    this.persist();
    return payload;
  }
}

// ---------------------------------------------------------------------------
// Placement routes
// ---------------------------------------------------------------------------

export interface PlacementRouteDeps {
  dataDir: string;
  store?: PlacementStore;
  loopbackToken?: string;
  jwtSecret?: string;
  getBots?: () => Array<{ id: string; name?: string }>;
  /** Routines belonging to a bot (for the flip push + active-run check). */
  getRoutinesForBot?: (botId: string) => BotRoutine[];
  hasActiveRunForBot?: (botId: string) => boolean;
  isSyncConfigured?: () => boolean;
  /** Push a placement change to the instance (sync client). Throws on failure. */
  pushPlacement?: (args: { botId: string; bot: unknown; placement: BotPlacement; executorHere: boolean; routines: BotRoutine[] }) => Promise<void>;
  role?: InstanceRole;
  cloudConnected?: () => boolean;
}

export function createPlacementRouter(deps: PlacementRouteDeps): Router {
  const router = express.Router();
  const store = deps.store ?? new PlacementStore(deps.dataDir);
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
  const role = deps.role ?? instanceRole();
  const syncConfigured = () => deps.isSyncConfigured?.() ?? false;

  router.get('/placement', (req: Request, res: Response) => {
    if (!requirePrincipal(req, res, pctx)) return;
    res.json({
      ok: true,
      role,
      syncConfigured: syncConfigured(),
      cloudConnected: deps.cloudConnected?.() ?? syncConfigured(),
      default: store.getDefault(),
      bots: store.listBots(),
    });
  });

  router.put('/placement/default', (req: Request, res: Response) => {
    if (!requirePrincipal(req, res, pctx)) return;
    const body = (req.body ?? {}) as { placement?: unknown; localOnly?: unknown };
    const patch: Partial<BotPlacementRecord> = {};
    if (body.placement === 'local' || body.placement === 'cloud-report' || body.placement === 'cloud-only') patch.placement = body.placement;
    if (typeof body.localOnly === 'boolean') patch.localOnly = body.localOnly;
    res.json({ ok: true, default: store.setDefault(patch) });
  });

  router.get('/placement/bots/:botId', (req: Request, res: Response) => {
    if (!requirePrincipal(req, res, pctx)) return;
    res.json({ ok: true, botId: req.params.botId, ...store.getBot(req.params.botId), role, syncConfigured: syncConfigured() });
  });

  router.put('/placement/bots/:botId', async (req: Request, res: Response) => {
    if (!requirePrincipal(req, res, pctx)) return;
    const botId = req.params.botId;
    const body = (req.body ?? {}) as { placement?: unknown; localOnly?: unknown };
    const hasPlacement = body.placement !== undefined;
    const placement = body.placement;
    if (hasPlacement && placement !== 'local' && placement !== 'cloud-report' && placement !== 'cloud-only') {
      res.status(400).json({ ok: false, error: 'placement must be local | cloud-report | cloud-only' });
      return;
    }
    if (body.localOnly !== undefined && typeof body.localOnly !== 'boolean') {
      res.status(400).json({ ok: false, error: 'localOnly must be a boolean' });
      return;
    }
    const current = store.getBot(botId);
    const placementChanging = hasPlacement && placement !== current.placement;

    // localOnly toggles are independent of placement flips.
    if (!placementChanging) {
      const rec = store.setBot(botId, { ...(typeof body.localOnly === 'boolean' ? { localOnly: body.localOnly } : {}) });
      res.json({ ok: true, botId, ...rec, role, syncConfigured: syncConfigured() });
      return;
    }

    const target = placement as BotPlacement;
    if (target !== 'local') {
      // Flip to a cloud placement: clean boundary + executor push first.
      if (!syncConfigured()) {
        res.status(409).json({ ok: false, error: 'cloud-not-connected' });
        return;
      }
      if (deps.hasActiveRunForBot?.(botId)) {
        res.status(409).json({ ok: false, error: 'run-in-flight' });
        return;
      }
      try {
        const bot = deps.getBots?.().find((b) => b.id === botId);
        await deps.pushPlacement?.({ botId, bot, placement: target, executorHere: true, routines: deps.getRoutinesForBot?.(botId) ?? [] });
      } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'failed to push placement to the cloud instance' });
        return;
      }
    } else if (syncConfigured() && deps.pushPlacement) {
      // Flip back to local: tell the instance it is no longer the executor.
      try {
        const bot = deps.getBots?.().find((b) => b.id === botId);
        await deps.pushPlacement({ botId, bot, placement: target, executorHere: false, routines: deps.getRoutinesForBot?.(botId) ?? [] });
      } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'failed to push placement to the cloud instance' });
        return;
      }
    }
    const rec = store.setBot(botId, {
      placement: target,
      ...(typeof body.localOnly === 'boolean' ? { localOnly: body.localOnly } : {}),
    });
    res.json({ ok: true, botId, ...rec, role, syncConfigured: syncConfigured() });
  });

  return router;
}

/** Scan routine + run stores: any queued/running run for any of the bot's routines. */
export function hasActiveRunForBot(args: {
  routines: BotRoutine[];
  listRunsByRoutine: (routineId: string, limit: number) => Array<{ status: string }>;
  botId: string;
}): boolean {
  for (const r of args.routines) {
    if (r.botId !== args.botId) continue;
    const runs = args.listRunsByRoutine(r.id, 20);
    if (runs.some((run) => run.status === 'queued' || run.status === 'running')) return true;
  }
  return false;
}
