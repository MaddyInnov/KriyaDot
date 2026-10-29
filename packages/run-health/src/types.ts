// SPDX-License-Identifier: Apache-2.0
// Shared types for run health scoring (feature #2) and regression detection
// (feature #5). Pure data shapes — no I/O, no network, no secrets.

/** Health verdict for a workflow run or a bot turn. */
export type HealthScore = 'good' | 'needs-work' | 'poor';

/** Machine-readable class of a health signal. */
export type HealthSignal =
  | 'retries'
  | 'errors'
  | 'latency'
  | 'token-bloat'
  | 'http-status'
  | 'approval'
  | 'empty-output'
  | 'cost'
  /** W13: repeated near-identical tool calls / assistant text in one run. */
  | 'loop';

export type FindingSeverity = 'info' | 'warning' | 'critical';

/**
 * One diagnosed problem with a plain-language explanation and a suggested
 * fix. Templates only — no LLM required. `nodeId` is set for node-level
 * findings on workflow runs.
 */
export interface HealthFinding {
  signal: HealthSignal;
  severity: FindingSeverity;
  /** Short label, e.g. "Step retried 3 times". */
  title: string;
  /** Plain-language diagnosis of what happened. */
  detail: string;
  /** Plain-language suggested fix. */
  fix: string;
  nodeId?: string;
}

/** Scored workflow run, persisted alongside the run record. */
export interface RunHealth {
  runId: string;
  workflowId: string;
  score: HealthScore;
  findings: HealthFinding[];
  latencyMs: number | null;
  failedNodes: number;
  generatedAt: number;
}

/** Telemetry describing one bot turn (chat or workflow agent step). */
export interface TurnTelemetry {
  botId: string;
  sessionId?: string;
  /** Wall-clock turn time in milliseconds. */
  latencyMs: number;
  /** Total (prompt + completion) tokens consumed by the turn. */
  totalTokens: number;
  /** True when the turn ended in an error / was interrupted. */
  errored: boolean;
  errorMessage?: string;
  /** Tool calls that were retried after a failure, if tracked. */
  toolRetries?: number;
  /** True when the turn produced no assistant text at all. */
  emptyResponse?: boolean;
}

/** Scored bot turn. */
export interface TurnHealth {
  botId: string;
  sessionId?: string;
  score: HealthScore;
  findings: HealthFinding[];
  generatedAt: number;
}

/** Optional baselines a scorer compares the current sample against. */
export interface HealthBaselines {
  /** Rolling p50 node/run latency in ms. */
  p50LatencyMs?: number;
  /** Rolling p50 tokens per run/turn. */
  p50Tokens?: number;
  /** Rolling mean cost per run/turn in USD. */
  meanCostUsd?: number;
}

/** One time-series point for regression detection. */
export interface MetricSample {
  scopeKind: 'workflow' | 'bot';
  scopeId: string;
  ts: number;
  latencyMs: number | null;
  errored: boolean;
  costUsd?: number;
  tokens?: number;
  runId?: string;
}

export type RegressionMetric = 'latency-p50' | 'error-rate' | 'cost-per-run';

/** A "quietly got worse" alert: the current 7-day window vs the prior 7 days. */
export interface RegressionAlert {
  /** Stable id: `${scopeKind}:${scopeId}:${metric}` — safe to dedupe on. */
  id: string;
  scopeKind: 'workflow' | 'bot';
  scopeId: string;
  metric: RegressionMetric;
  /** Human label for the metric, e.g. "p50 latency". */
  metricLabel: string;
  baseline: number;
  current: number;
  /** Positive = worse. Unit depends on metric (percent or percentage points). */
  changePct: number;
  changeUnit: 'percent' | 'points';
  baselineSamples: number;
  currentSamples: number;
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
}
