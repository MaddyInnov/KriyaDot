// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamStore, buildCoordinatorPrompt } from '../src/teams.js';
import { createDelegateTools } from '../src/tools/delegate.js';
import type { SubagentSpawnFn, SubagentSpawnInput } from '../src/subagents.js';
import type { ToolContext } from '../src/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-teams-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TeamStore', () => {
  it('creates, lists, gets, and deletes teams', () => {
    const store = new TeamStore(dir);
    expect(store.listTeams()).toEqual([]);

    const team = store.createTeam('  Research crew ', 'coordinator', ['coder', 'coder', 'researcher']);
    expect(team.name).toBe('Research crew');
    expect(team.memberBotIds).toEqual(['coder', 'researcher']); // deduped
    expect(team.coordinatorBotId).toBe('coordinator');

    const reopened = new TeamStore(dir);
    expect(reopened.listTeams()).toHaveLength(1);
    expect(reopened.getTeam(team.id)?.name).toBe('Research crew');
    expect(reopened.getTeam('missing')).toBeUndefined();

    expect(reopened.deleteTeam(team.id)).toBe(true);
    expect(reopened.deleteTeam(team.id)).toBe(false);
    expect(reopened.listTeams()).toEqual([]);
    store.close();
    reopened.close();
  });

  it('tracks run lifecycle: start → steps → done', () => {
    const store = new TeamStore(dir);
    const team = store.createTeam('T', 'coord', ['m1']);
    const run = store.startRun(team.id, 'do the thing');
    expect(run.status).toBe('running');
    expect(run.steps).toEqual([]);

    store.updateRun(run.id, {
      steps: [{ memberBotId: 'm1', memberName: 'M1', task: 'subtask', done: true, summary: 'did it' }],
    });
    const finished = store.updateRun(run.id, { status: 'done', result: 'all done' });
    expect(finished?.status).toBe('done');
    expect(finished?.result).toBe('all done');
    expect(finished?.steps).toHaveLength(1);
    expect(finished?.finishedAt).toBeGreaterThan(0);

    const failed = store.startRun(team.id, 'fail me');
    store.updateRun(failed.id, { status: 'failed', error: 'boom' });
    expect(store.getRun(failed.id)?.error).toBe('boom');

    expect(store.listRuns(team.id)).toHaveLength(2);
    expect(store.listRuns(team.id)[0].createdAt).toBeGreaterThanOrEqual(store.listRuns(team.id)[1].createdAt);
    expect(store.updateRun('missing', { status: 'done' })).toBeUndefined();
    expect(store.deleteTeam(team.id)).toBe(true);
    expect(store.listRuns(team.id)).toEqual([]); // runs cascade
    store.close();
  });
});

describe('buildCoordinatorPrompt', () => {
  it('includes roster, task, and delegate instructions', () => {
    const prompt = buildCoordinatorPrompt({
      teamName: 'Crew',
      coordinatorName: 'Boss',
      members: [
        { id: 'coder', name: 'Coder', description: 'writes code' },
        { id: 'researcher', name: 'Researcher', description: '' },
      ],
      task: 'Ship the feature',
    });
    expect(prompt).toContain('Crew');
    expect(prompt).toContain('Boss');
    expect(prompt).toContain('- coder ("Coder"): writes code');
    expect(prompt).toContain('- researcher ("Researcher"): general-purpose member');
    expect(prompt).toContain('Ship the feature');
    expect(prompt).toContain('"bot"');
    expect(prompt).toContain('delegate');
  });
});

describe('delegate bot param (AgentTeams assignment)', () => {
  const ctx: ToolContext = { sessionId: 'sess-parent', botId: 'bot-parent' };

  function stubSpawn() {
    const calls: SubagentSpawnInput[] = [];
    const spawn: SubagentSpawnFn = async (input) => {
      calls.push(input);
      return { result: 'ok', sessionId: 'child-1' };
    };
    return { spawn, calls };
  }

  it('passes the bot override through to spawn', async () => {
    const { spawn, calls } = stubSpawn();
    const [tool] = createDelegateTools({ spawn });
    // returnMode 'conclusion' isolates the bot-override mechanics from
    // the evidence-only delegation default (2026-11-25).
    const out = (await tool!.handler({ task: 'subtask', bot: 'member-bot', returnMode: 'conclusion' }, ctx)) as { result: string };
    expect(out.result).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.botId).toBe('member-bot');
  });

  it('defaults to the caller bot when bot is omitted', async () => {
    const { spawn, calls } = stubSpawn();
    const [tool] = createDelegateTools({ spawn });
    await tool!.handler({ task: 'subtask' }, ctx);
    expect(calls[0]!.botId).toBe('bot-parent');
  });

  it('ignores blank bot overrides', async () => {
    const { spawn, calls } = stubSpawn();
    const [tool] = createDelegateTools({ spawn });
    await tool!.handler({ task: 'subtask', bot: '   ' }, ctx);
    expect(calls[0]!.botId).toBe('bot-parent');
  });
});
