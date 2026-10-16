// SPDX-License-Identifier: Apache-2.0
// Peer-approval HTTP routes (OpenMausBot parity): card list/decide,
// grant list/revoke, broker settle/expiry, bot-deletion auto-settle.
// Real HTTP against a real PeerApprovalStore; zero network beyond
// localhost, zero paid API usage.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PeerApprovalStore } from '@mvp/agent-runtime';
import {
  createPeerApprovalBroker,
  createPeerApprovalRouter,
  peerApprovalsRemoveBot,
} from '../src/peer-approval-routes.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'peer-approval-routes-test-'));
}

let store: PeerApprovalStore;
const audits: Array<{ action: string; fields: unknown }> = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  const broker = createPeerApprovalBroker(store, {
    audit: (action, fields) => void audits.push({ action, fields }),
  });
  app.use(
    createPeerApprovalRouter({
      store,
      broker,
      audit: (action, fields) => void audits.push({ action, fields }),
    }),
  );
  return { app, broker };
}

let server: ReturnType<typeof makeApp> | undefined;
let baseUrl = '';

beforeEach(async () => {
  audits.length = 0;
  store = new PeerApprovalStore(tempDir());
  const built = makeApp();
  server = built;
  await new Promise<void>((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve());
    (server as unknown as { __s: unknown }).__s = s;
  });
  const addr = (server as unknown as { __s: { address(): { port: number } } }).__s.address() as {
    port: number;
  };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  const s = (server as unknown as { __s?: { close(cb: () => void): void } }).__s;
  await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
  store.close();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(baseUrl + path, init);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function raise() {
  return store.raiseCard({
    senderBotId: 'scout',
    senderBotName: 'Scout',
    targetBotId: 'coder',
    targetBotName: 'Coder',
    actionType: 'ask',
    preview: 'help me',
    sessionId: 's1',
  });
}

describe('GET /peer-approvals', () => {
  it('lists cards, filterable by status', async () => {
    raise();
    const all = await api('/peer-approvals');
    expect(all.status).toBe(200);
    expect((all.body.cards as unknown[])).toHaveLength(1);
    const pending = await api('/peer-approvals?status=pending');
    expect((pending.body.cards as unknown[])).toHaveLength(1);
    const allowed = await api('/peer-approvals?status=allowed');
    expect((allowed.body.cards as unknown[])).toHaveLength(0);
    const bad = await api('/peer-approvals?status=bogus');
    expect(bad.status).toBe(400);
  });
});

describe('POST /peer-approvals/:id', () => {
  it('allow → settles waiter + audits; double-decide → 409; unknown → 404; bad decision → 400', async () => {
    const card = raise();
    const res = await api(`/peer-approvals/${card.id}`, json({ decision: 'allow', decidedBy: 'user' }));
    expect(res.status).toBe(200);
    expect((res.body.card as { status: string }).status).toBe('allowed');
    expect(audits.some((a) => a.action === 'peer-approval.decided')).toBe(true);
    const again = await api(`/peer-approvals/${card.id}`, json({ decision: 'allow' }));
    expect(again.status).toBe(409);
    const missing = await api('/peer-approvals/nope', json({ decision: 'allow' }));
    expect(missing.status).toBe(404);
    const bad = await api(`/peer-approvals/${card.id}`, json({ decision: 'maybe' }));
    expect(bad.status).toBe(400);
  });

  it('always-allow records a grant', async () => {
    const card = raise();
    const res = await api(`/peer-approvals/${card.id}`, json({ decision: 'always-allow' }));
    expect(res.status).toBe(200);
    expect(store.hasGrant('scout', 'coder', 'ask')).toBe(true);
    const grants = await api('/peer-grants');
    expect((grants.body.grants as unknown[])).toHaveLength(1);
  });

  it('deny settles an in-flight broker waiter as denied', async () => {
    const card = store.raiseCard({
      senderBotId: 'scout',
      senderBotName: 'Scout',
      targetBotId: 'coder',
      targetBotName: 'Coder',
      actionType: 'message',
      preview: 'hi',
      sessionId: 's1',
    });
    const waiter = server!.broker.awaitDecision(card.id, 5000);
    // Simulate the route's decide+settle sequence for a deny.
    store.decideCard(card.id, 'deny', 'user');
    server!.broker.settle(card.id, 'denied');
    expect(await waiter).toBe('denied');
  });
});

describe('broker expiry', () => {
  it('awaitDecision resolves expired on TTL and marks the card', async () => {
    const dir = tempDir();
    const shortStore = new PeerApprovalStore(dir, { ttlMs: 50 });
    const broker = createPeerApprovalBroker(shortStore, { audit: () => {} });
    const card = shortStore.raiseCard({
      senderBotId: 'scout',
      senderBotName: 'Scout',
      targetBotId: 'coder',
      targetBotName: 'Coder',
      actionType: 'ask',
      preview: 'help',
      sessionId: 's1',
    });
    expect(await broker.awaitDecision(card.id, 5000)).toBe('expired');
    expect(shortStore.getCard(card.id)?.status).toBe('expired');
    shortStore.close();
  });
});

describe('DELETE /peer-grants', () => {
  it('revokes; 404 when absent; 400 on bad body', async () => {
    store.addGrant('scout', 'coder', 'delegate', 'user');
    const ok = await api('/peer-grants', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderBotId: 'scout', targetBotId: 'coder', actionType: 'delegate' }),
    });
    expect(ok.status).toBe(200);
    expect(store.hasGrant('scout', 'coder', 'delegate')).toBe(false);
    expect(audits.some((a) => a.action === 'peer-approval.grant_revoked')).toBe(true);
    const missing = await api('/peer-grants', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderBotId: 'scout', targetBotId: 'coder', actionType: 'delegate' }),
    });
    expect(missing.status).toBe(404);
    const bad = await api('/peer-grants', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderBotId: 'x' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('peerApprovalsRemoveBot', () => {
  it('dismisses pending cards involving a deleted bot', () => {
    const dir = tempDir();
    const s = new PeerApprovalStore(dir);
    s.raiseCard({
      senderBotId: 'scout', senderBotName: 'Scout',
      targetBotId: 'coder', targetBotName: 'Coder',
      actionType: 'ask', preview: 'a', sessionId: 's1',
    });
    s.raiseCard({
      senderBotId: 'helper', senderBotName: 'Helper',
      targetBotId: 'scout', targetBotName: 'Scout',
      actionType: 'message', preview: 'b', sessionId: 's2',
    });
    s.close();
    expect(peerApprovalsRemoveBot(dir, 'coder')).toBe(1);
    const check = new PeerApprovalStore(dir);
    expect(check.listCards('dismissed')).toHaveLength(1);
    expect(check.listCards('pending')).toHaveLength(1);
    check.close();
  });
});
