// SPDX-License-Identifier: Apache-2.0
// Tests for delegation safety — evidence-only sub-agent returns
// (Workstream 2 of the Agent-Safety Programme):
// - the mode resolver: explicit per-call arg wins, env flag is the host
//   default, and the historical default is 'conclusion' (flag OFF);
// - the evidence instruction is appended to the delegated task, verbatim
//   task preserved ahead of it;
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
  applyEvidenceOnlyReturn,
  isDelegateEvidenceOnlyEnabled,
  resolveDelegateReturnMode,
} from '../src/delegation-safety.js';
import { createDelegateTools } from '../src/tools/delegate.js';
import type { SubagentSpawnFn, SubagentSpawnInput } from '../src/subagents.js';
import { SubagentStore } from '../src/subagent-store.js';
import type { ToolContext } from '../src/types.js';

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
  it('defaults to conclusion with no arg and no env flag', () => {
    expect(resolveDelegateReturnMode({ env: {} })).toBe('conclusion');
    expect(isDelegateEvidenceOnlyEnabled({})).toBe(false);
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: '0' })).toBe(false);
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: 'yes' })).toBe(false);
  });

  it('env flag enables evidence mode as the host default', () => {
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: '1' })).toBe(true);
    expect(isDelegateEvidenceOnlyEnabled({ [DELEGATE_EVIDENCE_ONLY_ENV]: 'true' })).toBe(true);
    expect(resolveDelegateReturnMode({ env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '1' } })).toBe('evidence');
  });

  it('an explicit per-call mode wins over the env flag both ways', () => {
    expect(resolveDelegateReturnMode({ requested: 'evidence', env: {} })).toBe('evidence');
    expect(
      resolveDelegateReturnMode({ requested: 'conclusion', env: { [DELEGATE_EVIDENCE_ONLY_ENV]: '1' } }),
    ).toBe('conclusion');
    // Unknown values fall through to the env/default resolution.
    expect(resolveDelegateReturnMode({ requested: 'bogus', env: {} })).toBe('conclusion');
  });

  it('applyEvidenceOnlyReturn appends the instruction and keeps the task', () => {
    const out = applyEvidenceOnlyReturn('research the rivals');
    expect(out.startsWith('research the rivals')).toBe(true);
    expect(out).toContain(EVIDENCE_ONLY_RETURN_INSTRUCTION);
    expect(out).toMatch(/EVIDENCE ONLY/);
    expect(out).toMatch(/Do NOT state a conclusion/);
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

  it('default (flag off): spawn receives the raw task and returnMode is conclusion', async () => {
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    const out = (await tool!.handler({ task: 'research rivals' }, ctx)) as { returnMode: string };
    expect(calls[0]!.task).toBe('research rivals');
    expect(out.returnMode).toBe('conclusion');
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

  it('env flag defaults spawns to evidence mode (no-store path)', async () => {
    process.env[DELEGATE_EVIDENCE_ONLY_ENV] = '1';
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn })!;
    const out = (await tool!.handler({ task: 'audit the store' }, ctx)) as { returnMode: string };
    expect(calls[0]!.task).toContain('EVIDENCE-ONLY RETURN MODE');
    expect(out.returnMode).toBe('evidence');
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
