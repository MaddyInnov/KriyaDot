// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { AgentRuntime, BotConfig, ToolDefinition } from '@mvp/agent-runtime';
import type { EvalContext, EvaluateResult, GovernanceGateway } from '@mvp/governance';
import { WorkflowRunner } from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

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

function makeRunner(tools = new Map<string, ToolDefinition>()): WorkflowRunner {
  const runtime = {
    runTurn: async () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  } as unknown as AgentRuntime;
  return new WorkflowRunner({
    dbPath: ':memory:',
    agentRuntime: runtime,
    governance: new AllowGovernance().asGateway(),
    tools,
    bots: new Map<string, BotConfig>(),
  });
}

function trigger(): WorkflowDefinition['nodes'][number] {
  return { id: 'trigger', type: 'trigger', name: 'Start', config: {} };
}

describe('loop node', () => {
  it('repeats body+evaluator until the evaluator accepts', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-loop-accept',
      name: 'Loop accept',
      nodes: [
        trigger(),
        {
          id: 'refine',
          type: 'loop',
          name: 'Refine',
          config: { bodyNodeId: 'draft', evaluatorNodeId: 'judge', maxIterations: 5 },
        },
        {
          id: 'final',
          type: 'set',
          name: 'Final',
          config: { assignments: { text: '{{nodes.refine.output.bodyOutput.text}}' } },
        },
        {
          id: 'draft',
          type: 'code',
          name: 'Draft',
          config: {
            code: "const prev = (nodes.draft.output && nodes.draft.output.attempt) || 0;\nreturn { attempt: prev + 1, text: 'v' + (prev + 1) };",
          },
        },
        {
          id: 'judge',
          type: 'code',
          name: 'Judge',
          config: { code: 'return { accept: nodes.draft.output.attempt >= 3 };' },
        },
      ],
      edges: [
        ['trigger', 'refine'],
        ['refine', 'final'],
      ],
    };
    runner.register(def);
    const created = await runner.startRun('wf-loop-accept', {});
    const run = await runner.awaitRun(created.id);

    expect(run.status).toBe('succeeded');
    const out = run.nodeStates['refine']?.output as {
      accepted: boolean;
      iterations: number;
      bodyOutput: { attempt: number; text: string };
      history: unknown[];
    };
    expect(out.accepted).toBe(true);
    expect(out.iterations).toBe(3);
    expect(out.bodyOutput).toEqual({ attempt: 3, text: 'v3' });
    expect(out.history).toHaveLength(3);
    // Subordinate nodes recorded their final outputs and never ran standalone.
    expect(run.nodeStates['draft']?.status).toBe('succeeded');
    expect(run.nodeStates['draft']?.output).toEqual({ attempt: 3, text: 'v3' });
    expect(run.nodeStates['judge']?.output).toEqual({ accept: true });
    expect(run.nodeStates['final']?.output).toEqual({ text: 'v3' });
    runner.close();
  });

  it('accepts on the first iteration when the evaluator says so immediately', async () => {
    const runner = makeRunner();
    runner.register({
      id: 'wf-loop-first',
      name: 'Loop first',
      nodes: [
        trigger(),
        {
          id: 'refine',
          type: 'loop',
          name: 'Refine',
          config: { bodyNodeId: 'draft', evaluatorNodeId: 'judge' },
        },
        { id: 'draft', type: 'set', name: 'Draft', config: { assignments: { x: 1 } } },
        { id: 'judge', type: 'set', name: 'Judge', config: { assignments: { accept: true } } },
      ],
      edges: [['trigger', 'refine']],
    });
    const created = await runner.startRun('wf-loop-first', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    const out = run.nodeStates['refine']?.output as { iterations: number };
    expect(out.iterations).toBe(1);
    runner.close();
  });

  it('supports an if-node evaluator via acceptPath "condition"', async () => {
    const runner = makeRunner();
    runner.register({
      id: 'wf-loop-if-eval',
      name: 'Loop if evaluator',
      nodes: [
        trigger(),
        {
          id: 'refine',
          type: 'loop',
          name: 'Refine',
          config: {
            bodyNodeId: 'draft',
            evaluatorNodeId: 'judge',
            maxIterations: 4,
            acceptPath: 'condition',
          },
        },
        {
          id: 'draft',
          type: 'code',
          name: 'Draft',
          config: {
            code: 'return { attempt: ((nodes.draft.output && nodes.draft.output.attempt) || 0) + 1 };',
          },
        },
        {
          id: 'judge',
          type: 'if',
          name: 'Judge',
          config: { condition: '{{nodes.draft.output.attempt}} >= 2' },
        },
      ],
      edges: [['trigger', 'refine']],
    });
    const created = await runner.startRun('wf-loop-if-eval', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    const out = run.nodeStates['refine']?.output as { iterations: number };
    expect(out.iterations).toBe(2);
    runner.close();
  });

  it('fails with a clear error when maxIterations is exhausted (default 5)', async () => {
    const runner = makeRunner();
    runner.register({
      id: 'wf-loop-exhaust',
      name: 'Loop exhaust',
      nodes: [
        trigger(),
        {
          id: 'refine',
          type: 'loop',
          name: 'Refine',
          config: { bodyNodeId: 'draft', evaluatorNodeId: 'judge', maxIterations: 2 },
        },
        { id: 'draft', type: 'set', name: 'Draft', config: { assignments: { x: 1 } } },
        { id: 'judge', type: 'set', name: 'Judge', config: { assignments: { accept: false } } },
      ],
      edges: [['trigger', 'refine']],
    });
    const created = await runner.startRun('wf-loop-exhaust', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['refine']?.status).toBe('failed');
    expect(run.nodeStates['refine']?.error).toMatch(/did not accept after 2 iteration/);
    expect(run.nodeStates['refine']?.error).toMatch(/maxIterations exhausted/);
    runner.close();

    // Default maxIterations is 5.
    let judgeCalls = 0;
    const tools = new Map<string, ToolDefinition>([
      [
        'judge-tool',
        {
          name: 'judge-tool',
          description: 't',
          parameters: {},
          handler: async () => {
            judgeCalls += 1;
            return { accept: false };
          },
        },
      ],
    ]);
    const runner3 = makeRunner(tools);
    runner3.register({
      id: 'wf-loop-default',
      name: 'Loop default',
      nodes: [
        trigger(),
        {
          id: 'refine',
          type: 'loop',
          name: 'Refine',
          config: { bodyNodeId: 'draft', evaluatorNodeId: 'judge' },
        },
        { id: 'draft', type: 'set', name: 'Draft', config: { assignments: { x: 1 } } },
        { id: 'judge', type: 'tool', name: 'Judge', config: { tool: 'judge-tool', args: {} } },
      ],
      edges: [['trigger', 'refine']],
    });
    const created3 = await runner3.startRun('wf-loop-default', {});
    const run3 = await runner3.awaitRun(created3.id);
    expect(run3.status).toBe('failed');
    expect(run3.nodeStates['refine']?.error).toMatch(/after 5 iteration/);
    expect(judgeCalls).toBe(5);
    runner3.close();
  });

  it('rejects invalid loop configs at register time', () => {
    const runner = makeRunner();
    expect(() =>
      runner.register({
        id: 'bad-loop-1',
        name: 'Bad',
        nodes: [trigger(), { id: 'l', type: 'loop', name: 'L', config: {} }],
        edges: [['trigger', 'l']],
      }),
    ).toThrow(/config\.bodyNodeId is required/);
    expect(() =>
      runner.register({
        id: 'bad-loop-2',
        name: 'Bad',
        nodes: [
          trigger(),
          {
            id: 'l',
            type: 'loop',
            name: 'L',
            config: { bodyNodeId: 'ghost', evaluatorNodeId: 'ghost2' },
          },
        ],
        edges: [['trigger', 'l']],
      }),
    ).toThrow(/references unknown node: ghost/);
    runner.close();
  });
});

describe('match node', () => {
  it('fans out over the source array and collects results in input order', async () => {
    const completionOrder: number[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'work-tool',
        {
          name: 'work-tool',
          description: 't',
          parameters: {},
          handler: async (args) => {
            const index = args['index'] as number;
            const item = args['item'] as number;
            // Later items finish FIRST (reverse delays) — the collected
            // order must still follow the input, not completion.
            await new Promise((r) => setTimeout(r, (5 - index) * 10));
            completionOrder.push(index);
            return { index, doubled: item * 2 };
          },
        },
      ],
    ]);
    const runner = makeRunner(tools);
    runner.register({
      id: 'wf-match-order',
      name: 'Match order',
      nodes: [
        trigger(),
        {
          id: 'prep',
          type: 'set',
          name: 'Prep',
          config: { assignments: { items: '{{input.items}}' } },
        },
        {
          id: 'fan',
          type: 'match',
          name: 'Fan',
          config: { sourceNodeId: 'prep', sourcePath: 'items', bodyNodeId: 'work', maxParallel: 3 },
        },
        {
          id: 'work',
          type: 'tool',
          name: 'Work',
          config: { tool: 'work-tool', args: { item: '{{item}}', index: '{{index}}' } },
        },
      ],
      edges: [
        ['trigger', 'prep'],
        ['prep', 'fan'],
      ],
    });
    const created = await runner.startRun('wf-match-order', { items: [1, 2, 3, 4, 5] });
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    const out = run.nodeStates['fan']?.output as {
      results: { index: number; doubled: number }[];
      count: number;
    };
    expect(out.count).toBe(5);
    // Completion really was out of order (item 2 finished before 0/1)…
    expect(completionOrder[0]).toBe(2);
    // …but results are collected in input order.
    expect(out.results).toEqual([
      { index: 0, doubled: 2 },
      { index: 1, doubled: 4 },
      { index: 2, doubled: 6 },
      { index: 3, doubled: 8 },
      { index: 4, doubled: 10 },
    ]);
    expect(run.nodeStates['work']?.status).toBe('succeeded');
    runner.close();
  });

  it('respects the maxParallel cap (and the default of 4)', async () => {
    let active = 0;
    let maxActive = 0;
    const tools = new Map<string, ToolDefinition>([
      [
        'slow',
        {
          name: 'slow',
          description: 't',
          parameters: {},
          handler: async (args) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 25));
            active -= 1;
            return { v: args['v'] };
          },
        },
      ],
    ]);
    const runner = makeRunner(tools);
    runner.register({
      id: 'wf-match-cap',
      name: 'Match cap',
      nodes: [
        trigger(),
        {
          id: 'prep',
          type: 'set',
          name: 'Prep',
          config: { assignments: { items: '{{input.items}}' } },
        },
        {
          id: 'fan',
          type: 'match',
          name: 'Fan',
          config: { sourceNodeId: 'prep', sourcePath: 'items', bodyNodeId: 'work', maxParallel: 2 },
        },
        {
          id: 'work',
          type: 'tool',
          name: 'Work',
          config: { tool: 'slow', args: { v: '{{item}}' } },
        },
      ],
      edges: [
        ['trigger', 'prep'],
        ['prep', 'fan'],
      ],
    });
    const created = await runner.startRun('wf-match-cap', { items: [10, 20, 30, 40, 50, 60] });
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    expect(maxActive).toBe(2);
    const out = run.nodeStates['fan']?.output as { results: { v: number }[] };
    expect(out.results.map((r) => r.v)).toEqual([10, 20, 30, 40, 50, 60]);
    runner.close();
  });

  it('reads the whole source output when no sourcePath is given, and handles empty arrays', async () => {
    const runner = makeRunner();
    runner.register({
      id: 'wf-match-whole',
      name: 'Match whole',
      nodes: [
        trigger(),
        {
          id: 'list',
          type: 'code',
          name: 'List',
          config: { code: 'return input.items;' },
        },
        {
          id: 'fan',
          type: 'match',
          name: 'Fan',
          config: { sourceNodeId: 'list', bodyNodeId: 'work' },
        },
        {
          id: 'work',
          type: 'set',
          name: 'Work',
          config: { assignments: { seen: '{{item}}', at: '{{index}}' } },
        },
      ],
      edges: [
        ['trigger', 'list'],
        ['list', 'fan'],
      ],
    });
    const created = await runner.startRun('wf-match-whole', { items: ['a', 'b'] });
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    const out = run.nodeStates['fan']?.output as { results: unknown[]; count: number };
    expect(out.results).toEqual([
      { seen: 'a', at: 0 },
      { seen: 'b', at: 1 },
    ]);

    const created2 = await runner.startRun('wf-match-whole', { items: [] });
    const run2 = await runner.awaitRun(created2.id);
    expect(run2.status).toBe('succeeded');
    expect(run2.nodeStates['fan']?.output).toEqual({ results: [], count: 0 });
    expect(run2.nodeStates['work']?.status).toBe('skipped');
    runner.close();
  });

  it('fails clearly when the source is not an array', async () => {
    const runner = makeRunner();
    runner.register({
      id: 'wf-match-notarray',
      name: 'Match not array',
      nodes: [
        trigger(),
        { id: 'prep', type: 'set', name: 'Prep', config: { assignments: { items: 42 } } },
        {
          id: 'fan',
          type: 'match',
          name: 'Fan',
          config: { sourceNodeId: 'prep', sourcePath: 'items', bodyNodeId: 'work' },
        },
        { id: 'work', type: 'set', name: 'Work', config: { assignments: {} } },
      ],
      edges: [
        ['trigger', 'prep'],
        ['prep', 'fan'],
      ],
    });
    const created = await runner.startRun('wf-match-notarray', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['fan']?.error).toMatch(/did not produce an array/);
    runner.close();
  });

  it('rejects invalid match configs at register time', () => {
    const runner = makeRunner();
    expect(() =>
      runner.register({
        id: 'bad-match-1',
        name: 'Bad',
        nodes: [trigger(), { id: 'm', type: 'match', name: 'M', config: { bodyNodeId: 'x' } }],
        edges: [['trigger', 'm']],
      }),
    ).toThrow(/config\.sourceNodeId is required/);
    expect(() =>
      runner.register({
        id: 'bad-match-2',
        name: 'Bad',
        nodes: [
          trigger(),
          {
            id: 'm',
            type: 'match',
            name: 'M',
            config: { sourceNodeId: 'trigger', bodyNodeId: 'x', maxParallel: 0 },
          },
          { id: 'x', type: 'set', name: 'X', config: { assignments: {} } },
        ],
        edges: [['trigger', 'm']],
      }),
    ).toThrow(/config\.maxParallel must be a positive integer/);
    runner.close();
  });
});
