// SPDX-License-Identifier: Apache-2.0
// Plan-mode gate and sandbox read-only enforcement (runtime.ts).
//
// Invariants (C3+H5 fix): the `mutating` flag on ToolDefinition is
// authoritative — the stale name regexes are gone. In plan mode, mutating
// tools (edit, verify_changes, ...) must be denied pre-approval while
// read-only tools (glob, diff_review, ...) run freely. Sandbox read-only
// enforces the same flag.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolDefinition } from '../src/types.js';
import { createCodingTools } from '../src/tools/coding.js';
import { createBuiltInTools } from '../src/tools/builtin.js';
import { createVerifyTools } from '../src/tools/verify.js';

class FakeGateway implements GovernanceGateway {
  decision: GovernanceDecision = 'allow';
  async classify(): Promise<GovernanceDecision> {
    return this.decision;
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: this.decision };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  decide(): void {}
  audit(): void {}
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

/**
 * Real tool definitions (so the real `mutating` flags apply) with their
 * handlers swapped for safe spies — no filesystem or command execution.
 */
function spyTools(names: string[]): { tools: ToolDefinition[]; ran: Record<string, number> } {
  const ran: Record<string, number> = {};
  const all = [
    ...createCodingTools({ workspaceDir: '/tmp' }),
    ...createBuiltInTools({ workspaceDir: '/tmp' }),
    ...createVerifyTools({ workspaceDir: '/tmp' }),
  ];
  const tools = all
    .filter((t) => names.includes(t.name))
    .map((t) => ({
      ...t,
      handler: async () => {
        ran[t.name] = (ran[t.name] ?? 0) + 1;
        return { ok: true };
      },
    }));
  return { tools, ran };
}

function providerFor(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): MockProvider {
  return new MockProvider([
    {
      toolCalls: calls,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
    {
      content: 'done',
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
    },
  ]);
}

/** Collect the tool_result events (denied ones carry `denied: true`). */
async function runAndCollect(
  runtime: AgentRuntime,
  bot: BotConfig,
  opts: { planMode?: boolean; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' },
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await runtime.runTurn({
    bot,
    message: 'go',
    planMode: opts.planMode,
    sandboxMode: opts.sandboxMode,
    onEvent: (e) => {
      events.push(e);
    },
  });
  return events;
}

function toolResults(events: StreamEvent[]): Array<{ call: { name: string }; denied?: boolean; result: unknown }> {
  return events
    .filter((e) => e.type === 'tool_result')
    .map((e) => e as unknown as { call: { name: string }; denied?: boolean; result: unknown });
}

describe('plan-mode gate (mutating flag)', () => {
  it('denies edit pre-approval in plan mode', async () => {
    const gateway = new FakeGateway(); // governance allows — the plan gate must deny
    const { tools, ran } = spyTools(['edit', 'glob']);
    const runtime = makeRuntime(
      gateway,
      tools,
      providerFor([{ id: 'c1', name: 'edit', args: { path: 'a.txt', oldText: 'x', newText: 'y' } }]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['edit', 'glob'] }), { planMode: true });
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0].denied).toBe(true);
    expect(String((results[0].result as { reason: string }).reason)).toMatch(/Plan mode/);
    expect(ran['edit'] ?? 0).toBe(0); // handler never ran
  });

  it('denies verify_changes pre-approval in plan mode', async () => {
    const gateway = new FakeGateway();
    const { tools, ran } = spyTools(['verify_changes']);
    const runtime = makeRuntime(
      gateway,
      tools,
      providerFor([{ id: 'c1', name: 'verify_changes', args: {} }]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['verify_changes'] }), { planMode: true });
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0].denied).toBe(true);
    expect(ran['verify_changes'] ?? 0).toBe(0);
  });

  it('denies write_file and run_command in plan mode', async () => {
    const gateway = new FakeGateway();
    const { tools, ran } = spyTools(['write_file', 'run_command']);
    const runtime = makeRuntime(
      gateway,
      tools,
      providerFor([
        { id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'x' } },
        { id: 'c2', name: 'run_command', args: { command: 'echo hi' } },
      ]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['write_file', 'run_command'] }), { planMode: true });
    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.denied)).toBe(true);
    expect(ran['write_file'] ?? 0).toBe(0);
    expect(ran['run_command'] ?? 0).toBe(0);
  });

  it('allows read-only tools (glob, diff_review, read_file) in plan mode', async () => {
    const gateway = new FakeGateway();
    const { tools, ran } = spyTools(['glob', 'diff_review', 'read_file']);
    const runtime = makeRuntime(
      gateway,
      tools,
      providerFor([
        { id: 'c1', name: 'glob', args: { pattern: '**/*.ts' } },
        { id: 'c2', name: 'diff_review', args: {} },
        { id: 'c3', name: 'read_file', args: { path: 'a.txt' } },
      ]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['glob', 'diff_review', 'read_file'] }), {
      planMode: true,
    });
    const results = toolResults(events);
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.denied)).toBe(true);
    expect(ran['glob']).toBe(1);
    expect(ran['diff_review']).toBe(1);
    expect(ran['read_file']).toBe(1);
  });

  it('fail-closes unknown third-party mcp: tools in plan mode', async () => {
    const gateway = new FakeGateway();
    let mcpRan = 0;
    const mcpTool: ToolDefinition = {
      name: 'mcp:calendar:get_events',
      description: 'Third-party MCP tool',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        mcpRan += 1;
        return { ok: true };
      },
    };
    const runtime = makeRuntime(
      gateway,
      [mcpTool],
      providerFor([{ id: 'c1', name: 'mcp:calendar:get_events', args: {} }]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['mcp:calendar:get_events'] }), { planMode: true });
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0].denied).toBe(true);
    expect(mcpRan).toBe(0);
  });

  it('without plan mode, mutating tools run when governance allows', async () => {
    const gateway = new FakeGateway();
    const { tools, ran } = spyTools(['edit']);
    const runtime = makeRuntime(
      gateway,
      tools,
      providerFor([{ id: 'c1', name: 'edit', args: { path: 'a.txt', oldText: 'x', newText: 'y' } }]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['edit'] }), {});
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0].denied).toBeFalsy();
    expect(ran['edit']).toBe(1);
  });
});

describe('sandbox read-only enforcement (mutating flag)', () => {
  it('blocks mutating tools by flag in read-only sandbox mode', async () => {
    const gateway = new FakeGateway();
    const { tools, ran } = spyTools(['edit', 'write_file', 'run_command']);
    const runtime = makeRuntime(
      gateway,
      tools,
      providerFor([
        { id: 'c1', name: 'edit', args: { path: 'a.txt', oldText: 'x', newText: 'y' } },
        { id: 'c2', name: 'write_file', args: { path: 'a.txt', content: 'x' } },
        { id: 'c3', name: 'run_command', args: { command: 'echo hi' } },
      ]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['edit', 'write_file', 'run_command'] }), {
      sandboxMode: 'read-only',
    });
    const results = toolResults(events);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.denied)).toBe(true);
    expect(String((results[0].result as { reason: string }).reason)).toMatch(/read-only/);
    expect(ran['edit'] ?? 0).toBe(0);
    expect(ran['write_file'] ?? 0).toBe(0);
    expect(ran['run_command'] ?? 0).toBe(0);
  });

  it('allows read-only tools in read-only sandbox mode', async () => {
    const gateway = new FakeGateway();
    const { tools, ran } = spyTools(['read_file', 'glob', 'grep']);
    const runtime = makeRuntime(
      gateway,
      tools,
      providerFor([
        { id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
        { id: 'c2', name: 'glob', args: { pattern: '**/*.ts' } },
        { id: 'c3', name: 'grep', args: { pattern: 'foo' } },
      ]),
    );
    const events = await runAndCollect(runtime, testBot({ tools: ['read_file', 'glob', 'grep'] }), {
      sandboxMode: 'read-only',
    });
    const results = toolResults(events);
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.denied)).toBe(true);
    expect(ran['read_file']).toBe(1);
    expect(ran['glob']).toBe(1);
    expect(ran['grep']).toBe(1);
  });
});
