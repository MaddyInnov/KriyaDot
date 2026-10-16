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
  | 'model_error'
  | 'timeout'
  | 'interrupted'
  | 'max_iterations';

export const TURN_FAILURE_KINDS: readonly TurnFailureKind[] = [
  'tool_error',
  'approval_denied',
  'no_progress',
  'budget_exceeded',
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
  if (/budget cap|budget exceeded/i.test(msg)) return 'budget_exceeded';
  if (/timed? ?out|abort/i.test(msg)) return 'timeout';
  if (/denied|not approved/i.test(msg)) return 'approval_denied';
  if (/no progress/i.test(msg)) return 'no_progress';
  return 'model_error';
}
