// SPDX-License-Identifier: Apache-2.0
// MemoryExplorerPanel (OH-3/OH-4): atoms render + inline-confirm delete
// flow, category filtering, Ask-memory citations with the honest
// extractive label, and ingestion toggle save + run — all against a
// mocked lib/api (the fetch layer behind it is covered by api tests).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryExplorerPanel, filterAtomsClient, normalizeIngestionSources } from './memory-explorer';

afterEach(() => cleanup());

const hoisted = vi.hoisted(() => ({
  atoms: [] as Array<Record<string, unknown>>,
  deleted: [] as Array<{ botId: string; atomId: string }>,
  saved: [] as Array<{ botId: string; sources: Record<string, boolean>; rssFeeds?: string[] }>,
  runs: 0,
}));

vi.mock('../../lib/api', () => ({
  getBots: async () => [
    { id: 'scout', name: 'Scout', description: '', systemPrompt: '', provider: 'groq', model: 'm', skills: [], tools: [], mcpServers: [] },
  ],
  getMemoryAtoms: async () => ({ ok: true, botId: 'scout', atoms: hoisted.atoms }),
  getMemoryStats: async () => ({
    total: hoisted.atoms.length,
    pinned: hoisted.atoms.filter((a) => a.pinned).length,
    byCategory: { preference: 1, fact: 1 },
  }),
  deleteMemoryAtom: async (botId: string, atomId: string) => {
    hoisted.deleted.push({ botId, atomId });
    hoisted.atoms = hoisted.atoms.filter((a) => a.id !== atomId);
    return { ok: true, deleted: atomId };
  },
  askMemory: async () => ({
    answer: 'You prefer terse answers.',
    citations: [{ atomId: 'a1', fact: 'Prefers terse answers with no preamble.', category: 'preference', sourceTurn: 'turn-12' }],
    mode: 'extractive',
  }),
  getMemoryIngestion: async () => ({
    ok: true,
    botId: 'scout',
    settings: {
      sources: { files: false, rss: true, gmail: false, drive: false },
      rssFeeds: ['https://example.com/feed.xml'],
    },
    sources: [
      { id: 'files', enabled: false, available: true },
      { id: 'rss', enabled: true, available: true },
      { id: 'gmail', enabled: false, available: false, unavailableReason: 'Gmail account not connected' },
      { id: 'drive', enabled: false, available: true },
    ],
  }),
  saveMemoryIngestion: async (botId: string, settings: { sources: Record<string, boolean>; rssFeeds?: string[] }) => {
    hoisted.saved.push({ botId, sources: settings.sources, rssFeeds: settings.rssFeeds });
    return { ok: true, botId, settings, sources: [] };
  },
  runMemoryIngestion: async () => {
    hoisted.runs += 1;
    return { ok: true, added: 3, skipped: 1 };
  },
  // A10 proposals inbox: none pending in these explorer fixtures.
  getRuleProposals: async () => ({ ok: true, botId: 'scout', status: 'pending', proposals: [] }),
  decideRuleProposal: async () => ({ ok: true, proposal: {} }),
  synthesizeRuleProposals: async () => ({ ok: true, botId: 'scout', created: [], skipped: 0, lane: 'none' }),
  ruleScopeLabel: (scope: { kind: string; id?: string }) =>
    scope.kind === 'global' ? 'Global' : `${scope.kind === 'agent' ? 'Agent' : 'Project'} · ${scope.id ?? ''}`,
}));

const ATOMS = [
  {
    id: 'a1', botId: 'scout', fact: 'Prefers terse answers with no preamble.', entities: [],
    confidence: 0.9, sourceTurn: 'turn-12', createdAt: new Date('2026-10-01T00:00:00Z').getTime(),
    tier: 'cloud-ok', pinned: true, category: 'preference', active: true,
  },
  {
    id: 'a2', botId: 'scout', fact: 'Building a price-comparison app called Sauda.', entities: [],
    confidence: 0.8, sourceTurn: 'turn-30', createdAt: new Date('2026-10-02T00:00:00Z').getTime(),
    tier: 'cloud-ok', pinned: false, category: 'fact', active: true,
  },
];

beforeEach(() => {
  hoisted.atoms = [...ATOMS];
  hoisted.deleted = [];
  hoisted.saved = [];
  hoisted.runs = 0;
  localStorage.clear();
});

describe('MemoryExplorerPanel', () => {
  it('renders atoms with pinned marker, category, source and date, plus stats', async () => {
    render(<MemoryExplorerPanel />);
    expect(await screen.findByText(/Prefers terse answers with no preamble\./)).toBeInTheDocument();
    expect(screen.getByText('Building a price-comparison app called Sauda.')).toBeInTheDocument();
    expect(screen.getByText(/2 memories · 1 pinned/)).toBeInTheDocument();
    expect(screen.getByText(/preference · turn-12/)).toBeInTheDocument();
    expect(screen.getByText(/📌/)).toBeInTheDocument();
    // Bot selector is populated from the shared bot list plumbing.
    expect(screen.getByLabelText('Bot')).toHaveValue('scout');
  });

  it('delete flow: Delete → inline Confirm → atom removed via DELETE', async () => {
    render(<MemoryExplorerPanel />);
    await screen.findByText(/Prefers terse answers with no preamble\./);
    fireEvent.click(screen.getByRole('button', { name: 'Forget memory: Prefers terse answers with no preamble.' }));
    // Nothing deleted until the inline confirm is clicked.
    expect(hoisted.deleted).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm forget: Prefers terse answers with no preamble.' }));
    await waitFor(() =>
      expect(screen.queryByText(/Prefers terse answers with no preamble\./)).not.toBeInTheDocument(),
    );
    expect(hoisted.deleted).toEqual([{ botId: 'scout', atomId: 'a1' }]);
    expect(screen.getByText('Building a price-comparison app called Sauda.')).toBeInTheDocument();
  });

  it('category chips filter the atom list', async () => {
    render(<MemoryExplorerPanel />);
    await screen.findByText('Building a price-comparison app called Sauda.');
    fireEvent.click(screen.getByRole('button', { name: /preference/ }));
    await waitFor(() =>
      expect(screen.queryByText('Building a price-comparison app called Sauda.')).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Prefers terse answers with no preamble\./)).toBeInTheDocument();
  });

  it('ask renders the answer, citation chips, and the honest extractive label', async () => {
    render(<MemoryExplorerPanel />);
    await screen.findByText(/Prefers terse answers with no preamble\./);
    fireEvent.change(screen.getByLabelText('Ask memory a question'), {
      target: { value: 'How do I like answers?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('You prefer terse answers.')).toBeInTheDocument();
    expect(screen.getByText(/Showing matching memories — extractive match, not an AI-generated answer/)).toBeInTheDocument();
    expect(screen.getByText(/Prefers terse answers with no preamble\. · preference/)).toBeInTheDocument();
  });

  it('ingestion: unavailable source shows its reason and a disabled toggle', async () => {
    render(<MemoryExplorerPanel />);
    expect(await screen.findByText(/Gmail account not connected/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Ingest from Gmail/ })).toBeDisabled();
    expect(screen.getByLabelText('RSS feed URLs')).toHaveValue('https://example.com/feed.xml');
  });

  it('ingestion toggles save through PUT and Run now reports added/skipped', async () => {
    render(<MemoryExplorerPanel />);
    const filesBox = await screen.findByRole('checkbox', { name: /Ingest from Workspace files/ });
    expect(filesBox).not.toBeChecked();
    fireEvent.click(filesBox);
    expect(filesBox).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(hoisted.saved).toHaveLength(1));
    // PUT body is the settings shape: per-source booleans + rssFeeds.
    expect(hoisted.saved[0]!.sources.files).toBe(true);
    expect(hoisted.saved[0]!.sources.rss).toBe(true);
    expect(hoisted.saved[0]!.rssFeeds).toEqual(['https://example.com/feed.xml']);
    expect(await screen.findByText('Ingestion settings saved.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/added 3, skipped 1/)).toBeInTheDocument();
    expect(hoisted.runs).toBe(1);
  });
});

describe('memory explorer helpers', () => {
  it('filterAtomsClient mirrors the server q/category filter', () => {
    const atoms = ATOMS as never[];
    expect(filterAtomsClient(atoms, '', '')).toHaveLength(2);
    expect(filterAtomsClient(atoms, 'sauda', '')).toHaveLength(1);
    expect(filterAtomsClient(atoms, '', 'preference')).toHaveLength(1);
    expect(filterAtomsClient(atoms, 'terse', 'fact')).toHaveLength(0);
  });

  it('normalizeIngestionSources accepts a per-id map and orders known sources', () => {
    const list = normalizeIngestionSources({
      gmail: { enabled: true, available: false, unavailableReason: 'nope' },
      files: { enabled: true, available: true },
      rss: { enabled: false, available: true, url: 'https://x.example/rss' },
    });
    expect(list.map((s) => s.id)).toEqual(['files', 'rss', 'gmail']);
    expect(list[1]?.feeds).toEqual(['https://x.example/rss']);
    expect(list[2]?.unavailableReason).toBe('nope');
  });
});
