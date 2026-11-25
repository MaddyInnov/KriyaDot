// SPDX-License-Identifier: Apache-2.0
// Tests for delegation safety — evidence-only sub-agent returns
// (Workstream 2 of the Agent-Safety Programme):
// - the mode resolver: explicit per-call arg wins, then the delegating
//   bot's policy (per-bot opt-out), then the env flag (global opt-out),
//   and the DEFAULT is 'evidence' since the 2026-11-25 decision
//   (historically 'conclusion' — the flip is what these tests pin);
// - the evidence instruction is appended to the delegated task, verbatim
//   task preserved ahead of it, including the NO EVIDENCE FOUND
//   abstention line;
// - evidence-mode results are framed for the parent (evidence to judge,
//   abstention surfaced — never a silent conclusion);
// - the delegate tool wires the mode through BOTH spawn paths (with and
//   without a SubagentStore) and reports `returnMode` in its result;
// - the advertised tool schema is unchanged (returnMode is a handler-level
//   arg, like profileId — an existing test pins the exact property set).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELEGATE_EVIDENCE_ONLY_ENV,
  EVIDENCE_ONLY_RETURN_INSTRUCTION,
  EVIDENCE_RESULT_FRAMING,
  applyEvidenceOnlyReturn,
  frameEvidenceResult,
  isDelegateEvidenceOnlyEnabled,
  resolveDelegateReturnMode,
} from '../src/delegation-safety.js';
import { createDelegateTools } from '../src/tools/delegate.js';
import type { SubagentSpawnFn, SubagentSpawnInput } from '../src/subagents.js';
import { SubagentStore } from '../src/subagent-store.js';
import type { BotConfig, ToolContext } from '../src/types.js';

const ctx: ToolContext = { sessionId: 'sess-parent', botId: 'bot-parent' };

function stubSpawn() {
  const calls: SubagentSpawnInput[] = [];
  const spawn: SubagentSpawnFn = vi.fn(async (input) => {
    calls.push(input);
    return { result: 'child result', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
  });
  return { calls, spawn };
}

describe('delegation-safety mode resolution', () => {
  it('DEFAULT (2026-11-25): evidence with no arg, no bot policy and no env flag', () => {
    expect(resolveDelegateReturnMode({ env: {} })).toBe('evidence');
    expect(isDelegateEvidenceOnlyEnabled({})).toBe(true);
    // '1'/'true' state the default explicitly; any other non-opt-out
    // value leaves the default in place.
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: '1' })).toBe(true);
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: 'true' })).toBe(true);
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: 'yes' })).toBe(true);
  });

  it("env flag is now the global OPT-OUT: '0'/'false' restore conclusion returns", () => {
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: '0' })).toBe(false);
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: 'false' })).toBe(false);
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: 'FALSE' })).toBe(false);
    expect(resolveDelegateReturnMode({ env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '0' } })).toBe('conclusion');
    expect(resolveDelegateReturnMode({ env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '1' } })).toBe('evidence');
  });

  it('an explicit per-call mode wins over env and bot policy, both ways', () => {
    expect(resolveDelegateReturnMode({ requested: 'evidence', env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '0' } })).toBe('evidence');
    expect(resolveDelegateReturnMode({ requested: 'conclusion', env: {} })).toBe('conclusion');
    expect(
      resolveDelegateReturnMode({ requested: 'conclusion', botDefault: 'evidence', env: {} }),
    ).toBe('conclusion');
    expect(
      resolveDelegateReturnMode({ requested: 'evidence', botDefault: 'conclusion', env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '0' } }),
    ).toBe('evidence');
    // Unknown values fall through to the bot/env/default resolution.
    expect(resolveDelegateReturnMode({ requested: 'bogus', env: {} })).toBe('evidence');
    expect(resolveDelegateReturnMode({ requested: 'bogus', env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '0' } })).toBe('conclusion');
  });

  it("the delegating bot's policy is the per-bot opt-out (beats the env flag, loses to per-call)", () => {
    expect(resolveDelegateReturnMode({ botDefault: 'conclusion', env: {} })).toBe('conclusion');
    expect(
      resolveDelegateReturnMode({ botDefault: 'conclusion', env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '1' } }),
    ).toBe('conclusion');
    expect(
      resolveDelegateReturnMode({ botDefault: 'evidence', env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '0' } }),
    ).toBe('evidence');
    // Unknown bot-policy values fall through.
    expect(resolveDelegateReturnMode({ botDefault: 'bogus', env: {} })).toBe('evidence');
  });

  it('applyEvidenceOnlyReturn appends the instruction and keeps the task', () => {
    const out = applyEvidenceOnlyReturn('research the rivals');
    expect(out.startsWith('research the rivals')).toBe(true);
    expect(out).toContain(EVIDENCE_ONLY_RETURN_INSTRUCTION);
    expect(out).toMatch(/EVIDENCE ONLY/);
    expect(out).toMatch(/Do NOT state a conclusion/);
    // The abstention path is part of the instruction: a child that
    // finds nothing must say so in exactly this shape, never guess.
    expect(out).toMatch(/NO EVIDENCE FOUND/);
  });

  it('frameEvidenceResult frames the result as evidence with an explicit abstention duty', () => {
    const framed = frameEvidenceResult('[record ACC-1] "balance is 10"');
    expect(framed.startsWith(EVIDENCE_RESULT_FRAMING)).toBe(true);
    expect(framed).toContain('[record ACC-1] "balance is 10"');
    expect(framed).toMatch(/NOT a conclusion/);
    expect(framed).toMatch(/say plainly what could not be established/);
  });
});

describe('delegate tool — evidence-only wiring', () => {
  let dir: string;
  let store: SubagentStore;
  const savedEnv = process.env[DELEGATE_EVIDENCE_ONLY_ENV];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mvp-delegation-safety-'));
    store = new SubagentStore(join(dir, 'subagents.db'));
    delete process.env[DELEGATE_EVIDENCE_ONLY_ENV];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[DELEGATE_EVIDENCE_ONLY_ENV];
    else process.env[DELEGATE_EVIDENCE_ONLY_ENV] = savedEnv;
  });

  it('DEFAULT (2026-11-25): spawn receives the evidence instruction, returnMode is evidence, result is framed', async () => {
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    const out = (await tool!.handler({ task: 'research rivals' }, ctx)) as {
      returnMode: string;
      result: string;
    };
    expect(calls[0]!.task.startsWith('research rivals')).toBe(true);
    expect(calls[0]!.task).toContain('EVIDENCE-ONLY RETURN MODE');
    expect(calls[0]!.task).toContain('NO EVIDENCE FOUND');
    expect(out.returnMode).toBe('evidence');
    // The parent sees the abstention framing ahead of the child's text.
    expect(out.result.startsWith('[DELEGATION SAFETY — EVIDENCE-ONLY RESULT]')).toBe(true);
    expect(out.result).toContain('child result');
  });

  it("global opt-out (env '0'): spawn receives the raw task and returnMode is conclusion", async () => {
    process.env[DELEGATE_EVIDENCE_ONLY_ENV] = '0';
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    const out = (await tool!.handler({ task: 'research rivals' }, ctx)) as {
      returnMode: string;
      result: string;
    };
    expect(calls[0]!.task).toBe('research rivals');
    expect(out.returnMode).toBe('conclusion');
    expect(out.result).toBe('child result'); // unframed in conclusion mode
  });

  it("returnMode: 'evidence' appends the evidence instruction (store path)", async () => {
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    const out = (await tool!.handler({ task: 'research rivals', returnMode: 'evidence' }, ctx)) as {
      returnMode: string;
    };
    expect(calls[0]!.task.startsWith('research rivals')).toBe(true);
    expect(calls[0]!.task).toContain('EVIDENCE-ONLY RETURN MODE');
    expect(out.returnMode).toBe('evidence');
  });

  it('default also applies on the no-store path; env flag can state it explicitly', async () => {
    process.env[DELEGATE_EVIDENCE_ONLY_ENV] = '1';
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn })!;
    const out = (await tool!.handler({ task: 'audit the store' }, ctx)) as {
      returnMode: string;
      result: string;
    };
    expect(calls[0]!.task).toContain('EVIDENCE-ONLY RETURN MODE');
    expect(out.returnMode).toBe('evidence');
    expect(out.result).toContain('EVIDENCE-ONLY RESULT');
  });

  it("per-bot opt-out: the delegating bot's policy restores conclusion returns for its spawns", async () => {
    const { calls, spawn } = stubSpawn();
    const getBotConfig = (botId: string): BotConfig | undefined =>
      botId === ctx.botId
        ? ({ id: botId, policy: { rules: [], delegationReturnMode: 'conclusion' } } as unknown as BotConfig)
        : undefined;
    const [tool] = createDelegateTools({ spawn, store, getBotConfig })!;
    const out = (await tool!.handler({ task: 'audit the store' }, ctx)) as {
      returnMode: string;
      result: string;
    };
    expect(calls[0]!.task).toBe('audit the store');
    expect(out.returnMode).toBe('conclusion');
    expect(out.result).toBe('child result');
    // …and a per-call 'evidence' still beats the bot's opt-out.
    const out2 = (await tool!.handler({ task: 'audit the store', returnMode: 'evidence' }, ctx)) as {
      returnMode: string;
    };
    expect(calls[1]!.task).toContain('EVIDENCE-ONLY RETURN MODE');
    expect(out2.returnMode).toBe('evidence');
  });

  it("explicit returnMode: 'conclusion' overrides the env flag", async () => {
    process.env[DELEGATE_EVIDENCE_ONLY_ENV] = '1';
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    const out = (await tool!.handler({ task: 'audit the store', returnMode: 'conclusion' }, ctx)) as {
      returnMode: string;
    };
    expect(calls[0]!.task).toBe('audit the store');
    expect(out.returnMode).toBe('conclusion');
  });

  it('does not change the advertised schema', () => {
    const [tool] = createDelegateTools({ spawn: stubSpawn().spawn, store })!;
    const params = tool!.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(params.properties)).toEqual(['task', 'tools', 'bot', 'via']);
  });
});
