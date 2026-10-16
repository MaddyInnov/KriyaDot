// SPDX-License-Identifier: Apache-2.0

/**
 * GovernanceGateway surface.
 *
 * NOTE: @mvp/governance is being built in parallel by a teammate. Its runtime
 * code is deliberately NOT imported here so this package's tests stay green
 * without it. This interface documents the exact surface agent-runtime needs;
 * once the teammate's package ships TypeScript typings, this file can be
 * replaced with:
 *
 *   import type { GovernanceGateway } from '@mvp/governance';
 *
 * and re-exported. Any implementation satisfying this interface can be passed
 * to the AgentRuntime constructor.
 */
import type { ToolCall, ToolContext } from './types.js';

export type GovernanceDecision = 'allow' | 'deny' | 'require-approval';

export interface GovernanceEvaluation {
  decision: GovernanceDecision;
  reason?: string;
  /**
   * Optional approval id minted by the gateway. When present, the runtime
   * MUST use it (instead of minting its own) so the id the UI sees is
   * already mapped to the gateway's real approval record — no id
   * translation race.
   */
  approvalId?: string;
}

/** Where an approval decision came from. Surfaced in the inbox UI. */
export type ApprovalProvenance =
  | 'human'
  | 'auto-approve'
  | 'reviewer'
  | 'standing-rule'
  | 'learned'
  | 'bypass'
  | 'hard-floor-escalated';

export interface AuditEntry {
  type: string;
  sessionId: string;
  botId: string;
  call?: ToolCall;
  detail?: unknown;
  ts: string;
  /** Where the decision came from (for tool approval decisions). */
  provenance?: ApprovalProvenance;
}

export interface GovernanceGateway {
  /** Static policy check for a proposed tool call. */
  classify(call: ToolCall, ctx: ToolContext): Promise<GovernanceDecision> | GovernanceDecision;
  /** Dynamic evaluation (history/context aware). Its decision wins over classify. */
  evaluate(call: ToolCall, ctx: ToolContext): Promise<GovernanceEvaluation>;
  /** Wait for an external approval decision (e.g. from the approval inbox UI). */
  awaitDecision(approvalId: string, opts?: { timeoutMs?: number }): Promise<'approved' | 'denied'>;
  /** Record an external approval decision (called by the approval UI / API). */
  decide(approvalId: string, decision: 'approved' | 'denied', opts?: { decidedBy?: string; note?: string }): void;
  /** Append an audit event. Must never carry PII. */
  audit(entry: AuditEntry): void | Promise<void>;
  /** Governance hooks run around every tool execution. */
  runPreHooks(call: ToolCall, ctx: ToolContext): Promise<void>;
  runPostHooks(call: ToolCall, result: unknown, ctx: ToolContext): Promise<void>;
}
