// SPDX-License-Identifier: Apache-2.0
// A1 §3: mid-job swap with transcript replay + selection integrity.
// Pure decision matrix, replay construction, and full runtime turns with
// scripted in-process providers (zero paid APIs). The hard law under
// test (v0.2.2): an explicit selection that dies swaps ONLY to a
// pre-declared backup; otherwise it refuses loudly with ZERO calls to
// any other lane — especially never the free OVH lane.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { ProviderSelectionRefusedError } from '../src/failover.js';
import { BridgeCooldownRegistry } from '../src/providers/cli-cooldown.js';
import {
  buildTranscriptReplayMessages,
  decideBridgeSwap,
  declaredSelectionBackup,
  TRANSCRIPT_REPLAY_MARKER,
} from '../src/providers/cli-swap.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ChatMessage, LLMProvider, ModelInfo, StreamEvent, TokenUsage, ToolDefinition } from '../src/types.js';

function quotaError(): Error & { status?: number; code?: string } {
  const e = new Error('Provider request failed: 429 — {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}') as Error & { status?: number; code?: string };
  e.status = 429;
  e.code = 'insufficient_quota';
  return e;
}

describe('decideBridgeSwap (pure)', () => {
  const base = {
    failedProviderId: 'codex-subscription',
    failedReason: 'usage limit / quota death: quota exceeded',
    autoTarget: { providerId: 'groq', modelId: 'gpt-oss-120b' },
  };

  it('explicit + quota death + declared backup → swap to EXACTLY the declared backup (not the auto target)', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: true, quotaDeath: true, driverFailure: true,
      declaredBackup: { providerId: 'claude-subscription', modelId: 'sonnet' }, autoTargetCooldownReason: null,
    });
    expect(d).toEqual({ action: 'swap', via: 'declared-backup', target: { providerId: 'claude-subscription', modelId: 'sonnet' } });
  });

  it('explicit + quota death + NO declared backup → refuse, even though an auto target exists', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: true, quotaDeath: true, driverFailure: true,
      declaredBackup: null, autoTargetCooldownReason: null,
    });
    expect(d.action).toBe('refuse');
    if (d.action === 'refuse') {
      expect(d.reason).toContain('no backup was pre-declared');
      expect(d.reason).toContain('quota death');
    }
  });

  it('explicit + declared backup naming the FAILED provider itself → refuse (no swap to the corpse)', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: true, quotaDeath: true, driverFailure: false,
      declaredBackup: { providerId: 'codex-subscription', modelId: 'gpt-5' }, autoTargetCooldownReason: null,
    });
    expect(d.action).toBe('refuse');
  });

  it('explicit + driver failure (non-quota) + no declared backup → refuse (v0.2.2 semantics preserved)', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: true, quotaDeath: false, driverFailure: true,
      declaredBackup: null, autoTargetCooldownReason: null,
    });
    expect(d.action).toBe('refuse');
  });

  it('explicit + ordinary error (no death) → fail (caller surfaces it; no refusal, no swap)', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: true, quotaDeath: false, driverFailure: false,
      declaredBackup: null, autoTargetCooldownReason: null,
    });
    expect(d.action).toBe('fail');
  });

  it('auto + quota death → swap to the auto target', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: false, quotaDeath: true, driverFailure: true,
      declaredBackup: null, autoTargetCooldownReason: null,
    });
    expect(d).toEqual({ action: 'swap', via: 'auto', target: { providerId: 'groq', modelId: 'gpt-oss-120b' } });
  });

  it('auto + quota death + auto target in cooldown → fail WITH the cooled reason (no blind retry)', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: false, quotaDeath: true, driverFailure: true,
      declaredBackup: null, autoTargetCooldownReason: 'groq account "default" is in cooldown (rate_limit): window resets soon',
    });
    expect(d.action).toBe('fail');
    if (d.action === 'fail') expect(d.reason).toContain('cooldown');
  });

  it('auto + non-quota error → fail (no swap)', () => {
    const d = decideBridgeSwap({
      ...base, explicitSelection: false, quotaDeath: false, driverFailure: false,
      declaredBackup: null, autoTargetCooldownReason: null,
    });
    expect(d.action).toBe('fail');
  });

  it('declaredSelectionBackup: per-turn override wins; model falls back to catalog default', () => {
    const bot = { selectionBackupProvider: 'groq', selectionBackupModel: 'm1', model: 'bot-model' };
    expect(declaredSelectionBackup(bot, {})).toEqual({ providerId: 'groq', modelId: 'm1' });
    // A provider-only override keeps the declared model (the part the
    // user didn't override stays as declared).
    expect(declaredSelectionBackup(bot, { selectionBackupProvider: 'claude-subscription' })).toEqual({
      providerId: 'claude-subscription',
      modelId: 'm1',
    });
    expect(declaredSelectionBackup({ model: 'bot-model' }, {})).toBeNull();
  });
});

describe('buildTranscriptReplayMessages', () => {
  it('replays the FULL transcript plus a continuation marker before the final user turn; original untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ];
    const out = buildTranscriptReplayMessages(messages, {
      fromProvider: 'codex-subscription', fromModel: 'gpt-5',
      toProvider: 'backup', toModel: 'backup-model', reason: 'usage limit / quota death',
    });
    expect(messages).toHaveLength(4); // not mutated
    expect(out).toHaveLength(5);
    const texts = out.map((m) => m.content);
    expect(texts).toContain('first question');
    expect(texts).toContain('first answer');
    expect(texts).toContain('second question');
    const markerIdx = texts.findIndex((t) => t.includes(TRANSCRIPT_REPLAY_MARKER));
    expect(markerIdx).toBeGreaterThan(0);
    expect(markerIdx).toBeLessThan(texts.indexOf('second question'));
    expect(texts[markerIdx]).toContain('do not restart from scratch');
  });
});

// ---- Runtime integration ---------------------------------------------------

class FakeGateway implements GovernanceGateway {
  readonly audits: Array<{ type: string }> = [];
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(): Promise<{ decision: GovernanceDecision }> { return { decision: 'allow' }; }
  async awaitDecision(): Promise<'approved' | 'denied'> { return 'approved'; }
  decide(): void {}
  audit(entry: { type: string }): void { this.audits.push({ type: entry.type }); }
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ model: string; messages: ChatMessage[] }> = [];
  constructor(
    readonly providerId: string,
    private readonly behavior: (callIndex: number) => { content: string } | Error,
  ) {}
  async chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    opts: { model: string },
  ): Promise<{ content: string; toolCalls: never[]; usage: TokenUsage }> {
    this.calls.push({ model: opts.model, messages: [...messages] });
    const out = this.behavior(this.calls.length - 1);
    if (out instanceof Error) throw out;
    return { content: out.content, toolCalls: [], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
  }
  async listModels(): Promise<ModelInfo[]> { return [{ id: 'm', name: 'M' }]; }
}

function makeRuntime(providers: Map<string, LLMProvider>, cooldowns: BridgeCooldownRegistry): AgentRuntime {
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
    defaultProviderId: 'codex-subscription',
    bridgeCooldowns: cooldowns,
  });
}

function bridgeBot(extra: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-a1', name: 'A1 Bot', description: 'test', systemPrompt: 'You are a test bot.',
    provider: 'codex-subscription', model: 'gpt-5',
    skills: [], tools: [], mcpServers: [],
    ...extra,
  };
}

/** Scripted providers don't stream tokens; the durable session transcript is the proof of what a turn produced. */
async function sessionText(rt: AgentRuntime, sessionId: string): Promise<string> {
  return (await rt.sessionStore.getMessages(sessionId)).map((m) => m.content).join('\n');
}

describe('runtime: mid-job swap with transcript replay', () => {
  it('auto lane: quota death mid-job → backup receives the prior turns + replay marker and completes; death is recorded in cooldown', async () => {
    const cooldowns = new BridgeCooldownRegistry({});
    const primary = new ScriptedProvider('codex-subscription', (i) => (i === 0 ? { content: 'first answer' } : quotaError()));
    const backup = new ScriptedProvider('backup', () => ({ content: 'continued on backup' }));
    const rt = makeRuntime(new Map([['codex-subscription', primary], ['backup', backup]]), cooldowns);
    const bot = bridgeBot({ backupProvider: 'backup', backupModel: 'backup-model' });

    const ev1: StreamEvent[] = [];
    await rt.runTurn({ bot, message: 'first question', sessionId: 'swap-auto', onEvent: (e) => { ev1.push(e); } });
    expect(await sessionText(rt, 'swap-auto')).toContain('first answer');

    const ev2: StreamEvent[] = [];
    await rt.runTurn({ bot, message: 'second question', sessionId: 'swap-auto', onEvent: (e) => { ev2.push(e); } });
    expect(await sessionText(rt, 'swap-auto')).toContain('continued on backup');
    expect(ev2.some((e) => e.type === 'error')).toBe(false);
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(1);
    const replayed = backup.calls[0]!.messages.map((m) => m.content).join('\n');
    expect(replayed).toContain('first question');
    expect(replayed).toContain('first answer');
    expect(replayed).toContain('second question');
    expect(replayed).toContain(TRANSCRIPT_REPLAY_MARKER);
    expect(ev2.filter((e) => e.type === 'failover')).toHaveLength(1);
    // The quota death landed in the cooldown registry for (codex, default).
    expect(cooldowns.check('codex', 'default').active).toBe(true);
    expect(cooldowns.check('codex', 'default').entry?.family).toBe('rate_limit');

    // Next turn: the cooled primary is SKIPPED at resolution (not retried
    // blindly) — the turn starts on the backup, primary not called again.
    const ev3: StreamEvent[] = [];
    await rt.runTurn({ bot, message: 'third question', sessionId: 'swap-auto', onEvent: (e) => { ev3.push(e); } });
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(2);
    expect(ev3.some((e) => e.type === 'error')).toBe(false);
    const fo = ev3.filter((e) => e.type === 'failover');
    expect(fo).toHaveLength(1);
    expect((fo[0] as { reason?: string }).reason).toBe('bridge-cooldown');
    rt.close();
  });

  it('explicit + quota death + no declared backup → loud refusal; ZERO calls to backup or the free lane', async () => {
    const cooldowns = new BridgeCooldownRegistry({});
    const primary = new ScriptedProvider('codex-subscription', () => quotaError());
    const backup = new ScriptedProvider('backup', () => ({ content: 'must not run' }));
    const ovh = new ScriptedProvider('ovh-anonymous', () => ({ content: 'must not run' }));
    const rt = makeRuntime(new Map([['codex-subscription', primary], ['backup', backup], ['ovh-anonymous', ovh]]), cooldowns);
    const bot = bridgeBot({ backupProvider: 'backup', backupModel: 'backup-model' });
    const err = await rt.runTurn({
      bot, message: 'hello', sessionId: 'swap-explicit-refuse',
      providerId: 'codex-subscription', model: 'gpt-5',
      explicitSelection: true, selectedProviderId: 'codex-subscription', selectedModel: 'gpt-5',
      onEvent: () => undefined,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSelectionRefusedError);
    expect((err as Error).message).toMatch(/You picked/);
    expect((err as Error).message).toMatch(/quota death/);
    expect((err as Error).message).toMatch(/Nothing was sent to a different model/);
    expect(primary.calls).toHaveLength(1);
    expect(backup.calls).toHaveLength(0);
    expect(ovh.calls).toHaveLength(0);
    rt.close();
  });

  it('explicit + declared backup → swap to EXACTLY that backup (bot auto backup is a decoy, never called), transcript replayed', async () => {
    const cooldowns = new BridgeCooldownRegistry({});
    const primary = new ScriptedProvider('codex-subscription', (i) => (i === 0 ? { content: 'first answer' } : quotaError()));
    const declared = new ScriptedProvider('backup', () => ({ content: 'continued on declared backup' }));
    const decoy = new ScriptedProvider('decoy', () => ({ content: 'must not run' }));
    const ovh = new ScriptedProvider('ovh-anonymous', () => ({ content: 'must not run' }));
    const rt = makeRuntime(
      new Map([['codex-subscription', primary], ['backup', declared], ['decoy', decoy], ['ovh-anonymous', ovh]]),
      cooldowns,
    );
    const bot = bridgeBot({
      backupProvider: 'decoy', backupModel: 'decoy-model',
      selectionBackupProvider: 'backup', selectionBackupModel: 'backup-model',
    });
    const ev1: StreamEvent[] = [];
    await rt.runTurn({
      bot, message: 'first question', sessionId: 'swap-explicit-declared',
      providerId: 'codex-subscription', model: 'gpt-5',
      explicitSelection: true, selectedProviderId: 'codex-subscription', selectedModel: 'gpt-5',
      onEvent: (e) => { ev1.push(e); },
    });
    expect(await sessionText(rt, 'swap-explicit-declared')).toContain('first answer');
    const ev2: StreamEvent[] = [];
    await rt.runTurn({
      bot, message: 'second question', sessionId: 'swap-explicit-declared',
      providerId: 'codex-subscription', model: 'gpt-5',
      explicitSelection: true, selectedProviderId: 'codex-subscription', selectedModel: 'gpt-5',
      onEvent: (e) => { ev2.push(e); },
    });
    expect(await sessionText(rt, 'swap-explicit-declared')).toContain('continued on declared backup');
    expect(declared.calls).toHaveLength(1);
    expect(declared.calls[0]!.model).toBe('backup-model');
    const replayed = declared.calls[0]!.messages.map((m) => m.content).join('\n');
    expect(replayed).toContain('first question');
    expect(replayed).toContain('first answer');
    expect(replayed).toContain(TRANSCRIPT_REPLAY_MARKER);
    expect(decoy.calls).toHaveLength(0);
    expect(ovh.calls).toHaveLength(0);
    rt.close();
  });

  it('explicit + primary already in cooldown at turn start + no declared backup → refusal before ANY provider call', async () => {
    const cooldowns = new BridgeCooldownRegistry({});
    cooldowns.recordFailure('codex', 'default', quotaError());
    const primary = new ScriptedProvider('codex-subscription', () => ({ content: 'must not run' }));
    const backup = new ScriptedProvider('backup', () => ({ content: 'must not run' }));
    const rt = makeRuntime(new Map([['codex-subscription', primary], ['backup', backup]]), cooldowns);
    const bot = bridgeBot({ backupProvider: 'backup', backupModel: 'backup-model' });
    const err = await rt.runTurn({
      bot, message: 'hello', sessionId: 'swap-explicit-cooled',
      providerId: 'codex-subscription', model: 'gpt-5',
      explicitSelection: true, selectedProviderId: 'codex-subscription', selectedModel: 'gpt-5',
      onEvent: () => undefined,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSelectionRefusedError);
    expect((err as Error).message).toMatch(/cooldown/);
    expect(primary.calls).toHaveLength(0);
    expect(backup.calls).toHaveLength(0);
    rt.close();
  });

  it('auto + primary AND backup both in cooldown → turn fails with the cooled reason visible; neither backend is called', async () => {
    const cooldowns = new BridgeCooldownRegistry({});
    cooldowns.recordFailure('codex', 'default', quotaError());
    cooldowns.recordFailure('claude', 'default', quotaError());
    const primary = new ScriptedProvider('codex-subscription', () => ({ content: 'must not run' }));
    const backup = new ScriptedProvider('claude-subscription', () => ({ content: 'must not run' }));
    const rt = makeRuntime(new Map([['codex-subscription', primary], ['claude-subscription', backup]]), cooldowns);
    const bot = bridgeBot({ backupProvider: 'claude-subscription', backupModel: 'sonnet' });
    const err = await rt.runTurn({
      bot, message: 'hello', sessionId: 'swap-auto-cooled',
      onEvent: () => undefined,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/cooldown/);
    expect(primary.calls).toHaveLength(0);
    expect(backup.calls).toHaveLength(0);
    rt.close();
  });
});
