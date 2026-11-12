// SPDX-License-Identifier: Apache-2.0
// A10 memory pipeline routes:
// - GET /memory/proposals lists the inbox (scope shown, status filter)
// - POST /memory/proposals/synthesize is the manual trigger (mock lane; zero paid API)
// - POST /memory/proposals/:id/decide is USER-ONLY: a verified principal
//   (OPEN-1) is required — x-user-id alone never authorizes; the recorded
//   decidedBy is the verified identity
// - approve / edit-then-approve / dismiss flow through to the store, and
//   the citation builder distinguishes rule hits from fact hits

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TieredMemoryStore } from '@mvp/agent-runtime';
import { createMemoryProposalsRouter } from '../src/memory-proposals-routes.js';
import { citationFromAtom, citationsFromPack } from '../src/memory-citations.js';

const BOT_ID = 'bot-a';
const OWNER_TOKEN = 'test-owner-token';

let dir: string;
let store: TieredMemoryStore;
let server: { close(cb: () => void): void } | null = null;
let base: string;

async function startApp(withPrincipal: boolean, synthesizer?: Parameters<typeof createMemoryProposalsRouter>[0]['synthesizerForBot']): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/memory',
    createMemoryProposalsRouter({
      tieredMemoryStore: store,
      getBots: () => [{ id: BOT_ID }],
      ...(withPrincipal ? { principalContext: { dataDir: dir, loopbackToken: OWNER_TOKEN } } : {}),
      ...(synthesizer ? { synthesizerForBot: synthesizer } : {}),
    } as Parameters<typeof createMemoryProposalsRouter>[0]),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  base = `http://127.0.0.1:${addr.port}/api/memory`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a10-routes-'));
  store = new TieredMemoryStore(dir);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function seedProposal(text = 'Always run the test suite before pushing.', scope: { kind: 'global' } | { kind: 'project'; id: string } = { kind: 'global' }): string {
  return store.createRuleProposal(BOT_ID, { text, scope, sourceAtomIds: [] });
}

const ownerHeaders = { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' };

describe('proposals list', () => {
  it('lists pending proposals with scope; status filter works', async () => {
    await startApp(true);
    seedProposal();
    seedProposal('Freeze proj-x deploys.', { kind: 'project', id: 'proj-x' });
    const res = await fetch(`${base}/proposals?botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposals).toHaveLength(2);
    const scopes = body.proposals.map((p: { scope: { kind: string; id?: string } }) => p.scope.kind).sort();
    expect(scopes).toEqual(['global', 'project']);
    const project = body.proposals.find((p: { scope: { kind: string } }) => p.scope.kind === 'project');
    expect(project.scope.id).toBe('proj-x');
    const none = await (await fetch(`${base}/proposals?botId=${BOT_ID}&status=approved`)).json();
    expect(none.proposals).toHaveLength(0);
  });

  it('rejects unknown bots', async () => {
    await startApp(true);
    const res = await fetch(`${base}/proposals?botId=ghost`);
    expect(res.status).toBe(400);
  });
});

describe('decide enforces a user action (OPEN-1)', () => {
  it('401 without any credential — and x-user-id alone does NOT authorize', async () => {
    await startApp(true);
    const id = seedProposal();
    const noAuth = await fetch(`${base}/proposals/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: BOT_ID, action: 'approve' }),
    });
    expect(noAuth.status).toBe(401);
    const headerOnly = await fetch(`${base}/proposals/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'mallory' },
      body: JSON.stringify({ botId: BOT_ID, action: 'approve' }),
    });
    expect(headerOnly.status).toBe(401);
    // Still pending; nothing was promoted.
    expect(store.getRuleProposal(BOT_ID, id)?.status).toBe('pending');
    expect(store.listRuleAtoms(BOT_ID)).toHaveLength(0);
  });

  it('owner credential approves; decidedBy is the verified principal (profile asserted under owner)', async () => {
    await startApp(true);
    const id = seedProposal();
    const res = await fetch(`${base}/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...ownerHeaders, 'x-user-id': 'ashutosh' },
      body: JSON.stringify({ botId: BOT_ID, action: 'approve' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposal.status).toBe('approved');
    // Owner + x-user-id = asserted profile selection (OPEN-1 path 3).
    expect(body.proposal.decidedBy).toBe('ashutosh');
    expect(store.getApplicableRules(BOT_ID)).toHaveLength(1);
  });

  it('edit-then-approve stores the edited text; dismiss removes; re-decide is a 400', async () => {
    await startApp(true);
    const id1 = seedProposal('Always run tests.');
    const edited = await fetch(`${base}/proposals/${id1}/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'approve', text: 'Always run tests AND lint.' }),
    });
    expect(edited.status).toBe(200);
    expect(store.getApplicableRules(BOT_ID).map((a) => a.fact)).toEqual(['Always run tests AND lint.']);
    const again = await fetch(`${base}/proposals/${id1}/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'approve' }),
    });
    expect(again.status).toBe(400);

    const id2 = seedProposal('Never force-push.');
    const dismissed = await fetch(`${base}/proposals/${id2}/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'dismiss' }),
    });
    expect(dismissed.status).toBe(200);
    expect(store.getRuleProposal(BOT_ID, id2)?.status).toBe('dismissed');
    expect(store.listRuleProposals(BOT_ID, 'pending')).toHaveLength(0);
  });

  it('unknown proposal is a 404; bad action is a 400', async () => {
    await startApp(true);
    const missing = await fetch(`${base}/proposals/nope/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'approve' }),
    });
    expect(missing.status).toBe(404);
    const id = seedProposal();
    const bad = await fetch(`${base}/proposals/${id}/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'maybe' }),
    });
    expect(bad.status).toBe(400);
  });

  it('without a principal context the loopback-boundary fallback records local-user', async () => {
    await startApp(false);
    const id = seedProposal();
    const res = await fetch(`${base}/proposals/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: BOT_ID, action: 'approve' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposal.decidedBy).toBe('local-user');
  });
});

describe('synthesize trigger', () => {
  it('is user-gated, and with a mocked lane creates pending proposals (zero paid API)', async () => {
    const synthesizerForBot = vi.fn(() => async () => [
      { text: 'Use USD equivalents in money answers.', scope: { kind: 'global' as const }, sourceAtomIds: [] },
    ]);
    await startApp(true, synthesizerForBot);
    const denied = await fetch(`${base}/proposals/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(denied.status).toBe(401);
    const res = await fetch(`${base}/proposals/synthesize`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toHaveLength(1);
    expect(body.created[0].status).toBe('pending');
    expect(store.listRuleAtoms(BOT_ID)).toHaveLength(0);
  });

  it('with no model lane and no captured facts: no-op success', async () => {
    await startApp(true, () => undefined);
    const res = await fetch(`${base}/proposals/synthesize`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toHaveLength(0);
    expect(body.lane).toBe('none');
  });
});

describe('citation distinguishes rule hits (A10)', () => {
  it('citationFromAtom marks rules vs facts; pack citations carry the kind', async () => {
    const factId = store.storeAtom(BOT_ID, { fact: 'The user favorite color is teal', entities: [], confidence: 0.9 }, 't1', undefined, { category: 'preference' });
    const proposalId = seedProposal('Always cite sources for prices.');
    store.decideRuleProposal(BOT_ID, proposalId, { action: 'approve', decidedBy: 'user-1' });
    const fact = store.getAtom(BOT_ID, factId)!;
    const rule = store.listRuleAtoms(BOT_ID)[0]!;
    expect(citationFromAtom(fact).kind).toBe('fact');
    expect(citationFromAtom(rule).kind).toBe('rule');
    const pack = store.buildMemoryPack(BOT_ID, 'prices', {});
    const citations = citationsFromPack(pack)!;
    expect(citations.some((c) => c.kind === 'rule')).toBe(true);
    expect(citations.find((c) => c.kind === 'rule')!.fact).toContain('cite sources');
  });
});
