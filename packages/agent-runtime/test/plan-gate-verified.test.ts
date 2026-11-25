// SPDX-License-Identifier: Apache-2.0
// Soteria Verified Plans — runtime wiring (Workstream 1 (b) + (c)):
// the plan gate in verified mode (structured steps, verify-before-card,
// blocked plan never executes), recovery notes on mid-execution blocks,
// and the Fusion post-sanitizePlan verification hook.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { FusionOrchestrator } from '../src/fusion.js';
import { verifyPlan, type PlanOracleResult } from '../src/plan-verifier.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolCall, ToolDefinition } from '../src/types.js';
import type { PlanSpec } from '../src/plan-specs.js';

class FakeGateway implements GovernanceGateway {
  decision: GovernanceDecision = 'allow';
  approvalOutcome: 'approved' | 'denied' = 'approved';
  audits: Array<{ type: string; detail?: unknown }> = [];
  /** Per-tool simulate results for the verifier oracle. */
  simMap: Record<string, PlanOracleResult> = {};
  /** Every tool name the oracle was asked to simulate, in order. */
  simCalls: string[] = [];
  specs: PlanSpec[] = [];

  async classify(): Promise<GovernanceDecision> {
    return this.decision;
  }
  async evaluate(call: ToolCall): Promise<{ decision: GovernanceDecision }> {
    // Mid-execution behaviour mirrors the sim map's deny entries.
    const sim = this.simMap[call.name];
    return { decision: sim?.effect === 'deny' ? 'deny' : this.decision, reason: sim?.reason };
  }
  async simulatePolicy(_botId: string, toolName: string): Promise<PlanOracleResult> {
    this.simCalls.push(toolName);
    return this.simMap[toolName] ?? { effect: 'allow' };
  }
  planSpecsForBot(): PlanSpec[] {
    return this.specs;
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
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

function tool(name: string, ran: Record<string, number>): ToolDefinition {
  return {
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      ran[name] = (ran[name] ?? 0) + 1;
      return { ok: true };
    },
  };
}

const STRUCTURED_PLAN = JSON.stringify({
  steps: [
    { id: 's1', tool: 'list_folder', args: { path: '.' }, dependsOn: [], description: 'List files', outputs: { paths: 'old.log' } },
    { id: 's2', tool: 'delete_file', args: { path: 'old.log' }, dependsOn: ['s1'], description: 'Delete the listed log', goal: true },
  ],
});

describe('plan gate — verified mode', () => {
  it('a verified structured plan reaches the approval card with its verdict and then executes', async () => {
    const gateway = new FakeGateway();
    gateway.specs = [{
      type: 'provenance', id: 'del-prov', toolPattern: '^delete_file$', arg: 'path',
      sourceToolPattern: '^list_folder$', sourceArg: 'paths',
    }];
    const ran: Record<string, number> = {};
    const provider = new MockProvider([
      { content: STRUCTURED_PLAN },
      { toolCalls: [{ id: 'c1', name: 'delete_file', args: { path: 'old.log' } } as ToolCall] },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [tool('list_folder', ran), tool('delete_file', ran)], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan', verifiedPlans: true, tools: ['list_folder', 'delete_file'] }),
      message: 'Clean up old logs',
      onEvent: (e) => void events.push(e),
    });
    const approval = events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    if (approval?.type === 'approval_required') {
      const args = approval.call.args as Record<string, unknown>;
      expect(String(args.plan)).toContain('Delete the listed log');
      expect((args.verification as { status: string }).status).toBe('verified');
      expect(Array.isArray(args.structuredSteps)).toBe(true);
    }
    expect(gateway.audits.some((a) => a.type === 'plan.verified')).toBe(true);
    expect(ran.delete_file).toBe(1);
  });

  it('a BLOCKED plan never reaches the card and nothing executes', async () => {
    const gateway = new FakeGateway();
    gateway.specs = [{
      type: 'provenance', id: 'del-prov', toolPattern: '^delete_file$', arg: 'path',
      sourceToolPattern: '^list_folder$', sourceArg: 'paths',
    }];
    const badPlan = JSON.stringify({
      steps: [
        { id: 's1', tool: 'list_folder', args: { path: '.' }, dependsOn: [], outputs: { paths: 'old.log' } },
        { id: 's2', tool: 'delete_file', args: { path: 'secrets.env' }, dependsOn: ['s1'], goal: true },
      ],
    });
    const ran: Record<string, number> = {};
    const provider = new MockProvider([{ content: badPlan }, { content: 'never reached' }]);
    const rt = makeRuntime(gateway, [tool('list_folder', ran), tool('delete_file', ran)], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan', verifiedPlans: true, tools: ['list_folder', 'delete_file'] }),
      message: 'Delete something',
      onEvent: (e) => void events.push(e),
    });
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(ran).toEqual({});
    const err = events.find((e) => e.type === 'error');
    expect(err && 'message' in err ? err.message : '').toContain('del-prov');
    const verified = gateway.audits.find((a) => a.type === 'plan.verified');
    expect((verified?.detail as { status: string }).status).toBe('blocked');
  });

  it('an oracle-denied step blocks the plan pre-execution (hard floor = catastrophic)', async () => {
    const gateway = new FakeGateway();
    gateway.simMap = {
      run_command: {
        effect: 'deny',
        hardFloor: { tier: 'catastrophic', reason: 'catastrophic shell command', patternId: 'catastrophic-shell' },
      },
    };
    const plan = JSON.stringify({
      steps: [{ id: 's1', tool: 'run_command', args: { command: 'rm -rf /' }, dependsOn: [], goal: true }],
    });
    const ran: Record<string, number> = {};
    const provider = new MockProvider([{ content: plan }, { content: 'never' }]);
    const rt = makeRuntime(gateway, [tool('run_command', ran)], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      // Scope 'all' explicitly: run_command is outside the default
      // high-risk-only scope (kill-criterion narrowing), where the
      // catastrophic floor still denies it at execution time instead.
      bot: testBot({
        approvalMode: 'plan', verifiedPlans: true, tools: ['run_command'],
        policy: { rules: [], planVerificationScope: 'all' },
      }),
      message: 'Run it',
      onEvent: (e) => void events.push(e),
    });
    expect(ran).toEqual({});
    const verified = gateway.audits.find((a) => a.type === 'plan.verified');
    expect((verified?.detail as { status: string }).status).toBe('blocked');
  });

  it('a prose (unparseable) plan falls back to the legacy prose gate — verification never deadlocks a turn', async () => {
    // Since 2026-11-25 this bot IS in verified mode by default; the
    // model answered with free-text prose instead of structured steps,
    // so the gate audits the skip and continues with the prose card.
    const gateway = new FakeGateway();
    const provider = new MockProvider([
      { content: '1. First do X\n2. Then do Y' },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan' }),
      message: 'Do the thing',
      onEvent: (e) => void events.push(e),
    });
    const approval = events.find((e) => e.type === 'approval_required');
    if (approval?.type === 'approval_required') {
      expect(String((approval.call.args as Record<string, unknown>).plan)).toContain('First do X');
      expect((approval.call.args as Record<string, unknown>).verification).toBeUndefined();
    }
    expect(gateway.audits.some((a) => a.type === 'plan.verified')).toBe(false);
    expect(gateway.audits.some((a) => a.type === 'plan.verification_skipped')).toBe(true);
  });
});

describe('plan gate — verified by DEFAULT (2026-11-25 decision)', () => {
  it('a bot with NO opt-in gets high-risk steps verified: an oracle-denied delete blocks pre-card', async () => {
    const gateway = new FakeGateway();
    gateway.simMap = {
      delete_file: {
        effect: 'deny',
        hardFloor: { tier: 'catastrophic', reason: 'catastrophic delete', patternId: 'catastrophic-delete' },
      },
    };
    const ran: Record<string, number> = {};
    const provider = new MockProvider([{ content: STRUCTURED_PLAN }, { content: 'never reached' }]);
    const rt = makeRuntime(gateway, [tool('list_folder', ran), tool('delete_file', ran)], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      // No verifiedPlans, no planSpecs, no scope config — the shipped
      // defaults alone must engage verification at high-risk scope.
      bot: testBot({ approvalMode: 'plan', tools: ['list_folder', 'delete_file'] }),
      message: 'Clean up old logs',
      onEvent: (e) => void events.push(e),
    });
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(ran).toEqual({});
    const verified = gateway.audits.find((a) => a.type === 'plan.verified');
    expect(verified).toBeDefined();
    const detail = verified?.detail as { status: string; scope: string };
    expect(detail.status).toBe('blocked');
    expect(detail.scope).toBe('high-risk-only');
    // Only the high-risk step was simulated — list_folder stayed out of scope.
    expect(gateway.simCalls).toEqual(['delete_file']);
  });

  it('a bot with NO opt-in: an allowed high-risk plan verifies (low-risk steps out-of-scope) and executes', async () => {
    const gateway = new FakeGateway();
    const ran: Record<string, number> = {};
    const provider = new MockProvider([
      { content: STRUCTURED_PLAN },
      { toolCalls: [{ id: 'c1', name: 'delete_file', args: { path: 'old.log' } } as ToolCall] },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [tool('list_folder', ran), tool('delete_file', ran)], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan', tools: ['list_folder', 'delete_file'] }),
      message: 'Clean up old logs',
      onEvent: (e) => void events.push(e),
    });
    const approval = events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    if (approval?.type === 'approval_required') {
      const args = approval.call.args as Record<string, unknown>;
      expect((args.verification as { status: string }).status).toBe('verified');
    }
    // Scope proof: the oracle simulated ONLY the high-risk step.
    expect(gateway.simCalls).toEqual(['delete_file']);
    const verified = gateway.audits.find((a) => a.type === 'plan.verified');
    const detail = verified?.detail as { status: string; scope: string; steps: number };
    expect(detail.status).toBe('verified');
    expect(detail.scope).toBe('high-risk-only');
    expect(detail.steps).toBe(2);
    expect(ran.delete_file).toBe(1);
  });

  it("OPT-OUT: planVerificationScope 'off' restores the prose gate (no verification at all)", async () => {
    const gateway = new FakeGateway();
    gateway.simMap = { delete_file: { effect: 'deny', reason: 'would block if verified' } };
    const ran: Record<string, number> = {};
    const provider = new MockProvider([
      { content: '1. List files\n2. Delete the old log' },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [tool('list_folder', ran), tool('delete_file', ran)], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({
        approvalMode: 'plan', tools: ['list_folder', 'delete_file'],
        policy: { rules: [], planVerificationScope: 'off' },
      }),
      message: 'Clean up old logs',
      onEvent: (e) => void events.push(e),
    });
    const approval = events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    if (approval?.type === 'approval_required') {
      expect((approval.call.args as Record<string, unknown>).verification).toBeUndefined();
    }
    expect(gateway.audits.some((a) => a.type === 'plan.verified')).toBe(false);
    expect(gateway.audits.some((a) => a.type === 'plan.verification_skipped')).toBe(false);
  });

  it('OPT-OUT: verifiedPlans false restores the prose gate even when planSpecs exist', async () => {
    const gateway = new FakeGateway();
    gateway.specs = [{
      type: 'provenance', id: 'del-prov', toolPattern: '^delete_file$', arg: 'path',
      sourceToolPattern: '^list_folder$', sourceArg: 'paths',
    }];
    const provider = new MockProvider([
      { content: '1. First do X\n2. Then do Y' },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [], provider);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan', verifiedPlans: false }),
      message: 'Do the thing',
      onEvent: (e) => void events.push(e),
    });
    const approval = events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    if (approval?.type === 'approval_required') {
      expect((approval.call.args as Record<string, unknown>).verification).toBeUndefined();
    }
    expect(gateway.audits.some((a) => a.type === 'plan.verified')).toBe(false);
    expect(gateway.audits.some((a) => a.type === 'plan.verification_skipped')).toBe(false);
  });
});

describe('recovery — mid-execution block on a verified plan', () => {
  it('marks the step blocked and instructs skip-with-dependents when goals survive', async () => {
    const gateway = new FakeGateway();
    // list_folder is denied at execution time (policy changed / oracle
    // raced) — recovery must come from the verified plan, not improv.
    gateway.simMap = { list_folder: { effect: 'allow' } };
    const plan = JSON.stringify({
      steps: [
        { id: 's1', tool: 'read_file', args: { path: 'a' }, dependsOn: [], description: 'Read a' },
        { id: 's2', tool: 'delete_file', args: { path: 'b' }, dependsOn: [], description: 'Delete b', goal: true },
      ],
    });
    const ran: Record<string, number> = {};
    const provider = new MockProvider([
      { content: plan },
      {
        toolCalls: [
          { id: 'c1', name: 'read_file', args: { path: 'a' } } as ToolCall,
          { id: 'c2', name: 'delete_file', args: { path: 'b' } } as ToolCall,
        ],
      },
      { content: 'done' },
    ]);
    const rt = makeRuntime(gateway, [tool('read_file', ran), tool('delete_file', ran)], provider);
    // Deny read_file at the governance evaluate layer only.
    const baseEvaluate = gateway.evaluate.bind(gateway);
    gateway.evaluate = async (call: ToolCall) =>
      call.name === 'read_file' ? { decision: 'deny' as const, reason: 'reads frozen' } : baseEvaluate(call);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ approvalMode: 'plan', verifiedPlans: true, tools: ['read_file', 'delete_file'] }),
      message: 'Read a and delete b',
      onEvent: (e) => void events.push(e),
    });
    const recovery = gateway.audits.find((a) => a.type === 'plan.recovery');
    expect(recovery).toBeDefined();
    expect((recovery?.detail as { action: string }).action).toBe('skip-with-dependents');
    expect(ran.read_file).toBeUndefined();
    expect(ran.delete_file).toBe(1); // the surviving goal step still ran
  });
});

describe('fusion verification hook', () => {
  it('a blocked sanitized plan fails the run before any worker launches', async () => {
    let workers = 0;
    const orchestrator = new FusionOrchestrator({
      planLlm: async () => ({
        content: JSON.stringify({
          subtasks: [
            { id: 'a', title: 'A', description: 'first', dependencies: [] },
            { id: 'b', title: 'B', description: 'second', dependencies: ['a'] },
          ],
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      fuseLlm: async () => ({ content: 'fused', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
      runWorkerTurn: async () => {
        workers += 1;
        return { output: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
      verifyPlan: async (structured) =>
        verifyPlan(structured, [], {
          simulate: async () => ({ effect: 'allow' }),
        }).then((r) => ({
          ...r,
          // Force a structural block: pretend a spec blocked step b.
          status: 'blocked' as const,
          blocked: [{ stepId: 'b', status: 'blocked' as const, source: 'symbolic' as const, reason: 'test block' }],
        })),
    });
    const result = await orchestrator.run({ task: 'do two things' });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('blocked by verification');
    expect(workers).toBe(0);
  });

  it('without a verifyPlan hook, fusion behaves exactly as before', async () => {
    const orchestrator = new FusionOrchestrator({
      planLlm: async () => ({
        content: JSON.stringify({ subtasks: [{ id: 'a', title: 'A', description: 'only', dependencies: [] }] }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      fuseLlm: async () => ({ content: 'fused', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
      runWorkerTurn: async () => ({ output: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    });
    const result = await orchestrator.run({ task: 'one thing' });
    expect(result.status).toBe('completed');
    expect(result.fused).toBe('fused');
  });
});
