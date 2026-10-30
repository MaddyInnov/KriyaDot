// SPDX-License-Identifier: Apache-2.0
// C-5: provider conversations generally mirror into the Wave-4 side-chat
// store — one durable titled chat per (provider, external chat), deduped.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelSideChatStore } from '../src/channel-side-chats.js';
import { MIRRORED_PROVIDERS, isMirroredProvider, mirrorProviderMessage, createProviderConversationsRouter } from '../src/provider-conversations.js';

let dir: string; let store: ChannelSideChatStore; let server: Server; let base: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'provider-conv-'));
  store = new ChannelSideChatStore(dir);
  const app = express(); app.use(express.json());
  app.use('/api', createProviderConversationsRouter({ store }));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('C-5 generalized mirroring', () => {
  it('covers the general provider set beyond WhatsApp', () => {
    expect(MIRRORED_PROVIDERS).toContain('telegram');
    expect(MIRRORED_PROVIDERS).toContain('slack');
    expect(isMirroredProvider('whatsapp')).toBe(true);
    expect(isMirroredProvider('smoke-signals')).toBe(false);
  });
  it('mirrors telegram + slack conversations into the same store, titled per provider', () => {
    const tg = mirrorProviderMessage(store, { providerId: 'telegram', externalChatId: '42', direction: 'in', kind: 'text', text: 'hi', providerMessageId: 'tg1', contactName: 'Asha' });
    expect(tg.chat.title).toBe('Telegram · Asha');
    expect(tg.knownProvider).toBe(true);
    const sl = mirrorProviderMessage(store, { providerId: 'slack', externalChatId: 'C123', direction: 'out', kind: 'text', text: 'yo', providerMessageId: 'sl1', conversationLabel: '#general' });
    expect(sl.chat.title).toBe('Slack · #general');
    expect(store.listChats()).toHaveLength(2);
    expect(store.listChats('telegram')).toHaveLength(1);
  });
  it('dedupes redeliveries for non-WhatsApp providers too (CH-1 rule)', () => {
    const a = mirrorProviderMessage(store, { providerId: 'discord', externalChatId: 'chan1', direction: 'in', kind: 'text', text: 'x', providerMessageId: 'd1' });
    const b = mirrorProviderMessage(store, { providerId: 'discord', externalChatId: 'chan1', direction: 'in', kind: 'text', text: 'x again', providerMessageId: 'd1' });
    expect(a.inserted).toBe(true); expect(b.inserted).toBe(false);
    expect(store.listMessages(a.chat.id)).toHaveLength(1);
  });
  it('routes: mirror → list → messages round-trip; bad input 400', async () => {
    const res = await fetch(`${base}/api/provider-conversations/mirror`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'signal', externalChatId: '+1555', direction: 'in', kind: 'text', text: 'hello', providerMessageId: 's1' }) });
    expect(res.status).toBe(201);
    const list = (await (await fetch(`${base}/api/provider-conversations?provider=signal`)).json()) as { chats: unknown[] };
    expect(list.chats).toHaveLength(1);
    const msgs = (await (await fetch(`${base}/api/provider-conversations/signal/%2B1555/messages`)).json()) as { messages: Array<{ text?: string }> };
    expect(msgs.messages[0]?.text).toBe('hello');
    const bad = await fetch(`${base}/api/provider-conversations/mirror`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'signal' }) });
    expect(bad.status).toBe(400);
  });
});
