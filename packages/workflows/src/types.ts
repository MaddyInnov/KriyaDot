// SPDX-License-Identifier: Apache-2.0

/** Node types supported by the MVP workflow runner. */
export type NodeType =
  | 'trigger'
  | 'agent'
  | 'tool'
  | 'http'
  | 'delay'
  | 'approval'
  | 'if'
  | 'set'
  | 'code'
  | 'bot-turn'
  | 'loop'
  | 'match';

/** Every known node type (used by the file-format parser / validation). */
export const NODE_TYPES: readonly NodeType[] = [
  'trigger',
  'agent',
  'tool',
  'http',
  'delay',
  'approval',
  'if',
  'set',
  'code',
  'bot-turn',
  'loop',
  'match',
];

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value);
}

/**
 * Per-node retry policy (enforced by the runner). `maxAttempts` is the TOTAL
 * number of tries including the first (default 1 = no retry). `backoffMs`
 * is a fixed delay slept between attempts (default 0).
 */
export interface NodeRetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
}

/** Per-workflow spend cap, enforced by the runner (see src/cost.ts). */
export interface WorkflowBudget {
  maxCostUsd: number;
}

/**
 * Branch label on an edge leaving an 'if' node: which condition outcome the
 * edge carries ('true' → condition held, 'false' → it did not). Unlabeled
 * edges always carry.
 */
export type EdgeBranch = 'true' | 'false';

/**
 * A directed edge, optionally carrying a branch label for 'if'-node outputs.
 * Plain 2-tuples keep working everywhere: `[from, to]` ≡ `[from, to]` with
 * no label.
 */
export type WorkflowEdge = [string, string] | [string, string, EdgeBranch];

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  /**
   * Optional per-step retry policy, enforced by the runner around the
   * node's execution (including its timeout). See NodeRetryPolicy.
   */
  retry?: NodeRetryPolicy;
  /**
   * Optional per-step wall-clock timeout in ms, enforced by the runner
   * with a Promise.race (same style as the code sandbox). Applies per
   * attempt. Note this is distinct from a `code` node's config.timeoutMs,
   * which caps the sandbox itself.
   */
  timeoutMs?: number;
}

/**
 * Config shapes for the branch/transform node types (informational — the
 * runner reads these fields; configs are plain JSON).
 */
export interface IfNodeConfig {
  /**
   * Condition expression. Templates (`{{input}}`, `{{nodes.<id>.output…}}`)
   * are rendered first; the result may be a boolean, or a JS expression
   * string evaluated in the code sandbox (e.g. "{{nodes.a.output.n}} > 5").
   */
  condition: string;
}

export interface SetNodeConfig {
  /** Field → template string (rendered with {{input}} / {{nodes…}}). */
  assignments: Record<string, unknown>;
  /** When true, run input fields are merged underneath the assignments. */
  includeInput?: boolean;
}

export interface CodeNodeConfig {
  /** JS function body; `input` and `nodes` are in scope, `return` → output. */
  code: string;
  /** Wall-clock cap in ms (default 5000, hard cap 30000). */
  timeoutMs?: number;
}

/**
 * Config for a `loop` node. The loop repeatedly executes `bodyNodeId` and
 * then `evaluatorNodeId` (both are subordinate nodes: they are NOT wired
 * into the DAG with edges and never run standalone — the loop drives them).
 * After each iteration the evaluator's output decides acceptance:
 * - if the evaluator output is a boolean, it is used directly;
 * - otherwise the value at `acceptPath` (dot path, default `"accept"`) in
 *   the evaluator output must be truthy (e.g. `{ accept: true }`).
 * Point `acceptPath` at `"condition"` to use an `if` node as evaluator.
 * Body/evaluator templates and code see `{{iteration}}` / `iteration`
 * (1-based) and the latest body output via `nodes.<bodyNodeId>.output`.
 * The loop fails once `maxIterations` (default 5) pass without acceptance.
 * Loop output: `{ accepted, iterations, bodyOutput, evaluatorOutput,
 * history }` (plus `costUsd` when sub-executions reported costs).
 */
export interface LoopNodeConfig {
  bodyNodeId: string;
  evaluatorNodeId: string;
  maxIterations?: number;
  acceptPath?: string;
}

/**
 * Config for a `match` node (dynamic fan-out). The array at
 * `sourcePath` (dot path, default: the whole output) of `sourceNodeId`'s
 * output is taken, and `bodyNodeId` (a subordinate node, not wired with
 * edges) runs once per item with at most `maxParallel` (default 4)
 * concurrent executions. The body sees the current item as `{{item}}` /
 * `item` and its position as `{{index}}` / `index`. Results are collected
 * in input order. Match output: `{ results, count }` (plus `costUsd`
 * when body executions reported costs).
 */
export interface MatchNodeConfig {
  sourceNodeId: string;
  sourcePath?: string;
  bodyNodeId: string;
  maxParallel?: number;
}

/** Default cap on nodes executing concurrently within one level (#145). */
export const DEFAULT_MAX_PARALLEL = 8;

/**
 * Config for an `agent` node (#143): per-step role/model/toolset/skills.
 * Every field except `botId`/`prompt` is optional; when present the
 * runner builds an *effective* bot for this step only (the registered
 * bot is never mutated):
 * - `role`     — role/persona label for this step; applied to the
 *                effective bot's system prompt.
 * - `provider` — provider override (else the bot's provider).
 * - `model`    — model override (else the bot's model). Also used to
 *                price the step's token usage (#150).
 * - `toolset`  — tool names enabled for this step (alias: `tools`);
 *                replaces the bot's tool list for this step.
 * - `skills`   — skill names enabled for this step; replaces the bot's
 *                skill list for this step.
 */
export interface AgentNodeConfig {
  botId: string;
  prompt?: string;
  role?: string;
  provider?: string;
  model?: string;
  toolset?: string[] | string;
  /** Alias for `toolset`. */
  tools?: string[] | string;
  skills?: string[] | string;
}

/** Config for a `bot-turn` node: AgentNodeConfig plus thread continuity. */
export interface BotTurnNodeConfig extends AgentNodeConfig {
  /** Optional existing conversation/session id to continue. */
  sessionId?: string;
}

/** Token usage of one step, structurally identical to agent-runtime's. */
export interface WorkflowTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Resolve a workflow's level-parallelism cap (#145): `maxParallel`
 * (canonical) or the `max_parallel` spelling accepted by the file
 * formats, falling back to DEFAULT_MAX_PARALLEL (8).
 */
export function resolveWorkflowMaxParallel(
  def: Pick<WorkflowDefinition, 'maxParallel'> & { max_parallel?: unknown },
): number {
  const raw = def.maxParallel ?? def.max_parallel;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw;
  return DEFAULT_MAX_PARALLEL;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  /** Edges as [fromId, toId] pairs, with optional 'if'-branch labels. */
  edges: WorkflowEdge[];
  /**
   * Optional spend cap. The runner sums the cost signal carried by node
   * outputs (see src/cost.ts: top-level `costUsd`, or `costCents` /
   * `cost_cents`, or the same fields nested under `usage`) and fails the
   * run with a budget error as soon as the total exceeds `maxCostUsd`.
   * Agent/bot-turn usage is priced from the agent-runtime price table
   * (#150), so the cap covers LLM spend too.
   */
  budget?: WorkflowBudget;
  /**
   * Cap on how many nodes of one topological level may execute
   * concurrently (#145). Positive integer, default
   * DEFAULT_MAX_PARALLEL (8). The file formats also accept the
   * `max_parallel` spelling and normalize it to this field.
   */
  maxParallel?: number;
  /** Snake-case alias accepted on input; normalized to `maxParallel`. */
  max_parallel?: number;
}

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'paused' | 'skipped';

export type RunStatus = 'running' | 'paused' | 'succeeded' | 'failed';

export interface NodeState {
  status: NodeStatus;
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  approvalId?: string;
  /**
   * Execution attempts for this node. 1 on first execution; increments when
   * the node is re-executed (e.g. crash-resume re-runs an interrupted node).
   * Feeds run-health retry heuristics.
   */
  attempts?: number;
  /**
   * USD cost attributed to this node, extracted from its output by
   * extractCostUsd (src/cost.ts). Present only when the output carried a
   * cost signal. Summed by the runner for workflow budget enforcement.
   */
  costUsd?: number;
  /**
   * Token usage reported for this node (#150), when the executor
   * returned it (agent/bot-turn nodes, or an injected node executor).
   * In-memory / event-stream data: the SQLite store persists `costUsd`,
   * not the raw usage.
   */
  usage?: WorkflowTokenUsage;
  /** Provider that served an agent/bot-turn node (#143/#150). */
  provider?: string;
  /** Model that served an agent/bot-turn node (#143/#150). */
  model?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: RunStatus;
  nodeStates: Record<string, NodeState>;
  input: unknown;
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  /** Crash-resume checkpoint: index of the last completed step (level). */
  currentStepIndex?: number;
  /** Crash-resume checkpoint: outputs of completed steps, keyed by node id. */
  stepOutputs?: Record<string, unknown>;
}
