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
  return {
    defaultEffect: globalPolicy.defaultEffect,
    rules: [...botRules, ...globalPolicy.rules],
  };
}
