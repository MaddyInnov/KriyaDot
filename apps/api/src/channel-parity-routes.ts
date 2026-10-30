// SPDX-License-Identifier: Apache-2.0
// Routes for the Muse-parity messaging-channel layer (§4.6: CH-1..CH-10).
//
// Mount point (host wiring — see the WIRING note): under /api/messaging,
// alongside registerMessagingRoutes / createChannelConfigRouter:
//
//   Connections (CH-2/CH-3)
//     GET  /messaging/connections
//     POST /messaging/connections/:providerId/connect/begin
//     POST /messaging/connections/:providerId/connect/complete { flowId, credentials, settings }
//     POST /messaging/connections/:providerId/disconnect
//   Side chats (CH-1/CH-5)
//     GET  /messaging/side-chats?provider=whatsapp
//     GET  /messaging/side-chats/:id/messages
//   WhatsApp webhook (CH-1/CH-6/CH-9/CH-10 inbound)
//     GET  /messaging/whatsapp/webhook   (Meta verification handshake)
//     POST /messaging/whatsapp/webhook   (signature-checked when an app
//          secret is configured; events are mirrored once into the side
//          chat, reactions bridged, structured button replies routed to
//          the approval service — free text is NEVER a decision)
//   Approvals + cards (CH-8/CH-10 outbound)
//     POST /messaging/channel-approvals { approvalId, providerId, chatId }
//   Media (CH-7, approval-gated exactly like text sends)
//     POST /messaging/whatsapp/send-media { to, kind, link|mediaId, caption?, filename?, waitMs? }
//   Reactions (CH-9 outbound)
//     POST /messaging/side-chats/:id/reactions { providerMessageId, emoji }

import express, { type Router } from 'express';
import type { GovernanceGateway } from '@mvp/governance';
import { ChannelSideChatStore, type SideChatMessageKind } from './channel-side-chats.js';
import { ChannelApprovalService, ActionCardRegistry, approvalButtonSpecs } from './channel-approvals.js';
import { ChannelConnectionService } from './channel-connections.js';
import {
  buildWhatsAppMediaPayload,
  createWhatsAppTransport,
  parseWhatsAppWebhook,
  verifyWhatsAppWebhookHandshake,
  verifyWhatsAppWebhookSignature,
  type WhatsAppInboundEvent,
  type WhatsAppMediaInput,
  type WhatsAppTransport,
} from './whatsapp-cloud.js';
import { deliverApprovedSend, requestSendApproval, resolveWhatsAppPhoneNumberId, resolveWhatsAppToken } from './messaging.js';

export interface ChannelParityDeps {
  dataDir: string;
  governance: GovernanceGateway;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Encrypted provider-key store hooks (providers.ts saveProviderKey/removeProviderKey). */
  saveKey: (credentialRef: string, input: import('./providers.js').ProviderKeyInput) => void;
  removeKey: (credentialRef: string) => boolean;
  probe?: (providerId: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Injectable for tests; default builds the real Cloud transport from stored credentials. */
  createTransport?: () => WhatsAppTransport;
  /** WhatsApp webhook verify token; default: env WHATSAPP_VERIFY_TOKEN, then the connect-flow secret via resolveStoredWebhookSecret. */
  verifyToken?: string;
  resolveStoredWebhookSecret?: () => string | undefined;
  /** WhatsApp app secret for POST signature checks; default env WHATSAPP_APP_SECRET. Unset → signature check skipped (handshake still enforced). */
  appSecret?: string;
  /** In-app reaction store bridge (MessageReactionStore-compatible subset). */
  reactionStore?: {
    toggle(sessionId: string, messageId: string, emoji: string, userId: string): unknown;
    list(sessionId: string, messageId: string): Array<{ emoji: string; userId: string }>;
  };
  /** Agent-turn hook for plain inbound channel messages (host wires the chat pipeline). */
  onMessage?: (info: { providerId: string; chatId: string; from?: string; text: string; sideChatId: string }) => Promise<void> | void;
  /** Host callbacks for action cards (connect / open artifact). */
  actionHandlers?: import('./channel-approvals.js').ActionCardRegistryDeps['handlers'];
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export interface ChannelParityHandle {
  router: Router;
  sideChats: ChannelSideChatStore;
  approvals: ChannelApprovalService;
  actionCards: ActionCardRegistry;
  connections: ChannelConnectionService;
}

export function createChannelParityRouter(deps: ChannelParityDeps): ChannelParityHandle {
  const router = express.Router();
  const audit = deps.audit ?? ((action, fields) => deps.governance.audit(action, fields));
  const sideChats = new ChannelSideChatStore(deps.dataDir);
  const approvals = new ChannelApprovalService({ governance: deps.governance, audit });
  const actionCards = new ActionCardRegistry({ handlers: deps.actionHandlers ?? {}, audit });
  const connections = new ChannelConnectionService({
    dataDir: deps.dataDir,
    saveKey: deps.saveKey,
    removeKey: deps.removeKey,
    ...(deps.probe ? { probe: deps.probe } : {}),
    audit,
  });

  const transport = (): WhatsAppTransport =>
    deps.createTransport
      ? deps.createTransport()
      : createWhatsAppTransport({ token: resolveWhatsAppToken(deps.dataDir), phoneNumberId: resolveWhatsAppPhoneNumberId() });

  // ---- Connections (CH-2/CH-3) -------------------------------------------
  router.get('/connections', (_req, res) => {
    res.json({ ok: true, connections: connections.listConnections() });
  });

  router.post('/connections/:providerId/connect/begin', (req, res) => {
    try {
      const begun = connections.beginConnect(req.params.providerId);
      res.json({
        ok: true,
        flowId: begun.flowId,
        steps: begun.steps,
        expiresAt: begun.expiresAt,
        credentialFields: begun.descriptor.credentialFields,
        settingFields: begun.descriptor.settingFields ?? [],
      });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to begin connect'));
    }
  });

  router.post('/connections/:providerId/connect/complete', async (req, res) => {
    const body = (req.body ?? {}) as { flowId?: unknown; credentials?: Record<string, string>; settings?: Record<string, string> };
    if (typeof body.flowId !== 'string' || !body.flowId) {
      res.status(400).json(errorBody('flowId is required'));
      return;
    }
    try {
      const done = await connections.completeConnect(body.flowId, {
        credentials: body.credentials ?? {},
        ...(body.settings ? { settings: body.settings } : {}),
      });
      if (done.providerId !== req.params.providerId) {
        res.status(400).json(errorBody('flow does not belong to this provider'));
        return;
      }
      // webhookSecret is generated material shown once for provider-side
      // webhook registration — never the user's credential.
      res.json({ ok: true, providerId: done.providerId, status: done.status, webhookSecret: done.webhookSecret });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to complete connect'));
    }
  });

  router.post('/connections/:providerId/disconnect', (req, res) => {
    try {
      const out = connections.disconnect(req.params.providerId);
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to disconnect'));
    }
  });

  // ---- Side chats (CH-1/CH-5) --------------------------------------------
  router.get('/side-chats', (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    res.json({ ok: true, sideChats: sideChats.listChats(provider) });
  });

  router.get('/side-chats/:id/messages', (req, res) => {
    const chat = sideChats.getChat(req.params.id);
    if (!chat) {
      res.status(404).json(errorBody(`Unknown side chat "${req.params.id}"`));
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json({ ok: true, sideChat: chat, messages: sideChats.listMessages(chat.id, limit) });
  });

  // ---- Reactions outbound (CH-9) ------------------------------------------
  router.post('/side-chats/:id/reactions', async (req, res) => {
    const chat = sideChats.getChat(req.params.id);
    if (!chat) {
      res.status(404).json(errorBody(`Unknown side chat "${req.params.id}"`));
      return;
    }
    const body = (req.body ?? {}) as { providerMessageId?: unknown; emoji?: unknown };
    if (typeof body.providerMessageId !== 'string' || !body.providerMessageId || typeof body.emoji !== 'string') {
      res.status(400).json(errorBody('providerMessageId and emoji are required (emoji may be "" to remove)'));
      return;
    }
    if (chat.providerId !== 'whatsapp') {
      res.status(400).json(errorBody(`Outbound reactions are implemented for WhatsApp; "${chat.providerId}" is not supported yet`));
      return;
    }
    try {
      await transport().sendReaction(chat.externalChatId, body.providerMessageId, body.emoji);
      const updated = sideChats.applyReaction(chat.id, body.providerMessageId, body.emoji, 'user');
      // Bridge into the in-app reaction store so the app UI shows it too.
      if (updated && deps.reactionStore && body.emoji) {
        const existing = deps.reactionStore.list(chat.id, updated.id);
        if (!existing.some((r) => r.emoji === body.emoji && r.userId === 'user')) {
          deps.reactionStore.toggle(chat.id, updated.id, body.emoji, 'user');
        }
      }
      res.json({ ok: true, message: updated });
    } catch (err) {
      res.status(500).json(errorBody('Failed to send reaction', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Approval prompts (CH-8/CH-10 outbound) ------------------------------
  router.post('/channel-approvals', async (req, res) => {
    const body = (req.body ?? {}) as { approvalId?: unknown; providerId?: unknown; chatId?: unknown };
    if (typeof body.approvalId !== 'string' || typeof body.providerId !== 'string' || typeof body.chatId !== 'string') {
      res.status(400).json(errorBody('approvalId, providerId and chatId are required'));
      return;
    }
    let created: ReturnType<ChannelApprovalService['createApprovalPrompt']>;
    try {
      created = approvals.createApprovalPrompt({ approvalId: body.approvalId, providerId: body.providerId, chatId: body.chatId });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to create approval prompt'));
      return;
    }
    const rec = deps.governance.getApproval(body.approvalId);
    const text =
      `Approval requested: ${rec?.toolName ?? 'action'}\n` +
      `${JSON.stringify(rec?.args ?? {}).slice(0, 700)}\n\nTap a button to decide. Typed replies are never treated as a decision.`;
    let sent = false;
    let sendError: string | undefined;
    if (body.providerId === 'whatsapp') {
      try {
        const result = await transport().sendButtons(body.chatId, text, approvalButtonSpecs(created.approveReplyId, created.denyReplyId));
        sent = true;
        sideChats.mirrorMessage({
          providerId: 'whatsapp',
          externalChatId: body.chatId,
          providerMessageId: result.id,
          direction: 'out',
          kind: 'approval',
          text,
        });
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }
    }
    res.json({
      ok: true,
      promptId: created.prompt.promptId,
      approveReplyId: created.approveReplyId,
      denyReplyId: created.denyReplyId,
      expiresAt: created.prompt.expiresAt,
      sent,
      ...(sendError ? { sendError } : {}),
    });
  });

  // ---- WhatsApp media send (CH-7, approval-gated) ---------------------------
  router.post('/whatsapp/send-media', async (req, res) => {
    const body = (req.body ?? {}) as {
      to?: unknown; kind?: unknown; link?: unknown; mediaId?: unknown; caption?: unknown; filename?: unknown; waitMs?: unknown;
    };
    if (typeof body.to !== 'string' || !body.to || typeof body.kind !== 'string' || !body.kind) {
      res.status(400).json(errorBody('to and kind are required'));
      return;
    }
    const input: WhatsAppMediaInput = {
      kind: body.kind as WhatsAppMediaInput['kind'],
      ...(typeof body.link === 'string' ? { link: body.link } : {}),
      ...(typeof body.mediaId === 'string' ? { mediaId: body.mediaId } : {}),
      ...(typeof body.caption === 'string' ? { caption: body.caption } : {}),
      ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
    };
    // Validate the payload BEFORE raising an approval — an unsendable
    // payload (e.g. kind "html") must never consume a human decision.
    try {
      buildWhatsAppMediaPayload(body.to, input);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid media payload'));
      return;
    }
    try {
      // Same deny-by-default gate as text sends: a governance approval for
      // message.send must be 'approved' before the provider is called.
      const { approvalId } = requestSendApproval(deps.governance, {
        providerId: 'whatsapp',
        to: body.to,
        text: `[media:${input.kind}] ${input.caption ?? input.filename ?? input.link ?? input.mediaId ?? ''}`.trim(),
      });
      const waitMs = Math.min(Math.max(Number(body.waitMs) || 60_000, 0), 120_000);
      const decision = await deps.governance.awaitDecision(approvalId, waitMs);
      if (decision !== 'approved') {
        res.status(403).json({ error: 'Media send was not approved', approvalId, status: 'denied' });
        return;
      }
      const result = await deliverApprovedSend(deps.governance, approvalId, () => transport().sendMedia(body.to as string, input));
      const kindMap: Record<string, SideChatMessageKind> = {
        image: 'image', video: 'video', audio: 'audio', voice: 'voice', document: 'document', sticker: 'sticker',
      };
      const attKind = (kindMap[input.kind] ?? 'document') as import('./whatsapp-cloud.js').WhatsAppAttachmentKind;
      sideChats.mirrorMessage({
        providerId: 'whatsapp',
        externalChatId: body.to,
        providerMessageId: result.id,
        direction: 'out',
        kind: kindMap[input.kind] ?? 'text',
        text: input.caption,
        // Attachment record only when a real provider media id exists —
        // a by-link send has no media id to record (the URL is in the
        // approval record's args).
        attachment: input.mediaId
          ? { kind: attKind, mediaId: input.mediaId, ...(input.filename ? { filename: input.filename } : {}) }
          : undefined,
      });
      res.json({ ok: true, approvalId, id: result.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to send media', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- WhatsApp webhook -----------------------------------------------------
  router.get('/whatsapp/webhook', (req, res) => {
    const expected = deps.verifyToken ?? process.env.WHATSAPP_VERIFY_TOKEN ?? deps.resolveStoredWebhookSecret?.() ?? '';
    const challenge = verifyWhatsAppWebhookHandshake(req.query as Record<string, string | undefined>, expected);
    if (challenge === null) {
      res.status(403).json(errorBody('Webhook verification failed'));
      return;
    }
    res.status(200).send(challenge);
  });

  router.post('/whatsapp/webhook', async (req, res) => {
    const appSecret = deps.appSecret ?? process.env.WHATSAPP_APP_SECRET;
    if (appSecret) {
      const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      const signature = req.get('x-hub-signature-256') ?? '';
      if (!verifyWhatsAppWebhookSignature(appSecret, rawBody, signature)) {
        res.status(401).json(errorBody('Invalid WhatsApp signature'));
        return;
      }
    }
    const events = parseWhatsAppWebhook(req.body);
    const summary = { mirrored: 0, reactions: 0, decisions: 0, cards: 0, ignored: 0 };
    for (const event of events) {
      await handleWhatsAppEvent(event);
    }
    res.json({ ok: true, events: events.length, ...summary });

    async function handleWhatsAppEvent(event: WhatsAppInboundEvent): Promise<void> {
      if (event.kind === 'status') {
        summary.ignored += 1;
        return;
      }
      const chat = sideChats.ensureChat('whatsapp', event.chatId);
      if (event.kind === 'reaction') {
        const before = sideChats.getMessageByProviderId(chat.id, event.targetProviderMessageId);
        const updated = sideChats.applyReaction(chat.id, event.targetProviderMessageId, event.emoji, event.from);
        if (updated) {
          summary.reactions += 1;
          // Bridge to the in-app reaction store (set semantics on top of
          // its toggle API: only toggle when the state actually differs).
          if (deps.reactionStore) {
            const had = before?.reactions.some((r) => r.actor === event.from && r.emoji === event.emoji);
            if (event.emoji && !had) deps.reactionStore.toggle(chat.id, updated.id, event.emoji, event.from);
          }
        } else {
          summary.ignored += 1;
        }
        return;
      }
      if (event.kind === 'interactive-reply') {
        // CH-10: ONLY this structured path may decide an approval.
        const outcome = approvals.handleInteractiveReply({
          providerId: 'whatsapp',
          chatId: event.chatId,
          replyId: event.replyId,
          actor: event.from,
        });
        if (outcome.handled) {
          summary.decisions += 1;
          sideChats.mirrorMessage({
            providerId: 'whatsapp',
            externalChatId: event.chatId,
            providerMessageId: event.providerMessageId,
            direction: 'in',
            kind: 'approval',
            text: `Decision via button: ${outcome.decision} (approval ${outcome.approvalId})`,
          });
          return;
        }
        const card = await actionCards.handleInteractiveReply({
          providerId: 'whatsapp',
          chatId: event.chatId,
          replyId: event.replyId,
          actor: event.from,
        });
        if (card.handled) {
          summary.cards += 1;
          return;
        }
        summary.ignored += 1;
        audit('channel.interactive_reply_unmatched', {
          actor: event.from,
          detail: { reason: outcome.reason, replyId: event.replyId },
        });
        return;
      }
      // Plain message: mirror exactly once (CH-1), keep quote + typing (CH-6).
      const kind: SideChatMessageKind = event.attachment
        ? event.attachment.kind
        : event.location
          ? 'location'
          : 'text';
      const { inserted } = sideChats.mirrorMessage({
        providerId: 'whatsapp',
        externalChatId: event.chatId,
        providerMessageId: event.providerMessageId,
        direction: 'in',
        kind,
        text: event.text,
        attachment: event.attachment,
        location: event.location,
        quotedProviderMessageId: event.quoted?.providerMessageId,
        contactName: event.contactName,
        atMs: event.timestampMs,
      });
      if (inserted) {
        summary.mirrored += 1;
        audit('message.inbound', {
          actor: 'provider',
          detail: { provider: 'whatsapp', from: event.from, chatId: event.chatId, sideChatId: chat.id, kind },
        });
        if (deps.onMessage && event.text) {
          // Fire-and-forget agent turn; receipt must stay fast for Meta.
          void Promise.resolve(
            deps.onMessage({ providerId: 'whatsapp', chatId: event.chatId, from: event.from, text: event.text, sideChatId: chat.id }),
          ).catch(() => undefined);
        }
      }
    }
  });

  return { router, sideChats, approvals, actionCards, connections };
}
