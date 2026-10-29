// SPDX-License-Identifier: Apache-2.0

/**
 * Execution planning for workflow definitions: graph helpers shared by the
 * runner and the dry-run facility, plus `buildExecutionPlan` itself.
 *
 * Subordinate nodes: `loop` and `match` nodes drive other nodes directly
 * (their body / evaluator). Those subordinate nodes are part of the
 * definition but are NOT wired into the DAG with edges and never execute
 * as standalone steps — the topological levels computed here therefore
 * exclude them, while reachability still counts them (so their run states
 * start as `pending`, not `skipped`, and the driving node updates them).
 */

import type { NodeType, WorkflowDefinition, WorkflowNode } from './types.js';

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Node ids a loop/match node drives directly (body + evaluator). */
export function subordinateIdsOf(node: WorkflowNode): string[] {
  const config = asRecord(node.config);
  const ids: string[] = [];
  if (node.type === 'loop') {
    if (typeof config['bodyNodeId'] === 'string') ids.push(config['bodyNodeId']);
    if (typeof config['evaluatorNodeId'] === 'string') ids.push(config['evaluatorNodeId']);
  } else if (node.type === 'match') {
    if (typeof config['bodyNodeId'] === 'string') ids.push(config['bodyNodeId']);
  }
  return ids;
}

/** Every node id in the definition that is driven by a loop/match node. */
export function getSubordinateNodeIds(def: WorkflowDefinition): Set<string> {
  const out = new Set<string>();
  for (const node of def.nodes) {
    for (const id of subordinateIdsOf(node)) out.add(id);
  }
  return out;
}

/**
 * Nodes reachable from the trigger: via edges, plus subordinate nodes of
 * any reachable loop/match node (recursively, so nested loops count).
 */
export function computeReachableNodeIds(def: WorkflowDefinition): Set<string> {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const trigger = def.nodes.find((n) => n.type === 'trigger');
  const seen = new Set<string>();
  if (!trigger) return seen;
  const adjacency = new Map<string, string[]>();
  for (const node of def.nodes) adjacency.set(node.id, []);
  for (const [from, to] of def.edges) adjacency.get(from)?.push(to);
  const stack = [trigger.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) ?? []) stack.push(next);
    const node = byId.get(id);
    if (node) {
      for (const sub of subordinateIdsOf(node)) {
        if (byId.has(sub)) stack.push(sub);
      }
    }
  }
  return seen;
}

/**
 * Level-by-level topological order of the trigger-reachable subgraph,
 * EXCLUDING subordinate (loop/match-driven) nodes. Nodes in the same
 * level have no dependencies on each other; every level waits for all
 * previous levels. Throws when the reachable subgraph has a cycle.
 */
export function computeTopologicalLevels(def: WorkflowDefinition): string[][] {
  const reachable = computeReachableNodeIds(def);
  const subordinate = getSubordinateNodeIds(def);
  const executable = new Set([...reachable].filter((id) => !subordinate.has(id)));
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of executable) {
    adjacency.set(id, []);
    indegree.set(id, 0);
  }
  for (const [from, to] of def.edges) {
    if (!executable.has(from) || !executable.has(to)) continue;
    adjacency.get(from)!.push(to);
    indegree.set(to, indegree.get(to)! + 1);
  }
  const levels: string[][] = [];
  let frontier = [...executable].filter((id) => indegree.get(id) === 0);
  const emitted = new Set<string>();
  while (frontier.length > 0) {
    levels.push(frontier);
    for (const id of frontier) emitted.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of adjacency.get(id)!) {
        indegree.set(dep, indegree.get(dep)! - 1);
        if (indegree.get(dep) === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  if (emitted.size !== executable.size) {
    throw new Error('workflow graph has a cycle in the trigger-reachable subgraph');
  }
  return levels;
}

/**
 * Structural validation shared by the dry-run path (the runner performs
 * these checks too, plus node-config checks): workflow/node ids present
 * and unique, edges reference known nodes with valid branch labels,
 * exactly one trigger, and the graph is a DAG.
 */
export function validateWorkflowStructure(
  def: WorkflowDefinition,
  opts?: { requireSingleTrigger?: boolean },
): void {
  if (!def || typeof def !== 'object') throw new Error('workflow definition must be an object');
  if (!def.id) throw new Error('workflow must have an id');
  if (!Array.isArray(def.nodes)) throw new Error('workflow nodes must be an array');
  if (!Array.isArray(def.edges)) throw new Error('workflow edges must be an array');
  const ids = new Set<string>();
  const byId = new Map<string, WorkflowNode>();
  for (const node of def.nodes) {
    if (!node.id) throw new Error('workflow node must have an id');
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    byId.set(node.id, node);
  }
  for (const edge of def.edges) {
    const [from, to, branch] = edge;
    if (!ids.has(from)) throw new Error(`edge references unknown node: ${from}`);
    if (!ids.has(to)) throw new Error(`edge references unknown node: ${to}`);
    if (branch !== undefined) {
      if (branch !== 'true' && branch !== 'false') {
        throw new Error(`edge ${from} → ${to} has invalid branch label: ${String(branch)}`);
      }
      if (byId.get(from)?.type !== 'if') {
        throw new Error(
          `edge ${from} → ${to} carries a branch label but "${from}" is not an 'if' node`,
        );
      }
    }
  }
  if (opts?.requireSingleTrigger !== false) {
    const triggers = def.nodes.filter((n) => n.type === 'trigger');
    if (triggers.length !== 1) {
      throw new Error(`workflow must have exactly one trigger node, found ${triggers.length}`);
    }
  }
  // Cycle detection over the full graph (Kahn's algorithm).
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of def.nodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const [from, to] of def.edges) {
    adjacency.get(from)!.push(to);
    indegree.set(to, indegree.get(to)! + 1);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop()!;
    visited += 1;
    for (const next of adjacency.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== def.nodes.length) {
    throw new Error('workflow contains a cycle and is not a DAG');
  }
}

/** One node in a dry-run plan level. */
export interface DryRunPlanNode {
  id: string;
  type: NodeType;
  name: string;
}

export interface DryRunLevel {
  /** 0-based level index; levels execute strictly in order. */
  level: number;
  /** Nodes in this level (they would run concurrently). */
  nodes: DryRunPlanNode[];
}

/**
 * The result of a dry run: the execution plan for a definition, computed
 * without executing anything. `levels` covers the executable (non-
 * subordinate) nodes in topological order; `subordinate` maps each
 * loop/match node id to the node ids it drives; `skipped` lists nodes
 * unreachable from the trigger (they would be marked `skipped` at run
 * creation).
 */
export interface DryRunPlan {
  workflowId: string;
  name: string;
  nodeCount: number;
  levels: DryRunLevel[];
  subordinate: Record<string, string[]>;
  skipped: string[];
  budget?: { maxCostUsd: number };
}

/**
 * Validate a definition and compute its execution plan. Pure: no store,
 * no executor, no side effects.
 */
export function buildExecutionPlan(def: WorkflowDefinition): DryRunPlan {
  validateWorkflowStructure(def);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const levels = computeTopologicalLevels(def).map((ids, level) => ({
    level,
    nodes: ids.map((id) => {
      const node = byId.get(id)!;
      return { id: node.id, type: node.type, name: node.name };
    }),
  }));
  const subordinate: Record<string, string[]> = {};
  for (const node of def.nodes) {
    const subs = subordinateIdsOf(node);
    if (subs.length > 0) subordinate[node.id] = subs;
  }
  const reachable = computeReachableNodeIds(def);
  const skipped = def.nodes.map((n) => n.id).filter((id) => !reachable.has(id));
  const plan: DryRunPlan = {
    workflowId: def.id,
    name: def.name,
    nodeCount: def.nodes.length,
    levels,
    subordinate,
    skipped,
  };
  if (def.budget) plan.budget = { maxCostUsd: def.budget.maxCostUsd };
  return plan;
}
