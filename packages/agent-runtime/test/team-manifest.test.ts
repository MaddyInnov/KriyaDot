// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  TEAM_MANIFEST_FORMAT,
  buildTeamManifest,
  canonicalize,
  computeTeamManifestChecksum,
  describeTeamImport,
  teamManifestFilename,
  validateTeamManifest,
  type BotConfig,
  type Team,
  type TeamManifest,
} from '../src/team-manifest.js';

function bot(id: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    description: `${id} description`,
    systemPrompt: 'You are helpful.',
    provider: 'groq',
    model: 'llama-3.3-70b',
    skills: [],
    tools: ['web_search'],
    mcpServers: [],
  } as BotConfig;
}

function team(): Team {
  return {
    id: 'team-1',
    name: 'Research Squad',
    coordinatorBotId: 'scout',
    memberBotIds: ['coder', 'writer'],
    createdAt: 1700000000000,
    delegationPolicy: 'always-ask',
    delegationPolicyOverrides: { coder: 'always-allow' },
  };
}

function build(): TeamManifest {
  return buildTeamManifest({
    team: team(),
    coordinator: bot('scout'),
    members: [bot('coder'), bot('writer')],
    workflows: ['wf-1'],
    appVersion: 'kriyadot/0.1.0',
  });
}

describe('team manifest', () => {
  it('builds a valid self-contained manifest that validates', () => {
    const m = build();
    expect(m.format).toBe(TEAM_MANIFEST_FORMAT);
    expect(m.version).toBe('1');
    expect(m.team.name).toBe('Research Squad');
    expect(m.team.coordinator.id).toBe('scout');
    expect(m.team.members.map((b) => b.id)).toEqual(['coder', 'writer']);
    expect(m.team.rosterPrompt).toContain('{{task}}');
    expect(m.team.coordinationRules.delegationPolicy).toBe('always-ask');
    expect(m.team.coordinationRules.delegationPolicyOverrides).toEqual({ coder: 'always-allow' });
    expect(m.team.workflows).toEqual(['wf-1']);
    const v = validateTeamManifest(m);
    expect(v.ok).toBe(true);
  });

  it('rejects a tampered manifest (checksum mismatch)', () => {
    const m = build();
    const tampered = JSON.parse(JSON.stringify(m)) as TeamManifest;
    tampered.team.name = 'Evil Squad';
    const v = validateTeamManifest(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/checksum/i);
  });

  it('rejects a manifest with a wrong checksum format', () => {
    const m = build();
    const v = validateTeamManifest({ ...m, checksum: 'not-a-hash' });
    expect(v.ok).toBe(false);
  });

  it('rejects unsupported versions and wrong format markers', () => {
    const m = build();
    expect(validateTeamManifest({ ...m, version: '999' }).ok).toBe(false);
    expect(validateTeamManifest({ ...m, format: 'other.team' }).ok).toBe(false);
  });

  it('rejects malformed shapes with detailed errors', () => {
    expect(validateTeamManifest(null).ok).toBe(false);
    expect(validateTeamManifest({}).ok).toBe(false);
    const v = validateTeamManifest({ ...build(), team: { ...build().team, members: [] } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/member/);
  });

  it('canonicalize is order-independent for checksum purposes', () => {
    const m = build();
    const { checksum, ...unsigned } = m;
    // Rebuild the payload with keys in a different insertion order.
    const entries = Object.entries(unsigned).reverse();
    const shuffled = Object.fromEntries(entries) as Omit<TeamManifest, 'checksum'>;
    // Also shuffle nested team keys.
    shuffled.team = Object.fromEntries(Object.entries(shuffled.team).reverse()) as TeamManifest['team'];
    expect(computeTeamManifestChecksum(shuffled)).toBe(checksum);
    expect(canonicalize(shuffled)).toEqual(canonicalize(unsigned));
  });

  it('filename follows the kriyadot.team convention', () => {
    const name = teamManifestFilename('Research Squad!', '2026-10-17T00:00:00.000Z');
    expect(name).toBe('kriyadot.team.research-squad-20261017.json');
  });

  it('describeTeamImport reports name collisions and missing bots', () => {
    const m = build();
    const d = describeTeamImport(
      m,
      [{ id: 'other', name: 'research squad' }],
      new Set(['scout']),
    );
    expect(d.nameCollision).toEqual({ teamId: 'other', name: 'research squad' });
    expect(d.missingBotIds).toEqual(['coder', 'writer']);
  });

  it('describeTeamImport is clean when nothing collides', () => {
    const m = build();
    const d = describeTeamImport(m, [], new Set(['scout', 'coder', 'writer']));
    expect(d.nameCollision).toBeNull();
    expect(d.missingBotIds).toEqual([]);
  });
});
