// SPDX-License-Identifier: Apache-2.0

/**
 * The KriyaDot workflow file format — a documented, versioned JSON format
 * for storing workflow definitions in files (checked into repos, shared,
 * imported/exported) instead of only in the runner's SQLite store.
 *
 * Shape:
 *
 * ```json
 * {
 *   "format": "kriyadot.workflow",
 *   "version": 1,
 *   "workflow": {
 *     "id": "my-workflow",
 *     "name": "My workflow",
 *     "description": "optional",
 *     "budget": { "maxCostUsd": 1.5 },
 *     "nodes": [
 *       { "id": "trigger", "type": "trigger", "name": "Start", "config": {} },
 *       { "id": "work", "type": "code", "name": "Work",
 *         "config": { "code": "return input;" },
 *         "retry": { "maxAttempts": 3, "backoffMs": 250 },
 *         "timeoutMs": 10000 }
 *     ],
 *     "edges": [["trigger", "work"]]
 *   }
 * }
 * ```
 *
 * Rules:
 * - `format` must be exactly `"kriyadot.workflow"` and `version` must be
 *   `1`; anything else is rejected (future versions will migrate here).
 * - `workflow` is a plain `WorkflowDefinition`: `id` + `name`, a `nodes`
 *   array and an `edges` array of `[fromId, toId]` or `[fromId, toId,
 *   "true"|"false"]` tuples. Node `type` must be a known NodeType;
 *   `config` is a free-form JSON object per node type. Optional node
 *   fields `retry` / `timeoutMs` and the optional workflow `budget` are
 *   part of the format and round-trip losslessly.
 * - Validation rejects (with a message naming the problem): malformed
 *   JSON, a missing/wrong `format` or unsupported `version`, a missing
 *   workflow id, nodes with missing or duplicate ids, unknown node
 *   types, edges referencing unknown nodes (dangling edges), invalid
 *   branch labels, loop/match configs referencing unknown nodes, and
 *   cyclic graphs. Exactly-one-trigger and per-type config requirements
 *   are enforced by `WorkflowRunner.register`, not here, so a file can
 *   be parsed and inspected before it is registered.
 *
 * Round-trip guarantee: for any definition using the shapes above,
 * `parseWorkflowFile(serializeWorkflow(def))` deep-equals `def`.
 */

import {
  isNodeType,
  type NodeRetryPolicy,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from './types.js';
import { subordinateIdsOf, validateWorkflowStructure } from './plan.js';

/** Value of the top-level `format` field of a KriyaDot workflow file. */
export const WORKFLOW_FILE_FORMAT = 'kriyadot.workflow';

/** The only file-format version this build reads and writes. */
export const WORKFLOW_FILE_VERSION = 1;

/** The parsed file envelope (what serializeWorkflow produces). */
export interface WorkflowFile {
  format: typeof WORKFLOW_FILE_FORMAT;
  version: typeof WORKFLOW_FILE_VERSION;
  workflow: WorkflowDefinition;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function fail(message: string): never {
  throw new Error(`workflow file: ${message}`);
}

function parseRetry(raw: unknown, nodeId: string): NodeRetryPolicy | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(raw);
  if (!rec) fail(`node ${nodeId}: retry must be an object`);
  const maxAttempts = rec['maxAttempts'];
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    fail(`node ${nodeId}: retry.maxAttempts must be a positive integer`);
  }
  const retry: NodeRetryPolicy = { maxAttempts: maxAttempts as number };
  const backoffMs = rec['backoffMs'];
  if (backoffMs !== undefined) {
    if (typeof backoffMs !== 'number' || !Number.isFinite(backoffMs) || backoffMs < 0) {
      fail(`node ${nodeId}: retry.backoffMs must be a non-negative number`);
    }
    retry.backoffMs = backoffMs;
  }
  return retry;
}

function parseNode(raw: unknown, index: number): WorkflowNode {
  const rec = asRecord(raw);
  if (!rec) fail(`nodes[${index}] must be an object`);
  const id = rec['id'];
  if (typeof id !== 'string' || id.length === 0) {
    fail(`nodes[${index}] is missing a non-empty string "id"`);
  }
  const type = rec['type'];
  if (!isNodeType(type)) {
    fail(`node ${id}: unknown node type: ${String(type)}`);
  }
  const name = rec['name'];
  if (name !== undefined && typeof name !== 'string') {
    fail(`node ${id}: "name" must be a string`);
  }
  const config = rec['config'] ?? {};
  if (!asRecord(config)) fail(`node ${id}: "config" must be an object`);
  const node: WorkflowNode = {
    id,
    type,
    name: typeof name === 'string' ? name : id,
    config: config as Record<string, unknown>,
  };
  const retry = parseRetry(rec['retry'], id);
  if (retry) node.retry = retry;
  const timeoutMs = rec['timeoutMs'];
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      fail(`node ${id}: timeoutMs must be a positive number`);
    }
    node.timeoutMs = timeoutMs;
  }
  return node;
}

function parseEdge(raw: unknown, index: number): WorkflowEdge {
  if (!Array.isArray(raw) || (raw.length !== 2 && raw.length !== 3)) {
    fail(`edges[${index}] must be a [fromId, toId] pair (optionally with a branch label)`);
  }
  const [from, to, branch] = raw as unknown[];
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || to.length === 0) {
    fail(`edges[${index}] endpoints must be non-empty node id strings`);
  }
  if (branch === undefined) return [from, to];
  if (branch !== 'true' && branch !== 'false') {
    fail(`edges[${index}] has invalid branch label: ${String(branch)}`);
  }
  return [from, to, branch];
}

function parseDefinition(raw: unknown): WorkflowDefinition {
  const rec = asRecord(raw);
  if (!rec) fail('"workflow" must be an object');
  const id = rec['id'];
  if (typeof id !== 'string' || id.length === 0) {
    fail('workflow is missing a non-empty string "id"');
  }
  const name = rec['name'];
  if (typeof name !== 'string' || name.length === 0) {
    fail(`workflow ${id}: "name" must be a non-empty string`);
  }
  if (!Array.isArray(rec['nodes'])) fail(`workflow ${id}: "nodes" must be an array`);
  if (!Array.isArray(rec['edges'])) fail(`workflow ${id}: "edges" must be an array`);
  const nodes = (rec['nodes'] as unknown[]).map((n, i) => parseNode(n, i));
  const edges = (rec['edges'] as unknown[]).map((e, i) => parseEdge(e, i));
  let description: string | undefined;
  if (rec['description'] !== undefined) {
    if (typeof rec['description'] !== 'string') {
      fail(`workflow ${id}: "description" must be a string`);
    }
    description = rec['description'];
  }
  let budget: WorkflowDefinition['budget'];
  if (rec['budget'] !== undefined) {
    const budgetRec = asRecord(rec['budget']);
    if (!budgetRec) fail(`workflow ${id}: "budget" must be an object`);
    const maxCostUsd = budgetRec['maxCostUsd'];
    if (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
      fail(`workflow ${id}: budget.maxCostUsd must be a non-negative number`);
    }
    budget = { maxCostUsd };
  }
  // Built in the canonical field order (id, name, description, budget,
  // nodes, edges) so serialize(parse(serialize(def))) is byte-stable.
  // (nodes/edges are assigned immediately below, before any use.)
  const def = { id, name } as WorkflowDefinition;
  if (description !== undefined) def.description = description;
  if (budget !== undefined) def.budget = budget;
  def.nodes = nodes;
  def.edges = edges;
  // Structural checks: duplicate ids, dangling edges, branch labels,
  // cycles. (Trigger-count is deliberately left to the runner.)
  try {
    validateWorkflowStructure(def, { requireSingleTrigger: false });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // loop/match subordinate references must point at real nodes, and a
  // node may not drive itself.
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    for (const ref of subordinateIdsOf(node)) {
      if (!ids.has(ref)) {
        fail(`node ${node.id} (${node.type}) references unknown node: ${ref}`);
      }
      if (ref === node.id) {
        fail(`node ${node.id} (${node.type}) must not reference itself as its body/evaluator`);
      }
    }
  }
  return def;
}

/**
 * Serialize a workflow definition to a KriyaDot workflow file (JSON
 * string, 2-space indented). The definition is carried verbatim, so
 * parse(serialize(def)) is lossless for supported shapes.
 */
export function serializeWorkflow(def: WorkflowDefinition): string {
  const file: WorkflowFile = {
    format: WORKFLOW_FILE_FORMAT,
    version: WORKFLOW_FILE_VERSION,
    workflow: def,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse and validate a KriyaDot workflow file. Accepts the JSON string
 * or an already-parsed object. Returns the validated definition (a deep
 * copy detached from the input). Throws with a `workflow file: …`
 * message on any violation.
 */
export function parseWorkflowFile(input: string | unknown): WorkflowDefinition {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch (err) {
      fail(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const rec = asRecord(parsed);
  if (!rec) fail('top level must be an object with "format", "version" and "workflow"');
  if (rec['format'] !== WORKFLOW_FILE_FORMAT) {
    fail(
      `unsupported "format": ${JSON.stringify(rec['format'] ?? null)} (expected "${WORKFLOW_FILE_FORMAT}")`,
    );
  }
  if (rec['version'] !== WORKFLOW_FILE_VERSION) {
    fail(
      `unsupported "version": ${JSON.stringify(rec['version'] ?? null)} (this build supports version ${WORKFLOW_FILE_VERSION})`,
    );
  }
  if (rec['workflow'] === undefined) fail('missing "workflow" definition');
  const def = parseDefinition(rec['workflow']);
  // Detach from the caller's object graph (and guarantee the returned
  // definition is plain JSON data, exactly as it would be from a file).
  return JSON.parse(JSON.stringify(def)) as WorkflowDefinition;
}
