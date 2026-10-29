// SPDX-License-Identifier: Apache-2.0
// W8g: 16 parallel threads per bot — scheduler unit tests (cap + FIFO)
// and a runtime integration test proving a slow turn in thread A does
// not block a turn in thread B of the same bot.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { BotTurnScheduler, MAX_PARALLEL_THREADS_PER_BOT } from '../src/turn-scheduler.js';
import type { GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ChatMessage, LLMProvider } from '../src/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('BotTurnScheduler', () => {
  it('cap is 16 per bot', () => {
    expect(MAX_PARALLEL_THREADS_PER_BOT).toBe(16);
    expect(new BotTurnScheduler().perBotLimit).toBe(16);
  });

  it('allows up to the cap immediately and queues FIFO beyond it', async () => {
    const sched = new BotTurnScheduler(2);
    const r1 = await sched.acquire('b');
    const r2 = await sched.acquire('b');
    expect(sched.activeCount('b')).toBe(2);
    let thirdAcquired = false;
    const p3 = sched.acquire('b').then((rel) => {
      thirdAcquired = true;
      return rel;
    });
    await sleep(20);
    expect(thirdAcquired).toBe(false);
    expect(sched.queuedCount('b')).toBe(1);
    r1();
    const r3 = await p3;
    expect(thirdAcquired).toBe(true);
    expect(sched.activeCount('b')).toBe(2);
    r2();
    r3();
    expect(sched.activeCount('b')).toBe(0);
  });

  it('bots never block each other', async () => {
    const sched = new BotTurnScheduler(1);
    const ra = await sched.acquire('bot-a');
    // bot-b acquires immediately even though bot-a is at its cap.
    const rb = await sched.acquire('bot-b');
    expect(sched.activeCount('bot-b')).toBe(1);
    ra();
    rb();
  });
});

// ---------------------------------------------------------------------------
// Runtime integration: slow thread A vs fast thread B (same bot).
// ---------------------------------------------------------------------------

function allowAllGateway(): GovernanceGateway {
  return {
    classify: () => 'allow',
    evaluate: () => ({ decision: 'allow' }),
    awaitDecision: async () => 'approved',
    decide: () => {},
    audit: () => {},
    runPreHooks: async () => {},
    runPostHooks: async () => {},
  };
}

function testBot(): BotConfig {
  return {
    id: 'bot-par',
    name: 'Parallel Bot',
    description: 'test',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

/** Provider whose reply depends on the user message: "slow" waits for a gate. */
class GatedProvider implements LLMProvider {
  readonly providerId = 'mock';
  gate: Promise<void> = Promise.resolve();
  async chat(messages: ChatMessage[]): Promise<{ content: string; toolCalls: []; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser?.content.includes('slow')) await this.gate;
    return { content: 'ok', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels(): Promise<[]> {
    return [];
  }
}

describe('runtime parallel threads (W8g)', () => {
  it('thread B completes while thread A of the same bot is still running', async () => {
    const provider = new GatedProvider();
    let releaseGate: () => void = () => {};
    provider.gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    class TestRuntime extends AgentRuntime {
      protected resolveProvider(): LLMProvider {
        return provider;
      }
    }
    const runtime = new TestRuntime({
      dbPath: ':memory:',
      skillsDir: '/tmp/w8-sched-skills-missing',
      governance: allowAllGateway(),
      toolRegistry: new Map(),
      defaultProviderId: 'mock',
    });
    const bot = testBot();
    const order: string[] = [];
    const turnA = runtime
      .runTurn({ bot, message: 'slow please', sessionId: 'thread-a', onEvent: () => {} })
      .then(() => order.push('A'));
    // Give A time to enter the provider and block on the gate.
    await sleep(30);
    expect(runtime.turnStates.listForBot('bot-par').map((s) => s.sessionId)).toContain('thread-a');
    const turnB = runtime
      .runTurn({ bot, message: 'fast please', sessionId: 'thread-b', onEvent: () => {} })
      .then(() => order.push('B'));
    await turnB;
    expect(order).toEqual(['B']);
    releaseGate();
    await turnA;
    expect(order).toEqual(['B', 'A']);
    expect(runtime.scheduler.activeCount('bot-par')).toBe(0);
  });
});
