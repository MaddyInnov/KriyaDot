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
  /**
   * Guardrails as code (Octomind parity): argument matching — the rule
   * only matches when the named argument's value matches `pattern`
   * (case-sensitive RegExp against the string value, or JSON for
   * non-strings). A missing argument or an invalid pattern never
   * matches (fail-closed).
   */
  argPattern?: { arg: string; pattern: string };
  /**
   * Guardrails as code (Octomind parity): session-history condition —
   * the rule only matches when at least `minCount` (default 1) tools
   * matching `toolPattern` (case-insensitive RegExp) have already run
   * in this session. Needs EvalContext.sessionToolHistory; without it
   * the rule never matches (fail-closed).
   *
   * Argument-qualified conditions (#66): `argDigest` requires the
   * recorded history entries to carry exactly that argument digest
   * (see `computeArgDigest` in history.ts), and `argPattern` is a
   * case-sensitive RegExp matched against the entries' `argSummary`.
   * Entries that carry no digest/summary (legacy name-only string
   * entries) NEVER satisfy an argument-qualified condition
   * (fail-closed), but keep satisfying name-only conditions.
   */
  requiresHistory?: {
    toolPattern: string;
    minCount?: number;
    /** Exact argument digest a history entry must carry. */
    argDigest?: string;
    /** RegExp matched against a history entry's `argSummary`. */
    argPattern?: string;
  };
  /**
   * Domain-bound capability (#122): when present, this rule is an
   * egress allowlist. The gateway extracts the target host from the
   * tool arguments (see `extractTargetHost` in domains.ts); a call
   * whose host is outside `domains` — or whose host cannot be
   * determined — is DENIED outright (it does not fall through to a
   * later, more permissive rule). A call whose host is inside the set
   * matches the rule normally (its `effect` applies).
   */
  domains?: string[];
}

/**
 * One recorded session-history entry (#66).
 *
 * Legacy entries are plain tool-name strings. Rich entries carry the
 * tool name plus an argument digest (`argDigest`, a SHA-256 hex string
 * over the canonical JSON of the call arguments — see history.ts) and
 * an optional human/matcher-readable `argSummary` (a compact,
 * secret-redaction-unaware string the runtime builds from the args,
 * e.g. "command=git status"). Governance never sees raw arguments in
 * history: the digest is the exact-match contract and the summary is
 * the pattern-match contract.
 */
export interface SessionHistoryEntry {
  name: string;
  argDigest?: string;
  argSummary?: string;
}

/** Session tool history: legacy name-only strings and/or rich entries. */
export type SessionToolHistory = Array<string | SessionHistoryEntry>;

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
  /**
   * Guardrails as code (Octomind parity): tools that have already
   * executed in this session (in order) — legacy name-only strings or
   * rich {@link SessionHistoryEntry} objects carrying an argument
   * digest/summary for argument-qualified `requiresHistory` conditions
   * (#66). Policy rules with `requiresHistory` conditions match against
   * this list. Supplied by the runtime's tool context; absent for
   * out-of-session evaluations (simulations), where history-conditioned
   * rules never match.
   */
  sessionToolHistory?: SessionToolHistory;
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
  /** #122: true when a domain-bound rule denied the call (host outside its allowlist or undeterminable). */
  domainDenied?: boolean;
  /** #122: the target host extracted from the tool arguments, when one was found. */
  targetHost?: string;
  simulated: true;
}
