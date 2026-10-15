// SPDX-License-Identifier: Apache-2.0
// Bridges the real @mvp/governance GovernanceGateway (policy engine over
// tool names) to the GovernanceGateway SURFACE that @mvp/agent-runtime's
// AgentRuntime expects (see agent-runtime/src/governance.ts — a deliberate
// local interface so that package builds without the teammate's code).
//
// Approval-id mapping: the real gateway mints its own approval id inside
// evaluate(). The adapter mints a runtime-facing id at the same moment,
// maps it 1:1, and returns it on the evaluation — the runtime then uses
// that id on its `approval_required` events and in awaitDecision(), so the
// id the UI approves/denies is already mapped. No ordering assumptions,
// no translation race.

import { randomUUID } from 'node:crypto';
import type {
  AuditEntry as RuntimeAuditEntry,
  BotConfig,
  GovernanceDecision,
  GovernanceEvaluation,
  GovernanceGateway as RuntimeGovernanceGateway,
  ToolCall,
  ToolContext,
} from '@mvp/agent-runtime';
import { DEFAULT_POLICY, GovernanceGateway as RealGovernanceGateway } from '@mvp/governance';
import type { Policy, SimulationResult } from '@mvp/governance';
import { checkHardFloor } from '@mvp/governance';
// bot-policy.ts is a new module not re-exported from the governance index
// (index untouched); import the built subpath directly.
import { mergeBotPolicy } from '@mvp/governance/dist/bot-policy.js';

function toEvalContext(ctx: ToolContext): { sessionId: string; botId: string; actor: string } {
  return { sessionId: ctx.sessionId, botId: ctx.botId, actor: ctx.botId };
}

export interface GovernanceAdapterOptions {
  /**
   * Optional bot lookup: ctx.botId → BotConfig. When a bot carries
   * `policy.rules`, evaluation runs against the merged policy (bot rules
   * prepended, first match wins). Default: undefined → global policy only
   * (unchanged behaviour).
   *
   * HOST WIRING: pass `{ getBotConfig: (id) => botsById.get(id) }` from
   * index.ts (alongside `globalPolicy: DEFAULT_POLICY`, matching the policy
   * the real gateway was constructed with).
   */
  getBotConfig?: (botId: string) => BotConfig | undefined;
  /**
   * The global policy the real gateway was constructed with, used as the
   * merge base for per-bot policies. Defaults to DEFAULT_POLICY.
   */
  globalPolicy?: Policy;
  /**
   * Learned preference lookup (preference learning loop). When a tool has
   * a learned 'deny' preference, evaluation returns 'deny' immediately.
   * When 'allow', it returns 'allow'. Checked before the policy.
   */
  getPreference?: (botId: string, toolName: string) => 'deny' | 'allow' | undefined;
}

export class GovernanceAdapter implements RuntimeGovernanceGateway {
  private readonly real: RealGovernanceGateway;
  private readonly getBotConfig?: (botId: string) => BotConfig | undefined;
  private readonly globalPolicy: Policy;
  private readonly getPreference?: (botId: string, toolName: string) => 'deny' | 'allow' | undefined;
  /** Runtime-facing approval id → real gateway approval id. */
  private readonly idMap = new Map<string, string>();

  constructor(real: RealGovernanceGateway, opts: GovernanceAdapterOptions = {}) {
    this.real = real;
    this.getBotConfig = opts.getBotConfig;
    this.globalPolicy = opts.globalPolicy ?? DEFAULT_POLICY;
    this.getPreference = opts.getPreference;
  }

  /** Translate a runtime-issued approval id to the real gateway id. */
  resolveApprovalId(runtimeOrRealId: string): string {
    return this.idMap.get(runtimeOrRealId) ?? runtimeOrRealId;
  }

  /**
   * Mint a standalone approval for a team peer-delegation (bot→bot) through
   * the real gateway, so it shows up in the approvals inbox/cards like any
   * other approval. Returns the runtime-facing approval id; await it with
   * awaitDecision() and let the user decide via the normal
   * POST /api/approvals/:id endpoint. Used by the AgentTeams delegation
   * gate (teams-routes.ts, workstream C).
   */
  async requestPeerDelegationApproval(args: {
    sessionId: string;
    botId: string;
    fromBotId: string;
    toBotId: string;
    task: string;
    policy: string;
  }): Promise<string> {
    const realId = this.real.requestApproval(
      'delegate',
      {
        bot: args.toBotId,
        task: args.task.slice(0, 500),
        teamDelegation: true,
        fromBot: args.fromBotId,
        policy: args.policy,
      },
      { sessionId: args.sessionId, botId: args.botId, actor: args.fromBotId },
      { provenance: 'team-peer-delegation' },
    );
    const runtimeId = randomUUID();
    this.idMap.set(runtimeId, realId);
    // Bound the map: approvals are single-use.
    if (this.idMap.size > 1000) {
      const first = this.idMap.keys().next();
      if (!first.done) this.idMap.delete(first.value);
    }
    return runtimeId;
  }

  classify(call: ToolCall, _ctx: ToolContext): GovernanceDecision {
    // Side-effect-free static check. Only a fallback in the runtime
    // (`evaluated.decision ?? classified`); the true policy decision comes
    // from evaluate(). Reads auto-allow; everything else needs a human.
    return this.real.classify(call.name) === 'read' ? 'allow' : 'require-approval';
  }

  async evaluate(call: ToolCall, ctx: ToolContext): Promise<GovernanceEvaluation> {
    // Hard floors FIRST — before learned preferences, policy, always-allow.
    // No mode can bypass these.
    const floorHit = checkHardFloor(call.name, call.args);
    if (floorHit) {
      // Delegate to the real gateway so the approval is minted + audited
      // with hard-floor-escalated provenance (gateway checks floors first).
      const res = await this.real.evaluate(call.name, call.args, toEvalContext(ctx));
      if (res.effect === 'require-approval' && res.approvalId) {
        const runtimeId = randomUUID();
        this.idMap.set(runtimeId, res.approvalId);
        if (this.idMap.size > 1000) {
          const first = this.idMap.keys().next();
          if (!first.done) this.idMap.delete(first.value);
        }
        return { decision: 'require-approval', approvalId: runtimeId, reason: floorHit.reason };
      }
      return { decision: res.effect, reason: floorHit.reason };
    }
    // Learned preferences (preference learning loop): check before policy.
    // If the user consistently denied this tool, deny immediately.
    // If consistently approved, allow immediately.
    if (this.getPreference) {
      const pref = this.getPreference(ctx.botId, call.name);
      if (pref === 'deny') {
        return { decision: 'deny', reason: 'Learned preference: you have denied this tool multiple times.' };
      }
      if (pref === 'allow') {
        return { decision: 'allow', reason: 'Learned preference: you have approved this tool multiple times.' };
      }
    }
    // Per-bot policy: merge the calling bot's rules ahead of the global
    // policy (first match wins). No bot policy → global policy only.
    const botPolicy = this.getBotConfig?.(ctx.botId)?.policy;
    const res =
      botPolicy && botPolicy.rules.length > 0
        ? await this.real.evaluateWithPolicy(
            call.name,
            call.args,
            toEvalContext(ctx),
            mergeBotPolicy(this.globalPolicy, botPolicy),
          )
        : await this.real.evaluate(call.name, call.args, toEvalContext(ctx));
    if (res.effect === 'require-approval' && res.approvalId) {
      const runtimeId = randomUUID();
      this.idMap.set(runtimeId, res.approvalId);
      // Bound the map: approvals are single-use.
      if (this.idMap.size > 1000) {
        const first = this.idMap.keys().next();
        if (!first.done) this.idMap.delete(first.value);
      }
      return { decision: res.effect, approvalId: runtimeId };
    }
    return { decision: res.effect };
  }

  async awaitDecision(
    approvalId: string,
    opts?: { timeoutMs?: number },
  ): Promise<'approved' | 'denied'> {
    const realId = this.idMap.get(approvalId);
    if (!realId) {
      throw new Error(`no governance approval mapped for "${approvalId}"`);
    }
    return this.real.awaitDecision(realId, opts?.timeoutMs);
  }

  decide(approvalId: string, decision: 'approved' | 'denied'): void {
    this.real.decide(this.resolveApprovalId(approvalId), decision);
  }

  /**
   * Side-effect-free policy simulation for a proposed tool call: the
   * decision the gateway WOULD make (effect, matched rule, hard-floor /
   * denylist hits, whether a live call would mint an approval) WITHOUT
   * creating approvals or writing audit entries. Merges the bot's policy
   * rules ahead of the global policy exactly like evaluate() does.
   */
  async simulatePolicy(
    botId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<SimulationResult> {
    const botPolicy = this.getBotConfig?.(botId)?.policy;
    const policy =
      botPolicy && botPolicy.rules.length > 0
        ? mergeBotPolicy(this.globalPolicy, botPolicy)
        : this.globalPolicy;
    return this.real.simulate(toolName, args, policy);
  }

  audit(entry: RuntimeAuditEntry): void {
    // The real gateway redacts secrets and JSON-stringifies detail itself.
    this.real.audit(entry.type, {
      actor: entry.botId,
      sessionId: entry.sessionId,
      toolName: entry.call?.name,
      detail: entry.detail,
    });
  }

  async runPreHooks(call: ToolCall, ctx: ToolContext): Promise<void> {
    await this.real.runPreHooks(call.name, call.args, toEvalContext(ctx));
  }

  async runPostHooks(call: ToolCall, result: unknown, ctx: ToolContext): Promise<void> {
    await this.real.runPostHooks(call.name, call.args, result, toEvalContext(ctx));
  }
}
