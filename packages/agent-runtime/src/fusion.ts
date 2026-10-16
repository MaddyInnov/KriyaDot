// SPDX-License-Identifier: Apache-2.0
// Fusion mode (Atomic Agent parity): a planner decomposes a task into
// independent subtasks, a bounded pool of worker agents executes them in
// parallel (respecting declared dependencies), and a fusion step synthesizes
// the worker outputs into one final answer.
//
// Design notes:
// - The orchestrator takes its LLM callables and worker-turn function as
//   injected dependencies, so tests run with zero network / zero cost and
//   the API layer wires in the real AgentRuntime.
// - Worker isolation: each worker gets a fresh session and only its own
//   subtask description (+ shared context + the outputs of the subtasks it
//   declares as dependencies). Workers never see non-dependency peers'
//   outputs until the fusion step.
// - Cost guard: every LLM call's usage is converted to USD through an
//   injected cost function; exceeding maxBudgetUsd aborts the run cleanly
//   (partial results are preserved on the returned result).
// - Planner failure (bad JSON, provider error) falls back to single-agent
//   mode instead of failing the run.

import type { ChatMessage, TokenUsage } from './types.js';

export const FUSION_DEFAULT_MAX_SUBTASKS = 8;
export const FUSION_DEFAULT_MAX_CONCURRENCY = 4;

/** One unit of work produced by the planner. */
export interface FusionSubtask {
  id: string;
  title: string;
  description: string;
  /** Ids of subtasks whose outputs this worker may see before starting. */
  dependencies: string[];
}

export interface FusionPlan {
  subtasks: FusionSubtask[];
  rationale?: string;
}

export interface FusionWorkerResult {
  subtaskId: string;
  title: string;
  /** Final assistant text produced by the worker (empty when errored). */
  output: string;
  usage: TokenUsage;
  /** Set when the worker failed; other workers still ran. */
  error?: string;
}

export type FusionRunStatus = 'completed' | 'aborted_budget' | 'failed';

export interface FusionResult {
  task: string;
  status: FusionRunStatus;
  /** Null when the planner failed and we fell back to single-agent mode. */
  plan: FusionPlan | null;
  workerResults: FusionWorkerResult[];
  /** The fused final answer (or the single worker's output on fallback). */
  fused: string;
  fallbackSingleAgent: boolean;
  usage: TokenUsage;
  /** USD estimate when a cost function was provided, else undefined. */
  costUsd?: number;
  /** Human-readable failure reason when status === 'failed'. */
  error?: string;
}

export type FusionProgressEvent =
  | { type: 'plan_created'; plan: FusionPlan }
  | { type: 'plan_failed'; reason: string }
  | { type: 'worker_started'; subtaskId: string; title: string }
  | { type: 'worker_done'; subtaskId: string; title: string; ok: boolean }
  | { type: 'fusion_started'; workerCount: number }
  | { type: 'done'; result: FusionResultSummary }
  | { type: 'error'; message: string };

/** JSON-safe subset of FusionResult for progress events / API payloads. */
export interface FusionResultSummary {
  task: string;
  status: FusionRunStatus;
  plan: FusionPlan | null;
  workerResults: FusionWorkerResult[];
  fused: string;
  fallbackSingleAgent: boolean;
  usage: TokenUsage;
  costUsd?: number;
  error?: string;
}

export interface FusionRunOptions {
  task: string;
  sharedContext?: string;
  maxSubtasks?: number;
  maxConcurrency?: number;
  /** Max USD for the whole run (planner + workers + fusion). */
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

export interface FusionWorkerTurnInput {
  subtask: FusionSubtask;
  sharedContext?: string;
  /** Outputs of completed dependency subtasks, keyed by subtask id. */
  dependencyOutputs: Map<string, string>;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

export interface FusionWorkerTurnOutput {
  output: string;
  usage: TokenUsage;
}

export type FusionLlmCall = (messages: ChatMessage[]) => Promise<{
  content: string;
  usage: TokenUsage;
}>;

export interface FusionDeps {
  /** Planner model call (decompose the task). */
  planLlm: FusionLlmCall;
  /** Fusion model call (synthesize worker outputs). */
  fuseLlm: FusionLlmCall;
  /** One isolated worker turn. */
  runWorkerTurn: (input: FusionWorkerTurnInput) => Promise<FusionWorkerTurnOutput>;
  /** Optional USD cost estimator; without it the budget guard is disabled. */
  costOf?: (usage: TokenUsage) => number;
}

export class FusionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FusionPlanError';
  }
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Planner system prompt. Demands strict JSON — no prose — so the plan can
 * be parsed deterministically.
 */
export function buildPlannerPrompt(task: string, sharedContext: string | undefined, maxSubtasks: number): ChatMessage[] {
  const context = sharedContext?.trim() ? `\n\nShared context:\n${sharedContext.trim()}\n` : '';
  return [
    {
      role: 'system',
      content: `You are a task planner for a parallel agent system. Decompose the user's task into independent subtasks that can be executed in parallel by worker agents.

Respond with ONLY valid JSON (no markdown fences, no prose) in exactly this shape:
{"subtasks": [{"id": "s1", "title": "short title", "description": "self-contained instructions for the worker", "dependencies": []}], "rationale": "one sentence on why this decomposition"}

Rules:
- At most ${maxSubtasks} subtasks. Fewer is fine — do not invent work.
- Subtask ids must be s1, s2, ... in order.
- Each description must be self-contained: the worker sees ONLY its description (plus shared context), never the other subtasks.
- Use "dependencies" ONLY when a subtask genuinely needs another subtask's output first (the dependent worker will receive that output as context). Prefer empty dependencies so workers run in parallel.
- If the task is simple and needs no decomposition, return {"subtasks": [], "rationale": "..."} and it will run as a single agent turn.`,
    },
    { role: 'user', content: `Task:\n${task}${context}` },
  ];
}

/**
 * Extract and validate a FusionPlan from planner output. Accepts raw JSON
 * or JSON inside markdown fences. Throws FusionPlanError on any problem.
 */
export function parseFusionPlan(text: string): FusionPlan {
  const raw = (text ?? '').trim();
  if (!raw) throw new FusionPlanError('Planner returned empty output');
  const candidates: string[] = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) candidates.push(raw.slice(braceStart, braceEnd + 1));

  let parsed: unknown;
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr !== undefined || parsed === undefined) {
    throw new FusionPlanError('Planner output was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new FusionPlanError('Planner output was not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.subtasks)) {
    throw new FusionPlanError('Planner output is missing "subtasks" array');
  }
  const subtasks: FusionSubtask[] = [];
  for (let i = 0; i < obj.subtasks.length; i++) {
    const s = obj.subtasks[i] as Record<string, unknown>;
    if (typeof s !== 'object' || s === null) throw new FusionPlanError(`Subtask ${i} is not an object`);
    if (typeof s.id !== 'string' || !s.id.trim()) throw new FusionPlanError(`Subtask ${i} is missing a string "id"`);
    if (typeof s.title !== 'string' || !s.title.trim()) throw new FusionPlanError(`Subtask ${i} is missing a string "title"`);
    if (typeof s.description !== 'string' || !s.description.trim()) {
      throw new FusionPlanError(`Subtask ${i} is missing a string "description"`);
    }
    const dependencies = Array.isArray(s.dependencies)
      ? s.dependencies.filter((d): d is string => typeof d === 'string')
      : [];
    subtasks.push({
      id: s.id.trim(),
      title: s.title.trim(),
      description: s.description.trim(),
      dependencies,
    });
  }
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : undefined;
  return { subtasks, rationale };
}

/**
 * Sanitize a parsed plan: clamp to maxSubtasks, dedupe ids, drop unknown
 * and self dependencies. Never throws.
 */
export function sanitizePlan(plan: FusionPlan, maxSubtasks: number): FusionPlan {
  const seen = new Set<string>();
  const subtasks: FusionSubtask[] = [];
  for (const s of plan.subtasks.slice(0, Math.max(0, maxSubtasks))) {
    let id = s.id;
    let n = 2;
    while (seen.has(id)) id = `${s.id}_${n++}`;
    seen.add(id);
    subtasks.push({ ...s, id, dependencies: [] }); // deps fixed below
  }
  const ids = new Set(subtasks.map((s) => s.id));
  // Second pass: keep only dependencies that reference a real, different subtask.
  return {
    ...plan,
    subtasks: subtasks.map((s, i) => ({
      ...s,
      dependencies: plan.subtasks[i].dependencies.filter((d) => d !== s.id && ids.has(d)),
    })),
  };
}

/**
 * Order subtasks into dependency waves (Kahn's algorithm). Each wave's
 * subtasks may run in parallel; later waves see earlier waves' outputs.
 * Cycles degrade gracefully: leftover nodes run in one final wave.
 */
export function planWaves(subtasks: FusionSubtask[]): FusionSubtask[][] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of subtasks) {
    const deps = s.dependencies.filter((d) => byId.has(d) && d !== s.id);
    indegree.set(s.id, deps.length);
    for (const d of deps) {
      const list = dependents.get(d) ?? [];
      list.push(s.id);
      dependents.set(d, list);
    }
  }
  const waves: FusionSubtask[][] = [];
  const done = new Set<string>();
  for (;;) {
    const ready = subtasks.filter((s) => !done.has(s.id) && (indegree.get(s.id) ?? 0) === 0);
    if (ready.length === 0) break;
    waves.push(ready);
    for (const s of ready) {
      done.add(s.id);
      for (const depId of dependents.get(s.id) ?? []) {
        indegree.set(depId, (indegree.get(depId) ?? 1) - 1);
      }
    }
  }
  const leftover = subtasks.filter((s) => !done.has(s.id));
  if (leftover.length > 0) waves.push(leftover); // dependency cycle: run together
  return waves;
}

/** Bounded-concurrency map. Never throws for item failures — fn handles them. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const count = Math.min(Math.max(1, limit), items.length);
  for (let w = 0; w < count; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await fn(items[i]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

export function buildWorkerMessage(
  subtask: FusionSubtask,
  sharedContext: string | undefined,
  dependencyOutputs: Map<string, string>,
  subtasksById: Map<string, FusionSubtask>,
): string {
  const parts: string[] = [];
  if (sharedContext?.trim()) parts.push(`Shared context:\n${sharedContext.trim()}`);
  for (const depId of subtask.dependencies) {
    const out = dependencyOutputs.get(depId);
    if (out === undefined) continue;
    const title = subtasksById.get(depId)?.title ?? depId;
    parts.push(
      `Output of prerequisite subtask "${title}" (use it, do not redo it):\n${out}`,
    );
  }
  parts.push(
    `You are a worker in a fusion run. Complete ONLY the assigned subtask below. Do not attempt anything else.\n\n# Assigned subtask: ${subtask.title}\n${subtask.description}\n\nWhen you are done, write your final result as plain text.`,
  );
  return parts.join('\n\n');
}

export function buildFusionPrompt(task: string, workerResults: FusionWorkerResult[]): ChatMessage[] {
  const sections = workerResults.map((r) => {
    const body = r.error ? `[worker failed: ${r.error}]` : r.output || '(no output)';
    return `### [${r.subtaskId}] ${r.title}\n${body}`;
  });
  return [
    {
      role: 'system',
      content:
        'You are the fusion step of a parallel agent system. Several workers completed parts of a task independently. Synthesize their outputs into one coherent final answer to the original task. Where relevant, note which part contributed what. If workers disagree, reconcile them or surface the disagreement honestly. Do not invent facts beyond what the workers provided.',
    },
    {
      role: 'user',
      content: `Original task:\n${task}\n\n## Worker outputs\n${sections.join('\n\n')}`,
    },
  ];
}

export function summarizeResult(result: FusionResult): FusionResultSummary {
  const { task, status, plan, workerResults, fused, fallbackSingleAgent, usage, costUsd, error } = result;
  return { task, status, plan, workerResults, fused, fallbackSingleAgent, usage, costUsd, error };
}

export class FusionOrchestrator {
  constructor(private readonly deps: FusionDeps) {}

  async run(
    options: FusionRunOptions,
    onProgress?: (e: FusionProgressEvent) => void | Promise<void>,
  ): Promise<FusionResult> {
    const emit = async (e: FusionProgressEvent): Promise<void> => {
      try {
        await onProgress?.(e);
      } catch {
        // Progress listeners must never break the run.
      }
    };
    const maxSubtasks = Math.max(1, options.maxSubtasks ?? FUSION_DEFAULT_MAX_SUBTASKS);
    const maxConcurrency = Math.max(1, options.maxConcurrency ?? FUSION_DEFAULT_MAX_CONCURRENCY);
    const task = (options.task ?? '').trim();
    if (!task) throw new Error('Fusion task must not be empty');

    let usage: TokenUsage = { ...ZERO_USAGE };
    let costUsd = 0;
    const charge = (u: TokenUsage): void => {
      usage = addUsage(usage, u);
      if (this.deps.costOf) costUsd += this.deps.costOf(u);
    };
    const overBudget = (): boolean =>
      options.maxBudgetUsd !== undefined && costUsd > options.maxBudgetUsd;

    const fail = async (message: string, partial: Partial<FusionResult>): Promise<FusionResult> => {
      const result: FusionResult = {
        task,
        status: partial.status ?? 'failed',
        plan: partial.plan ?? null,
        workerResults: partial.workerResults ?? [],
        fused: partial.fused ?? '',
        fallbackSingleAgent: partial.fallbackSingleAgent ?? false,
        usage,
        ...(this.deps.costOf ? { costUsd } : {}),
        error: message,
      };
      await emit({ type: 'error', message });
      await emit({ type: 'done', result: summarizeResult(result) });
      return result;
    };

    // ---- 1. Plan ---------------------------------------------------------
    let plan: FusionPlan;
    try {
      const planRes = await this.deps.planLlm(buildPlannerPrompt(task, options.sharedContext, maxSubtasks));
      charge(planRes.usage);
      if (overBudget()) {
        return fail(`Budget of $${options.maxBudgetUsd} exceeded by the planner call.`, { status: 'aborted_budget' });
      }
      plan = sanitizePlan(parseFusionPlan(planRes.content), maxSubtasks);
    } catch (err) {
      // Graceful fallback: single-agent turn instead of a failed run.
      const reason = err instanceof Error ? err.message : String(err);
      await emit({ type: 'plan_failed', reason });
      return this.runSingleAgent(task, options, usage, costUsd, emit, reason);
    }
    await emit({ type: 'plan_created', plan });

    // Empty plan (planner decided no decomposition) → single worker, still fused trivially.
    if (plan.subtasks.length === 0) {
      return this.runSingleAgent(task, options, usage, costUsd, emit, 'planner returned no subtasks');
    }

    // ---- 2. Workers ------------------------------------------------------
    const byId = new Map(plan.subtasks.map((s) => [s.id, s]));
    const waves = planWaves(plan.subtasks);
    const outputs = new Map<string, string>();
    const workerResults: FusionWorkerResult[] = [];
    const perWorkerBudget =
      options.maxBudgetUsd !== undefined
        ? Math.max(0, (options.maxBudgetUsd - costUsd) / Math.max(1, plan.subtasks.length))
        : undefined;

    for (const wave of waves) {
      if (options.signal?.aborted) {
        return fail('Fusion run aborted.', { status: 'failed', plan, workerResults });
      }
      if (overBudget()) {
        return fail(`Budget of $${options.maxBudgetUsd} exceeded; stopping before launching more workers.`, {
          status: 'aborted_budget',
          plan,
          workerResults,
        });
      }
      const waveResults = await mapWithConcurrency(wave, maxConcurrency, async (subtask) => {
        await emit({ type: 'worker_started', subtaskId: subtask.id, title: subtask.title });
        try {
          const depOutputs = new Map<string, string>();
          for (const depId of subtask.dependencies) {
            const out = outputs.get(depId);
            if (out !== undefined) depOutputs.set(depId, out);
          }
          const out = await this.deps.runWorkerTurn({
            subtask,
            sharedContext: options.sharedContext,
            dependencyOutputs: depOutputs,
            maxBudgetUsd: perWorkerBudget,
            signal: options.signal,
          });
          charge(out.usage);
          outputs.set(subtask.id, out.output);
          const result: FusionWorkerResult = {
            subtaskId: subtask.id,
            title: subtask.title,
            output: out.output,
            usage: out.usage,
          };
          await emit({ type: 'worker_done', subtaskId: subtask.id, title: subtask.title, ok: true });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const result: FusionWorkerResult = {
            subtaskId: subtask.id,
            title: subtask.title,
            output: '',
            usage: { ...ZERO_USAGE },
            error: message,
          };
          await emit({ type: 'worker_done', subtaskId: subtask.id, title: subtask.title, ok: false });
          return result;
        }
      });
      workerResults.push(...waveResults);
    }

    // ---- 3. Fuse ----------------------------------------------------------
    await emit({ type: 'fusion_started', workerCount: workerResults.length });
    if (overBudget()) {
      return fail(`Budget of $${options.maxBudgetUsd} exceeded before the fusion step.`, {
        status: 'aborted_budget',
        plan,
        workerResults,
      });
    }
    let fused: string;
    try {
      const fuseRes = await this.deps.fuseLlm(buildFusionPrompt(task, workerResults));
      charge(fuseRes.usage);
      fused = fuseRes.content;
    } catch (err) {
      return fail(`Fusion step failed: ${err instanceof Error ? err.message : String(err)}`, {
        plan,
        workerResults,
      });
    }

    const result: FusionResult = {
      task,
      status: 'completed',
      plan,
      workerResults,
      fused,
      fallbackSingleAgent: false,
      usage,
      ...(this.deps.costOf ? { costUsd } : {}),
    };
    await emit({ type: 'done', result: summarizeResult(result) });
    return result;
  }

  /** Fallback path: one worker turn with the full task, no decomposition. */
  private async runSingleAgent(
    task: string,
    options: FusionRunOptions,
    usage: TokenUsage,
    costUsd: number,
    emit: (e: FusionProgressEvent) => Promise<void>,
    reason: string,
  ): Promise<FusionResult> {
    const subtask: FusionSubtask = {
      id: 's1',
      title: 'Full task (single agent)',
      description: task,
      dependencies: [],
    };
    await emit({ type: 'worker_started', subtaskId: subtask.id, title: subtask.title });
    let workerResults: FusionWorkerResult[];
    try {
      const out = await this.deps.runWorkerTurn({
        subtask,
        sharedContext: options.sharedContext,
        dependencyOutputs: new Map(),
        maxBudgetUsd: options.maxBudgetUsd,
        signal: options.signal,
      });
      usage = addUsage(usage, out.usage);
      if (this.deps.costOf) costUsd += this.deps.costOf(out.usage);
      workerResults = [{ subtaskId: subtask.id, title: subtask.title, output: out.output, usage: out.usage }];
      await emit({ type: 'worker_done', subtaskId: subtask.id, title: subtask.title, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      workerResults = [
        { subtaskId: subtask.id, title: subtask.title, output: '', usage: { ...ZERO_USAGE }, error: message },
      ];
      await emit({ type: 'worker_done', subtaskId: subtask.id, title: subtask.title, ok: false });
      await emit({ type: 'error', message: `Single-agent fallback failed: ${message} (planner: ${reason})` });
      const result: FusionResult = {
        task,
        status: 'failed',
        plan: null,
        workerResults,
        fused: '',
        fallbackSingleAgent: true,
        usage,
        ...(this.deps.costOf ? { costUsd } : {}),
        error: message,
      };
      await emit({ type: 'done', result: summarizeResult(result) });
      return result;
    }
    const result: FusionResult = {
      task,
      status: 'completed',
      plan: null,
      workerResults,
      fused: workerResults[0].output,
      fallbackSingleAgent: true,
      usage,
      ...(this.deps.costOf ? { costUsd } : {}),
    };
    await emit({ type: 'done', result: summarizeResult(result) });
    return result;
  }
}
