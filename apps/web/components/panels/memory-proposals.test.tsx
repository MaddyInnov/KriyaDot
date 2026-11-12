// SPDX-License-Identifier: Apache-2.0
// A10 proposals inbox UI: pending candidates render with their scope,
// approve / edit-then-approve / dismiss call the decide endpoint with the
// right payload, "Synthesize now" hits the trigger, the empty state
// explains the pipeline in one line — and the Memory-used note cites an
// approved RULE distinctly from a fact.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryProposalsSection, PROPOSALS_EMPTY_STATE } from './memory-proposals';
import { MemoryUsedNote } from '../chat/memory-used-note';
import type { RuleProposalRecord } from '../../lib/api';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  proposals: [] as RuleProposalRecord[],
  decided: [] as Array<{ botId: string; id: string; action: string; text?: string }>,
  synthCalls: 0,
}));

vi.mock('../../lib/api', () => ({
  getRuleProposals: async () => ({ ok: true, botId: 'scout', status: 'pending', proposals: hoisted.proposals }),
  decideRuleProposal: async (botId: string, id: string, action: string, text?: string) => {
    hoisted.decided.push({ botId, id, action, text });
    hoisted.proposals = hoisted.proposals.filter((p) => p.id !== id);
    return { ok: true, proposal: { id, status: action === 'approve' ? 'approved' : 'dismissed' } };
  },
  synthesizeRuleProposals: async () => {
    hoisted.synthCalls += 1;
    return { ok: true, botId: 'scout', created: [], skipped: 0, lane: 'none' };
  },
  ruleScopeLabel: (scope: { kind: string; id?: string }) =>
    scope.kind === 'global' ? 'Global' : `${scope.kind === 'agent' ? 'Agent' : 'Project'} · ${scope.id ?? ''}`,
}));

const PENDING: RuleProposalRecord[] = [
  {
    id: 'p1', botId: 'scout', text: 'Always run the test suite before pushing.',
    scope: { kind: 'global' }, sourceAtomIds: ['a1', 'a2'], rationale: 'same rule recurs in 2 projects',
    status: 'pending', createdAt: new Date('2026-11-01T00:00:00Z').getTime(),
  },
  {
    id: 'p2', botId: 'scout', text: 'Freeze deploys during the audit.',
    scope: { kind: 'project', id: 'proj-x' }, sourceAtomIds: ['a3'],
    status: 'pending', createdAt: new Date('2026-11-02T00:00:00Z').getTime(),
  },
];

beforeEach(() => {
  hoisted.proposals = [...PENDING];
  hoisted.decided = [];
  hoisted.synthCalls = 0;
});

describe('MemoryProposalsSection', () => {
  it('renders pending proposals with scope labels and provenance', async () => {
    render(<MemoryProposalsSection botId="scout" />);
    expect(await screen.findByText('Always run the test suite before pushing.')).toBeInTheDocument();
    expect(screen.getByText('Freeze deploys during the audit.')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Project · proj-x')).toBeInTheDocument();
    expect(screen.getByText(/from 2 memories/)).toBeInTheDocument();
    expect(screen.getByText(/same rule recurs in 2 projects/)).toBeInTheDocument();
  });

  it('approve calls decide with action approve and removes the card', async () => {
    render(<MemoryProposalsSection botId="scout" />);
    await screen.findByText('Always run the test suite before pushing.');
    const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
    fireEvent.click(approveButtons[0]!);
    await waitFor(() => expect(hoisted.decided).toHaveLength(1));
    expect(hoisted.decided[0]).toMatchObject({ botId: 'scout', id: 'p1', action: 'approve' });
    await waitFor(() =>
      expect(screen.queryByText('Always run the test suite before pushing.')).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Rule approved \(Global\)/)).toBeInTheDocument();
  });

  it('edit-then-approve sends the edited text', async () => {
    render(<MemoryProposalsSection botId="scout" />);
    await screen.findByText('Freeze deploys during the audit.');
    const editButtons = screen.getAllByRole('button', { name: 'Edit & approve' });
    fireEvent.click(editButtons[1]!);
    const textarea = screen.getByLabelText(/Edit rule text: Freeze deploys/);
    fireEvent.change(textarea, { target: { value: 'Freeze deploys during the audit window only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve edited rule' }));
    await waitFor(() => expect(hoisted.decided).toHaveLength(1));
    expect(hoisted.decided[0]).toMatchObject({
      id: 'p2',
      action: 'approve',
      text: 'Freeze deploys during the audit window only.',
    });
  });

  it('dismiss calls decide with action dismiss', async () => {
    render(<MemoryProposalsSection botId="scout" />);
    await screen.findByText('Always run the test suite before pushing.');
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissButtons[0]!);
    await waitFor(() => expect(hoisted.decided).toHaveLength(1));
    expect(hoisted.decided[0]).toMatchObject({ id: 'p1', action: 'dismiss' });
  });

  it('empty state explains the pipeline in one line', async () => {
    hoisted.proposals = [];
    render(<MemoryProposalsSection botId="scout" />);
    expect(await screen.findByText(PROPOSALS_EMPTY_STATE)).toBeInTheDocument();
    expect(PROPOSALS_EMPTY_STATE).toContain('nothing becomes a standing rule until you approve it');
  });

  it('"Synthesize now" triggers a synthesis pass', async () => {
    hoisted.proposals = [];
    render(<MemoryProposalsSection botId="scout" />);
    await screen.findByText(PROPOSALS_EMPTY_STATE);
    fireEvent.click(screen.getByRole('button', { name: 'Synthesize now' }));
    await waitFor(() => expect(hoisted.synthCalls).toBe(1));
    expect(await screen.findByText(/Synthesis ran — no new candidate rules/)).toBeInTheDocument();
  });
});

describe('MemoryUsedNote rule citation (A10)', () => {
  it('shows a Rule chip only for rule-kind citations', () => {
    render(
      <MemoryUsedNote
        items={[
          { atomId: 'r1', fact: 'Always cite sources for prices.', category: 'preference', sourceTurn: 'rule-proposal:p1', kind: 'rule' },
          { atomId: 'f1', fact: 'The user favorite color is teal.', category: 'preference', sourceTurn: 'turn-3', kind: 'fact' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Memory used · 2/ }));
    expect(screen.getByText(/⚖️ Rule/)).toBeInTheDocument();
    expect(screen.getAllByText(/⚖️ Rule/)).toHaveLength(1);
  });
});
