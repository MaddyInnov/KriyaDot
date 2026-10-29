// SPDX-License-Identifier: Apache-2.0
// Team composition rules (item 15).
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamStore, validateTeamComposition } from '../src/teams.js';

function store(): TeamStore { return new TeamStore(mkdtempSync(join(tmpdir(), 'teams-'))); }
describe('team composition', () => {
  it('requires >=2 members unless solo exception', () => {
    expect(validateTeamComposition(['a'])).toHaveLength(1);
    expect(validateTeamComposition(['a'], { allowSolo: true })).toHaveLength(0);
    expect(validateTeamComposition(['a','b'])).toHaveLength(0);
  });
  it('strict createTeam enforces size and rejects nested teams', () => {
    const s = store();
    expect(() => s.createTeam('X', 'coord', ['only'], { enforceComposition: true })).toThrow(/at least 2/);
    const solo = s.createTeam('Solo', 'coord', ['only'], { enforceComposition: true, allowSolo: true });
    expect(solo.memberBotIds).toEqual(['only']);
    const t = s.createTeam('Main', 'coord', ['a','b'], { enforceComposition: true });
    expect(() => s.createTeam('Outer', 'coord', [t.id, 'c'], { enforceComposition: true })).toThrow(/nested/);
    s.close();
  });
  it('updateMembers protects in-flight members with a clear error', () => {
    const s = store();
    const t = s.createTeam('Main', 'coord', ['a','b'], { enforceComposition: true });
    expect(() => s.updateMembers(t.id, ['a','c'], { isMemberBusy: (id) => id === 'b' })).toThrow(/turn in flight/);
    const updated = s.updateMembers(t.id, ['a','c'], { isMemberBusy: () => false });
    expect(updated.memberBotIds).toEqual(['a','c']);
    s.close();
  });
  it('legacy createTeam without enforcement keeps old behaviour', () => {
    const s = store(); const t = s.createTeam('Old', 'coord', ['m1']); expect(t.memberBotIds).toEqual(['m1']); s.close();
  });
});
