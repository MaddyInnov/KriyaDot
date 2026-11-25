// SPDX-License-Identifier: Apache-2.0
// Opt-in policy snapshot mode (#70) at the adapter: when a bot opts in
// via `policy.policySnapshot: true`, the session's effective policy is
// captured at its first evaluation and mid-session edits do NOT change
// outcomes for that session (they apply from the next session).
// Without the flag, evaluation stays live (KriyaDot's default).

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { GovernanceAdapter } from '../src/governance-adapter.js';
import type { BotConfig, ToolContext } from '@mvp/agent-runtime';

function makeRig(bot: BotConfig) {
  const real = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
  const byId = new Map([[bot.id, bot]]);
  const adapter = new GovernanceAdapter(real, {
    getBotConfig: (id) => byId.get(id),
    globalPolicy: DEFAULT_POLICY,
  });
  return { adapter, byId };
}

function snapBot(): BotConfig {
  return {
    id: 'snap-bot',
    name: 'snap-bot',
    provider: 'groq',
    model: 'test',
    skills: [],
    tools: [],
    mcpServers: [],
    policy: {
      policySnapshot: true,
      rules: [{ id: 'deny-write', toolPattern: '^write_file$', effect: 'deny', reason: 'locked at capture' }],
    },
  } as BotConfig;
}

const call = { id: 'c1', name: 'write_file', args: { path: 'a.txt' } };
const ctx = (sessionId: string): ToolContext => ({ sessionId, botId: 'snap-bot' }) as ToolContext;

describe('policy snapshot mode (#70)', () => {
  it('captures on first evaluation; mid-session policy edits do not apply to that session', async () => {
    const bot = snapBot();
    const { adapter, byId } = makeRig(bot);
    const first = await adapter.evaluate(call, ctx('s1'));
    expect(first.decision).toBe('deny');
    const snap = adapter.policySnapshotForSession('s1');
    expect(snap).toBeDefined();
    expect(snap!.hash).toMatch(/^[0-9a-f]{64}$/);

    // Mid-session edit: the operator loosens the bot's rules.
    byId.set('snap-bot', {
      ...bot,
      policy: { policySnapshot: true, rules: [{ id: 'allow-write', toolPattern: '^write_file$', effect: 'allow' }] },
    } as BotConfig);
    const second = await adapter.evaluate(call, ctx('s1'));
    expect(second.decision).toBe('deny'); // snapshot still governs s1

    // A NEW session captures the edited policy.
    const third = await adapter.evaluate(call, ctx('s2'));
    expect(third.decision).toBe('allow');
    expect(adapter.policySnapshotForSession('s2')!.hash).not.toBe(snap!.hash);
  });

  it('default (no opt-in): edits apply immediately — live evaluation', async () => {
    const bot = snapBot();
    bot.policy = { rules: bot.policy!.rules }; // same rules, flag removed
    const { adapter, byId } = makeRig(bot);
    const first = await adapter.evaluate(call, ctx('s1'));
    expect(first.decision).toBe('deny');
    expect(adapter.policySnapshotForSession('s1')).toBeUndefined();
    byId.set('snap-bot', {
      ...bot,
      policy: { rules: [{ id: 'allow-write', toolPattern: '^write_file$', effect: 'allow' }] },
    } as BotConfig);
    const second = await adapter.evaluate(call, ctx('s1'));
    expect(second.decision).toBe('allow');
  });
});

describe('sweep 2026-11-25: plan verification follows the same policy as execution', () => {
  it('A-D9: simulatePolicy + planSpecsForBot use the session snapshot when a sessionId is given', async () => {
    const bot = snapBot();
    bot.policy = {
      policySnapshot: true,
      rules: [{ id: 'deny-write', toolPattern: '^write_file$', effect: 'deny', reason: 'locked at capture' }],
      planSpecs: [{
        type: 'provenance', id: 'cap-spec', toolPattern: '^delete_file$', arg: 'path',
        sourceToolPattern: '^list_folder$', sourceArg: 'paths',
      }],
    } as BotConfig['policy'];
    const { adapter, byId } = makeRig(bot);
    await adapter.evaluate(call, ctx('s1')); // captures the snapshot

    // Mid-session edit: loosen rules AND replace the specs.
    byId.set('snap-bot', {
      ...bot,
      policy: {
        policySnapshot: true,
        rules: [{ id: 'allow-write', toolPattern: '^write_file$', effect: 'allow' }],
        planSpecs: [],
      },
    } as BotConfig);

    // With the session id: frozen policy — deny stands, captured spec returned.
    const frozen = await adapter.simulatePolicy('snap-bot', 'write_file', { path: 'a.txt' }, undefined, 's1');
    expect(frozen.effect).toBe('deny');
    expect(adapter.planSpecsForBot('snap-bot', 's1').map((s) => s.id)).toEqual(['cap-spec']);
    // Without it: live policy — allow, no specs.
    const live = await adapter.simulatePolicy('snap-bot', 'write_file', { path: 'a.txt' });
    expect(live.effect).toBe('allow');
    expect(adapter.planSpecsForBot('snap-bot')).toEqual([]);
  });

  it('A-D4: the workspace policy file scope wins over bot config (same layering as rules/specs)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const ws = mkdtempSync(join(tmpdir(), 'kriyadot-ws-scope-'));
    mkdirSync(join(ws, '.kriyadot'), { recursive: true });
    writeFileSync(join(ws, '.kriyadot', 'policy.json'), JSON.stringify({ planVerificationScope: 'off' }));
    const bot = snapBot();
    bot.policy = { rules: [], planVerificationScope: 'all' } as BotConfig['policy'];
    const real = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const adapter = new GovernanceAdapter(real, {
      getBotConfig: () => bot,
      globalPolicy: DEFAULT_POLICY,
      workspaceDirForBot: () => ws,
    });
    // The workspace "off" (project-level opt-out) beats the bot's "all".
    expect(adapter.planVerificationScopeForBot('snap-bot')).toBe('off');
    // A workspace with no scope falls through to the bot config.
    const ws2 = mkdtempSync(join(tmpdir(), 'kriyadot-ws-scope-'));
    const adapter2 = new GovernanceAdapter(real, {
      getBotConfig: () => bot,
      globalPolicy: DEFAULT_POLICY,
      workspaceDirForBot: () => ws2,
    });
    expect(adapter2.planVerificationScopeForBot('snap-bot')).toBe('all');
  });
});
