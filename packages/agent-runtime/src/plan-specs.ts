// SPDX-License-Identifier: Apache-2.0
/**
 * Plan-level policy specs — agent-runtime side (Soteria Verified Plans,
 * Workstream 1 (a)).
 *
 * These types are STRUCTURALLY DUPLICATED from
 * `packages/governance/src/plan-specs.ts`, following the established
 * BotPolicyRule/BotPolicy pattern: governance cannot import
 * agent-runtime (the dependency runs the other way), and the runtime
 * keeps its own declarations so its public types stay self-contained.
 * The two declarations must stay field-compatible — governance tests
 * and runtime tests both pin the shapes.
 *
 * Semantics (see the governance copy for the full rationale): a spec
 * constrains a WHOLE PLAN, not a single call.
 *   - ordering:         step A (before) must / must-not precede step B (after)
 *   - requires-history: a step is valid only if an earlier plan step
 *                       called `requires.toolPattern` with matching args
 *   - provenance:       an arg of step B must be value-derived from an
 *                       earlier step A's declared output
 *   - postcondition:    declared effect class, recorded for the runtime
 *                       monitor (never blocks by itself)
 *
 * Tool patterns are case-insensitive RegExps over tool names, exactly
 * like PolicyRule.toolPattern, so specs cover the file / browser / app /
 * send-pay action classes by pattern.
 */

/** Temporal ordering constraint between two tool patterns within a plan. */
export interface OrderingPlanSpec {
  type: 'ordering';
  id: string;
  before: string;
  after: string;
  relation: 'must-precede' | 'must-not-precede';
  reason?: string;
}

/** A step is valid only if an earlier plan step called a required tool. */
export interface RequiresHistoryPlanSpec {
  type: 'requires-history';
  id: string;
  toolPattern: string;
  requires: {
    toolPattern: string;
    arg?: string;
    argPattern?: string;
    minCount?: number;
  };
  reason?: string;
}

/** An argument of a step must be value-derived from an earlier step's output. */
export interface ProvenancePlanSpec {
  type: 'provenance';
  id: string;
  toolPattern: string;
  arg: string;
  sourceToolPattern: string;
  sourceArg?: string;
  reason?: string;
}

/** Declared expected effect class of a step — recorded for the runtime monitor. */
export interface PostconditionPlanSpec {
  type: 'postcondition';
  id: string;
  toolPattern: string;
  effectClass: string;
  reason?: string;
}

/** One plan-level policy spec (discriminated on `type`). */
export type PlanSpec =
  | OrderingPlanSpec
  | RequiresHistoryPlanSpec
  | ProvenancePlanSpec
  | PostconditionPlanSpec;

/** The `planSpecs` block of a policy: an ordered list of plan specs. */
export type PlanSpecs = PlanSpec[];

/**
 * Verification scope (kill-criterion narrowing, Workstream 1 (d)):
 * 'all' verifies every step; 'high-risk-only' restricts symbolic
 * verification to high-risk tool classes — file deletes, payments and
 * sends; 'off' disables plan verification entirely (the documented
 * opt-out). The 2026-11-18 harness outcome (0% false blocks, but +58%
 * relative latency on micro-fixture tasks at ~0.03 ms/plan absolute)
 * triggered the latency arm, so 'high-risk-only' is the DEFAULT scope
 * in the runtime wiring; 'all' remains one flag away. Since 2026-11-25
 * (Ashutosh decision) verification itself is ON by default at that
 * scope for every bot in plan-approval mode — 'off' (here, or
 * `verifiedPlans: false` on the bot) is how a user turns it back off.
 */
export type PlanVerificationScope = 'all' | 'high-risk-only' | 'off';

const HIGH_RISK_TOOL_RE =
  /delete|remove|drop|erase|wipe|purge|purchase|payment|pay_|_pay|checkout|send|message_|email|post_message|publish/i;

/** True when a tool name belongs to a high-risk class (delete / pay / send). */
export function isHighRiskTool(toolName: string): boolean {
  return HIGH_RISK_TOOL_RE.test(toolName);
}
