// SPDX-License-Identifier: Apache-2.0

/**
 * Workflow JSONL observability (#152).
 *
 * A run emits a stream of plain-object events:
 *
 * - `run_started`    — execution of a run began;
 * - `step_completed` — one node finished (succeeded / failed / skipped),
 *                      carrying that step's `costUsd` (priced agent usage
 *                      included, #150), its token `usage` when known,
 *                      the provider/model that served it, and the
 *                      run's running `totalCostUsd`;
 * - `run_finished`   — the run reached a terminal status, carrying the
 *                      aggregated `totalCostUsd` and a per-step
 *                      `steps` cost breakdown.
 *
 * `formatRunEventsJsonl` renders events as JSON Lines (one JSON object
 * per line) for log files / streaming exports, and
 * `runEventsFromRun` reconstructs the same event shape from a finished
 * (or in-flight) `WorkflowRun` snapshot, so hosts can export JSONL for
 * runs whose live events they did not collect. `WorkflowRunEventCollector`
 * is the ready-made sink for `WorkflowRunnerOptions.onRunEvent` /
 * `runner.onRunEvent(cb)`.
 */

import type { RunStatus, WorkflowRun, WorkflowTokenUsage } from './types.js';

export interface RunStartedEvent {
  type: 'run_started';
  ts: number;
  runId: string;
  workflowId: string;
}

export interface StepCompletedEvent {
  type: 'step_completed';
  ts: number;
  runId: string;
  workflowId: string;
  nodeId: string;
  nodeType?: string;
  status: 'succeeded' | 'failed' | 'skipped';
  /** USD attributed to this step (0 when it carried no cost). */
  costUsd: number;
  /** Token usage, when the step's executor reported it (#150). */
  usage?: WorkflowTokenUsage;
  provider?: string;
  model?: string;
  /** Running total USD for the run after this step. */
  totalCostUsd: number;
}

export interface RunFinishedEvent {
  type: 'run_finished';
  ts: number;
  runId: string;
  workflowId: string;
  status: RunStatus;
  /** Aggregated USD for the whole run (sum of step costs). */
  totalCostUsd: number;
  /** Per-step cost breakdown (only steps that ran / were skipped). */
  steps: { nodeId: string; costUsd: number; status: string }[];
}

export type WorkflowRunEvent = RunStartedEvent | StepCompletedEvent | RunFinishedEvent;

/** Render run events as JSON Lines: one JSON object per line. */
export function formatRunEventsJsonl(events: readonly WorkflowRunEvent[]): string {
  if (events.length === 0) return '';
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Parse a JSONL run-events document back into events (blank lines skipped). */
export function parseRunEventsJsonl(text: string): WorkflowRunEvent[] {
  const out: WorkflowRunEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as WorkflowRunEvent);
  }
  return out;
}

/**
 * Reconstruct run events from a `WorkflowRun` snapshot (e.g. one loaded
 * from the store by a host that did not subscribe live). Step events
 * are ordered by `endedAt`; the run total is the sum of the persisted
 * per-step `costUsd` values.
 */
export function runEventsFromRun(run: WorkflowRun): WorkflowRunEvent[] {
  const events: WorkflowRunEvent[] = [
    { type: 'run_started', ts: run.createdAt, runId: run.id, workflowId: run.workflowId },
  ];
  const completed = Object.entries(run.nodeStates)
    .filter(([, s]) => s.status === 'succeeded' || s.status === 'failed' || s.status === 'skipped')
    .sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
  let total = 0;
  const steps: RunFinishedEvent['steps'] = [];
  for (const [nodeId, state] of completed) {
    const costUsd = typeof state.costUsd === 'number' ? state.costUsd : 0;
    total += costUsd;
    steps.push({ nodeId, costUsd, status: state.status });
    const event: StepCompletedEvent = {
      type: 'step_completed',
      ts: state.endedAt ?? run.updatedAt,
      runId: run.id,
      workflowId: run.workflowId,
      nodeId,
      status: state.status as StepCompletedEvent['status'],
      costUsd,
      totalCostUsd: total,
    };
    if (state.usage) event.usage = state.usage;
    if (state.provider) event.provider = state.provider;
    if (state.model) event.model = state.model;
    events.push(event);
  }
  if (run.status === 'succeeded' || run.status === 'failed') {
    events.push({
      type: 'run_finished',
      ts: run.updatedAt,
      runId: run.id,
      workflowId: run.workflowId,
      status: run.status,
      totalCostUsd: total,
      steps,
    });
  }
  return events;
}

/** JSONL export for a run snapshot (see runEventsFromRun). */
export function runEventsJsonlFromRun(run: WorkflowRun): string {
  return formatRunEventsJsonl(runEventsFromRun(run));
}

/** Collects run events in memory; `toJsonl()` renders the JSONL export. */
export class WorkflowRunEventCollector {
  readonly events: WorkflowRunEvent[] = [];

  /** Sink compatible with `WorkflowRunnerOptions.onRunEvent`. */
  readonly handle = (event: WorkflowRunEvent): void => {
    this.events.push(event);
  };

  /** Events for one run only. */
  forRun(runId: string): WorkflowRunEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }

  /** Aggregated USD across all collected `run_finished` events. */
  get totalCostUsd(): number {
    let total = 0;
    for (const e of this.events) if (e.type === 'run_finished') total += e.totalCostUsd;
    return total;
  }

  toJsonl(runId?: string): string {
    return formatRunEventsJsonl(runId ? this.forRun(runId) : this.events);
  }
}
