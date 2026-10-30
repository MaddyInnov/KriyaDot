// SPDX-License-Identifier: Apache-2.0
/**
 * Autonomous execution-loop policy (closure ADD-4, DeepSeek-harness style).
 *
 * One explicit POLICY unifying the pieces that already exist — the runtime
 * tool loop, the supervisor verify-gate, the no-progress guard, provider /
 * model failover, delegation, and the approval modes:
 *
 *   attempt → verify → diagnose → retry-differently → escalate
 *
 * Rules enforced here (runtime-level, not prompt hints):
 *
 *   1. Never blind-repeat. After a step fails, a retry of the SAME step
 *      must declare a MATERIAL CHANGE — different tool, different args,
 *      different agent/profile, different model, or a revised plan /
 *      context. An identical repeat call is blocked before it executes.
 *   2. Bounded attempts per step. After `maxAttemptsPerStep` ordinary
 *      failures on one step, the step is exhausted: the turn escalates
 *      with a structured summary of what was tried instead of retrying.
 *   3. Escalate-at-once classes are NOT attempts: a governance DENY is
 *      final (the policy never retries a denied action with changed args
 *      to sneak past it), an approval denial/timeout was already decided
 *      by the human, and a missing-credential error needs the user, not
 *      another approach. These are recorded for the trail but never
 *      counted toward the attempt bound and never retried by the policy.
 *   4. Verify before done: when the policy is active the supervisor
 *      verify-gate engages for the turn (see runtime wiring); a failed
 *      verification is recorded and re-enters the loop as a new step.
 *
 * Scope (ADD-4): the policy is ON by default for Universal Chat turns and
 * Chief-of-Staff-led turns, OFF elsewhere unless a bot opts in. A per-bot
 * `executionPolicy.enabled: false` is an explicit opt-out that wins over
 * the scope default; a per-turn config wins over the bot config.
 *
 * The AttemptLedger is the bookkeeping: every attempt records the step,
 * the action, what materially changed, and the failure/outcome. It
 * serializes into the observability run record (`attempts` array on the
 * SpanStore run record — the shape the API work-panel projection reads)
 * and renders as the "what it took" trail (Pro: per-attempt lines;
 * Simple: one plain sentence).
 */

// ---------------------------------------------------------------------------
// Policy object
// ---------------------------------------------------------------------------

/** Default per-step attempt bound (ordinary failures before escalation). */
export const DEFAULT_MAX_ATTEMPTS_PER_STEP = 3;
const MAX_ATTEMPTS_CAP = 10;

/** Per-bot / per-turn configuration for the execution policy. */
export interface ExecutionPolicyConfig {
  /** Explicit on/off. Absent → the scope default decides (see header). */
  enabled?: boolean;
  /** Ordinary failures tolerated on one step before escalation. Default 3. */
  maxAttemptsPerStep?: number;
  /** Run the supervisor verify-gate before a turn may end. Default true. */
  verifyBeforeDone?: boolean;
}

/** A fully-resolved execution policy for one turn. */
export interface ExecutionPolicy {
  enabled: boolean;
  maxAttemptsPerStep: number;
  verifyBeforeDone: boolean;
  /** Why the policy is on/off — recorded in the audit trail. */
  scope: 'universal' | 'chief' | 'bot-opt-in' | 'per-turn' | 'bot-opt-out' | 'off';
}

export interface ExecutionPolicyScopeInput {
  /** The turn runs inside Universal Chat (host flag or universal session). */
  universal?: boolean;
  /** The executing bot is the Chief of Staff. */
  chief?: boolean;
  /** The bot's own `executionPolicy` config (opt-in / opt-out / tuning). */
  botConfig?: ExecutionPolicyConfig;
  /** Per-turn config from the call site; wins over the bot config. */
  perTurn?: ExecutionPolicyConfig | false;
}

function clampAttempts(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_ATTEMPTS_CAP, Math.floor(n)));
}

/**
 * Resolve the effective policy for a turn. Precedence: per-turn `false`
 * or `enabled` > bot `enabled` > scope default (universal/chief = on).
 * Attempt bound / verify flag: per-turn > bot > defaults.
 */
export function resolveExecutionPolicy(input: ExecutionPolicyScopeInput): ExecutionPolicy {
  const bot = input.botConfig;
  const perTurn = input.perTurn === false ? { enabled: false } : input.perTurn;
  const maxAttemptsPerStep = clampAttempts(
    perTurn?.maxAttemptsPerStep ?? bot?.maxAttemptsPerStep,
    DEFAULT_MAX_ATTEMPTS_PER_STEP,
  );
  const verifyBeforeDone = perTurn?.verifyBeforeDone ?? bot?.verifyBeforeDone ?? true;

  if (perTurn?.enabled !== undefined) {
    return {
      enabled: perTurn.enabled,
      maxAttemptsPerStep,
      verifyBeforeDone,
      scope: perTurn.enabled ? 'per-turn' : 'off',
    };
  }
  if (bot?.enabled === false) {
    return { enabled: false, maxAttemptsPerStep, verifyBeforeDone, scope: 'bot-opt-out' };
  }
  if (bot?.enabled === true) {
    return { enabled: true, maxAttemptsPerStep, verifyBeforeDone, scope: 'bot-opt-in' };
  }
  if (input.universal) {
    return { enabled: true, maxAttemptsPerStep, verifyBeforeDone, scope: 'universal' };
  }
  if (input.chief) {
    return { enabled: true, maxAttemptsPerStep, verifyBeforeDone, scope: 'chief' };
  }
  return { enabled: false, maxAttemptsPerStep, verifyBeforeDone, scope: 'off' };
}

/** True when a session id belongs to a Universal Chat shadow/fusion session. */
export function isUniversalSessionId(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('universal');
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * How a failed step is treated by the policy:
 * - 'ordinary'         — counts toward the attempt bound; retry-differently applies.
 * - 'approval'         — a human already decided (denied / timed out). Escalation, not an attempt.
 * - 'credential'       — missing/invalid credential or sign-in. Needs the user, not a retry.
 * - 'governance-deny'  — governance (or an authorizer / peer / team gate) denied the
 *                        action. FINAL: never retried, never routed around.
 */
export type StepFailureClass = 'ordinary' | 'approval' | 'credential' | 'governance-deny';

/** Failure classes that bypass the retry loop immediately (never counted). */
export function isEscalationClass(cls: StepFailureClass): boolean {
  return cls !== 'ordinary';
}

const CREDENTIAL_ERROR_RE =
  /missing credential|credential(?:s)? (?:is |are )?(?:required|missing|not found|invalid)|no api key|api key (?:is )?(?:not configured|missing|invalid)|unauthori[sz]ed|authentication (?:is )?(?:required|failed)|not authenticated|login required|please (?:sign|log) in|account (?:is )?not connected/i;
const APPROVAL_ERROR_RE = /approval (?:denied|timed out|timeout)|not approved|user denied/i;

/**
 * Classify a tool result for the policy. Returns null when the result is
 * not a failure. A `{ denied: true }` result is a governance denial unless
 * its reason says a human approval was denied/timed out. Pure.
 */
export function classifyToolFailure(result: unknown): StepFailureClass | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const rec = result as { error?: unknown; denied?: unknown; reason?: unknown };
  if (rec.denied === true) {
    const reason = typeof rec.reason === 'string' ? rec.reason : '';
    return APPROVAL_ERROR_RE.test(reason) ? 'approval' : 'governance-deny';
  }
  const err = typeof rec.error === 'string' ? rec.error : '';
  if (!err) return null;
  if (CREDENTIAL_ERROR_RE.test(err)) return 'credential';
  if (APPROVAL_ERROR_RE.test(err)) return 'approval';
  return 'ordinary';
}

/** Extract the failure text from a tool result (`error` or denial reason). */
export function toolFailureText(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const rec = result as { error?: unknown; denied?: unknown; reason?: unknown };
  if (typeof rec.error === 'string' && rec.error) return rec.error;
  if (rec.denied === true && typeof rec.reason === 'string' && rec.reason) return rec.reason;
  return undefined;
}

// ---------------------------------------------------------------------------
// Attempt ledger
// ---------------------------------------------------------------------------

/** What materially changed between a failed attempt and its retry. */
export type MaterialChangeKind =
  | 'initial'
  | 'tool'
  | 'args'
  | 'agent'
  | 'model'
  | 'plan'
  | 'verify-retry'
  | 'none';

export type AttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'blocked-identical-retry'
  | 'escalated'
  | 'verify-failed';

/**
 * The serialized attempt shape — the run-record `attempts` array element
 * (the API work-panel projection surfaces this verbatim).
 */
export interface AttemptRecord {
  step: string;
  attempt: number;
  change: string;
  action?: string;
  failure?: string;
  outcome: AttemptOutcome;
}

/** One ledger entry (the in-memory form; serializes to AttemptRecord). */
export interface AttemptLedgerEntry extends AttemptRecord {
  changeMade: MaterialChangeKind;
  /** Failure class when the attempt failed; undefined on success. */
  failureClass?: StepFailureClass;
}

/** Context that can carry a material change between attempts. */
export interface AttemptCallContext {
  /** Current provider/model identity, e.g. "groq/llama-3.3-70b". */
  model?: string;
  /** Current executing agent/profile identity (bot id, delegate profile). */
  agentId?: string;
  /**
   * Monotonic plan/context revision: bumped when the plan is revised or a
   * corrective instruction (validator / gate / steering) re-enters the
   * loop. A higher revision than the failed attempt's counts as a change.
   */
  planRevision?: number;
}

export interface ToolAttemptCall {
  tool: string;
  args?: Record<string, unknown>;
}

export type RetryDecision =
  | { allowed: true; change: MaterialChangeKind; attempt: number }
  | { allowed: false; kind: 'identical-retry'; message: string }
  | { allowed: false; kind: 'attempt-bound'; message: string; summary: string };

/** Stable args hash (sorted keys, values hashed — raw args never stored). */
export function hashToolArgs(args: Record<string, unknown> | undefined): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}`;
  };
  const text = canonical(args ?? {});
  // FNV-1a — a change detector, not a security hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Short, value-free action summary: tool name + sorted arg KEYS only. */
export function summarizeToolAction(call: ToolAttemptCall): string {
  const keys = Object.keys(call.args ?? {}).sort();
  return (keys.length > 0 ? `${call.tool}(${keys.join(', ')})` : `${call.tool}()`).slice(0, 160);
}

interface StepState {
  /** Executed attempts (ordinary + successful). Escalations don't count. */
  attempts: number;
  /** Consecutive ordinary failures (reset by a success on the step). */
  failures: number;
  lastFailedHash?: string;
  lastFailedTool?: string;
  lastFailedCtx?: AttemptCallContext;
}

/** Reserved step name for supervisor verification attempts. */
export const VERIFY_STEP = 'verify';

/**
 * Per-turn attempt ledger + retry gate. The runtime calls
 * `beforeAttempt` before executing a tool call and `afterAttempt` with
 * its outcome; the ledger enforces the material-change rule and the
 * attempt bound, and keeps the trail for the run record.
 */
export class AttemptLedger {
  private readonly entries: AttemptLedgerEntry[] = [];
  private readonly steps = new Map<string, StepState>();
  private verifyFailures = 0;

  constructor(readonly policy: ExecutionPolicy) {}

  get allEntries(): readonly AttemptLedgerEntry[] {
    return this.entries;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  failuresForStep(step: string): number {
    return this.steps.get(step)?.failures ?? 0;
  }

  attemptsForStep(step: string): number {
    return this.steps.get(step)?.attempts ?? 0;
  }

  /** True when the step has hit the attempt bound. */
  isExhausted(step: string): boolean {
    return this.failuresForStep(step) >= this.policy.maxAttemptsPerStep;
  }

  private stateFor(step: string): StepState {
    let s = this.steps.get(step);
    if (!s) {
      s = { attempts: 0, failures: 0 };
      this.steps.set(step, s);
    }
    return s;
  }

  /** The material change of `call` relative to the step's last failure. */
  private changeSinceFailure(
    step: string,
    call: ToolAttemptCall,
    ctx: AttemptCallContext,
  ): MaterialChangeKind {
    const s = this.steps.get(step);
    if (!s || s.failures === 0 || s.lastFailedHash === undefined) return 'initial';
    if (s.lastFailedTool !== undefined && call.tool !== s.lastFailedTool) return 'tool';
    if (hashToolArgs(call.args) !== s.lastFailedHash) return 'args';
    const prev = s.lastFailedCtx ?? {};
    if (ctx.model !== undefined && prev.model !== undefined && ctx.model !== prev.model) return 'model';
    if (ctx.agentId !== undefined && prev.agentId !== undefined && ctx.agentId !== prev.agentId) return 'agent';
    if (
      ctx.planRevision !== undefined &&
      prev.planRevision !== undefined &&
      ctx.planRevision > prev.planRevision
    ) {
      return 'plan';
    }
    return 'none';
  }

  /**
   * Gate a tool call BEFORE it executes. The first attempt on a step and
   * any retry carrying a material change are allowed; an identical repeat
   * of a failed call is blocked; a step at its attempt bound escalates.
   */
  beforeAttempt(step: string, call: ToolAttemptCall, ctx: AttemptCallContext = {}): RetryDecision {
    const s = this.stateFor(step);
    if (s.failures > 0 && s.failures >= this.policy.maxAttemptsPerStep) {
      const summary = this.escalationSummary({
        reason: `the step "${step}" failed ${s.failures} times (the per-step limit is ${this.policy.maxAttemptsPerStep})`,
        step,
      });
      return {
        allowed: false,
        kind: 'attempt-bound',
        message:
          `[execution policy] Attempt bound reached for "${step}": ${s.failures} failed attempts. ` +
          'The turn is escalating to the user with a summary of what was tried instead of retrying.',
        summary,
      };
    }
    const change = this.changeSinceFailure(step, call, ctx);
    if (change === 'none') {
      return {
        allowed: false,
        kind: 'identical-retry',
        message:
          `[execution policy] Blocked an identical retry of ${summarizeToolAction(call)}: this exact call ` +
          'already failed on this step and nothing material changed (same tool, same arguments, same ' +
          'model/agent, same plan). Do NOT repeat it — diagnose the failure, then change the tool, the ' +
          'arguments, the agent/profile, the model, or the plan before trying this step again.',
      };
    }
    return { allowed: true, change, attempt: s.attempts + 1 };
  }

  /**
   * Record the outcome of an executed attempt. Ordinary failures count
   * toward the bound and arm the material-change rule; escalation-class
   * failures (approval / credential / governance-deny) are recorded with
   * outcome 'escalated' and never counted.
   */
  afterAttempt(
    step: string,
    call: ToolAttemptCall,
    input: {
      change: MaterialChangeKind;
      ok: boolean;
      failure?: string;
      failureClass?: StepFailureClass;
      ctx?: AttemptCallContext;
    },
  ): AttemptLedgerEntry {
    const s = this.stateFor(step);
    const action = summarizeToolAction(call);
    if (!input.ok && input.failureClass !== undefined && isEscalationClass(input.failureClass)) {
      const entry: AttemptLedgerEntry = {
        step,
        attempt: s.attempts + 1,
        change: input.change,
        changeMade: input.change,
        action,
        failure: input.failure?.slice(0, 300),
        outcome: 'escalated',
        failureClass: input.failureClass,
      };
      this.entries.push(entry);
      return entry;
    }
    s.attempts += 1;
    const entry: AttemptLedgerEntry = {
      step,
      attempt: s.attempts,
      change: input.change,
      changeMade: input.change,
      action,
      outcome: input.ok ? 'succeeded' : 'failed',
    };
    if (!input.ok) {
      entry.failure = input.failure?.slice(0, 300) ?? 'tool error';
      entry.failureClass = input.failureClass ?? 'ordinary';
      s.failures += 1;
      s.lastFailedHash = hashToolArgs(call.args);
      s.lastFailedTool = call.tool;
      s.lastFailedCtx = { ...input.ctx };
    } else {
      s.failures = 0;
      s.lastFailedHash = undefined;
      s.lastFailedTool = undefined;
      s.lastFailedCtx = undefined;
    }
    this.entries.push(entry);
    return entry;
  }

  /** Record a call the policy blocked before execution (identical retry). */
  noteBlocked(step: string, call: ToolAttemptCall, failure?: string): AttemptLedgerEntry {
    const s = this.stateFor(step);
    const entry: AttemptLedgerEntry = {
      step,
      attempt: s.attempts + 1,
      change: 'none',
      changeMade: 'none',
      action: summarizeToolAction(call),
      failure: failure?.slice(0, 300),
      outcome: 'blocked-identical-retry',
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Record an escalation-class failure that never reached execution
   * (governance deny, approval denied at the card, peer/team gate deny).
   * Recorded for the trail; never counted as an attempt.
   */
  noteEscalation(
    step: string,
    input: { failure: string; failureClass: StepFailureClass; action?: string },
  ): AttemptLedgerEntry {
    const s = this.stateFor(step);
    const entry: AttemptLedgerEntry = {
      step,
      attempt: s.attempts + 1,
      change: 'none',
      changeMade: 'none',
      action: input.action?.slice(0, 160),
      failure: input.failure.slice(0, 300),
      outcome: 'escalated',
      failureClass: input.failureClass,
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Record a supervisor verification outcome. A failed verification is a
   * step of its own; the re-entry it causes bumps the plan revision the
   * runtime passes on later attempts, which is what makes the retry a
   * material ('plan') change.
   */
  noteVerification(input: { ok: boolean; failure?: string }): AttemptLedgerEntry {
    const entry: AttemptLedgerEntry = {
      step: VERIFY_STEP,
      attempt: this.verifyFailures + 1,
      change: this.verifyFailures === 0 ? 'initial' : 'verify-retry',
      changeMade: this.verifyFailures === 0 ? 'initial' : 'verify-retry',
      action: 'supervisor verify-gate',
      outcome: input.ok ? 'succeeded' : 'verify-failed',
    };
    if (!input.ok) {
      entry.failure = input.failure?.slice(0, 300) ?? 'verification failed';
      this.verifyFailures += 1;
    }
    this.entries.push(entry);
    return entry;
  }

  get verificationFailures(): number {
    return this.verifyFailures;
  }

  /**
   * Structured escalation summary: what was tried, per attempt, and why
   * the turn is stopping. Used when the attempt bound is hit and when an
   * escalation-class failure ends a step.
   */
  escalationSummary(input: { reason: string; step?: string }): string {
    const relevant = input.step
      ? this.entries.filter((e) => e.step === input.step)
      : this.entries;
    const lines = relevant.map((e) => {
      const changeText =
        e.attempt <= 1 || e.changeMade === 'initial'
          ? 'first try'
          : e.changeMade === 'none'
            ? 'no material change'
            : `changed: ${e.changeMade}`;
      const failText = e.failure ? ` — failed: ${e.failure}` : '';
      return `- Attempt ${e.attempt} (${e.action ?? e.step}, ${changeText}): ${e.outcome}${failText}`;
    });
    return [
      `I stopped and am escalating to you: ${input.reason}.`,
      'What was tried:',
      ...(lines.length > 0 ? lines : ['- (nothing executed yet)']),
      'You can approve or provide what is missing, suggest a different approach, or rephrase the request.',
    ].join('\n');
  }

  /** The run-record `attempts` array (work-panel shape). */
  toRunRecordAttempts(): AttemptRecord[] {
    return this.entries.map((e) => {
      const rec: AttemptRecord = {
        step: e.step,
        attempt: e.attempt,
        change: e.change,
        outcome: e.outcome,
      };
      if (e.action) rec.action = e.action;
      if (e.failure) rec.failure = e.failure;
      return rec;
    });
  }
}

// ---------------------------------------------------------------------------
// "What it took" trail
// ---------------------------------------------------------------------------

/**
 * Non-trivial per ADD-4: at least one retry (any step attempted twice, a
 * blocked identical retry, or a failed verification) or at least two
 * distinct executed steps.
 */
export function isNonTrivialAttemptTrail(entries: readonly AttemptLedgerEntry[]): boolean {
  const toolSteps = new Set<string>();
  for (const e of entries) {
    if (e.outcome === 'blocked-identical-retry' || e.outcome === 'verify-failed') return true;
    if (e.step !== VERIFY_STEP) {
      toolSteps.add(e.step);
      if (e.attempt >= 2 && e.outcome !== 'escalated') return true;
    }
  }
  return toolSteps.size >= 2;
}

const CHANGE_PHRASE: Record<MaterialChangeKind, string> = {
  initial: 'first try',
  tool: 'switched tool',
  args: 'changed the arguments',
  agent: 'switched agent/profile',
  model: 'switched model',
  plan: 'revised the plan',
  'verify-retry': 'retried after verification',
  none: 'no material change',
};

/**
 * Render the ledger as the "what it took" trail. Returns null for a
 * trivial trail (nothing worth reporting). `pro` = one line per attempt;
 * `simple` = one plain sentence.
 */
export function renderAttemptTrail(
  entries: readonly AttemptLedgerEntry[],
  mode: 'pro' | 'simple',
  opts: { outcome?: 'succeeded' | 'escalated' } = {},
): string | null {
  if (!isNonTrivialAttemptTrail(entries)) return null;
  const outcome = opts.outcome ?? 'succeeded';
  if (mode === 'simple') {
    const executed = entries.filter((e) => e.outcome === 'succeeded' || e.outcome === 'failed');
    const retries = executed.filter((e) => e.attempt >= 2).length;
    const steps = new Set(executed.filter((e) => e.step !== VERIFY_STEP).map((e) => e.step)).size;
    const verifyFails = entries.filter((e) => e.outcome === 'verify-failed').length;
    const bits = [
      `It took ${executed.length} attempt${executed.length === 1 ? '' : 's'} across ${steps} step${steps === 1 ? '' : 's'}`,
    ];
    if (retries > 0) bits.push(`including ${retries} ${retries === 1 ? 'retry' : 'retries'} with a different approach`);
    if (verifyFails > 0) bits.push(`and ${verifyFails} failed verification check${verifyFails === 1 ? '' : 's'}`);
    return outcome === 'escalated'
      ? `${bits.join(', ')} — then I stopped and escalated because the approaches were exhausted.`
      : `${bits.join(', ')} to get this done.`;
  }
  const lines = entries.map((e) => {
    const failText = e.failure ? ` — ${e.failure}` : '';
    return `- ${e.step} · attempt ${e.attempt} · ${CHANGE_PHRASE[e.changeMade]} · ${e.outcome}${failText}`;
  });
  return ['What it took:', ...lines].join('\n');
}
