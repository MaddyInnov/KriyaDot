// SPDX-License-Identifier: Apache-2.0
// Spend-cap gate wiring (OpenMausBot parity P1 #21): per-turn gate
// closures, in-flight reservations, fail-closed ledger errors, and the
// runtime default-factory attachment. Zero paid API usage.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker, SpendCapStore } from '@mvp/billing';
import { attachSpendCapGate, makeSpendCapGate } from '../src/spend-caps.js';

describe('makeSpendCapGate', () => {
  let dir: string;
  let costTracker: CostTracker;
  let spendCapStore: SpendCapStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-spendgate-'));
    costTracker = new CostTracker(join(dir, 'billing.db'));
    spendCapStore = new SpendCapStore(join(dir, 'billing.db'));
  });

  afterEach(() => {
    costTracker.close();
    spendCapStore.close();
  });

  it('allows calls when no caps are set', async () => {
    const gate = makeSpendCapGate('scout', costTracker, spendCapStore);
    expect(await gate(100)).toEqual({ allowed: true });
  });

  it('blocks when spend + estimate would exceed a cap', async () => {
    spendCapStore.setCap('global', undefined, 'day', 500);
    costTracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 480, botId: 'scout' });
    const gate = makeSpendCapGate('scout', costTracker, spendCapStore);
    const verdict = await gate(30);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.message).toContain('Spend cap reached');
  });

  it('counts in-flight reservations toward the cap within a turn', async () => {
    spendCapStore.setCap('global', undefined, 'day', 100);
    const gate = makeSpendCapGate('scout', costTracker, spendCapStore);
    expect(await gate(60)).toEqual({ allowed: true }); // reserves 60
    expect(await gate(30)).toEqual({ allowed: true }); // reserves 90 total
    const third = await gate(20); // 90 + 20 > 100 → blocked
    expect(third.allowed).toBe(false);
  });

  it('fails closed when the ledger read throws', async () => {
    // A cap must be set, otherwise the ledger is never consulted.
    spendCapStore.setCap('global', undefined, 'day', 1000);
    const broken = { spentCents: () => { throw new Error('db gone'); } } as unknown as CostTracker;
    const gate = makeSpendCapGate('scout', broken, spendCapStore);
    const verdict = await gate(1);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.message).toContain('fail-closed');
  });

  it('each gate has its own reservation counter (no cross-turn leakage)', async () => {
    spendCapStore.setCap('global', undefined, 'day', 100);
    const g1 = makeSpendCapGate('scout', costTracker, spendCapStore);
    const g2 = makeSpendCapGate('scout', costTracker, spendCapStore);
    expect(await g1(90)).toEqual({ allowed: true });
    expect(await g2(90)).toEqual({ allowed: true }); // g2 unaffected by g1
  });
});

describe('attachSpendCapGate', () => {
  it('registers a default factory on the runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-spendgate-attach-'));
    const costTracker = new CostTracker(join(dir, 'billing.db'));
    const calls: string[] = [];
    const runtime = {
      setDefaultSpendCapGateFactory: (f: (botId: string) => unknown) => {
        calls.push('set');
        // The factory must produce a working gate.
        void f('bot-1');
      },
    } as unknown as import('@mvp/agent-runtime').AgentRuntime;
    const store = attachSpendCapGate(runtime, { dataDir: dir, costTracker });
    expect(calls).toEqual(['set']);
    expect(store).toBeInstanceOf(SpendCapStore);
    costTracker.close();
    store.close();
  });
});
