// SPDX-License-Identifier: Apache-2.0
// Resource guard + self-monitoring (B3, Timon parity programme).
//
// WHY THIS EXISTS
// Timon-class orchestrators carry Linux server utilities for keeping a
// long-lived daemon inside its resource envelope (systemd units, cgroup
// limits, journald plumbing). KriyaDot is desktop-first and local-first —
// hosting is PARKED (users self-host on their own VPS; there is no
// KriyaDot-operated daemon to protect with OS machinery), so the OS-level
// parts are deliberately NOT built (see the B3 log for the full list).
// What survives translation to a Node desktop/server process is the
// protective substance, and that is what lives here:
//
//   1. Sample the pressure signals Node exposes portably — process RSS,
//      event-loop lag (perf_hooks), and free disk on the data-dir
//      filesystem (fs.statfs) — on every OS the packaged binary ships to.
//   2. React in graded, honest steps. Soft pressure → an audit/health
//      event and a log line. Hard pressure → SHED LOAD: refuse to start
//      NEW optional work (scheduled routine fires, limit-reset resumes)
//      with a clear, measured reason, until pressure clears.
//   3. Never kill, cancel, or preempt in-flight user work, and never
//      terminate the process. The guard holds no handles to live runs —
//      shedding is a gate checked BEFORE work starts, so in-flight work
//      is untouched by construction, not by careful bookkeeping.
//
// REJECTED ALTERNATIVES
// - Extending the Sentinel (sentinel.ts): Sentinel is a point-in-time
//   checklist ("is anything broken right now?") with no memory, no
//   graded reaction, and no consumer for a shed decision. The guard is
//   the complementary piece: a trend-keeping state machine whose whole
//   output is a decision other subsystems consult. Thresholds are
//   deliberately aligned with Sentinel's (warn 1.5 GB / fail 2.5 GB RSS,
//   disk warn < 1 GB / fail < 200 MB free) so the app speaks ONE pressure
//   language instead of two disagreeing ones.
// - OS enforcement (cgroups / Job Objects / rlimits): not portable from
//   a Node binary, and unnecessary at desktop scale. This guard is a
//   seatbelt, not a cage — it cannot see other processes' pressure or a
//   container's true cgroup ceiling, and it says so wherever it reports.
//
// DEFAULTS (posture): monitoring ON, shedding ON but conservative.
// Self-checks already run by default in this codebase (Sentinel), and a
// guard that only watches is the Sentinel again — the protective value
// is the shed. The hard thresholds sit at the levels Sentinel already
// calls failures, so shedding begins only where the app already agrees
// something is wrong; everything below that is audit-only.
//
// SETTINGS (existing patterns — persisted file wins, then env, then
// defaults; same shape as analytics-settings.ts / egress-settings.ts):
//   <dataDir>/resource-guard-settings.json
//   KRIYADOT_RESOURCE_GUARD=0            → guard off entirely (no-op)
//   KRIYADOT_RESOURCE_GUARD_SHED=0      → monitor + audit, never shed
//   KRIYADOT_RESOURCE_GUARD_MEM_SOFT_MB / _MEM_HARD_MB
//   KRIYADOT_RESOURCE_GUARD_LAG_SOFT_MS / _LAG_HARD_MS
//   KRIYADOT_RESOURCE_GUARD_DISK_SOFT_MB / _DISK_HARD_MB  (free-space floor)
//   KRIYADOT_RESOURCE_GUARD_INTERVAL_MS  (sample interval)
//
// AUDIT: every guard action goes through the injected audit function
// (the governance idiom — governance.audit in the host) with the
// measured values attached: resource_guard.soft_pressure,
// resource_guard.shedding_started, resource_guard.hard_pressure (hard
// pressure while shedding is disabled), resource_guard.work_shed (one
// entry per refused start), resource_guard.shedding_cleared /
// resource_guard.recovered. Audit failures are swallowed — the guard
// must never break the host it protects.

import { readFileSync, writeFileSync, mkdirSync, renameSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ResourceGuardSettings {
  /** Master switch. Off ⇒ the guard samples nothing and allows all work. */
  enabled: boolean;
  /** When false, hard pressure is audited but no work is ever refused. */
  shedEnabled: boolean;
  /** RSS at/above which pressure is "soft" (audit + health event). */
  memorySoftBytes: number;
  /** RSS at/above which pressure is "hard" (shed new optional work). */
  memoryHardBytes: number;
  /** Mean event-loop lag (ms) at/above which pressure is soft. */
  eventLoopLagSoftMs: number;
  /** Mean event-loop lag (ms) at/above which pressure is hard. */
  eventLoopLagHardMs: number;
  /** Free disk on the data-dir filesystem at/below which pressure is soft. */
  diskSoftFreeBytes: number;
  /** Free disk at/below which pressure is hard. */
  diskHardFreeBytes: number;
  /** Sampling interval for the background timer. */
  sampleIntervalMs: number;
}

const MB = 1024 * 1024;

export const RESOURCE_GUARD_DEFAULTS: ResourceGuardSettings = {
  enabled: true,
  shedEnabled: true,
  // Aligned with Sentinel's memory warn/fail (1.5 GB / 2.5 GB RSS).
  memorySoftBytes: 1.5 * 1024 * MB,
  memoryHardBytes: 2.5 * 1024 * MB,
  // A healthy loop idles at single-digit ms lag; 100 ms mean lag is a
  // visibly janky process, 500 ms is a process that cannot keep up.
  eventLoopLagSoftMs: 100,
  eventLoopLagHardMs: 500,
  // Aligned with Sentinel's disk warn/fail (free < 1 GB / free < 200 MB).
  diskSoftFreeBytes: 1024 * MB,
  diskHardFreeBytes: 200 * MB,
  sampleIntervalMs: 30_000,
};

const SETTINGS_FILE = 'resource-guard-settings.json';

export function resourceGuardSettingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE);
}

function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (!v) return undefined;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = (env[name] ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Coerce arbitrary input into valid settings. Invariants enforced here so
 * no caller can create a guard whose hard threshold fires before its soft
 * one: memory/lag hard > soft; disk hard floor < soft floor; the sample
 * interval is clamped to [1s, 10min] so a typo can't busy-loop the host.
 */
export function sanitizeResourceGuardSettings(
  input: unknown,
  base: ResourceGuardSettings = RESOURCE_GUARD_DEFAULTS,
): ResourceGuardSettings {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const out: ResourceGuardSettings = {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    shedEnabled: typeof o.shedEnabled === 'boolean' ? o.shedEnabled : base.shedEnabled,
    memorySoftBytes: positiveOr(o.memorySoftBytes, base.memorySoftBytes),
    memoryHardBytes: positiveOr(o.memoryHardBytes, base.memoryHardBytes),
    eventLoopLagSoftMs: positiveOr(o.eventLoopLagSoftMs, base.eventLoopLagSoftMs),
    eventLoopLagHardMs: positiveOr(o.eventLoopLagHardMs, base.eventLoopLagHardMs),
    diskSoftFreeBytes: positiveOr(o.diskSoftFreeBytes, base.diskSoftFreeBytes),
    diskHardFreeBytes: positiveOr(o.diskHardFreeBytes, base.diskHardFreeBytes),
    sampleIntervalMs: positiveOr(o.sampleIntervalMs, base.sampleIntervalMs),
  };
  if (out.memoryHardBytes <= out.memorySoftBytes) out.memoryHardBytes = Math.ceil(out.memorySoftBytes * 1.5);
  if (out.eventLoopLagHardMs <= out.eventLoopLagSoftMs) out.eventLoopLagHardMs = out.eventLoopLagSoftMs * 2;
  if (out.diskHardFreeBytes >= out.diskSoftFreeBytes) out.diskHardFreeBytes = Math.floor(out.diskSoftFreeBytes / 2);
  out.sampleIntervalMs = Math.min(10 * 60_000, Math.max(1_000, Math.floor(out.sampleIntervalMs)));
  return out;
}

/** Boot-time settings: persisted file first, then env, then defaults. */
export function loadResourceGuardSettings(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ResourceGuardSettings {
  let persisted: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(resourceGuardSettingsPath(dataDir), 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      persisted = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing/corrupt file ⇒ env + defaults (same posture as the other
    // settings modules: a broken settings file must never block boot).
  }
  const fromEnv: Record<string, unknown> = {};
  const enabled = envBool(env, 'KRIYADOT_RESOURCE_GUARD');
  if (enabled !== undefined) fromEnv.enabled = enabled;
  const shed = envBool(env, 'KRIYADOT_RESOURCE_GUARD_SHED');
  if (shed !== undefined) fromEnv.shedEnabled = shed;
  const memSoft = envNumber(env, 'KRIYADOT_RESOURCE_GUARD_MEM_SOFT_MB');
  if (memSoft !== undefined) fromEnv.memorySoftBytes = memSoft * MB;
  const memHard = envNumber(env, 'KRIYADOT_RESOURCE_GUARD_MEM_HARD_MB');
  if (memHard !== undefined) fromEnv.memoryHardBytes = memHard * MB;
  const lagSoft = envNumber(env, 'KRIYADOT_RESOURCE_GUARD_LAG_SOFT_MS');
  if (lagSoft !== undefined) fromEnv.eventLoopLagSoftMs = lagSoft;
  const lagHard = envNumber(env, 'KRIYADOT_RESOURCE_GUARD_LAG_HARD_MS');
  if (lagHard !== undefined) fromEnv.eventLoopLagHardMs = lagHard;
  const diskSoft = envNumber(env, 'KRIYADOT_RESOURCE_GUARD_DISK_SOFT_MB');
  if (diskSoft !== undefined) fromEnv.diskSoftFreeBytes = diskSoft * MB;
  const diskHard = envNumber(env, 'KRIYADOT_RESOURCE_GUARD_DISK_HARD_MB');
  if (diskHard !== undefined) fromEnv.diskHardFreeBytes = diskHard * MB;
  const interval = envNumber(env, 'KRIYADOT_RESOURCE_GUARD_INTERVAL_MS');
  if (interval !== undefined) fromEnv.sampleIntervalMs = interval;
  // sanitize over defaults with env applied, then persisted fields win.
  const envApplied = sanitizeResourceGuardSettings(fromEnv, RESOURCE_GUARD_DEFAULTS);
  return sanitizeResourceGuardSettings({ ...envApplied, ...persisted }, envApplied);
}

export function saveResourceGuardSettings(dataDir: string, settings: ResourceGuardSettings): ResourceGuardSettings {
  const clean = sanitizeResourceGuardSettings(settings);
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${resourceGuardSettingsPath(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  renameSync(tmp, resourceGuardSettingsPath(dataDir));
  return clean;
}

// ---------------------------------------------------------------------------
// Pressure sampling (injectable — tests simulate pressure, never cause it)
// ---------------------------------------------------------------------------

export interface PressureSample {
  at: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** Mean event-loop lag since the previous sample, ms. */
  eventLoopLagMs: number;
  /** Free bytes on the data-dir filesystem; null when not measurable. */
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
}

export interface PressureSampler {
  sample(): PressureSample;
  close?(): void;
}

/** Production sampler: Node builtins only, so the packaged binary works. */
export class NodePressureSampler implements PressureSampler {
  private readonly histogram: IntervalHistogram;

  constructor(private readonly dataDir: string) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
  }

  sample(): PressureSample {
    const mem = process.memoryUsage();
    // Mean lag since the last sample (reset makes each sample a window,
    // not a lifetime average that would hide a fresh stall).
    const lagMs = this.histogram.mean / 1e6;
    this.histogram.reset();
    let diskFreeBytes: number | null = null;
    let diskTotalBytes: number | null = null;
    try {
      const st = statfsSync(this.dataDir);
      diskFreeBytes = Number(st.bfree) * Number(st.bsize);
      diskTotalBytes = Number(st.blocks) * Number(st.bsize);
    } catch {
      // Filesystem not measurable from here (rare) — the signal reports
      // null and the guard treats it as "no reading", never as pressure.
    }
    return {
      at: Date.now(),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      eventLoopLagMs: Number.isFinite(lagMs) ? lagMs : 0,
      diskFreeBytes,
      diskTotalBytes,
    };
  }

  close(): void {
    this.histogram.disable();
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type PressureLevel = 'ok' | 'soft' | 'hard';

export interface SignalEvaluation {
  signal: 'memory' | 'eventLoopLag' | 'disk';
  level: PressureLevel;
  /** The measured value in the signal's unit (bytes, ms, free bytes). */
  measured: number | null;
  detail: string;
}

export interface GuardEvaluation {
  at: number;
  level: PressureLevel;
  signals: SignalEvaluation[];
}

const LEVEL_RANK: Record<PressureLevel, number> = { ok: 0, soft: 1, hard: 2 };

function fmtMb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

export function evaluateSample(sample: PressureSample, settings: ResourceGuardSettings): GuardEvaluation {
  const signals: SignalEvaluation[] = [];

  const memLevel: PressureLevel =
    sample.rssBytes >= settings.memoryHardBytes ? 'hard' : sample.rssBytes >= settings.memorySoftBytes ? 'soft' : 'ok';
  signals.push({
    signal: 'memory',
    level: memLevel,
    measured: sample.rssBytes,
    detail: `RSS ${fmtMb(sample.rssBytes)} (soft at ${fmtMb(settings.memorySoftBytes)}, hard at ${fmtMb(settings.memoryHardBytes)})`,
  });

  const lagLevel: PressureLevel =
    sample.eventLoopLagMs >= settings.eventLoopLagHardMs
      ? 'hard'
      : sample.eventLoopLagMs >= settings.eventLoopLagSoftMs
        ? 'soft'
        : 'ok';
  signals.push({
    signal: 'eventLoopLag',
    level: lagLevel,
    measured: sample.eventLoopLagMs,
    detail: `event-loop lag ${sample.eventLoopLagMs.toFixed(1)} ms mean (soft at ${settings.eventLoopLagSoftMs} ms, hard at ${settings.eventLoopLagHardMs} ms)`,
  });

  if (sample.diskFreeBytes === null) {
    signals.push({ signal: 'disk', level: 'ok', measured: null, detail: 'disk free space not measurable from this process' });
  } else {
    const diskLevel: PressureLevel =
      sample.diskFreeBytes <= settings.diskHardFreeBytes
        ? 'hard'
        : sample.diskFreeBytes <= settings.diskSoftFreeBytes
          ? 'soft'
          : 'ok';
    signals.push({
      signal: 'disk',
      level: diskLevel,
      measured: sample.diskFreeBytes,
      detail: `disk free ${fmtMb(sample.diskFreeBytes)} on the data-dir filesystem (soft at ${fmtMb(settings.diskSoftFreeBytes)} free, hard at ${fmtMb(settings.diskHardFreeBytes)} free)`,
    });
  }

  const level = signals.reduce<PressureLevel>(
    (worst, s) => (LEVEL_RANK[s.level] > LEVEL_RANK[worst] ? s.level : worst),
    'ok',
  );
  return { at: sample.at, level, signals };
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export type GuardAuditFn = (action: string, fields: { actor?: string; detail?: unknown }) => void;

export interface OptionalWorkDecision {
  allowed: boolean;
  /** Present when allowed is false: the measured, human-readable reason. */
  reason?: string;
}

export interface MemoryTrend {
  samples: number;
  windowMs: number;
  rssDeltaBytes: number;
  rssSlopeBytesPerMinute: number;
  rssMinBytes: number | null;
  rssMaxBytes: number | null;
}

export interface ResourceGuardState {
  enabled: boolean;
  shedEnabled: boolean;
  level: PressureLevel;
  /** True only while hard pressure is actively refusing new optional work. */
  shedding: boolean;
  settings: ResourceGuardSettings;
  lastSample: PressureSample | null;
  lastEvaluation: GuardEvaluation | null;
  memoryTrend: MemoryTrend;
  denialCount: number;
  lastDenial: { at: number; kind: string; reason: string } | null;
}

const HISTORY_LIMIT = 120;

export interface ResourceGuardDeps {
  settings: ResourceGuardSettings;
  sampler: PressureSampler;
  audit?: GuardAuditFn;
  log?: (message: string) => void;
}

export class ResourceGuard {
  private settings: ResourceGuardSettings;
  private readonly sampler: PressureSampler;
  private readonly auditFn?: GuardAuditFn;
  private readonly log: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: PressureSample[] = [];
  private level: PressureLevel = 'ok';
  private shedding = false;
  private lastSample: PressureSample | null = null;
  private lastEvaluation: GuardEvaluation | null = null;
  private denialCount = 0;
  private lastDenial: { at: number; kind: string; reason: string } | null = null;

  constructor(deps: ResourceGuardDeps) {
    this.settings = deps.settings;
    this.sampler = deps.sampler;
    this.auditFn = deps.audit;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  get currentSettings(): ResourceGuardSettings {
    return this.settings;
  }

  private audit(action: string, detail: Record<string, unknown>): void {
    try {
      this.auditFn?.(action, { actor: 'resource-guard', detail });
    } catch {
      // Audit must never break the guard (or the host through it).
    }
  }

  /** Apply new settings live (the settings route calls this after saving). */
  updateSettings(next: ResourceGuardSettings): void {
    this.settings = sanitizeResourceGuardSettings(next, this.settings);
    if (this.shedding && (!this.settings.enabled || !this.settings.shedEnabled)) {
      this.shedding = false;
      this.audit('resource_guard.shedding_cleared', {
        reason: 'shedding disabled by settings change',
        lastSample: this.lastSample,
      });
    }
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      try {
        this.sampleNow();
      } catch {
        // The guard must never break the host it protects.
      }
    };
    this.timer = setInterval(tick, this.settings.sampleIntervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    this.stop();
    this.sampler.close?.();
  }

  /**
   * Take one sample and run the state machine. Returns the evaluation, or
   * null when the guard is disabled (disabled = true no-op: no history, no
   * audit, no state change).
   *
   * Transitions (each audited with the measured values):
   *   ok → soft        resource_guard.soft_pressure
   *   *  → hard        resource_guard.shedding_started (shed on) or
   *                    resource_guard.hard_pressure (monitor-only mode)
   *   shedding → ok    resource_guard.shedding_cleared (hysteresis: a dip
   *                    to soft does NOT resume work — flapping at the hard
   *                    boundary would start/stop routines every sample)
   *   soft → ok        resource_guard.recovered
   */
  sampleNow(): GuardEvaluation | null {
    if (!this.settings.enabled) return null;
    const sample = this.sampler.sample();
    this.lastSample = sample;
    this.history.push(sample);
    if (this.history.length > HISTORY_LIMIT) this.history = this.history.slice(-HISTORY_LIMIT);
    const evaluation = evaluateSample(sample, this.settings);
    this.lastEvaluation = evaluation;
    const prev = this.level;
    this.level = evaluation.level;

    if (LEVEL_RANK[evaluation.level] > LEVEL_RANK[prev]) {
      if (evaluation.level === 'hard') {
        if (this.settings.shedEnabled) {
          this.shedding = true;
          this.audit('resource_guard.shedding_started', { sample, evaluation });
          this.log(`[resource-guard] hard pressure — shedding new optional work: ${worstDetail(evaluation)}`);
        } else {
          this.audit('resource_guard.hard_pressure', { sample, evaluation, note: 'shedding disabled — monitoring only' });
          this.log(`[resource-guard] hard pressure (shedding disabled): ${worstDetail(evaluation)}`);
        }
      } else {
        this.audit('resource_guard.soft_pressure', { sample, evaluation });
        this.log(`[resource-guard] soft pressure: ${worstDetail(evaluation)}`);
      }
    } else if (this.shedding && evaluation.level === 'ok') {
      this.shedding = false;
      this.audit('resource_guard.shedding_cleared', { sample, evaluation });
      this.log('[resource-guard] pressure cleared — optional work resumes');
    } else if (prev !== 'ok' && evaluation.level === 'ok') {
      this.audit('resource_guard.recovered', { sample, evaluation });
    }
    return evaluation;
  }

  /**
   * The shed gate. Callers consult this BEFORE starting new optional work
   * (background/routine work). It never inspects, cancels, or signals
   * anything already running — there is deliberately no code path here
   * that can touch in-flight work.
   */
  checkOptionalWork(kind: string): OptionalWorkDecision {
    if (!this.settings.enabled || !this.shedding) return { allowed: true };
    const worst = this.lastEvaluation ? worstDetail(this.lastEvaluation) : 'resource pressure above the hard threshold';
    const reason =
      `Resource guard is shedding new optional work (${kind}): ${worst}. ` +
      'New optional work resumes automatically when pressure clears; work already in flight is not affected.';
    this.denialCount += 1;
    this.lastDenial = { at: Date.now(), kind, reason };
    this.audit('resource_guard.work_shed', { kind, reason, sample: this.lastSample, evaluation: this.lastEvaluation });
    return { allowed: false, reason };
  }

  memoryTrend(): MemoryTrend {
    const samples = this.history;
    if (samples.length === 0) {
      return { samples: 0, windowMs: 0, rssDeltaBytes: 0, rssSlopeBytesPerMinute: 0, rssMinBytes: null, rssMaxBytes: null };
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const windowMs = Math.max(0, last.at - first.at);
    const delta = last.rssBytes - first.rssBytes;
    return {
      samples: samples.length,
      windowMs,
      rssDeltaBytes: delta,
      rssSlopeBytesPerMinute: windowMs > 0 ? Math.round((delta / windowMs) * 60_000) : 0,
      rssMinBytes: Math.min(...samples.map((s) => s.rssBytes)),
      rssMaxBytes: Math.max(...samples.map((s) => s.rssBytes)),
    };
  }

  state(): ResourceGuardState {
    return {
      enabled: this.settings.enabled,
      shedEnabled: this.settings.shedEnabled,
      level: this.level,
      shedding: this.shedding,
      settings: this.settings,
      lastSample: this.lastSample,
      lastEvaluation: this.lastEvaluation,
      memoryTrend: this.memoryTrend(),
      denialCount: this.denialCount,
      lastDenial: this.lastDenial,
    };
  }
}

function worstDetail(evaluation: GuardEvaluation): string {
  const worst = evaluation.signals.filter((s) => s.level === evaluation.level);
  return worst.map((s) => s.detail).join('; ') || 'resource pressure';
}

// ---------------------------------------------------------------------------
// Self-monitoring snapshot (the A14 doctor seam — see resource-guard-routes)
// ---------------------------------------------------------------------------

export interface SelfSnapshotCounts {
  activeTurns?: number;
  runningWorkflowRuns?: number;
  routineRunsInFlight?: number;
  pendingApprovals?: number;
}

export interface SelfSnapshot {
  at: number;
  uptimeSeconds: number;
  process: {
    pid: number;
    rssBytes: number | null;
    heapUsedBytes: number | null;
    heapTotalBytes: number | null;
  };
  eventLoopLagMs: number | null;
  memoryTrend: MemoryTrend;
  counts: SelfSnapshotCounts;
  guard: ResourceGuardState;
}

/**
 * Assemble the self-monitoring snapshot from the guard's latest sample +
 * trend and whatever live counters the host already tracks (injected —
 * this module invents no counting of its own). Pure read: sampling is the
 * guard timer's job, so calling this never perturbs the measured process.
 */
export function buildSelfSnapshot(deps: {
  guard: ResourceGuard;
  counts?: SelfSnapshotCounts;
  now?: number;
}): SelfSnapshot {
  const state = deps.guard.state();
  const sample = state.lastSample;
  return {
    at: deps.now ?? Date.now(),
    uptimeSeconds: Math.round(process.uptime()),
    process: {
      pid: process.pid,
      rssBytes: sample?.rssBytes ?? null,
      heapUsedBytes: sample?.heapUsedBytes ?? null,
      heapTotalBytes: sample?.heapTotalBytes ?? null,
    },
    eventLoopLagMs: sample?.eventLoopLagMs ?? null,
    memoryTrend: state.memoryTrend,
    counts: deps.counts ?? {},
    guard: state,
  };
}
