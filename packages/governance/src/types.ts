// SPDX-License-Identifier: Apache-2.0

/** Broad category of what a tool does. Used for policy matching. */
export type ActionClass = 'read' | 'write' | 'execute' | 'network';

/** What the gateway decides for a proposed tool call. */
export type Effect = 'allow' | 'require-approval' | 'deny';

/** A single policy rule. `toolPattern` is compiled as a case-insensitive RegExp
 *  and matched against the tool name. The first matching rule wins. */
export interface PolicyRule {
  id: string;
  toolPattern: string;
  actionClass?: ActionClass;
  effect: Effect;
  reason?: string;
}

/** A deny-by-default policy: `defaultEffect` applies when no rule matches. */
export interface Policy {
  defaultEffect: Effect;
  rules: PolicyRule[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRecord {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  actor: string;
  toolName: string;
  /** Redacted args snapshot — secrets are replaced with '[REDACTED]'. */
  args: Record<string, unknown>;
  status: ApprovalStatus;
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
  /**
   * W12 never-expire cards: epoch ms at which a pending approval would
   * expire on a decision wait, or null when the approval never expires.
   * Absent on pre-W12 records (the gateway's approval timeout applies).
   */
  expiresAt?: number | null;
  /** W12: true when this approval was created with neverExpire. */
  neverExpire?: boolean;
  /** Where the approval came from (hard floor, reviewer escalation, etc.). */
  provenance?: string;
  /**
   * Guarded external messages: true when this approval was raised from a
   * relayed external message. Such approvals can NEVER be approved —
   * decide() throws on 'approved' (fail-closed).
   */
  relayed?: boolean;
  /**
   * Multiplayer layer (W7): the person this approval is addressed to —
   * the owner of the bot that raised it (see PeopleStore in
   * @mvp/agent-runtime). Absent on pre-W7 records and for bots with no
   * owner recorded; consumers fall back to the bot's current owner.
   */
  addresseePersonId?: string;
}

/** Append-only audit entry. `detail` must NEVER contain secrets. */
export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  sessionId?: string;
  action: string;
  toolName?: string;
  decision?: string;
  detail?: string;
}

/** Context of the agent run requesting a tool call. */
export interface EvalContext {
  sessionId: string;
  botId: string;
  actor: string;
  /**
   * Guarded external messages: true when the turn was triggered by a
   * relayed external message (webhook / external origin). Approvals minted
   * with relayed=true can never be approved (fail-closed in decide()).
   */
  relayed?: boolean;
  /**
   * Multiplayer layer (W7): person the resulting approval is addressed
   * to (the bot's owner). Copied onto the ApprovalRecord.
   */
  addresseePersonId?: string;
  /**
   * W12: when true, approvals minted from this evaluation never expire
   * (ApprovalRecord.expiresAt = null; awaitDecision never marks them
   * expired). Copied onto the ApprovalRecord.
   */
  neverExpire?: boolean;
}

/** Result of evaluating a proposed tool call against the policy. */
export interface EvaluateResult {
  effect: Effect;
  approvalId?: string;
}

/**
 * Result of a policy simulation (dry-run evaluation): the decision the
 * gateway WOULD make, with no approvals minted and no audit entries
 * written. `simulated` is always true so consumers can distinguish it
 * from a live EvaluateResult at a glance.
 */
export interface SimulationResult {
  effect: Effect;
  actionClass: ActionClass;
  /** Id of the first matching policy rule, if any. */
  matchedRuleId?: string;
  reason: string;
  /** True when a live evaluation would mint a pending approval (none is created here). */
  wouldCreateApproval: boolean;
  /** Present when a hard floor forced the decision regardless of policy rules. */
  hardFloor?: { tier: 'catastrophic' | 'destructive'; reason: string; patternId: string };
  /** True when the run_command hard denylist fired. */
  denylist?: boolean;
  simulated: true;
}
