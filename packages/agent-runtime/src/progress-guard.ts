// SPDX-License-Identifier: Apache-2.0
// No-progress guard + turn failure taxonomy (Atomic parity).
//
// The guard watches a turn's tool calls: when the agent makes N consecutive
// calls without producing new information (no new files written, no
// successful results, repeated identical calls), the turn is interrupted
// with a clear "no progress detected" message instead of burning tokens in
// a loop.
//
// The taxonomy classifies every failed turn so the activity log and UI can
// show *why* a turn failed, not just that it did.

/** Why a turn failed. Recorded in the turn/activity log and shown in the UI. */
export type TurnFailureKind =
  | 'tool_error'
  | 'approval_denied'
  | 'no_progress'
  | 'budget_exceeded'
  | 'spend_cap_exceeded'
  | 'provider_limit'
  | 'model_error'
  | 'timeout'
  | 'interrupted'
  | 'max_iterations';

export const TURN_FAILURE_KINDS: readonly TurnFailureKind[] = [
  'tool_error',
  'approval_denied',
  'no_progress',
  'budget_exceeded',
  'spend_cap_exceeded',
  'provider_limit',
  'model_error',
  'timeout',
  'interrupted',
  'max_iterations',
];

export const TURN_FAILURE_DESCRIPTIONS: Record<TurnFailureKind, string> = {
  tool_error: 'A tool call failed with an error.',
  approval_denied: 'The user denied (or did not answer) an approval request.',
  no_progress: 'The agent made repeated tool calls without producing new information.',
  budget_exceeded: 'The turn exceeded its spending cap.',
  spend_cap_exceeded: 'A global or per-bot spend cap blocked the next model call.',
  provider_limit: 'The model provider hit a hard usage limit / quota and no backup could take over.',
  model_error: 'The model provider returned an error.',
  timeout: 'The turn timed out waiting for a response.',
  interrupted: 'The turn was superseded by a newer message.',
  max_iterations: 'The turn hit the iteration limit without a final answer.',
};

export interface TurnFailure {
  kind: TurnFailureKind;
  message: string;
  /** What the agent tried (for no_progress: the repeated calls). */
  detail?: Record<string, unknown>;
}

/** A single observed tool call for progress tracking. */
export interface ObservedCall {
  name: string;
  /** Canonicalized args (sorted keys) for repeat detection. */
  argsKey: string;
  /** True when the call produced genuinely new information. */
  productive: boolean;
}

/**
 * No-progress guard. Feed it each executed tool call; when
 * `consecutiveUnproductive` reaches the threshold it trips and the turn
 * should be interrupted.
 *
 * A call counts as productive when it:
 * - wrote/created/edited a file successfully, or
 * - returned a successful (non-error) result the agent hasn't seen before.
 * Pure reads that return identical content, repeated identical calls, and
 * error results are unproductive.
 */
export class ProgressGuard {
  private readonly threshold: number;
  private consecutiveUnproductive = 0;
  private seenResults = new Set<string>();
  private history: ObservedCall[] = [];
  private tripped = false;

  constructor(threshold = 5) {
    this.threshold = Math.max(2, threshold);
  }

  get unproductiveStreak(): number {
    return this.consecutiveUnproductive;
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  /** Recent call history (for the "what it tried" report). */
  get recentCalls(): ObservedCall[] {
    return this.history.slice(-this.threshold * 2);
  }

  /**
   * Observe one executed tool call. Returns true when the guard trips
   * (the turn should be interrupted now).
   */
  observe(call: { name: string; args: Record<string, unknown>; result: unknown }): boolean {
    if (this.tripped) return true;
    const productive = ProgressGuard.isProductive(call.name, call.args, call.result, this.seenResults);
    const argsKey = ProgressGuard.canonicalArgs(call.args);
    this.history.push({ name: call.name, argsKey, productive });
    if (productive) {
      this.consecutiveUnproductive = 0;
    } else {
      this.consecutiveUnproductive += 1;
    }
    if (this.consecutiveUnproductive >= this.threshold) {
      this.tripped = true;
    }
    return this.tripped;
  }

  /** Reset for a new turn. */
  reset(): void {
    this.consecutiveUnproductive = 0;
    this.seenResults.clear();
    this.history = [];
    this.tripped = false;
  }

  private static canonicalArgs(args: Record<string, unknown>): string {
    const sorted = Object.keys(args)
      .sort()
      .map((k) => `${k}=${JSON.stringify(args[k])}`);
    return sorted.join('&');
  }

  private static isProductive(
    name: string,
    _args: Record<string, unknown>,
    result: unknown,
    seenResults: Set<string>,
  ): boolean {
    // Error results are never productive.
    if (
      result !== null &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      typeof (result as { error?: unknown }).error === 'string'
    ) {
      return false;
    }
    // Successful writes always count as progress.
    if (/^(write_file|create_file|edit_file|patch|delete_file|remove_file|git_commit|git_push)$/.test(name)) {
      return true;
    }
    // New successful result content counts — once. Identical repeats don't.
    const key = `${name}:${typeof result === 'string' ? result : JSON.stringify(result)}`;
    if (seenResults.has(key)) return false;
    seenResults.add(key);
    // A bare successful read with empty content is not progress.
    if (typeof result === 'string' && result.trim().length === 0) return false;
    return true;
  }
}

/**
 * Build the user-facing "no progress" report from the guard state.
 */
export function noProgressReport(guard: ProgressGuard): TurnFailure {
  const calls = guard.recentCalls.map((c) => `${c.name}(${c.argsKey.slice(0, 120)})`);
  return {
    kind: 'no_progress',
    message:
      `No progress detected: ${guard.unproductiveStreak} consecutive tool calls produced no new ` +
      `information. The turn was stopped to avoid wasting tokens. Try rephrasing the request or ` +
      `giving the agent more specific guidance.`,
    detail: { unproductiveStreak: guard.unproductiveStreak, recentCalls: calls },
  };
}

/**
 * Classify an arbitrary turn error into the taxonomy. Pure — safe to test.
 */
export function classifyTurnError(err: unknown, opts?: { aborted?: boolean }): TurnFailureKind {
  if (opts?.aborted) return 'interrupted';
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota|quota (?:exceeded|reached|exhausted)|usage limit (?:reached|exceeded|hit)/i.test(msg)) return 'provider_limit';
  if (/budget cap|budget exceeded/i.test(msg)) return 'budget_exceeded';
  if (/timed? ?out|abort/i.test(msg)) return 'timeout';
  if (/denied|not approved/i.test(msg)) return 'approval_denied';
  if (/no progress/i.test(msg)) return 'no_progress';
  return 'model_error';
}

// ---------------------------------------------------------------------------
// Per-tool error tracking (closure #188): repeated errors change behaviour.
// ---------------------------------------------------------------------------

/** Coarse error class for a tool result (stable across message wording). */
export function classifyToolError(result: unknown): string | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const err = (result as { error?: unknown }).error;
  if (typeof err !== 'string' || !err) return null;
  if (/not found|enoent|no such/i.test(err)) return 'not-found';
  if (/permission|denied|forbidden|eacces/i.test(err)) return 'permission';
  if (/timed? ?out|deadline/i.test(err)) return 'timeout';
  if (/invalid|required|argument|schema/i.test(err)) return 'invalid-args';
  if (/rate|quota|429/i.test(err)) return 'rate-limit';
  return 'error';
}

export interface ToolErrorDirective {
  toolName: string;
  errorClass: string;
  failures: number;
  /** Instruction the runtime injects for the model. */
  instruction: string;
  /** True when the tool should be dropped for the rest of the session. */
  dropTool: boolean;
}

/**
 * Tracks CONSECUTIVE failures per (tool, error class) per session. At
 * `threshold` (default 3) failures the runtime injects a "try an
 * alternative" instruction; with `dropAfterThreshold` (default true)
 * the tool is also dropped for the rest of the session.
 */
export class ToolErrorTracker {
  private readonly counts = new Map<string, number>();
  private readonly dropped = new Set<string>();
  constructor(
    private readonly opts: { threshold?: number; dropAfterThreshold?: boolean } = {},
  ) {}
  get threshold(): number { return this.opts.threshold ?? 3; }
  private key(tool: string, cls: string): string { return `${tool}::${cls}`; }

  /** Observe one executed call. Returns a directive when the threshold is hit (once per tool+class). */
  observe(toolName: string, result: unknown): ToolErrorDirective | null {
    const cls = classifyToolError(result);
    if (!cls) {
      // Success resets this tool's consecutive counters.
      for (const k of [...this.counts.keys()]) {
        if (k.startsWith(`${toolName}::`)) this.counts.delete(k);
      }
      return null;
    }
    const k = this.key(toolName, cls);
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    if (n !== this.threshold) return null;
    const dropTool = this.opts.dropAfterThreshold ?? true;
    if (dropTool) this.dropped.add(toolName);
    return {
      toolName,
      errorClass: cls,
      failures: n,
      dropTool,
      instruction:
        `[tool reliability] Tool "${toolName}" keeps failing with ${cls} errors (${n} times in a row). ` +
        'Stop calling it the same way: diagnose the cause, fix the arguments, or use an alternative tool/approach.' +
        (dropTool ? ` "${toolName}" has been disabled for the rest of this session.` : ''),
    };
  }

  isDropped(toolName: string): boolean { return this.dropped.has(toolName); }
  failureCount(toolName: string, errorClass?: string): number {
    if (errorClass) return this.counts.get(this.key(toolName, errorClass)) ?? 0;
    let total = 0;
    for (const [k, v] of this.counts) if (k.startsWith(`${toolName}::`)) total += v;
    return total;
  }
  reset(): void { this.counts.clear(); this.dropped.clear(); }
}
