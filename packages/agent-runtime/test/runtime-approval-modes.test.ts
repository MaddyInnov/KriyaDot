// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolCall, ToolDefinition } from '../src/types.js';

class FakeGateway implements GovernanceGateway {
  decision: GovernanceDecision = 'allow';
  approvalOutcome: 'approved' | 'denied' = 'approved';
  audits: Array<{ type: string; detail?: unknown }> = [];

  async classify(): Promise<GovernanceDecision> {
    return this.decision;
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: this.decision };
  }
  async awaitDecision(_approvalId: string): Promise<'approved' | 'denied'> {
    return this.approvalOutcome;
  }
  decide(): void {}
  audit(entry: { type: string; detail?: unknown }): void {
    this.audits.push(entry);
  }
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

function testBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-test',
    name: 'Test Bot',
    description: 'A bot for tests',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: [],
    mcpServers: [],
    ...overrides,
  };
}

function makeRuntime(gateway: FakeGateway, tools: ToolDefinition[], provider: MockProvider): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: gateway,
    toolRegistry: new Map(tools.map((t) => [t.name, t])),
    defaultProviderId: 'mock',
  });
}

function echoTool(): ToolDefinition {
  return {
    name: 'echo_tool',
    description: 'test tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (args) => ({ echoed: args }),
  };
}

function readTool(): ToolDefinition {
  return {
    name: 'read_file',
    description: 'test read',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ error: 'not found' }),
  };
}

describe('approvalMode: plan', () => {
  it('presents the plan for approval before any tool runs', async () => {
    const gateway = new FakeGateway();
    const provider = new MockProvider([
      { content: '1. First do X\n2. Then do Y' }, // plan generation
      { toolCalls: [{ id: 'c1', name: 'echo_tool', args: {} } as ToolCall] },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [echoTool()], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan', tools: ['echo_tool'] }),
      message: 'Do the thing',
      onEvent: (e) => void events.push(e),
    });
    const approval = events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    if (approval?.type === 'approval_required') {
      expect(approval.call.name).toBe('approve_plan');
      expect(String((approval.call.args as Record<string, unknown>).plan)).toContain('First do X');
    }
    // Plan card types are audited.
    expect(gateway.audits.some((a) => a.type === 'plan.approval_requested')).toBe(true);
    expect(gateway.audits.some((a) => a.type === 'plan.approval_decided')).toBe(true);
    // Tool ran after approval.
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('denied plan ends the turn before any tool executes', async () => {
    const gateway = new FakeGateway();
    gateway.approvalOutcome = 'denied';
    let toolRan = false;
    const provider = new MockProvider([{ content: '1. Do X' }, { content: 'never' }]);
    const tool: ToolDefinition = {
      name: 'echo_tool',
      description: 't',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        toolRan = true;
        return {};
      },
    };
    const rt = makeRuntime(gateway, [tool], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan', tools: ['echo_tool'] }),
      message: 'Do the thing',
      onEvent: (e) => void events.push(e),
    });
    expect(toolRan).toBe(false);
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
    const failed = gateway.audits.find((a) => a.type === 'turn.failed');
    expect(failed).toBeDefined();
    expect((failed?.detail as { kind: string }).kind).toBe('approval_denied');
  });
});

describe('approvalMode: bypass', () => {
  it('auto-grants approvals with loud audit, no card', async () => {
    const gateway = new FakeGateway();
    gateway.decision = 'require-approval';
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'echo_tool', args: {} } as ToolCall] },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [echoTool()], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'bypass', tools: ['echo_tool'] }),
      message: 'Do it',
      onEvent: (e) => void events.push(e),
    });
    // No approval card was raised…
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    // …but the tool executed and the bypass was audited.
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    const bypassed = gateway.audits.filter((a) => a.type === 'tool.approval_bypassed');
    expect(bypassed).toHaveLength(1);
    expect(events.some((e) => e.type === 'notice')).toBe(true);
  });

  it('auto mode still raises approval cards', async () => {
    const gateway = new FakeGateway();
    gateway.decision = 'require-approval';
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'echo_tool', args: {} } as ToolCall] },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [echoTool()], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ tools: ['echo_tool'] }), // default auto
      message: 'Do it',
      onEvent: (e) => void events.push(e),
    });
    expect(events.some((e) => e.type === 'approval_required')).toBe(true);
    expect(gateway.audits.some((a) => a.type === 'tool.approval_bypassed')).toBe(false);
  });
});

describe('no-progress guard in runTurn', () => {
  it('stops a looping turn with a classified failure', async () => {
    const gateway = new FakeGateway();
    // The model keeps "reading" a missing file forever.
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: {} } as ToolCall] },
      { toolCalls: [{ id: 'c2', name: 'read_file', args: {} } as ToolCall] },
      { toolCalls: [{ id: 'c3', name: 'read_file', args: {} } as ToolCall] },
      { toolCalls: [{ id: 'c4', name: 'read_file', args: {} } as ToolCall] },
      { content: 'never reached' },
    ]);
    const rt = makeRuntime(gateway, [readTool()], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ tools: ['read_file'] }),
      message: 'Read the file',
      onEvent: (e) => void events.push(e),
      noProgressThreshold: 3,
      maxIterations: 10,
    });
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.message).toContain('No progress detected');
    const failed = gateway.audits.find((a) => a.type === 'turn.failed');
    expect((failed?.detail as { kind: string }).kind).toBe('no_progress');
    // The 4th tool call never ran — the guard tripped at 3.
    expect(provider.calls.length).toBeLessThan(4);
  });

  it('can be disabled with threshold 0', async () => {
    const gateway = new FakeGateway();
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: {} } as ToolCall] },
      { content: 'gave up' },
    ]);
    const rt = makeRuntime(gateway, [readTool()], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ tools: ['read_file'] }),
      message: 'Read',
      onEvent: (e) => void events.push(e),
      noProgressThreshold: 0,
    });
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
