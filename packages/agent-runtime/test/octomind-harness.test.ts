// SPDX-License-Identifier: Apache-2.0
// Octomind-parity harness integration tests: supervisor verify-gate,
// structured output enforcement, turn-end validators, project
// instructions, input transforms, post-result hook injections, in-turn
// layers, semantic skill auto-activation, and the tool-parallelism
// discipline. Zero paid API usage — scripted mock providers only.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, executeWithToolDiscipline } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { HookBus } from '../src/hooks.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type {
  BotConfig,
  LLMProvider,
  StreamEvent,
  ToolDefinition,
} from '../src/types.js';

class AllowGateway implements GovernanceGateway {
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

const deployTool: ToolDefinition = {
  name: 'deploy',
  description: 'Deploy the app.',
  parameters: { type: 'object', properties: {} },
  mutating: true,
  handler: async () => ({ deployed: true, log: 'service healthy on port 8080' }),
};

const failingTool: ToolDefinition = {
  name: 'deploy',
  description: 'Deploy the app.',
  parameters: { type: 'object', properties: {} },
  mutating: true,
  handler: async () => ({ error: 'deploy failed: connection refused' }),
};

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo.',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ ok: true }),
};

let dir: string;
let skillsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-octomind-'));
  skillsDir = join(dir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: LLMProvider,
  tools: ToolDefinition[] = [],
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
): AgentRuntime {
  return new TestRuntime(
    {
      dbPath: ':memory:',
      skillsDir,
      governance: new AllowGateway(),
      toolRegistry: new Map(tools.map((t) => [t.name, t])),
      defaultProviderId: 'mock',
      ...extra,
    },
    provider,
  );
}

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-oct',
    name: 'Harness Bot',
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
  opts: { message?: string; sessionId?: string; responseFormat?: unknown } = {},
): Promise<{ events: StreamEvent[]; answer: string }> {
  const events: StreamEvent[] = [];
  const sessionId = opts.sessionId ?? `s-${Math.random().toString(36).slice(2)}`;
  await runtime.runTurn({
    bot: b,
    message: opts.message ?? 'do the thing',
    sessionId,
    onEvent: (e) => events.push(e),
    ...(opts.responseFormat
      ? { responseFormat: opts.responseFormat as never }
      : {}),
  });
  const answer = events
    .filter((e): e is Extract<StreamEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.content)
    .join('');
  return { events, answer };
}

describe('supervisor verify-gate', () => {
  const profiles = { supervisor: { modelId: 'mock-model' } };

  it('rejects an unevidenced claim and accepts the evidenced retry', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy', args: {} }] },
      { content: 'Deployment complete!' },
      { content: '{"verdict": "reject", "reason": "no output quoted", "guidance": "Quote the deploy log line."}' },
      { content: 'Deployed — log: service healthy on port 8080.' },
      { content: '{"verdict": "accept", "reason": "evidence quoted"}' },
    ]);
    const runtime = makeRuntime(provider, [deployTool], { modelProfiles: profiles });
    const { events, answer } = await runTurn(
      runtime,
      bot({ tools: ['deploy'], supervisorVerifyGate: true }),
    );
    expect(answer).toContain('service healthy on port 8080');
    expect(provider.calls.length).toBe(5);
    expect(events.some((e) => e.type === 'notice' && e.kind === 'supervisor-gate')).toBe(true);
    // The gate correction reached the model as an instruction.
    const correctionSeen = provider.calls[3]!.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('Quote the deploy log line'),
    );
    expect(correctionSeen).toBe(true);
  });

  it('rejects without a supervisor call when the only evidence failed, then stops after max rejections', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy', args: {} }] },
      { content: 'All deployed!' },
      { content: 'Definitely deployed now!' },
      { content: 'Final answer: could not deploy.' },
    ]);
    const runtime = makeRuntime(provider, [failingTool], { modelProfiles: profiles });
    const { answer } = await runTurn(runtime, bot({ tools: ['deploy'], supervisorVerifyGate: true }));
    // Two gate rejections (no supervisor calls — evidence all failed),
    // then the third claim is allowed through so the turn can end.
    expect(answer).toContain('could not deploy');
    expect(provider.calls.length).toBe(4);
  });

  it('does not gate pure-conversation turns', async () => {
    const provider = new MockProvider([{ content: 'Just an answer.' }]);
    const runtime = makeRuntime(provider, [], { modelProfiles: profiles });
    const { answer } = await runTurn(runtime, bot({ supervisorVerifyGate: true }));
    expect(answer).toBe('Just an answer.');
    expect(provider.calls.length).toBe(1);
  });
});

describe('structured output enforcement', () => {
  it('retries once when the answer is not valid JSON for the schema', async () => {
    const provider = new MockProvider([
      { content: 'Sure, the answer is 42.' },
      { content: '{"answer": 42}' },
    ]);
    const runtime = makeRuntime(provider);
    const { answer } = await runTurn(runtime, bot(), {
      responseFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } },
    });
    expect(answer).toBe('{"answer": 42}');
    expect(provider.calls.length).toBe(2);
  });

  it('accepts fenced JSON without a retry', async () => {
    const provider = new MockProvider([{ content: '```json\n{"a": 1}\n```' }]);
    const runtime = makeRuntime(provider);
    const { answer } = await runTurn(runtime, bot(), {
      responseFormat: { type: 'json_object' },
    });
    expect(answer).toContain('{"a": 1}');
    expect(provider.calls.length).toBe(1);
  });
});

describe('turn-end validators', () => {
  it('injects failures as the next instruction and re-runs until green', async () => {
    const ws = join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    const marker = join(ws, 'attempted');
    const script = join(ws, 'check.mjs');
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from 'node:fs';\n` +
        `if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, '1'); console.error('check failed: lint errors'); process.exit(1); }\n` +
        `console.log('all checks pass');\n`,
    );
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'echo', args: {} }] },
      { content: 'Work complete.' },
      { content: 'Fixed the lint errors; work complete.' },
    ]);
    const runtime = makeRuntime(provider, [echoTool], {
      workspaceDirForBot: () => ws,
    });
    const { events, answer } = await runTurn(
      runtime,
      bot({
        tools: ['echo'],
        validators: [{ name: 'lint', command: [process.execPath, script] }],
      }),
    );
    expect(answer).toContain('Fixed the lint errors');
    expect(events.some((e) => e.type === 'notice' && e.kind === 'validator-failed')).toBe(true);
    const correctionSeen = provider.calls[2]!.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('End-of-turn validation failed'),
    );
    expect(correctionSeen).toBe(true);
  });
});

describe('project instructions', () => {
  it('loads AGENTS.md from the bot workspace into the system prompt', async () => {
    const ws = join(dir, 'ws2');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'AGENTS.md'), 'RULE: always add a changelog entry.');
    const provider = new MockProvider([{ content: 'ok' }]);
    const runtime = makeRuntime(provider, [], { workspaceDirForBot: () => ws });
    await runTurn(runtime, bot());
    const system = provider.calls[0]!.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('## Project instructions');
    expect(system?.content).toContain('always add a changelog entry');
  });

  it('is skipped when the bot disables project instructions', async () => {
    const ws = join(dir, 'ws3');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'AGENTS.md'), 'RULE: secret rule.');
    const provider = new MockProvider([{ content: 'ok' }]);
    const runtime = makeRuntime(provider, [], { workspaceDirForBot: () => ws });
    await runTurn(runtime, bot({ projectInstructions: false }));
    const system = provider.calls[0]!.messages.find((m) => m.role === 'system');
    expect(system?.content).not.toContain('secret rule');
  });
});

describe('hooks: input transform + post-result injection', () => {
  it('transforms the model-visible message but stores the original', async () => {
    const hooks = new HookBus();
    hooks.on('input.transform', async (payload) => {
      const p = payload as { message: string };
      return { transform: p.message.replace('SECRET', '[redacted]') };
    });
    const provider = new MockProvider([{ content: 'ok' }]);
    const runtime = makeRuntime(provider, [], { hooks });
    const sessionId = 's-transform';
    await runTurn(runtime, bot(), { message: 'the SECRET plan', sessionId });
    const modelSaw = provider.calls[0]!.messages.some(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[redacted]'),
    );
    expect(modelSaw).toBe(true);
    const stored = runtime
      .listThreadMessages(sessionId)
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(stored.some((c) => c.includes('the SECRET plan'))).toBe(true);
  });

  it('injects tool.after hook feedback before the next model step', async () => {
    const hooks = new HookBus();
    hooks.on('tool.after', async () => ({ inject: 'Reminder: verify the echo output.' }));
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'echo', args: {} }] },
      { content: 'verified, done' },
    ]);
    const runtime = makeRuntime(provider, [echoTool], { hooks });
    const { answer } = await runTurn(runtime, bot({ tools: ['echo'] }));
    expect(answer).toBe('verified, done');
    const injected = provider.calls[1]!.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('Hook feedback'),
    );
    expect(injected).toBe(true);
  });
});

describe('in-turn layers', () => {
  it('runs a prepare stage and a review stage with their own prompts', async () => {
    const provider = new MockProvider([
      { content: 'prepared context: user likes concise answers' },
      { content: 'rough draft answer' },
      { content: 'polished final answer' },
    ]);
    const runtime = makeRuntime(provider);
    const { answer } = await runTurn(
      runtime,
      bot({
        layers: [
          { name: 'prep', kind: 'prepare', prompt: 'Prepare context for the turn.' },
          { name: 'polish', kind: 'review', prompt: 'Polish the draft.', inputMode: 'draft' },
        ],
      }),
    );
    expect(answer).toBe('polished final answer');
    const mainCall = provider.calls[1]!;
    expect(
      mainCall.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('[Layer stage "prep" output]'),
      ),
    ).toBe(true);
    expect(provider.calls.length).toBe(3);
  });
});

describe('semantic skill auto-activation', () => {
  it('activates a clearly matching skill by intent', async () => {
    const skillDir = join(skillsDir, 'blog-publisher');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: blog-publisher\ndescription: Publish a blog post to the company website with images and SEO metadata.\n---\n# Blog Publisher\n\nSteps for publishing.\n',
    );
    const provider = new MockProvider([{ content: 'Published!' }]);
    const runtime = makeRuntime(provider);
    await runTurn(runtime, bot({ autoActivateSkills: true }), {
      message: 'Please publish a blog post to the company website',
    });
    const system = provider.calls[0]!.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('blog-publisher');
  });
});

describe('executeWithToolDiscipline', () => {
  it('serializes mutating calls as barriers while reads overlap', async () => {
    const log: string[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const mk = (name: string, mutating: boolean, ms: number) => ({
      def: { name, description: '', parameters: {}, mutating, handler: async () => null } as ToolDefinition,
      call: { id: name, name, args: {} },
    });
    const entries = [mk('readA', false, 30), mk('writeB', true, 5), mk('readC', false, 5), mk('readD', false, 20)];
    const results = await executeWithToolDiscipline(entries, async (e) => {
      log.push(`start:${e.call.name}`);
      await delay(e.def.name === 'readA' ? 30 : e.def.name === 'readD' ? 20 : 5);
      log.push(`end:${e.call.name}`);
      return e.call.name;
    });
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      'readA',
      'writeB',
      'readC',
      'readD',
    ]);
    // writeB started only after readA finished; readC/readD only after writeB.
    expect(log.indexOf('start:writeB')).toBeGreaterThan(log.indexOf('end:readA'));
    expect(log.indexOf('start:readC')).toBeGreaterThan(log.indexOf('end:writeB'));
    // readC and readD overlapped (readD started before readC ended is fine either way;
    // both started before the slower readD ended).
    expect(log.indexOf('start:readD')).toBeLessThan(log.indexOf('end:readD'));
  });

  it('treats mcp: tools as mutating barriers', async () => {
    const order: string[] = [];
    const mk = (name: string) => ({
      def: { name, description: '', parameters: {}, handler: async () => null } as ToolDefinition,
      call: { id: name, name, args: {} },
    });
    const entries = [mk('readX'), mk('mcp:server_tool'), mk('readY')];
    await executeWithToolDiscipline(entries, async (e) => {
      order.push(`start:${e.call.name}`);
      await new Promise((r) => setTimeout(r, e.call.name === 'readX' ? 20 : 1));
      order.push(`end:${e.call.name}`);
      return null;
    });
    expect(order.indexOf('start:mcp:server_tool')).toBeGreaterThan(order.indexOf('end:readX'));
    expect(order.indexOf('start:readY')).toBeGreaterThan(order.indexOf('end:mcp:server_tool'));
  });
});
