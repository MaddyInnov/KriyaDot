// SPDX-License-Identifier: Apache-2.0
//
// Octomind-parity closure tests: #143 (per-step role/model/toolset/
// skills + TOML format), #145 (max_parallel level cap), #150 (priced
// agent usage + injectable executor/pricer + budget enforcement),
// #151 (public dryRun()), #152 (JSONL run events). Fakes only.

import { describe, expect, it } from 'vitest';
import type { AgentRuntime, BotConfig, StreamEvent, TokenUsage, ToolDefinition } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import {
  WorkflowRunEventCollector,
  WorkflowRunner,
  applyStepConfigToBot,
  dryRun,
  formatRunEventsJsonl,
  parseRunEventsJsonl,
  parseWorkflowFile,
  parseWorkflowToml,
  priceUsageUsd,
  resolveStepConfig,
  runEventsFromRun,
  serializeWorkflow,
  serializeWorkflowToml,
  type WorkflowNodeExecutor,
  type WorkflowRunEvent,
} from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

const BOT: BotConfig = {
  id: 'writer',
  name: 'Writer',
  description: 'd',
  systemPrompt: 'You are a writer.',
  provider: 'openai',
  model: 'gpt-4o-mini',
  skills: ['base-skill'],
  tools: ['base-tool'],
  mcpServers: [],
};

// gpt-4o: $2.50 / $10.00 per 1M. 100k in + 50k out = $0.25 + $0.50 = $0.75.
const BIG_USAGE: TokenUsage = { promptTokens: 100_000, completionTokens: 50_000, totalTokens: 150_000 };

interface Harness {
  runner: WorkflowRunner;
  turnBots: BotConfig[];
  turnMessages: string[];
}

function makeRunner(opts?: {
  usage?: TokenUsage;
  nodeExecutor?: WorkflowNodeExecutor;
  onRunEvent?: (e: WorkflowRunEvent) => void;
  usagePricer?: import('../src/index.js').UsagePricer;
  tools?: Map<string, ToolDefinition>;
}): Harness {
  const turnBots: BotConfig[] = [];
  const turnMessages: string[] = [];
  const runtime = {
    runTurn: async (options: {
      bot: BotConfig;
      message: string;
      onEvent?: (e: StreamEvent) => void | Promise<void>;
    }): Promise<TokenUsage> => {
      turnBots.push(options.bot);
      turnMessages.push(options.message);
      await options.onEvent?.({ type: 'token', content: 'step text' } as StreamEvent);
      return opts?.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    },
  } as unknown as AgentRuntime;
  const governance = {
    evaluate: async () => ({ effect: 'allow' as const }),
  } as unknown as GovernanceGateway;
  const runner = new WorkflowRunner({
    dbPath: ':memory:',
    agentRuntime: runtime,
    governance,
    tools: opts?.tools ?? new Map(),
    bots: new Map([['writer', BOT]]),
    nodeExecutor: opts?.nodeExecutor,
    onRunEvent: opts?.onRunEvent,
    usagePricer: opts?.usagePricer,
  });
  return { runner, turnBots, turnMessages };
}

function triggerNode() {
  return { id: 'trigger', type: 'trigger', name: 'Start', config: {} } as const;
}

describe('#143 per-step role/model/toolset/skills', () => {
  it('resolveStepConfig normalizes toolset alias and string lists', () => {
    expect(resolveStepConfig({ botId: 'b', tools: 'search' })).toEqual({
      botId: 'b',
      toolset: ['search'],
    });
    expect(resolveStepConfig({ role: 'r', skills: ['a', 'b'] })).toEqual({
      role: 'r',
      skills: ['a', 'b'],
    });
  });

  it('applyStepConfigToBot clones and never mutates the registered bot', () => {
    const eff = applyStepConfigToBot(BOT, {
      role: 'editor',
      model: 'gpt-4o',
      toolset: ['web_search'],
      skills: ['seo'],
    });
    expect(eff).not.toBe(BOT);
    expect(eff.model).toBe('gpt-4o');
    expect(eff.provider).toBe('openai');
    expect(eff.tools).toEqual(['web_search']);
    expect(eff.skills).toEqual(['seo']);
    expect(eff.systemPrompt).toContain('You are a writer.');
    expect(eff.systemPrompt).toContain('Role for this workflow step: editor');
    expect(BOT.model).toBe('gpt-4o-mini');
    expect(BOT.tools).toEqual(['base-tool']);
  });

  it('the runner honors per-step config when executing agent and bot-turn nodes', async () => {
    const { runner, turnBots } = makeRunner();
    runner.register({
      id: 'wf-step',
      name: 'Step config',
      nodes: [
        triggerNode(),
        {
          id: 'draft',
          type: 'agent',
          name: 'Draft',
          config: {
            botId: 'writer',
            prompt: 'draft it',
            role: 'copywriter',
            provider: 'openai',
            model: 'gpt-4o',
            toolset: ['web_search', 'fetch'],
            skills: ['seo'],
          },
        },
        {
          id: 'polish',
          type: 'bot-turn',
          name: 'Polish',
          config: { botId: 'writer', prompt: 'polish', role: 'editor' },
        },
      ],
      edges: [
        ['trigger', 'draft'],
        ['draft', 'polish'],
      ],
    });
    const started = await runner.startRun('wf-step', {});
    const run = await runner.awaitRun(started.id);
    expect(run.status).toBe('succeeded');
    expect(turnBots).toHaveLength(2);
    // Step 1: every override applied.
    expect(turnBots[0]!.model).toBe('gpt-4o');
    expect(turnBots[0]!.tools).toEqual(['web_search', 'fetch']);
    expect(turnBots[0]!.skills).toEqual(['seo']);
    expect(turnBots[0]!.systemPrompt).toContain('Role for this workflow step: copywriter');
    // Step 2: role-only override keeps the bot's model/tools.
    expect(turnBots[1]!.model).toBe('gpt-4o-mini');
    expect(turnBots[1]!.tools).toEqual(['base-tool']);
    expect(turnBots[1]!.systemPrompt).toContain('Role for this workflow step: editor');
    runner.close();
  });

  it('rejects malformed per-step config at register and file-parse time', () => {
    const { runner } = makeRunner();
    const bad: WorkflowDefinition = {
      id: 'wf-bad-step',
      name: 'Bad step',
      nodes: [
        triggerNode(),
        { id: 'a', type: 'agent', name: 'A', config: { botId: 'writer', model: 42 } },
      ],
      edges: [['trigger', 'a']],
    };
    expect(() => runner.register(bad)).toThrow(/config\.model must be a non-empty string/);
    expect(() => parseWorkflowFile(serializeWorkflow(bad))).toThrow(/config\.model/);
    runner.close();
  });
});

describe('#143 TOML workflow format', () => {
  const def: WorkflowDefinition = {
    id: 'wf-toml',
    name: 'TOML workflow',
    description: 'round-trip "quoted" and\nnewline',
    budget: { maxCostUsd: 1.5 },
    maxParallel: 3,
    nodes: [
      triggerNode(),
      {
        id: 'draft',
        type: 'agent',
        name: 'Draft',
        config: {
          botId: 'writer',
          prompt: 'Write about {{input.topic}}',
          role: 'copywriter',
          model: 'gpt-4o',
          toolset: ['web_search'],
          skills: ['seo', 'style'],
        },
        retry: { maxAttempts: 2, backoffMs: 50 },
        timeoutMs: 4000,
      },
      {
        id: 'work',
        type: 'code',
        name: 'Work',
        config: { code: 'return { n: 1, ok: true, list: [1, 2.5] };' },
      },
    ],
    edges: [
      ['trigger', 'draft'],
      ['draft', 'work'],
    ],
  };

  it('round-trips losslessly through TOML (incl. step config + maxParallel)', () => {
    const toml = serializeWorkflowToml(def);
    expect(toml).toContain('format = "kriyadot.workflow"');
    expect(toml).toContain('[[workflow.nodes]]');
    expect(parseWorkflowToml(toml)).toEqual(def);
    // TOML -> JSON -> TOML is stable too.
    expect(parseWorkflowFile(serializeWorkflow(parseWorkflowToml(toml)))).toEqual(def);
    expect(serializeWorkflowToml(parseWorkflowToml(toml))).toBe(toml);
  });

  it('parses hand-written TOML with max_parallel spelling and branch edges', () => {
    const toml = [
      'format = "kriyadot.workflow"',
      'version = 1',
      '',
      '[workflow]',
      'id = "wf-hand"',
      'name = "Hand"',
      'max_parallel = 2',
      'edges = [["trigger", "check"], ["check", "yes", "true"], ["check", "no", "false"]]',
      '',
      '[[workflow.nodes]]',
      'id = "trigger"',
      'type = "trigger"',
      'name = "Start"',
      'config = {}',
      '',
      '[[workflow.nodes]]',
      'id = "check"',
      'type = "if"',
      'name = "Check"',
      'config = { condition = "{{input.go}}" }',
      '',
      '[[workflow.nodes]]',
      'id = "yes"',
      'type = "set"',
      'name = "Yes"',
      'config = { assignments = { a = 1 } }',
      '',
      '[[workflow.nodes]]',
      'id = "no"',
      'type = "set"',
      'name = "No"',
      'config = { assignments = { a = 0 } }',
      '',
    ].join('\n');
    const parsed = parseWorkflowToml(toml);
    expect(parsed.maxParallel).toBe(2);
    expect(parsed.max_parallel).toBeUndefined();
    expect(parsed.edges).toHaveLength(3);
    expect(parsed.nodes).toHaveLength(4);
  });

  it('rejects invalid TOML definitions and null values', () => {
    expect(() => parseWorkflowToml('format = "other"\nversion = 1\n')).toThrow();
    const withNull: WorkflowDefinition = {
      id: 'wf-null',
      name: 'Null',
      nodes: [
        triggerNode(),
        { id: 's', type: 'set', name: 'S', config: { assignments: { a: null } } },
      ],
      edges: [['trigger', 's']],
    };
    expect(() => serializeWorkflowToml(withNull)).toThrow(/TOML cannot represent/);
  });
});

describe('#145 max_parallel level cap', () => {
  it('caps concurrent execution within a level and validates the cap', async () => {
    // Shared counter in the tool handler measures true concurrency.
    let active = 0;
    let peak = 0;
    const probe: ToolDefinition = {
      name: 'probe',
      description: 't',
      parameters: {},
      handler: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return { ok: true };
      },
    };
    const tools = new Map<string, ToolDefinition>([['probe', probe]]);
    const nodes: WorkflowDefinition['nodes'] = [triggerNode()];
    const edges: WorkflowDefinition['edges'] = [];
    for (let i = 0; i < 6; i++) {
      nodes.push({
        id: `n${i}`,
        type: 'tool',
        name: `N${i}`,
        config: { tool: 'probe', args: {} },
      });
      edges.push(['trigger', `n${i}`]);
    }
    const capped: WorkflowDefinition = {
      id: 'wf-cap',
      name: 'Capped',
      maxParallel: 2,
      nodes,
      edges,
    };
    const { runner } = makeRunner({ tools });
    runner.register(capped);
    const started = await runner.startRun('wf-cap', {});
    const run = await runner.awaitRun(started.id);
    expect(run.status).toBe('succeeded');
    // Six nodes in one level, cap 2: never more (and, with 25ms
    // handlers, never fewer) than 2 in flight.
    expect(peak).toBe(2);
    runner.close();

    // Same workflow uncapped (default 8): all six run at once.
    active = 0;
    peak = 0;
    const { runner: runner3 } = makeRunner({ tools });
    runner3.register({ ...capped, id: 'wf-uncapped', maxParallel: undefined });
    const started3 = await runner3.startRun('wf-uncapped', {});
    const run3 = await runner3.awaitRun(started3.id);
    expect(run3.status).toBe('succeeded');
    expect(peak).toBe(6);
    runner3.close();

    const { runner: runner2 } = makeRunner();
    expect(() =>
      runner2.register({ ...capped, id: 'wf-cap-bad', maxParallel: 0 }),
    ).toThrow(/maxParallel must be a positive integer/);
    runner2.close();
  });

  it('defaults to 8 and surfaces in the dry-run plan', () => {
    const plan = dryRun({
      id: 'wf-plan-cap',
      name: 'Plan cap',
      max_parallel: 1,
      nodes: [
        triggerNode(),
        { id: 'a', type: 'delay', name: 'A', config: { seconds: 0 } },
        { id: 'b', type: 'delay', name: 'B', config: { seconds: 0 } },
      ],
      edges: [
        ['trigger', 'a'],
        ['trigger', 'b'],
      ],
    });
    expect(plan.maxParallel).toBe(1);
    const fanLevel = plan.levels.find((l) => l.width === 2);
    expect(fanLevel?.effectiveParallel).toBe(1);
    const planDefault = dryRun({
      id: 'wf-plan-cap2',
      name: 'Plan cap 2',
      nodes: [triggerNode()],
      edges: [],
    });
    expect(planDefault.maxParallel).toBe(8);
  });
});

describe('#150 priced agent usage', () => {
  it('priceUsageUsd uses the agent-runtime price table', () => {
    expect(priceUsageUsd('openai', 'gpt-4o', BIG_USAGE)).toBeCloseTo(0.75);
    expect(priceUsageUsd('openai', 'no-such-model', BIG_USAGE)).toBe(0);
  });

  it('agent nodes report non-zero costUsd from runTurn usage', async () => {
    const { runner } = makeRunner({ usage: BIG_USAGE });
    runner.register({
      id: 'wf-priced',
      name: 'Priced',
      nodes: [
        triggerNode(),
        {
          id: 'a',
          type: 'agent',
          name: 'A',
          // Step model override also drives pricing: gpt-4o rates.
          config: { botId: 'writer', prompt: 'go', model: 'gpt-4o' },
        },
      ],
      edges: [['trigger', 'a']],
    });
    const started = await runner.startRun('wf-priced', {});
    const run = await runner.awaitRun(started.id);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['a']?.output).toBe('step text');
    expect(run.nodeStates['a']?.costUsd).toBeCloseTo(0.75);
    runner.close();
  });

  it('budget enforcement stops a run whose priced LLM spend exceeds the cap', async () => {
    const { runner, turnMessages } = makeRunner({ usage: BIG_USAGE });
    runner.register({
      id: 'wf-priced-budget',
      name: 'Priced budget',
      budget: { maxCostUsd: 0.5 },
      nodes: [
        triggerNode(),
        { id: 'a', type: 'agent', name: 'A', config: { botId: 'writer', prompt: 'one', model: 'gpt-4o' } },
        { id: 'b', type: 'agent', name: 'B', config: { botId: 'writer', prompt: 'two', model: 'gpt-4o' } },
      ],
      edges: [
        ['trigger', 'a'],
        ['a', 'b'],
      ],
    });
    const started = await runner.startRun('wf-priced-budget', {});
    const run = await runner.awaitRun(started.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['a']?.status).toBe('failed');
    expect(run.nodeStates['a']?.error).toMatch(/budget exceeded/);
    expect(run.nodeStates['a']?.costUsd).toBeCloseTo(0.75);
    // Second agent node never ran.
    expect(turnMessages).toEqual(['one']);
    runner.close();
  });

  it('injected nodeExecutor usage is priced; explicit executor cost wins', async () => {
    const executor: WorkflowNodeExecutor = async (req) => {
      expect(req.effectiveBot.model).toBe('gpt-4o');
      expect(req.step.role).toBe('analyst');
      return { text: `exec:${req.message}`, usage: BIG_USAGE };
    };
    const { runner, turnBots } = makeRunner({ nodeExecutor: executor });
    runner.register({
      id: 'wf-exec',
      name: 'Injected executor',
      nodes: [
        triggerNode(),
        {
          id: 'a',
          type: 'bot-turn',
          name: 'A',
          config: { botId: 'writer', prompt: 'hi', model: 'gpt-4o', role: 'analyst' },
        },
      ],
      edges: [['trigger', 'a']],
    });
    const started = await runner.startRun('wf-exec', {});
    const run = await runner.awaitRun(started.id);
    expect(run.status).toBe('succeeded');
    // The built-in runtime was bypassed.
    expect(turnBots).toEqual([]);
    const out = run.nodeStates['a']?.output as { text: string; costUsd?: number };
    expect(out.text).toBe('exec:hi');
    expect(out.costUsd).toBeCloseTo(0.75);
    expect(run.nodeStates['a']?.costUsd).toBeCloseTo(0.75);
    runner.close();

    const explicit: WorkflowNodeExecutor = async () => ({ text: 'x', usage: BIG_USAGE, costUsd: 3 });
    const { runner: runner2 } = makeRunner({ nodeExecutor: explicit });
    runner2.register({
      id: 'wf-exec2',
      name: 'Explicit cost',
      nodes: [
        triggerNode(),
        { id: 'a', type: 'agent', name: 'A', config: { botId: 'writer', prompt: 'hi', model: 'gpt-4o' } },
      ],
      edges: [['trigger', 'a']],
    });
    const started2 = await runner2.startRun('wf-exec2', {});
    const run2 = await runner2.awaitRun(started2.id);
    expect(run2.nodeStates['a']?.costUsd).toBe(3);
    runner2.close();
  });

  it('injected usagePricer overrides the default price table', async () => {
    const { runner } = makeRunner({
      usage: BIG_USAGE,
      usagePricer: () => 0.01,
    });
    runner.register({
      id: 'wf-pricer',
      name: 'Custom pricer',
      nodes: [
        triggerNode(),
        { id: 'a', type: 'agent', name: 'A', config: { botId: 'writer', prompt: 'hi' } },
      ],
      edges: [['trigger', 'a']],
    });
    const started = await runner.startRun('wf-pricer', {});
    const run = await runner.awaitRun(started.id);
    expect(run.nodeStates['a']?.costUsd).toBeCloseTo(0.01);
    runner.close();
  });
});

describe('#151 public dryRun()', () => {
  it('is exported standalone, covers per-step config, and spawns nothing', () => {
    const plan = dryRun({
      id: 'wf-dry-public',
      name: 'Dry public',
      budget: { maxCostUsd: 2 },
      nodes: [
        triggerNode(),
        {
          id: 'a',
          type: 'agent',
          name: 'A',
          config: {
            botId: 'writer',
            prompt: 'hi',
            role: 'analyst',
            model: 'gpt-4o',
            toolset: ['web_search'],
            skills: ['seo'],
          },
        },
      ],
      edges: [['trigger', 'a']],
    });
    expect(plan.workflowId).toBe('wf-dry-public');
    expect(plan.budget).toEqual({ maxCostUsd: 2 });
    const agentNode = plan.levels.flatMap((l) => l.nodes).find((n) => n.id === 'a');
    expect(agentNode?.step).toEqual({
      botId: 'writer',
      role: 'analyst',
      model: 'gpt-4o',
      toolset: ['web_search'],
      skills: ['seo'],
    });
    expect(() =>
      dryRun({
        id: 'wf-dry-bad',
        name: 'Bad',
        nodes: [
          triggerNode(),
          { id: 'a', type: 'agent', name: 'A', config: { botId: 'writer', skills: [1] } },
        ],
        edges: [['trigger', 'a']],
      }),
    ).toThrow(/config\.skills/);
  });
});

describe('#152 JSONL run events', () => {
  it('emits run_started / step_completed(cost) / run_finished(total) as JSONL', async () => {
    const collector = new WorkflowRunEventCollector();
    const { runner } = makeRunner({ usage: BIG_USAGE, onRunEvent: collector.handle });
    runner.register({
      id: 'wf-events',
      name: 'Events',
      nodes: [
        triggerNode(),
        { id: 'a', type: 'agent', name: 'A', config: { botId: 'writer', prompt: 'hi', model: 'gpt-4o' } },
      ],
      edges: [['trigger', 'a']],
    });
    const started = await runner.startRun('wf-events', {});
    const run = await runner.awaitRun(started.id);
    expect(run.status).toBe('succeeded');

    const events = collector.forRun(started.id);
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'step_completed',
      'step_completed',
      'run_finished',
    ]);
    const agentStep = events.find(
      (e): e is Extract<WorkflowRunEvent, { type: 'step_completed' }> =>
        e.type === 'step_completed' && e.nodeId === 'a',
    );
    expect(agentStep?.costUsd).toBeCloseTo(0.75);
    expect(agentStep?.usage).toEqual(BIG_USAGE);
    expect(agentStep?.model).toBe('gpt-4o');
    const finished = events[events.length - 1] as Extract<WorkflowRunEvent, { type: 'run_finished' }>;
    expect(finished.totalCostUsd).toBeCloseTo(0.75);
    expect(finished.steps.find((s) => s.nodeId === 'a')?.costUsd).toBeCloseTo(0.75);

    // JSONL: every line parses as one JSON object; export matches live events.
    const jsonl = runner.exportRunEventsJsonl(started.id);
    expect(jsonl.endsWith('\n')).toBe(true);
    const parsed = parseRunEventsJsonl(jsonl);
    expect(parsed).toHaveLength(4);
    expect(formatRunEventsJsonl(parsed)).toBe(jsonl);
    expect(collector.toJsonl(started.id)).toBe(jsonl);

    // Reconstruction from a run snapshot yields the same totals.
    const fromRun = runEventsFromRun(runner.getRun(started.id)!);
    const fromRunFinished = fromRun[fromRun.length - 1] as Extract<
      WorkflowRunEvent,
      { type: 'run_finished' }
    >;
    expect(fromRunFinished.totalCostUsd).toBeCloseTo(0.75);
    runner.close();
  });

  it('runner.onRunEvent subscription receives events and unsubscribes cleanly', async () => {
    const { runner } = makeRunner();
    const seen: WorkflowRunEvent[] = [];
    const unsub = runner.onRunEvent((e) => seen.push(e));
    runner.register({
      id: 'wf-events2',
      name: 'Events 2',
      nodes: [triggerNode(), { id: 'd', type: 'delay', name: 'D', config: { seconds: 0 } }],
      edges: [['trigger', 'd']],
    });
    const started = await runner.startRun('wf-events2', {});
    await runner.awaitRun(started.id);
    unsub();
    expect(seen.some((e) => e.type === 'run_started')).toBe(true);
    expect(seen.some((e) => e.type === 'run_finished')).toBe(true);
    expect(runner.getRunEvents(started.id).length).toBe(seen.length);
    runner.close();
  });
});
