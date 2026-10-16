// SPDX-License-Identifier: Apache-2.0
// Spend-cap enforcement in the agent runtime (OpenMausBot parity P1 #21):
// - the spendCapGate is consulted BEFORE every provider.chat call; a deny
//   blocks the call fail-closed (provider never touched), emits
//   'spend_cap_reached' + 'error', and audits the block
// - a throwing gate is treated as a deny (fail closed)
// - the per-turn maxBudgetUsd now also blocks pre-call when the projected
//   cost (accumulated + estimated next call) exceeds it
// Zero paid API usage — MockProvider only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import type { SpendCapGate, SpendCapGateVerdict } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-spendgate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeGateway implements GovernanceGateway {
  readonly audits: Array<{ action: string; detail: unknown }> = [];
  async classify(): Promise<GovernanceDecision> {
    return 'allow';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: 'allow' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  decide(): void {}
  audit(entry: { type: string; detail?: unknown }): void {
    this.audits.push({ action: entry.type, detail: entry.detail });
  }
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

function testBot(model = 'mock-model'): BotConfig {
  return {
    id: 'bot-test',
    name: 'Test Bot',
    description: 'A bot for tests',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model,
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

function makeRuntime(provider: MockProvider, gateway: FakeGateway, defaultProviderId = 'mock'): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: gateway,
    toolRegistry: new Map(),
    defaultProviderId,
  });
}

async function collectEvents(
  runtime: AgentRuntime,
  opts: { bot: BotConfig; gate?: SpendCapGate; maxBudgetUsd?: number },
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await runtime.runTurn({
    bot: opts.bot,
    message: 'hello',
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    spendCapGate: opts.gate,
    maxBudgetUsd: opts.maxBudgetUsd,
    onEvent: (e) => {
      events.push(e);
    },
  });
  return events;
}

describe('spendCapGate pre-call enforcement', () => {
  it('blocks the provider call when the gate denies, emitting spend_cap_reached + error', async () => {
    const provider = new MockProvider([{ content: 'should never run' }]);
    const gateway = new FakeGateway();
    const runtime = makeRuntime(provider, gateway);
    const gate: SpendCapGate = async (estCents) => {
      expect(estCents).toBeGreaterThanOrEqual(0);
      const verdict: SpendCapGateVerdict = {
        allowed: false,
        message: 'Spend cap reached: Global daily spend cap: $4.8000 spent of $5.0000 cap.',
      };
      return verdict;
    };
    const events = await collectEvents(runtime, { bot: testBot(), gate });
    expect(provider.calls).toHaveLength(0);
    const capEvent = events.find((e) => e.type === 'spend_cap_reached');
    expect(capEvent).toBeDefined();
    expect(capEvent).toMatchObject({ capKind: 'spend-cap' });
    expect((capEvent as { message: string }).message).toContain('Spend cap reached');
    const errEvent = events.find((e) => e.type === 'error');
    expect((errEvent as { message: string } | undefined)?.message).toContain('Spend cap reached');
    expect(gateway.audits.some((a) => a.action === 'turn.spend_cap')).toBe(true);
    expect(gateway.audits.some((a) => a.action === 'turn.failed')).toBe(true);
  });

  it('lets the call through when the gate allows', async () => {
    const provider = new MockProvider([{ content: 'hello world' }]);
    const gateway = new FakeGateway();
    const runtime = makeRuntime(provider, gateway);
    const seen: number[] = [];
    const events = await collectEvents(runtime, {
      bot: testBot(),
      gate: async (estCents) => {
        seen.push(estCents);
        return { allowed: true };
      },
    });
    expect(provider.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(events.some((e) => e.type === 'spend_cap_reached')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('treats a throwing gate as a deny (fail closed)', async () => {
    const provider = new MockProvider([{ content: 'should never run' }]);
    const gateway = new FakeGateway();
    const runtime = makeRuntime(provider, gateway);
    const events = await collectEvents(runtime, {
      bot: testBot(),
      gate: async () => {
        throw new Error('db exploded');
      },
    });
    expect(provider.calls).toHaveLength(0);
    const capEvent = events.find((e) => e.type === 'spend_cap_reached');
    expect((capEvent as { message: string } | undefined)?.message).toContain('fail-closed');
  });

  it('no gate → previous behavior (provider called)', async () => {
    const provider = new MockProvider([{ content: 'hi' }]);
    const gateway = new FakeGateway();
    const runtime = makeRuntime(provider, gateway);
    await collectEvents(runtime, { bot: testBot() });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('per-turn budget pre-call check (same enforcement path)', () => {
  it('blocks before the first call when the projected cost already exceeds maxBudgetUsd', async () => {
    // Priced model so the estimate is non-zero: gpt-4o output reserve
    // alone is ~4 cents, well over a $0.00001 cap.
    const provider = new MockProvider([{ content: 'should never run' }]);
    const gateway = new FakeGateway();
    const runtime = makeRuntime(provider, gateway, 'openai');
    const events = await collectEvents(runtime, { bot: testBot('gpt-4o'), maxBudgetUsd: 0.00001 });
    expect(provider.calls).toHaveLength(0);
    const capEvent = events.find((e) => e.type === 'spend_cap_reached');
    expect(capEvent).toMatchObject({ capKind: 'turn-budget' });
    expect((capEvent as { message: string }).message).toContain('Budget cap reached');
  });

  it('lets affordable calls through and still stops post-call (backstop intact)', async () => {
    const provider = new MockProvider([{ content: 'done' }]);
    const gateway = new FakeGateway();
    const runtime = makeRuntime(provider, gateway);
    const events = await collectEvents(runtime, { bot: testBot(), maxBudgetUsd: 10 });
    expect(provider.calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
