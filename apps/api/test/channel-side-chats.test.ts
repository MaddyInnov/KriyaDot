// SPDX-License-Identifier: Apache-2.0
// Tests for durable provider side chats (CH-1/CH-5/CH-6/CH-9 state):
// - one side chat per (provider, external chat); deterministic id
// - one-transcript mirroring: same provider message id never duplicates
// - provider-titled, durable across store reopen, separate from main chat
// - quote resolution against the transcript
// - reaction set/remove state on mirrored messages

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelSideChatStore, sideChatIdFor, sideChatTitle } from '../src/channel-side-chats.js';

describe('ChannelSideChatStore', () => {
  let dir: string;
  let store: ChannelSideChatStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sidechats-'));
    store = new ChannelSideChatStore(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates exactly one chat per (provider, external chat) with a provider title (CH-1/CH-5)', () => {
    const a = store.ensureChat('whatsapp', '+15551234567');
    const b = store.ensureChat('whatsapp', '+15551234567');
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(sideChatIdFor('whatsapp', '+15551234567'));
    expect(a.title).toBe('WhatsApp · +15551234567');
    expect(sideChatTitle('telegram', '42')).toBe('Telegram · 42');
    const other = store.ensureChat('whatsapp', '+15557654321');
    expect(other.id).not.toBe(a.id);
    expect(store.listChats('whatsapp')).toHaveLength(2);
    expect(store.listChats('telegram')).toHaveLength(0);
  });

  it('refines the title when a contact name arrives, never blanks it', () => {
    store.ensureChat('whatsapp', '+1555');
    const named = store.ensureChat('whatsapp', '+1555', 'Asha Rao');
    expect(named.title).toBe('WhatsApp · Asha Rao');
    expect(store.ensureChat('whatsapp', '+1555').title).toBe('WhatsApp · Asha Rao');
  });

  it('mirrors a message exactly once — webhook redelivery dedupes (CH-1)', () => {
    const first = store.mirrorMessage({
      providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'wamid.1',
      direction: 'in', kind: 'text', text: 'hi',
    });
    const dupe = store.mirrorMessage({
      providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'wamid.1',
      direction: 'in', kind: 'text', text: 'hi (redelivered)',
    });
    expect(first.inserted).toBe(true);
    expect(dupe.inserted).toBe(false);
    expect(dupe.message.id).toBe(first.message.id);
    expect(dupe.message.text).toBe('hi'); // original kept — no second copy, no overwrite
    expect(store.listMessages(first.chat.id)).toHaveLength(1);
    expect(store.getChat(first.chat.id)?.messageCount).toBe(1);
  });

  it('is durable across reopen and keeps in/out ordering', () => {
    store.mirrorMessage({ providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'w1', direction: 'in', kind: 'text', text: 'one', atMs: 1000 });
    store.mirrorMessage({ providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'w2', direction: 'out', kind: 'text', text: 'two', atMs: 2000 });
    store.close();
    store = new ChannelSideChatStore(dir);
    const chat = store.getChatByExternal('whatsapp', '+1555');
    expect(chat?.messageCount).toBe(2);
    const msgs = store.listMessages(chat!.id);
    expect(msgs.map((m) => m.text)).toEqual(['one', 'two']);
    expect(msgs.map((m) => m.direction)).toEqual(['in', 'out']);
  });

  it('resolves quotes against the transcript and preserves the raw id (CH-6)', () => {
    const orig = store.mirrorMessage({ providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'wamid.q', direction: 'in', kind: 'text', text: 'original' });
    const reply = store.mirrorMessage({
      providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'wamid.r', direction: 'in', kind: 'text',
      text: 'reply', quotedProviderMessageId: 'wamid.q',
    });
    expect(reply.message.quotedMessageId).toBe(orig.message.id);
    expect(reply.message.quotedProviderMessageId).toBe('wamid.q');
    const orphan = store.mirrorMessage({
      providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'wamid.o', direction: 'in', kind: 'text',
      text: 'orphan quote', quotedProviderMessageId: 'wamid.missing',
    });
    expect(orphan.message.quotedMessageId).toBeUndefined();
    expect(orphan.message.quotedProviderMessageId).toBe('wamid.missing');
  });

  it('keeps typed attachment metadata on the mirrored message (CH-6)', () => {
    const { message } = store.mirrorMessage({
      providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'wamid.doc', direction: 'in', kind: 'document',
      text: 'invoice', attachment: { kind: 'document', mediaId: 'media-1', mimeType: 'application/pdf', filename: 'invoice.pdf' },
    });
    expect(message.attachment).toEqual({ kind: 'document', mediaId: 'media-1', mimeType: 'application/pdf', filename: 'invoice.pdf' });
  });

  it('tracks reaction state per actor; empty emoji removes (CH-9)', () => {
    store.mirrorMessage({ providerId: 'whatsapp', externalChatId: '+1555', providerMessageId: 'wamid.1', direction: 'in', kind: 'text', text: 'hi' });
    const chat = store.getChatByExternal('whatsapp', '+1555')!;
    const reacted = store.applyReaction(chat.id, 'wamid.1', '👍', '+1555');
    expect(reacted?.reactions).toHaveLength(1);
    expect(reacted?.reactions[0]).toMatchObject({ emoji: '👍', actor: '+1555' });
    const changed = store.applyReaction(chat.id, 'wamid.1', '❤️', '+1555');
    expect(changed?.reactions).toEqual([expect.objectContaining({ emoji: '❤️' })]);
    const removed = store.applyReaction(chat.id, 'wamid.1', '', '+1555');
    expect(removed?.reactions).toEqual([]);
    expect(store.applyReaction(chat.id, 'wamid.unknown', '👍', '+1555')).toBeNull();
  });
});
