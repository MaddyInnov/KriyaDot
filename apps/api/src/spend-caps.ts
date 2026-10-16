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
} from '@mvp/billing';
import type { CostTracker } from '@mvp/billing';

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
    reservedCents += est;
    return { allowed: true };
  };
}

/**
 * Attach the default spend-cap gate factory to the runtime. Returns the
 * shared SpendCapStore (the billing routes need it for the config API).
 * Idempotent for the store (one table), last-write-wins for the factory.
 */
export function attachSpendCapGate(agentRuntime: AgentRuntime, deps: SpendCapWiringDeps): SpendCapStore {
  const store = makeSpendCapStore(deps.dataDir);
  agentRuntime.setDefaultSpendCapGateFactory((botId) =>
    makeSpendCapGate(botId, deps.costTracker, store),
  );
  return store;
}
