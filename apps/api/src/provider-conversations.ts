// SPDX-License-Identifier: Apache-2.0
// Provider conversations as durable side chats (Muse parity §4.5 C-5).
//
// Wave 4 shipped ChannelSideChatStore (channel-side-chats.ts) for
// WhatsApp with the one-transcript mirroring rule (CH-1). C-5 extends
// that rule to provider conversations GENERALLY: any external provider
// conversation — Telegram, Slack, Discord, Signal, email threads,
// iMessage bridges — mirrors into the SAME store under its own
// providerId, so every provider gets exactly one durable, titled side
// chat per external conversation, deduped by provider message id.
// No second store, no per-provider transcript silos.

import express, { type Router } from 'express';
import {
  ChannelSideChatStore,
  type MirrorInboundInput,
  type SideChat,
  type SideChatMessage,
} from './channel-side-chats.js';

/** Providers whose conversations mirror into side chats under C-5. */
export const MIRRORED_PROVIDERS = [
  'whatsapp', 'telegram', 'slack', 'discord', 'signal', 'email', 'imessage', 'messenger', 'instagram',
] as const;
export type MirroredProvider = (typeof MIRRORED_PROVIDERS)[number];

export function isMirroredProvider(providerId: string): boolean {
  return (MIRRORED_PROVIDERS as readonly string[]).includes(providerId);
}

export interface ProviderMirrorInput extends MirrorInboundInput {
  /** Free-form provider conversation label used when no contact name exists. */
  conversationLabel?: string;
}

/**
 * Mirror one provider-conversation message into the shared side-chat
 * store. Unknown providers are accepted too (forward-compatible: a new
 * bridge mirrors by passing its providerId) but flagged via
 * `knownProvider` so the UI can badge unvetted bridges.
 */
export function mirrorProviderMessage(
  store: ChannelSideChatStore,
  input: ProviderMirrorInput,
): { message: SideChatMessage; inserted: boolean; chat: SideChat; knownProvider: boolean } {
  const { conversationLabel, ...rest } = input;
  const result = store.mirrorMessage({
    ...rest,
    contactName: input.contactName ?? conversationLabel,
  });
  return { ...result, knownProvider: isMirroredProvider(input.providerId) };
}

/** All mirrored provider conversations, optionally for one provider. */
export function listProviderConversations(store: ChannelSideChatStore, providerId?: string): SideChat[] {
  return store.listChats(providerId);
}

export function createProviderConversationsRouter(deps: { store: ChannelSideChatStore }): Router {
  const router = express.Router();
  router.get('/provider-conversations', (req, res) => {
    const providerId = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    res.json({ ok: true, providers: MIRRORED_PROVIDERS, chats: listProviderConversations(deps.store, providerId) });
  });
  router.get('/provider-conversations/:providerId/:externalChatId/messages', (req, res) => {
    const chat = deps.store.getChatByExternal(req.params.providerId, req.params.externalChatId);
    if (!chat) { res.status(404).json({ ok: false, error: 'no mirrored conversation for this provider chat' }); return; }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json({ ok: true, chat, messages: deps.store.listMessages(chat.id, limit) });
  });
  // Bridge intake: a provider bridge (or a test) mirrors one message.
  router.post('/provider-conversations/mirror', (req, res) => {
    const b = (req.body ?? {}) as Partial<ProviderMirrorInput>;
    if (typeof b.providerId !== 'string' || !b.providerId || typeof b.externalChatId !== 'string' || !b.externalChatId) {
      res.status(400).json({ ok: false, error: 'providerId and externalChatId are required' }); return;
    }
    if (b.direction !== 'in' && b.direction !== 'out') {
      res.status(400).json({ ok: false, error: "direction must be 'in' or 'out'" }); return;
    }
    try {
      const out = mirrorProviderMessage(deps.store, {
        providerId: b.providerId, externalChatId: b.externalChatId, direction: b.direction,
        kind: b.kind ?? 'text', text: b.text, providerMessageId: b.providerMessageId,
        contactName: b.contactName, conversationLabel: b.conversationLabel,
        quotedProviderMessageId: b.quotedProviderMessageId, attachment: b.attachment, location: b.location,
      });
      res.status(out.inserted ? 201 : 200).json({ ok: true, inserted: out.inserted, knownProvider: out.knownProvider, chat: out.chat, message: out.message });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'mirror failed' });
    }
  });
  return router;
}
