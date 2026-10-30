// SPDX-License-Identifier: Apache-2.0
// CA-21: `kriyadot run --bare` — discovery plan semantics (counting
// loaders prove NOTHING is discovered in bare mode and EVERYTHING is
// without it), CLI forwarding of bare:true on the chat request, and
// the --continue interaction (auto-discovery → usage error in bare).

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { BARE_DISCOVERY_SOURCES, bareModeNote, resolveDiscoveryPlan, runDiscovery } from '../src/bare.js';
import { flagBool } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { CommandDeps } from '../src/commands.js';
import type { ChatEvent } from '../src/api.js';
import { makeDeps, makeFakeApi } from './fake-api.js';

const BOTS = [
  { id: 'helper', name: 'Helper', model: 'llama-3.3-70b' },
  { id: 'coder', name: 'Coder' },
];
const SCRIPT: ChatEvent[] = [
  { type: 'token', content: 'Hi!' },
  { type: 'done', usage: { inputTokens: 3, outputTokens: 1 } },
];

function run(argv: string[], fake = makeFakeApi({ bots: BOTS, chatScript: SCRIPT }), depOpts: Partial<CommandDeps> = {}) {
  const deps = makeDeps(fake, depOpts);
  return runCommand(parseArgs(argv), deps).then((code) => ({ code, deps, fake }));
}

describe('resolveDiscoveryPlan', () => {
  it('bare disables ALL six discovery sources', () => {
    const plan = resolveDiscoveryPlan(true);
    expect(plan.bare).toBe(true);
    expect(plan.skipped).toEqual([...BARE_DISCOVERY_SOURCES]);
    expect(BARE_DISCOVERY_SOURCES).toEqual(['hooks', 'skills', 'commands', 'agents', 'mcp', 'memory']);
    for (const s of BARE_DISCOVERY_SOURCES) expect(plan.enabled[s]).toBe(false);
  });

  it('non-bare enables every source and skips none', () => {
    const plan = resolveDiscoveryPlan(false);
    expect(plan.skipped).toEqual([]);
    for (const s of BARE_DISCOVERY_SOURCES) expect(plan.enabled[s]).toBe(true);
    expect(bareModeNote(plan)).toBeNull();
    expect(bareModeNote(resolveDiscoveryPlan(true))).toContain('auto-discovery disabled');
  });
});

describe('runDiscovery with counting loaders', () => {
  it('invokes EVERY loader without --bare, and NONE with --bare', async () => {
    const counts: Record<string, number> = {};
    const loaders = Object.fromEntries(
      BARE_DISCOVERY_SOURCES.map((s) => [
        s,
        () => {
          counts[s] = (counts[s] ?? 0) + 1;
          return `${s}-result`;
        },
      ]),
    );

    const active = await runDiscovery(resolveDiscoveryPlan(false), loaders);
    expect(Object.keys(active).sort()).toEqual([...BARE_DISCOVERY_SOURCES].sort());
    for (const s of BARE_DISCOVERY_SOURCES) expect(counts[s]).toBe(1);

    const bare = await runDiscovery(resolveDiscoveryPlan(true), loaders);
    expect(bare).toEqual({});
    // Counts unchanged: bare mode invoked zero loaders.
    for (const s of BARE_DISCOVERY_SOURCES) expect(counts[s]).toBe(1);
  });
});

describe('kriyadot run --bare (CLI integration, fake API)', () => {
  it('parses --bare as a run flag', () => {
    const p = parseArgs(['run', '--bot', 'coder', '--message', 'x', '--bare']);
    expect(flagBool(p.flags, 'bare')).toBe(true);
    const q = parseArgs(['run', '--bot', 'coder', '--message', 'x']);
    expect(flagBool(q.flags, 'bare')).toBe(false);
  });

  it('forwards bare:true on the chat request and notes the mode on stderr', async () => {
    const { code, deps, fake } = await run(['run', '--bot', 'coder', '--message', 'list files', '--bare']);
    expect(code).toBe(0);
    expect(fake.chatRequests).toHaveLength(1);
    expect(fake.chatRequests[0]!.bare).toBe(true);
    expect(deps.stderrText()).toContain('[bare] auto-discovery disabled');
    expect(deps.stderrText()).toContain('hooks, skills, commands, agents, mcp, memory');
  });

  it('without --bare the chat request carries no bare flag and no note', async () => {
    const { code, deps, fake } = await run(['run', '--bot', 'coder', '--message', 'list files']);
    expect(code).toBe(0);
    expect(fake.chatRequests[0]!.bare).toBeUndefined();
    expect(deps.stderrText()).not.toContain('[bare]');
  });

  it('--bare --continue is a usage error (exit 2): most-recent-session lookup is discovery', async () => {
    const { code, deps, fake } = await run(['run', '--bot', 'coder', '--message', 'x', '--bare', '--continue']);
    expect(code).toBe(2);
    expect(deps.stderrText()).toContain('--bare');
    expect(deps.stderrText()).toContain('--session <id>');
    expect(fake.chatRequests).toHaveLength(0);
  });

  it('--continue without --bare resolves the most recent session via discovery', async () => {
    const fake = makeFakeApi({
      bots: BOTS,
      chatScript: SCRIPT,
      threads: [{ id: 'thread-9', botId: 'coder', title: 'Earlier', lastMessageTs: '2026-10-30T00:00:00.000Z' } as never],
    });
    const { code, deps } = await run(['run', '--bot', 'coder', '--message', 'x', '--continue'], fake);
    expect(code).toBe(0);
    expect(fake.chatRequests[0]!.sessionId).toBe('thread-9');
    expect(deps.stderrText()).toContain('continuing');
  });
});
