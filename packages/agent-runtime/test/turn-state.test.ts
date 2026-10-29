// SPDX-License-Identifier: Apache-2.0
// W8a: live step line + "Now" state — TurnStateRegistry unit tests and
// runtime integration (step events during a turn; state cleared on
// done and on error).

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { TurnStateRegistry, formatElapsed } from '../src/turn-state.js';
import type { GovernanceGateway } from '../src/governance.js';
import type { BotConfig, LLMProvider, StreamEvent } from '../src/types.js';

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

function testBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-test',
    name: 'Test Bot',
    description: 'test',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: [],
    mcpServers: [],
    ...overrides,
  };
}

function makeRuntime(provider: LLMProvider): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): LLMProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/w8-turn-state-skills-missing',
    governance: allowAllGateway(),
    toolRegistry: new Map(),
    defaultProviderId: 'mock',
  });
}

describe('TurnStateRegistry', () => {
  it('begins, updates, snapshots with elapsed, and finishes', () => {
    let t = 1000;
    const reg = new TurnStateRegistry({ now: () => t });
    const s = reg.begin({ botId: 'b1', botName: 'One', sessionId: 's1' });
    expect(s.step).toBe('Thinking');
    expect(s.elapsedMs).toBe(0);
    t = 3500;
    const u = reg.update('s1', { step: 'Running read_file', stepIndex: 2, stepTotal: 8 });
    expect(u?.step).toBe('Running read_file');
    expect(u?.stepIndex).toBe(2);
    expect(u?.elapsedMs).toBe(2500);
    expect(reg.list()).toHaveLength(1);
    expect(reg.listForBot('b1')).toHaveLength(1);
    expect(reg.listForBot('other')).toHaveLength(0);
    expect(reg.finish('s1')).toBe(true);
    expect(reg.snapshot('s1')).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it('update on an unknown session is a no-op', () => {
    const reg = new TurnStateRegistry();
    expect(reg.update('nope', { step: 'X' })).toBeUndefined();
  });

  it('formatElapsed renders seconds and minutes', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
  });
});

describe('runtime step events (W8a)', () => {
  it('emits step events during a turn and clears Now state at the end', async () => {
    const runtime = makeRuntime(new MockProvider([{ content: 'hello world' }]));
    const events: StreamEvent[] = [];
    let nowDuring: number | undefined;
    await runtime.runTurn({
      bot: testBot(),
      message: 'hi',
      sessionId: 'sess-step',
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'token') nowDuring = runtime.turnStates.list().length;
      },
    });
    const steps = events.filter((e) => e.type === 'step');
    expect(steps.length).toBeGreaterThan(0);
    const first = steps[0]!;
    if (first.type === 'step') {
      expect(first.botId).toBe('bot-test');
      expect(first.sessionId).toBe('sess-step');
      expect(first.step).toBe('Thinking');
      expect(first.stepIndex).toBe(1);
      expect(first.stepTotal).toBe(8);
      expect(typeof first.startedAt).toBe('number');
    }
    expect(nowDuring).toBe(1);
    // Cleared on turn end.
    expect(runtime.turnStates.list()).toEqual([]);
  });

  it('shows the running tool as the current step', async () => {
    const tool = {
      name: 'adder',
      description: 'adds',
      parameters: { type: 'object', properties: {} },
      handler: async () => 5,
    };
    const runtime = new (class extends AgentRuntime {
      protected resolveProvider(): LLMProvider {
        return new MockProvider([
          { toolCalls: [{ id: 'c1', name: 'adder', args: {} }] },
          { content: 'done' },
        ]);
      }
    })({
      dbPath: ':memory:',
      skillsDir: '/tmp/w8-turn-state-skills-missing',
      governance: allowAllGateway(),
      toolRegistry: new Map([[tool.name, tool]]),
      defaultProviderId: 'mock',
    });
    const steps: string[] = [];
    await runtime.runTurn({
      bot: testBot({ tools: ['adder'] }),
      message: 'add',
      sessionId: 'sess-tool',
      onEvent: (e) => {
        if (e.type === 'step') steps.push(e.step);
      },
    });
    expect(steps).toContain('Running adder');
    expect(runtime.turnStates.list()).toEqual([]);
  });

  it('clears Now state when the turn errors', async () => {
    const failing: LLMProvider = {
      providerId: 'mock',
      chat: async () => {
        throw new Error('boom');
      },
      listModels: async () => [],
    };
    const runtime = makeRuntime(failing);
    await expect(
      runtime.runTurn({ bot: testBot(), message: 'hi', sessionId: 'sess-err', onEvent: () => {} }),
    ).rejects.toThrow('boom');
    expect(runtime.turnStates.list()).toEqual([]);
  });
});
