// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  BotConfig,
  StreamEvent,
  TelemetryCollector,
  ToolDefinition,
} from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { WorkflowStore } from './store.js';
import { renderTemplate, type TemplateContext } from './template.js';
import { evaluateCode, evaluateCondition, type CodeSandboxContext } from './code-sandbox.js';
import { extractCostUsd, priceUsageUsd, type UsagePricer } from './cost.js';
import {
  buildExecutionPlan,
  computeReachableNodeIds,
  computeTopologicalLevels,
  subordinateIdsOf,
  type DryRunPlan,
} from './plan.js';
import {
  applyStepConfigToBot,
  resolveStepConfig,
  validateStepConfig,
  type ResolvedStepConfig,
} from './step-config.js';
import {
  formatRunEventsJsonl,
  runEventsFromRun,
  type WorkflowRunEvent,
} from './run-events.js';
import {
  isNodeType,
  resolveWorkflowMaxParallel,
  type NodeState,
  type NodeStatus,
  type RunStatus,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowTokenUsage,
} from './types.js';

export type { DryRunPlan, DryRunLevel, DryRunPlanNode } from './plan.js';

/**
 * Request handed to an injected node executor (#150) for agent /
 * bot-turn nodes. The host (API) can pass a real executor that runs
 * the turn its own way (e.g. a different runtime, a recorded fixture,
 * a metered gateway) and returns the text plus token usage; the
 * runner prices the usage itself via its price table / `usagePricer`.
 */
export interface AgentNodeExecutionRequest {
  runId: string;
  workflowId: string;
  node: WorkflowNode;
  /** Resolved per-step config (#143) for this node. */
  step: ResolvedStepConfig;
  /** The registered bot (unmodified). */
  bot: BotConfig;
  /** Effective bot for this step: role/model/toolset/skills applied. */
  effectiveBot: BotConfig;
  message: string;
  sessionId: string;
}

/** Result an injected node executor returns for an agent/bot-turn node. */
export interface AgentNodeExecutionResult {
  text: string;
  /** Token usage of the turn; priced by the runner when present. */
  usage?: WorkflowTokenUsage;
  /** Explicit USD cost; wins over pricing `usage` when present. */
  costUsd?: number;
  providerId?: string;
  modelId?: string;
}

export type WorkflowNodeExecutor = (
  req: AgentNodeExecutionRequest,
) => Promise<AgentNodeExecutionResult>;

export type RunEventCallback = (event: WorkflowRunEvent) => void;

export interface WorkflowRunnerOptions {
  dbPath: string;
  agentRuntime: AgentRuntime;
  governance: GovernanceGateway;
  tools: Map<string, ToolDefinition>;
  bots: Map<string, BotConfig>;
  /**
   * Runtime telemetry collector ("eyes for your AI"). When set, each
   * workflow run gets a telemetry record keyed by runId (a paused run
   * keeps its record open across the approval wait; resume reuses it),
   * with one timed step per node. Metadata-tier fields only.
   */
  telemetry?: TelemetryCollector;
  /**
   * Injectable executor for agent/bot-turn nodes (#150). When set it
   * replaces `agentRuntime.runTurn` for those nodes; its returned
   * token usage is priced by the runner. When unset, the runner uses
   * `agentRuntime.runTurn` and prices the usage IT returns (previously
   * that usage was discarded and agent nodes always cost $0).
   */
  nodeExecutor?: WorkflowNodeExecutor;
  /**
   * Injectable price table (#150): converts (provider, model, usage)
   * to USD. Defaults to the agent-runtime price table
   * (`costOfUsage` / `priceUsageUsd` in src/cost.ts).
   */
  usagePricer?: UsagePricer;
  /**
   * JSONL observability sink (#152): receives every run event
   * (run_started / step_completed / run_finished) as it happens.
   * Equivalent to calling `runner.onRunEvent(cb)` after construction.
   */
  onRunEvent?: RunEventCallback;
}

export type RunUpdateCallback = (run: WorkflowRun) => void;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Extra context for a sub-execution: a node driven directly by a `loop`
 * or `match` node instead of by the DAG. `nodes` replaces the template /
 * sandbox node-output map (so the body sees the latest loop outputs);
 * `item` / `index` / `iteration` feed `{{item}}`, `{{index}}`,
 * `{{iteration}}` and the code sandbox variables of the same names.
 */
interface SubExecutionContext {
  nodes?: Record<string, unknown>;
  item?: unknown;
  index?: number;
  iteration?: number;
}

/**
 * Internal node-execution result: the node's output plus the priced
 * usage side-channel (#150). Agent nodes keep a plain-string output
 * for template compatibility, so their usage/cost cannot ride on the
 * output — they ride here instead.
 */
interface NodeExecutionResult {
  output: unknown;
  usage?: WorkflowTokenUsage;
  costUsd?: number;
  provider?: string;
  model?: string;
}

/** Dot-path lookup (`a.b.0.c`) into a JSON-like value; undefined on miss. */
function getPathValue(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Minimal durable DAG workflow runner.
 *
 * Workflows are validated DAGs with exactly one trigger node. Runs execute
 * level-by-level in topological order: nodes in the same level (fan-out)
 * run concurrently, and a level only starts once every node in the previous
 * level has completed (join = wait for all incoming edges).
 *
 * Every node-state transition and run-status change is persisted to SQLite
 * and broadcast to `onRunUpdate` subscribers (the API layer uses this for SSE).
 */
export class WorkflowRunner {
  private store: WorkflowStore;
  private agentRuntime: AgentRuntime;
  private governance: GovernanceGateway;
  private tools: Map<string, ToolDefinition>;
  private bots: Map<string, BotConfig>;
  private listeners = new Set<RunUpdateCallback>();
  private executing = new Set<string>();
  /**
   * In-memory run cache for the duration of executeRun(). The runner is the
   * sole writer of a run while it executes (guarded by `executing`), so
   * caching the assembled run eliminates ~7 redundant DB round trips per
   * node (each getRun = 2 queries: runs + node_states). All mutations write
   * through to the store immediately — the DB stays the durable source of
   * truth for crash-resume and the API still reads from the store directly.
   */
  private runCache = new Map<string, WorkflowRun>();

  /**
   * Telemetry run ids for workflow runs currently executing (runId →
   * telemetry run id). Kept so executeNode can attach node steps to the
   * right record without changing its signature chain.
   */
  private readonly telemetryRuns = new Map<string, string>();
  private readonly telemetry?: TelemetryCollector;

  /**
   * Accumulated USD cost per in-flight run (sum of extractCostUsd over
   * completed node outputs), for workflow budget enforcement. Entries
   * live only while a run executes; node-level costs are durable on the
   * node states themselves (`costUsd`).
   */
  private readonly runCosts = new Map<string, number>();

  /** Injected agent/bot-turn executor (#150); see WorkflowRunnerOptions. */
  private readonly nodeExecutor?: WorkflowNodeExecutor;
  /** Injected usage pricer (#150); defaults to the agent-runtime table. */
  private readonly usagePricer?: UsagePricer;
  /** JSONL run-event listeners (#152) + per-run in-memory event log. */
  private readonly runEventListeners = new Set<RunEventCallback>();
  private readonly runEvents = new Map<string, WorkflowRunEvent[]>();

  constructor(opts: WorkflowRunnerOptions) {
    this.store = new WorkflowStore(opts.dbPath);
    this.agentRuntime = opts.agentRuntime;
    this.governance = opts.governance;
    this.tools = opts.tools;
    this.bots = opts.bots;
    this.telemetry = opts.telemetry;
    this.nodeExecutor = opts.nodeExecutor;
    this.usagePricer = opts.usagePricer;
    if (opts.onRunEvent) this.runEventListeners.add(opts.onRunEvent);
  }

  // -- run events (#152) ------------------------------------------------------

  /**
   * Subscribe to JSONL-observability run events (run_started /
   * step_completed with costUsd / run_finished with totals). Returns
   * an unsubscribe function.
   */
  onRunEvent(cb: RunEventCallback): () => void {
    this.runEventListeners.add(cb);
    return () => {
      this.runEventListeners.delete(cb);
    };
  }

  /** Events emitted so far for a run (live-collected, in order). */
  getRunEvents(runId: string): WorkflowRunEvent[] {
    const live = this.runEvents.get(runId);
    if (live && live.length > 0) return [...live];
    const run = this.store.getRun(runId);
    return run ? runEventsFromRun(run) : [];
  }

  /**
   * JSONL export for a run: one JSON object per line (run_started,
   * step_completed…, run_finished). Uses live-collected events when
   * available, else reconstructs them from the stored run snapshot.
   */
  exportRunEventsJsonl(runId: string): string {
    return formatRunEventsJsonl(this.getRunEvents(runId));
  }

  private emitRunEvent(event: WorkflowRunEvent): void {
    const list = this.runEvents.get(event.runId) ?? [];
    list.push(event);
    this.runEvents.set(event.runId, list);
    for (const cb of this.runEventListeners) {
      try {
        cb(event);
      } catch (err) {
        console.error('onRunEvent listener threw:', err);
      }
    }
  }

  /** Price token usage with the injected pricer or the default table. */
  private priceUsage(
    providerId: string | undefined,
    modelId: string | undefined,
    usage: WorkflowTokenUsage | undefined,
  ): number {
    if (!usage || !providerId || !modelId) return 0;
    if (this.usagePricer) {
      const priced = this.usagePricer(providerId, modelId, usage);
      if (typeof priced === 'number') return Number.isFinite(priced) && priced >= 0 ? priced : 0;
      if (priced && typeof priced.total === 'number') {
        return Number.isFinite(priced.total) && priced.total >= 0 ? priced.total : 0;
      }
      return 0;
    }
    return priceUsageUsd(providerId, modelId, usage);
  }

  close(): void {
    this.store.close();
  }

  // -- definitions ----------------------------------------------------------

  register(def: WorkflowDefinition): void {
    this.validateDefinition(def);
    this.store.saveWorkflow(def);
  }

  /**
   * Dry run: validate a definition and return its execution plan
   * (topological levels with node ids/types, subordinate loop/match
   * nodes, unreachable nodes) WITHOUT executing anything — the agent
   * runtime, tools, governance and the store are never touched, and the
   * definition does not need to be registered first.
   */
  dryRun(def: WorkflowDefinition): DryRunPlan {
    this.validateDefinition(def);
    return buildExecutionPlan(def);
  }

  listWorkflows(): WorkflowDefinition[] {
    return this.store.listWorkflows();
  }

  getWorkflow(id: string): WorkflowDefinition {
    const def = this.store.getWorkflow(id);
    if (!def) throw new Error(`unknown workflow: ${id}`);
    return def;
  }

  /**
   * Version history of a workflow definition (oldest first). Every
   * register() that changes the definition archives the previous one.
   */
  listWorkflowVersions(id: string): { version: number; savedAt: number }[] {
    this.getWorkflow(id); // throws on unknown workflow
    return this.store.listWorkflowVersions(id);
  }

  /** A previously archived definition version. */
  getWorkflowVersion(id: string, version: number): WorkflowDefinition {
    this.getWorkflow(id); // throws on unknown workflow
    const def = this.store.getWorkflowVersion(id, version);
    if (!def) throw new Error(`unknown version ${version} of workflow: ${id}`);
    return def;
  }

  private validateDefinition(def: WorkflowDefinition): void {
    if (!def.id) throw new Error('workflow must have an id');
    if (def.budget !== undefined) {
      const max = def.budget.maxCostUsd;
      if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
        throw new Error('workflow budget.maxCostUsd must be a non-negative number');
      }
    }
    if (def.maxParallel !== undefined || def.max_parallel !== undefined) {
      const raw = def.maxParallel ?? def.max_parallel;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        throw new Error('workflow maxParallel must be a positive integer');
      }
      if (
        def.maxParallel !== undefined &&
        def.max_parallel !== undefined &&
        def.maxParallel !== def.max_parallel
      ) {
        throw new Error('workflow maxParallel and max_parallel disagree');
      }
    }
    const ids = new Set<string>();
    const byId = new Map<string, WorkflowNode>();
    for (const node of def.nodes) {
      if (!node.id) throw new Error('workflow node must have an id');
      if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      if (!isNodeType(node.type)) {
        throw new Error(`node ${node.id}: unknown node type: ${String(node.type)}`);
      }
      ids.add(node.id);
      byId.set(node.id, node);
      this.validateNodeConfig(node);
      if (node.retry !== undefined) {
        const { maxAttempts, backoffMs } = node.retry;
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
          throw new Error(`node ${node.id}: retry.maxAttempts must be a positive integer`);
        }
        if (backoffMs !== undefined && (typeof backoffMs !== 'number' || backoffMs < 0)) {
          throw new Error(`node ${node.id}: retry.backoffMs must be a non-negative number`);
        }
      }
      if (node.timeoutMs !== undefined && (typeof node.timeoutMs !== 'number' || !(node.timeoutMs > 0))) {
        throw new Error(`node ${node.id}: timeoutMs must be a positive number`);
      }
    }
    // loop/match subordinate references must exist and not be self-refs.
    for (const node of def.nodes) {
      for (const ref of subordinateIdsOf(node)) {
        if (!ids.has(ref)) {
          throw new Error(`node ${node.id} (${node.type}) references unknown node: ${ref}`);
        }
        if (ref === node.id) {
          throw new Error(`node ${node.id} (${node.type}) must not reference itself as its body/evaluator`);
        }
      }
      if (node.type === 'loop') {
        const config = asRecord(node.config);
        if (config['bodyNodeId'] === config['evaluatorNodeId']) {
          throw new Error(`loop node ${node.id}: bodyNodeId and evaluatorNodeId must differ`);
        }
      }
      if (node.type === 'match') {
        const config = asRecord(node.config);
        if (config['sourceNodeId'] === node.id) {
          throw new Error(`match node ${node.id}: sourceNodeId must not be the match node itself`);
        }
      }
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
    const triggers = def.nodes.filter((n) => n.type === 'trigger');
    if (triggers.length !== 1) {
      throw new Error(`workflow must have exactly one trigger node, found ${triggers.length}`);
    }
    // Cycle detection: Kahn's algorithm over the full graph.
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

  /**
   * Builder-time config checks for node types with required config shapes.
   * (agent/tool/http checks stay at run time, matching previous behavior.)
   */
  private validateNodeConfig(node: WorkflowNode): void {
    const config = asRecord(node.config);
    // Per-step agent config (#143): role/provider/model/toolset/skills
    // must be well-typed when present on agent/bot-turn nodes.
    validateStepConfig(node);
    if (node.type === 'if') {
      const condition = config['condition'];
      if (typeof condition !== 'string' || condition.trim().length === 0) {
        throw new Error(`if node ${node.id}: config.condition must be a non-empty string`);
      }
    }
    if (node.type === 'set') {
      const assignments = config['assignments'];
      if (assignments !== undefined && (assignments === null || typeof assignments !== 'object' || Array.isArray(assignments))) {
        throw new Error(`set node ${node.id}: config.assignments must be an object`);
      }
    }
    if (node.type === 'code') {
      const code = config['code'];
      if (typeof code !== 'string' || code.trim().length === 0) {
        throw new Error(`code node ${node.id}: config.code must be a non-empty string`);
      }
    }
    if (node.type === 'loop') {
      const bodyNodeId = config['bodyNodeId'];
      const evaluatorNodeId = config['evaluatorNodeId'];
      if (typeof bodyNodeId !== 'string' || bodyNodeId.length === 0) {
        throw new Error(`loop node ${node.id}: config.bodyNodeId is required`);
      }
      if (typeof evaluatorNodeId !== 'string' || evaluatorNodeId.length === 0) {
        throw new Error(`loop node ${node.id}: config.evaluatorNodeId is required`);
      }
      const maxIterations = config['maxIterations'];
      if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || (maxIterations as number) < 1)) {
        throw new Error(`loop node ${node.id}: config.maxIterations must be a positive integer`);
      }
      const acceptPath = config['acceptPath'];
      if (acceptPath !== undefined && (typeof acceptPath !== 'string' || acceptPath.length === 0)) {
        throw new Error(`loop node ${node.id}: config.acceptPath must be a non-empty string`);
      }
    }
    if (node.type === 'match') {
      const sourceNodeId = config['sourceNodeId'];
      const bodyNodeId = config['bodyNodeId'];
      if (typeof sourceNodeId !== 'string' || sourceNodeId.length === 0) {
        throw new Error(`match node ${node.id}: config.sourceNodeId is required`);
      }
      if (typeof bodyNodeId !== 'string' || bodyNodeId.length === 0) {
        throw new Error(`match node ${node.id}: config.bodyNodeId is required`);
      }
      const sourcePath = config['sourcePath'];
      if (sourcePath !== undefined && (typeof sourcePath !== 'string' || sourcePath.length === 0)) {
        throw new Error(`match node ${node.id}: config.sourcePath must be a non-empty string`);
      }
      const maxParallel = config['maxParallel'];
      if (maxParallel !== undefined && (!Number.isInteger(maxParallel) || (maxParallel as number) < 1)) {
        throw new Error(`match node ${node.id}: config.maxParallel must be a positive integer`);
      }
    }
  }

  // -- runs -----------------------------------------------------------------

  /**
   * Create a run and start executing it asynchronously. Resolves with the
   * freshly created run snapshot; execution continues in the background.
   * When `idempotencyKey` is provided and a run already exists for it, the
   * existing run is returned without re-executing anything.
   */
  async startRun(
    workflowId: string,
    input: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<WorkflowRun> {
    const def = this.getWorkflow(workflowId);
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.store.getRunByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }

    const now = Date.now();
    const nodeStates: WorkflowRun['nodeStates'] = {};
    const reachable = this.reachableFromTrigger(def);
    for (const node of def.nodes) {
      nodeStates[node.id] = { status: reachable.has(node.id) ? 'pending' : 'skipped' };
    }
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId,
      status: 'running',
      nodeStates,
      input,
      createdAt: now,
      updatedAt: now,
    };
    if (idempotencyKey) run.idempotencyKey = idempotencyKey;

    try {
      this.store.insertRun(run);
    } catch (err) {
      // Lost a race with a concurrent startRun using the same idempotency key.
      if (idempotencyKey && isUniqueConstraintError(err)) {
        const existing = this.store.getRunByIdempotencyKey(idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }

    // Execute asynchronously without blocking the caller.
    void this.executeRun(run.id).catch((err: unknown) => {
      // executeNode already captures node failures; this is a last-resort guard
      // so an unexpected runner bug still marks the run failed instead of hanging.
      try {
        this.setRunStatus(run.id, 'failed');
      } catch {
        // store may be closed; nothing more we can do
      }
      console.error(`workflow run ${run.id} crashed:`, err);
    });

    return this.getRunOrThrow(run.id);
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.store.getRun(id);
  }

  /** Look up a run by the idempotency key it was started with, if any. */
  getRunByIdempotencyKey(key: string): WorkflowRun | undefined {
    return this.store.getRunByIdempotencyKey(key);
  }

  /** Newest first. */
  listRuns(workflowId?: string): WorkflowRun[] {
    return this.store.listRuns(workflowId);
  }

  /**
   * Resolve once the run reaches a terminal status (succeeded/failed).
   * Rejects on timeout (default 120s) so callers never hang forever.
   */
  awaitRun(id: string, timeoutMs = 120_000): Promise<WorkflowRun> {
    const current = this.store.getRun(id);
    if (!current) return Promise.reject(new Error(`unknown run: ${id}`));
    if (TERMINAL_STATUSES.has(current.status)) return Promise.resolve(current);

    return new Promise<WorkflowRun>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out waiting for run ${id} after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsubscribe = this.onRunUpdate((run) => {
        if (run.id !== id) return;
        if (TERMINAL_STATUSES.has(run.status)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(run);
        }
      });
      // Re-check in case the run finished between the first check and subscribing.
      const rechecked = this.store.getRun(id);
      if (rechecked && TERMINAL_STATUSES.has(rechecked.status)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(rechecked);
      }
    });
  }

  /**
   * Crash recovery: find runs stuck in 'running' (the process died without
   * marking them terminal) and resume each from its last checkpoint.
   * Completed steps are never re-executed — resume skips nodes already
   * 'succeeded' and re-runs only pending/interrupted ones. Runs 'paused' for
   * approval stay paused; terminal runs are untouched. Idempotent: calling
   * recover() twice resumes nothing the second time (runs are either picked
   * up by the in-flight `executing` guard or already terminal).
   *
   * Call this once at boot before starting the scheduler / API.
   */
  async recover(): Promise<string[]> {
    const crashed = this.store.listCrashedRuns();
    const resumed: string[] = [];
    for (const run of crashed) {
      if (this.executing.has(run.id)) continue;
      resumed.push(run.id);
      // Await each resume sequentially: keeps the burst of recovered runs
      // bounded and preserves FIFO order by last update.
      try {
        await this.executeRun(run.id);
      } catch (err) {
        console.error(`workflow run ${run.id} failed during recovery:`, err);
      }
    }
    return resumed;
  }
  /**
   * Subscribe to run updates. The callback fires after every node-state
   * transition and every run-status change. Returns an unsubscribe function.
   */
  onRunUpdate(cb: RunUpdateCallback): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // -- execution -------------------------------------------------------------

  private async executeRun(runId: string): Promise<void> {
    if (this.executing.has(runId)) return;
    this.executing.add(runId);
    // Prime the run cache: every getRunOrThrow below hits memory instead of
    // re-assembling the run from SQLite (2 queries per call).
    const primed = this.store.getRun(runId);
    if (primed) this.runCache.set(runId, primed);
    // Budget accounting: seed from costs already recorded on completed
    // node states (crash-resume must not reset the spend meter).
    if (primed && !this.runCosts.has(runId)) {
      let seed = 0;
      for (const state of Object.values(primed.nodeStates)) {
        if (state.status === 'succeeded' && typeof state.costUsd === 'number') {
          seed += state.costUsd;
        }
      }
      this.runCosts.set(runId, seed);
    }
    // Runtime telemetry: one record per workflow run, keyed by runId so a
    // paused-then-resumed run reuses its record instead of double-counting.
    // Only metadata-tier fields are recorded; the ingestion guard runs.
    let telRunId: string | null = null;
    try {
      telRunId =
        this.telemetry?.beginRun({
          id: runId,
          kind: 'workflow-run',
          workflowId: primed?.workflowId,
          sessionId: runId,
        }) ?? null;
      if (telRunId) this.telemetryRuns.set(runId, telRunId);
    } catch {
      telRunId = null;
    }
    try {
      const run = this.getRunOrThrow(runId);
      const def = this.getWorkflow(run.workflowId);
      const levels = this.topologicalLevels(def);
      // JSONL observability (#152): one run_started per run execution.
      const alreadyStarted = (this.runEvents.get(runId) ?? []).some(
        (e) => e.type === 'run_started',
      );
      if (!alreadyStarted) {
        this.emitRunEvent({
          type: 'run_started',
          ts: Date.now(),
          runId,
          workflowId: def.id,
        });
      }

      for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
        const current = this.getRunOrThrow(runId);
        if (current.status !== 'running') return; // failed or paused-by-await
        // Branch gating: an 'if' node deactivates the untaken branch. A node
        // whose incoming edges are ALL inactive (untaken 'if' branch, or a
        // skipped/failed predecessor) is marked 'skipped' instead of running.
        // The skip propagates level by level, so whole subtrees drop out.
        for (const nodeId of levels[levelIndex]) {
          const s = current.nodeStates[nodeId]?.status;
          if (s === 'pending' && !this.hasActiveIncomingEdge(def, current, nodeId)) {
            this.updateNodeState(runId, nodeId, { status: 'skipped' });
            this.emitRunEvent({
              type: 'step_completed',
              ts: Date.now(),
              runId,
              workflowId: def.id,
              nodeId,
              nodeType: def.nodes.find((n) => n.id === nodeId)?.type,
              status: 'skipped',
              costUsd: 0,
              totalCostUsd: this.runCosts.get(runId) ?? 0,
            });
          }
        }
        // Crash-resume: never re-execute steps that already completed (or
        // were skipped as unreachable). Only pending / interrupted nodes run.
        const pending = levels[levelIndex].filter((nodeId) => {
          const s = current.nodeStates[nodeId]?.status;
          return s !== 'succeeded' && s !== 'skipped';
        });
        if (pending.length > 0) {
          // max_parallel cap (#145): at most `cap` nodes of this level
          // execute concurrently (worker-pool, results via node states).
          const cap = resolveWorkflowMaxParallel(def);
          let cursor = 0;
          const worker = async (): Promise<void> => {
            for (;;) {
              const idx = cursor++;
              if (idx >= pending.length) return;
              await this.executeNode(runId, pending[idx]!);
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(cap, pending.length) }, () => worker()),
          );
        }

        const after = this.getRunOrThrow(runId);
        const states = levels[levelIndex].map((nodeId) => after.nodeStates[nodeId]?.status);
        if (states.some((s) => s === 'failed')) {
          this.finishRun(runId, def, 'failed');
          return;
        }
        if (states.some((s) => s === 'paused')) {
          // A node is awaiting a governance decision; the run stays paused
          // until the decision arrives and that node completes.
          return;
        }
      }
      this.finishRun(runId, def, 'succeeded');
    } finally {
      // Telemetry: close the run record on terminal status only. A run
      // paused for approval keeps its record open across the wait; the
      // resume path reuses it via the id-keyed beginRun above.
      try {
        const final = this.store.getRun(runId)?.status;
        if (telRunId && (final === 'succeeded' || final === 'failed')) {
          this.telemetry?.endRun(telRunId, { status: final === 'succeeded' ? 'ok' : 'error' });
          this.telemetryRuns.delete(runId);
        }
      } catch {
        // Telemetry must never break execution.
      }
      this.runCache.delete(runId);
      this.runCosts.delete(runId);
      this.executing.delete(runId);
    }
  }

  private async executeNode(runId: string, nodeId: string): Promise<void> {
    const run = this.getRunOrThrow(runId);
    const def = this.getWorkflow(run.workflowId);
    const node = def.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`unknown node ${nodeId} in workflow ${def.id}`);

    // Telemetry: one timed step per node (latency + ok/error).
    const telRunId = this.telemetryRuns.get(runId) ?? null;
    const nodeStep = telRunId ? this.telemetry?.startStep(telRunId, node.id, 'node') : null;

    // Attempt counting for run-health retry heuristics: re-execution of an
    // already-attempted node (crash-resume, manual re-run) increments.
    const priorAttempts = run.nodeStates[nodeId]?.attempts ?? 0;
    this.updateNodeState(runId, nodeId, {
      status: 'running',
      startedAt: Date.now(),
      attempts: priorAttempts + 1,
    });
    let lastCostUsd = 0;
    let lastResult: NodeExecutionResult | undefined;
    try {
      const result = await this.runNodeWithPolicy(runId, node, undefined, {
        onAttempt: (attempt) => {
          if (attempt > 1) {
            this.updateNodeState(runId, nodeId, {
              status: 'running',
              attempts: priorAttempts + attempt,
            });
          }
        },
      });
      lastResult = result;
      const output = result.output;
      // Budget: sum the cost of this node — an explicit cost signal on
      // the output, or the priced token usage of an agent/bot-turn
      // step (#150) — and fail on exceeding the workflow's cap.
      const costUsd = result.costUsd ?? extractCostUsd(output);
      lastCostUsd = costUsd;
      if (costUsd > 0) {
        const total = (this.runCosts.get(runId) ?? 0) + costUsd;
        this.runCosts.set(runId, total);
        const maxCostUsd = def.budget?.maxCostUsd;
        if (maxCostUsd !== undefined && total > maxCostUsd) {
          throw new Error(
            `budget exceeded: workflow ${def.id} spent $${total.toFixed(4)} which exceeds its budget of $${maxCostUsd.toFixed(4)} (maxCostUsd) at node ${nodeId}`,
          );
        }
      }
      const patch: Partial<NodeState> & { status: NodeStatus } = {
        status: 'succeeded',
        output,
        endedAt: Date.now(),
      };
      if (costUsd > 0) patch.costUsd = costUsd;
      if (result.usage) patch.usage = result.usage;
      if (result.provider) patch.provider = result.provider;
      if (result.model) patch.model = result.model;
      this.updateNodeState(runId, nodeId, patch);
      this.checkpoint(runId);
      this.emitRunEvent({
        type: 'step_completed',
        ts: Date.now(),
        runId,
        workflowId: def.id,
        nodeId,
        nodeType: node.type,
        status: 'succeeded',
        costUsd,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        totalCostUsd: this.runCosts.get(runId) ?? costUsd,
      });
      nodeStep?.end({ ok: true });
      // A node that paused for approval resumes the run once its decision lands.
      const current = this.getRunOrThrow(runId);
      if (current.status === 'paused') this.setRunStatus(runId, 'running');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      nodeStep?.end({ ok: false, errorKind: err instanceof Error ? err.name : 'Error' });
      const patch: Partial<NodeState> & { status: NodeStatus } = {
        status: 'failed',
        error: message,
        endedAt: Date.now(),
      };
      // Keep the cost of a node that tripped the budget on its state.
      if (lastCostUsd > 0) patch.costUsd = lastCostUsd;
      if (lastResult?.usage) patch.usage = lastResult.usage;
      if (lastResult?.provider) patch.provider = lastResult.provider;
      if (lastResult?.model) patch.model = lastResult.model;
      this.updateNodeState(runId, nodeId, patch);
      this.checkpoint(runId);
      this.emitRunEvent({
        type: 'step_completed',
        ts: Date.now(),
        runId,
        workflowId: def.id,
        nodeId,
        nodeType: node.type,
        status: 'failed',
        costUsd: lastCostUsd,
        ...(lastResult?.usage ? { usage: lastResult.usage } : {}),
        ...(lastResult?.provider ? { provider: lastResult.provider } : {}),
        ...(lastResult?.model ? { model: lastResult.model } : {}),
        totalCostUsd: this.runCosts.get(runId) ?? lastCostUsd,
      });
    }
  }

  /**
   * Run a node's logic under its retry policy and per-attempt timeout.
   * Retry: `node.retry.maxAttempts` total tries (default 1), sleeping
   * `node.retry.backoffMs` (default 0) between tries. Timeout:
   * `node.timeoutMs` caps each attempt via Promise.race — the same style
   * as the code sandbox; the underlying work is not cancelled (JS cannot
   * preempt it), only the wait is abandoned and the attempt fails.
   */
  private async runNodeWithPolicy(
    runId: string,
    node: WorkflowNode,
    override?: SubExecutionContext,
    hooks?: { onAttempt?: (attempt: number) => void },
  ): Promise<NodeExecutionResult> {
    const maxAttempts = node.retry?.maxAttempts ?? 1;
    const backoffMs = node.retry?.backoffMs ?? 0;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      hooks?.onAttempt?.(attempt);
      try {
        return await this.withNodeTimeout(runId, node, override);
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts && backoffMs > 0) await sleep(backoffMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async withNodeTimeout(
    runId: string,
    node: WorkflowNode,
    override?: SubExecutionContext,
  ): Promise<NodeExecutionResult> {
    const work = this.runNodeLogic(runId, node, override);
    const timeoutMs = node.timeoutMs;
    if (timeoutMs === undefined) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`node ${node.id} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runNodeLogic(
    runId: string,
    node: WorkflowNode,
    override?: SubExecutionContext,
  ): Promise<NodeExecutionResult> {
    const run = this.getRunOrThrow(runId);
    const ctx = this.buildTemplateContext(run, override);

    switch (node.type) {
      case 'trigger':
        return { output: run.input };

      case 'agent': {
        const config = asRecord(node.config);
        const botId = config['botId'];
        if (typeof botId !== 'string' || botId.length === 0) {
          throw new Error(`agent node ${node.id}: config.botId is required`);
        }
        if (!this.bots.has(botId)) throw new Error(`agent node ${node.id}: unknown bot ${botId}`);
        const bot = this.bots.get(botId)!;
        const rendered = renderTemplate(config['prompt'] ?? '', ctx);
        const message = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
        const turn = await this.runAgentTurn(runId, node, bot, message, `workflow:${runId}:${node.id}`);
        // Output stays the plain assistant text (templates address it
        // as {{nodes.<id>.output}}); usage/cost ride the side channel.
        return {
          output: turn.text,
          usage: turn.usage,
          costUsd: turn.costUsd,
          provider: turn.provider,
          model: turn.model,
        };
      }

      case 'tool': {
        const config = asRecord(node.config);
        const toolName = config['tool'];
        if (typeof toolName !== 'string' || toolName.length === 0) {
          throw new Error(`tool node ${node.id}: config.tool is required`);
        }
        const tool = this.tools.get(toolName);
        if (!tool) throw new Error(`tool node ${node.id}: unknown tool ${toolName}`);
        const args = asRecord(renderTemplate(config['args'] ?? {}, ctx));
        const toolCtx = { sessionId: `workflow:${runId}`, botId: 'workflow' };

        const evaluation = await this.governance.evaluate(toolName, args, {
          ...toolCtx,
          actor: 'workflow-runner',
        });
        if (evaluation.effect === 'deny') {
          throw new Error('tool call denied by policy');
        }
        if (evaluation.effect === 'require-approval' && evaluation.approvalId) {
          const approved = await this.pauseOnApproval(runId, node.id, evaluation.approvalId);
          if (!approved) throw new Error('denied by user');
        }
        return { output: await tool.handler(args, toolCtx) };
      }

      case 'http': {
        const config = asRecord(node.config);
        const renderedUrl = renderTemplate(config['url'], ctx);
        if (typeof renderedUrl !== 'string' || renderedUrl.length === 0) {
          throw new Error(`http node ${node.id}: config.url is required`);
        }
        const method = typeof config['method'] === 'string' ? config['method'].toUpperCase() : 'GET';
        const headers = asRecord(renderTemplate(config['headers'] ?? {}, ctx)) as Record<string, string>;
        let bodyInit: string | undefined;
        if (config['body'] !== undefined) {
          const renderedBody = renderTemplate(config['body'], ctx);
          if (typeof renderedBody === 'string') {
            bodyInit = renderedBody;
          } else {
            bodyInit = JSON.stringify(renderedBody);
            if (!headers['content-type'] && !headers['Content-Type']) {
              headers['content-type'] = 'application/json';
            }
          }
        }
        const response = await fetch(renderedUrl, { method, headers, body: bodyInit });
        const text = (await response.text()).slice(0, 20_000);
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
        return { output: { status: response.status, body } };
      }

      case 'delay': {
        const config = asRecord(node.config);
        const seconds = Number(config['seconds']);
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`delay node ${node.id}: config.seconds must be a non-negative number`);
        }
        await sleep(seconds * 1000);
        return { output: { waitedSeconds: seconds } };
      }

      case 'approval': {
        const config = asRecord(node.config);
        const rendered = renderTemplate(config['message'] ?? '', ctx);
        const message = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
        const approvalId = this.governance.requestApproval(
          'workflow-approval',
          { message, runId, nodeId: node.id },
          { sessionId: `workflow:${runId}`, botId: 'workflow', actor: 'workflow-runner' },
        );
        const approved = await this.pauseOnApproval(runId, node.id, approvalId);
        if (!approved) throw new Error('denied by user');
        return { output: { approved: true } };
      }

      case 'if': {
        const config = asRecord(node.config);
        const rawCondition = config['condition'];
        if (typeof rawCondition !== 'string' || rawCondition.trim().length === 0) {
          throw new Error(`if node ${node.id}: config.condition must be a non-empty string`);
        }
        const rendered = renderTemplate(rawCondition, ctx);
        const sandboxCtx = this.buildCodeSandboxContext(run, override);
        const condition = await this.evaluateConditionValue(node.id, rendered, sandboxCtx);
        return { output: { condition } };
      }

      case 'set': {
        const config = asRecord(node.config);
        const assignments = asRecord(config['assignments'] ?? {});
        const output: Record<string, unknown> = {};
        if (config['includeInput'] === true) {
          Object.assign(output, asRecord(run.input));
        }
        for (const [field, template] of Object.entries(assignments)) {
          output[field] = renderTemplate(template, ctx);
        }
        return { output };
      }

      case 'code': {
        const config = asRecord(node.config);
        const code = config['code'];
        if (typeof code !== 'string' || code.trim().length === 0) {
          throw new Error(`code node ${node.id}: config.code must be a non-empty string`);
        }
        const timeoutMs =
          typeof config['timeoutMs'] === 'number' ? config['timeoutMs'] : undefined;
        try {
          return {
            output: await evaluateCode(code, this.buildCodeSandboxContext(run, override), timeoutMs),
          };
        } catch (err) {
          throw new Error(
            `code node ${node.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      case 'bot-turn': {
        // Workflow → bot: run a bot turn as a node and store the output.
        // Unlike the 'agent' node (which always runs in an isolated
        // per-node session and returns raw text), 'bot-turn' supports
        // thread continuity: pass config.sessionId to continue an existing
        // conversation thread, and the output carries the sessionId so
        // later nodes can chain onto the same thread.
        const config = asRecord(node.config);
        const botId = config['botId'];
        if (typeof botId !== 'string' || botId.length === 0) {
          throw new Error(`bot-turn node ${node.id}: config.botId is required`);
        }
        const bot = this.bots.get(botId);
        if (!bot) throw new Error(`bot-turn node ${node.id}: unknown bot ${botId}`);
        const rendered = renderTemplate(config['prompt'] ?? '', ctx);
        const message = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
        const renderedSession = renderTemplate(config['sessionId'] ?? '', ctx);
        const sessionId =
          typeof renderedSession === 'string' && renderedSession.length > 0
            ? renderedSession
            : `workflow:${runId}:${node.id}`;
        const turn = await this.runAgentTurn(runId, node, bot, message, sessionId);
        // Output carries usage + costUsd (#150) alongside the historic
        // { text, sessionId } shape.
        const output: Record<string, unknown> = { text: turn.text, sessionId };
        if (turn.usage) output['usage'] = turn.usage;
        if (turn.costUsd > 0) output['costUsd'] = turn.costUsd;
        return {
          output,
          usage: turn.usage,
          costUsd: turn.costUsd,
          provider: turn.provider,
          model: turn.model,
        };
      }

      case 'loop': {
        const config = asRecord(node.config);
        const bodyNodeId = config['bodyNodeId'];
        const evaluatorNodeId = config['evaluatorNodeId'];
        if (typeof bodyNodeId !== 'string' || bodyNodeId.length === 0) {
          throw new Error(`loop node ${node.id}: config.bodyNodeId is required`);
        }
        if (typeof evaluatorNodeId !== 'string' || evaluatorNodeId.length === 0) {
          throw new Error(`loop node ${node.id}: config.evaluatorNodeId is required`);
        }
        const maxIterations =
          typeof config['maxIterations'] === 'number' && config['maxIterations'] >= 1
            ? Math.floor(config['maxIterations'])
            : 5;
        const acceptPath =
          typeof config['acceptPath'] === 'string' && config['acceptPath'].length > 0
            ? config['acceptPath']
            : 'accept';
        const def = this.getWorkflow(run.workflowId);
        // Working output map: starts from the run's current node outputs
        // and is updated with each iteration's body/evaluator outputs so
        // both see the latest values via nodes.<id>.output.
        const outputs: Record<string, unknown> = { ...(override?.nodes ?? {}) };
        if (!override?.nodes) {
          for (const [id, state] of Object.entries(run.nodeStates)) {
            outputs[id] = state.output;
          }
        }
        const history: {
          iteration: number;
          bodyOutput: unknown;
          evaluatorOutput: unknown;
          accepted: boolean;
        }[] = [];
        let totalCostUsd = 0;
        let lastBodyOutput: unknown;
        let lastEvaluatorOutput: unknown;
        for (let iteration = 1; iteration <= maxIterations; iteration++) {
          const bodyResult = await this.executeSubNode(runId, def, bodyNodeId, {
            nodes: { ...outputs },
            iteration,
            item: override?.item,
            index: override?.index,
          });
          const bodyOutput = bodyResult.output;
          outputs[bodyNodeId] = bodyOutput;
          lastBodyOutput = bodyOutput;
          totalCostUsd += bodyResult.costUsd ?? extractCostUsd(bodyOutput);
          const evaluatorResult = await this.executeSubNode(runId, def, evaluatorNodeId, {
            nodes: { ...outputs },
            iteration,
            item: override?.item,
            index: override?.index,
          });
          const evaluatorOutput = evaluatorResult.output;
          outputs[evaluatorNodeId] = evaluatorOutput;
          lastEvaluatorOutput = evaluatorOutput;
          totalCostUsd += evaluatorResult.costUsd ?? extractCostUsd(evaluatorOutput);
          const accepted = this.loopAccepted(evaluatorOutput, acceptPath);
          history.push({ iteration, bodyOutput, evaluatorOutput, accepted });
          if (accepted) {
            this.markSubNodeSucceeded(runId, bodyNodeId, bodyOutput);
            this.markSubNodeSucceeded(runId, evaluatorNodeId, evaluatorOutput);
            const out: Record<string, unknown> = {
              accepted: true,
              iterations: iteration,
              bodyOutput,
              evaluatorOutput,
              history,
            };
            if (totalCostUsd > 0) out['costUsd'] = totalCostUsd;
            return { output: out, costUsd: totalCostUsd };
          }
        }
        // Exhausted: body/evaluator themselves ran fine — record their
        // last outputs — but the loop node fails with a clear error.
        this.markSubNodeSucceeded(runId, bodyNodeId, lastBodyOutput);
        this.markSubNodeSucceeded(runId, evaluatorNodeId, lastEvaluatorOutput);
        throw new Error(
          `loop node ${node.id}: evaluator did not accept after ${maxIterations} iteration(s) (maxIterations exhausted)`,
        );
      }

      case 'match': {
        const config = asRecord(node.config);
        const sourceNodeId = config['sourceNodeId'];
        const bodyNodeId = config['bodyNodeId'];
        if (typeof sourceNodeId !== 'string' || sourceNodeId.length === 0) {
          throw new Error(`match node ${node.id}: config.sourceNodeId is required`);
        }
        if (typeof bodyNodeId !== 'string' || bodyNodeId.length === 0) {
          throw new Error(`match node ${node.id}: config.bodyNodeId is required`);
        }
        const maxParallel =
          typeof config['maxParallel'] === 'number' && config['maxParallel'] >= 1
            ? Math.floor(config['maxParallel'])
            : 4;
        const sourcePath =
          typeof config['sourcePath'] === 'string' && config['sourcePath'].length > 0
            ? config['sourcePath']
            : undefined;
        const def = this.getWorkflow(run.workflowId);
        const outputs: Record<string, unknown> = { ...(override?.nodes ?? {}) };
        if (!override?.nodes) {
          for (const [id, state] of Object.entries(run.nodeStates)) {
            outputs[id] = state.output;
          }
        }
        const sourceOutput = outputs[sourceNodeId];
        const itemsRaw = sourcePath ? getPathValue(sourceOutput, sourcePath) : sourceOutput;
        if (!Array.isArray(itemsRaw)) {
          throw new Error(
            `match node ${node.id}: source ${sourceNodeId}${sourcePath ? `.${sourcePath}` : ''} did not produce an array`,
          );
        }
        const items = itemsRaw as unknown[];
        const results: unknown[] = new Array(items.length);
        const costs: number[] = new Array(items.length).fill(0);
        let cursor = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            const sub = await this.executeSubNode(runId, def, bodyNodeId, {
              nodes: { ...outputs },
              item: items[index],
              index,
              iteration: override?.iteration,
            });
            results[index] = sub.output;
            costs[index] = sub.costUsd ?? extractCostUsd(sub.output);
          }
        };
        const workerCount = Math.min(maxParallel, items.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        const totalCostUsd = costs.reduce((a, b) => a + b, 0);
        if (items.length > 0) {
          this.markSubNodeSucceeded(runId, bodyNodeId, results);
        } else {
          this.updateNodeState(runId, bodyNodeId, { status: 'skipped' });
        }
        const out: Record<string, unknown> = { results, count: items.length };
        if (totalCostUsd > 0) out['costUsd'] = totalCostUsd;
        return { output: out, costUsd: totalCostUsd };
      }

      default:
        throw new Error(`unsupported node type: ${(node as WorkflowNode).type}`);
    }
  }

  /**
   * Run one agent/bot-turn step (#143 + #150): resolve the per-step
   * config, build the effective bot, execute via the injected
   * `nodeExecutor` when present else `agentRuntime.runTurn`, and price
   * the returned token usage with the runner's price table / injected
   * pricer. An executor-supplied explicit `costUsd` wins over pricing.
   */
  private async runAgentTurn(
    runId: string,
    node: WorkflowNode,
    bot: BotConfig,
    message: string,
    sessionId: string,
  ): Promise<{
    text: string;
    usage?: WorkflowTokenUsage;
    costUsd: number;
    provider?: string;
    model?: string;
  }> {
    const run = this.getRunOrThrow(runId);
    const step = resolveStepConfig(asRecord(node.config));
    const effectiveBot = applyStepConfigToBot(bot, step);
    const provider = effectiveBot.provider;
    const model = effectiveBot.model;

    if (this.nodeExecutor) {
      const res = await this.nodeExecutor({
        runId,
        workflowId: run.workflowId,
        node,
        step,
        bot,
        effectiveBot,
        message,
        sessionId,
      });
      const usage = res.usage;
      const costUsd =
        typeof res.costUsd === 'number' && Number.isFinite(res.costUsd) && res.costUsd >= 0
          ? res.costUsd
          : this.priceUsage(res.providerId ?? provider, res.modelId ?? model, usage);
      return {
        text: res.text,
        usage,
        costUsd,
        provider: res.providerId ?? provider,
        model: res.modelId ?? model,
      };
    }

    let text = '';
    let doneUsage: WorkflowTokenUsage | undefined;
    const returned = await this.agentRuntime.runTurn({
      bot: effectiveBot,
      message,
      sessionId,
      onEvent: (event: StreamEvent) => {
        if (event.type === 'token') text += event.content;
        if (event.type === 'done') doneUsage = event.usage;
      },
    });
    const usage: WorkflowTokenUsage | undefined =
      returned && typeof returned === 'object' && typeof returned.promptTokens === 'number'
        ? returned
        : doneUsage;
    return {
      text,
      usage,
      costUsd: this.priceUsage(provider, model, usage),
      provider,
      model,
    };
  }

  /** Acceptance rule for a loop evaluator output (see LoopNodeConfig). */
  private loopAccepted(evaluatorOutput: unknown, acceptPath: string): boolean {
    if (typeof evaluatorOutput === 'boolean') return evaluatorOutput;
    const value = getPathValue(evaluatorOutput, acceptPath);
    return Boolean(value);
  }

  /**
   * Execute a subordinate node (loop/match body or evaluator) directly,
   * under its own retry/timeout policy. Sub-executions do not get their
   * own level in the DAG; their final outputs are recorded on their node
   * states by the driving node via markSubNodeSucceeded.
   */
  private async executeSubNode(
    runId: string,
    def: WorkflowDefinition,
    targetId: string,
    ctx: SubExecutionContext,
  ): Promise<NodeExecutionResult> {
    const target = def.nodes.find((n) => n.id === targetId);
    if (!target) throw new Error(`unknown subordinate node ${targetId} in workflow ${def.id}`);
    return this.runNodeWithPolicy(runId, target, ctx);
  }

  /** Record a subordinate node's final output as a succeeded state. */
  private markSubNodeSucceeded(runId: string, nodeId: string, output: unknown): void {
    const run = this.getRunOrThrow(runId);
    const priorAttempts = run.nodeStates[nodeId]?.attempts ?? 0;
    const patch: Partial<NodeState> & { status: NodeStatus } = {
      status: 'succeeded',
      output,
      endedAt: Date.now(),
      attempts: priorAttempts + 1,
    };
    const costUsd = extractCostUsd(output);
    if (costUsd > 0 && !Array.isArray(output)) patch.costUsd = costUsd;
    this.updateNodeState(runId, nodeId, patch);
  }

  /**
   * Resolve an 'if' condition to a boolean. Templates render first; a plain
   * boolean/number result is used directly, the strings "true"/"false"
   * parse literally, and anything else is evaluated as a JS expression in
   * the code sandbox (e.g. "{{nodes.a.output.n}} > 5" renders to "3 > 5").
   */
  private async evaluateConditionValue(
    nodeId: string,
    rendered: unknown,
    sandboxCtx: CodeSandboxContext,
  ): Promise<boolean> {
    if (typeof rendered === 'boolean') return rendered;
    if (typeof rendered === 'number') return rendered !== 0;
    if (typeof rendered === 'string') {
      const trimmed = rendered.trim();
      const lowered = trimmed.toLowerCase();
      if (lowered === 'true') return true;
      if (lowered === 'false' || lowered === '') return false;
      try {
        return await evaluateCondition(trimmed, sandboxCtx);
      } catch (err) {
        throw new Error(
          `if node ${nodeId}: condition expression failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return Boolean(rendered);
  }

  /**
   * Mark node+run paused on an existing approval and wait for the human
   * decision. Returns true when approved.
   */
  private async pauseOnApproval(
    runId: string,
    nodeId: string,
    approvalId: string,
  ): Promise<boolean> {
    this.updateNodeState(runId, nodeId, { status: 'paused', approvalId });
    this.setRunStatus(runId, 'paused');
    this.checkpoint(runId);
    const decision = await this.governance.awaitDecision(approvalId);
    return decision === 'approved';
  }

  // -- graph helpers ---------------------------------------------------------

  /**
   * True when at least one incoming edge of `nodeId` is currently carrying:
   * the source node succeeded, and — for a labeled edge out of an 'if' node —
   * the label matches the branch the 'if' took. Nodes with no incoming edges
   * (the trigger) always carry.
   */
  private hasActiveIncomingEdge(def: WorkflowDefinition, run: WorkflowRun, nodeId: string): boolean {
    const incoming = def.edges.filter((edge) => edge[1] === nodeId);
    if (incoming.length === 0) return true;
    return incoming.some((edge) => {
      const [from, , branch] = edge;
      const srcState = run.nodeStates[from];
      if (!srcState || srcState.status !== 'succeeded') return false;
      if (branch === undefined) return true;
      const srcNode = def.nodes.find((n) => n.id === from);
      if (srcNode?.type !== 'if') return true; // validated; defensive
      return this.branchTaken(srcState) === (branch === 'true');
    });
  }

  /** Which branch an executed 'if' node took. Defaults to false when unknown. */
  private branchTaken(ifState: NodeState): boolean {
    const output = ifState.output;
    return (
      typeof output === 'object' &&
      output !== null &&
      (output as { condition?: unknown }).condition === true
    );
  }

  private reachableFromTrigger(def: WorkflowDefinition): Set<string> {
    return computeReachableNodeIds(def);
  }

  /**
   * Level-by-level topological order of the trigger-reachable subgraph.
   * Nodes in the same level have no dependencies on each other (fan-out);
   * every level waits for all previous levels (join). Subordinate
   * (loop/match-driven) nodes are excluded — they execute inside their
   * driving node, not as standalone steps.
   */
  private topologicalLevels(def: WorkflowDefinition): string[][] {
    return computeTopologicalLevels(def);
  }

  // -- state helpers ----------------------------------------------------------

  private getRunOrThrow(id: string): WorkflowRun {
    const cached = this.runCache.get(id);
    if (cached) return cached;
    const run = this.store.getRun(id);
    if (!run) throw new Error(`unknown run: ${id}`);
    return run;
  }

  /**
   * Context for the code sandbox: `input` is the run input and
   * `nodes.<id>.output` is that node's output — mirroring the template
   * reference syntax (`{{nodes.<id>.output…}}`) so the same paths work in
   * both places.
   */
  private buildCodeSandboxContext(
    run: WorkflowRun,
    override?: SubExecutionContext,
  ): CodeSandboxContext {
    const nodes: Record<string, unknown> = {};
    if (override?.nodes) {
      for (const [id, output] of Object.entries(override.nodes)) {
        nodes[id] = { output };
      }
    } else {
      for (const [id, state] of Object.entries(run.nodeStates)) {
        nodes[id] = { output: state.output };
      }
    }
    const ctx: CodeSandboxContext = { input: run.input, nodes };
    if (override?.item !== undefined) ctx.item = override.item;
    if (override?.index !== undefined) ctx.index = override.index;
    if (override?.iteration !== undefined) ctx.iteration = override.iteration;
    return ctx;
  }

  private buildTemplateContext(run: WorkflowRun, override?: SubExecutionContext): TemplateContext {
    const nodes: Record<string, unknown> = {};
    if (override?.nodes) {
      Object.assign(nodes, override.nodes);
    } else {
      for (const [id, state] of Object.entries(run.nodeStates)) {
        nodes[id] = state.output;
      }
    }
    const ctx: TemplateContext = { input: run.input, nodes };
    if (override?.item !== undefined) ctx.item = override.item;
    if (override?.index !== undefined) ctx.index = override.index;
    if (override?.iteration !== undefined) ctx.iteration = override.iteration;
    return ctx;
  }

  private updateNodeState(runId: string, nodeId: string, patch: Partial<NodeState> & { status: NodeStatus }): void {
    const run = this.getRunOrThrow(runId);
    const current = run.nodeStates[nodeId] ?? { status: 'pending' as NodeStatus };
    const next: NodeState = { ...current, ...patch };
    this.store.upsertNodeState(runId, nodeId, next);
    // Write-through: keep the cached run in sync so later reads in this
    // execution don't re-assemble from SQLite.
    const cached = this.runCache.get(runId);
    if (cached) cached.nodeStates[nodeId] = next;
    this.emitUpdate(runId);
  }

  /** Set a terminal run status and emit the run_finished event (#152). */
  private finishRun(runId: string, def: WorkflowDefinition, status: 'succeeded' | 'failed'): void {
    this.setRunStatus(runId, status);
    const run = this.getRunOrThrow(runId);
    const steps: { nodeId: string; costUsd: number; status: string }[] = [];
    let summed = 0;
    for (const [nodeId, state] of Object.entries(run.nodeStates)) {
      if (state.status === 'pending' || state.status === 'running' || state.status === 'paused') {
        continue;
      }
      const costUsd = typeof state.costUsd === 'number' ? state.costUsd : 0;
      // Steps completed live in this process already emitted their
      // step_completed events; the breakdown here is for aggregation.
      steps.push({ nodeId, costUsd, status: state.status });
      summed += costUsd;
    }
    this.emitRunEvent({
      type: 'run_finished',
      ts: Date.now(),
      runId,
      workflowId: def.id,
      status,
      totalCostUsd: this.runCosts.get(runId) ?? summed,
      steps,
    });
  }

  private setRunStatus(runId: string, status: RunStatus): void {
    const now = Date.now();
    this.store.updateRunStatus(runId, status, now);
    const cached = this.runCache.get(runId);
    if (cached) {
      cached.status = status;
      cached.updatedAt = now;
    }
    this.emitUpdate(runId);
  }

  /**
   * Write the crash-resume checkpoint for a run: number of completed steps
   * and every completed step's output. Called after each node finishes (and
   * on pause) so a crash always resumes from the latest durable state.
   */
  private checkpoint(runId: string): void {
    const run = this.getRunOrThrow(runId);
    const stepOutputs: Record<string, unknown> = {};
    let completed = 0;
    for (const [nodeId, state] of Object.entries(run.nodeStates)) {
      if (state.status === 'succeeded') {
        completed += 1;
        stepOutputs[nodeId] = state.output;
      }
    }
    this.store.checkpointRun(runId, { currentStepIndex: completed, stepOutputs }, Date.now());
  }

  private emitUpdate(runId: string): void {
    const run = this.runCache.get(runId) ?? this.store.getRun(runId);
    if (!run) return;
    for (const cb of this.listeners) {
      try {
        cb(run);
      } catch (err) {
        console.error('onRunUpdate listener threw:', err);
      }
    }
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/UNIQUE constraint failed/i.test(err.message) || (err as { code?: string }).code === 'ERR_SQLITE_CONSTRAINT_UNIQUE')
  );
}
