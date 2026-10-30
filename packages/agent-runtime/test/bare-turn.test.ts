// SPDX-License-Identifier: Apache-2.0
// CA-21 (runtime half): RunTurnOptions.bare skips ALL auto-discovery
// for a turn — semantic skill auto-activation and memory/context
// injection — while explicit bot configuration keeps working.
// Zero paid API use: scripted MockProvider only.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/sessions.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, LLMProvider } from '../src/types.js';

class AllowGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(): Promise<{ decision: GovernanceDecision }> { return { decision: 'allow' }; }
  async awaitDecision(): Promise<'approved' | 'denied'> { return 'approved'; }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

class TestRuntime extends AgentRuntime {
  constructor(opts: ConstructorParameters<typeof AgentRuntime>[0], private readonly provider: LLMProvider) {
    super(opts);
  }
  protected override resolveProvider(): LLMProvider { return this.provider; }
}

let dir: string;
let skillsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-bare-'));
  skillsDir = join(dir, 'skills');
  const skillDir = join(skillsDir, 'blog-publisher');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: blog-publisher\ndescription: Publish a blog post to the company website with images and SEO metadata.\n---\n# Blog Publisher\n\nSteps for publishing.\n',
  );
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-bare', name: 'Bare Bot', description: 'test', systemPrompt: 'You are a test bot.',
    provider: 'mock', model: 'mock-model', skills: [], tools: [], mcpServers: [],
    autoActivateSkills: true, ...overrides,
  };
}

function makeRuntime(provider: MockProvider): TestRuntime {
  return new TestRuntime(
    { dbPath: ':memory:', skillsDir, governance: new AllowGateway(), toolRegistry: new Map(), defaultProviderId: 'mock' },
    provider,
  );
}

async function systemPromptOf(provider: MockProvider): Promise<string> {
  return provider.calls[0]!.messages.find((m) => m.role === 'system')?.content ?? '';
}

describe('RunTurnOptions.bare (CA-21)', () => {
  it('WITHOUT bare: skill auto-activation and memory context are discovered into the turn', async () => {
    const provider = new MockProvider([{ content: 'Published!' }]);
    const runtime = makeRuntime(provider);
    runtime.addContextProvider(() => 'CONTEXT-PROVIDER-BLOCK');
    await runtime.runTurn({
      bot: bot(),
      message: 'Please publish a blog post to the company website',
      memoryContext: 'MEMORY-CONTEXT-BLOCK',
      onEvent: () => undefined,
    });
    const system = await systemPromptOf(provider);
    expect(system).toContain('blog-publisher');
    expect(system).toContain('MEMORY-CONTEXT-BLOCK');
    expect(system).toContain('CONTEXT-PROVIDER-BLOCK');
    runtime.close();
  });

  it('WITH bare: NO skill auto-activation, NO memory/context injection — but the turn still runs', async () => {
    const provider = new MockProvider([{ content: 'Published!' }]);
    const runtime = makeRuntime(provider);
    runtime.addContextProvider(() => 'CONTEXT-PROVIDER-BLOCK');
    const usage = await runtime.runTurn({
      bot: bot(),
      message: 'Please publish a blog post to the company website',
      memoryContext: 'MEMORY-CONTEXT-BLOCK',
      bare: true,
      onEvent: () => undefined,
    });
    const system = await systemPromptOf(provider);
    expect(system).not.toContain('blog-publisher');
    expect(system).not.toContain('MEMORY-CONTEXT-BLOCK');
    expect(system).not.toContain('CONTEXT-PROVIDER-BLOCK');
    expect(usage.totalTokens).toBeGreaterThan(0);
    runtime.close();
  });

  it('WITH bare: explicitly configured bot skills still load (explicit config is not discovery)', async () => {
    const provider = new MockProvider([{ content: 'ok' }]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn({
      bot: bot({ skills: ['blog-publisher'] }),
      message: 'hello',
      bare: true,
      onEvent: () => undefined,
    });
    const system = await systemPromptOf(provider);
    expect(system).toContain('blog-publisher');
    runtime.close();
  });
});

describe('SessionStore project binding (CA-31)', () => {
  it('createSession stamps projectId; getSession/listSessions/setSessionProject round-trip it', () => {
    const store = new SessionStore(':memory:');
    const a = store.createSession('bot-1', { projectId: 'proj-a' });
    const b = store.createSession('bot-1');
    expect(store.getSession(a)?.projectId).toBe('proj-a');
    expect(store.getSession(b)?.projectId).toBeUndefined();
    expect(store.listSessions({ projectId: 'proj-a' }).map((s) => s.id)).toEqual([a]);
    expect(store.setSessionProject(b, 'proj-a')).toBe(true);
    expect(store.sessionProjectId(b)).toBe('proj-a');
    expect(store.listSessions({ projectId: 'proj-a' })).toHaveLength(2);
    expect(store.setSessionProject(b, null)).toBe(true);
    expect(store.sessionProjectId(b)).toBeUndefined();
    expect(store.setSessionProject('sess-missing', 'proj-a')).toBe(false);
    store.close();
  });
});
