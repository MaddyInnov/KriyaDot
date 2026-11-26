// SPDX-License-Identifier: Apache-2.0
// B-7 residual: stream retraction on a mid-stream provider swap.
// When a provider dies AFTER streaming partial tokens live and the turn
// swaps to a backup, the runtime emits exactly one 'retract' event —
// after the dying provider's partial deltas, before the backup's first
// replayed token — so clients discard the fragment instead of showing
// fragment + full second answer. A swap before any token streamed
// emits no retraction. Zero paid API usage — scripted providers only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { resetRateLimits } from '../src/providers/rate-limit.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ChatMessage, LLMProvider, ModelInfo, StreamEvent, TokenUsage, ToolDefinition } from '../src/types.js';

function limitError(): Error & { status?: number; code?: string } {
  const e = new Error(
    'Provider request failed: 429 Too Many Requests — {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
  ) as Error & { status?: number; code?: string };
  e.status = 429;
  e.code = 'insufficient_quota';
  return e;
}

class FakeGateway implements GovernanceGateway {
  readonly audits: Array<{ type: string; detail: unknown }> = [];
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(): Promise<{ decision: GovernanceDecision }> { return { decision: 'allow' }; }
  async awaitDecision(): Promise<'approved' | 'denied'> { return 'approved'; }
  decide(): void {}
  audit(entry: { type: string; detail?: unknown }): void { this.audits.push({ type: entry.type, detail: entry.detail }); }
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

/** Provider that streams scripted tokens via onToken, then returns or throws. */
class StreamingProvider implements LLMProvider {
  readonly calls: Array<{ model: string }> = [];
  constructor(
    readonly providerId: string,
    private readonly script: { tokens: string[]; content?: string; error?: Error },
  ) {}
  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    opts: { model: string; onToken?: (t: string) => void },
  ): Promise<{ content: string; toolCalls: never[]; usage: TokenUsage }> {
    this.calls.push({ model: opts.model });
    for (const t of this.script.tokens) opts.onToken?.(t);
    if (this.script.error) throw this.script.error;
    return {
      content: this.script.content ?? this.script.tokens.join(''),
      toolCalls: [],
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    };
  }
  async listModels(): Promise<ModelInfo[]> { return [{ id: 'm', name: 'M' }]; }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mvp-retract-')); resetRateLimits(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetRateLimits(); });

function makeRuntime(providers: Map<string, LLMProvider>): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected override resolveProvider(providerId: string): LLMProvider {
      const p = providers.get(providerId);
      if (!p) throw new Error(`no test provider "${providerId}"`);
      return p;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: new FakeGateway(),
    toolRegistry: new Map(),
    defaultProviderId: 'primary',
  });
}

function botWithBackup(): BotConfig {
  return {
    id: 'bot-retract', name: 'Retract Bot', description: 'test', systemPrompt: 'You are a test bot.',
    provider: 'primary', model: 'primary-model', backupProvider: 'backup', backupModel: 'backup-model',
    skills: [], tools: [], mcpServers: [],
  };
}

async function run(runtime: AgentRuntime): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await runtime.runTurn({
    bot: botWithBackup(), message: 'hello', sessionId: `s-${Math.random().toString(36).slice(2)}`,
    onEvent: (e) => { events.push(e); },
  }).catch(() => undefined);
  return events;
}

type RetractEvent = Extract<StreamEvent, { type: 'retract' }>;

describe('stream retraction on mid-stream swap (B-7 residual)', () => {
  it('swap after partial stream emits exactly one retract between the partial deltas and the replay', async () => {
    const partial = ['partial ', 'frag'];
    const primary = new StreamingProvider('primary', { tokens: partial, error: limitError() });
    const backup = new StreamingProvider('backup', { tokens: ['full ', 'answer'], content: 'full answer' });
    const runtime = makeRuntime(new Map([['primary', primary], ['backup', backup]]));
    const events = await run(runtime);

    const retracts = events.filter((e): e is RetractEvent => e.type === 'retract');
    expect(retracts).toHaveLength(1);
    expect(retracts[0]).toMatchObject({
      scope: 'turn-segment',
      reason: 'provider-swap',
      retractedChars: 'partial frag'.length,
      fromProvider: 'primary',
      toProvider: 'backup',
    });

    const retractIdx = events.findIndex((e) => e.type === 'retract');
    const tokenIdxs = events
      .map((e, i) => (e.type === 'token' ? i : -1))
      .filter((i) => i >= 0);
    // Both partial deltas precede the retraction; both backup deltas follow it.
    expect(tokenIdxs).toHaveLength(4);
    expect(Math.max(...tokenIdxs.slice(0, 2))).toBeLessThan(retractIdx);
    expect(Math.min(...tokenIdxs.slice(2))).toBeGreaterThan(retractIdx);
    // The failover pair is still emitted, ahead of the retraction.
    const failoverIdx = events.findIndex((e) => e.type === 'failover');
    expect(failoverIdx).toBeGreaterThanOrEqual(0);
    expect(failoverIdx).toBeLessThan(retractIdx);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('swap before any token emits no retraction', async () => {
    const primary = new StreamingProvider('primary', { tokens: [], error: limitError() });
    const backup = new StreamingProvider('backup', { tokens: ['full answer'], content: 'full answer' });
    const runtime = makeRuntime(new Map([['primary', primary], ['backup', backup]]));
    const events = await run(runtime);
    expect(events.filter((e) => e.type === 'failover')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'retract')).toHaveLength(0);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('no swap → no retraction (ordinary streamed turn is untouched)', async () => {
    const primary = new StreamingProvider('primary', { tokens: ['hello ', 'world'], content: 'hello world' });
    const backup = new StreamingProvider('backup', { tokens: ['unused'] });
    const runtime = makeRuntime(new Map([['primary', primary], ['backup', backup]]));
    const events = await run(runtime);
    expect(backup.calls).toHaveLength(0);
    expect(events.filter((e) => e.type === 'retract')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'token')).toHaveLength(2);
  });
});
