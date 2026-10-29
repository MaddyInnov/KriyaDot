// SPDX-License-Identifier: Apache-2.0
// W13 runtime integration: auto-instrumentation at the provider + tool
// choke points. A mock-provider turn must produce session > turn >
// llm + tool spans WITHOUT the test creating any span by hand; outcomes,
// tool-cost attribution, redaction, and loop flagging are verified on the
// recorded run. Zero paid API usage — scripted in-process providers only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { SpanStore } from '../src/spans.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type {
  BotConfig,
  ChatMessage,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
} from '../src/types.js';

class FakeGateway implements GovernanceGateway {
  decision: 'approved' | 'denied' = 'approved';
  async classify(): Promise<GovernanceDecision> {
    return 'allow';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: 'allow' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return this.decision;
  }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

class TestRuntime extends AgentRuntime {
  constructor(
    opts: ConstructorParameters<typeof AgentRuntime>[0],
    private readonly provider: LLMProvider,
  ) {
    super(opts);
  }
  protected override resolveProvider(): LLMProvider {
    return this.provider;
  }
}

let dir: string;
let store: SpanStore;
let gateway: FakeGateway;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-w13-'));
  store = new SpanStore(join(dir, 'spans.db'));
  gateway = new FakeGateway();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const paidLookup: ToolDefinition = {
  name: 'paid_lookup',
  description: 'Paid external lookup (returns a cost).',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ costCents: 7, data: 'the answer' }),
};

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo args back.',
  parameters: { type: 'object', properties: {} },
  handler: async (args) => ({ echoed: args }),
};

function makeRuntime(provider: LLMProvider, tools: ToolDefinition[] = []): AgentRuntime {
  return new TestRuntime(
    {
      dbPath: ':memory:',
      skillsDir: '/tmp/agent-runtime-test-skills-missing',
      governance: gateway,
      toolRegistry: new Map(tools.map((t) => [t.name, t])),
      defaultProviderId: 'mock',
      spanStore: store,
    },
    provider,
  );
}

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-w13',
    name: 'Observability Bot',
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

async function runTurn(
  runtime: AgentRuntime,
  b: BotConfig,
  opts: { message?: string; sessionId?: string; signal?: AbortSignal; maxIterations?: number } = {},
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await runtime
    .runTurn({
      bot: b,
      message: opts.message ?? 'hello',
      sessionId: opts.sessionId ?? `s-${Math.random().toString(36).slice(2)}`,
      signal: opts.signal,
      maxIterations: opts.maxIterations,
      onEvent: (e) => {
        events.push(e);
      },
    })
    .catch(() => undefined);
  return events;
}

describe('auto-instrumentation', () => {
  it('a mock-provider turn produces session>turn>llm+tool spans with correct parents', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'hi' } }] },
      { content: 'all done' },
    ]);
    const runtime = makeRuntime(provider, [echoTool]);
    await runTurn(runtime, bot({ tools: ['echo'] }), { sessionId: 's-tree' });

    const runs = store.listRuns({ botId: 'bot-w13' });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.sessionId).toBe('s-tree');
    expect(run.outcome).toBe('success');

    const spans = store.listSpans(run.runId);
    const session = spans.find((s) => s.kind === 'session');
    const turn = spans.find((s) => s.kind === 'turn');
    const llms = spans.filter((s) => s.kind === 'llm');
    const tools = spans.filter((s) => s.kind === 'tool');
    expect(session?.parentSpanId).toBeNull();
    expect(turn?.parentSpanId).toBe(session?.id);
    expect(llms).toHaveLength(2); // one per provider call
    expect(tools).toHaveLength(1);
    for (const s of [...llms, ...tools]) expect(s.parentSpanId).toBe(turn?.id);
    for (const s of spans) expect(s.status).toBe('ok');
    // Payloads carry the exact prompt/completion + tool input/output.
    const llmPayload = llms[0]?.payload as { input: { messages: ChatMessage[] }; output: { content: string } };
    expect(llmPayload.input.messages.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true);
    const toolPayload = tools[0]?.payload as { input: unknown; output: { echoed: unknown } };
    expect(toolPayload.input).toEqual({ text: 'hi' });
    expect(toolPayload.output.echoed).toEqual({ text: 'hi' });
    const finalPayload = llms[1]?.payload as { output: { content: string } };
    expect(finalPayload.output.content).toBe('all done');
  });

  it('tool-span cost attribution appears in run totals', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'paid_lookup', args: {} }] },
      { content: 'done' },
    ]);
    const runtime = makeRuntime(provider, [paidLookup]);
    await runTurn(runtime, bot({ tools: ['paid_lookup'] }), { sessionId: 's-cost' });
    const run = store.listRuns({ botId: 'bot-w13' })[0]!;
    const totals = store.runTotals(run.runId);
    expect(totals.toolCostCents).toBe(7);
    expect(totals.totalCostCents).toBeGreaterThanOrEqual(7);
    const toolSpan = store.listSpans(run.runId).find((s) => s.kind === 'tool');
    expect(toolSpan?.costCents).toBe(7);
  });

  it('secrets in the user message and tool args never reach stored payloads', async () => {
    const fakeKey = 'sk-FAKESECRET1234567890';
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'echo', args: { apiKey: 'hunter2-super-secret-value' } }] },
      { content: 'done' },
    ]);
    const runtime = makeRuntime(provider, [echoTool]);
    await runTurn(runtime, bot({ tools: ['echo'] }), {
      sessionId: 's-redact',
      message: `please use ${fakeKey} for this`,
    });
    const run = store.listRuns({ botId: 'bot-w13' })[0]!;
    const raw = JSON.stringify(store.listSpans(run.runId).map((s) => s.payload));
    expect(raw).not.toContain(fakeKey);
    expect(raw).not.toContain('hunter2-super-secret-value');
    expect(raw).toContain('[REDACTED]');
  });

  it('a broken span store never breaks the turn', async () => {
    const provider = new MockProvider([{ content: 'still fine' }]);
    const runtime = makeRuntime(provider);
    store.close(); // every subsequent store write throws
    const events: StreamEvent[] = [];
    const usage = await runtime.runTurn({
      bot: bot(),
      message: 'hello',
      sessionId: 's-broken-store',
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(usage.totalTokens).toBe(15);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    // Re-open for afterEach close idempotence: recreate handle.
    store = new SpanStore(join(dir, 'spans2.db'));
  });
});

describe('outcome finalization', () => {
  it('provider error → failed', async () => {
    const failing: LLMProvider = {
      providerId: 'mock',
      async chat(): Promise<{ content: string; toolCalls: never[]; usage: TokenUsage }> {
        throw new Error('provider exploded');
      },
      async listModels(): Promise<ModelInfo[]> {
        return [];
      },
    };
    const runtime = makeRuntime(failing);
    await runTurn(runtime, bot(), { sessionId: 's-fail' });
    expect(store.listRuns({ botId: 'bot-w13' })[0]?.outcome).toBe('failed');
  });

  it('user abort → cancelled', async () => {
    const provider = new MockProvider([{ content: 'never reached' }]);
    const runtime = makeRuntime(provider);
    const ac = new AbortController();
    ac.abort();
    await runTurn(runtime, bot(), { sessionId: 's-cancel', signal: ac.signal });
    expect(store.listRuns({ botId: 'bot-w13' })[0]?.outcome).toBe('cancelled');
  });

  it('plan-approval gate ending the turn → needs-input', async () => {
    gateway.decision = 'denied';
    const provider = new MockProvider([{ content: '1. step one\n2. step two' }]);
    const runtime = makeRuntime(provider);
    await runTurn(runtime, bot({ approvalMode: 'plan' }), { sessionId: 's-plan' });
    expect(store.listRuns({ botId: 'bot-w13' })[0]?.outcome).toBe('needs-input');
  });

  it('per-bot success-rate aggregation reflects recorded outcomes', async () => {
    const ok = new MockProvider([{ content: 'fine' }]);
    const runtime = makeRuntime(ok);
    await runTurn(runtime, bot(), { sessionId: 's-ok-1' });
    await runTurn(runtime, bot(), { sessionId: 's-ok-2' });
    const stats = store.outcomesByBot().find((s) => s.botId === 'bot-w13');
    expect(stats).toMatchObject({ total: 2, success: 2 });
    expect(stats?.successRate).toBe(1);
  });
});

describe('loop flagging on the run record', () => {
  it('repeating identical tool calls >= threshold flag the run with evidence', async () => {
    const looping: LLMProvider = {
      providerId: 'mock',
      async chat(): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>; usage: TokenUsage }> {
        return {
          content: '',
          toolCalls: [{ id: `c-${Math.random()}`, name: 'echo', args: { text: 'same' } }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async listModels(): Promise<ModelInfo[]> {
        return [];
      },
    };
    const runtime = makeRuntime(looping, [echoTool]);
    const events: StreamEvent[] = [];
    await runtime
      .runTurn({
        bot: bot({ tools: ['echo'] }),
        message: 'loop please',
        sessionId: 's-loop',
        maxIterations: 4,
        noProgressThreshold: 0, // isolate loop detection from the progress guard
        onEvent: (e) => {
          events.push(e);
        },
      })
      .catch(() => undefined);
    const run = store.listRuns({ botId: 'bot-w13' })[0]!;
    expect(run.loopDetected).toBe(true);
    expect(run.loopEvidence[0]?.kind).toBe('tool');
    expect(run.loopEvidence[0]?.count).toBe(4);
    expect(run.loopEvidence[0]?.spanIds).toHaveLength(4);
    expect(run.outcome).toBe('failed'); // max iterations reached
  });

  it('varied tool calls do not flag the run', async () => {
    let n = 0;
    const varied: LLMProvider = {
      providerId: 'mock',
      async chat(): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>; usage: TokenUsage }> {
        n += 1;
        if (n >= 4) {
          return { content: 'finished', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        }
        return {
          content: '',
          toolCalls: [{ id: `c${n}`, name: 'echo', args: { text: `unique-${n}-${Math.random()}` } }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async listModels(): Promise<ModelInfo[]> {
        return [];
      },
    };
    const runtime = makeRuntime(varied, [echoTool]);
    await runTurn(runtime, bot({ tools: ['echo'] }), { sessionId: 's-varied', maxIterations: 6 });
    const run = store.listRuns({ botId: 'bot-w13' })[0]!;
    expect(run.loopDetected).toBe(false);
    expect(run.outcome).toBe('success');
  });
});
