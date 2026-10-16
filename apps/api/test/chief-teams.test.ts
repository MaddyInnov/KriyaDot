// SPDX-License-Identifier: Apache-2.0
// Tests for ChiefTeamsStore (chief-teams.ts): chief config, proposal
// lifecycle, incident lifecycle, thread lookup, overrides, deleted ids.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChiefTeamsStore } from '../src/chief-teams.js';

let dir: string;
let store: ChiefTeamsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chief-teams-'));
  store = new ChiefTeamsStore(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('chief config', () => {
  it('starts with no chief', () => {
    expect(store.getChiefConfig()).toEqual({ chiefBotId: null, managedSections: [] });
  });

  it('sets and unsets the chief', () => {
    expect(store.setChiefConfig('chief-1', ['support'])).toEqual({
      chiefBotId: 'chief-1',
      managedSections: ['support'],
    });
    expect(store.setChiefConfig(null)).toEqual({ chiefBotId: null, managedSections: [] });
  });
});

describe('proposals', () => {
  function create() {
    return store.createProposal({
      kind: 'team-setup',
      createdByBotId: 'chief-1',
      reason: 'restructure',
      operations: [{ action: 'update', botId: 'coder', fields: { description: 'x' } }],
    });
  }

  it('creates a pending proposal with an id', () => {
    const p = create();
    expect(p.id).toMatch(/^cpr_/);
    expect(p.status).toBe('pending');
    expect(store.getProposal(p.id)).toEqual(p);
  });

  it('lists and filters by status', () => {
    const p = create();
    store.decideProposal(p.id, 'approved');
    expect(store.listProposals('pending')).toHaveLength(0);
    expect(store.listProposals('approved')).toHaveLength(1);
    expect(store.listProposals()).toHaveLength(1);
  });

  it('records suggestion and newTeams flags', () => {
    const p = store.createProposal({
      kind: 'create-bot',
      createdByBotId: 'chief-1',
      reason: 'suggest a writer',
      operations: [{ action: 'create', key: 'writer', fields: { name: 'Writer' } }],
      suggestion: true,
      newTeams: ['editorial'],
    });
    const fetched = store.getProposal(p.id)!;
    expect(fetched.suggestion).toBe(true);
    expect(fetched.newTeams).toEqual(['editorial']);
  });

  it('decideProposal only transitions pending proposals', () => {
    const p = create();
    expect(store.decideProposal(p.id, 'rejected')?.status).toBe('rejected');
    expect(store.decideProposal(p.id, 'approved')).toBeUndefined();
  });

  it('returns undefined for unknown ids', () => {
    expect(store.getProposal('cpr_nope')).toBeUndefined();
    expect(store.decideProposal('cpr_nope', 'approved')).toBeUndefined();
  });
});

describe('incidents', () => {
  it('reports and resolves an incident', () => {
    const inc = store.reportIncident({
      kind: 'incident',
      chiefBotId: 'chief-1',
      targetBotId: 'coder',
      targetBotName: 'Coder',
      threadId: 't1',
      summary: 'delegation failed',
      detail: JSON.stringify({ brief: 'do x' }),
      attempts: 3,
    });
    expect(inc.id).toMatch(/^cin_/);
    expect(inc.status).toBe('open');
    expect(inc.attempts).toBe(3);

    const byThread = store.getIncidentByThread('t1');
    expect(byThread?.id).toBe(inc.id);

    const resolved = store.resolveIncident(inc.id);
    expect(resolved?.status).toBe('resolved');
    expect(store.listIncidents({ status: 'open' })).toHaveLength(0);
    expect(store.listIncidents({ status: 'resolved' })).toHaveLength(1);
  });

  it('filters by kind', () => {
    store.reportIncident({ kind: 'incident', chiefBotId: 'c', summary: 'i' });
    store.reportIncident({ kind: 'escalation', chiefBotId: 'c', summary: 'e' });
    expect(store.listIncidents({ kind: 'incident' })).toHaveLength(1);
    expect(store.listIncidents({ kind: 'escalation' })).toHaveLength(1);
    expect(store.listIncidents()).toHaveLength(2);
  });

  it('updates attempts and status', () => {
    const inc = store.reportIncident({ kind: 'incident', chiefBotId: 'c', summary: 'i' });
    const updated = store.updateIncident(inc.id, { attempts: 2, status: 'triaged' });
    expect(updated?.attempts).toBe(2);
    expect(updated?.status).toBe('triaged');
  });

  it('returns undefined for unknown ids', () => {
    expect(store.getIncident('cin_nope')).toBeUndefined();
    expect(store.getIncidentByThread('nope')).toBeUndefined();
    expect(store.resolveIncident('cin_nope')).toBeUndefined();
  });
});

describe('overrides and deleted ids', () => {
  it('merges field overrides per bot', () => {
    store.setBotOverride('scout', { description: 'a' });
    store.setBotOverride('scout', { model: 'm' });
    expect(store.getBotOverrides()).toEqual({ scout: { description: 'a', model: 'm' } });
    store.deleteBotOverride('scout');
    expect(store.getBotOverrides()).toEqual({});
  });

  it('tracks deleted bot ids without duplicates', () => {
    store.addDeletedBotId('b1');
    store.addDeletedBotId('b1');
    expect(store.getDeletedBotIds()).toEqual(['b1']);
    store.removeDeletedBotId('b1');
    expect(store.getDeletedBotIds()).toEqual([]);
  });
});
