// SPDX-License-Identifier: Apache-2.0
// Spend-cap gate wiring (OpenMausBot parity P1 #21).
//
// Builds per-turn SpendCapGate closures from the SpendCapStore (global +
// per-bot daily/monthly caps) and the CostTracker ledger (the append-only
// record of every metered event), then attaches them to the AgentRuntime
// as the default gate factory — so chat, group rooms, routines, and
// fusion workers are all hard-stopped BEFORE a provider call that would
// exceed a cap.
//
// Each turn gets a fresh gate with its own in-flight reservation counter:
// estimated costs of calls already approved this turn count toward the
// cap, so a burst of calls inside one turn cannot overshoot it. The
// reservation is conservative (an over-estimate); the ledger records
// actuals after the turn.

import { join } from 'node:path';
import type { AgentRuntime, SpendCapGate } from '@mvp/agent-runtime';
import {
  checkSpendCaps,
  formatSpendCapMessage,
  SpendCapStore,
  THRESHOLD_RESUMABLE_MARKER,
  ThresholdGate,
} from '@mvp/billing';
import type { CostTracker, ThresholdPendingDecision } from '@mvp/billing';

export interface SpendCapWiringDeps {
  dataDir: string;
  costTracker: CostTracker;
}

export function makeSpendCapStore(dataDir: string): SpendCapStore {
  return new SpendCapStore(join(dataDir, 'billing.db'));
}

/**
 * One gate per turn. `reservedCents` accumulates this turn's approved
 * call estimates so the check sees in-flight spend the ledger hasn't
 * recorded yet (the ledger is written per turn, after it ends).
 */
export function makeSpendCapGate(
  botId: string,
  costTracker: CostTracker,
  spendCapStore: SpendCapStore,
  opts: { thresholdGate?: ThresholdGate } = {},
): SpendCapGate {
  let reservedCents = 0;
  return async (estimatedCallCostCents: number) => {
    const est = Math.max(0, Math.floor(estimatedCallCostCents));
    let result;
    try {
      result = checkSpendCaps({
        caps: spendCapStore.getConfig(),
        botId,
        estimatedAdditionalCents: reservedCents + est,
        spentLookup: (since, until, b) => costTracker.spentCents({ since, until, botId: b }),
      });
    } catch (err) {
      // Ledger/cap read failure → fail closed, never fail open.
      return {
        allowed: false,
        message: `Spend-cap check failed (${err instanceof Error ? err.message : String(err)}); blocking the call fail-closed.`,
      };
    }
    if (!result.allowed) {
      return { allowed: false, message: formatSpendCapMessage(result) };
    }
    // Incremental threshold gate (#72, opt-in): every threshold
    // multiple of cumulative spend must be approved before spend may
    // cross it. The gate seam cannot ask synchronously, so a crossing
    // stops the call with the resumable (exit-75) contract: the
    // pending decision is approved out of band via
    // POST /api/billing/threshold-decisions/:id/approve and the user
    // resumes the session. Approvals persist on the per-bot gate, so
    // an approved multiple never re-asks.
    if (opts.thresholdGate) {
      try {
        const spentAllTime = costTracker.spentCents({ since: 0, until: Date.now(), botId });
        const decision = opts.thresholdGate.check({
          spentCents: spentAllTime + reservedCents,
          projectedAdditionalCents: est,
          interactive: false,
        });
        if (decision.kind !== 'allow') {
          return {
            allowed: false,
            message:
              `${decision.reason} [${THRESHOLD_RESUMABLE_MARKER}] ` +
              `Pending decision ${decision.pendingId ?? ''} — approve it via POST /api/billing/threshold-decisions/${decision.pendingId ?? ''}/approve, then resume the session.`,
          };
        }
      } catch (err) {
        return {
          allowed: false,
          message: `Spend-threshold check failed (${err instanceof Error ? err.message : String(err)}); blocking the call fail-closed.`,
        };
      }
    }
    reservedCents += est;
    return { allowed: true };
  };
}

// ---------------------------------------------------------------------------
// Threshold-gate registry (#72): one long-lived gate per bot, created by
// attachSpendCapGate when the opt-in interval is configured. The billing
// routes list/approve/deny pendings through these accessors.
// ---------------------------------------------------------------------------

const thresholdGatesByBot = new Map<string, ThresholdGate>();

/** The threshold interval (cents) from the environment; 0 = disabled. */
export function spendThresholdCentsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KRIYADOT_SPEND_THRESHOLD_CENTS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function thresholdGateForBot(botId: string): ThresholdGate | undefined {
  return thresholdGatesByBot.get(botId);
}

/** All recorded threshold decisions across bots (oldest first per bot). */
export function listThresholdDecisions(): Array<{ botId: string; decision: ThresholdPendingDecision }> {
  const out: Array<{ botId: string; decision: ThresholdPendingDecision }> = [];
  for (const [botId, gate] of thresholdGatesByBot) {
    for (const decision of gate.listPending()) out.push({ botId, decision });
  }
  return out.sort((a, b) => a.decision.createdAt - b.decision.createdAt);
}

/** Approve a pending threshold decision by id (any bot). False when unknown. */
export function approveThresholdDecision(id: string): boolean {
  for (const gate of thresholdGatesByBot.values()) {
    if (gate.getPending(id)) {
      gate.approve(id);
      return true;
    }
  }
  return false;
}

/** Deny a pending threshold decision by id (any bot). False when unknown. */
export function denyThresholdDecision(id: string): boolean {
  for (const gate of thresholdGatesByBot.values()) {
    if (gate.getPending(id)) {
      gate.deny(id);
      return true;
    }
  }
  return false;
}

/**
 * Attach the default spend-cap gate factory to the runtime. Returns the
 * shared SpendCapStore (the billing routes need it for the config API).
 * Idempotent for the store (one table), last-write-wins for the factory.
 */
export function attachSpendCapGate(agentRuntime: AgentRuntime, deps: SpendCapWiringDeps): SpendCapStore {
  const store = makeSpendCapStore(deps.dataDir);
  // Opt-in incremental thresholds (#72): KRIYADOT_SPEND_THRESHOLD_CENTS
  // unset/0 = disabled (default behaviour unchanged — hard caps only).
  const thresholdCents = spendThresholdCentsFromEnv();
  agentRuntime.setDefaultSpendCapGateFactory((botId) => {
    let thresholdGate: ThresholdGate | undefined;
    if (thresholdCents > 0) {
      thresholdGate = thresholdGatesByBot.get(botId);
      if (!thresholdGate) {
        thresholdGate = new ThresholdGate({ thresholdCents });
        thresholdGatesByBot.set(botId, thresholdGate);
      }
    }
    return makeSpendCapGate(botId, deps.costTracker, store, { thresholdGate });
  });
  return store;
}
