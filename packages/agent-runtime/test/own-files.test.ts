// SPDX-License-Identifier: Apache-2.0
// W8e: own-files reads never trigger approval — helper unit tests plus
// runtime integration against a governance gateway that requires
// approval for EVERYTHING.

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { isOwnWorkspaceRead, OWN_FILE_READ_TOOLS } from '../src/own-files.js';
import { createBuiltInTools } from '../src/tools/builtin.js';
import type { GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolCall } from '../src/types.js';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'c1', name, args };
}

describe('isOwnWorkspaceRead', () => {
  const root = mkdtempSync(join(tmpdir(), 'w8-own-helper-'));
  const coder = join(root, 'coder');
  mkdirSync(join(coder, 'notes'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  const own = [coder];

  it('allows read_file inside the own area', () => {
    expect(isOwnWorkspaceRead(call('read_file', { path: 'notes/todo.md' }), own)).toBe(true);
    expect(isOwnWorkspaceRead(call('read_file', { path: join(coder, 'a.txt') }), own)).toBe(true);
  });

  it('rejects traversal and outside paths', () => {
    expect(isOwnWorkspaceRead(call('read_file', { path: '../secret.txt' }), own)).toBe(false);
    expect(isOwnWorkspaceRead(call('read_file', { path: '/etc/passwd' }), own)).toBe(false);
    expect(isOwnWorkspaceRead(call('read_file', { path: join(root, 'other', 'a.txt') }), own)).toBe(false);
  });

  it('a non-existent own area qualifies nothing (fail closed)', () => {
    expect(isOwnWorkspaceRead(call('read_file', { path: 'a.txt' }), ['/definitely/not/a/real/dir'])).toBe(false);
  });

  it('rejects symlink escapes via realpath confinement', () => {
    const root = mkdtempSync(join(tmpdir(), 'w8-own-'));
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(ws, 'link'));
    expect(isOwnWorkspaceRead(call('read_file', { path: 'link/secret.txt' }), [ws])).toBe(false);
    writeFileSync(join(ws, 'mine.txt'), 'mine');
    expect(isOwnWorkspaceRead(call('read_file', { path: 'mine.txt' }), [ws])).toBe(true);
  });

  it('never qualifies writes or non-file tools', () => {
    for (const name of ['write_file', 'edit', 'patch', 'run_command', 'web_search', 'ask_bot']) {
      expect(isOwnWorkspaceRead(call(name, { path: 'a.txt' }), own)).toBe(false);
      expect(OWN_FILE_READ_TOOLS.has(name)).toBe(false);
    }
  });

  it('grep without a path is own (workspace-root search); with a path it must be inside', () => {
    expect(isOwnWorkspaceRead(call('grep', { pattern: 'x' }), own)).toBe(true);
    expect(isOwnWorkspaceRead(call('grep', { pattern: 'x', path: 'src' }), own)).toBe(true);
    expect(isOwnWorkspaceRead(call('grep', { pattern: 'x', path: '../' }), own)).toBe(false);
  });

  it('glob qualifies unless the pattern traverses', () => {
    expect(isOwnWorkspaceRead(call('glob', { pattern: 'src/**/*.ts' }), own)).toBe(true);
    expect(isOwnWorkspaceRead(call('glob', { pattern: '../**/*' }), own)).toBe(false);
  });

  it('empty own-dirs list qualifies nothing', () => {
    expect(isOwnWorkspaceRead(call('read_file', { path: 'a.txt' }), [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime integration: governance requires approval for everything.
// ---------------------------------------------------------------------------

class ApproveEverythingGateway implements GovernanceGateway {
  evaluateCalls = 0;
  awaitCalls = 0;
  audits: Array<{ type: string }> = [];
  verdict: 'approved' | 'denied' = 'approved';
  async classify(): Promise<'require-approval'> {
    return 'require-approval';
  }
  async evaluate(): Promise<{ decision: 'require-approval' }> {
    this.evaluateCalls += 1;
    return { decision: 'require-approval' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    this.awaitCalls += 1;
    return this.verdict;
  }
  decide(): void {}
  audit(entry: { type: string }): void {
    this.audits.push(entry);
  }
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

function testBot(tools: string[]): BotConfig {
  return {
    id: 'bot-test',
    name: 'Test Bot',
    description: 'test',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools,
    mcpServers: [],
  };
}

function runtimeWithGateway(gateway: ApproveEverythingGateway, ws: string): AgentRuntime {
  const tools = createBuiltInTools({ workspaceDir: ws });
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'mine.txt' } }] },
        { content: 'read it' },
      ]);
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/w8-own-skills-missing',
    governance: gateway,
    toolRegistry: new Map(tools.map((t) => [t.name, t])),
    defaultProviderId: 'mock',
  });
}

describe('runtime own-files integration (W8e)', () => {
  it('read inside own workspace runs with NO approval and NO governance evaluation', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'w8-own-ws-'));
    writeFileSync(join(ws, 'mine.txt'), 'hello own file');
    const gateway = new ApproveEverythingGateway();
    gateway.verdict = 'denied'; // would kill the call if approval were consulted
    const runtime = runtimeWithGateway(gateway, ws);
    const events: StreamEvent[] = [];
    await runtime.runTurn({
      bot: testBot(['read_file']),
      message: 'read mine',
      sessionId: 's-own',
      ownWorkspaceDirs: [ws],
      onEvent: (e) => events.push(e),
    });
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.length).toBeGreaterThan(0);
    const first = results[0]!;
    if (first.type === 'tool_result') expect(first.result).toBe('hello own file');
    expect(gateway.evaluateCalls).toBe(0);
    expect(gateway.awaitCalls).toBe(0);
    expect(gateway.audits.some((a) => a.type === 'tool.own_file_auto_allowed')).toBe(true);
  });

  it('without ownWorkspaceDirs the same read goes through approval (denied here)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'w8-own-ws2-'));
    writeFileSync(join(ws, 'mine.txt'), 'hello own file');
    const gateway = new ApproveEverythingGateway();
    gateway.verdict = 'denied';
    const runtime = runtimeWithGateway(gateway, ws);
    const events: StreamEvent[] = [];
    await runtime.runTurn({
      bot: testBot(['read_file']),
      message: 'read mine',
      sessionId: 's-governed',
      onEvent: (e) => events.push(e),
    });
    expect(gateway.evaluateCalls).toBeGreaterThan(0);
    expect(gateway.awaitCalls).toBe(1);
    const denied = events.some((e) => e.type === 'tool_result' && e.denied === true);
    expect(denied).toBe(true);
  });
});
