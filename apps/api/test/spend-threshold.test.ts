// SPDX-License-Identifier: Apache-2.0
// Incremental spend thresholds (#72) at the API spend gate: opt-in via
// KRIYADOT_SPEND_THRESHOLD_CENTS; crossing a threshold multiple stops
// the call with resumable (exit-75) semantics + a pending decision;
// approving out of band lets spend continue to the next multiple.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CostTracker, SpendCapStore, ThresholdGate } from '@mvp/billing';
import {
  approveThresholdDecision,
  listThresholdDecisions,
  makeSpendCapGate,
  spendThresholdCentsFromEnv,
} from '../src/spend-caps.js';

function rig(thresholdCents?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'thr-'));
  const db = join(dir, 'billing.db');
  const costTracker = new CostTracker(db);
  const store = new SpendCapStore(db);
  const gate = thresholdCents ? new ThresholdGate({ thresholdCents }) : undefined;
  return { costTracker, store, gate };
}

describe('threshold gate at the spend-cap gate (#72)', () => {
  it('allows spend below the threshold and stops at the crossing with a pending decision', async () => {
    const { costTracker, store, gate } = rig(1000);
    const spend = makeSpendCapGate('bot-t', costTracker, store, { thresholdGate: gate });
    // Ledger already holds 900c for the bot; a 50c call stays under 1000c.
    costTracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 900, botId: 'bot-t' });
    const ok = await spend(50);
    expect(ok.allowed).toBe(true);
    // A 200c call crosses 1000c → stop with the resumable marker + pending id.
    const stopped = await spend(200);
    expect(stopped.allowed).toBe(false);
    expect(stopped.message).toContain('exit-75-resumable');
    const pendings = gate!.listPending();
    expect(pendings).toHaveLength(1);
    expect(stopped.message).toContain(pendings[0]!.id);
    // Approving the pending decision lets the same call through.
    gate!.approve(pendings[0]!.id);
    const after = await spend(200);
    expect(after.allowed).toBe(true);
  });

  it('without a threshold gate the behaviour is the plain hard-cap gate', async () => {
    const { costTracker, store } = rig();
    const spend = makeSpendCapGate('bot-t', costTracker, store);
    const res = await spend(5000);
    expect(res.allowed).toBe(true);
  });

  it('env parsing: unset/invalid → disabled', () => {
    expect(spendThresholdCentsFromEnv({})).toBe(0);
    expect(spendThresholdCentsFromEnv({ KRIYADOT_SPEND_THRESHOLD_CENTS: 'abc' })).toBe(0);
    expect(spendThresholdCentsFromEnv({ KRIYADOT_SPEND_THRESHOLD_CENTS: '-5' })).toBe(0);
    expect(spendThresholdCentsFromEnv({ KRIYADOT_SPEND_THRESHOLD_CENTS: '2500' })).toBe(2500);
  });

  it('registry accessors report no decisions before any gate exists', () => {
    expect(Array.isArray(listThresholdDecisions())).toBe(true);
    expect(approveThresholdDecision('thr_nonexistent')).toBe(false);
  });
});
