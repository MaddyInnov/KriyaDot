// SPDX-License-Identifier: Apache-2.0
/**
 * Plan verifier — Soteria Verified Plans, Workstream 1 (b) + (c).
 *
 * WHY THIS EXISTS. KriyaDot's plan mode historically produced a
 * free-text plan a human approved by reading prose; no step was ever
 * checked against policy, and execution was never bound to the plan.
 * Soteria's core idea (clean-room re-implementation — see the programme
 * research report) is: verify the WHOLE plan against policy specs
 * BEFORE execution, and recover from the verified plan — never by
 * improvisation — when a step is blocked mid-task.
 *
 * WHAT THE VERIFIER IS. A symbolic evaluator over KriyaDot's own
 * governance oracle — deliberately no SMT/Dafny: a desktop runtime has
 * a millisecond latency budget, and the governance gateway already
 * exposes a side-effect-free `simulate()` that answers "what WOULD
 * policy decide for this call?" without minting approvals or audit
 * rows. The verifier composes that per-step oracle with whole-plan
 * spec evaluation (plan-specs.ts):
 *
 *   1. structural pass — dependsOn references exist, no dependency
 *      cycles (a cyclic plan can never execute in order);
 *   2. per-step oracle pass — every step is simulated; a policy DENY
 *      blocks the step (a tier-1 catastrophic hard-floor hit or a
 *      denylist hit blocks it as CATASTROPHIC — absolute, see
 *      recovery below); require-approval is recorded, not blocked —
 *      the human plan-approval card is the approval;
 *   3. whole-plan spec pass — ordering / requires-history / provenance
 *      evaluated as static constraints over the step sequence
 *      (provenance as static arg-lineage against steps' DECLARED
 *      outputs); postcondition specs are recorded for the runtime
 *      monitor and never block.
 *
 * VERDICTS. `verified` | `blocked(step, specId, reason)` |
 * `undecidable(step, reason)`. A step is undecidable when symbolic
 * evaluation cannot settle it: the oracle itself errored, a provenance
 * claim points at a step that declares no outputs to check against,
 * or the step is flagged semantic (free-text send content whose safety
 * is a judgement, not a pattern). ONLY undecidable steps may be routed
 * to an SLM judge — behind this same interface, via the `verifier`
 * purpose profile — and the judge is OFF by default (symbolic-only).
 * Judge verdicts are recorded with `source: 'judge'` and are NEVER
 * conflated with symbolic results (`source: 'symbolic'`): a plan that
 * passed only because a judge waved a step through says so.
 *
 * RECOVERY (c). `planRecoveryDecision` implements the programme's
 * order, over the verified plan: skip-with-dependents (drop the
 * blocked step and its transitive dependents when the plan's goal
 * steps survive) → ONE bounded re-plan of the remainder (the caller
 * bumps policyContextRevision and re-verifies before continuing) →
 * ask the user with the spec reason. Tier-1 catastrophic denials are
 * ABSOLUTE: the decision is always `escalate` — no skip, no re-plan
 * around them — mirroring AttemptLedger's rule that governance denials
 * are never retried.
 *
 * SCOPING (kill criterion). `scope: 'high-risk-only'` restricts
 * verification to high-risk tool classes (file deletes, payments,
 * sends); out-of-scope steps are reported as such, never silently
 * treated as verified. `scope: 'off'` puts every step out of the
 * POLICY scope: no oracle simulation and no spec evaluation runs for
 * any step, high-risk or not — the runtime never calls the verifier
 * in that configuration (the plan gate itself is disabled), but the
 * verifier honours it too, so no caller can accidentally verify at
 * high-risk scope while believing verification is off. (The
 * structural pass — unknown dependencies, cycles — is scope-
 * independent: it judges whether the plan can execute in order at
 * all, not whether policy allows it.)
 */

import type { PlanSpec, PlanVerificationScope } from './plan-specs.js';
import { isHighRiskTool } from './plan-specs.js';
import type { LLMProvider } from './types.js';

// ---------------------------------------------------------------------------
// Structured plan
// ---------------------------------------------------------------------------

/**
 * One structured plan step — the machine-checkable replacement for a
 * prose plan line. Produced at the runPlanGate seam (the model is asked
 * for structured steps; the human approval card shows their rendering)
 * and reusable from Fusion's post-sanitizePlan output
 * ({@link fusionPlanToPlanSteps}).
 */
export interface PlanStep {
  id: string;
  /** Tool the step will call. Empty string = a pure-reasoning step
   *  (Fusion subtasks): nothing to simulate, structure still checked. */
  tool: string;
  args: Record<string, unknown>;
  /** Ids of steps that must complete before this one. */
  dependsOn: string[];
  /** Human-readable one-liner shown on the approval card. */
  description?: string;
  /**
   * Outputs this step DECLARES it will produce (name → expected value
   * or shape). Provenance specs check later steps' args against these
   * declarations — static arg-lineage, resolved before execution.
   */
  outputs?: Record<string, unknown>;
  /** True when this step is one of the plan's goal steps (recovery
   *  preserves goal steps or escalates). */
  goal?: boolean;
  /**
   * True when the step's safety is semantic (e.g. free-text send
   * content): symbolic evaluation marks it undecidable; only the
   * (flag-gated, default-off) judge may settle it.
   */
  semantic?: boolean;
}

export interface StructuredPlan {
  steps: PlanStep[];
  /** Optional planner rationale, carried for the approval card. */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Oracle + judge interfaces
// ---------------------------------------------------------------------------

/** What the per-step policy oracle reports for one hypothetical call.
 *  Structurally compatible with governance's SimulationResult. */
export interface PlanOracleResult {
  effect: 'allow' | 'require-approval' | 'deny';
  reason?: string;
  matchedRuleId?: string;
  hardFloor?: { tier: 'catastrophic' | 'destructive'; reason: string; patternId: string };
  denylist?: boolean;
}

/**
 * The verifier's per-step policy oracle — in production this is the
 * governance adapter's `simulatePolicy` (side-effect-free; no approvals
 * minted, no audit rows). Injected so tests drive the verifier with
 * deterministic fakes.
 */
export interface PlanPolicyOracle {
  simulate(step: PlanStep): Promise<PlanOracleResult>;
}

/** A judge verdict for one undecidable step. */
export interface PlanJudgeVerdict {
  verdict: 'allow' | 'block';
  reason: string;
}

/**
 * The SLM judge interface (hybrid pass). Implementations judge ONE
 * undecidable step; they never see — and can never override — symbolic
 * blocked/verified results.
 */
export type PlanJudge = (step: PlanStep, context: { plan: StructuredPlan }) => Promise<PlanJudgeVerdict>;

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

export type PlanStepVerdictStatus = 'verified' | 'blocked' | 'undecidable' | 'out-of-scope';

export interface PlanStepVerdict {
  stepId: string;
  status: PlanStepVerdictStatus;
  /** 'symbolic' for the deterministic passes, 'judge' for SLM verdicts.
   *  The two are never conflated (programme requirement). */
  source: 'symbolic' | 'judge';
  /** Spec that blocked the step, when a plan spec did. */
  specId?: string;
  /** Policy rule that blocked the step, when the oracle did. */
  ruleId?: string;
  reason?: string;
  /** True when the block is a tier-1 catastrophic / denylist denial —
   *  absolute for recovery (no skip, no re-plan around it). */
  catastrophic?: boolean;
  /** True when the oracle said this step needs human approval (the
   *  plan-approval card covers it); informational, not a block. */
  requiresApproval?: boolean;
}

export interface PlanPostconditionRecord {
  stepId: string;
  specId: string;
  effectClass: string;
}

export interface PlanVerificationResult {
  status: 'verified' | 'blocked' | 'undecidable';
  steps: PlanStepVerdict[];
  /** Convenience views over `steps`. */
  blocked: PlanStepVerdict[];
  undecidable: PlanStepVerdict[];
  /** Every judge verdict taken, in order (empty in symbolic-only mode). */
  judgeVerdicts: Array<{ stepId: string; verdict: 'allow' | 'block'; reason: string }>;
  /** Postcondition declarations recorded for the runtime monitor. */
  postconditions: PlanPostconditionRecord[];
  /** Wall-clock of the verification pass itself (the cost-study metric). */
  latencyMs: number;
  scope: PlanVerificationScope;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolMatches(pattern: string, toolName: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(toolName);
  } catch {
    return false; // invalid pattern never matches — fail-closed, like rules
  }
}

function argText(args: Record<string, unknown>, arg: string | undefined): string {
  const value = arg !== undefined ? args[arg] : args;
  if (value === undefined) return '';
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** A provenance lineage reference: "$stepId.output" or { $from, output }. */
function lineageRef(value: unknown): { stepId: string; output: string } | null {
  if (typeof value === 'string') {
    const m = value.match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    return m ? { stepId: m[1]!, output: m[2]! } : null;
  }
  if (typeof value === 'object' && value !== null) {
    const r = value as Record<string, unknown>;
    if (typeof r.$from === 'string' && typeof r.output === 'string') {
      return { stepId: r.$from, output: r.output };
    }
  }
  return null;
}

/** Transitive dependents of a step (steps that depend on it, directly or not). */
export function transitiveDependents(plan: StructuredPlan, stepId: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of plan.steps) {
      if (s.id === stepId || out.has(s.id)) continue;
      if (s.dependsOn.includes(stepId) || s.dependsOn.some((d) => out.has(d))) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

function hasCycle(plan: StructuredPlan): string | null {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'visiting') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  for (const s of plan.steps) if (visit(s.id)) return s.id;
  return null;
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

export interface VerifyPlanOptions {
  /** Verification scope (kill-criterion narrowing). Default 'all'. */
  scope?: PlanVerificationScope;
  /** SLM judge for undecidable steps. Only consulted when
   *  `judgeEnabled` is true. DEFAULT: no judge (symbolic-only). */
  judge?: PlanJudge;
  /** Master flag for the hybrid pass. Default false. */
  judgeEnabled?: boolean;
  /** Injectable clock for deterministic latency tests. */
  now?: () => number;
}

/**
 * Verify a structured plan against plan specs + the policy oracle.
 * Purely evaluative: executes nothing, mints nothing.
 */
export async function verifyPlan(
  plan: StructuredPlan,
  specs: readonly PlanSpec[],
  oracle: PlanPolicyOracle,
  opts: VerifyPlanOptions = {},
): Promise<PlanVerificationResult> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const scope: PlanVerificationScope = opts.scope ?? 'all';
  // 'off' must mean off for every step — including high-risk ones.
  // (The naive `scope === 'all' || isHighRiskTool(...)` would keep
  // verifying deletes/pays/sends under an explicit opt-out.)
  const inScope = (step: PlanStep): boolean =>
    scope === 'all' ? true : scope === 'off' ? false : isHighRiskTool(step.tool);
  const verdicts = new Map<string, PlanStepVerdict>();
  const postconditions: PlanPostconditionRecord[] = [];
  const judgeVerdicts: PlanVerificationResult['judgeVerdicts'] = [];

  const setVerdict = (v: PlanStepVerdict): void => {
    const prev = verdicts.get(v.stepId);
    // A block is sticky: later passes never un-block a step.
    if (prev?.status === 'blocked' && v.status !== 'blocked') return;
    verdicts.set(v.stepId, v);
  };

  // -- 1. Structural pass ---------------------------------------------------
  const ids = new Set(plan.steps.map((s) => s.id));
  for (const step of plan.steps) {
    const unknown = step.dependsOn.filter((d) => !ids.has(d));
    if (unknown.length > 0) {
      setVerdict({
        stepId: step.id, status: 'blocked', source: 'symbolic',
        reason: `step depends on unknown step(s): ${unknown.join(', ')}`,
      });
    }
  }
  const cycleAt = hasCycle(plan);
  if (cycleAt) {
    setVerdict({
      stepId: cycleAt, status: 'blocked', source: 'symbolic',
      reason: 'dependency cycle detected — the plan can never execute in order',
    });
  }

  // -- 2. Per-step oracle pass ----------------------------------------------
  for (const step of plan.steps) {
    if (verdicts.get(step.id)?.status === 'blocked') continue;
    if (!inScope(step)) {
      setVerdict({ stepId: step.id, status: 'out-of-scope', source: 'symbolic', reason: `out of verification scope (${scope})` });
      continue;
    }
    if (!step.tool) {
      setVerdict({ stepId: step.id, status: 'verified', source: 'symbolic', reason: 'no tool call — nothing to simulate' });
      continue;
    }
    if (step.semantic) {
      setVerdict({
        stepId: step.id, status: 'undecidable', source: 'symbolic',
        reason: 'semantic step: free-text content whose safety is a judgement, not a pattern',
      });
      continue;
    }
    let sim: PlanOracleResult;
    try {
      sim = await oracle.simulate(step);
    } catch (err) {
      setVerdict({
        stepId: step.id, status: 'undecidable', source: 'symbolic',
        reason: `policy oracle errored: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (sim.effect === 'deny') {
      const catastrophic = sim.hardFloor?.tier === 'catastrophic' || sim.denylist === true;
      setVerdict({
        stepId: step.id, status: 'blocked', source: 'symbolic',
        ...(sim.matchedRuleId ? { ruleId: sim.matchedRuleId } : {}),
        ...(catastrophic ? { catastrophic: true } : {}),
        reason: sim.hardFloor?.reason ?? sim.reason ?? 'policy denies this step',
      });
    } else {
      setVerdict({
        stepId: step.id, status: 'verified', source: 'symbolic',
        ...(sim.effect === 'require-approval' ? { requiresApproval: true } : {}),
        ...(sim.reason ? { reason: sim.reason } : {}),
      });
    }
  }

  // -- 3. Whole-plan spec pass ------------------------------------------------
  const earlier = (idx: number): PlanStep[] => plan.steps.slice(0, idx);
  plan.steps.forEach((step, idx) => {
    if (!inScope(step) && scope !== 'all') return;
    for (const spec of specs) {
      switch (spec.type) {
        case 'ordering': {
          if (spec.relation === 'must-precede' && toolMatches(spec.after, step.tool)) {
            const hasBefore = earlier(idx).some((s) => toolMatches(spec.before, s.tool));
            if (!hasBefore) {
              setVerdict({
                stepId: step.id, status: 'blocked', source: 'symbolic', specId: spec.id,
                reason: spec.reason ?? `ordering: a step matching ${spec.before} must precede ${step.tool} (${spec.id})`,
              });
            }
          }
          if (spec.relation === 'must-not-precede' && toolMatches(spec.before, step.tool)) {
            const laterHasAfter = plan.steps.slice(idx + 1).some((s) => toolMatches(spec.after, s.tool));
            if (laterHasAfter) {
              setVerdict({
                stepId: step.id, status: 'blocked', source: 'symbolic', specId: spec.id,
                reason: spec.reason ?? `ordering: ${step.tool} must not precede a step matching ${spec.after} (${spec.id})`,
              });
            }
          }
          break;
        }
        case 'requires-history': {
          if (!toolMatches(spec.toolPattern, step.tool)) break;
          const min = spec.requires.minCount ?? 1;
          const count = earlier(idx).filter((s) => {
            if (!toolMatches(spec.requires.toolPattern, s.tool)) return false;
            if (spec.requires.argPattern) {
              try {
                return new RegExp(spec.requires.argPattern).test(argText(s.args, spec.requires.arg));
              } catch {
                return false;
              }
            }
            return true;
          }).length;
          if (count < min) {
            setVerdict({
              stepId: step.id, status: 'blocked', source: 'symbolic', specId: spec.id,
              reason: spec.reason ?? `requires-history: ${step.tool} needs an earlier plan step matching ${spec.requires.toolPattern} (${spec.id})`,
            });
          }
          break;
        }
        case 'provenance': {
          if (!toolMatches(spec.toolPattern, step.tool)) break;
          const value = step.args[spec.arg];
          const sourceName = spec.sourceArg ?? spec.arg;
          const ref = lineageRef(value);
          if (ref) {
            const srcIdx = plan.steps.findIndex((s) => s.id === ref.stepId);
            const src = srcIdx >= 0 ? plan.steps[srcIdx] : undefined;
            if (!src || srcIdx >= idx || !toolMatches(spec.sourceToolPattern, src.tool)) {
              setVerdict({
                stepId: step.id, status: 'blocked', source: 'symbolic', specId: spec.id,
                reason: `provenance: arg "${spec.arg}" claims lineage from step ${ref.stepId}, which is not an earlier step matching ${spec.sourceToolPattern} (${spec.id})`,
              });
            } else if (!src.outputs || !(ref.output in src.outputs)) {
              setVerdict({
                stepId: step.id, status: 'undecidable', source: 'symbolic', specId: spec.id,
                reason: `provenance: source step ${src.id} declares no output "${ref.output}" to check lineage against (${spec.id})`,
              });
            }
            break;
          }
          const sources = earlier(idx).filter((s) => toolMatches(spec.sourceToolPattern, s.tool));
          if (sources.length === 0) {
            setVerdict({
              stepId: step.id, status: 'blocked', source: 'symbolic', specId: spec.id,
              reason: spec.reason ?? `provenance: arg "${spec.arg}" of ${step.tool} must be derived from an earlier step matching ${spec.sourceToolPattern}, but the plan has none (${spec.id})`,
            });
          } else if (sources.some((s) => s.outputs && sourceName in s.outputs && deepEqual(s.outputs[sourceName], value))) {
            // Statically derived — verified.
          } else if (sources.every((s) => !s.outputs || !(sourceName in s.outputs))) {
            setVerdict({
              stepId: step.id, status: 'undecidable', source: 'symbolic', specId: spec.id,
              reason: `provenance: earlier ${spec.sourceToolPattern} step(s) declare no output "${sourceName}" — lineage cannot be checked statically (${spec.id})`,
            });
          } else {
            setVerdict({
              stepId: step.id, status: 'blocked', source: 'symbolic', specId: spec.id,
              reason: `provenance: arg "${spec.arg}" value is not among the declared outputs of earlier ${spec.sourceToolPattern} step(s) (${spec.id})`,
            });
          }
          break;
        }
        case 'postcondition': {
          if (toolMatches(spec.toolPattern, step.tool)) {
            postconditions.push({ stepId: step.id, specId: spec.id, effectClass: spec.effectClass });
          }
          break;
        }
      }
    }
  });

  // -- 4. Hybrid pass: judge ONLY the undecidable (flag-gated, default off) --
  if (opts.judgeEnabled && opts.judge) {
    for (const step of plan.steps) {
      const v = verdicts.get(step.id);
      if (!v || v.status !== 'undecidable') continue;
      try {
        const jv = await opts.judge(step, { plan });
        judgeVerdicts.push({ stepId: step.id, verdict: jv.verdict, reason: jv.reason });
        setVerdict({
          stepId: step.id,
          status: jv.verdict === 'allow' ? 'verified' : 'blocked',
          source: 'judge',
          ...(v.specId ? { specId: v.specId } : {}),
          reason: `judge: ${jv.reason}`,
        });
      } catch {
        // A failing judge leaves the step undecidable — never a pass.
      }
    }
  }

  const steps = plan.steps.map((s) => verdicts.get(s.id) ?? { stepId: s.id, status: 'verified' as const, source: 'symbolic' as const });
  const blocked = steps.filter((s) => s.status === 'blocked');
  const undecidable = steps.filter((s) => s.status === 'undecidable');
  return {
    status: blocked.length > 0 ? 'blocked' : undecidable.length > 0 ? 'undecidable' : 'verified',
    steps,
    blocked,
    undecidable,
    judgeVerdicts,
    postconditions,
    latencyMs: Math.max(0, now() - started),
    scope,
  };
}

// ---------------------------------------------------------------------------
// SLM judge factory (verifier purpose profile)
// ---------------------------------------------------------------------------

/**
 * Build a PlanJudge from any chat-capable provider — the runtime wires
 * this with the model resolved from the `verifier` purpose profile.
 * The judge is asked a narrow question about ONE step and must answer
 * with JSON {"verdict":"allow"|"block","reason":"…"}. Unparseable
 * answers throw, which the verifier treats as "still undecidable" —
 * a confused judge can never wave a step through.
 */
export function createProviderPlanJudge(provider: LLMProvider, model: string): PlanJudge {
  return async (step) => {
    const res = await provider.chat(
      [
        {
          role: 'system',
          content:
            'You are a safety judge for ONE step of an agent plan that symbolic policy checks could not settle. ' +
            'Reply with exactly one JSON object: {"verdict":"allow"|"block","reason":"one sentence"}. ' +
            'Block when the step could send, publish, pay, delete or expose anything the user did not clearly ask for.',
        },
        {
          role: 'user',
          content: `Step: tool=${step.tool} args=${JSON.stringify(step.args).slice(0, 800)} description=${step.description ?? ''}`,
        },
      ],
      [],
      { model },
    );
    const text = res.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text) as { verdict?: unknown; reason?: unknown };
    if (parsed.verdict !== 'allow' && parsed.verdict !== 'block') {
      throw new Error('judge returned no verdict');
    }
    return { verdict: parsed.verdict, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  };
}

// ---------------------------------------------------------------------------
// Recovery (c)
// ---------------------------------------------------------------------------

export type PlanRecoveryAction = 'skip-with-dependents' | 'replan' | 'ask' | 'escalate';

export interface PlanRecoveryDecision {
  action: PlanRecoveryAction;
  reason: string;
  /** Steps dropped by a skip (blocked step + transitive dependents). */
  droppedStepIds: string[];
  /** Steps that survive a skip / form the remainder for a re-plan. */
  survivingStepIds: string[];
}

/**
 * Decide recovery for a step blocked mid-execution, in the programme's
 * fixed order. NEVER improvises around a block:
 *   1. catastrophic (tier-1 hard floor / denylist) → `escalate`,
 *      absolute — no skip, no re-plan;
 *   2. goal steps survive dropping the blocked step + its transitive
 *      dependents → `skip-with-dependents`;
 *   3. otherwise, if the one bounded re-plan has not been used →
 *      `replan` the remainder (caller bumps policyContextRevision and
 *      re-verifies the new remainder before continuing);
 *   4. otherwise → `ask` the user, surfacing the spec reason.
 */
export function planRecoveryDecision(input: {
  plan: StructuredPlan;
  blockedStepId: string;
  /** The block's reason (spec / policy), surfaced verbatim to the user on `ask`. */
  reason: string;
  catastrophic?: boolean;
  /** Whether the single bounded re-plan has already been spent this turn. */
  replanUsed?: boolean;
}): PlanRecoveryDecision {
  const { plan, blockedStepId } = input;
  const dependents = transitiveDependents(plan, blockedStepId);
  const dropped = [blockedStepId, ...dependents];
  const surviving = plan.steps.filter((s) => !dropped.includes(s.id)).map((s) => s.id);
  if (input.catastrophic) {
    return {
      action: 'escalate',
      reason: `catastrophic denial is absolute — no skip or re-plan around it: ${input.reason}`,
      droppedStepIds: dropped,
      survivingStepIds: surviving,
    };
  }
  const goalIds = plan.steps.filter((s) => s.goal).map((s) => s.id);
  const goalsSurvive = goalIds.length > 0
    ? goalIds.every((g) => surviving.includes(g))
    : surviving.length > 0;
  if (goalsSurvive && surviving.length > 0) {
    return {
      action: 'skip-with-dependents',
      reason: `blocked step ${blockedStepId} and its ${dependents.size} dependent(s) dropped; goal steps survive: ${input.reason}`,
      droppedStepIds: dropped,
      survivingStepIds: surviving,
    };
  }
  if (!input.replanUsed) {
    return {
      action: 'replan',
      reason: `goal steps do not survive a skip — one bounded re-plan of the remainder: ${input.reason}`,
      droppedStepIds: dropped,
      survivingStepIds: surviving,
    };
  }
  return {
    action: 'ask',
    reason: `re-plan already spent and goal steps do not survive — asking the user: ${input.reason}`,
    droppedStepIds: dropped,
    survivingStepIds: surviving,
  };
}

/** The plan that remains after a skip-with-dependents decision. */
export function applySkipWithDependents(plan: StructuredPlan, decision: PlanRecoveryDecision): StructuredPlan {
  const keep = new Set(decision.survivingStepIds);
  return { ...plan, steps: plan.steps.filter((s) => keep.has(s.id)) };
}

// ---------------------------------------------------------------------------
// Fusion reuse + approval-card rendering
// ---------------------------------------------------------------------------

/** Structural shape of a Fusion plan (post-sanitizePlan) — duplicated
 *  here so this module does not import fusion.ts (which may import
 *  back through index barrels in tests). */
export interface FusionPlanShape {
  subtasks: Array<{ id: string; title: string; description: string; dependencies: string[] }>;
  rationale?: string;
}

/**
 * Convert a Fusion plan (post-`sanitizePlan`) into a StructuredPlan the
 * verifier can check: dependency structure is verified symbolically;
 * subtasks carry no tool calls, so per-step simulation is a no-op and
 * any tool-named spec simply does not match — the reuse the programme
 * asked for, without pretending subtasks are tool calls.
 */
export function fusionPlanToPlanSteps(plan: FusionPlanShape): StructuredPlan {
  return {
    ...(plan.rationale ? { rationale: plan.rationale } : {}),
    steps: plan.subtasks.map((s) => ({
      id: s.id,
      tool: '',
      args: {},
      dependsOn: [...s.dependencies],
      description: `${s.title}: ${s.description}`,
    })),
  };
}

/** Human-readable rendering of a structured plan for the approval card. */
export function renderStructuredPlan(plan: StructuredPlan): string {
  return plan.steps
    .map((s, i) => {
      const tool = s.tool ? ` [${s.tool}]` : '';
      const deps = s.dependsOn.length > 0 ? ` (after ${s.dependsOn.join(', ')})` : '';
      return `${i + 1}. ${s.description ?? s.tool}${tool}${deps}`;
    })
    .join('\n');
}

/** One-line-per-issue summary of a verification result for cards/results. */
export function renderVerificationSummary(result: PlanVerificationResult): string {
  if (result.status === 'verified') {
    const judged = result.judgeVerdicts.length;
    return judged > 0
      ? `Plan verified symbolically; ${judged} step(s) settled by the judge (flagged, not symbolic proof).`
      : 'Plan verified against policy specs.';
  }
  const lines = [
    ...result.blocked.map((b) => `BLOCKED step ${b.stepId}${b.specId ? ` by spec ${b.specId}` : ''}${b.ruleId ? ` by rule ${b.ruleId}` : ''}: ${b.reason ?? ''}`),
    ...result.undecidable.map((u) => `UNDECIDABLE step ${u.stepId}: ${u.reason ?? ''}`),
  ];
  return lines.join('\n');
}
