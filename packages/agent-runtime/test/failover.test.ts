// SPDX-License-Identifier: Apache-2.0
// W1: AI failover + limit classification + near-limit warnings.
// Zero paid API usage — scripted in-process providers only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import {
  classifyProviderError,
  computeResumeAtMs,
  isLimitError,
  resolveFailoverTarget,
  usageWarningFromSnapshot,
  usageWarningFromSpend,
} from '../src/failover.js';
import { resetRateLimits, recordRateLimit } from '../src/providers/rate-limit.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ChatMessage, LLMProvider, ModelInfo, StreamEvent, TokenUsage, ToolDefinition } from '../src/types.js';

function limitError(message = 'Provider request failed: 429 Too Many Requests — {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'): Error & { status?: number; code?: string } {
  const e = new Error(message) as Error & { status?: number; code?: string };
  e.status = 429;
  e.code = 'insufficient_quota';
  return e;
}

describe('classifyProviderError', () => {
  beforeEach(() => resetRateLimits());
  afterEach(() => resetRateLimits());

  it('classifies 429 with quota semantics as a hard limit', () => {
    const c = classifyProviderError(limitError());
    expect(c.kind).toBe('limit');
    expect(c.isLimit).toBe(true);
    expect(c.status).toBe(429);
    expect(c.code).toBe('insufficient_quota');
    expect(isLimitError(limitError())).toBe(true);
  });

  it('classifies "usage limit reached" phrasing as a hard limit without a status', () => {
    const c = classifyProviderError(new Error('You have hit your usage limit. Try again later.'));
    expect(c.isLimit).toBe(true);
  });

  it('classifies Anthropic usage_limit error type as a hard limit', () => {
    const e = new Error('Anthropic request failed: 429 Too Many Requests — {"type":"error","error":{"type":"usage_limit_reached"}}') as Error & { status?: number; code?: string };
    e.status = 429;
    e.code = 'usage_limit_reached';
    expect(classifyProviderError(e).isLimit).toBe(true);
  });

  it('classifies a bare 429 (per-minute throttling) as transient, NOT a limit', () => {
    const e = new Error('Provider request failed: 429 Too Many Requests — rate limit reached, please slow down') as Error & { status?: number };
    e.status = 429;
    const c = classifyProviderError(e);
    expect(c.kind).toBe('transient');
    expect(c.isLimit).toBe(false);
    expect(c.isTransientRateLimit).toBe(true);
  });

  it('classifies Anthropic rate_limit_error without quota semantics as transient', () => {
    const e = new Error('Anthropic request failed: 429 — {"error":{"type":"rate_limit_error","message":"Rate limited"}}') as Error & { status?: number; code?: string };
    e.status = 429;
    e.code = 'rate_limit_error';
    expect(classifyProviderError(e).isLimit).toBe(false);
    expect(classifyProviderError(e).kind).toBe('transient');
  });

  it('classifies 503 / overloaded as transient and other errors as other', () => {
    expect(classifyProviderError(new Error('Provider request failed: 503 Service Unavailable')).kind).toBe('transient');
    expect(classifyProviderError(new Error('boom: invalid api key')).kind).toBe('other');
    expect(classifyProviderError(new Error('boom: invalid api key')).isLimit).toBe(false);
  });

  it('extracts retry-after, reset and usage percent from structured fields', () => {
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const e = limitError() as Error & { retryAfterMs?: number; resetAt?: string };
    e.retryAfterMs = 90_000;
    e.resetAt = reset;
    const c = classifyProviderError(e);
    expect(c.retryAfterMs).toBe(90_000);
    expect(c.resetAtMs).toBe(new Date(reset).getTime());
    const e2 = new Error('quota exceeded: 92% used of your quota') as Error & { status?: number };
    e2.status = 429;
    expect(classifyProviderError(e2).usagePercent).toBe(92);
  });

  it('extracts retry-after phrased in the message', () => {
    const c = classifyProviderError(new Error('Provider request failed: 429 — quota exceeded, retry after 15 minutes'));
    expect(c.retryAfterMs).toBe(15 * 60_000);
  });

  it('falls back to the rate-limit snapshot reset for the provider', () => {
    const reset = new Date(Date.now() + 7_200_000).toISOString();
    recordRateLimit('groq', { resetAt: reset });
    const c = classifyProviderError(limitError(), { providerId: 'groq' });
    expect(c.resetAtMs).toBe(new Date(reset).getTime());
  });
});

describe('computeResumeAtMs', () => {
  const now = 1_700_000_000_000;
  it('prefers the provider reset time', () => {
    expect(computeResumeAtMs({ resetAtMs: now + 5000 }, { nowMs: now })).toBe(now + 5000);
  });
  it('uses retry-after when no reset is known', () => {
    expect(computeResumeAtMs({ retryAfterMs: 60_000 }, { nowMs: now })).toBe(now + 60_000);
  });
  it('falls back to the configurable default backoff', () => {
    expect(computeResumeAtMs({}, { nowMs: now, defaultBackoffMs: 30 * 60_000 })).toBe(now + 30 * 60_000);
    expect(computeResumeAtMs({ resetAtMs: now - 1000 }, { nowMs: now, defaultBackoffMs: 5000 })).toBe(now + 5000);
  });
});

describe('near-limit warnings', () => {
  it('warns at >=80% from a rate-limit snapshot ("92% used")', () => {
    const w = usageWarningFromSnapshot('groq', { limitRequests: 100, remainingRequests: 8 });
    expect(w).not.toBeNull();
    expect(w!.usedPercent).toBe(92);
    expect(w!.message).toContain('92% used');
    expect(w!.source).toBe('rate-limit');
  });
  it('stays silent below the threshold and with no data', () => {
    expect(usageWarningFromSnapshot('groq', { limitRequests: 100, remainingRequests: 50 })).toBeNull();
    expect(usageWarningFromSnapshot('groq', null)).toBeNull();
    expect(usageWarningFromSnapshot('groq', {})).toBeNull();
    expect(usageWarningFromSnapshot('groq', { remainingRequests: 3 })).toBeNull();
  });
  it('warns from spend figures vs a cap, and not without a cap', () => {
    const w = usageWarningFromSpend({ label: 'Global spend', spentCents: 460, capCents: 500 });
    expect(w!.usedPercent).toBe(92);
    expect(usageWarningFromSpend({ label: 'Global spend', spentCents: 460, capCents: null })).toBeNull();
  });
});

describe('resolveFailoverTarget', () => {
  it('prefers the configured backup provider/model', () => {
    const t = resolveFailoverTarget({
      bot: { provider: 'groq', model: 'gpt-oss-20b', backupProvider: 'anthropic', backupModel: 'claude-3-5-haiku-latest' },
      excludeProviderId: 'groq',
    });
    expect(t).toMatchObject({ providerId: 'anthropic', modelId: 'claude-3-5-haiku-latest' });
  });
  it('falls back to the next eligible catalog provider when no backup is configured', () => {
    const t = resolveFailoverTarget({ bot: { provider: 'groq', model: 'gpt-oss-20b' }, excludeProviderId: 'groq' });
    expect(t).not.toBeNull();
    expect(t!.providerId).not.toBe('groq');
    expect(t!.modelId.length).toBeGreaterThan(0);
  });
  it('never returns the failed provider itself', () => {
    const t = resolveFailoverTarget({
      bot: { provider: 'groq', model: 'm', backupProvider: 'groq', backupModel: 'm2' },
      excludeProviderId: 'groq',
    });
    expect(t!.providerId).not.toBe('groq');
  });
});

// ---- Runtime integration ---------------------------------------------------

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

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ model: string }> = [];
  constructor(
    readonly providerId: string,
    private readonly behavior: (callIndex: number) => { content: string } | Error,
  ) {}
  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    opts: { model: string },
  ): Promise<{ content: string; toolCalls: never[]; usage: TokenUsage }> {
    this.calls.push({ model: opts.model });
    const out = this.behavior(this.calls.length - 1);
    if (out instanceof Error) throw out;
    return { content: out.content, toolCalls: [], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
  }
  async listModels(): Promise<ModelInfo[]> { return [{ id: 'm', name: 'M' }]; }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mvp-failover-')); resetRateLimits(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetRateLimits(); });

function makeRuntime(providers: Map<string, LLMProvider>, gateway: FakeGateway): AgentRuntime {
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
    governance: gateway,
    toolRegistry: new Map(),
    defaultProviderId: 'primary',
  });
}

function botWithBackup(): BotConfig {
  return {
    id: 'bot-failover', name: 'Failover Bot', description: 'test', systemPrompt: 'You are a test bot.',
    provider: 'primary', model: 'primary-model', backupProvider: 'backup', backupModel: 'backup-model',
    skills: [], tools: [], mcpServers: [],
  };
}

async function run(runtime: AgentRuntime, bot: BotConfig): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await runtime.runTurn({
    bot, message: 'hello', sessionId: `s-${Math.random().toString(36).slice(2)}`,
    onEvent: (e) => { events.push(e); },
  }).catch(() => undefined);
  return events;
}

describe('runtime failover', () => {
  it('primary limit-fails → backup completes the turn, notice emitted exactly once', async () => {
    const primary = new ScriptedProvider('primary', () => limitError());
    const backup = new ScriptedProvider('backup', () => ({ content: 'answer from backup' }));
    const gateway = new FakeGateway();
    const runtime = makeRuntime(new Map([['primary', primary], ['backup', backup]]), gateway);
    const events: StreamEvent[] = [];
    const usage = await runtime.runTurn({
      bot: botWithBackup(), message: 'hello', sessionId: 's-failover-1',
      onEvent: (e) => { events.push(e); },
    });
    expect(usage.totalTokens).toBe(10);
    expect(primary.calls).toHaveLength(1);
    expect(backup.calls).toHaveLength(1);
    expect(backup.calls[0]!.model).toBe('backup-model');
    const failovers = events.filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ fromProvider: 'primary', toProvider: 'backup' });
    expect(events.filter((e) => e.type === 'notice' && (e as { kind?: string }).kind === 'failover')).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(gateway.audits.some((a) => a.type === 'turn.failover')).toBe(true);
  });

  it('backup also limit-fails → error surfaces, no loop (each provider called once)', async () => {
    const primary = new ScriptedProvider('primary', () => limitError());
    const backup = new ScriptedProvider('backup', () => limitError(new Error('Provider request failed: 429 — monthly limit reached for this plan')));
    const gateway = new FakeGateway();
    const runtime = makeRuntime(new Map([['primary', primary], ['backup', backup]]), gateway);
    const events = await run(runtime, botWithBackup());
    expect(primary.calls).toHaveLength(1);
    expect(backup.calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.filter((e) => e.type === 'failover')).toHaveLength(1);
  });

  it('transient 429 does NOT trigger failover', async () => {
    const transient = new Error('Provider request failed: 429 Too Many Requests — rate limit reached, slow down') as Error & { status?: number };
    transient.status = 429;
    const primary = new ScriptedProvider('primary', () => transient);
    const backup = new ScriptedProvider('backup', () => ({ content: 'should not run' }));
    const runtime = makeRuntime(new Map([['primary', primary], ['backup', backup]]), new FakeGateway());
    const events = await run(runtime, botWithBackup());
    expect(backup.calls).toHaveLength(0);
    expect(events.some((e) => e.type === 'failover')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('non-limit errors do NOT trigger failover', async () => {
    const primary = new ScriptedProvider('primary', () => new Error('invalid api key'));
    const backup = new ScriptedProvider('backup', () => ({ content: 'should not run' }));
    const runtime = makeRuntime(new Map([['primary', primary], ['backup', backup]]), new FakeGateway());
    await run(runtime, botWithBackup());
    expect(backup.calls).toHaveLength(0);
  });

  it('emits a near-limit usage_warning from the rate-limit snapshot', async () => {
    recordRateLimit('primary', { limitRequests: 100, remainingRequests: 5 });
    const primary = new ScriptedProvider('primary', () => ({ content: 'ok' }));
    const runtime = makeRuntime(new Map([['primary', primary]]), new FakeGateway());
    const bot = botWithBackup();
    delete bot.backupProvider;
    delete bot.backupModel;
    const events = await run(runtime, bot);
    const warnings = events.filter((e) => e.type === 'usage_warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ providerId: 'primary', usedPercent: 95 });
  });
});
