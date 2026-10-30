// SPDX-License-Identifier: Apache-2.0
// Closure ADD-4: autonomous execution-loop policy — unit tests for the
// policy/ledger (scope resolution, material-change rule, attempt bound,
// escalation classes, trail rendering) plus runtime integration tests
// (identical retry blocked, changed-approach retry allowed, attempt
// bound escalation, approval bypass, verify-gate re-entry, ledger →
// run record). Zero paid APIs — scripted mock providers + fake tools.

import { describe, expect, it } from 'vitest';
import {
  AttemptLedger,
  classifyToolFailure,
  hashToolArgs,
  isNonTrivialAttemptTrail,
  renderAttemptTrail,
  resolveExecutionPolicy,
  type ExecutionPolicy,
} from '../src/execution-policy.js';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { SpanStore } from '../src/spans.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolDefinition } from '../src/types.js';

const policy = (over: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  enabled: true,
  maxAttemptsPerStep: 3,
  verifyBeforeDone: true,
  scope: 'universal',
  ...over,
});

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

describe('resolveExecutionPolicy scope', () => {
  it('defaults ON for universal and chief turns, OFF elsewhere', () => {
    expect(resolveExecutionPolicy({ universal: true })).toMatchObject({ enabled: true, scope: 'universal' });
    expect(resolveExecutionPolicy({ chief: true })).toMatchObject({ enabled: true, scope: 'chief' });
    expect(resolveExecutionPolicy({})).toMatchObject({ enabled: false, scope: 'off' });
  });

  it('bot opt-out wins over the scope default; bot opt-in enables anywhere', () => {
    expect(resolveExecutionPolicy({ universal: true, botConfig: { enabled: false } })).toMatchObject({
      enabled: false,
      scope: 'bot-opt-out',
    });
    expect(resolveExecutionPolicy({ botConfig: { enabled: true } })).toMatchObject({
      enabled: true,
      scope: 'bot-opt-in',
    });
  });

  it('per-turn config wins over bot config; false disables', () => {
    expect(
      resolveExecutionPolicy({ botConfig: { enabled: true }, perTurn: false }).enabled,
    ).toBe(false);
    expect(
      resolveExecutionPolicy({ botConfig: { enabled: false }, perTurn: { enabled: true } }).enabled,
    ).toBe(true);
  });

  it('attempt bound is configurable and clamped', () => {
    expect(resolveExecutionPolicy({ universal: true }).maxAttemptsPerStep).toBe(3);
    expect(resolveExecutionPolicy({ universal: true, botConfig: { maxAttemptsPerStep: 2 } }).maxAttemptsPerStep).toBe(2);
    expect(resolveExecutionPolicy({ universal: true, botConfig: { maxAttemptsPerStep: 0 } }).maxAttemptsPerStep).toBe(1);
    expect(resolveExecutionPolicy({ universal: true, perTurn: { maxAttemptsPerStep: 99 } }).maxAttemptsPerStep).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe('classifyToolFailure', () => {
  it('ordinary errors count; denials and credential errors escalate', () => {
    expect(classifyToolFailure({ error: 'connection refused' })).toBe('ordinary');
    expect(classifyToolFailure({ error: 'Missing credential: GITHUB_TOKEN not configured' })).toBe('credential');
    expect(classifyToolFailure({ error: '401 Unauthorized' })).toBe('credential');
    expect(classifyToolFailure({ denied: true, reason: 'catastrophic command' })).toBe('governance-deny');
    expect(classifyToolFailure({ denied: true, reason: 'approval denied by user' })).toBe('approval');
    expect(classifyToolFailure({ ok: true })).toBeNull();
    expect(classifyToolFailure('a string')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ledger: material change, bound, escalation classes
// ---------------------------------------------------------------------------

describe('AttemptLedger material-change rule', () => {
  it('blocks an identical retry after a failure; allows changed args', () => {
    const ledger = new AttemptLedger(policy());
    const call = { tool: 'lookup', args: { q: 'a' } };
    expect(ledger.beforeAttempt('lookup', call)).toMatchObject({ allowed: true, change: 'initial' });
    ledger.afterAttempt('lookup', call, { change: 'initial', ok: false, failure: 'boom', ctx: {} });

    const blocked = ledger.beforeAttempt('lookup', call);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.kind).toBe('identical-retry');

    const changed = ledger.beforeAttempt('lookup', { tool: 'lookup', args: { q: 'b' } });
    expect(changed).toMatchObject({ allowed: true, change: 'args' });
  });

  it('a model or plan change also counts as material', () => {
    const ledger = new AttemptLedger(policy());
    const call = { tool: 'lookup', args: { q: 'a' } };
    ledger.afterAttempt('lookup', call, {
      change: 'initial', ok: false, failure: 'boom', ctx: { model: 'p/m1', planRevision: 0 },
    });
    expect(ledger.beforeAttempt('lookup', call, { model: 'p/m2', planRevision: 0 })).toMatchObject({
      allowed: true, change: 'model',
    });
    expect(ledger.beforeAttempt('lookup', call, { model: 'p/m1', planRevision: 1 })).toMatchObject({
      allowed: true, change: 'plan',
    });
  });

  it('a success resets the step (same call is a fresh attempt again)', () => {
    const ledger = new AttemptLedger(policy());
    const call = { tool: 'lookup', args: { q: 'a' } };
    ledger.afterAttempt('lookup', call, { change: 'initial', ok: false, failure: 'boom', ctx: {} });
    ledger.afterAttempt('lookup', call, { change: 'args', ok: true, ctx: {} });
    expect(ledger.failuresForStep('lookup')).toBe(0);
    expect(ledger.beforeAttempt('lookup', call)).toMatchObject({ allowed: true, change: 'initial' });
  });

  it('hashToolArgs is order-insensitive and value-sensitive', () => {
    expect(hashToolArgs({ a: 1, b: 2 })).toBe(hashToolArgs({ b: 2, a: 1 }));
    expect(hashToolArgs({ a: 1 })).not.toBe(hashToolArgs({ a: 2 }));
  });
});

describe('AttemptLedger attempt bound + escalation', () => {
  it('escalates at the bound with a per-attempt summary', () => {
    const ledger = new AttemptLedger(policy({ maxAttemptsPerStep: 2 }));
    const c1 = { tool: 'lookup', args: { q: 'a' } };
    const c2 = { tool: 'lookup', args: { q: 'b' } };
    ledger.afterAttempt('lookup', c1, { change: 'initial', ok: false, failure: 'first boom', ctx: {} });
    ledger.afterAttempt('lookup', c2, { change: 'args', ok: false, failure: 'second boom', ctx: {} });
    const decision = ledger.beforeAttempt('lookup', { tool: 'lookup', args: { q: 'c' } });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed && decision.kind === 'attempt-bound') {
      expect(decision.summary).toContain('Attempt 1');
      expect(decision.summary).toContain('first boom');
      expect(decision.summary).toContain('Attempt 2');
      expect(decision.summary).toContain('second boom');
      expect(decision.summary).toContain('changed: args');
    } else {
      throw new Error('expected attempt-bound decision');
    }
  });

  it('approval / credential / governance-deny failures are NOT counted as attempts', () => {
    const ledger = new AttemptLedger(policy({ maxAttemptsPerStep: 1 }));
    const call = { tool: 'send', args: { to: 'x' } };
    const e1 = ledger.afterAttempt('send', call, {
      change: 'initial', ok: false, failure: 'approval denied', failureClass: 'approval', ctx: {},
    });
    expect(e1.outcome).toBe('escalated');
    const e2 = ledger.afterAttempt('send', call, {
      change: 'initial', ok: false, failure: 'missing credential', failureClass: 'credential', ctx: {},
    });
    expect(e2.outcome).toBe('escalated');
    ledger.noteEscalation('send', { failure: 'denied by governance policy', failureClass: 'governance-deny' });
    // Bound is 1, yet nothing counted — the next ordinary attempt is fresh.
    expect(ledger.failuresForStep('send')).toBe(0);
    expect(ledger.isExhausted('send')).toBe(false);
    expect(ledger.beforeAttempt('send', call)).toMatchObject({ allowed: true, change: 'initial' });
  });
});

describe('trail rendering', () => {
  it('trivial trails render null; non-trivial render Pro lines and a Simple sentence', () => {
    const ledger = new AttemptLedger(policy());
    const call = { tool: 'lookup', args: { q: 'a' } };
    ledger.afterAttempt('lookup', call, { change: 'initial', ok: true, ctx: {} });
    expect(isNonTrivialAttemptTrail(ledger.allEntries)).toBe(false);
    expect(renderAttemptTrail(ledger.allEntries, 'pro')).toBeNull();

    ledger.afterAttempt('fetch', { tool: 'fetch', args: {} }, { change: 'initial', ok: false, failure: 'boom', ctx: {} });
    ledger.afterAttempt('fetch', { tool: 'fetch', args: { u: 'x' } }, { change: 'args', ok: true, ctx: {} });
    const pro = renderAttemptTrail(ledger.allEntries, 'pro');
    expect(pro).toContain('What it took:');
    expect(pro).toContain('fetch · attempt 2 · changed the arguments · succeeded');
    const simple = renderAttemptTrail(ledger.allEntries, 'simple');
    expect(simple).toContain('across 2 steps');
    expect(simple).toContain('to get this done.');
    expect(simple!.split('\n')).toHaveLength(1);
  });

  it('serializes into the run-record attempts shape', () => {
    const ledger = new AttemptLedger(policy());
    ledger.afterAttempt('lookup', { tool: 'lookup', args: { q: 'a' } }, {
      change: 'initial', ok: false, failure: 'boom', ctx: {},
    });
    expect(ledger.toRunRecordAttempts()).toEqual([
      { step: 'lookup', attempt: 1, change: 'initial', action: 'lookup(q)', failure: 'boom', outcome: 'failed' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Runtime integration
// ---------------------------------------------------------------------------

class FakeGateway implements GovernanceGateway {
  decision: GovernanceDecision = 'allow';
  approvalOutcome: 'approved' | 'denied' = 'approved';
  async classify(): Promise<GovernanceDecision> {
    return this.decision;
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: this.decision };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return this.approvalOutcome;
  }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

function makeRuntime(
  gateway: FakeGateway,
  tools: ToolDefinition[],
  provider: MockProvider,
  extra: Record<string, unknown> = {},
): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected override resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: gateway,
    toolRegistry: new Map(tools.map((t) => [t.name, t])),
    defaultProviderId: 'mock',
    ...extra,
  } as never);
}

function testBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-chief',
    name: 'Chief',
    description: 'test',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: [],
    mcpServers: [],
    chiefOfStaff: true,
    ...overrides,
  };
}

async function runTurn(
  runtime: AgentRuntime,
  bot: BotConfig,
  opts: Record<string, unknown> = {},
): Promise<{ events: StreamEvent[]; answer: string }> {
  const events: StreamEvent[] = [];
  await runtime.runTurn({
    bot,
    message: 'do the thing',
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    onEvent: (e) => events.push(e),
    ...opts,
  } as never);
  const answer = events
    .filter((e): e is Extract<StreamEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.content)
    .join('');
  return { events, answer };
}

const flakyTool = (failuresBeforeSuccess: number): { tool: ToolDefinition; calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    tool: {
      name: 'flaky_lookup',
      description: 'Fails a set number of times, then succeeds.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      handler: async () => {
        calls += 1;
        if (calls <= failuresBeforeSuccess) return { error: `lookup failed (call ${calls})` };
        return { found: true };
      },
    },
  };
};

describe('runtime execution policy (chief-led turn)', () => {
  it('blocks an identical retry; the tool handler runs only once', async () => {
    const gateway = new FakeGateway();
    const flaky = flakyTool(99);
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky_lookup', args: { q: 'a' } }] },
      { toolCalls: [{ id: 'c2', name: 'flaky_lookup', args: { q: 'a' } }] }, // identical repeat
      { content: 'Giving up on that lookup.' },
    ]);
    const runtime = makeRuntime(gateway, [flaky.tool], provider);
    const { events, answer } = await runTurn(runtime, testBot({ tools: ['flaky_lookup'] }));
    expect(flaky.calls()).toBe(1);
    const blocked = events.find(
      (e) => e.type === 'tool_result' && (e.result as { blockedByExecutionPolicy?: boolean })?.blockedByExecutionPolicy === true,
    );
    expect(blocked).toBeTruthy();
    // The model saw the block instruction in the tool result.
    const seenByModel = provider.calls[2]!.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('Blocked an identical retry'),
    );
    expect(seenByModel).toBe(true);
    expect(answer).toContain('Giving up');
    runtime.close();
  });

  it('allows a changed-approach retry (different args) through to the handler', async () => {
    const gateway = new FakeGateway();
    const flaky = flakyTool(1);
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky_lookup', args: { q: 'a' } }] },
      { toolCalls: [{ id: 'c2', name: 'flaky_lookup', args: { q: 'b' } }] },
      { content: 'Found it.' },
    ]);
    const runtime = makeRuntime(gateway, [flaky.tool], provider);
    const { answer } = await runTurn(runtime, testBot({ tools: ['flaky_lookup'] }));
    expect(flaky.calls()).toBe(2);
    expect(answer).toContain('Found it.');
    runtime.close();
  });

  it('does not apply the policy to a non-chief, non-universal bot by default', async () => {
    const gateway = new FakeGateway();
    const flaky = flakyTool(99);
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky_lookup', args: { q: 'a' } }] },
      { toolCalls: [{ id: 'c2', name: 'flaky_lookup', args: { q: 'a' } }] },
      { content: 'ok' },
    ]);
    const runtime = makeRuntime(gateway, [flaky.tool], provider);
    await runTurn(runtime, testBot({ tools: ['flaky_lookup'], chiefOfStaff: false }));
    expect(flaky.calls()).toBe(2); // identical repeat executed — policy off
    runtime.close();
  });

  it('escalates with a structured summary when the attempt bound is hit', async () => {
    const gateway = new FakeGateway();
    const flaky = flakyTool(99);
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky_lookup', args: { q: 'a' } }] },
      { toolCalls: [{ id: 'c2', name: 'flaky_lookup', args: { q: 'b' } }] },
      { toolCalls: [{ id: 'c3', name: 'flaky_lookup', args: { q: 'c' } }] },
      { content: 'should never be reached' },
    ]);
    const runtime = makeRuntime(gateway, [flaky.tool], provider);
    const { events, answer } = await runTurn(
      runtime,
      testBot({ tools: ['flaky_lookup'], executionPolicy: { maxAttemptsPerStep: 2 } }),
    );
    expect(flaky.calls()).toBe(2);
    expect(answer).toContain('escalating to you');
    expect(answer).toContain('Attempt 1');
    expect(answer).toContain('Attempt 2');
    expect(answer).toContain('lookup failed (call 1)');
    expect(answer).not.toContain('should never be reached');
    expect(events.some((e) => e.type === 'notice' && e.kind === 'execution-policy-escalation')).toBe(true);
    runtime.close();
  });

  it('approval-denied bypasses the loop at once and is not counted as an attempt', async () => {
    const gateway = new FakeGateway();
    gateway.decision = 'require-approval';
    gateway.approvalOutcome = 'denied';
    const flaky = flakyTool(0);
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky_lookup', args: { q: 'a' } }] },
      // With maxAttemptsPerStep 1, a counted failure would exhaust the
      // step; the model instead retries identically and the approval
      // flow (not the policy) decides again — proving no counting.
      { toolCalls: [{ id: 'c2', name: 'flaky_lookup', args: { q: 'a' } }] },
      { content: 'Understood, stopped.' },
    ]);
    const runtime = makeRuntime(gateway, [flaky.tool], provider);
    const { events, answer } = await runTurn(
      runtime,
      testBot({ tools: ['flaky_lookup'], executionPolicy: { maxAttemptsPerStep: 1 } }),
    );
    expect(flaky.calls()).toBe(0); // never approved, never executed
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(2);
    expect(answer).toContain('Understood, stopped.');
    runtime.close();
  });

  it('a governance DENY is final: an identical call is re-denied by governance, never policy-blocked or executed', async () => {
    const gateway = new FakeGateway();
    gateway.decision = 'deny';
    const flaky = flakyTool(0);
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky_lookup', args: { q: 'a' } }] },
      { toolCalls: [{ id: 'c2', name: 'flaky_lookup', args: { q: 'a' } }] },
      { content: 'It is denied.' },
    ]);
    const runtime = makeRuntime(gateway, [flaky.tool], provider);
    const { events, answer } = await runTurn(runtime, testBot({ tools: ['flaky_lookup'] }));
    expect(flaky.calls()).toBe(0);
    const deniedResults = events.filter((e) => e.type === 'tool_result' && e.denied === true);
    expect(deniedResults).toHaveLength(2);
    expect(answer).toContain('It is denied.');
    runtime.close();
  });

  it('verify-fail re-enters the loop: policy engages the gate for a chief turn and the retry succeeds', async () => {
    const gateway = new FakeGateway();
    const deploy: ToolDefinition = {
      name: 'deploy',
      description: 'Deploy.',
      parameters: { type: 'object', properties: {} },
      mutating: true,
      handler: async () => ({ deployed: true, log: 'service healthy on port 8080' }),
    };
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy', args: {} }] },
      { content: 'Deployment complete!' },
      { content: '{"verdict": "reject", "reason": "no output quoted", "guidance": "Quote the deploy log line."}' },
      { content: 'Deployed — log: service healthy on port 8080.' },
      { content: '{"verdict": "accept", "reason": "evidence quoted"}' },
    ]);
    const runtime = makeRuntime(gateway, [deploy], provider, {
      modelProfiles: { supervisor: { modelId: 'mock-model' } },
    });
    // NOTE: bot does NOT set supervisorVerifyGate — the policy's
    // verifyBeforeDone engages the gate for this chief-led turn.
    const { events, answer } = await runTurn(runtime, testBot({ tools: ['deploy'] }));
    expect(answer).toContain('service healthy on port 8080');
    expect(events.some((e) => e.type === 'notice' && e.kind === 'supervisor-gate')).toBe(true);
    expect(events.some((e) => e.type === 'notice' && e.kind === 'what-it-took')).toBe(true);
    runtime.close();
  });

  it('serializes the ledger into the observability run record attempts array', async () => {
    const gateway = new FakeGateway();
    const flaky = flakyTool(1);
    const spanStore = new SpanStore(':memory:');
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky_lookup', args: { q: 'a' } }] },
      { toolCalls: [{ id: 'c2', name: 'flaky_lookup', args: { q: 'b' } }] },
      { content: 'Found it.' },
    ]);
    const runtime = makeRuntime(gateway, [flaky.tool], provider, { spanStore });
    const { events } = await runTurn(runtime, testBot({ tools: ['flaky_lookup'] }));
    const runs = spanStore.listRuns({ botId: 'bot-chief' });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.attempts).toEqual([
      { step: 'flaky_lookup', attempt: 1, change: 'initial', action: 'flaky_lookup(q)', failure: 'lookup failed (call 1)', outcome: 'failed' },
      { step: 'flaky_lookup', attempt: 2, change: 'args', action: 'flaky_lookup(q)', outcome: 'succeeded' },
    ]);
    // Non-trivial turn → the "what it took" trail was emitted.
    const trail = events.find((e) => e.type === 'notice' && e.kind === 'what-it-took');
    expect(trail).toBeTruthy();
    if (trail && trail.type === 'notice') {
      expect(trail.message).toContain('flaky_lookup · attempt 2 · changed the arguments · succeeded');
    }
    runtime.close();
    spanStore.close();
  });
});
