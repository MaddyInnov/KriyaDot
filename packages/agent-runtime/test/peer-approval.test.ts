// SPDX-License-Identifier: Apache-2.0
// Peer approval cards (OpenMausBot parity): store lifecycle + gate behavior.
// All broker interactions are mocked; zero network, zero paid API usage.

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PEER_CARD_TTL_MS,
  PeerApprovalStore,
  createPeerApprovalGate,
  describePeerAction,
  isPeerActionType,
  isPeerDecision,
  parsePeerCall,
} from '../src/peer-approval.js';
import type {
  PeerApprovalBroker,
  PeerApprovalCard,
  PeerApprovalGateOpts,
  RaisePeerCardInput,
} from '../src/peer-approval.js';
import type { StreamEvent, ToolCall, ToolContext } from '../src/types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'peer-approval-test-'));
}

const ctx: ToolContext = { sessionId: 'sess-1', botId: 'scout' };

function askCall(botId = 'coder'): ToolCall {
  return { id: 'call-1', name: 'ask_bot', args: { bot_id: botId, message: 'help me' } };
}

/** Fake broker: cards are auto-decided per the configured verdict. */
function fakeBroker(verdict: 'allowed' | 'denied' | 'expired' = 'allowed'): {
  broker: PeerApprovalBroker;
  cards: PeerApprovalCard[];
  requested: RaisePeerCardInput[];
} {
  const dir = tempDir();
  const store = new PeerApprovalStore(dir);
  const cards: PeerApprovalCard[] = [];
  const requested: RaisePeerCardInput[] = [];
  const broker: PeerApprovalBroker = {
    requestCard: async (input) => {
      requested.push(input);
      const card = store.raiseCard(input);
      cards.push(card);
      return card;
    },
    awaitDecision: async () => verdict,
    settle: () => {},
  };
  return { broker, cards, requested };
}

function gateOpts(overrides: Partial<PeerApprovalGateOpts> = {}): PeerApprovalGateOpts {
  const { broker } = fakeBroker();
  const store = new PeerApprovalStore(tempDir());
  return {
    store,
    broker,
    getBotName: (id) => ({ scout: 'Scout', coder: 'Coder' })[id] ?? id,
    ...overrides,
  };
}

describe('parsePeerCall', () => {
  it('recognizes ask_bot / message_bot with target + preview', () => {
    const p = parsePeerCall(askCall(), 'scout');
    expect(p).toMatchObject({ targetBotId: 'coder', action: 'ask', selfCall: false });
    expect(p!.preview).toBe('help me');
    const m = parsePeerCall({ id: 'c', name: 'message_bot', args: { bot_id: 'coder', message: 'hi' } }, 'scout');
    expect(m).toMatchObject({ targetBotId: 'coder', action: 'message' });
  });

  it('recognizes delegate with a bot override targeting another bot', () => {
    const p = parsePeerCall(
      { id: 'c', name: 'delegate', args: { task: 'do the thing', bot: 'coder' } },
      'scout',
    );
    expect(p).toMatchObject({ targetBotId: 'coder', action: 'delegate', selfCall: false });
  });

  it('flags self-calls and ignores non-peer tools / missing targets', () => {
    expect(parsePeerCall(askCall('scout'), 'scout')!.selfCall).toBe(true);
    expect(parsePeerCall({ id: 'c', name: 'delegate', args: { task: 'x', bot: 'scout' } }, 'scout')!.selfCall).toBe(true);
    expect(parsePeerCall({ id: 'c', name: 'delegate', args: { task: 'x' } }, 'scout')).toBeNull();
    expect(parsePeerCall({ id: 'c', name: 'read_file', args: {} }, 'scout')).toBeNull();
    expect(parsePeerCall({ id: 'c', name: 'ask_bot', args: {} }, 'scout')).toBeNull();
  });

  it('truncates the preview', () => {
    const p = parsePeerCall(
      { id: 'c', name: 'ask_bot', args: { bot_id: 'coder', message: 'x'.repeat(1000) } },
      'scout',
    );
    expect(p!.preview.length).toBeLessThanOrEqual(500);
  });
});

describe('PeerApprovalStore', () => {
  it('raises, gets, and lists cards', () => {
    const store = new PeerApprovalStore(tempDir());
    const card = store.raiseCard({
      senderBotId: 'scout',
      senderBotName: 'Scout',
      targetBotId: 'coder',
      targetBotName: 'Coder',
      actionType: 'ask',
      preview: 'help',
      sessionId: 's1',
    });
    expect(card.status).toBe('pending');
    expect(card.expiresAt - card.createdAt).toBe(PEER_CARD_TTL_MS);
    expect(store.getCard(card.id)?.id).toBe(card.id);
    expect(store.listCards('pending')).toHaveLength(1);
    expect(store.listCards('allowed')).toHaveLength(0);
    store.close();
  });

  it('decides cards: allow / deny / always-allow (+grant)', () => {
    const store = new PeerApprovalStore(tempDir());
    const mk = () =>
      store.raiseCard({
        senderBotId: 'scout',
        senderBotName: 'Scout',
        targetBotId: 'coder',
        targetBotName: 'Coder',
        actionType: 'ask',
        preview: 'help',
        sessionId: 's1',
      });
    const a = store.decideCard(mk().id, 'allow', 'user');
    expect(a.status).toBe('allowed');
    expect(a.decidedBy).toBe('user');
    const d = store.decideCard(mk().id, 'deny');
    expect(d.status).toBe('denied');
    const g = store.decideCard(mk().id, 'always-allow', 'user');
    expect(g.status).toBe('allowed');
    expect(store.hasGrant('scout', 'coder', 'ask')).toBe(true);
    expect(store.hasGrant('scout', 'coder', 'message')).toBe(false);
    // Deciding twice throws.
    expect(() => store.decideCard(a.id, 'allow')).toThrow(/not pending/);
    expect(() => store.decideCard('nope', 'allow')).toThrow(/not found/);
    store.close();
  });

  it('grants: add / list / revoke', () => {
    const store = new PeerApprovalStore(tempDir());
    store.addGrant('scout', 'coder', 'message', 'user');
    expect(store.hasGrant('scout', 'coder', 'message')).toBe(true);
    expect(store.listGrants()).toHaveLength(1);
    expect(store.listGrants()[0]).toMatchObject({
      senderBotId: 'scout',
      targetBotId: 'coder',
      actionType: 'message',
      grantedBy: 'user',
    });
    expect(store.revokeGrant('scout', 'coder', 'message')).toBe(true);
    expect(store.hasGrant('scout', 'coder', 'message')).toBe(false);
    expect(store.revokeGrant('scout', 'coder', 'message')).toBe(false);
    store.close();
  });

  it('expireStale marks overdue pending cards expired', () => {
    const store = new PeerApprovalStore(tempDir(), { ttlMs: 1 });
    const card = store.raiseCard({
      senderBotId: 'scout',
      senderBotName: 'Scout',
      targetBotId: 'coder',
      targetBotName: 'Coder',
      actionType: 'ask',
      preview: 'help',
      sessionId: 's1',
    });
    const expired = store.expireStale(Date.now() + 60_000);
    expect(expired).toEqual([card.id]);
    expect(store.getCard(card.id)?.status).toBe('expired');
    // Already-decided cards are untouched.
    const c2 = store.raiseCard({
      senderBotId: 'scout',
      senderBotName: 'Scout',
      targetBotId: 'coder',
      targetBotName: 'Coder',
      actionType: 'ask',
      preview: 'help',
      sessionId: 's1',
    });
    store.decideCard(c2.id, 'allow');
    expect(store.expireStale(Date.now() + 60_000)).toEqual([]);
    store.close();
  });

  it('dismissBotCards dismisses pending cards involving the bot', () => {
    const store = new PeerApprovalStore(tempDir());
    const mk = (from: string, to: string) =>
      store.raiseCard({
        senderBotId: from,
        senderBotName: from,
        targetBotId: to,
        targetBotName: to,
        actionType: 'ask',
        preview: 'help',
        sessionId: 's1',
      });
    const c1 = mk('scout', 'coder');
    const c2 = mk('coder', 'helper');
    const c3 = mk('helper', 'scout');
    store.decideCard(c3.id, 'deny'); // decided cards stay
    expect(store.dismissBotCards('coder')).toBe(2);
    expect(store.getCard(c1.id)?.status).toBe('dismissed');
    expect(store.getCard(c2.id)?.status).toBe('dismissed');
    expect(store.getCard(c3.id)?.status).toBe('denied');
    store.close();
  });
});

describe('createPeerApprovalGate', () => {
  it('allows non-peer tools without raising a card', async () => {
    const fb = fakeBroker();
    const store = new PeerApprovalStore(tempDir());
    const gate = createPeerApprovalGate({ store, broker: fb.broker });
    const verdict = await gate({ id: 'c', name: 'read_file', args: {} }, ctx);
    expect(verdict).toEqual({ decision: 'allow', via: 'not-peer' });
    expect(fb.requested).toHaveLength(0);
    store.close();
  });

  it('allows self-calls without a card', async () => {
    const fb = fakeBroker();
    const store = new PeerApprovalStore(tempDir());
    const gate = createPeerApprovalGate({ store, broker: fb.broker });
    const verdict = await gate(askCall('scout'), ctx);
    expect(verdict.decision).toBe('allow');
    if (verdict.decision === 'allow') expect(verdict.via).toBe('self');
    expect(fb.requested).toHaveLength(0);
    store.close();
  });

  it('raises a card and allows on approval, emitting pending/decided events', async () => {
    const fb = fakeBroker('allowed');
    const store = new PeerApprovalStore(tempDir());
    const events: StreamEvent[] = [];
    const gate = createPeerApprovalGate({
      store,
      broker: fb.broker,
      getBotName: (id) => ({ scout: 'Scout', coder: 'Coder' })[id] ?? id,
    });
    const verdict = await gate(askCall(), ctx, { onEvent: (e) => void events.push(e) });
    expect(verdict.decision).toBe('allow');
    if (verdict.decision === 'allow') {
      expect(verdict.via).toBe('card');
      expect(verdict.cardId).toBeTruthy();
    }
    expect(fb.requested).toHaveLength(1);
    expect(fb.requested[0]).toMatchObject({
      senderBotId: 'scout',
      senderBotName: 'Scout',
      targetBotId: 'coder',
      targetBotName: 'Coder',
      actionType: 'ask',
    });
    const required = events.find((e) => e.type === 'peer_approval_required');
    expect(required).toBeTruthy();
    if (required?.type === 'peer_approval_required') {
      expect(required.senderBotName).toBe('Scout');
      expect(required.targetBotName).toBe('Coder');
    }
    const decided = events.find((e) => e.type === 'peer_approval_decided');
    expect(decided).toMatchObject({ type: 'peer_approval_decided', decision: 'allowed' });
    store.close();
  });

  it('denies gracefully on user denial', async () => {
    const fb = fakeBroker('denied');
    const store = new PeerApprovalStore(tempDir());
    const gate = createPeerApprovalGate({ store, broker: fb.broker });
    const verdict = await gate(askCall(), ctx);
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') {
      expect(verdict.reason).toMatch(/denied/);
      expect(verdict.expired).toBeFalsy();
    }
    store.close();
  });

  it('denies with an expiry message when the card expires', async () => {
    const fb = fakeBroker('expired');
    const store = new PeerApprovalStore(tempDir());
    const gate = createPeerApprovalGate({ store, broker: fb.broker });
    const verdict = await gate(askCall(), ctx);
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') {
      expect(verdict.expired).toBe(true);
      expect(verdict.reason).toMatch(/expired.*15 min/);
    }
    store.close();
  });

  it('skips the card when an always-allow grant exists', async () => {
    const fb = fakeBroker();
    const store = new PeerApprovalStore(tempDir());
    store.addGrant('scout', 'coder', 'ask', 'user');
    const gate = createPeerApprovalGate({ store, broker: fb.broker });
    const verdict = await gate(askCall(), ctx);
    expect(verdict).toEqual({ decision: 'allow', via: 'grant' });
    expect(fb.requested).toHaveLength(0);
    store.close();
  });

  it('skips the gate in bypass mode', async () => {
    const fb = fakeBroker();
    const store = new PeerApprovalStore(tempDir());
    const audit = vi.fn();
    const gate = createPeerApprovalGate({
      store,
      broker: fb.broker,
      isBypassMode: (botId) => botId === 'scout',
      audit: (t, d) => void audit(t, d),
    });
    const verdict = await gate(askCall(), ctx);
    expect(verdict).toEqual({ decision: 'allow', via: 'bypass' });
    expect(fb.requested).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith('tool.peer_approval_bypassed', expect.anything());
    store.close();
  });

  it('fails closed when the broker throws', async () => {
    const store = new PeerApprovalStore(tempDir());
    const broker: PeerApprovalBroker = {
      requestCard: async () => {
        throw new Error('db gone');
      },
      awaitDecision: async () => 'allowed',
      settle: () => {},
    };
    const gate = createPeerApprovalGate({ store, broker });
    const verdict = await gate(askCall(), ctx);
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') expect(verdict.reason).toMatch(/could not be requested/);
    store.close();
  });

  it('audits the card decision', async () => {
    const fb = fakeBroker('denied');
    const store = new PeerApprovalStore(tempDir());
    const audit = vi.fn();
    const gate = createPeerApprovalGate({ store, broker: fb.broker, audit: (t, d) => void audit(t, d) });
    await gate(askCall(), ctx);
    expect(audit).toHaveBeenCalledWith(
      'tool.peer_approval_decided',
      expect.objectContaining({ verdict: 'denied', senderBotId: 'scout', targetBotId: 'coder' }),
    );
    store.close();
  });
  it('ends the wait fail-closed when the turn is aborted', async () => {
    const dir = tempDir();
    const store = new PeerApprovalStore(dir);
    const broker: PeerApprovalBroker = {
      requestCard: async (input) => store.raiseCard(input),
      // Never settles on its own — the abort must win.
      awaitDecision: () => new Promise<'allowed' | 'denied' | 'expired'>(() => {}),
      settle: () => {},
    };
    const gate = createPeerApprovalGate({ store, broker });
    const controller = new AbortController();
    const pending = gate(askCall(), ctx, { signal: controller.signal });
    // Give the gate a tick to raise the card and start waiting.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort('user interrupted');
    const verdict = await pending;
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') {
      expect(verdict.reason).toMatch(/denied/);
    }
    // The card itself stays pending (decidable in the inbox until expiry).
    expect(store.listCards('pending')).toHaveLength(1);
    store.close();
  });
});

describe('helpers', () => {
  it('isPeerActionType / isPeerDecision validators', () => {
    expect(isPeerActionType('ask')).toBe(true);
    expect(isPeerActionType('nope')).toBe(false);
    expect(isPeerDecision('always-allow')).toBe(true);
    expect(isPeerDecision('maybe')).toBe(false);
  });

  it('describePeerAction framings', () => {
    expect(describePeerAction('ask')).toBe('ask');
    expect(describePeerAction('message')).toBe('message');
    expect(describePeerAction('delegate')).toBe('delegate a subtask to');
  });
});

describe('gateOpts helper (unused default)', () => {
  it('builds default opts', () => {
    const o = gateOpts();
    expect(o.store).toBeInstanceOf(PeerApprovalStore);
    o.store.close();
  });
});
