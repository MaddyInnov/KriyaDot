// SPDX-License-Identifier: Apache-2.0
// Tests for structured channel approvals + action cards (CH-8/CH-10).
//
// The load-bearing guarantees:
// - ONLY a structured reply id issued for a prompt can decide an approval
// - free text ("yes"/"approve"/…) NEVER decides — there is no code path
// - a prompt is origin-bound (same provider + chat), single-use, expiring
// - a relayed approval still cannot be approved (governance hard floor)
// - action cards dispatch only validated taps to host handlers

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import {
  ActionCardRegistry,
  ChannelApprovalService,
  approvalButtonSpecs,
  parseActionReplyId,
  parseApprovalReplyId,
} from '../src/channel-approvals.js';

describe('ChannelApprovalService (CH-10)', () => {
  let governance: GovernanceGateway;
  let service: ChannelApprovalService;
  let now = 1_000_000;

  beforeEach(() => {
    governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    service = new ChannelApprovalService({ governance, now: () => now, promptTtlMs: 60_000 });
  });
  afterEach(() => governance.close());

  function pendingApproval(): string {
    return governance.requestApproval('message.send', { providerId: 'whatsapp', to: '+1', text: 'hi' }, {
      sessionId: 's1', botId: 'system', actor: 'api',
    });
  }

  it('decides an approval from a structured button reply id', () => {
    const approvalId = pendingApproval();
    const { prompt, approveReplyId } = service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1555' });
    const outcome = service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: approveReplyId, actor: '+1555' });
    expect(outcome).toEqual({ handled: true, promptId: prompt.promptId, approvalId, decision: 'approved' });
    expect(governance.getApproval(approvalId)?.status).toBe('approved');
  });

  it('denies from the deny button id', () => {
    const approvalId = pendingApproval();
    const { denyReplyId } = service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1555' });
    const outcome = service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: denyReplyId });
    expect(outcome).toMatchObject({ handled: true, decision: 'denied' });
    expect(governance.getApproval(approvalId)?.status).toBe('denied');
  });

  it('NEVER decides from free text — no wording is treated as approval', () => {
    const approvalId = pendingApproval();
    service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1555' });
    for (const text of ['yes', 'Yes', 'approve', 'Approved', 'ok', '👍', 'y', 'go ahead', 'APPROVE']) {
      expect(service.handleFreeText({ providerId: 'whatsapp', chatId: '+1555', text })).toEqual({
        handled: false, reason: 'free-text-never-decides',
      });
      // Even routed into the structured entry point by mistake, text is not an id.
      expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: text })).toEqual({
        handled: false, reason: 'not-a-structured-approval-reply',
      });
    }
    expect(governance.getApproval(approvalId)?.status).toBe('pending');
  });

  it('rejects unknown, tampered, and malformed reply ids', () => {
    const approvalId = pendingApproval();
    const { prompt } = service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1555' });
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: 'kap:nope:approved' })).toEqual({ handled: false, reason: 'unknown-prompt' });
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: `kap:${prompt.promptId}:maybe` })).toEqual({ handled: false, reason: 'not-a-structured-approval-reply' });
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: 42 })).toEqual({ handled: false, reason: 'not-a-structured-approval-reply' });
    expect(parseApprovalReplyId(`kap:${prompt.promptId}:approved`)).toEqual({ promptId: prompt.promptId, decision: 'approved' });
    expect(parseApprovalReplyId('hello')).toBeNull();
    expect(governance.getApproval(approvalId)?.status).toBe('pending');
  });

  it('is origin-bound: a tap from a different chat or provider cannot decide', () => {
    const approvalId = pendingApproval();
    const { approveReplyId } = service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1555' });
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1666', replyId: approveReplyId })).toEqual({ handled: false, reason: 'wrong-chat' });
    expect(service.handleInteractiveReply({ providerId: 'telegram', chatId: '+1555', replyId: approveReplyId })).toEqual({ handled: false, reason: 'wrong-chat' });
    expect(governance.getApproval(approvalId)?.status).toBe('pending');
  });

  it('is single-use and expires', () => {
    const approvalId = pendingApproval();
    const { approveReplyId, denyReplyId } = service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1555' });
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: approveReplyId }).handled).toBe(true);
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: denyReplyId })).toEqual({ handled: false, reason: 'already-consumed' });

    const approvalId2 = pendingApproval();
    const second = service.createApprovalPrompt({ approvalId: approvalId2, providerId: 'whatsapp', chatId: '+1555' });
    now += 61_000;
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: second.approveReplyId })).toEqual({ handled: false, reason: 'expired' });
    expect(governance.getApproval(approvalId2)?.status).toBe('pending');
  });

  it('refuses to prompt for a missing or already-decided approval', () => {
    expect(() => service.createApprovalPrompt({ approvalId: 'nope', providerId: 'whatsapp', chatId: '+1' })).toThrow(/not found/);
    const approvalId = pendingApproval();
    governance.decide(approvalId, 'denied');
    expect(() => service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1' })).toThrow(/not pending/);
  });

  it('a relayed approval can never be approved, even via a structured tap (hard floor intact)', () => {
    const approvalId = governance.requestApproval('message.send', { text: 'x' }, { sessionId: 's', botId: 'b', actor: 'a' }, { relayed: true });
    const { approveReplyId, denyReplyId, prompt } = service.createApprovalPrompt({ approvalId, providerId: 'whatsapp', chatId: '+1555' });
    const outcome = service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: approveReplyId });
    expect(outcome).toMatchObject({ handled: false, reason: 'governance-refused' });
    expect(governance.getApproval(approvalId)?.status).toBe('pending');
    expect(service.getPrompt(prompt.promptId)?.consumed).toBe(false);
    // Deny still works.
    expect(service.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: denyReplyId })).toMatchObject({ handled: true, decision: 'denied' });
  });

  it('approval button specs fit WhatsApp limits and carry the structured ids', () => {
    const specs = approvalButtonSpecs('kap:p:approved', 'kap:p:denied');
    expect(specs.map((s) => s.id)).toEqual(['kap:p:approved', 'kap:p:denied']);
    for (const s of specs) expect([...s.title].length).toBeLessThanOrEqual(20);
  });
});

describe('ActionCardRegistry (CH-8)', () => {
  it('dispatches validated connect / open-artifact taps to host handlers exactly once', async () => {
    const onConnect = vi.fn();
    const onOpen = vi.fn();
    const registry = new ActionCardRegistry({
      handlers: { connect: onConnect, 'open-artifact': onOpen },
    });
    const card = registry.createCard({ kind: 'connect', providerId: 'whatsapp', chatId: '+1555' });
    const replyId = card.replyIdFor('connect');
    expect(parseActionReplyId(replyId)).toEqual({ cardId: card.cardId, action: 'connect' });
    const out = await registry.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId, actor: '+1555' });
    expect(out).toMatchObject({ handled: true, action: 'connect' });
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    const again = await registry.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId });
    expect(again).toEqual({ handled: false, reason: 'already-consumed' });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong-chat, unknown, and free-text taps', async () => {
    const onConnect = vi.fn();
    const registry = new ActionCardRegistry({ handlers: { connect: onConnect } });
    const card = registry.createCard({ kind: 'connect', providerId: 'whatsapp', chatId: '+1555' });
    expect(await registry.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1666', replyId: card.replyIdFor('connect') })).toEqual({ handled: false, reason: 'wrong-chat' });
    expect(await registry.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: 'connect' })).toEqual({ handled: false, reason: 'not-a-structured-action-reply' });
    expect(await registry.handleInteractiveReply({ providerId: 'whatsapp', chatId: '+1555', replyId: 'kac:missing:connect' })).toEqual({ handled: false, reason: 'unknown-card' });
    expect(onConnect).not.toHaveBeenCalled();
  });
});
