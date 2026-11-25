// SPDX-License-Identifier: Apache-2.0
// Tests for the `delegate` tool factory:
// - schema shape (name, required args, safety documentation in description)
// - handler calls the injected spawn with task / parentSessionId / botId
// - explicit tool subsets pass through, but `delegate` is always stripped
// - nesting past the depth limit is blocked (store present) and spawn is
//   never called

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDelegateTools } from '../src/tools/delegate.js';
import type { SubagentSpawnFn, SubagentSpawnInput } from '../src/subagents.js';
import { SubagentStore } from '../src/subagent-store.js';
import type { ToolContext } from '../src/types.js';

let dir: string;
let store: SubagentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-delegate-'));
  store = new SubagentStore(join(dir, 'subagents.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctx: ToolContext = { sessionId: 'sess-parent', botId: 'bot-parent' };

function stubSpawn(overrides?: Partial<Awaited<ReturnType<SubagentSpawnFn>>>) {
  const calls: SubagentSpawnInput[] = [];
  const spawn: SubagentSpawnFn = vi.fn(async (input) => {
    calls.push(input);
    return { result: 'child result', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, ...overrides };
  });
  return { calls, spawn };
}

describe('createDelegateTools', () => {
  it('registers a single `delegate` tool with the documented schema', () => {
    const [tool] = createDelegateTools({ spawn: stubSpawn().spawn, store })!;
    expect(tool!.name).toBe('delegate');
    const params = tool!.parameters as { required: string[]; properties: Record<string, unknown> };
    expect(params.required).toEqual(['task']);
    expect(Object.keys(params.properties)).toEqual(['task', 'tools', 'bot', 'via']);
    // the description documents the safety contract
    expect(tool!.description).toMatch(/approval/i);
    expect(tool!.description).toMatch(/same governance/i);
    expect(tool!.description).toMatch(/2 deep|nest/);
  });

  it('calls the injected spawn with task, botId and parentSessionId', async () => {
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    const out = (await tool!.handler({ task: 'research rivals' }, ctx)) as {
      result: string;
      subagentId: string;
    };
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      botId: 'bot-parent',
      parentSessionId: 'sess-parent',
    });
    // Delegation-safety default (2026-11-25): the spawned task carries
    // the original task plus the evidence-only return instruction, and
    // the result comes back framed as evidence for the parent to judge.
    expect(calls[0]!.task.startsWith('research rivals')).toBe(true);
    expect(calls[0]!.task).toContain('EVIDENCE-ONLY RETURN MODE');
    // tools omitted -> undefined, so the host defaults to parent-tools-minus-delegate
    expect(calls[0]!.tools).toBeUndefined();
    expect(out.result).toContain('child result');
    expect(out.result).toContain('EVIDENCE-ONLY RESULT');
    expect(out.subagentId).toMatch(/^sub_/);

    // parent/child record exists
    const kids = store.listByParent('sess-parent');
    expect(kids).toHaveLength(1);
    expect(kids[0]!.status).toBe('done');
    expect(kids[0]!.parentBotId).toBe('bot-parent');
  });

  it('passes explicit tool subsets through but always strips `delegate`', async () => {
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    await tool!.handler(
      { task: 'look things up', tools: ['web_search', 'delegate', 'read_file'] },
      ctx,
    );
    expect(calls[0]!.tools).toEqual(['web_search', 'read_file']);
  });

  it('rejects an empty task', async () => {
    const [tool] = createDelegateTools({ spawn: stubSpawn().spawn, store })!;
    await expect(tool!.handler({ task: '   ' }, ctx)).rejects.toThrow(/non-empty/);
    await expect(tool!.handler({}, ctx)).rejects.toThrow(/non-empty/);
  });

  it('blocks delegation past the depth limit without calling spawn', async () => {
    // sess-parent -> child (depth 1) -> grandchild (depth 2): grandchild is at the limit.
    store.spawnChild({ sessionId: 'child', parentSessionId: 'sess-parent', parentBotId: 'b', task: 't' });
    store.spawnChild({ sessionId: 'grand', parentSessionId: 'child', parentBotId: 'b', task: 't' });

    const { spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn, store })!;
    const deepCtx: ToolContext = { sessionId: 'grand', botId: 'b' };
    await expect(tool!.handler({ task: 'one too deep' }, deepCtx)).rejects.toThrow(/nesting limit/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still spawns when no store is wired (depth unenforced — documented fallback)', async () => {
    const { calls, spawn } = stubSpawn();
    const [tool] = createDelegateTools({ spawn })!;
    const out = (await tool!.handler({ task: 'no store' }, ctx)) as { result: string };
    expect(calls[0]!.parentSessionId).toBe('sess-parent');
    // Evidence-only default applies on this path too (framed result).
    expect(out.result).toContain('child result');
    expect(out.result).toContain('EVIDENCE-ONLY RESULT');
    // no subagentId in the fallback path
    expect((out as { subagentId?: string }).subagentId).toBeUndefined();
  });

  it('propagates spawn failures to the caller', async () => {
    const spawn: SubagentSpawnFn = async () => {
      throw new Error('host blew up');
    };
    const [tool] = createDelegateTools({ spawn, store })!;
    await expect(tool!.handler({ task: 'doomed' }, ctx)).rejects.toThrow('host blew up');
    expect(store.listByParent('sess-parent')[0]!.status).toBe('failed');
  });
});
