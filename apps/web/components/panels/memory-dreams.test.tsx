// SPDX-License-Identifier: Apache-2.0
// A11 Dreams UI: the section states the opt-in + privacy posture,
// renders leads with their evidence numbers, gates the enable toggle
// and Run now through the API, and Accept/Dismiss/Snooze send the
// right decisions (with the accept-mapping notice shown back).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DREAMS_EMPTY_STATE, DREAMS_PRIVACY_COPY, MemoryDreamsSection } from './memory-dreams';
import type { DreamLeadRecord, DreamSettingsRecord } from '../../lib/api';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  settings: null as unknown as DreamSettingsRecord,
  leads: [] as DreamLeadRecord[],
  saved: [] as Array<Record<string, unknown>>,
  decided: [] as Array<{ id: string; action: string; snoozeDays?: number }>,
  runs: 0,
}));

vi.mock('../../lib/api', () => ({
  getDreams: async () => ({ ok: true, botId: 'scout', settings: hoisted.settings, lastRunAt: null, leads: hoisted.leads }),
  saveDreamSettings: async (botId: string, patch: Record<string, unknown>) => {
    hoisted.saved.push({ botId, ...patch });
    hoisted.settings = { ...hoisted.settings, ...patch };
    return { ok: true, botId, settings: hoisted.settings };
  },
  runDreamsNow: async () => {
    hoisted.runs += 1;
    return { ok: true, created: [], suppressed: 0, considered: 12, lane: 'deterministic' };
  },
  decideDreamLead: async (botId: string, id: string, action: string, snoozeDays?: number) => {
    hoisted.decided.push({ id, action, snoozeDays });
    const lead = hoisted.leads.find((l) => l.id === id)!;
    const acceptedArtefact =
      lead.artefact.type === 'rule'
        ? { type: 'rule-proposal' as const, id: 'prop-1' }
        : lead.artefact.type === 'routine'
          ? { type: 'routine-draft' as const, id: 'routine-1' }
          : { type: 'acknowledged' as const };
    return { ok: true, lead: { ...lead, status: 'accepted', acceptedArtefact } };
  },
}));

const LEADS: DreamLeadRecord[] = [
  {
    id: 'lead-1',
    botId: 'scout',
    kind: 'recurring-failure',
    title: '“web_search” failed 5 times in the window',
    suggestedAction: 'Consider a rule: stop and report instead of retrying.',
    score: 90,
    evidence: { count: 5, windowStart: 0, windowEnd: 1, examples: ['tool.execute · web_search · 2026-11-11T00:00:00.000Z'], metrics: { distinctDays: 2 } },
    artefact: { type: 'rule' },
    status: 'pending',
    createdAt: new Date('2026-11-12T00:00:00Z').getTime(),
  },
  {
    id: 'lead-2',
    botId: 'scout',
    kind: 'stale-rule',
    title: 'Approved rule never used in 46 days',
    suggestedAction: 'Review it in Memory. Accepting only acknowledges this lead.',
    score: 55,
    evidence: { count: 1, windowStart: 0, windowEnd: 1, examples: ['atom://a9'], metrics: { ageDays: 46 } },
    artefact: { type: 'none' },
    status: 'pending',
    createdAt: new Date('2026-11-12T00:00:00Z').getTime(),
  },
];

beforeEach(() => {
  hoisted.settings = { enabled: false, hour: 3, minute: 15, summarise: false, updatedAt: new Date(0).toISOString() };
  hoisted.leads = [...LEADS];
  hoisted.saved = [];
  hoisted.decided = [];
  hoisted.runs = 0;
});

describe('MemoryDreamsSection', () => {
  it('states the opt-in/privacy posture and shows the OFF default', async () => {
    hoisted.leads = [];
    render(<MemoryDreamsSection botId="scout" />);
    expect(await screen.findByText(DREAMS_PRIVACY_COPY)).toBeInTheDocument();
    const toggle = (await screen.findByLabelText('Enable nightly Dreams pass')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(await screen.findByText(DREAMS_EMPTY_STATE)).toBeInTheDocument();
  });

  it('toggling enable saves settings through the API', async () => {
    render(<MemoryDreamsSection botId="scout" />);
    const toggle = await screen.findByLabelText('Enable nightly Dreams pass');
    fireEvent.click(toggle);
    await waitFor(() => expect(hoisted.saved).toEqual([{ botId: 'scout', enabled: true }]));
    expect(await screen.findByText(/Dreams enabled/)).toBeInTheDocument();
  });

  it('renders leads with evidence counts and scores; accept shows the mapping notice', async () => {
    render(<MemoryDreamsSection botId="scout" />);
    expect(await screen.findByText('“web_search” failed 5 times in the window')).toBeInTheDocument();
    expect(screen.getByText(/score 90 · evidence: 5 events/)).toBeInTheDocument();
    const acceptButtons = screen.getAllByRole('button', { name: 'Accept' });
    fireEvent.click(acceptButtons[0]!);
    await waitFor(() => expect(hoisted.decided).toEqual([{ id: 'lead-1', action: 'accept', snoozeDays: undefined }]));
    expect(await screen.findByText(/pending rule proposal was created/)).toBeInTheDocument();
  });

  it('dismiss and snooze send the right decisions', async () => {
    render(<MemoryDreamsSection botId="scout" />);
    await screen.findByText('“web_search” failed 5 times in the window');
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
    await waitFor(() => expect(hoisted.decided).toHaveLength(1));
    expect(hoisted.decided[0]).toMatchObject({ id: 'lead-1', action: 'dismiss' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Snooze 7 days' })[0]!);
    await waitFor(() => expect(hoisted.decided).toHaveLength(2));
    expect(hoisted.decided[1]).toMatchObject({ id: 'lead-2', action: 'snooze', snoozeDays: 7 });
  });

  it('Run now triggers a manual pass and reports the outcome', async () => {
    render(<MemoryDreamsSection botId="scout" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Dreams now' }));
    await waitFor(() => expect(hoisted.runs).toBe(1));
    expect(await screen.findByText(/Dreams pass ran over 12 audit events/)).toBeInTheDocument();
  });
});
