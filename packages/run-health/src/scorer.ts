// SPDX-License-Identifier: Apache-2.0
// Run/turn health scoring (feature #2). Pure functions over telemetry —
// no I/O, no network, no LLM. Findings are template-generated from the
// failing signals so they work standalone.

import type { WorkflowRun } from '@mvp/workflows';
import type {
  FindingSeverity,
  HealthBaselines,
  HealthFinding,
  HealthScore,
  RunHealth,
  TurnHealth,
  TurnTelemetry,
} from './types.js';

/** Points model: findings deduct from 100; kept for future gradation. */
const POINTS: Record<FindingSeverity, number> = { critical: 40, warning: 15, info: 2 };

/**
 * Verdict from findings. Deliberately simple so the UI can explain it:
 * any critical → poor, any warning → needs-work, otherwise good.
 */
export function scoreFromFindings(findings: HealthFinding[]): HealthScore {
  if (findings.some((f) => f.severity === 'critical')) return 'poor';
  if (findings.some((f) => f.severity === 'warning')) return 'needs-work';
  return 'good';
}

/** Points remaining after findings (0–100); useful for ranking runs. */
export function healthPoints(findings: HealthFinding[]): number {
  let points = 100;
  for (const f of findings) points -= POINTS[f.severity];
  return Math.max(0, points);
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function quoteError(message: string | undefined, max = 160): string {
  if (!message) return '';
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

interface ErrorClass {
  title: string;
  detail: string;
  fix: string;
}

/** Classify a raw error message into a plain-language diagnosis + fix. */
export function classifyError(message: string | undefined): ErrorClass {
  const msg = message ?? '';
  if (/timed?\s?out|ETIMEDOUT|deadline exceeded|operation aborted/i.test(msg)) {
    return {
      title: 'Step hit a timeout',
      detail: `This step kept retrying or waiting until it timed out${quoteError(msg) ? `: "${quoteError(msg)}"` : ''}. Timeouts usually mean the upstream service is slow or the limit is too tight for the work.`,
      fix: 'Raise the timeout for this step, or add exponential backoff with jitter between attempts so transient slowness recovers instead of failing.',
    };
  }
  if (/rate.?limit|429|too many requests/i.test(msg)) {
    return {
      title: 'Provider rate limit hit',
      detail: `The provider throttled requests${quoteError(msg) ? `: "${quoteError(msg)}"` : ''}. This happens when steps fire faster than the plan allows.`,
      fix: 'Add backoff with jitter and slow the pace of calls; if this is frequent, batch the work or move to a higher-rate plan.',
    };
  }
  if (/401|unauthori[sz]ed|403|forbidden|invalid api key|authentication/i.test(msg)) {
    return {
      title: 'Credentials rejected',
      detail: `The provider refused the request on authentication${quoteError(msg) ? `: "${quoteError(msg)}"` : ''}. The stored key is missing, wrong, or revoked.`,
      fix: 'Check the provider API key in Providers settings and reconnect it; rotate the key if it was revoked or leaked.',
    };
  }
  if (/denied by user|denied by policy|tool call denied|require.?approval/i.test(msg)) {
    return {
      title: 'Action denied by human or policy',
      detail: `A governance rule or a human denied this step${quoteError(msg) ? `: "${quoteError(msg)}"` : ''}. The step itself ran fine — it was never allowed to proceed.`,
      fix: 'Review the approval request in the Activity tab, or adjust the governance policy for this tool if denials are routine.',
    };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i.test(msg)) {
    return {
      title: 'Network error reaching a dependency',
      detail: `The step could not reach its dependency${quoteError(msg) ? `: "${quoteError(msg)}"` : ''}. The host may be down or DNS/connectivity may be broken from this machine.`,
      fix: 'Verify the target host is reachable, then add retries with backoff — network blips should not fail a run on the first try.',
    };
  }
  if (/is required|unknown (bot|tool|workflow|node)|invalid|must be|not found/i.test(msg)) {
    return {
      title: 'Step misconfigured',
      detail: `The step failed before doing any real work${quoteError(msg) ? `: "${quoteError(msg)}"` : ''}. This is a configuration problem, not a flaky dependency.`,
      fix: 'Open the workflow and check this step’s configuration — a required field is missing or references something that no longer exists.',
    };
  }
  return {
    title: 'Step failed with an unexpected error',
    detail: `The step failed${quoteError(msg) ? `: "${quoteError(msg)}"` : ''}. The error does not match a known pattern, so the cause needs a look.`,
    fix: 'Inspect the step’s error output, then add a retry or a fallback branch so this failure mode degrades gracefully instead of failing the run.',
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ScoreRunOptions {
  baselines?: HealthBaselines;
  /** Total tokens for the run, when tracked (agent steps). */
  totalTokens?: number;
}

/**
 * Score a workflow run from its persisted telemetry: node statuses, errors,
 * attempt counts, per-node latencies, HTTP statuses, and optional token
 * totals vs a rolling baseline.
 */
export function scoreWorkflowRun(run: WorkflowRun, opts: ScoreRunOptions = {}): RunHealth {
  const findings: HealthFinding[] = [];
  const latencies: number[] = [];
  const nodeIds = Object.keys(run.nodeStates);
  let failedNodes = 0;

  for (const nodeId of nodeIds) {
    const st = run.nodeStates[nodeId];
    if (st.startedAt !== undefined && st.endedAt !== undefined && st.endedAt >= st.startedAt) {
      latencies.push(st.endedAt - st.startedAt);
    }

    if (st.status === 'failed') {
      failedNodes += 1;
      const cls = classifyError(st.error);
      findings.push({
        signal: 'errors',
        severity: 'critical',
        title: cls.title,
        detail: `Step "${nodeId}": ${cls.detail}`,
        fix: cls.fix,
        nodeId,
      });
    }

    const attempts = st.attempts ?? 1;
    if (attempts >= 3) {
      findings.push({
        signal: 'retries',
        severity: attempts >= 5 ? 'critical' : 'warning',
        title: `Step retried ${attempts}×`,
        detail: `Step "${nodeId}" needed ${attempts} attempts before it ${st.status === 'succeeded' ? 'succeeded' : 'gave up'}. Repeated attempts usually mean flaky timeouts or a dependency that is only sometimes healthy.`,
        fix: 'Add exponential backoff with jitter between attempts, or raise the step timeout so the first attempt has a fair chance.',
        nodeId,
      });
    }

    // HTTP steps record their status in the output; non-2xx is a signal even
    // when the runner itself did not throw.
    const output = st.output as { status?: unknown } | null | undefined;
    const httpStatus = output && typeof output === 'object' && typeof output.status === 'number' ? output.status : null;
    if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
      findings.push({
        signal: 'http-status',
        severity: httpStatus >= 500 ? 'critical' : 'warning',
        title: `HTTP step returned ${httpStatus}`,
        detail: `Step "${nodeId}" completed but the upstream answered ${httpStatus}. ${httpStatus >= 500 ? 'Server-side errors are usually transient — worth a retry.' : 'Client errors usually mean the request itself is wrong.'}`,
        fix:
          httpStatus >= 500
            ? 'Retry 5xx responses with backoff; alert if the upstream error rate stays high.'
            : 'Check the request URL, method, headers, and body for this step — the upstream is rejecting the call as made.',
        nodeId,
      });
    }

    if (st.status === 'succeeded' && (st.output === undefined || st.output === '' || st.output === null)) {
      findings.push({
        signal: 'empty-output',
        severity: 'info',
        title: 'Step succeeded with no output',
        detail: `Step "${nodeId}" reports success but produced nothing. Harmless for trigger/delay steps; suspicious for agent or tool steps.`,
        fix: 'If downstream steps expect data from this step, verify it is actually producing output — an empty success can silently poison the rest of the run.',
        nodeId,
      });
    }
  }

  // Latency outliers: compare each node against the run's own median so the
  // heuristic needs no external baseline.
  const med = median(latencies);
  if (med !== null) {
    for (const nodeId of nodeIds) {
      const st = run.nodeStates[nodeId];
      if (st.startedAt === undefined || st.endedAt === undefined) continue;
      const latency = st.endedAt - st.startedAt;
      if (latency > Math.max(3 * med, 15_000) || latency > 120_000) {
        findings.push({
          signal: 'latency',
          severity: 'warning',
          title: `Step slow: ${fmtMs(latency)}`,
          detail: `Step "${nodeId}" took ${fmtMs(latency)} — far longer than the typical step in this run (${fmtMs(med)} median). Slow steps dominate total run time.`,
          fix: 'Profile this step: cache repeatable work, parallelize what is independent, or split the step so slow parts can be retried alone.',
          nodeId,
        });
      }
    }
  }

  // Token bloat vs the rolling baseline for this workflow.
  const baselineTokens = opts.baselines?.p50Tokens;
  if (
    opts.totalTokens !== undefined &&
    baselineTokens !== undefined &&
    baselineTokens > 0 &&
    opts.totalTokens > 2 * baselineTokens &&
    opts.totalTokens > 4000
  ) {
    findings.push({
      signal: 'token-bloat',
      severity: 'warning',
      title: `Token bloat: ${fmtTokens(opts.totalTokens)} vs ${fmtTokens(baselineTokens)} typical`,
      detail: `This run consumed ${fmtTokens(opts.totalTokens)} tokens — more than double the typical ${fmtTokens(baselineTokens)} for this workflow. Something is making the model work much harder than usual (longer context, retry loops, or verbose outputs).`,
      fix: 'Trim the context sent to agent steps, cap max output tokens, and check whether a step is looping or re-sending the same large payload.',
    });
  }

  if (run.status === 'failed') {
    findings.push({
      signal: 'errors',
      severity: 'critical',
      title: `Run failed (${failedNodes} of ${nodeIds.length} steps failed)`,
      detail: 'The run ended in a failed state. Fix the failed steps above — runs usually fail for one root cause, so start with the first failing step.',
      fix: 'Re-run after fixing the first failing step; consider adding a fallback branch so one bad step does not sink the whole run.',
    });
  }

  if (run.status === 'paused' && Date.now() - run.updatedAt > 30 * 60 * 1000) {
    findings.push({
      signal: 'approval',
      severity: 'info',
      title: 'Waiting on approval for a while',
      detail: `This run has been paused for over 30 minutes waiting on a human decision. Stalled approvals quietly block everything downstream.`,
      fix: 'Decide the pending approval in the Activity tab, or add an auto-expire so paused runs do not wait forever.',
    });
  }

  const latencyMs =
    run.createdAt !== undefined && run.updatedAt !== undefined ? Math.max(0, run.updatedAt - run.createdAt) : null;

  return {
    runId: run.id,
    workflowId: run.workflowId,
    score: scoreFromFindings(findings),
    findings,
    latencyMs,
    failedNodes,
    generatedAt: Date.now(),
  };
}

export interface ScoreTurnOptions {
  baselines?: HealthBaselines;
}

/** Score a single bot turn from its telemetry. */
export function scoreTurn(t: TurnTelemetry, opts: ScoreTurnOptions = {}): TurnHealth {
  const findings: HealthFinding[] = [];
  const b = opts.baselines ?? {};

  if (t.errored) {
    const cls = classifyError(t.errorMessage);
    findings.push({
      signal: 'errors',
      severity: 'critical',
      title: cls.title,
      detail: `Bot turn failed. ${cls.detail}`,
      fix: cls.fix,
    });
  }

  const retries = t.toolRetries ?? 0;
  if (retries >= 3) {
    findings.push({
      signal: 'retries',
      severity: retries >= 6 ? 'critical' : 'warning',
      title: `Tool calls retried ${retries}×`,
      detail: `This turn retried tool calls ${retries} times before ${t.errored ? 'giving up' : 'getting through'}. Retry storms burn tokens and usually mean the tool is flaky or the model is calling it wrong.`,
      fix: 'Make the tool itself retry with backoff instead of the turn loop, or tighten the tool description so the model calls it correctly the first time.',
    });
  }

  if (b.p50LatencyMs !== undefined && b.p50LatencyMs > 0 && t.latencyMs > 2.5 * b.p50LatencyMs && t.latencyMs > 30_000) {
    findings.push({
      signal: 'latency',
      severity: 'warning',
      title: `Turn slow: ${fmtMs(t.latencyMs)}`,
      detail: `This turn took ${fmtMs(t.latencyMs)} vs a typical ${fmtMs(b.p50LatencyMs)} for this bot. Slow turns usually come from long tool calls or oversized context.`,
      fix: 'Find the slow tool call in the turn transcript and speed it up, cache it, or run it in the background.',
    });
  } else if (t.latencyMs > 180_000) {
    findings.push({
      signal: 'latency',
      severity: 'warning',
      title: `Turn slow: ${fmtMs(t.latencyMs)}`,
      detail: `This turn took ${fmtMs(t.latencyMs)} — over three minutes. Even without a baseline, that is slow enough to hurt.`,
      fix: 'Find the slow tool call in the turn transcript and speed it up, cache it, or run it in the background.',
    });
  }

  if (
    b.p50Tokens !== undefined &&
    b.p50Tokens > 0 &&
    t.totalTokens > 2 * b.p50Tokens &&
    t.totalTokens > 4000
  ) {
    findings.push({
      signal: 'token-bloat',
      severity: 'warning',
      title: `Token bloat: ${fmtTokens(t.totalTokens)} vs ${fmtTokens(b.p50Tokens)} typical`,
      detail: `This turn burned ${fmtTokens(t.totalTokens)} tokens — more than double the typical ${fmtTokens(b.p50Tokens)} for this bot. Check for re-sent context, retry loops, or runaway tool output.`,
      fix: 'Compact the conversation before it grows, summarize long tool outputs, and cap max tokens per turn.',
    });
  }

  if (t.emptyResponse && !t.errored) {
    findings.push({
      signal: 'empty-output',
      severity: 'warning',
      title: 'Turn produced no text',
      detail: 'The turn completed but the assistant said nothing. The model may be stopping early or the response was swallowed.',
      fix: 'Check the system prompt and max-token settings for this bot; look at the raw turn transcript for a truncated or empty completion.',
    });
  }

  return {
    botId: t.botId,
    sessionId: t.sessionId,
    score: scoreFromFindings(findings),
    findings,
    generatedAt: Date.now(),
  };
}

/**
 * W13: build the health finding for a detected loop (span-store loop
 * detector in @mvp/agent-runtime). The detector supplies the evidence —
 * this factory only renders the plain-language diagnosis + fix, in the
 * same template style as every other finding (no LLM).
 */
export function loopFinding(input: {
  kind: 'tool' | 'text';
  key: string;
  count: number;
  spanIds: string[];
}): HealthFinding {
  const what =
    input.kind === 'tool'
      ? `the "${input.key}" tool call`
      : 'the same assistant text';
  return {
    signal: 'loop',
    severity: 'warning',
    title: `Possible loop: ${what} repeated ${input.count} times`,
    detail:
      `This run repeated ${what} ${input.count} times with near-identical content ` +
      `(evidence spans: ${input.spanIds.join(', ')}). Loops burn tokens and paid tool ` +
      `credits without making progress.`,
    fix: 'Open the run waterfall in Activity → Runs to inspect the repeated spans; then tighten the bot prompt, add a stopping condition, or lower the tool\u2019s retry budget.',
  };
}
