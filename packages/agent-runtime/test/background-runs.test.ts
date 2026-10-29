// SPDX-License-Identifier: Apache-2.0
// Background specialist runs + ephemeral agents (Octomind parity):
// delegate in the background, result injected at the next turn.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { BackgroundRunRegistry, renderRunInjection } from '../src/background-runs.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, LLMProvider, ToolDefinition } from '../src/types.js';

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

/**
 * Provider that routes by system prompt: the ephemeral specialist's
 * prompt contains 'You research things.' — deterministic per-bot
 * scripts, safe under concurrent turns (a shared step cursor is not).
 */
class RoutingProvider implements LLMProvider {
  readonly providerId = 'mock';
  readonly calls: Array<{ script: string; messages: Array<{ role: string; content: unknown }> }> = [];
  private readonly cursors = new Map<string, number>();
  constructor(private readonly scripts: Record<string, Array<{ content?: string; toolCalls?: unknown[] }>>) {}

  async chat(
    messages: Array<{ role: string; content: unknown }>,
    _tools: unknown,
    opts: { onToken?: (t: string) => void },
  ): Promise<{ content: string; toolCalls: unknown[]; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    const script = system.includes('You research things.') ? 'specialist' : 'main';
    const steps = this.scripts[script]!;
    const idx = Math.min(this.cursors.get(script) ?? 0, steps.length - 1);
    this.cursors.set(script, idx + 1);
    this.calls.push({ script, messages });
    const step = steps[idx]!;
    const content = step.content ?? '';
    if (opts.onToken && content) {
      for (const word of content.split(/(\s+)/)) if (word) opts.onToken(word);
    }
    return {
      content,
      toolCalls: (step.toolCalls ?? []) as never[],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: 'mock-model', name: 'Mock' }];
  }
}

const bot: BotConfig = {
  id: 'bot-main',
  name: 'Main Bot',
  description: 'test',
  systemPrompt: 'You are the main bot.',
  provider: 'mock',
  model: 'mock-model',
  skills: [],
  tools: ['delegate_background'],
  mcpServers: [],
};

function registryOf(runtime: AgentRuntime): Map<string, ToolDefinition> {
  return (runtime as unknown as { toolRegistry: Map<string, ToolDefinition> }).toolRegistry;
}

function makeRuntime(provider: LLMProvider): AgentRuntime {
  const runtime = new TestRuntime(
    {
      dbPath: ':memory:',
      skillsDir: '/tmp/agent-runtime-test-skills-missing',
      governance: new AllowGateway(),
      toolRegistry: new Map(),
      defaultProviderId: 'mock',
    },
    provider,
  );
  for (const t of runtime.createBackgroundTools()) registryOf(runtime).set(t.name, t);
  return runtime;
}

async function waitForStatus(
  runtime: AgentRuntime,
  sessionId: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const runs = runtime.listBackgroundRuns(sessionId);
    if (runs.length > 0 && runs.every((r) => r.status !== 'running')) return;
    if (Date.now() - start > timeoutMs) throw new Error('background run did not finish');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('background specialist runs', () => {
  it('runs an ephemeral specialist and injects its result at the next turn', async () => {
    const provider = new RoutingProvider({
      main: [
        { toolCalls: [{ id: 'c1', name: 'delegate_background', args: {
          task: 'Research the history of the fork.',
          ephemeralName: 'Researcher',
          ephemeralPrompt: 'You research things.',
        } }] },
        { content: 'Delegated; continuing with other work.' },
        { content: 'The fork dates to 1987, per the research.' },
      ],
      specialist: [{ content: 'FINDINGS: the fork dates to 1987.' }],
    });
    const runtime = makeRuntime(provider);
    const sessionId = 's-bg-1';
    const tokens1: string[] = [];
    await runtime.runTurn({
      bot,
      message: 'look into the fork',
      sessionId,
      onEvent: (e) => {
        if (e.type === 'token') tokens1.push(e.content);
      },
    });
    expect(tokens1.join('')).toContain('continuing with other work');

    await waitForStatus(runtime, sessionId);
    const runs = runtime.listBackgroundRuns(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'done', ephemeral: true, botName: 'Researcher' });

    // Second turn: the injection reaches the model as a user note.
    await runtime.runTurn({ bot, message: 'so what did we learn?', sessionId, onEvent: () => {} });
    const mainCalls = provider.calls.filter((c) => c.script === 'main');
    const turn2Messages = mainCalls[mainCalls.length - 1]!.messages;
    const injected = turn2Messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('Background run'),
    );
    expect(injected?.content).toContain('FINDINGS: the fork dates to 1987.');
    // Injection happens exactly once: drain again returns nothing new.
    expect(runtime.backgroundRuns.drainInjectable(sessionId)).toEqual([]);
  });

  it('reports an error for an unresolvable roster bot and for a missing definition', async () => {
    const provider = new RoutingProvider({ main: [{ content: 'ok' }], specialist: [] });
    const runtime = makeRuntime(provider);
    const bad1 = runtime.startBackgroundRun({
      originBot: bot,
      originSessionId: 's-x',
      task: 't',
      specialistBotId: 'ghost',
    });
    expect('error' in bad1 && bad1.error).toContain('ghost');
    const bad2 = runtime.startBackgroundRun({ originBot: bot, originSessionId: 's-x', task: 't' });
    expect('error' in bad2).toBe(true);
  });

  it('stop aborts a running run', async () => {
    const registry = new BackgroundRunRegistry();
    const { record, signal } = registry.start({
      botId: 'b',
      botName: 'B',
      ephemeral: true,
      originBotId: 'o',
      originSessionId: 's',
      task: 'long task',
    });
    expect(signal.aborted).toBe(false);
    expect(registry.stop(record.id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(registry.get(record.id)?.status).toBe('stopped');
    expect(registry.stop(record.id)).toBe(false);
    // A stopped run still injects (as a stopped note) exactly once.
    const drained = registry.drainInjectable('s');
    expect(drained).toHaveLength(1);
    expect(renderRunInjection(drained[0]!)).toContain('was stopped');
    expect(registry.drainInjectable('s')).toEqual([]);
  });
});
