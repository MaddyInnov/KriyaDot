// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { AgentRuntime, BotConfig, StreamEvent, TokenUsage, ToolDefinition } from '@mvp/agent-runtime';
import type { EvalContext, EvaluateResult, GovernanceGateway } from '@mvp/governance';
import {
  WORKFLOW_TEMPLATES,
  WorkflowRunner,
  fanOutTemplate,
  graphTemplate,
  parseWorkflowFile,
  researchTemplate,
  sequentialPipelineTemplate,
  serializeWorkflow,
} from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

const TEST_USAGE: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

class AllowGovernance {
  async evaluate(
    _toolName: string,
    _args: Record<string, unknown>,
    _ctx: EvalContext,
  ): Promise<EvaluateResult> {
    return { effect: 'allow' };
  }
  asGateway(): GovernanceGateway {
    return this as unknown as GovernanceGateway;
  }
}

interface Harness {
  runner: WorkflowRunner;
  agentCalls: string[];
}

function makeRunner(tools = new Map<string, ToolDefinition>()): Harness {
  const agentCalls: string[] = [];
  const runtime = {
    runTurn: async (options: {
      bot: BotConfig;
      message: string;
      onEvent?: (e: StreamEvent) => void | Promise<void>;
    }): Promise<TokenUsage> => {
      agentCalls.push(options.message);
      await options.onEvent?.({ type: 'token', content: 'agent text' } as StreamEvent);
      return TEST_USAGE;
    },
  } as unknown as AgentRuntime;
  const runner = new WorkflowRunner({
    dbPath: ':memory:',
    agentRuntime: runtime,
    governance: new AllowGovernance().asGateway(),
    tools,
    bots: new Map<string, BotConfig>(),
  });
  return { runner, agentCalls };
}

function trigger(): WorkflowDefinition['nodes'][number] {
  return { id: 'trigger', type: 'trigger', name: 'Start', config: {} };
}

function paidTool(name: string, result: unknown, calls?: string[]): ToolDefinition {
  return {
    name,
    description: 't',
    parameters: {},
    handler: async () => {
      calls?.push(name);
      return result;
    },
  };
}

describe('workflow budget', () => {
  it('aborts the run with a budget error as soon as summed costUsd exceeds the cap', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['pay-a', paidTool('pay-a', { costUsd: 0.6, data: 'a' }, calls)],
      ['pay-b', paidTool('pay-b', { costUsd: 0.6, data: 'b' }, calls)],
      ['pay-c', paidTool('pay-c', { costUsd: 0.1, data: 'c' }, calls)],
    ]);
    const { runner } = makeRunner(tools);
    runner.register({
      id: 'wf-budget',
      name: 'Budget',
      budget: { maxCostUsd: 1 },
      nodes: [
        trigger(),
        { id: 'a', type: 'tool', name: 'A', config: { tool: 'pay-a', args: {} } },
        { id: 'b', type: 'tool', name: 'B', config: { tool: 'pay-b', args: {} } },
        { id: 'c', type: 'tool', name: 'C', config: { tool: 'pay-c', args: {} } },
      ],
      edges: [
        ['trigger', 'a'],
        ['a', 'b'],
        ['b', 'c'],
      ],
    });
    const created = await runner.startRun('wf-budget', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    // a ($0.60) ran, b ($0.60) pushed the total to $1.20 > $1.00 → b is
    // marked failed with the budget error and c never executes.
    expect(run.nodeStates['a']?.status).toBe('succeeded');
    expect(run.nodeStates['a']?.costUsd).toBeCloseTo(0.6);
    expect(run.nodeStates['b']?.status).toBe('failed');
    expect(run.nodeStates['b']?.error).toMatch(/budget exceeded/);
    expect(run.nodeStates['b']?.error).toMatch(/\$1\.2000/);
    expect(run.nodeStates['b']?.costUsd).toBeCloseTo(0.6);
    expect(calls).toEqual(['pay-a', 'pay-b']);
    runner.close();
  });

  it('counts costCents from tool results toward the budget', async () => {
    const tools = new Map<string, ToolDefinition>([
      ['pay', paidTool('pay', { costCents: 75, ok: true })],
    ]);
    const { runner } = makeRunner(tools);
    runner.register({
      id: 'wf-budget-cents',
      name: 'Budget cents',
      budget: { maxCostUsd: 0.5 },
      nodes: [
        trigger(),
        { id: 'a', type: 'tool', name: 'A', config: { tool: 'pay', args: {} } },
      ],
      edges: [['trigger', 'a']],
    });
    const created = await runner.startRun('wf-budget-cents', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['a']?.error).toMatch(/budget exceeded/);
    expect(run.nodeStates['a']?.costUsd).toBeCloseTo(0.75);
    runner.close();
  });

  it('lets runs finish when total cost stays within budget (incl. loop aggregation)', async () => {
    const { runner } = makeRunner();
    runner.register({
      id: 'wf-budget-ok',
      name: 'Budget ok',
      budget: { maxCostUsd: 1 },
      nodes: [
        trigger(),
        {
          id: 'refine',
          type: 'loop',
          name: 'Refine',
          config: { bodyNodeId: 'draft', evaluatorNodeId: 'judge', maxIterations: 5 },
        },
        {
          id: 'draft',
          type: 'code',
          name: 'Draft',
          config: {
            code: 'return { attempt: ((nodes.draft.output && nodes.draft.output.attempt) || 0) + 1, costUsd: 0.2 };',
          },
        },
        {
          id: 'judge',
          type: 'code',
          name: 'Judge',
          config: { code: 'return { accept: nodes.draft.output.attempt >= 2 };' },
        },
      ],
      edges: [['trigger', 'refine']],
    });
    const created = await runner.startRun('wf-budget-ok', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    // Two iterations × $0.20 aggregated onto the loop node's cost.
    expect(run.nodeStates['refine']?.costUsd).toBeCloseTo(0.4);
    runner.close();
  });

  it('rejects an invalid budget at register time', () => {
    const { runner } = makeRunner();
    expect(() =>
      runner.register({
        id: 'wf-budget-bad',
        name: 'Bad budget',
        budget: { maxCostUsd: -5 },
        nodes: [trigger()],
        edges: [],
      }),
    ).toThrow(/budget\.maxCostUsd/);
    runner.close();
  });
});

describe('per-step retry', () => {
  it('retries a flaky node until it succeeds and counts the attempts', async () => {
    let tries = 0;
    const tools = new Map<string, ToolDefinition>([
      [
        'flaky',
        {
          name: 'flaky',
          description: 't',
          parameters: {},
          handler: async () => {
            tries += 1;
            if (tries < 3) throw new Error(`transient failure ${tries}`);
            return { ok: true, tries };
          },
        },
      ],
    ]);
    const { runner } = makeRunner(tools);
    runner.register({
      id: 'wf-retry',
      name: 'Retry',
      nodes: [
        trigger(),
        {
          id: 'work',
          type: 'tool',
          name: 'Work',
          config: { tool: 'flaky', args: {} },
          retry: { maxAttempts: 3, backoffMs: 5 },
        },
      ],
      edges: [['trigger', 'work']],
    });
    const created = await runner.startRun('wf-retry', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['work']?.output).toEqual({ ok: true, tries: 3 });
    expect(run.nodeStates['work']?.attempts).toBe(3);
    expect(tries).toBe(3);
    runner.close();
  });

  it('fails after exhausting maxAttempts, and does not retry by default', async () => {
    let tries = 0;
    const tools = new Map<string, ToolDefinition>([
      [
        'always-bad',
        {
          name: 'always-bad',
          description: 't',
          parameters: {},
          handler: async () => {
            tries += 1;
            throw new Error('permanent failure');
          },
        },
      ],
    ]);
    const { runner } = makeRunner(tools);
    runner.register({
      id: 'wf-retry-exhaust',
      name: 'Retry exhaust',
      nodes: [
        trigger(),
        {
          id: 'work',
          type: 'tool',
          name: 'Work',
          config: { tool: 'always-bad', args: {} },
          retry: { maxAttempts: 2, backoffMs: 1 },
        },
        { id: 'plain', type: 'tool', name: 'Plain', config: { tool: 'always-bad', args: {} } },
      ],
      edges: [['trigger', 'work']],
    });
    const created = await runner.startRun('wf-retry-exhaust', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['work']?.error).toMatch(/permanent failure/);
    expect(run.nodeStates['work']?.attempts).toBe(2);
    expect(tries).toBe(2);
    runner.close();

    // No retry policy → exactly one attempt.
    const harness2 = makeRunner(tools);
    tries = 0;
    harness2.runner.register({
      id: 'wf-no-retry',
      name: 'No retry',
      nodes: [
        trigger(),
        { id: 'plain', type: 'tool', name: 'Plain', config: { tool: 'always-bad', args: {} } },
      ],
      edges: [['trigger', 'plain']],
    });
    const created2 = await harness2.runner.startRun('wf-no-retry', {});
    const run2 = await harness2.runner.awaitRun(created2.id);
    expect(run2.status).toBe('failed');
    expect(tries).toBe(1);
    expect(run2.nodeStates['plain']?.attempts).toBe(1);
    harness2.runner.close();
  });
});

describe('per-step timeout', () => {
  it('fails a node that exceeds its timeoutMs', async () => {
    const tools = new Map<string, ToolDefinition>([
      [
        'slow',
        {
          name: 'slow',
          description: 't',
          parameters: {},
          handler: async () => {
            await new Promise((r) => setTimeout(r, 300));
            return { done: true };
          },
        },
      ],
    ]);
    const { runner } = makeRunner(tools);
    runner.register({
      id: 'wf-timeout',
      name: 'Timeout',
      nodes: [
        trigger(),
        {
          id: 'work',
          type: 'tool',
          name: 'Work',
          config: { tool: 'slow', args: {} },
          timeoutMs: 50,
        },
      ],
      edges: [['trigger', 'work']],
    });
    const started = Date.now();
    const created = await runner.startRun('wf-timeout', {});
    const run = await runner.awaitRun(created.id);
    const elapsed = Date.now() - started;
    expect(run.status).toBe('failed');
    expect(run.nodeStates['work']?.error).toMatch(/node work timed out after 50ms/);
    // The runner abandoned the wait instead of riding out the 300ms handler.
    expect(elapsed).toBeLessThan(290);
    runner.close();
  });

  it('lets a node finish when it is within its timeoutMs', async () => {
    const { runner } = makeRunner();
    runner.register({
      id: 'wf-timeout-ok',
      name: 'Timeout ok',
      nodes: [
        trigger(),
        { id: 'd', type: 'delay', name: 'D', config: { seconds: 0 }, timeoutMs: 2000 },
      ],
      edges: [['trigger', 'd']],
    });
    const created = await runner.startRun('wf-timeout-ok', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    runner.close();
  });
});

describe('dry-run', () => {
  const branchyDef: WorkflowDefinition = {
    id: 'wf-dry',
    name: 'Dry',
    nodes: [
      trigger(),
      { id: 'check', type: 'if', name: 'Check', config: { condition: '{{input.go}}' } },
      { id: 'yes', type: 'set', name: 'Yes', config: { assignments: { a: 1 } } },
      { id: 'no', type: 'set', name: 'No', config: { assignments: { a: 0 } } },
      { id: 'orphan', type: 'delay', name: 'Orphan', config: { seconds: 0 } },
    ],
    edges: [
      ['trigger', 'check'],
      ['check', 'yes', 'true'],
      ['check', 'no', 'false'],
    ],
  };

  it('returns topological levels with ids/types without invoking any executor', () => {
    let toolCalls = 0;
    const tools = new Map<string, ToolDefinition>([
      [
        'spy',
        {
          name: 'spy',
          description: 't',
          parameters: {},
          handler: async () => {
            toolCalls += 1;
            return {};
          },
        },
      ],
    ]);
    const { runner, agentCalls } = makeRunner(tools);
    const def: WorkflowDefinition = {
      ...branchyDef,
      nodes: [
        ...branchyDef.nodes,
        { id: 'spy-node', type: 'tool', name: 'Spy', config: { tool: 'spy', args: {} } },
        { id: 'agent-node', type: 'agent', name: 'Agent', config: { botId: 'b', prompt: 'hi' } },
      ],
      edges: [...branchyDef.edges, ['yes', 'spy-node'], ['no', 'agent-node']],
    };
    const plan = runner.dryRun(def);
    expect(plan.workflowId).toBe('wf-dry');
    expect(plan.nodeCount).toBe(7);
    expect(plan.levels.map((l) => l.nodes.map((n) => n.id))).toEqual([
      ['trigger'],
      ['check'],
      expect.arrayContaining(['yes', 'no']),
      expect.arrayContaining(['spy-node', 'agent-node']),
    ]);
    expect(plan.levels[1].nodes[0]).toEqual({ id: 'check', type: 'if', name: 'Check' });
    expect(plan.skipped).toEqual(['orphan']);
    expect(plan.subordinate).toEqual({});
    // Nothing executed: no tool calls, no agent turns, nothing registered.
    expect(toolCalls).toBe(0);
    expect(agentCalls).toEqual([]);
    expect(runner.listWorkflows()).toEqual([]);
    expect(runner.listRuns()).toEqual([]);
    runner.close();
  });

  it('reports loop/match subordinate nodes outside the levels', () => {
    const { runner } = makeRunner();
    const plan = runner.dryRun(researchTemplate);
    const levelIds = plan.levels.flatMap((l) => l.nodes.map((n) => n.id));
    expect(levelIds).toEqual(['trigger', 'research', 'final']);
    expect(plan.subordinate).toEqual({ research: ['draft', 'evaluate'] });
    expect(plan.skipped).toEqual([]);

    const fanPlan = runner.dryRun(fanOutTemplate);
    expect(fanPlan.subordinate).toEqual({ fan: ['process-item'] });
    expect(fanPlan.levels.flatMap((l) => l.nodes.map((n) => n.id))).toEqual([
      'trigger',
      'prep',
      'fan',
      'collect',
    ]);
    runner.close();
  });

  it('validates the definition and throws on invalid input', () => {
    const { runner } = makeRunner();
    expect(() =>
      runner.dryRun({
        id: 'bad',
        name: 'Bad',
        nodes: [trigger(), { id: 'a', type: 'delay', name: 'A', config: { seconds: 0 } }],
        edges: [
          ['trigger', 'a'],
          ['a', 'trigger'],
        ],
      }),
    ).toThrow(/cycle/);
    expect(() =>
      runner.dryRun({
        id: 'bad2',
        name: 'Bad2',
        nodes: [trigger()],
        edges: [['trigger', 'ghost']],
      }),
    ).toThrow(/unknown node/);
    runner.close();
  });
});

describe('shipped templates', () => {
  it('ships at least four templates; each parses via the file format and dry-runs cleanly', () => {
    const { runner } = makeRunner();
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(ids).toContain(sequentialPipelineTemplate.id);
    expect(ids).toContain(fanOutTemplate.id);
    expect(ids).toContain(graphTemplate.id);
    expect(ids).toContain(researchTemplate.id);
    for (const template of WORKFLOW_TEMPLATES) {
      // Lossless file-format round-trip.
      expect(parseWorkflowFile(serializeWorkflow(template))).toEqual(template);
      // Dry-run cleanly (validation + plan).
      const plan = runner.dryRun(template);
      expect(plan.workflowId).toBe(template.id);
      expect(plan.levels.length).toBeGreaterThan(0);
      expect(plan.skipped).toEqual([]);
    }
    runner.close();
  });

  it('the sequential, graph, fan-out and research templates also execute end-to-end', async () => {
    const { runner } = makeRunner();
    for (const template of WORKFLOW_TEMPLATES) runner.register(template);

    const seq = await runner.startRun(sequentialPipelineTemplate.id, {
      title: 'T',
      items: ['a', 'b'],
    });
    const seqRun = await runner.awaitRun(seq.id);
    expect(seqRun.status).toBe('succeeded');
    expect(seqRun.nodeStates['summary']?.output).toEqual({
      title: 'T',
      count: 2,
      upper: ['A', 'B'],
    });

    const graph = await runner.startRun(graphTemplate.id, { score: 80 });
    const graphRun = await runner.awaitRun(graph.id);
    expect(graphRun.status).toBe('succeeded');
    expect(graphRun.nodeStates['on-high']?.status).toBe('succeeded');
    expect(graphRun.nodeStates['on-low']?.status).toBe('skipped');
    expect(graphRun.nodeStates['join']?.status).toBe('succeeded');

    const fan = await runner.startRun(fanOutTemplate.id, { items: ['x', 'y', 'z'] });
    const fanRun = await runner.awaitRun(fan.id);
    expect(fanRun.status).toBe('succeeded');
    expect(fanRun.nodeStates['collect']?.output).toEqual({
      results: [
        { index: 0, value: 'x', shout: 'X' },
        { index: 1, value: 'y', shout: 'Y' },
        { index: 2, value: 'z', shout: 'Z' },
      ],
      count: 3,
    });

    const research = await runner.startRun(researchTemplate.id, { topic: 'gravity' });
    const researchRun = await runner.awaitRun(research.id);
    expect(researchRun.status).toBe('succeeded');
    expect(researchRun.nodeStates['final']?.output).toEqual({
      answer: 'Draft v3 on: gravity',
      iterations: 3,
      score: 90,
    });
    runner.close();
  });
});
