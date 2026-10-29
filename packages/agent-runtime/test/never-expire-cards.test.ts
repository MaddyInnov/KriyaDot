// SPDX-License-Identifier: Apache-2.0
// W12b never-expire cards: widgets (ask_user_question), peer-approval
// cards, and credential-proposal cards raised with neverExpire survive
// past the default expiry window, while normal cards still expire.
// Direct sweep invocation at a future `now` — no real waiting.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WidgetCoordinator, WidgetStore, WIDGET_TTL_MS } from '../src/widgets.js';
import { PeerApprovalStore, PEER_CARD_TTL_MS } from '../src/peer-approval.js';
import { CredentialProposalStore, CREDENTIAL_PROPOSAL_TTL_MS } from '../src/credential-proposals.js';
import { createBuiltInTools } from '../src/tools/builtin.js';
import type { ToolContext, WidgetHost } from '../src/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'never-expire-'));
}

const FUTURE = Date.now() + 24 * 60 * 60 * 1000; // a day past every TTL

describe('WidgetStore neverExpire (W12b)', () => {
  it('stores expiresAt=null and survives expireStale; normal cards expire', () => {
    const store = new WidgetStore(tempDir(), { ttlMs: 1000 });
    const eternal = store.raise({
      sessionId: 's1',
      botId: 'b1',
      kind: 'buttons',
      payload: { kind: 'buttons', question: 'Forever?', options: [{ id: 'a', label: 'A' }] },
      interactive: true,
      neverExpire: true,
    });
    const normal = store.raise({
      sessionId: 's1',
      botId: 'b1',
      kind: 'buttons',
      payload: { kind: 'buttons', question: 'Normal?', options: [{ id: 'a', label: 'A' }] },
      interactive: true,
    });
    expect(eternal.expiresAt).toBeNull();
    expect(eternal.neverExpire).toBe(true);
    expect(normal.expiresAt).not.toBeNull();
    expect(normal.neverExpire).toBe(false);

    const expired = store.expireStale(FUTURE);
    expect(expired).toEqual([normal.id]);
    expect(store.get(eternal.id)?.status).toBe('pending');
    // Round-trips through a fresh read (SQLite persistence).
    expect(store.get(eternal.id)?.expiresAt).toBeNull();
    expect(store.get(eternal.id)?.neverExpire).toBe(true);
    store.close();
  });

  it('default TTL is unchanged (15 minutes)', () => {
    const store = new WidgetStore(tempDir());
    const before = Date.now();
    const rec = store.raise({
      sessionId: 's',
      botId: 'b',
      kind: 'confirm',
      payload: { kind: 'confirm', question: 'Sure?' },
      interactive: true,
    });
    expect(rec.expiresAt! - before).toBeGreaterThanOrEqual(WIDGET_TTL_MS - 1000);
    expect(rec.expiresAt! - before).toBeLessThanOrEqual(WIDGET_TTL_MS + 5000);
    store.close();
  });

  it('coordinator sweep leaves never-expire waiters alone; the wait times out unanswered but NOT expired', async () => {
    const store = new WidgetStore(tempDir(), { ttlMs: 60_000 });
    const coordinator = new WidgetCoordinator(store);
    const rec = await coordinator.raise({
      sessionId: 's',
      botId: 'b',
      kind: 'buttons',
      payload: { kind: 'buttons', question: 'Later?', options: [{ id: 'a', label: 'A' }] },
      interactive: true,
      neverExpire: true,
    });
    expect(coordinator.sweepExpired(FUTURE)).toEqual([]);
    // Short caller timeout: resolves unanswered, card stays pending.
    const answer = await coordinator.awaitAnswer(rec.id, 25);
    expect(answer.answered).toBe(false);
    expect(answer.expired).toBe(false);
    expect(store.get(rec.id)?.status).toBe('pending');
    // Still answerable after the wait gave up.
    const settled = coordinator.settle(rec.id, { answered: true, value: { selected: ['a'] } });
    expect(settled.status).toBe('answered');
    store.close();
  });
});

describe('ask_user_question neverExpire plumbing (W12b)', () => {
  it('the tool raises a never-expire widget and emits expiresAt=null', async () => {
    const store = new WidgetStore(tempDir());
    const coordinator = new WidgetCoordinator(store);
    const emitted: Array<{ expiresAt: number | null; neverExpire?: boolean }> = [];
    const host: WidgetHost = {
      raise: (i) => coordinator.raise({ ...i, sessionId: 'sess', botId: 'bot' }),
      emit: (e) => {
        if (e.type === 'widget') emitted.push({ expiresAt: e.expiresAt, neverExpire: e.neverExpire });
      },
      awaitAnswer: (id, ms) => coordinator.awaitAnswer(id, ms),
    };
    const tools = createBuiltInTools({ workspaceDir: tempDir() });
    const tool = tools.find((t) => t.name === 'ask_user_question');
    expect(tool).toBeDefined();
    const ctx = { sessionId: 'sess', botId: 'bot', widget: host } as unknown as ToolContext;
    // Answer it from "the UI" shortly after it is raised.
    const run = tool!.handler(
      { question: 'Pick one?', options: [{ label: 'Yes' }], neverExpire: true, timeoutMinutes: 1 },
      ctx,
    );
    // Let the raise land, then settle the (single) pending widget.
    await new Promise((r) => setTimeout(r, 30));
    const pending = store.list('sess', 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.neverExpire).toBe(true);
    expect(pending[0]!.expiresAt).toBeNull();
    coordinator.settle(pending[0]!.id, { answered: true, value: { selected: ['o1'] } });
    const result = (await run) as { answers: Array<{ answered: boolean; neverExpire?: boolean }> };
    expect(result.answers[0]!.answered).toBe(true);
    expect(result.answers[0]!.neverExpire).toBe(true);
    expect(emitted[0]).toEqual({ expiresAt: null, neverExpire: true });
    store.close();
  });
});

describe('PeerApprovalStore neverExpire (W12b)', () => {
  it('never-expire peer cards survive expireStale; normal cards expire', () => {
    const store = new PeerApprovalStore(tempDir(), { ttlMs: 1000 });
    const base = {
      senderBotId: 'a',
      senderBotName: 'A',
      targetBotId: 'b',
      targetBotName: 'B',
      actionType: 'ask' as const,
      preview: 'hello',
      sessionId: 's',
    };
    const eternal = store.raiseCard({ ...base, neverExpire: true });
    const normal = store.raiseCard(base);
    expect(eternal.expiresAt).toBeNull();
    expect(eternal.neverExpire).toBe(true);
    expect(normal.expiresAt).not.toBeNull();
    const expired = store.expireStale(Date.now() + PEER_CARD_TTL_MS + 1000);
    expect(expired).toEqual([normal.id]);
    expect(store.getCard(eternal.id)?.status).toBe('pending');
    expect(store.getCard(eternal.id)?.expiresAt).toBeNull();
    store.close();
  });
});

describe('CredentialProposalStore neverExpire (W12b)', () => {
  it('never-expire proposals survive expireStale; normal proposals expire', () => {
    const store = new CredentialProposalStore(tempDir());
    const eternal = store.propose({ botId: 'b', sessionId: 's', key: 'api_key', neverExpire: true });
    const normal = store.propose({ botId: 'b', sessionId: 's', key: 'other_key' });
    expect(eternal.expiresAt).toBeNull();
    expect(eternal.neverExpire).toBe(true);
    expect(normal.expiresAt).not.toBeNull();
    const expired = store.expireStale(Date.now() + CREDENTIAL_PROPOSAL_TTL_MS + 1000);
    expect(expired).toEqual([normal.id]);
    expect(store.get(eternal.id)?.status).toBe('pending');
    store.close();
  });
});
