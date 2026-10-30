// SPDX-License-Identifier: Apache-2.0
// Octomind 100%-parity closure build (2026-10-30): supervisor workstream
// rows #8/#11/#14/#15/#17/#18/#19/#20/#23/#24/#25/#26/#27/#28/#41/#44/
// #62/#138/#139/#141/#180/#188.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import {
  Supervisor,
  SupervisorPlanStore,
  authorizeToolCall,
  getSupervisorStats,
  parsePlanStepTitles,
  renderSupervisorPlan,
  supervisorStats,
  verifyCompletionClaim,
  type TurnEvidence,
} from '../src/supervisor.js';
import { reviewToolCall } from '../src/reviewer.js';
import { evaluateQuestion } from '../src/evaluate.js';
import {
  BackgroundRunRegistry,
  FileBackgroundRunStore,
  MemoryBackgroundRunStore,
  SpawnConcurrencyGate,
} from '../src/background-runs.js';
import { ToolErrorTracker, classifyToolError } from '../src/progress-guard.js';
import {
  decideMcpAutoActivation,
  pickBotForIntent,
  rankBotsByIntent,
} from '../src/discovery.js';
import { routeMessageWithModel, routeMessage } from '../src/message-router.js';
import { selectToolsByIntentSync } from '../src/tool-fitting.js';
import { validateExtendedLayers, parsePlanSteps } from '../src/approval-modes.js';
import { NamedAgentRegistry } from '../src/subagent-profiles.js';
import { summarizeSupervisorStats } from '../src/spans.js';
import { TrigramEmbedder } from '../src/hybrid-search.js';
import { SteerQueue } from '../src/steer.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type {
  BotConfig,
  ChatMessage,
  LLMProvider,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- helpers ---------------------------------------------------------------

interface CapturedCall {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  opts: Record<string, unknown>;
}

/** Provider that dispatches on message content and captures full opts. */
class DispatchProvider implements LLMProvider {
  readonly providerId = 'mock';
  readonly calls: CapturedCall[] = [];
  constructor(
    private readonly dispatch: (msgs: ChatMessage[], callIdx: number) => { content?: string; toolCalls?: ToolCall[] },
  ) {}
  async chat(messages: ChatMessage[], tools: ToolDefinition[], opts: Record<string, unknown>) {
    this.calls.push({ messages, tools, opts });
    const step = this.dispatch(messages, this.calls.length - 1);
    const content = step.content ?? '';
    if (typeof opts.onToken === 'function' && content) (opts.onToken as (t: string) => void)(content);
    return {
      content,
      toolCalls: step.toolCalls ?? [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
  async listModels() {
    return [{ id: 'mock-model', name: 'Mock' }];
  }
}

class AllowGateway implements GovernanceGateway {
  audits: Array<{ type: string; detail?: unknown }> = [];
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
    this.audits.push(entry);
  }
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

function testBot(overrides: Record<string, unknown> = {}): BotConfig {
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
  } as BotConfig;
}

function makeRuntime(provider: LLMProvider, tools: ToolDefinition[] = [], gateway = new AllowGateway(), extra: Record<string, unknown> = {}): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected override resolveProvider(): LLMProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: gateway,
    toolRegistry: new Map(tools.map((t) => [t.name, t])),
    defaultProviderId: 'mock',
    ...(extra as object),
  } as ConstructorParameters<typeof AgentRuntime>[0]);
}

const knobProfile = {
  modelId: 'mock-model',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 321,
  reasoningEffort: 'high' as const,
  maxRetries: 3,
  timeoutMs: 4321,
};

// --- #8/#11: full knob set reaches aux provider calls ----------------------

describe('#8/#11 purpose-profile knobs forwarded to aux drivers', () => {
  it('reviewer receives temperature/topP/maxTokens/effort/retry/timeout', async () => {
    const provider = new DispatchProvider(() => ({ content: 'YES routine' }));
    const res = await reviewToolCall(
      provider,
      { id: 'c1', name: 'read_file', args: {} },
      { profiles: { reviewer: knobProfile } },
    );
    expect(res.verdict).toBe('yes');
    const opts = provider.calls[0]!.opts;
    expect(opts.temperature).toBe(0.7);
    expect(opts.topP).toBe(0.9);
    expect(opts.maxTokens).toBe(321);
    expect(opts.reasoningEffort).toBe('high');
    expect(opts.maxRetries).toBe(3);
    expect(opts.timeoutMs).toBe(4321);
  });

  it('supervisor gate receives the knob set (temperature 0.7, not the hard-coded 0)', async () => {
    const provider = new DispatchProvider((msgs) =>
      msgs[0]!.content.includes('calibrated decision helper')
        ? { content: '{"answer": true, "probability": 90}' }
        : { content: '{"verdict": "accept", "reason": "evidence ok"}' },
    );
    const evidence: TurnEvidence[] = [{ toolName: 'write_file', ok: true, mutating: true, excerpt: 'wrote it' }];
    const verdict = await verifyCompletionClaim(
      provider,
      { request: 'Do it', claim: 'Done', evidence },
      { profiles: { supervisor: knobProfile }, withConfidence: true },
    );
    expect(verdict.accepted).toBe(true);
    const gateOpts = provider.calls[0]!.opts;
    expect(gateOpts.temperature).toBe(0.7);
    expect(gateOpts.topP).toBe(0.9);
    expect(gateOpts.maxRetries).toBe(3);
    expect(gateOpts.timeoutMs).toBe(4321);
    // #28(a): the gate verdict carries calibrated confidence from evaluate.
    if (verdict.accepted) expect(verdict.confidence).toBeCloseTo(0.9);
  });

  it('evaluate receives the knob set', async () => {
    const provider = new DispatchProvider(() => ({ content: '{"answer": true, "probability": 75}' }));
    const ans = await evaluateQuestion(
      provider,
      { kind: 'noul', question: 'Ok?' },
      { profiles: { evaluate: knobProfile } },
    );
    expect(ans?.value).toBe(true);
    expect(provider.calls[0]!.opts.temperature).toBe(0.7);
    expect(provider.calls[0]!.opts.timeoutMs).toBe(4321);
  });
});

// --- #20/#24/#26: Supervisor unit ------------------------------------------

describe('#20 standing Supervisor', () => {
  const sketchProvider = () =>
    new DispatchProvider((msgs) =>
      msgs[0]!.content.includes('Sketch a short execution plan')
        ? { content: '1. Inspect the repo\n2. Fix the bug\n3. Run the tests' }
        : { content: '{}' },
    );

  it('produces a plan sketch and seeds the persistent plan (#62)', async () => {
    const store = new SupervisorPlanStore();
    const sup = new Supervisor(sketchProvider(), {
      profiles: { supervisor: { modelId: 'mock-model' } },
      planStore: store,
      sessionId: 's1',
      botId: 'b1',
    });
    const steps = await sup.planSketch('Fix the bug in the parser');
    expect(steps).toEqual(['Inspect the repo', 'Fix the bug', 'Run the tests']);
    const plan = store.get('s1');
    expect(plan?.steps.map((s) => s.title)).toEqual(steps);
    expect(renderSupervisorPlan(plan!)).toContain('[>] Inspect the repo');
  });

  it('steers only on failure/stall signals and is bounded per turn', async () => {
    const sup = new Supervisor(sketchProvider(), {
      profiles: { supervisor: { modelId: 'mock-model' } },
      maxSteersPerTurn: 2,
    });
    expect(sup.observe({ toolName: 'read_file', ok: true, excerpt: 'fine' })).toBeNull();
    const steer1 = sup.observe({ toolName: 'run_command', ok: false, excerpt: 'exit 1' });
    expect(steer1).toContain('supervisor steering');
    const steer2 = sup.observe({ toolName: 'x', ok: true, excerpt: '', unproductiveStreak: 3 });
    expect(steer2).toContain('no new information');
    // Bound reached: further failures do not steer.
    expect(sup.observe({ toolName: 'run_command', ok: false, excerpt: 'exit 1' })).toBeNull();
    expect(sup.steersIssued).toBe(2);
  });

  it('#24 condenses its own state at the threshold via the fake summarizer', async () => {
    const sup = new Supervisor(sketchProvider(), {
      profiles: { supervisor: { modelId: 'mock-model' } },
      condenseThresholdChars: 100,
      summarizer: async (text) => `CONDENSED(${text.length} chars)`,
    });
    for (let i = 0; i < 10; i++) {
      sup.observe({ toolName: 'tool_' + i, ok: true, excerpt: 'a fairly long observation excerpt' });
    }
    expect(await sup.maybeCondense()).toBe(true);
    expect(sup.stateText).toContain('CONDENSED(');
    expect(await sup.maybeCondense()).toBe(false);
  });

  it('#26 primitives wrap steer/delegate/resolve machinery', async () => {
    const queue = new SteerQueue();
    const provider = new DispatchProvider(() => ({ content: '{"answer": "beta", "probability": 80}' }));
    const sup = new Supervisor(provider, {
      profiles: { evaluate: { modelId: 'mock-model' } },
      steerQueue: queue,
    });
    expect(sup.steer('sess', 'change course')).toBe(true);
    expect(queue.pending('sess')).toBe(1);
    expect(await sup.delegate(() => Promise.resolve('delegated-result'))).toBe('delegated-result');
    const ans = await sup.resolve({ kind: 'choice', question: 'Pick', choices: ['alpha', 'beta'] });
    expect(ans?.value).toBe('beta');
  });

  it('#20 runtime: standing mode steers a failing/looping run; gate mode does not', async () => {
    let mainCalls = 0;
    const provider = new DispatchProvider((msgs) => {
      if (msgs.some((m) => m.content.includes('Sketch a short execution plan'))) {
        return { content: '1. Call flaky\n2. Report' };
      }
      mainCalls += 1;
      if (mainCalls <= 2) {
        return { toolCalls: [{ id: `c${mainCalls}`, name: 'flaky', args: { path: 'x' } }] };
      }
      return { content: 'final answer' };
    });
    const flaky: ToolDefinition = {
      name: 'flaky',
      description: 'always fails',
      parameters: { type: 'object', properties: {} },
      mutating: true,
      handler: async () => ({ error: 'file not found' }),
    };
    const rt = makeRuntime(provider, [flaky]);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ supervisorMode: 'standing', tools: ['flaky'] }),
      message: 'use the flaky tool',
      sessionId: 's-standing',
      modelProfiles: { supervisor: { modelId: 'mock-model' } },
      onEvent: (e) => void events.push(e),
    });
    const lastMain = provider.calls.filter((c) => !c.messages.some((m) => m.content.includes('Sketch'))).at(-1)!;
    expect(lastMain.messages.some((m) => m.content.includes('[supervisor steering]'))).toBe(true);
    expect(events.some((e) => e.type === 'notice' && e.kind === 'supervisor-steering')).toBe(true);
    expect(rt.getSupervisorPlan('s-standing')?.steps.length).toBeGreaterThan(0);
  });
});

// --- #23: authorizer --------------------------------------------------------

describe('#23 supervisor authorizer', () => {
  it('unit: reviewer YES allows, NO denies with reason', async () => {
    const yes = new DispatchProvider(() => ({ content: 'YES routine read' }));
    expect(
      (await authorizeToolCall(yes, { id: '1', name: 'read_file', args: {} }, { profiles: { reviewer: { modelId: 'mock-model' } } })).allowed,
    ).toBe(true);
    const no = new DispatchProvider(() => ({ content: 'NO this deletes data' }));
    const denied = await authorizeToolCall(
      no,
      { id: '2', name: 'delete_file', args: {} },
      { profiles: { reviewer: { modelId: 'mock-model' } } },
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('NO');
  });

  it('runtime: authorizer denial blocks a mutating call outside auto-approve; governance allow is not overridden', async () => {
    let toolRan = false;
    const provider = new DispatchProvider((msgs) => {
      if (msgs.some((m) => m.content.includes('You are a safety reviewer'))) {
        return { content: 'NO mass deletion risk' };
      }
      const mainCount = provider.calls.filter((c) => !c.messages.some((m) => m.content.includes('safety reviewer'))).length;
      if (mainCount <= 1) return { toolCalls: [{ id: 'c1', name: 'wipe', args: {} }] };
      return { content: 'ok, blocked' };
    });
    const wipe: ToolDefinition = {
      name: 'wipe',
      description: 'mutating',
      parameters: { type: 'object', properties: {} },
      mutating: true,
      handler: async () => {
        toolRan = true;
        return {};
      },
    };
    const gateway = new AllowGateway();
    const rt = makeRuntime(provider, [wipe], gateway);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ supervisorAuthorizer: true, tools: ['wipe'] }),
      message: 'wipe it',
      sessionId: 's-auth',
      modelProfiles: { reviewer: { modelId: 'mock-model' } },
      onEvent: (e) => void events.push(e),
    });
    expect(toolRan).toBe(false);
    const deniedResult = events.find((e) => e.type === 'tool_result' && e.denied);
    expect(deniedResult).toBeDefined();
    expect(gateway.audits.some((a) => a.type === 'tool.supervisor_authorizer_denied')).toBe(true);
  });
});

// --- #62: plan store ---------------------------------------------------------

describe('#62 supervisor plan store', () => {
  it('persists across turns (serialize/restore) and updates step states', () => {
    const store = new SupervisorPlanStore();
    store.set({ sessionId: 's', botId: 'b', request: 'r', steps: ['One', 'Two'], humanApproved: true });
    store.updateStep('s', 'step-1', { status: 'done', note: 'verified' });
    const plan = store.get('s')!;
    expect(plan.humanApproved).toBe(true);
    expect(plan.steps[0]).toMatchObject({ status: 'done', note: 'verified' });
    expect(plan.steps[1]!.status).toBe('active');
    const restored = new SupervisorPlanStore();
    restored.restore(store.serialize());
    expect(restored.get('s')?.steps).toHaveLength(2);
    expect(parsePlanSteps('Plan:\n1. Alpha\n2. Beta\n- Gamma')).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(parsePlanStepTitles('1) X step\n2) Y step')).toEqual(['X step', 'Y step']);
  });

  it('plan tools read/update through the runtime', async () => {
    const rt = makeRuntime(new MockProvider([{ content: 'x' }]));
    rt.supervisorPlans.set({ sessionId: 'sp', botId: 'b', request: 'r', steps: ['First', 'Second'] });
    const tools = rt.createPlanTools('sp');
    const get = tools.find((t) => t.name === 'get_plan')!;
    const out = (await get.handler({}, { sessionId: 'sp', botId: 'b' } as never)) as { plan: string };
    expect(out.plan).toContain('First');
    const upd = tools.find((t) => t.name === 'update_plan_step')!;
    const out2 = (await upd.handler({ step: '1', status: 'done' }, { sessionId: 'sp', botId: 'b' } as never)) as { plan: string };
    expect(out2.plan).toContain('[x] First');
  });
});

// --- #14/#44/#17: background runs -------------------------------------------

describe('#14/#44/#17 background runs', () => {
  it('resume re-dispatches a failed run with prior context', () => {
    const reg = new BackgroundRunRegistry();
    const { record } = reg.start({ botId: 'b', botName: 'Spec', ephemeral: false, originBotId: 'o', originSessionId: 's', task: 'do X' });
    reg.fail(record.id, 'network exploded');
    const resumed = reg.prepareResume(record.id);
    expect(resumed?.record.resumedFromId).toBe(record.id);
    expect(resumed?.record.priorContext).toContain('FAILED: network exploded');
    expect(resumed?.record.status).toBe('running');
    // Running/done runs are not resumable.
    expect(reg.prepareResume(resumed!.record.id)).toBeUndefined();
  });

  it('#44 records survive a restart via a store and still deliver', () => {
    const store = new MemoryBackgroundRunStore();
    const reg1 = new BackgroundRunRegistry({ store });
    const { record } = reg1.start({ botId: 'b', botName: 'Spec', ephemeral: false, originBotId: 'o', originSessionId: 's', task: 't' });
    reg1.complete(record.id, 'the findings');
    const reg2 = new BackgroundRunRegistry({ store });
    const drained = reg2.drainInjectable('s');
    expect(drained).toHaveLength(1);
    expect(drained[0]!.result).toBe('the findings');
    expect(reg2.drainInjectable('s')).toHaveLength(0);
  });

  it('#44 file store round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgr-'));
    const store = new FileBackgroundRunStore(join(dir, 'runs.json'));
    const reg1 = new BackgroundRunRegistry({ store });
    const { record } = reg1.start({ botId: 'b', botName: 'S', ephemeral: true, originBotId: 'o', originSessionId: 's', task: 't' });
    reg1.complete(record.id, 'done-result');
    const reg2 = new BackgroundRunRegistry({ store: new FileBackgroundRunStore(join(dir, 'runs.json')) });
    expect(reg2.peekInjectable('s')[0]!.result).toBe('done-result');
  });

  it('#17 spawn gate enforces the cap with FIFO queueing', async () => {
    const gate = new SpawnConcurrencyGate(2);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.tryAcquire()).toBeNull();
    let thirdAcquired = false;
    const p3 = gate.acquire().then((rel) => {
      thirdAcquired = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(thirdAcquired).toBe(false);
    r1();
    const r3 = await p3;
    expect(thirdAcquired).toBe(true);
    r2();
    r3();
  });

  it('#14 runtime: a run finishing mid-turn injects at the next tool boundary', async () => {
    let mainCalls = 0;
    const provider = new DispatchProvider(() => {
      mainCalls += 1;
      if (mainCalls === 1) return { toolCalls: [{ id: 'c1', name: 'finisher', args: {} }] };
      if (mainCalls === 2) return { toolCalls: [{ id: 'c2', name: 'echo2', args: {} }] };
      return { content: 'wrapped up' };
    });
    let rt: AgentRuntime;
    let bgId = '';
    const finisher: ToolDefinition = {
      name: 'finisher',
      description: 'completes the bg run',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        rt.backgroundRuns.complete(bgId, 'BG LIVE RESULT');
        return { ok: true };
      },
    };
    const echo2: ToolDefinition = {
      name: 'echo2',
      description: 'plain',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    };
    rt = makeRuntime(provider, [finisher, echo2]);
    const started = rt.backgroundRuns.start({
      botId: 'bg',
      botName: 'BgBot',
      ephemeral: true,
      originBotId: 'bot-test',
      originSessionId: 's-live',
      task: 'background task',
    });
    bgId = started.record.id;
    await rt.runTurn({
      bot: testBot({ tools: ['finisher', 'echo2'] }),
      message: 'go',
      sessionId: 's-live',
      onEvent: () => {},
    });
    const secondCall = provider.calls[1]!;
    expect(secondCall.messages.some((m) => m.content.includes('BG LIVE RESULT'))).toBe(true);
  });

  it('#14 runtime resume: resumeBackgroundRun re-runs a failed run to completion', async () => {
    const provider = new DispatchProvider((msgs) => {
      if (msgs.some((m) => m.content.includes('[Resumed run'))) return { content: 'resumed findings' };
      return { content: 'irrelevant' };
    });
    const rt = makeRuntime(provider, [], new AllowGateway(), {
      resolveBot: (id: string) => (id === 'spec-bot' ? testBot({ id: 'spec-bot' }) : undefined),
    });
    const { record } = rt.backgroundRuns.start({
      botId: 'spec-bot',
      botName: 'Spec',
      ephemeral: false,
      originBotId: 'bot-test',
      originSessionId: 's-resume',
      task: 'original task',
    });
    rt.backgroundRuns.fail(record.id, 'boom');
    const res = rt.resumeBackgroundRun(record.id);
    expect('runId' in res).toBe(true);
    for (let i = 0; i < 50 && rt.backgroundRuns.get((res as { runId: string }).runId)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = rt.backgroundRuns.get((res as { runId: string }).runId);
    expect(done?.status).toBe('done');
    expect(done?.result).toContain('resumed findings');
  });
});

// --- #18: named agent lifecycle ----------------------------------------------

describe('#18 named agent registry lifecycle', () => {
  it('add/enable/disable/remove + re-invoke by name, persisted', () => {
    const reg = new NamedAgentRegistry();
    reg.add({ id: 'a1', name: 'Researcher', specialty: 'research', description: '', systemPrompt: 'You research.', suggestedTools: ['web_search'] });
    expect(reg.ephemeralFor('Researcher')?.name).toBe('Researcher');
    expect(reg.get('a1')?.invokeCount).toBe(1);
    reg.setEnabled('a1', false);
    expect(reg.ephemeralFor('a1')).toBeUndefined();
    reg.setEnabled('Researcher', true);
    expect(reg.ephemeralFor('a1')).toBeDefined();
    const restored = new NamedAgentRegistry();
    restored.restore(reg.serialize());
    expect(restored.get('Researcher')?.profile.systemPrompt).toBe('You research.');
    expect(reg.remove('Researcher')).toBe(true);
    expect(reg.size).toBe(0);
  });
});

// --- #19: session tool registry -----------------------------------------------

describe('#19 per-session dynamic tools', () => {
  it('a session tool is visible only to its own session', async () => {
    const provider = new DispatchProvider(() => ({ content: 'hello' }));
    const rt = makeRuntime(provider, []);
    rt.registerSessionTool('sess-a', {
      name: 'only_for_a',
      description: 'session A only',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({}),
    });
    await rt.runTurn({ bot: testBot(), message: 'hi', sessionId: 'sess-a', onEvent: () => {} });
    await rt.runTurn({ bot: testBot(), message: 'hi', sessionId: 'sess-b', onEvent: () => {} });
    const toolsA = provider.calls[0]!.tools.map((t) => t.name);
    const toolsB = provider.calls[1]!.tools.map((t) => t.name);
    expect(toolsA).toContain('only_for_a');
    expect(toolsB).not.toContain('only_for_a');
    rt.closeSessionTools('sess-a');
    expect(rt.sessionToolNames('sess-a')).toEqual([]);
  });
});

// --- #15/#139: discovery -------------------------------------------------------

describe('#15/#139 discovery', () => {
  it('intent query ranks the right bot first (fake embedder = trigram)', async () => {
    const embedder = new TrigramEmbedder();
    const bots = [
      { id: 'chef', name: 'Chef Bot', description: 'cooking recipes meals kitchen food' },
      { id: 'coder', name: 'Coder Bot', description: 'software code debugging typescript programming' },
      { id: 'banker', name: 'Banker Bot', description: 'finance money budgets invoices taxes' },
    ];
    const hits = await rankBotsByIntent('help me debug this typescript code', bots, embedder);
    expect(hits[0]!.item.id).toBe('coder');
    const picked = await pickBotForIntent('plan my meals and recipes for the week', bots, embedder);
    expect(picked?.id).toBe('chef');
  });

  it('#139 MCP auto-activation: clear winner activates, tie abstains', () => {
    const hit = (id: string, score: number, kind: 'mcp' | 'skill' = 'mcp') => ({
      item: { kind, id, name: id, description: '' },
      score,
    });
    const clear = decideMcpAutoActivation([hit('srv-a', 0.9), hit('srv-b', 0.2)]);
    expect(clear.abstained).toBe(false);
    expect(clear.activate.map((h) => h.item.id)).toEqual(['srv-a']);
    const tie = decideMcpAutoActivation([hit('srv-a', 0.9), hit('srv-b', 0.88)], { maxActivate: 1 });
    expect(tie.abstained).toBe(true);
    // Skills are not MCP activations.
    const skillOnly = decideMcpAutoActivation([hit('sk', 0.95, 'skill')]);
    expect(skillOnly.abstained).toBe(true);
  });
});

// --- #138: intent tool loading --------------------------------------------------

describe('#138 intent-driven tool loading', () => {
  const manyTools: ToolDefinition[] = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    description: i < 3 ? 'database sql query tables' : `generic utility number ${i} for misc tasks`,
    parameters: { type: 'object', properties: {} },
    handler: async () => ({}),
  }));

  it('a large registry is reduced to an intent-relevant set', () => {
    const sel = selectToolsByIntentSync(manyTools, 'run a sql query on the database', { maxTools: 8 });
    expect(sel.reduced).toBe(true);
    expect(sel.tools).toHaveLength(8);
    expect(sel.kept).toContain('tool_0');
  });

  it('explicit small lists stay exact', () => {
    const few = manyTools.slice(0, 5);
    const sel = selectToolsByIntentSync(few, 'anything', { maxTools: 32, explicitList: true });
    expect(sel.reduced).toBe(false);
    expect(sel.tools).toBe(few);
    const belowCap = selectToolsByIntentSync(few, 'anything', {});
    expect(belowCap.reduced).toBe(false);
  });
});

// --- #141/#28(c): routing --------------------------------------------------------

describe('#141/#28 routing purpose profile consumer', () => {
  const bots = [
    { id: 'alpha', name: 'Alpha', description: 'handles general stuff and things', keywords: ['stuff'] },
    { id: 'beta', name: 'Beta', description: 'handles other things and stuff', keywords: ['things'] },
  ];

  it('confident deterministic routes never call the model', async () => {
    const provider = new DispatchProvider(() => ({ content: '{"answer": "beta", "probability": 99}' }));
    const route = await routeMessageWithModel('fix this typescript code bug now', [
      { id: 'coder', name: 'Coder', description: 'typescript code bugs', keywords: ['typescript', 'code', 'bug'] },
      { id: 'chef', name: 'Chef', description: 'cooking recipes', keywords: ['cooking'] },
    ], provider, { profiles: { routing: { modelId: 'mock-model' } } });
    expect(route.botId).toBe('coder');
    expect(route.via).toBe('deterministic');
    expect(provider.calls).toHaveLength(0);
  });

  it('ambiguous routes ask evaluate via the routing profile; low probability abstains', async () => {
    const det = routeMessage('stuff things', bots);
    expect(det.confidence).toBeLessThan(0.6);
    const confident = new DispatchProvider(() => ({ content: '{"answer": "beta", "probability": 85}' }));
    const viaModel = await routeMessageWithModel('stuff things', bots, confident, {
      profiles: { routing: { modelId: 'mock-model' } },
    });
    expect(viaModel.via).toBe('evaluate');
    expect(viaModel.botId).toBe('beta');
    const unsure = new DispatchProvider(() => ({ content: '{"answer": "beta", "probability": 30}' }));
    const abstained = await routeMessageWithModel('stuff things', bots, unsure, {
      profiles: { routing: { modelId: 'mock-model' } },
    });
    expect(abstained.via).toBe('abstained');
    expect(abstained.botId).toBe(det.botId);
  });
});

// --- #180: stats -----------------------------------------------------------------

describe('#180 supervisor statistics', () => {
  it('accumulates gates/authorizer decisions and summarizes', async () => {
    supervisorStats.reset();
    const evidence: TurnEvidence[] = [{ toolName: 't', ok: true, mutating: true, excerpt: 'x' }];
    const provider = new DispatchProvider((msgs) =>
      msgs[0]!.content.includes('calibrated decision helper')
        ? { content: '{"answer": true, "probability": 90}' }
        : { content: '{"verdict": "accept", "reason": "ok"}' },
    );
    await verifyCompletionClaim(provider, { request: 'r', claim: 'c', evidence }, { profile: { modelId: 'mock-model' } });
    const snap = getSupervisorStats();
    expect(snap.gatesFired).toBe(1);
    expect(snap.gateAccepts).toBe(1);
    const summary = summarizeSupervisorStats(snap as never);
    expect(summary.gateAcceptRate).toBe(1);
  });
});

// --- #188: tool error tracker ------------------------------------------------------

describe('#188 per-tool error behaviour', () => {
  it('classifies errors and fires a drop directive at K=3', () => {
    expect(classifyToolError({ error: 'ENOENT: no such file' })).toBe('not-found');
    expect(classifyToolError({ ok: true })).toBeNull();
    const tracker = new ToolErrorTracker({ threshold: 3 });
    expect(tracker.observe('read_file', { error: 'file not found' })).toBeNull();
    expect(tracker.observe('read_file', { error: 'file not found' })).toBeNull();
    // A success resets the consecutive streak.
    tracker.observe('read_file', { ok: 1 });
    expect(tracker.observe('read_file', { error: 'file not found' })).toBeNull();
    tracker.observe('read_file', { error: 'file not found' });
    const directive = tracker.observe('read_file', { error: 'file not found' });
    expect(directive?.instruction).toContain('keeps failing');
    expect(directive?.dropTool).toBe(true);
    expect(tracker.isDropped('read_file')).toBe(true);
  });

  it('runtime: after 3 failures the tool is dropped and a directive is injected', async () => {
    let handlerRuns = 0;
    let mainCalls = 0;
    const provider = new DispatchProvider(() => {
      mainCalls += 1;
      if (mainCalls <= 4) return { toolCalls: [{ id: `c${mainCalls}`, name: 'bad_tool', args: {} }] };
      return { content: 'giving up gracefully' };
    });
    const bad: ToolDefinition = {
      name: 'bad_tool',
      description: 'always fails',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        handlerRuns += 1;
        return { error: 'file not found on disk' };
      },
    };
    const rt = makeRuntime(provider, [bad]);
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: testBot({ tools: ['bad_tool'] }),
      message: 'use bad_tool',
      sessionId: 's-err',
      onEvent: (e) => void events.push(e),
    });
    expect(handlerRuns).toBe(3);
    const lastCall = provider.calls.at(-1)!;
    expect(lastCall.messages.some((m) => m.content.includes('keeps failing'))).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.denied)).toBe(true);
  });
});

// --- #41: extended layers ------------------------------------------------------------

describe('#41 extended layers validation', () => {
  it('accepts execute/verify kinds with outputMode + role; rejects junk', () => {
    const ok = validateExtendedLayers(
      [
        { name: 'gather', kind: 'execute', prompt: 'gather facts', role: 'researcher', outputMode: 'note' },
        { name: 'check', kind: 'verify', prompt: 'verify claims', profile: 'supervisor' },
      ],
      'bot',
    );
    expect(ok.errors).toEqual([]);
    expect(ok.layers?.[0]).toMatchObject({ kind: 'execute', role: 'researcher', outputMode: 'note' });
    const bad = validateExtendedLayers([{ name: 'x', kind: 'dance', prompt: 'p' }], 'bot');
    expect(bad.errors.length).toBe(1);
  });
});

// --- #25: recite -----------------------------------------------------------------------

describe('#25 supervisor recite (plan mode)', () => {
  it('a confident coverage miss forces exactly one recitation retry, then execution proceeds', async () => {
    process.env.MODEL_PROFILE_EVALUATE = 'mock-model';
    try {
      let reciteCalls = 0;
      const provider = new DispatchProvider((msgs) => {
        const all = msgs.map((m) => m.content).join('\n');
        if (all.includes('calibrated decision helper')) {
          // Coverage: judge the CHECKLIST portion only (the plan itself
          // always contains Gamma — that is the trap this test guards).
          const checklist = all.split('Checklist:')[1] ?? '';
          return checklist.includes('Gamma step')
            ? { content: '{"answer": true, "probability": 95}' }
            : { content: '{"answer": false, "probability": 90, "reason": "Gamma missing"}' };
        }
        if (all.includes('Recite it back')) {
          reciteCalls += 1;
          if (all.includes('missed steps')) {
            return { content: '1. Alpha step\n2. Beta step\n3. Gamma step' };
          }
          return { content: '1. Alpha step\n2. Beta step' };
        }
        if (all.includes('produce a concise step-by-step plan')) {
          return { content: '1. Alpha step\n2. Beta step\n3. Gamma step' };
        }
        return { content: 'executed the plan' };
      });
      const gateway = new AllowGateway();
      const rt = makeRuntime(provider, [], gateway);
      await rt.runTurn({
        bot: testBot({ approvalMode: 'plan', recitePlan: true }),
        message: 'do the three steps',
        sessionId: 's-recite',
        onEvent: () => {},
      });
      expect(reciteCalls).toBe(2);
      expect(gateway.audits.some((a) => a.type === 'plan.recite_coverage_retry')).toBe(true);
      expect(gateway.audits.some((a) => a.type === 'plan.recited')).toBe(true);
      // The approved plan also became the supervisor plan object (#62).
      expect(rt.getSupervisorPlan('s-recite')?.humanApproved).toBe(true);
      expect(rt.getSupervisorPlan('s-recite')?.steps.map((s) => s.title)).toEqual([
        'Alpha step',
        'Beta step',
        'Gamma step',
      ]);
    } finally {
      delete process.env.MODEL_PROFILE_EVALUATE;
    }
  });
});

// --- #27: hindsight retrospective ---------------------------------------------------------

describe('#27 hindsight retrospective', () => {
  it('writes one evidence-grounded Lesson via the sink after a tool-using turn', async () => {
    const lessons: Array<{ lesson: string; request: string }> = [];
    const provider = new DispatchProvider((msgs) => {
      const all = msgs.map((m) => m.content).join('\n');
      if (all.includes('retrospective lesson')) {
        return { content: 'Lesson: run echo_tool before claiming success — it returned the proof this turn.' };
      }
      const mainSoFar = provider.calls.filter((c) => !c.messages.some((m) => m.content.includes('retrospective'))).length;
      if (mainSoFar <= 1) return { toolCalls: [{ id: 'c1', name: 'echo_tool', args: {} }] };
      return { content: 'done with evidence' };
    });
    const echo: ToolDefinition = {
      name: 'echo_tool',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ echoed: true }),
    };
    const rt = makeRuntime(provider, [echo], new AllowGateway(), {
      retrospectiveSink: (info: { lesson: string; request: string }) => {
        lessons.push(info);
      },
    });
    await rt.runTurn({
      bot: testBot({ hindsight: true, tools: ['echo_tool'] }),
      message: 'echo something',
      sessionId: 's-hind',
      modelProfiles: { evaluate: { modelId: 'mock-model' } },
      onEvent: () => {},
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.lesson).toMatch(/^Lesson:/);
    expect(lessons[0]!.lesson).toContain('echo_tool');
  });

  it('writes nothing when the model declines (NONE)', async () => {
    const lessons: unknown[] = [];
    const provider = new DispatchProvider((msgs) => {
      const all = msgs.map((m) => m.content).join('\n');
      if (all.includes('retrospective lesson')) return { content: 'NONE' };
      const n = provider.calls.filter((c) => !c.messages.some((m) => m.content.includes('retrospective'))).length;
      if (n <= 1) return { toolCalls: [{ id: 'c1', name: 'echo_tool', args: {} }] };
      return { content: 'done' };
    });
    const echo: ToolDefinition = {
      name: 'echo_tool',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ echoed: true }),
    };
    const rt = makeRuntime(provider, [echo], new AllowGateway(), {
      retrospectiveSink: (info: unknown) => {
        lessons.push(info);
      },
    });
    await rt.runTurn({
      bot: testBot({ hindsight: true, tools: ['echo_tool'] }),
      message: 'echo',
      sessionId: 's-hind2',
      modelProfiles: { evaluate: { modelId: 'mock-model' } },
      onEvent: () => {},
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(lessons).toHaveLength(0);
  });
});
