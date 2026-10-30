// SPDX-License-Identifier: Apache-2.0
// CA-1/CA-5 integration tests: lifecycle event emission at the real
// call sites (SessionStore, AgentRuntime governance/tool paths,
// delegate + background spawns) and worktree isolation spawns.
// Zero paid APIs: MockProvider, stub tools, throwaway git repos.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus } from '../src/hooks.js';
import { SessionStore } from '../src/sessions.js';
import { AgentRuntime } from '../src/runtime.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, LLMProvider, ToolDefinition } from '../src/types.js';
import { MockProvider } from '../src/providers/mock.js';
import { createDelegateTools } from '../src/tools/delegate.js';
import { SubagentStore } from '../src/subagent-store.js';
import type { SubagentSpawnFn, SubagentSpawnInput } from '../src/subagents.js';
import { parseAgentDefinition, type AgentDefinition } from '../src/agent-definitions.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(base: string): string {
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'init');
  return repo;
}

// ---------------------------------------------------------------------------
// SessionStore: session.start / session.end / compact.before / compact.after
// ---------------------------------------------------------------------------

describe('SessionStore hook emission', () => {
  it('emits session.start on create and session.end on delete', async () => {
    const bus = new HookBus();
    const seen: Array<{ event: string; sessionId: string }> = [];
    bus.on('session.start', (p) => { seen.push({ event: 'start', sessionId: (p as { sessionId: string }).sessionId }); });
    bus.on('session.end', (p) => { seen.push({ event: 'end', sessionId: (p as { sessionId: string }).sessionId }); });
    const store = new SessionStore(':memory:', { hooks: bus });
    const id = store.createSession('bot-1');
    expect(store.deleteSession(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // fire-and-forget emissions
    expect(seen).toEqual([
      { event: 'start', sessionId: id },
      { event: 'end', sessionId: id },
    ]);
    store.close();
  });

  it('emits compact.before/after around compactNow and honors the gate', async () => {
    const bus = new HookBus();
    const events: string[] = [];
    bus.on('compact.before', (p) => { events.push(`before:${(p as { messageCount: number }).messageCount}`); });
    bus.on('compact.after', (p) => { events.push(`after:${(p as { compacted: boolean }).compacted}`); });
    const store = new SessionStore(':memory:', {
      hooks: bus,
      summarizer: async () => 'SUMMARY',
    });
    const id = store.createSession('bot-1');
    // Non-adaptive compaction needs > keepFloor(100) + threshold(140) rows.
    for (let i = 0; i < 260; i++) store.appendMessage(id, { role: 'user', content: `msg ${i}` });
    expect(await store.compactNow(id)).toBe(true);
    expect(events[0]).toMatch(/^before:/);
    expect(events[1]).toBe('after:true');

    // Gate: a cancelling compact.before handler skips the fold.
    const bus2 = new HookBus();
    bus2.on('compact.before', () => ({ cancel: true, reason: 'not now' }) as const);
    const store2 = new SessionStore(':memory:', { hooks: bus2, summarizer: async () => 'SUMMARY' });
    const id2 = store2.createSession('bot-1');
    for (let i = 0; i < 260; i++) store2.appendMessage(id2, { role: 'user', content: `msg ${i}` });
    expect(await store2.compactNow(id2)).toBe(false);
    store.close();
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// Runtime: turn.start / permission.request / file.changed
// ---------------------------------------------------------------------------

class ApprovalGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(call: { name: string }): Promise<{ decision: GovernanceDecision }> {
    return { decision: call.name === 'write_file' ? 'require-approval' : 'allow' };
  }
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

const mainBot: BotConfig = {
  id: 'bot-main', name: 'Main', description: 'test', systemPrompt: 'You are the main bot.',
  provider: 'mock', model: 'mock-model', skills: [], tools: ['write_file'], mcpServers: [],
};

function makeFileRuntime(bus: HookBus, toolRan: { value: boolean }): { runtime: TestRuntime; provider: MockProvider } {
  const provider = new MockProvider([
    { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'hi' } }] },
    { content: 'done' },
  ]);
  const writeTool: ToolDefinition = {
    name: 'write_file',
    mutating: true,
    description: 'write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => { toolRan.value = true; return { ok: true }; },
  };
  const runtime = new TestRuntime(
    {
      dbPath: ':memory:',
      skillsDir: '/tmp/no-skills-here',
      governance: new ApprovalGateway(),
      toolRegistry: new Map([[writeTool.name, writeTool]]),
      defaultProviderId: 'mock',
      hooks: bus,
    },
    provider,
  );
  return { runtime, provider };
}

describe('AgentRuntime hook emission', () => {
  it('emits session.start, turn.start, permission.request and file.changed with payloads', async () => {
    const bus = new HookBus();
    const got = new Map<string, unknown[]>();
    const record = (event: string) => (p: unknown) => {
      got.set(event, [...(got.get(event) ?? []), p]);
    };
    bus.on('session.start', record('session.start'));
    bus.on('turn.start', record('turn.start'));
    bus.on('permission.request', record('permission.request'));
    bus.on('file.changed', record('file.changed'));
    const toolRan = { value: false };
    const { runtime } = makeFileRuntime(bus, toolRan);
    await runtime.runTurn({ bot: mainBot, message: 'write it', onEvent: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(toolRan.value).toBe(true);
    expect(got.get('session.start')).toHaveLength(1);
    expect(got.get('turn.start')?.[0]).toMatchObject({ botId: 'bot-main', isNewSession: true });
    expect(got.get('permission.request')?.[0]).toMatchObject({ toolName: 'write_file', decision: 'require-approval' });
    expect(got.get('file.changed')?.[0]).toMatchObject({ toolName: 'write_file', path: 'a.txt', botId: 'bot-main' });
  });

  it('permission.request advisory hooks cannot block; additionalDeny hooks add a deny and governance is never weakened', async () => {
    // Advisory (default): cancel verdict ignored — the approved tool still runs.
    const advisoryBus = new HookBus();
    advisoryBus.on('permission.request', () => ({ cancel: true, reason: 'advisory no' }) as const);
    const ranA = { value: false };
    const { runtime: rtA } = makeFileRuntime(advisoryBus, ranA);
    await rtA.runTurn({ bot: mainBot, message: 'write it', onEvent: () => {} });
    expect(ranA.value).toBe(true);

    // additionalDeny (canBlock): the hook adds a deny — tool never runs,
    // no file.changed fires.
    const denyBus = new HookBus();
    denyBus.on('permission.request', () => ({ cancel: true, reason: 'extra deny' }) as const, { canBlock: true });
    let fileChanged = 0;
    denyBus.on('file.changed', () => { fileChanged += 1; });
    const ranB = { value: false };
    const { runtime: rtB } = makeFileRuntime(denyBus, ranB);
    const results: Array<{ denied?: boolean }> = [];
    await rtB.runTurn({
      bot: mainBot,
      message: 'write it',
      onEvent: (e) => { if (e.type === 'tool_result') results.push(e as { denied?: boolean }); },
    });
    expect(ranB.value).toBe(false);
    expect(results.some((r) => r.denied === true)).toBe(true);
    expect(fileChanged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Delegate: file-definition resolution + worktree isolation spawn
// ---------------------------------------------------------------------------

describe('delegate with agent definitions + worktree isolation', () => {
  let base: string;
  let repo: string;
  let store: SubagentStore;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'kriyadot-delegate-iso-'));
    repo = makeRepo(base);
    store = new SubagentStore(join(base, 'subagents.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  const ctx = { sessionId: 'sess-parent', botId: 'bot-parent' };

  function defs(): AgentDefinition[] {
    const { definition } = parseAgentDefinition(
      '---\nname: Isolated Reviewer\nmodel: rev-model\ntools: [read_file]\nisolation: worktree\n---\nYou review in isolation.',
      {},
    );
    return [definition!];
  }

  it('resolves the file definition (winning over the library) and spawns in a worktree that is cleaned up, branch kept', async () => {
    const bus = new HookBus();
    const hookEvents: string[] = [];
    bus.on('subagent.start', () => { hookEvents.push('subagent.start'); });
    bus.on('subagent.stop', () => { hookEvents.push('subagent.stop'); });
    bus.on('worktree.create', (p) => { hookEvents.push(`worktree.create:${(p as { worktreePath?: string }).worktreePath ? 'done' : 'gate'}`); });
    bus.on('worktree.remove', () => { hookEvents.push('worktree.remove'); });

    const calls: SubagentSpawnInput[] = [];
    let worktreeExistedDuringSpawn = false;
    const spawn: SubagentSpawnFn = vi.fn(async (input) => {
      calls.push(input);
      worktreeExistedDuringSpawn = input.worktreePath ? existsSync(input.worktreePath) : false;
      return { result: 'reviewed', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const [tool] = createDelegateTools({ spawn, store, workspaceDir: repo, agentDefinitions: defs(), hooks: bus })!;
    const out = (await tool!.handler({ task: 'review the repo', profileId: 'isolated-reviewer' }, ctx)) as {
      result: string; worktreePath?: string; worktreeBranch?: string;
    };
    expect(out.result).toBe('reviewed');
    expect(calls[0]!.profile).toMatchObject({ name: 'Isolated Reviewer', model: 'rev-model' });
    expect(calls[0]!.isolation).toBe('worktree');
    expect(worktreeExistedDuringSpawn).toBe(true);
    expect(out.worktreePath).toBeTruthy();
    // Cleanup per existing policy: clean worktree dir removed, branch kept.
    expect(existsSync(out.worktreePath!)).toBe(false);
    const branches = git(repo, 'branch', '--list', out.worktreeBranch!);
    expect(branches).toContain(out.worktreeBranch!);
    expect(hookEvents).toContain('subagent.start');
    expect(hookEvents).toContain('subagent.stop');
    expect(hookEvents).toContain('worktree.remove');
  });

  it('a blocking subagent.start hook prevents the spawn', async () => {
    const bus = new HookBus();
    bus.on('subagent.start', () => ({ cancel: true, reason: 'frozen' }) as const);
    const spawn: SubagentSpawnFn = vi.fn(async () => ({ result: 'never' }));
    const [tool] = createDelegateTools({ spawn, store, hooks: bus })!;
    await expect(tool!.handler({ task: 'anything' }, ctx)).rejects.toThrow(/blocked by a hook/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('per-spawn isolation option works without a profile', async () => {
    const calls: SubagentSpawnInput[] = [];
    const spawn: SubagentSpawnFn = vi.fn(async (input) => {
      calls.push(input);
      return { result: 'ok' };
    });
    const [tool] = createDelegateTools({ spawn, store, workspaceDir: repo })!;
    const out = (await tool!.handler({ task: 'isolated please', isolation: 'worktree' }, ctx)) as { worktreePath?: string };
    expect(calls[0]!.worktreePath).toBeTruthy();
    expect(existsSync(out.worktreePath!)).toBe(false); // cleaned up
  });
});

// ---------------------------------------------------------------------------
// Background runs: definition-driven spawn + worktree isolation
// ---------------------------------------------------------------------------

describe('background runs with agent definitions + worktree isolation', () => {
  let base: string;
  let repo: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'kriyadot-bg-iso-'));
    repo = makeRepo(base);
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('spawns a file-defined specialist in a worktree, attaches it to the run record, cleans up, emits subagent hooks', async () => {
    const bus = new HookBus();
    const hookEvents: string[] = [];
    bus.on('subagent.start', () => { hookEvents.push('subagent.start'); });
    bus.on('subagent.stop', () => { hookEvents.push('subagent.stop'); });
    const { definition } = parseAgentDefinition(
      '---\nname: BG Reviewer\nmodel: bg-model\nisolation: worktree\n---\nYou review in the background.',
      {},
    );
    const provider = new MockProvider([{ content: 'bg findings' }]);
    const runtime = new TestRuntime(
      {
        dbPath: ':memory:',
        skillsDir: '/tmp/no-skills-here',
        governance: new ApprovalGateway(),
        toolRegistry: new Map(),
        defaultProviderId: 'mock',
        hooks: bus,
        agentDefinitions: [definition!],
        workspaceDirForBot: () => repo,
      },
      provider,
    );
    const started = runtime.startBackgroundRun({
      originBot: mainBot,
      originSessionId: 'sess-origin',
      task: 'review in background',
      profileId: 'bg-reviewer',
    });
    expect('runId' in started).toBe(true);
    const runId = (started as { runId: string }).runId;
    const start = Date.now();
    for (;;) {
      const rec = runtime.backgroundRuns.get(runId);
      if (rec && rec.status !== 'running') break;
      if (Date.now() - start > 5000) throw new Error('background run did not finish');
      await new Promise((r) => setTimeout(r, 10));
    }
    const rec = runtime.backgroundRuns.get(runId)!;
    expect(rec.status).toBe('done');
    expect(rec.botName).toBe('BG Reviewer');
    expect(rec.profileId).toBe('bg-reviewer');
    expect(rec.worktreePath).toBeTruthy();
    expect(rec.result).toContain('bg findings');
    // Worktree cleaned up (was clean), branch kept.
    expect(existsSync(rec.worktreePath!)).toBe(false);
    expect(git(repo, 'branch', '--list', rec.worktreeBranch!)).toContain(rec.worktreeBranch!);
    expect(hookEvents).toEqual(['subagent.start', 'subagent.stop']);
  });
});
