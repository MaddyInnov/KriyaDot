// SPDX-License-Identifier: Apache-2.0
// Runtime telemetry ("eyes for your AI"): per-step latency, error/retry
// rates, and token cost per bot turn / workflow run, captured in a bounded
// in-memory ring buffer and exposed read-only (MCP resources, /_kriyadot/).
//
// Privacy posture: only metadata-tier fields are ever recorded (ids,
// names, counts, timings, token totals). Every ingestion passes through an
// injected guard — the API server wires the privacy-tiers
// `sanitizeTelemetry()` guard, which normalizes route/screen/bot names to
// id-templates and REFUSES payloads carrying bodies/headers/cookies/query
// values (dropped with a warning, never stored). Internal producers
// (AgentRuntime, WorkflowRunner) emit only typed scalar fields, so they are
// safe by construction; the guard still runs over their metadata.
//
// Cost reuses the existing pricing (costOfUsage) — no duplicate tracking.

import { costOfUsage } from './pricing.js';
import { emptyUsage, type TokenUsage } from './types.js';

export type TelemetryRunKind = 'bot-turn' | 'workflow-run';
export type TelemetryStepKind = 'llm' | 'tool' | 'node' | 'approval' | 'http' | 'other';
export type TelemetryRunStatus = 'ok' | 'error' | 'interrupted';

export interface TelemetryStepRecord {
  name: string;
  kind: TelemetryStepKind;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  retries: number;
  errorKind?: string;
}

export interface TelemetryRunRecord {
  id: string;
  kind: TelemetryRunKind;
  botId?: string;
  workflowId?: string;
  sessionId?: string;
  route?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TelemetryRunStatus | 'running';
  iterations?: number;
  steps: TelemetryStepRecord[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  errors: number;
  retries: number;
  providerId?: string;
  model?: string;
}

/** Result of the injected ingestion guard (matches sanitizeTelemetry). */
export interface TelemetryGuardResult {
  accepted: boolean;
  sanitized?: Record<string, unknown>;
  reason?: string;
  droppedFields?: string[];
}

/**
 * Ingestion guard: receives the run metadata object, returns whether it may
 * be stored and (optionally) a sanitized/normalized copy. The API server
 * injects the privacy-tiers `sanitizeTelemetry()` guard here; the runtime
 * package keeps its type-only relationship with @mvp/governance.
 */
export type TelemetryGuard = (payload: Record<string, unknown>) => TelemetryGuardResult;

export type TelemetryWarnFn = (message: string, detail: Record<string, unknown>) => void;

export interface BeginRunMeta {
  /** Explicit id (workflow runs key by runId so resume reuses the record). */
  id?: string;
  kind: TelemetryRunKind;
  botId?: string;
  workflowId?: string;
  sessionId?: string;
  route?: string;
}

export interface EndRunOutcome {
  status: TelemetryRunStatus;
  usage?: TokenUsage;
  providerId?: string;
  model?: string;
  iterations?: number;
}

/** Handle for one in-flight step. Call end() exactly once. */
export interface TelemetryStepHandle {
  end(outcome?: { ok?: boolean; errorKind?: string }): void;
}

export interface TelemetrySummary {
  /** Completed runs currently in the window. */
  windowRuns: number;
  inflight: number;
  ok: number;
  errors: number;
  /** errors / windowRuns (0 when empty). */
  errorRate: number;
  /** Total retry events observed. */
  retries: number;
  /** Share of runs that retried at least once. */
  retryRate: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  byKind: Record<TelemetryRunKind, { runs: number; errors: number; avgLatencyMs: number }>;
}

export interface TelemetryBotSummary {
  id: string;
  runs: number;
  errors: number;
  errorRate: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  lastSeenAt: number | null;
}

export interface ListRunsFilter {
  limit?: number;
  botId?: string;
  kind?: TelemetryRunKind;
}

/**
 * Read-only telemetry surface consumed by the platform MCP server
 * (kriyadot://telemetry/* resources). Structural — TelemetryCollector
 * satisfies it without importing the MCP server.
 */
export interface TelemetryResourceProvider {
  listRuns(limit?: number): unknown;
  getRun(id: string): unknown | null;
  listBots(): unknown;
  getBotSummary(id: string): unknown | null;
  summary(): unknown;
}

const DEFAULT_MAX_RUNS = 500;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

function newRunId(kind: TelemetryRunKind): string {
  return `${kind === 'bot-turn' ? 'turn' : 'wfrun'}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * In-memory telemetry collector. Bounded (ring buffer, default 500 runs);
 * synchronous; never throws into producers (guard failures refuse the
 * payload fail-closed instead).
 */
export class TelemetryCollector implements TelemetryResourceProvider {
  private readonly maxRuns: number;
  private readonly guard?: TelemetryGuard;
  private readonly warn: TelemetryWarnFn;
  private readonly runs = new Map<string, TelemetryRunRecord>();
  /** Insertion order for eviction + newest-first listing. */
  private readonly order: string[] = [];

  constructor(opts?: { maxRuns?: number; guard?: TelemetryGuard; warn?: TelemetryWarnFn }) {
    this.maxRuns = Math.max(1, opts?.maxRuns ?? DEFAULT_MAX_RUNS);
    this.guard = opts?.guard;
    this.warn = opts?.warn ?? ((message, detail) => console.warn(`[telemetry] ${message}`, detail));
  }

  /**
   * Begin a run record. Returns the run id, or null when the ingestion
   * guard refused the metadata (dropped with a warning, never stored).
   * An explicit `id` that is already in-flight reuses the existing record
   * (workflow resume must not double-count).
   */
  beginRun(meta: BeginRunMeta): string | null {
    const raw: Record<string, unknown> = {
      kind: meta.kind,
      botId: meta.botId,
      workflowId: meta.workflowId,
      sessionId: meta.sessionId,
      route: meta.route,
    };
    let fields = raw;
    if (this.guard) {
      let checked: TelemetryGuardResult;
      try {
        checked = this.guard(raw);
      } catch (err) {
        // Fail closed: a throwing guard refuses the payload.
        this.warn('telemetry run refused (guard threw)', {
          reason: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      if (!checked.accepted) {
        this.warn('telemetry run refused', {
          reason: checked.reason ?? 'rejected by ingestion guard',
          droppedFields: checked.droppedFields ?? [],
        });
        return null;
      }
      if (checked.sanitized) fields = checked.sanitized;
    }
    const requestedId = asString(meta.id);
    if (requestedId) {
      const existing = this.runs.get(requestedId);
      // Reuse only in-flight records; a terminal record with the same id is
      // a different incarnation (shouldn't happen — ids are unique).
      if (existing && existing.status === 'running') return requestedId;
    }
    const id = requestedId ?? newRunId(meta.kind);
    const record: TelemetryRunRecord = {
      id,
      kind: meta.kind,
      botId: asString(fields['botId']),
      workflowId: asString(fields['workflowId']),
      sessionId: asString(fields['sessionId']),
      route: asString(fields['route']),
      startedAt: Date.now(),
      status: 'running',
      steps: [],
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      errors: 0,
      retries: 0,
    };
    this.runs.set(id, record);
    this.order.push(id);
    this.evictOverflow();
    return id;
  }

  /** Start a timed step on a run. Returns null for unknown/refused runs. */
  startStep(runId: string, name: string, kind: TelemetryStepKind): TelemetryStepHandle | null {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return null;
    const startedAt = Date.now();
    let ended = false;
    return {
      end: (outcome) => {
        if (ended) return;
        ended = true;
        const ok = outcome?.ok ?? true;
        run.steps.push({
          name,
          kind,
          startedAt,
          durationMs: Date.now() - startedAt,
          ok,
          retries: 0,
          ...(ok ? {} : { errorKind: outcome?.errorKind ?? 'error' }),
        });
        if (!ok) run.errors += 1;
      },
    };
  }

  /** Record one retry event against a run (e.g. provider fetch retry). */
  noteRetry(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;
    run.retries += 1;
  }

  /** Close a run record. Unknown ids are ignored. */
  endRun(runId: string, outcome: EndRunOutcome): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;
    const usage = outcome.usage ?? emptyUsage();
    let costUsd = 0;
    try {
      // Reuse the existing pricing — no duplicate cost tracking.
      costUsd = costOfUsage(outcome.providerId ?? 'unknown', outcome.model ?? 'unknown', usage).total;
    } catch {
      costUsd = 0;
    }
    run.status = outcome.status;
    if (run.status !== 'ok') run.errors += 1;
    run.endedAt = Date.now();
    run.durationMs = run.endedAt - run.startedAt;
    run.iterations = outcome.iterations;
    run.promptTokens = usage.promptTokens;
    run.completionTokens = usage.completionTokens;
    run.totalTokens = usage.totalTokens;
    run.costUsd = costUsd;
    run.providerId = outcome.providerId;
    run.model = outcome.model;
  }

  getRun(id: string): TelemetryRunRecord | null {
    return this.runs.get(id) ?? null;
  }

  /** Newest first. Accepts a bare limit or a filter object. */
  listRuns(filter?: number | ListRunsFilter): TelemetryRunRecord[] {
    const f: ListRunsFilter = typeof filter === 'number' ? { limit: filter } : (filter ?? {});
    const limit = Math.max(1, f.limit ?? 50);
    const out: TelemetryRunRecord[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const run = this.runs.get(this.order[i]!);
      if (!run) continue;
      if (f.botId !== undefined && run.botId !== f.botId) continue;
      if (f.kind !== undefined && run.kind !== f.kind) continue;
      out.push(run);
    }
    return out;
  }

  /** In-flight (not yet ended) runs, newest first. */
  listInflight(limit = 50): TelemetryRunRecord[] {
    const out: TelemetryRunRecord[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const run = this.runs.get(this.order[i]!);
      if (run && run.status === 'running') out.push(run);
    }
    return out;
  }

  inflightCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.status === 'running') n += 1;
    return n;
  }

  /** Aggregate stats over completed runs in the window. */
  summary(): TelemetrySummary {
    const completed = [...this.runs.values()].filter((r) => r.status !== 'running');
    const latencies = completed
      .map((r) => r.durationMs ?? 0)
      .sort((a, b) => a - b);
    const ok = completed.filter((r) => r.status === 'ok').length;
    const errors = completed.length - ok;
    const retried = completed.filter((r) => r.retries > 0).length;
    const byKind = {
      'bot-turn': { runs: 0, errors: 0, avgLatencyMs: 0 },
      'workflow-run': { runs: 0, errors: 0, avgLatencyMs: 0 },
    } satisfies Record<TelemetryRunKind, { runs: number; errors: number; avgLatencyMs: number }>;
    const kindLatency: Record<TelemetryRunKind, number> = { 'bot-turn': 0, 'workflow-run': 0 };
    for (const r of completed) {
      const bucket = byKind[r.kind];
      bucket.runs += 1;
      if (r.status !== 'ok') bucket.errors += 1;
      kindLatency[r.kind] += r.durationMs ?? 0;
    }
    for (const k of Object.keys(byKind) as TelemetryRunKind[]) {
      byKind[k].avgLatencyMs = byKind[k].runs > 0 ? kindLatency[k] / byKind[k].runs : 0;
    }
    return {
      windowRuns: completed.length,
      inflight: this.inflightCount(),
      ok,
      errors,
      errorRate: completed.length > 0 ? errors / completed.length : 0,
      retries: completed.reduce((n, r) => n + r.retries, 0),
      retryRate: completed.length > 0 ? retried / completed.length : 0,
      totalTokens: completed.reduce((n, r) => n + r.totalTokens, 0),
      totalCostUsd: completed.reduce((n, r) => n + r.costUsd, 0),
      avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      byKind,
    };
  }

  /** Per-bot aggregates over completed runs (workflow runs key by workflow:…). */
  botSummaries(): TelemetryBotSummary[] {
    const byId = new Map<string, TelemetryBotSummary & { latencySum: number }>();
    for (const r of this.runs.values()) {
      if (r.status === 'running') continue;
      const id = r.botId ?? (r.workflowId ? `workflow:${r.workflowId}` : 'unknown');
      let agg = byId.get(id);
      if (!agg) {
        agg = {
          id,
          runs: 0,
          errors: 0,
          errorRate: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          avgLatencyMs: 0,
          lastSeenAt: null,
          latencySum: 0,
        };
        byId.set(id, agg);
      }
      agg.runs += 1;
      if (r.status !== 'ok') agg.errors += 1;
      agg.totalTokens += r.totalTokens;
      agg.totalCostUsd += r.costUsd;
      agg.latencySum += r.durationMs ?? 0;
      if (agg.lastSeenAt === null || r.startedAt > agg.lastSeenAt) agg.lastSeenAt = r.startedAt;
    }
    return [...byId.values()]
      .map(({ latencySum, ...rest }) => ({
        ...rest,
        errorRate: rest.runs > 0 ? rest.errors / rest.runs : 0,
        avgLatencyMs: rest.runs > 0 ? latencySum / rest.runs : 0,
      }))
      .sort((a, b) => b.runs - a.runs);
  }

  // -- TelemetryResourceProvider (MCP read-only surface) ---------------------

  listBots(): unknown {
    return this.botSummaries();
  }

  getBotSummary(id: string): unknown | null {
    return this.botSummaries().find((b) => b.id === id) ?? null;
  }

  private evictOverflow(): void {
    while (this.order.length > this.maxRuns) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      const run = this.runs.get(oldest);
      // Never evict in-flight runs — drop the oldest COMPLETED run instead.
      if (run && run.status === 'running') {
        this.order.push(oldest);
        const victim = this.order.find((id) => {
          const r = this.runs.get(id);
          return r !== undefined && r.status !== 'running';
        });
        if (!victim) break;
        this.order.splice(this.order.indexOf(victim), 1);
        this.runs.delete(victim);
      } else {
        this.runs.delete(oldest);
      }
    }
  }
}
