// SPDX-License-Identifier: Apache-2.0
//
// Per-bot policy merging.
//
// A bot's own rules are PREPENDED to the global policy's rules before
// evaluation. Policy matching is first-match-wins (see
// GovernanceGateway.evaluate and default-policy.ts), so a bot rule can
// tighten the global floor (e.g. deny a tool the global policy would
// allow) or loosen it (e.g. allow a tool the global policy gates behind
// approval) — for that bot only. A bot with no policy evaluates against
// the global policy unchanged.
//
// NOTE: this package cannot import BotConfig from @mvp/agent-runtime (that
// package depends on THIS one), so the bot-policy shapes are declared here
// structurally. They must stay field-compatible with agent-runtime's
// BotPolicyRule/BotPolicy in packages/agent-runtime/src/types.ts.

import type { Policy, PolicyRule } from './types.js';
import type { PlanSpec } from './plan-specs.js';

/** Per-bot governance rule — field-compatible with agent-runtime's BotPolicyRule. */
export interface BotPolicyRule {
  id: string;
  toolPattern: string;
  effect: 'allow' | 'deny' | 'require-approval';
  reason?: string;
  /** Guardrails as code: argument-value condition (see PolicyRule.argPattern). */
  argPattern?: { arg: string; pattern: string };
  /** Guardrails as code: session-history condition (see PolicyRule.requiresHistory). */
  requiresHistory?: { toolPattern: string; minCount?: number; argDigest?: string; argPattern?: string };
  /** Domain-bound capability (#122): egress allowlist (see PolicyRule.domains). */
  domains?: string[];
}

/** Per-bot governance policy — field-compatible with agent-runtime's BotPolicy. */
export interface BotPolicy {
  rules: BotPolicyRule[];
  /**
   * Opt-in policy snapshot mode (#70): when true, the host captures an
   * immutable snapshot of the effective merged policy at session start
   * and evaluates the whole session against it (see
   * policy-snapshot.ts). Absent/false (DEFAULT) = live evaluation.
   * NOTE: agent-runtime's BotPolicy needs the same optional field for
   * the flag to flow from bot config — see the closure report.
   */
  policySnapshot?: boolean;
  /**
   * Opt-in sandbox-auto-allow (CA-3): field-compatible with
   * agent-runtime's BotPolicy.sandboxAutoAllow. The API governance
   * adapter reads it (via the bot config) and gates it on live
   * sandbox confinement; mergeBotPolicy does not need to carry it
   * because the adapter consults the bot config directly.
   */
  sandboxAutoAllow?: boolean;
  /**
   * Plan-level policy specs (Soteria Verified Plans, Workstream 1) —
   * field-compatible with agent-runtime's BotPolicy.planSpecs. Merged
   * by mergeBotPolicy ahead of the global policy's specs, mirroring
   * rule layering (most specific scope first).
   */
  planSpecs?: PlanSpec[];
  /**
   * Verification scope for plan specs (kill-criterion narrowing): when
   * 'high-risk-only', the plan verifier checks only high-risk tool
   * classes (file deletes, payments, sends). Absent = the runtime
   * default, which the 2026-11-18 harness outcome set to
   * 'high-risk-only' (see benchmarks/agent-safety/RESULTS.md).
   * Field-compatible with agent-runtime's BotPolicy.planVerificationScope.
   */
  planVerificationScope?: 'all' | 'high-risk-only';
}

/**
 * Merge a bot's policy with the global policy: bot rules first (they win
 * on match), then the global rules, keeping the global defaultEffect for
 * tools nothing matches. Pure function — neither input is mutated.
 */
export function mergeBotPolicy(globalPolicy: Policy, botPolicy?: BotPolicy): Policy {
  const botRules: PolicyRule[] = (botPolicy?.rules ?? []).map((r) => ({
    id: r.id,
    toolPattern: r.toolPattern,
    effect: r.effect,
    reason: r.reason,
    argPattern: r.argPattern,
    requiresHistory: r.requiresHistory,
    domains: r.domains,
  }));
  const planSpecs = [...(botPolicy?.planSpecs ?? []), ...(globalPolicy.planSpecs ?? [])];
  return {
    defaultEffect: globalPolicy.defaultEffect,
    rules: [...botRules, ...globalPolicy.rules],
    ...(planSpecs.length > 0 ? { planSpecs } : {}),
  };
}
