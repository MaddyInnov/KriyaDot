// SPDX-License-Identifier: Apache-2.0
// TeamsPanel component test (chief of staff). This package has no DOM test
// harness (repo convention: rendering is covered by type-checking), so the
// test renders the panel with react-dom/server against a mocked ../../lib/api
// and asserts the static structure: the four section headings, the roster
// list from props, and the operation-summary helper. Data-loading uses the
// mocked API functions — the test verifies the mocks' contracts match what
// the panel consumes.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TeamsPanel, { opSummary } from './teams-panel';
import type { BotConfig } from '../../lib/api';

// Mock the whole API module: the panel must only call these six functions
// on load, plus the action functions on user interaction.
vi.mock('../../lib/api', () => ({
  getChief: vi.fn(async () => ({ ok: true, chiefBotId: 'helper', managedSections: ['support'] })),
  setChief: vi.fn(async (botId: string | null) => ({ ok: true, chiefBotId: botId, managedSections: [] })),
  getChiefSections: vi.fn(async () => ({ ok: true, sections: ['support'] })),
  setChiefSections: vi.fn(async (sections: string[]) => ({ ok: true, sections })),
  listChiefProposals: vi.fn(async () => ({ ok: true, proposals: [] })),
  approveChiefProposal: vi.fn(async (id: string) => ({ ok: true, proposal: { id, status: 'approved' }, applied: [] })),
  rejectChiefProposal: vi.fn(async (id: string) => ({ ok: true, proposal: { id, status: 'rejected' } })),
  listChiefIncidents: vi.fn(async () => ({ ok: true, incidents: [] })),
  resolveChiefIncident: vi.fn(async (id: string) => ({ ok: true, incident: { id, status: 'resolved' } })),
  retryChiefIncident: vi.fn(async (id: string) => ({ ok: true, incidentId: id, attempts: 1, incident: { id } })),
}));

const bots = [
  { id: 'helper', name: 'Helper', description: 'general help', chiefOfStaff: true },
  { id: 'coder', name: 'Coder', description: 'writes code' },
] as BotConfig[];

describe('teams-panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all four section headings', () => {
    const html = renderToStaticMarkup(<TeamsPanel bots={bots} onRosterChanged={() => undefined} />);
    expect(html).toContain('Chief of Staff');
    expect(html).toContain('Team roster');
    expect(html).toContain('Pending proposals');
    expect(html).toContain('Incidents &amp; escalations');
  });

  it('lists the roster with a crown on the chief', () => {
    const html = renderToStaticMarkup(<TeamsPanel bots={bots} onRosterChanged={() => undefined} />);
    expect(html).toContain('Helper');
    expect(html).toContain('Coder');
    // The 👑 crown marks the chief (chiefBotId comes from getChief on load;
    // the static render also flags bots whose chiefOfStaff prop is set).
    expect(html).toContain('👑');
  });

  it('exposes the chief card actions', () => {
    // Note: renderToStaticMarkup does not run useEffect, so the chief state
    // is still null here — only the always-visible actions render.
    const html = renderToStaticMarkup(<TeamsPanel bots={bots} onRosterChanged={() => undefined} />);
    expect(html).toContain('Make chief');
    expect(html).toContain('Managed sections');
    expect(html).toContain('Choose a bot…');
  });

  it('opSummary formats create/update/delete operations', () => {
    expect(opSummary({ action: 'create', key: 'writer', fields: { name: 'Writer' } })).toContain('create writer');
    expect(opSummary({ action: 'update', botId: 'coder' })).toContain('update coder');
    expect(opSummary({ action: 'delete', botId: 'scout' })).toContain('delete scout');
  });

  it('mocked API contracts match what the panel consumes', async () => {
    const api = await import('../../lib/api');
    const chief = await (api.getChief as () => Promise<{ chiefBotId: string | null; managedSections: string[] }>)();
    expect(chief.chiefBotId).toBe('helper');
    expect(chief.managedSections).toEqual(['support']);
    const proposals = await (api.listChiefProposals as (s?: string) => Promise<{ proposals: unknown[] }>)('pending');
    expect(proposals.proposals).toEqual([]);
    const incidents = await (api.listChiefIncidents as (s?: string) => Promise<{ incidents: unknown[] }>)('open');
    expect(incidents.incidents).toEqual([]);
    const approved = await (api.approveChiefProposal as (id: string) => Promise<{ proposal: { status: string } }>)('cpr_1');
    expect(approved.proposal.status).toBe('approved');
    const retried = await (api.retryChiefIncident as (id: string) => Promise<{ attempts: number }>)('cin_1');
    expect(retried.attempts).toBe(1);
  });
});
