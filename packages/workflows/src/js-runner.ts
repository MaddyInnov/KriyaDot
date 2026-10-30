// SPDX-License-Identifier: Apache-2.0
/**
 * D-2 — Runner adapter for JS-orchestration workflows.
 *
 * Thin adapter over the existing WorkflowRunner: registering a JS module
 * parses + compiles it to a DAG definition and registers THAT, so runs of
 * a JS workflow produce exactly the same run records, node states,
 * governance decisions and run events as a hand-authored DAG workflow.
 */

import type { WorkflowRun } from './types.js';
import type { WorkflowRunner } from './runner.js';
import {
  compileJsWorkflow,
  parseJsWorkflow,
  type JsWorkflowDefinition,
} from './js-format.js';

export class JsWorkflowRunner {
  constructor(private readonly runner: WorkflowRunner) {}

  /** Parse + compile + register a JS workflow module. Returns both forms. */
  registerSource(source: string): { js: JsWorkflowDefinition; workflowId: string } {
    const js = parseJsWorkflow(source);
    const dag = compileJsWorkflow(js);
    this.runner.register(dag);
    return { js, workflowId: dag.id };
  }

  /** Register an already-parsed JS workflow definition. */
  registerDefinition(js: JsWorkflowDefinition): string {
    const dag = compileJsWorkflow(js);
    this.runner.register(dag);
    return dag.id;
  }

  /** Start a run of a registered JS workflow (delegates to the DAG runner). */
  async startRun(
    workflowId: string,
    input: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<WorkflowRun> {
    return this.runner.startRun(workflowId, input, opts);
  }

  /**
   * Start a run and wait until it reaches a terminal status
   * ('succeeded' | 'failed'), polling the shared run store. Rejects on
   * timeout; the run itself keeps executing in the runner.
   */
  async runAndWait(
    workflowId: string,
    input: unknown,
    opts: { idempotencyKey?: string; timeoutMs?: number; pollMs?: number } = {},
  ): Promise<WorkflowRun> {
    const started = await this.startRun(workflowId, input, {
      idempotencyKey: opts.idempotencyKey,
    });
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 10;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = this.runner.getRun(started.id);
      if (!run) throw new Error(`js workflow run ${started.id} disappeared from the run store`);
      if (run.status === 'succeeded' || run.status === 'failed') return run;
      if (Date.now() > deadline) {
        throw new Error(`js workflow run ${started.id} did not finish within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.runner.getRun(id);
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    return this.runner.listRuns(workflowId);
  }
}
