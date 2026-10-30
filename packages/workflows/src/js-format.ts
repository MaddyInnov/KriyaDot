// SPDX-License-Identifier: Apache-2.0
/**
 * D-2 — Optional JS-orchestration workflow format, alongside the DAG format.
 *
 * A JS workflow is a plain JavaScript module (source text) that assigns its
 * definition to `exports.workflow`:
 *
 * ```js
 * exports.workflow = {
 *   id: 'invoice-total',
 *   name: 'Invoice total',
 *   steps: [
 *     { id: 'parse', code: 'return { total: input.items.reduce((s, i) => s + i.price, 0) };' },
 *     { id: 'tax',   code: 'return { total: input.total * 1.2 };' },
 *   ],
 * };
 * ```
 *
 * Semantics: steps run in order. Each step's `code` is a JS function body
 * executed in the SAME code sandbox as DAG `code` nodes (see
 * code-sandbox.ts): `input` is the previous step's output (the run input
 * for the first step) and `nodes` maps every earlier step id to
 * `{ output }`, exactly as in DAG code nodes.
 * `return <value>` is the step's output.
 *
 * Execution: the definition is COMPILED to an ordinary DAG
 * WorkflowDefinition (trigger → one `code` node per step, chained) and run
 * through the existing WorkflowRunner, so governance evaluation, run
 * records, node states, budgets and run events are identical to a DAG
 * workflow — there is no second execution engine to audit.
 *
 * The module source itself is only ever read as DATA: it is evaluated in
 * the vm sandbox with a frozen `exports` object and no host bindings, so a
 * workflow file cannot reach the filesystem, network, or process.
 */

import vm from 'node:vm';
import type { WorkflowDefinition, WorkflowNode } from './types.js';
import { validateWorkflowStructure } from './plan.js';

export const JS_WORKFLOW_FORMAT = 'kriyadot.workflow.js';
export const JS_WORKFLOW_VERSION = 1;

/** Node id reserved for the compiled trigger node. */
export const JS_WORKFLOW_TRIGGER_ID = '__trigger';

export interface JsWorkflowStep {
  id: string;
  /** Optional human label; defaults to the step id. */
  name?: string;
  /** JS function body; `input` / `nodes` in scope, `return` → output. */
  code: string;
  /** Per-step sandbox wall-clock cap in ms (sandbox clamps to its max). */
  timeoutMs?: number;
}

export interface JsWorkflowDefinition {
  format: typeof JS_WORKFLOW_FORMAT;
  version: number;
  id: string;
  name: string;
  description?: string;
  steps: JsWorkflowStep[];
  /** Optional whole-workflow spend cap, carried onto the compiled DAG. */
  budget?: { maxCostUsd: number };
}

const STEP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_STEPS = 100;
const MAX_SOURCE_BYTES = 256_000;

function fail(message: string): never {
  throw new Error(`js workflow: ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return fail('expected an object');
}

/**
 * Evaluate a JS workflow module's source in the vm sandbox and return its
 * raw `exports.workflow` value. The sandbox gets NO host capabilities:
 * no require, no process, no timers beyond what the vm context provides.
 */
function loadModuleExports(source: string): unknown {
  if (typeof source !== 'string' || source.trim().length === 0) {
    fail('source must be a non-empty string');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    fail(`source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  const sandbox = vm.createContext(Object.create(null));
  const seed = new vm.Script('exports = {};', { filename: 'js-workflow-seed.js' });
  seed.runInContext(sandbox, { timeout: 1_000 });
  const script = new vm.Script(`"use strict";\n${source}`, { filename: 'workflow.js' });
  try {
    script.runInContext(sandbox, { timeout: 2_000 });
  } catch (err) {
    fail(`module evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let exported: unknown;
  try {
    exported = new vm.Script('exports.workflow', { filename: 'js-workflow-read.js' }).runInContext(sandbox, {
      timeout: 1_000,
    });
  } catch {
    fail('could not read exports.workflow');
  }
  // Cross the realm boundary into plain host data (also rejects functions,
  // class instances and other non-data values hiding in the definition).
  try {
    return JSON.parse(JSON.stringify(exported ?? null)) as unknown;
  } catch {
    return fail('exports.workflow is not plain JSON-serializable data');
  }
}

/** Parse + validate JS workflow module source into a JsWorkflowDefinition. */
export function parseJsWorkflow(source: string): JsWorkflowDefinition {
  const raw = loadModuleExports(source);
  if (raw === null || raw === undefined) {
    fail('module must assign its definition to exports.workflow');
  }
  const def = asRecord(raw);
  const id = def['id'];
  if (typeof id !== 'string' || !STEP_ID_RE.test(id)) {
    fail('workflow.id must be a non-empty identifier (letters, digits, - and _)');
  }
  const name = def['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    fail('workflow.name must be a non-empty string');
  }
  const rawSteps = def['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    fail('workflow.steps must be a non-empty array');
  }
  if (rawSteps.length > MAX_STEPS) fail(`workflow.steps exceeds the ${MAX_STEPS}-step cap`);
  const seen = new Set<string>();
  const steps: JsWorkflowStep[] = rawSteps.map((rawStep, i) => {
    const step = asRecord(rawStep);
    const stepId = step['id'];
    if (typeof stepId !== 'string' || !STEP_ID_RE.test(stepId)) {
      fail(`steps[${i}].id must be a non-empty identifier`);
    }
    if (stepId === JS_WORKFLOW_TRIGGER_ID) fail(`steps[${i}].id is reserved`);
    if (seen.has(stepId)) fail(`duplicate step id: ${stepId}`);
    seen.add(stepId);
    const code = step['code'];
    if (typeof code !== 'string' || code.trim().length === 0) {
      fail(`steps[${i}].code must be a non-empty string`);
    }
    return {
      id: stepId,
      ...(typeof step['name'] === 'string' && step['name'] ? { name: step['name'] } : {}),
      code,
      ...(typeof step['timeoutMs'] === 'number' && step['timeoutMs'] > 0
        ? { timeoutMs: Math.floor(step['timeoutMs']) }
        : {}),
    };
  });
  let budget: JsWorkflowDefinition['budget'];
  if (def['budget'] !== undefined) {
    const b = asRecord(def['budget']);
    if (typeof b['maxCostUsd'] !== 'number' || !(b['maxCostUsd'] >= 0)) {
      fail('workflow.budget.maxCostUsd must be a non-negative number');
    }
    budget = { maxCostUsd: b['maxCostUsd'] };
  }
  return {
    format: JS_WORKFLOW_FORMAT,
    version: JS_WORKFLOW_VERSION,
    id,
    name: name.trim(),
    ...(typeof def['description'] === 'string' && def['description']
      ? { description: def['description'] }
      : {}),
    steps,
    ...(budget ? { budget } : {}),
  };
}

/**
 * Wrap a step's code so `input` is the previous step's output (the DAG
 * sandbox seeds `input` with the RUN input and `nodes` with prior outputs).
 */
function wrapStepCode(step: JsWorkflowStep, previousStepId: string | null): string {
  if (previousStepId === null) return step.code;
  const prev = `nodes[${JSON.stringify(previousStepId)}]`;
  return `input = ${prev} !== undefined ? ${prev}.output : input;\n${step.code}`;
}

/**
 * Compile a JS workflow definition to the equivalent DAG definition:
 * a trigger node feeding a linear chain of `code` nodes, one per step.
 * The result passes the same structural validation as any DAG workflow.
 */
export function compileJsWorkflow(def: JsWorkflowDefinition): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: JS_WORKFLOW_TRIGGER_ID, type: 'trigger', name: 'Start', config: {} },
  ];
  const edges: WorkflowDefinition['edges'] = [];
  let previousId: string = JS_WORKFLOW_TRIGGER_ID;
  let previousStepId: string | null = null;
  for (const step of def.steps) {
    nodes.push({
      id: step.id,
      type: 'code',
      name: step.name ?? step.id,
      config: {
        code: wrapStepCode(step, previousStepId),
        ...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
        jsStep: true,
      },
    });
    edges.push([previousId, step.id]);
    previousId = step.id;
    previousStepId = step.id;
  }
  const dag: WorkflowDefinition = {
    id: def.id,
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    nodes,
    edges,
    ...(def.budget ? { budget: def.budget } : {}),
  };
  try {
    validateWorkflowStructure(dag);
  } catch (err) {
    fail(`compiled DAG is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  return dag;
}

/** Convenience: parse module source and compile it in one call. */
export function parseAndCompileJsWorkflow(source: string): { js: JsWorkflowDefinition; dag: WorkflowDefinition } {
  const js = parseJsWorkflow(source);
  return { js, dag: compileJsWorkflow(js) };
}
