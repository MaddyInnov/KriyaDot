// SPDX-License-Identifier: Apache-2.0
// Item 12: team-library instantiation (injected create fns stubbed) and
// the Chief default watch bootstrap (real RoutineStore in a temp dir).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTeamManifest, type BotConfig, type Team } from '@mvp/agent-runtime';
import { RoutineStore } from '../src/bot-routines.js';
import {
  ensureChiefDefaultWatch,
  readChiefWatchFlag,
  setChiefWatchOptOut,
  CHIEF_WATCH_ROUTINE_NAME,
} from '../src/chief-default-watch.js';
import { TeamLibraryError, TeamLibraryService } from '../src/team-library-service.js';

function bot(id: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

function manifestFixture() {
  const coordinator = bot('coord-1');
  const members = [bot('member-1'), bot('member-2')];
  const team: Team = {
    id: 'team-1',
    name: 'Research Team',
    coordinatorBotId: 'coord-1',
    memberBotIds: ['member-1', 'member-2'],
    createdAt: 1700000000000,
    delegationPolicy: 'always-ask',
    delegationPolicyOverrides: { 'member-2': 'always-allow' },
  };
  return buildTeamManifest({ team, coordinator, members });
}

describe('TeamLibraryService.instantiate', () => {
  it('creates all bots then the team with manifest coordination rules', async () => {
    const manifest = manifestFixture();
    const createdBots: string[] = [];
    const audits: string[] = [];
    const service = new TeamLibraryService({
      getEntry: (id) => (id === 'lib-1' ? { id, kind: 'team', name: 'Research Team', payload: manifest } : undefined),
      botExists: () => false,
      createBot: (b) => void createdBots.push(b.id),
      createTeam: (input) => ({
        id: 'team-new',
        name: input.name,
        coordinatorBotId: input.coordinatorBotId,
        memberBotIds: input.memberBotIds,
        createdAt: Date.now(),
        delegationPolicy: input.delegationPolicy,
        delegationPolicyOverrides: input.delegationPolicyOverrides,
      }),
      audit: (action) => void audits.push(action),
    });
    const out = await service.instantiate('lib-1');
    expect(createdBots).toEqual(['coord-1', 'member-1', 'member-2']);
    expect(out.createdBotIds).toEqual(createdBots);
    expect(out.team).toMatchObject({
      name: 'Research Team',
      coordinatorBotId: 'coord-1',
      memberBotIds: ['member-1', 'member-2'],
      delegationPolicy: 'always-ask',
      delegationPolicyOverrides: { 'member-2': 'always-allow' },
    });
    expect(audits).toEqual(['team_library.instantiated']);
  });

  it('skips bots that already exist instead of overwriting them', async () => {
    const manifest = manifestFixture();
    const createdBots: string[] = [];
    const service = new TeamLibraryService({
      getEntry: () => ({ id: 'lib-1', kind: 'team', name: 'x', payload: manifest }),
      botExists: (id) => id === 'member-1',
      createBot: (b) => void createdBots.push(b.id),
      createTeam: (input) => ({
        id: 't',
        name: input.name,
        coordinatorBotId: input.coordinatorBotId,
        memberBotIds: input.memberBotIds,
        createdAt: 0,
      }),
    });
    const out = await service.instantiate('lib-1');
    expect(out.createdBotIds).toEqual(['coord-1', 'member-2']);
    expect(out.skippedBotIds).toEqual(['member-1']);
    expect(out.team.memberBotIds).toEqual(['member-1', 'member-2']); // team still references the existing bot
  });

  it('rejects unknown entries, non-team kinds and invalid manifests', async () => {
    const service = new TeamLibraryService({
      getEntry: (id) =>
        id === 'lib-skill'
          ? { id, kind: 'skill', name: 's', payload: {} }
          : id === 'lib-bad'
            ? { id, kind: 'team', name: 't', payload: { nope: true } }
            : undefined,
      createBot: () => undefined,
      createTeam: () => {
        throw new Error('must not be called');
      },
    });
    await expect(service.instantiate('ghost')).rejects.toThrow(TeamLibraryError);
    await expect(service.instantiate('lib-skill')).rejects.toThrow(/not a team/);
    await expect(service.instantiate('lib-bad')).rejects.toThrow(/not carry a valid team manifest/);
  });
});

describe('ensureChiefDefaultWatch', () => {
  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'chief-watch-'));
    const routines = new RoutineStore(dataDir);
    return { dataDir, routines };
  }

  it('creates exactly one daily watch routine for the Chief, once', () => {
    const { dataDir, routines } = setup();
    const deps = { dataDir, routines, getChiefBotId: () => 'chief-1' };
    const first = ensureChiefDefaultWatch(deps);
    expect(first.created).toBe(true);
    if (first.created) {
      expect(first.routine.name).toBe(CHIEF_WATCH_ROUTINE_NAME);
      expect(first.routine.botId).toBe('chief-1');
      expect(first.routine.schedule?.kind).toBe('daily');
      expect(first.routine.enabled).toBe(true);
    }
    const second = ensureChiefDefaultWatch(deps);
    expect(second).toMatchObject({ created: false, reason: 'exists' });
    expect(routines.list().filter((r) => r.name === CHIEF_WATCH_ROUTINE_NAME)).toHaveLength(1);
    expect(readChiefWatchFlag(dataDir).routineId).toBeDefined();
  });

  it('does nothing when there is no Chief', () => {
    const { dataDir, routines } = setup();
    const out = ensureChiefDefaultWatch({ dataDir, routines, getChiefBotId: () => null });
    expect(out).toEqual({ created: false, reason: 'no-chief' });
    expect(routines.list()).toHaveLength(0);
  });

  it('respects a persisted opt-out', () => {
    const { dataDir, routines } = setup();
    setChiefWatchOptOut(dataDir, true);
    const out = ensureChiefDefaultWatch({ dataDir, routines, getChiefBotId: () => 'chief-1' });
    expect(out).toEqual({ created: false, reason: 'opted-out' });
    expect(routines.list()).toHaveLength(0);
  });

  it('does not resurrect a routine the user deleted after bootstrap', () => {
    const { dataDir, routines } = setup();
    const deps = { dataDir, routines, getChiefBotId: () => 'chief-1' };
    const first = ensureChiefDefaultWatch(deps);
    expect(first.created).toBe(true);
    // Simulate deletion: a fresh store view without the routine but with
    // the flag file intact.
    const emptyStore = {
      list: () => [],
      create: () => {
        throw new Error('must not recreate');
      },
    } as unknown as RoutineStore;
    const out = ensureChiefDefaultWatch({ ...deps, routines: emptyStore });
    expect(out).toEqual({ created: false, reason: 'already-bootstrapped' });
  });
});
