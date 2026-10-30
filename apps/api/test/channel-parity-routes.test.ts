// SPDX-License-Identifier: Apache-2.0
// Route tests for the Muse-parity channel layer (CH-1..CH-10):
// - WhatsApp webhook: handshake, mirroring (once), quote resolution,
//   reaction bridging, structured button approval decisions, and the
//   guarantee that a free-text "yes" in the same webhook decides NOTHING
// - approval prompt route sends a button card via the mock transport
// - media send is approval-gated exactly like text sends
// - connections begin/complete/disconnect + side-chat read surfaces
// Zero network: the WhatsApp transport is an injected mock.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { createChannelParityRouter, type ChannelParityHandle } from '../src/channel-parity-routes.js';
import type { WhatsAppTransport } from '../src/whatsapp-cloud.js';
import type { ProviderKeyInput } from '../src/providers.js';

const FROM = '919999999999';

function waWebhook(messages: unknown[]): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'b', changes: [{ field: 'messages', value: { contacts: [{ profile: { name: 'Asha Rao' }, wa_id: FROM }], messages } }] }],
  };
}

describe('channel parity routes', () => {
  let dir: string;
  let governance: GovernanceGateway;
  let handle: ChannelParityHandle;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  let savedKeys: Map<string, ProviderKeyInput>;
  const sentPayloads: Array<{ method: string; args: unknown[] }> = [];
  const onMessage = vi.fn(async () => undefined);
  const reactionToggles: Array<{ sessionId: string; messageId: string; emoji: string; userId: string }> = [];

  function mockTransport(): WhatsAppTransport {
    const rec = (method: string) => async (...args: unknown[]) => {
      sentPayloads.push({ method, args });
      return { ok: true as const, id: `wamid.out-${sentPayloads.length}` };
    };
    return {
      sendPayload: rec('sendPayload') as WhatsAppTransport['sendPayload'],
      sendText: rec('sendText') as WhatsAppTransport['sendText'],
      sendMedia: rec('sendMedia') as WhatsAppTransport['sendMedia'],
      sendButtons: rec('sendButtons') as WhatsAppTransport['sendButtons'],
      sendCtaUrl: rec('sendCtaUrl') as WhatsAppTransport['sendCtaUrl'],
      sendReaction: rec('sendReaction') as WhatsAppTransport['sendReaction'],
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chanparity-'));
    savedKeys = new Map();
    sentPayloads.length = 0;
    reactionToggles.length = 0;
    onMessage.mockClear();
    governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json());
    handle = createChannelParityRouter({
      dataDir: dir,
      governance,
      saveKey: (ref, input) => { savedKeys.set(ref, input); },
      removeKey: (ref) => savedKeys.delete(ref),
      createTransport: () => mockTransport(),
      verifyToken: 'verify-me',
      reactionStore: {
        toggle: (sessionId, messageId, emoji, userId) => { reactionToggles.push({ sessionId, messageId, emoji, userId }); return {}; },
        list: () => [],
      },
      onMessage,
    });
    app.use('/api/messaging', handle.router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/messaging`;
  });

  afterEach(async () => {
    governance.close();
    handle.sideChats.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('verifies the webhook handshake and rejects a wrong token', async () => {
    const ok = await fetch(`${baseUrl}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=xyz`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('xyz');
    const bad = await fetch(`${baseUrl}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=xyz`);
    expect(bad.status).toBe(403);
  });

  it('mirrors an inbound WhatsApp message once into a titled side chat (CH-1/CH-5)', async () => {
    const payload = waWebhook([{ id: 'wamid.1', from: FROM, timestamp: '1700000000', type: 'text', text: { body: 'hello agent' } }]);
    const res = await post('/whatsapp/webhook', payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mirrored: 1 });
    // Redelivery of the same webhook changes nothing.
    const again = await post('/whatsapp/webhook', payload);
    expect(await again.json()).toMatchObject({ mirrored: 0 });
    const chats = (await (await fetch(`${baseUrl}/side-chats?provider=whatsapp`)).json()) as { sideChats: Array<{ id: string; title: string; messageCount: number }> };
    expect(chats.sideChats).toHaveLength(1);
    expect(chats.sideChats[0].title).toBe('WhatsApp · Asha Rao');
    expect(chats.sideChats[0].messageCount).toBe(1);
    const msgs = (await (await fetch(`${baseUrl}/side-chats/${chats.sideChats[0].id}/messages`)).json()) as { messages: Array<{ text: string; direction: string }> };
    expect(msgs.messages).toEqual([expect.objectContaining({ text: 'hello agent', direction: 'in' })]);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('resolves an inbound quote against the mirrored transcript (CH-6)', async () => {
    await post('/whatsapp/webhook', waWebhook([{ id: 'wamid.q', from: FROM, timestamp: '1700000000', type: 'text', text: { body: 'original' } }]));
    await post('/whatsapp/webhook', waWebhook([
      { id: 'wamid.r', from: FROM, timestamp: '1700000001', type: 'text', text: { body: 'quoted reply' }, context: { id: 'wamid.q', from: FROM } },
    ]));
    const chat = handle.sideChats.getChatByExternal('whatsapp', FROM)!;
    const msgs = handle.sideChats.listMessages(chat.id);
    expect(msgs[1].quotedMessageId).toBe(msgs[0].id);
    expect(msgs[1].quotedProviderMessageId).toBe('wamid.q');
  });

  it('bridges an inbound reaction to the side chat + in-app reaction store (CH-9)', async () => {
    await post('/whatsapp/webhook', waWebhook([{ id: 'wamid.1', from: FROM, timestamp: '1700000000', type: 'text', text: { body: 'hi' } }]));
    const res = await post('/whatsapp/webhook', waWebhook([
      { id: 'wamid.r1', from: FROM, timestamp: '1700000001', type: 'reaction', reaction: { message_id: 'wamid.1', emoji: '👍' } },
    ]));
    expect(await res.json()).toMatchObject({ reactions: 1 });
    const chat = handle.sideChats.getChatByExternal('whatsapp', FROM)!;
    const target = handle.sideChats.getMessageByProviderId(chat.id, 'wamid.1')!;
    expect(target.reactions).toEqual([expect.objectContaining({ emoji: '👍', actor: FROM })]);
    expect(reactionToggles).toEqual([{ sessionId: chat.id, messageId: target.id, emoji: '👍', userId: FROM }]);
  });

  it('decides an approval ONLY from the structured button tap — free text "yes" decides nothing (CH-10)', async () => {
    const approvalId = governance.requestApproval('message.send', { providerId: 'whatsapp', to: FROM, text: 'send it' }, { sessionId: 's', botId: 'system', actor: 'api' });
    const promptRes = await post('/channel-approvals', { approvalId, providerId: 'whatsapp', chatId: FROM });
    expect(promptRes.status).toBe(200);
    const prompt = (await promptRes.json()) as { approveReplyId: string; sent: boolean };
    expect(prompt.sent).toBe(true);
    expect(sentPayloads.some((p) => p.method === 'sendButtons')).toBe(true);

    // 1) A free-text "yes" webhook message must NOT decide it.
    await post('/whatsapp/webhook', waWebhook([{ id: 'wamid.txt', from: FROM, timestamp: '1700000002', type: 'text', text: { body: 'yes' } }]));
    expect(governance.getApproval(approvalId)?.status).toBe('pending');

    // 2) The structured button tap decides it.
    const tapRes = await post('/whatsapp/webhook', waWebhook([
      { id: 'wamid.tap', from: FROM, timestamp: '1700000003', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: prompt.approveReplyId, title: '✅ Approve' } } },
    ]));
    expect(await tapRes.json()).toMatchObject({ decisions: 1 });
    expect(governance.getApproval(approvalId)?.status).toBe('approved');
  });

  it('gates WhatsApp media sends behind governance approval (CH-7)', async () => {
    // Denied (no decision before the wait elapses) → provider never called.
    const denied = await post('/whatsapp/send-media', { to: FROM, kind: 'image', link: 'https://example.com/x.png', waitMs: 10 });
    expect(denied.status).toBe(403);
    expect(sentPayloads.some((p) => p.method === 'sendMedia')).toBe(false);

    // Approved → media goes out and is mirrored as an outbound message.
    const sendPromise = post('/whatsapp/send-media', { to: FROM, kind: 'document', mediaId: 'media-9', filename: 'a.pdf', waitMs: 8000 });
    const deadline = Date.now() + 5000;
    let approvalId = '';
    while (!approvalId && Date.now() < deadline) {
      const pending = governance.listApprovals('pending').find((a) => a.toolName === 'message.send');
      if (pending) approvalId = pending.id;
      else await new Promise((r) => setTimeout(r, 25));
    }
    governance.decide(approvalId, 'approved');
    const sent = await sendPromise;
    expect(sent.status).toBe(200);
    expect(sentPayloads.some((p) => p.method === 'sendMedia')).toBe(true);
    const chat = handle.sideChats.getChatByExternal('whatsapp', FROM)!;
    expect(handle.sideChats.listMessages(chat.id).some((m) => m.direction === 'out' && m.kind === 'document')).toBe(true);
  });

  it('rejects HTML media at the route with the honest error, before any approval (CH-7)', async () => {
    const res = await post('/whatsapp/send-media', { to: FROM, kind: 'html', link: 'https://example.com/x.html', waitMs: 8000 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no HTML message type/);
    expect(sentPayloads.some((p) => p.method === 'sendMedia')).toBe(false);
    expect(governance.listApprovals('pending')).toHaveLength(0);
  });

  it('runs the unified connect flow + disconnect over HTTP (CH-2/CH-3)', async () => {
    const begin = await post('/connections/whatsapp/connect/begin', {});
    expect(begin.status).toBe(200);
    const { flowId } = (await begin.json()) as { flowId: string };
    const complete = await post('/connections/whatsapp/connect/complete', {
      flowId, credentials: { apiKey: 'wa-tok' }, settings: { phoneNumberId: 'pn-1' },
    });
    expect(complete.status).toBe(200);
    expect(savedKeys.get('custom-whatsapp')?.apiKey).toBe('wa-tok');
    const list = (await (await fetch(`${baseUrl}/connections`)).json()) as { connections: Array<{ providerId: string; status: string }> };
    expect(list.connections.find((c) => c.providerId === 'whatsapp')?.status).toBe('connected');
    const disc = await post('/connections/whatsapp/disconnect', {});
    expect(disc.status).toBe(200);
    expect(savedKeys.has('custom-whatsapp')).toBe(false);
    const list2 = (await (await fetch(`${baseUrl}/connections`)).json()) as { connections: Array<{ providerId: string; status: string }> };
    expect(list2.connections.find((c) => c.providerId === 'whatsapp')?.status).toBe('disconnected');
  });

  it('sends an outbound reaction and bridges it in-app (CH-9)', async () => {
    await post('/whatsapp/webhook', waWebhook([{ id: 'wamid.1', from: FROM, timestamp: '1700000000', type: 'text', text: { body: 'hi' } }]));
    const chat = handle.sideChats.getChatByExternal('whatsapp', FROM)!;
    const res = await post(`/side-chats/${chat.id}/reactions`, { providerMessageId: 'wamid.1', emoji: '❤️' });
    expect(res.status).toBe(200);
    expect(sentPayloads.some((p) => p.method === 'sendReaction')).toBe(true);
    const target = handle.sideChats.getMessageByProviderId(chat.id, 'wamid.1')!;
    expect(target.reactions).toEqual([expect.objectContaining({ emoji: '❤️', actor: 'user' })]);
    expect(reactionToggles.some((t) => t.emoji === '❤️' && t.userId === 'user')).toBe(true);
  });
});
