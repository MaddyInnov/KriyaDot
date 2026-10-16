// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import {
  FusionOrchestrator,
  FusionPlanError,
  buildFusionPrompt,
  buildPlannerPrompt,
  buildWorkerMessage,
  parseFusionPlan,
  planWaves,
  sanitizePlan,
  type FusionDeps,
  type FusionLlmCall,
  type FusionProgressEvent,
  type FusionRunOptions,
  type FusionSubtask,
  type FusionWorkerResult,
} from '../src/fusion.js';
import type { TokenUsage } from '../src/types.js';

const U = (total: number): TokenUsage => ({ promptTokens: total, completionTokens: total, totalTokens: total * 2 });

function llmReturning(content: string, usage: TokenUsage = U(5)): FusionLlmCall {
  return vi.fn(async () => ({ content, usage }));
}

function workerReturning(outputs: Record<string, string>): FusionDeps['runWorkerTurn'] {
  return vi.fn(async (input) => ({
    output: outputs[input.subtask.id] ?? `done:${input.subtask.id}`,
    usage: U(3),
  }));
}

function deps(over: Partial<FusionDeps> = {}): FusionDeps {
  return {
    planLlm: llmReturning('{"subtasks": []}'),
    fuseLlm: llmReturning('fused answer'),
    runWorkerTurn: workerReturning({}),
    ...over,
  };
}

describe('parseFusionPlan', () => {
  it('parses a valid plan', () => {
    const plan = parseFusionPlan(
      '{"subtasks": [{"id": "s1", "title": "Research", "description": "research X", "dependencies": []}], "rationale": "split work"}',
    );
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].id).toBe('s1');
    expect(plan.rationale).toBe('split work');
  });

  it('parses JSON inside markdown fences', () => {
    const plan = parseFusionPlan(
      'Here is the plan:\n```json\n{"subtasks": [{"id": "s1", "title": "T", "description": "D"}]}\n```',
    );
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].dependencies).toEqual([]);
  });

  it('parses JSON with surrounding prose', () => {
    const plan = parseFusionPlan('Sure! {"subtasks": []} Let me know.');
    expect(plan.subtasks).toEqual([]);
  });

  it('rejects empty output', () => {
    expect(() => parseFusionPlan('')).toThrow(FusionPlanError);
    expect(() => parseFusionPlan('   ')).toThrow(FusionPlanError);
  });

  it('rejects non-JSON', () => {
    expect(() => parseFusionPlan('not json at all')).toThrow(FusionPlanError);
  });

  it('rejects missing subtasks array', () => {
    expect(() => parseFusionPlan('{"tasks": []}')).toThrow(FusionPlanError);
  });

  it('rejects subtask missing description', () => {
    expect(() => parseFusionPlan('{"subtasks": [{"id": "s1", "title": "T"}]}')).toThrow(FusionPlanError);
  });

  it('rejects subtask missing id', () => {
    expect(() => parseFusionPlan('{"subtasks": [{"title": "T", "description": "D"}]}')).toThrow(
      FusionPlanError,
    );
  });
});

describe('sanitizePlan', () => {
  it('clamps to maxSubtasks', () => {
    const plan = sanitizePlan(
      {
        subtasks: [
          { id: 's1', title: 'a', description: 'd', dependencies: [] },
          { id: 's2', title: 'b', description: 'd', dependencies: [] },
          { id: 's3', title: 'c', description: 'd', dependencies: [] },
        ],
      },
      2,
    );
    expect(plan.subtasks).toHaveLength(2);
  });

  it('dedupes ids and drops unknown/self dependencies', () => {
    const plan = sanitizePlan(
      {
        subtasks: [
          { id: 's1', title: 'a', description: 'd', dependencies: ['nope', 's1'] },
          { id: 's1', title: 'b', description: 'd', dependencies: ['s1'] },
        ],
      },
      8,
    );
    expect(plan.subtasks[0].id).toBe('s1');
    expect(plan.subtasks[1].id).not.toBe('s1');
    expect(plan.subtasks[0].dependencies).toEqual([]);
  });
});

describe('planWaves', () => {
  const s = (id: string, dependencies: string[] = []): FusionSubtask => ({
    id,
    title: id,
    description: 'd',
    dependencies,
  });

  it('puts independent subtasks in one wave', () => {
    const waves = planWaves([s('s1'), s('s2'), s('s3')]);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it('orders dependent subtasks into waves', () => {
    const waves = planWaves([s('s1'), s('s2', ['s1']), s('s3', ['s2'])]);
    expect(waves.map((w) => w.map((x) => x.id))).toEqual([['s1'], ['s2'], ['s3']]);
  });

  it('breaks cycles gracefully with a final joint wave', () => {
    const waves = planWaves([s('s1', ['s2']), s('s2', ['s1']), s('s3')]);
    const all = waves.flat().map((x) => x.id).sort();
    expect(all).toEqual(['s1', 's2', 's3']);
  });
});

describe('buildPlannerPrompt', () => {
  it('embeds the task and max subtasks', () => {
    const msgs = buildPlannerPrompt('write a report', 'ctx', 5);
    expect(msgs[1].content).toContain('write a report');
    expect(msgs[0].content).toContain('At most 5 subtasks');
  });
});

describe('buildWorkerMessage', () => {
  it('includes dependency outputs for declared deps only', () => {
    const sub: FusionSubtask = { id: 's2', title: 'B', description: 'do B', dependencies: ['s1'] };
    const byId = new Map([
      ['s1', { id: 's1', title: 'A', description: 'do A', dependencies: [] }],
      ['s2', sub],
    ]);
    const msg = buildWorkerMessage(sub, 'shared', new Map([['s1', 'out-A'], ['s9', 'out-X']]), byId);
    expect(msg).toContain('out-A');
    expect(msg).not.toContain('out-X');
    expect(msg).toContain('do B');
  });
});

describe('buildFusionPrompt', () => {
  it('attributes each worker output', () => {
    const results: FusionWorkerResult[] = [
      { subtaskId: 's1', title: 'Research', output: 'facts', usage: U(1) },
      { subtaskId: 's2', title: 'Write', output: '', usage: U(1), error: 'boom' },
    ];
    const msgs = buildFusionPrompt('task', results);
    expect(msgs[1].content).toContain('[s1] Research');
    expect(msgs[1].content).toContain('facts');
    expect(msgs[1].content).toContain('boom');
  });
});

describe('FusionOrchestrator', () => {
  const PLAN_TWO =
    '{"subtasks": [' +
    '{"id": "s1", "title": "Research", "description": "research the topic", "dependencies": []},' +
    '{"id": "s2", "title": "Draft", "description": "draft the doc", "dependencies": ["s1"]}' +
    '], "rationale": "research then draft"}';

  async function runWithEvents(
    d: FusionDeps,
    opts: FusionRunOptions,
  ): Promise<{ result: Awaited<ReturnType<FusionOrchestrator['run']>>; events: FusionProgressEvent[] }> {
    const events: FusionProgressEvent[] = [];
    const orch = new FusionOrchestrator(d);
    const result = await orch.run(opts, (e) => {
      events.push(e);
    });
    return { result, events };
  }

  it('runs plan -> workers (dependency waves) -> fusion, with progress events', async () => {
    const d = deps({
      planLlm: llmReturning(PLAN_TWO),
      runWorkerTurn: workerReturning({ s1: 'research-out', s2: 'draft-out' }),
    });
    const { result, events } = await runWithEvents(d, { task: 'write doc' });

    expect(result.status).toBe('completed');
    expect(result.fallbackSingleAgent).toBe(false);
    expect(result.plan?.subtasks).toHaveLength(2);
    expect(result.workerResults.map((r) => r.output)).toEqual(['research-out', 'draft-out']);
    expect(result.fused).toBe('fused answer');
    // usage aggregated across plan + 2 workers + fusion
    expect(result.usage.totalTokens).toBe(5 * 2 + 3 * 2 * 2 + 5 * 2);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('plan_created');
    expect(types).toContain('worker_started');
    expect(types).toContain('worker_done');
    expect(types).toContain('fusion_started');
    expect(types[types.length - 1]).toBe('done');
    // s2 starts only after s1 done (dependency wave ordering)
    const s1Done = types.indexOf('worker_done');
    const startedEvents = events.filter((e) => e.type === 'worker_started');
    expect(startedEvents[0]).toMatchObject({ subtaskId: 's1' });
    expect(startedEvents[1]).toMatchObject({ subtaskId: 's2' });
    expect(s1Done).toBeLessThan(events.findIndex((e) => e.type === 'worker_started' && e.subtaskId === 's2'));
  });

  it('runs independent workers in parallel up to maxConcurrency', async () => {
    const plan = '{"subtasks": [' + [1, 2, 3, 4].map((i) => `{"id": "s${i}", "title": "T${i}", "description": "D${i}", "dependencies": []}`).join(',') + ']}';
    let concurrent = 0;
    let maxSeen = 0;
    const runWorkerTurn = vi.fn(async (input: { subtask: FusionSubtask }) => {
      concurrent++;
      maxSeen = Math.max(maxSeen, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return { output: `out-${input.subtask.id}`, usage: U(1) };
    });
    const d = deps({ planLlm: llmReturning(plan), runWorkerTurn });
    const { result } = await runWithEvents(d, { task: 'parallel', maxConcurrency: 2 });
    expect(result.status).toBe('completed');
    expect(result.workerResults).toHaveLength(4);
    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(maxSeen).toBeGreaterThan(1);
  });

  it('passes dependency outputs to dependent workers (isolation otherwise)', async () => {
    const seen: Array<{ id: string; depOutputs: Map<string, string> }> = [];
    const runWorkerTurn = vi.fn(async (input: { subtask: FusionSubtask; dependencyOutputs: Map<string, string> }) => {
      seen.push({ id: input.subtask.id, depOutputs: input.dependencyOutputs });
      return { output: `out-${input.subtask.id}`, usage: U(1) };
    });
    const d = deps({ planLlm: llmReturning(PLAN_TWO), runWorkerTurn });
    await runWithEvents(d, { task: 't' });
    const s2 = seen.find((x) => x.id === 's2');
    expect(s2?.depOutputs.get('s1')).toBe('out-s1');
    const s1 = seen.find((x) => x.id === 's1');
    expect(s1?.depOutputs.size).toBe(0);
  });

  it('falls back to single-agent mode when the planner returns garbage', async () => {
    const d = deps({ planLlm: llmReturning('definitely not json {{{') });
    const { result, events } = await runWithEvents(d, { task: 'simple task' });
    expect(result.status).toBe('completed');
    expect(result.fallbackSingleAgent).toBe(true);
    expect(result.plan).toBeNull();
    expect(result.fused).toBe('done:s1');
    expect(events.map((e) => e.type)).toContain('plan_failed');
    expect(d.runWorkerTurn).toHaveBeenCalledTimes(1);
  });

  it('falls back to single-agent mode when the planner call throws', async () => {
    const d = deps({ planLlm: async () => { throw new Error('provider down'); } });
    const { result } = await runWithEvents(d, { task: 't' });
    expect(result.fallbackSingleAgent).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('treats an empty plan as single-agent fallback', async () => {
    const d = deps({ planLlm: llmReturning('{"subtasks": []}') });
    const { result } = await runWithEvents(d, { task: 't' });
    expect(result.fallbackSingleAgent).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('keeps going when one worker fails', async () => {
    const runWorkerTurn = vi.fn(async (input: { subtask: FusionSubtask }) => {
      if (input.subtask.id === 's1') throw new Error('worker exploded');
      return { output: 'ok', usage: U(1) };
    });
    const plan = '{"subtasks": [{"id": "s1", "title": "A", "description": "d", "dependencies": []}, {"id": "s2", "title": "B", "description": "d", "dependencies": []}]}';
    const d = deps({ planLlm: llmReturning(plan), runWorkerTurn });
    const { result, events } = await runWithEvents(d, { task: 't' });
    expect(result.status).toBe('completed');
    expect(result.workerResults.find((r) => r.subtaskId === 's1')?.error).toBe('worker exploded');
    expect(result.workerResults.find((r) => r.subtaskId === 's2')?.output).toBe('ok');
    expect(events.filter((e) => e.type === 'worker_done' && !e.ok)).toHaveLength(1);
  });

  it('aborts cleanly when the budget is exceeded', async () => {
    const d = deps({
      planLlm: llmReturning(PLAN_TWO, U(1000)),
      costOf: () => 10, // $10 per call
    });
    const { result, events } = await runWithEvents(d, { task: 't', maxBudgetUsd: 5 });
    expect(result.status).toBe('aborted_budget');
    expect(result.costUsd).toBe(10);
    expect(events.map((e) => e.type)).toContain('error');
    expect(d.runWorkerTurn).not.toHaveBeenCalled();
  });

  it('caps subtasks at maxSubtasks', async () => {
    const many = '{"subtasks": [' + Array.from({ length: 12 }, (_, i) => `{"id": "s${i + 1}", "title": "T", "description": "D", "dependencies": []}`).join(',') + ']}';
    const d = deps({ planLlm: llmReturning(many) });
    const { result } = await runWithEvents(d, { task: 't', maxSubtasks: 3 });
    expect(result.plan?.subtasks).toHaveLength(3);
    expect(d.runWorkerTurn).toHaveBeenCalledTimes(3);
  });

  it('surfaces fusion-step failure without losing worker results', async () => {
    const d = deps({
      planLlm: llmReturning(PLAN_TWO),
      fuseLlm: async () => { throw new Error('fuse down'); },
    });
    const { result } = await runWithEvents(d, { task: 't' });
    expect(result.status).toBe('failed');
    expect(result.workerResults).toHaveLength(2);
    expect(result.error).toContain('Fusion step failed');
  });

  it('rejects an empty task', async () => {
    const orch = new FusionOrchestrator(deps());
    await expect(orch.run({ task: '   ' })).rejects.toThrow('must not be empty');
  });

  it('never lets a throwing progress listener break the run', async () => {
    const d = deps({ planLlm: llmReturning('{"subtasks": []}') });
    const orch = new FusionOrchestrator(d);
    const result = await orch.run({ task: 't' }, () => { throw new Error('listener boom'); });
    expect(result.status).toBe('completed');
  });

  it('emits a terminal done event', async () => {
    const d = deps({ planLlm: llmReturning('{"subtasks": []}') });
    const orch = new FusionOrchestrator(d);
    const events: FusionProgressEvent[] = [];
    await orch.run({ task: 't' }, (e) => {
      events.push(e);
    });
    expect(events.at(-1)?.type).toBe('done');
  });
});
