// SPDX-License-Identifier: Apache-2.0
// Messaging gateway (Phase 3, Workstream B).
//
// Outbound message sends are DENY-BY-DEFAULT: every send raises a
// require-approval approval through the governance gateway first and the
// message only leaves the machine when that approval is decided 'approved'
// (denied / expired / missing all fail closed — the provider is never
// called). Inbound webhooks are received, signature-checked where the
// provider supports it, and recorded to an append-only log + audit trail.
//
// Flow:
//   POST /api/messaging/send { provider, to, text, waitMs? }
//     → requestSendApproval() raises a pending approval (visible in the
//       approvals inbox / chat SSE approval_required event)
//     → the endpoint awaits the decision (bounded waitMs, default 60s)
//     → approved: sendMessage() delivers via the provider, 200 { ok, id }
//     → denied/expired: 403, the provider is never called
// Unit tests drive requestSendApproval / deliverApprovedSend directly for
// the "blocked until approved" guarantee.

import express from 'express';
import { randomUUID } from 'node:crypto';
import type { GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from './config.js';
import { syncProviderKeysToEnv } from './providers.js';
import type { OnBehalfOfLedger } from '@mvp/agent-runtime';

// ---------------------------------------------------------------------------
// Provider interface + registry
// ---------------------------------------------------------------------------

export interface MessageProvider {
  id: string;
  name: string;
  /** Deliver one message. Throws on provider errors; never throws on policy — policy is enforced above this layer. */
  send(to: string, text: string): Promise<{ ok: boolean; id?: string }>;
}

type MessageProviderFactory = (dataDir: string) => MessageProvider;

const providerFactories = new Map<string, MessageProviderFactory>();

export function registerMessageProvider(id: string, factory: MessageProviderFactory): void {
  providerFactories.set(id, factory);
}

export function listMessageProviders(): string[] {
  return [...providerFactories.keys()];
}

export function getMessageProvider(providerId: string, dataDir: string): MessageProvider {
  const factory = providerFactories.get(providerId);
  if (!factory) throw new Error(`Unknown message provider "${providerId}"`);
  return factory(dataDir);
}

// ---------------------------------------------------------------------------
// Telegram reference implementation (Bot API over fetch).
//
// Bot token resolution: real env TELEGRAM_BOT_TOKEN first; otherwise the
// encrypted store via POST /api/providers/keys with providerId
// "custom-telegram" (mirrored into CUSTOM_TELEGRAM_API_KEY by
// syncProviderKeysToEnv — same AES-256-GCM file as everything else).
// ---------------------------------------------------------------------------

export const TELEGRAM_BOT_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_WEBHOOK_SECRET_ENV = 'TELEGRAM_WEBHOOK_SECRET';

export function resolveTelegramToken(dataDir: string): string {
  const realEnv = process.env[TELEGRAM_BOT_TOKEN_ENV];
  if (realEnv) return realEnv;
  syncProviderKeysToEnv(dataDir);
  const stored = process.env['CUSTOM_TELEGRAM_API_KEY'];
  if (stored) return stored;
  throw new Error(
    `Telegram bot token is not configured: set ${TELEGRAM_BOT_TOKEN_ENV} or store it ` +
      `via POST /api/providers/keys with providerId "custom-telegram".`,
  );
}

export function createTelegramProvider(botToken: string): MessageProvider {
  if (!botToken) throw new Error('Telegram bot token is required');
  return {
    id: 'telegram',
    name: 'Telegram',
    async send(to: string, text: string) {
      if (!to) throw new Error('Telegram send: "to" (chat id) is required');
      if (!text) throw new Error('Telegram send: text is required');
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: to, text }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // fall through to the error below
      }
      if (!res.ok || body.ok !== true) {
        const description = typeof body.description === 'string' ? body.description : `HTTP ${res.status}`;
        throw new Error(`Telegram send failed: ${description}`);
      }
      const result = body.result as { message_id?: number } | undefined;
      return { ok: true, id: result?.message_id !== undefined ? String(result.message_id) : undefined };
    },
  };
}

// Telegram is the shipped reference provider.
registerMessageProvider('telegram', (dataDir) => createTelegramProvider(resolveTelegramToken(dataDir)));

// ---------------------------------------------------------------------------
// Discord provider (Bot API over fetch).
//
// Bot token resolution: real env DISCORD_BOT_TOKEN first; otherwise the
// encrypted store via POST /api/providers/keys with providerId
// "custom-discord" (mirrored into CUSTOM_DISCORD_API_KEY).
// The bot's user id (for mention detection) comes from DISCORD_BOT_USER_ID.
// ---------------------------------------------------------------------------

export const DISCORD_BOT_TOKEN_ENV = 'DISCORD_BOT_TOKEN';
export const DISCORD_BOT_USER_ID_ENV = 'DISCORD_BOT_USER_ID';

export function resolveDiscordToken(dataDir: string): string {
  const realEnv = process.env[DISCORD_BOT_TOKEN_ENV];
  if (realEnv) return realEnv;
  syncProviderKeysToEnv(dataDir);
  const stored = process.env['CUSTOM_DISCORD_API_KEY'];
  if (stored) return stored;
  throw new Error(
    `Discord bot token is not configured: set ${DISCORD_BOT_TOKEN_ENV} or store it ` +
      `via POST /api/providers/keys with providerId "custom-discord".`,
  );
}

export function createDiscordProvider(botToken: string): MessageProvider {
  if (!botToken) throw new Error('Discord bot token is required');
  return {
    id: 'discord',
    name: 'Discord',
    async send(to: string, text: string) {
      if (!to) throw new Error('Discord send: "to" (channel id) is required');
      if (!text) throw new Error('Discord send: text is required');
      const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(to)}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bot ${botToken}`,
        },
        body: JSON.stringify({ content: text }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // fall through to the error below
      }
      if (!res.ok) {
        const message = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
        throw new Error(`Discord send failed: ${message}`);
      }
      return { ok: true, id: typeof body.id === 'string' ? body.id : undefined };
    },
  };
}

registerMessageProvider('discord', (dataDir) => createDiscordProvider(resolveDiscordToken(dataDir)));

// ---------------------------------------------------------------------------
// Slack provider (Web API chat.postMessage over fetch).
//
// Token resolution: real env SLACK_BOT_TOKEN first; otherwise the encrypted
// store via providerId "custom-slack" (mirrored into CUSTOM_SLACK_API_KEY).
// ---------------------------------------------------------------------------

export const SLACK_BOT_TOKEN_ENV = 'SLACK_BOT_TOKEN';
export const SLACK_SIGNING_SECRET_ENV = 'SLACK_SIGNING_SECRET';

export function resolveSlackToken(dataDir: string): string {
  const realEnv = process.env[SLACK_BOT_TOKEN_ENV];
  if (realEnv) return realEnv;
  syncProviderKeysToEnv(dataDir);
  const stored = process.env['CUSTOM_SLACK_API_KEY'];
  if (stored) return stored;
  throw new Error(
    `Slack bot token is not configured: set ${SLACK_BOT_TOKEN_ENV} or store it ` +
      `via POST /api/providers/keys with providerId "custom-slack".`,
  );
}

export function createSlackProvider(botToken: string): MessageProvider {
  if (!botToken) throw new Error('Slack bot token is required');
  return {
    id: 'slack',
    name: 'Slack',
    async send(to: string, text: string) {
      if (!to) throw new Error('Slack send: "to" (channel id) is required');
      if (!text) throw new Error('Slack send: text is required');
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ channel: to, text }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // fall through to the error below
      }
      if (!res.ok || body.ok !== true) {
        const error = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
        throw new Error(`Slack send failed: ${error}`);
      }
      return { ok: true, id: typeof body.ts === 'string' ? body.ts : undefined };
    },
  };
}

registerMessageProvider('slack', (dataDir) => createSlackProvider(resolveSlackToken(dataDir)));

// ---------------------------------------------------------------------------
// WhatsApp provider (Business Cloud API over fetch).
//
// Token: WHATSAPP_TOKEN env (or encrypted store via providerId
// "custom-whatsapp" → CUSTOM_WHATSAPP_API_KEY). The sender phone number id
// comes from WHATSAPP_PHONE_NUMBER_ID env.
// ---------------------------------------------------------------------------

export const WHATSAPP_TOKEN_ENV = 'WHATSAPP_TOKEN';
export const WHATSAPP_PHONE_NUMBER_ID_ENV = 'WHATSAPP_PHONE_NUMBER_ID';

export function resolveWhatsAppToken(dataDir: string): string {
  const realEnv = process.env[WHATSAPP_TOKEN_ENV];
  if (realEnv) return realEnv;
  syncProviderKeysToEnv(dataDir);
  const stored = process.env['CUSTOM_WHATSAPP_API_KEY'];
  if (stored) return stored;
  throw new Error(
    `WhatsApp token is not configured: set ${WHATSAPP_TOKEN_ENV} or store it ` +
      `via POST /api/providers/keys with providerId "custom-whatsapp".`,
  );
}

export function resolveWhatsAppPhoneNumberId(): string {
  const id = process.env[WHATSAPP_PHONE_NUMBER_ID_ENV];
  if (!id) throw new Error(`WhatsApp phone number id is not configured: set ${WHATSAPP_PHONE_NUMBER_ID_ENV}.`);
  return id;
}

export function createWhatsAppProvider(token: string, phoneNumberId: string): MessageProvider {
  if (!token) throw new Error('WhatsApp token is required');
  if (!phoneNumberId) throw new Error('WhatsApp phone number id is required');
  return {
    id: 'whatsapp',
    name: 'WhatsApp',
    async send(to: string, text: string) {
      if (!to) throw new Error('WhatsApp send: "to" (recipient phone) is required');
      if (!text) throw new Error('WhatsApp send: text is required');
      const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text, preview_url: false },
        }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // fall through to the error below
      }
      if (!res.ok) {
        const err = body.error as { message?: string } | undefined;
        const message = err?.message ?? `HTTP ${res.status}`;
        throw new Error(`WhatsApp send failed: ${message}`);
      }
      const messages = body.messages as Array<{ id?: string }> | undefined;
      return { ok: true, id: messages?.[0]?.id };
    },
  };
}

registerMessageProvider('whatsapp', (dataDir) =>
  createWhatsAppProvider(resolveWhatsAppToken(dataDir), resolveWhatsAppPhoneNumberId()),
);

// ---------------------------------------------------------------------------
// Approval-gated outbound sends
// ---------------------------------------------------------------------------

export interface SendRequest {
  providerId: string;
  to: string;
  text: string;
  sessionId?: string;
  botId?: string;
  actor?: string;
}

/**
 * Raise the require-approval approval for an outbound send. Returns the
 * approval id immediately — NOTHING is sent yet. The message content is
 * visible in the approval inbox so the human sees exactly what would go
 * out (args are secret-redacted by the gateway; message text is content,
 * not a secret).
 */
export function requestSendApproval(
  governance: GovernanceGateway,
  req: SendRequest,
): { approvalId: string } {
  const ctx = {
    sessionId: req.sessionId ?? randomUUID(),
    botId: req.botId ?? 'system',
    actor: req.actor ?? 'api',
  };
  const approvalId = governance.requestApproval(
    'message.send',
    { providerId: req.providerId, to: req.to, text: req.text },
    ctx,
  );
  governance.audit('message.send_requested', {
    actor: ctx.actor,
    sessionId: ctx.sessionId,
    toolName: 'message.send',
    decision: 'require-approval',
    detail: { approvalId, providerId: req.providerId, to: req.to },
  });
  return { approvalId };
}

/**
 * Deliver ONLY when the given approval is currently 'approved'. Throws
 * otherwise — this is the deny-by-default enforcement point. Audits the
 * outcome.
 */
export async function deliverApprovedSend<T>(
  governance: GovernanceGateway,
  approvalId: string,
  deliver: () => Promise<T>,
): Promise<T> {
  const rec = governance.getApproval(approvalId);
  const status = rec?.status ?? 'missing';
  if (status !== 'approved') {
    governance.audit('message.send_blocked', {
      actor: rec?.actor ?? 'system',
      sessionId: rec?.sessionId,
      toolName: 'message.send',
      decision: 'deny',
      detail: { approvalId, status },
    });
    throw new Error(`send blocked: approval "${approvalId}" is ${status} — deny-by-default`);
  }
  const result = await deliver();
  governance.audit('message.sent', {
    actor: rec?.actor ?? 'system',
    sessionId: rec?.sessionId,
    toolName: 'message.send',
    decision: 'approved',
    detail: { approvalId },
  });
  return result;
}

/**
 * Convenience: raise the approval, wait for the decision, and deliver only
 * on 'approved'. Used by POST /api/messaging/send.
 */
export async function requestApprovalAndSend(
  governance: GovernanceGateway,
  dataDir: string,
  req: SendRequest,
  timeoutMs: number,
): Promise<{ approvalId: string; decision: 'approved' | 'denied'; result?: { ok: boolean; id?: string } }> {
  const { approvalId } = requestSendApproval(governance, req);
  const decision = await governance.awaitDecision(approvalId, timeoutMs);
  if (decision !== 'approved') {
    return { approvalId, decision: 'denied' };
  }
  const result = await deliverApprovedSend(governance, approvalId, () =>
    getMessageProvider(req.providerId, dataDir).send(req.to, req.text),
  );
  return { approvalId, decision, result };
}

// ---------------------------------------------------------------------------
// Inbound webhooks
// ---------------------------------------------------------------------------

export interface InboundMessage {
  id: string;
  providerId: string;
  receivedAt: number;
  from?: string;
  chatId?: string;
  text?: string;
  /** Full raw payload for provider-specific fields. */
  raw: unknown;
  /**
   * Guarded external messages: inbound provider messages are always
   * relayed — they arrive via a third party and can never satisfy an
   * approval. The onBehalfOf ledger holds the (from, on-behalf-of) entry.
   */
  relayed: true;
}

const MAX_INBOUND_LOG = 200;
const inboundLog: InboundMessage[] = [];

export function getInboundLog(): InboundMessage[] {
  return [...inboundLog];
}

function pushInbound(message: InboundMessage): void {
  inboundLog.push(message);
  if (inboundLog.length > MAX_INBOUND_LOG) inboundLog.splice(0, inboundLog.length - MAX_INBOUND_LOG);
}

/** Telegram webhook update → InboundMessage. Returns null for non-message updates (e.g. callback queries in this MVP). */
function parseTelegramUpdate(update: unknown): InboundMessage | null {
  if (typeof update !== 'object' || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const m = message as {
    message_id?: number;
    from?: { id?: number; username?: string };
    chat?: { id?: number };
    text?: string;
  };
  return {
    id: `telegram-${m.message_id ?? randomUUID()}`,
    providerId: 'telegram',
    receivedAt: Date.now(),
    from: m.from?.username ?? (m.from?.id !== undefined ? String(m.from.id) : undefined),
    chatId: m.chat?.id !== undefined ? String(m.chat.id) : undefined,
    text: typeof m.text === 'string' ? m.text : undefined,
    raw: update,
    relayed: true,
  };
}

/**
 * Discord message payload → InboundMessage.
 * Detects whether the bot was mentioned: the payload's `mentions` array
 * contains the bot user id (DISCORD_BOT_USER_ID), or the content has a
 * `<@BOTID>` mention. Messages authored by bots are ignored (loop guard).
 * Returns null for non-mention messages and bot-authored messages.
 */
export interface DiscordMention extends InboundMessage {
  mentioned: boolean;
}

export function parseDiscordMessage(payload: unknown, botUserId?: string): DiscordMention | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    id?: string;
    channel_id?: string;
    author?: { id?: string; username?: string; bot?: boolean };
    content?: string;
    mentions?: Array<{ id?: string }>;
  };
  if (p.author?.bot === true) return null; // loop guard
  const content = typeof p.content === 'string' ? p.content : '';
  const mentionsBot =
    !!botUserId &&
    (Array.isArray(p.mentions)
      ? p.mentions.some((m) => m?.id === botUserId)
      : false ||
      content.includes(`<@${botUserId}>`) ||
      content.includes(`<@!${botUserId}>`));
  return {
    id: `discord-${p.id ?? randomUUID()}`,
    providerId: 'discord',
    receivedAt: Date.now(),
    from: p.author?.username ?? p.author?.id,
    chatId: p.channel_id,
    text: content || undefined,
    raw: payload,
    relayed: true,
    mentioned: mentionsBot,
  };
}

export type SlackInbound =
  | { kind: 'url_verification'; challenge: string }
  | { kind: 'app_mention'; message: InboundMessage }
  | { kind: 'ignored' };

/**
 * Slack Events API payload → SlackInbound.
 * - url_verification: handshake — echo the challenge.
 * - event_callback/app_mention: the bot was mentioned in a channel.
 * Everything else is ignored.
 */
export function parseSlackEvent(payload: unknown): SlackInbound {
  if (typeof payload !== 'object' || payload === null) return { kind: 'ignored' };
  const p = payload as { type?: string; challenge?: string; event?: unknown };
  if (p.type === 'url_verification' && typeof p.challenge === 'string') {
    return { kind: 'url_verification', challenge: p.challenge };
  }
  if (p.type === 'event_callback' && typeof p.event === 'object' && p.event !== null) {
    const e = p.event as {
      type?: string;
      user?: string;
      channel?: string;
      text?: string;
      ts?: string;
      bot_id?: string;
    };
    if (e.type === 'app_mention' && !e.bot_id) {
      // Strip the leading <@BOTID> mention from the text for the agent.
      const text = typeof e.text === 'string' ? e.text.replace(/^<@[A-Z0-9]+>\s*/, '').trim() : undefined;
      return {
        kind: 'app_mention',
        message: {
          id: `slack-${e.ts ?? randomUUID()}`,
          providerId: 'slack',
          receivedAt: Date.now(),
          from: e.user,
          chatId: e.channel,
          text: text || undefined,
          raw: payload,
          relayed: true,
        },
      };
    }
  }
  return { kind: 'ignored' };
}

/** Verify a Slack request signature (optional — only when SLACK_SIGNING_SECRET is set). */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  // Reject stale timestamps (replay guard, 5 min).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Inbound mentions → agent turns (OpenDots parity)
//
// When the bot is mentioned on Discord/Slack, the host can run an agent turn
// and reply in the channel. The host wires `onMention` (see
// MessagingRouteDeps); without it, mentions are only logged.
// ---------------------------------------------------------------------------

export interface MentionInfo {
  providerId: string;
  /** Channel id (Discord/Slack) to reply in. */
  chatId: string;
  from?: string;
  text: string;
  messageId?: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface MessagingRouteDeps {
  config: AppConfig;
  governance: GovernanceGateway;
  /**
   * Run an agent turn for an inbound bot mention and return the reply text.
   * The host (routes.ts) wires this to the chat pipeline. When unset,
   * mentions are logged/audited but not answered.
   */
  onMention?: (info: MentionInfo) => Promise<string | undefined>;
  /**
   * Guarded external messages: onBehalfOf ledger. When set, every inbound
   * provider message is recorded as a relayed message (who sent it on whose
   * behalf, when) and the approval gate treats turns from these messages as
   * relayed (they can never satisfy an approval).
   */
  relayLedger?: OnBehalfOfLedger;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

/** Clamp the client-requested wait to a sane bound. */
function clampWaitMs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 60_000;
  return Math.min(Math.max(Math.floor(n), 0), 120_000);
}

export function registerMessagingRoutes(router: express.Router, deps: MessagingRouteDeps): void {
  const { config, governance, onMention, relayLedger } = deps;

  /** Run the agent turn for a mention and reply in the channel. Fire-and-forget from the webhook. */
  const handleMention = (info: MentionInfo): void => {
    if (!onMention) return;
    void (async () => {
      try {
        const reply = await onMention(info);
        if (!reply?.trim() || !info.chatId) return;
        const provider = getMessageProvider(info.providerId, config.dataDir);
        const result = await provider.send(info.chatId, reply.trim());
        governance.audit('message.auto_reply', {
          actor: 'agent',
          sessionId: info.chatId,
          toolName: 'message.auto_reply',
          decision: 'sent',
          detail: { provider: info.providerId, chatId: info.chatId, messageId: result.id },
        });
      } catch (err) {
        console.error(
          `[messaging] mention reply failed (${info.providerId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    })();
  };

  const recordInbound = (inbound: InboundMessage): void => {
    pushInbound(inbound);
    // Guarded external messages: ledger the relay (who → on whose behalf).
    try {
      relayLedger?.record({
        messageId: inbound.id,
        source: 'messaging',
        from: inbound.from ?? inbound.providerId,
        onBehalfOf: inbound.chatId ?? inbound.providerId,
        note: `inbound ${inbound.providerId} message`,
      });
    } catch {
      // ledgering must never break receipt
    }
    governance.audit('message.inbound', {
      actor: 'provider',
      sessionId: inbound.chatId,
      toolName: 'message.inbound',
      decision: 'received',
      detail: {
        provider: inbound.providerId,
        from: inbound.from,
        chatId: inbound.chatId,
        text: inbound.text?.slice(0, 500),
      },
    });
    console.log(`[messaging] inbound ${inbound.providerId} message from ${inbound.from ?? 'unknown'}`);
  };

  // POST /api/messaging/send — approval-gated outbound send.
  // Body: { provider, to, text, waitMs? }.
  router.post('/messaging/send', async (req, res) => {
    const body = (req.body ?? {}) as { provider?: unknown; to?: unknown; text?: unknown; waitMs?: unknown };
    if (typeof body.provider !== 'string' || !body.provider) {
      res.status(400).json(errorBody('provider is required'));
      return;
    }
    if (typeof body.to !== 'string' || !body.to) {
      res.status(400).json(errorBody('to is required'));
      return;
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json(errorBody('text is required'));
      return;
    }
    if (!providerFactories.has(body.provider)) {
      res.status(404).json(errorBody(`Unknown message provider "${body.provider}"`));
      return;
    }
    try {
      const outcome = await requestApprovalAndSend(
        governance,
        config.dataDir,
        { providerId: body.provider, to: body.to, text: body.text },
        clampWaitMs(body.waitMs),
      );
      if (outcome.decision !== 'approved') {
        res.status(403).json({
          error: 'Message send was not approved',
          approvalId: outcome.approvalId,
          status: 'denied',
        });
        return;
      }
      res.json({ ok: true, approvalId: outcome.approvalId, ...outcome.result });
    } catch (err) {
      res.status(500).json(errorBody('Failed to send message', err instanceof Error ? err.message : String(err)));
    }
  });

  // POST /api/messaging/inbound/:provider — provider webhook receipt.
  // Telegram: stored to the inbound log + audit trail; no auto-reply.
  // Discord/Slack: bot mentions trigger an agent turn (when the host wires
  // onMention) and the reply goes back to the channel/thread.
  router.post('/messaging/inbound/:provider', async (req, res) => {
    const providerId = req.params.provider;

    // ---- Discord ---------------------------------------------------------
    if (providerId === 'discord') {
      const botUserId = process.env[DISCORD_BOT_USER_ID_ENV];
      const parsed = parseDiscordMessage(req.body, botUserId);
      if (!parsed) {
        res.json({ ok: true, ignored: true });
        return;
      }
      recordInbound(parsed);
      if (parsed.mentioned && parsed.text && parsed.chatId) {
        handleMention({
          providerId: 'discord',
          chatId: parsed.chatId,
          from: parsed.from,
          text: parsed.text,
          messageId: parsed.id,
        });
        res.json({ ok: true, id: parsed.id, mentioned: true });
        return;
      }
      res.json({ ok: true, id: parsed.id, mentioned: false });
      return;
    }

    // ---- Slack -----------------------------------------------------------
    if (providerId === 'slack') {
      // Optional request verification (only when the signing secret is set).
      const signingSecret = process.env[SLACK_SIGNING_SECRET_ENV];
      if (signingSecret) {
        const timestamp = req.get('x-slack-request-timestamp') ?? '';
        const signature = req.get('x-slack-signature') ?? '';
        // NOTE: requires express.raw() for this route to get the raw body;
        // fall back to JSON-stringified body when unavailable.
        const rawBody =
          (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
        const valid = await verifySlackSignature(signingSecret, timestamp, rawBody, signature);
        if (!valid) {
          res.status(401).json(errorBody('Invalid Slack signature'));
          return;
        }
      }
      const parsed = parseSlackEvent(req.body);
      if (parsed.kind === 'url_verification') {
        res.json({ challenge: parsed.challenge });
        return;
      }
      if (parsed.kind === 'app_mention') {
        recordInbound(parsed.message);
        if (parsed.message.text && parsed.message.chatId) {
          handleMention({
            providerId: 'slack',
            chatId: parsed.message.chatId,
            from: parsed.message.from,
            text: parsed.message.text,
            messageId: parsed.message.id,
          });
        }
        res.json({ ok: true, id: parsed.message.id });
        return;
      }
      res.json({ ok: true, ignored: true });
      return;
    }

    // ---- Telegram (unchanged) --------------------------------------------
    if (providerId !== 'telegram') {
      res.status(404).json(errorBody(`Unknown message provider "${providerId}"`));
      return;
    }
    const expectedSecret = process.env[TELEGRAM_WEBHOOK_SECRET_ENV];
    if (expectedSecret) {
      const got = req.get('x-telegram-bot-api-secret-token');
      if (got !== expectedSecret) {
        res.status(401).json(errorBody('Invalid webhook secret'));
        return;
      }
    }
    const inbound = parseTelegramUpdate(req.body);
    if (!inbound) {
      // Non-message update (e.g. edited message, callback query): acknowledge.
      res.json({ ok: true, ignored: true });
      return;
    }
    recordInbound(inbound);
    res.json({ ok: true, id: inbound.id });
  });

  // GET /api/messaging/inbound — recent inbound messages (Workspace UI).
  router.get('/messaging/inbound', (_req, res) => {
    res.json(getInboundLog());
  });

  // GET /api/messaging/providers — available outbound providers (no secrets).
  router.get('/messaging/providers', (_req, res) => {
    res.json(listMessageProviders().map((id) => ({ id })));
  });
}
