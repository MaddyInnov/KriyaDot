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
