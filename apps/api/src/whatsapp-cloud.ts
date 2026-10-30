// SPDX-License-Identifier: Apache-2.0
// WhatsApp Cloud API — full message surface (Muse parity §4.6: CH-6/CH-7/CH-8).
//
// The shipped provider in messaging.ts sends plain text only. This module
// completes the WhatsApp surface without touching that file:
//
//   Inbound (webhook payloads → typed events)
//   - text, image, document, video, audio, voice (audio + voice_notes),
//     sticker, location, contacts — each with typed attachment metadata
//   - quote-reply semantics: `context.id` (the provider id of the quoted
//     message) + `context.from`, and `referral` is never treated as a quote
//   - emoji reactions (`reaction.message_id` + `reaction.emoji`; an empty
//     emoji removes the reaction)                              → CH-9 inbound
//   - structured interactive replies: reply-button taps and list-row picks
//     carry the exact `id` the sender embedded — the ONLY channel input
//     that may ever resolve an approval (see channel-approvals.ts) → CH-10
//
//   Outbound (payload builders + an injectable-fetch transport)
//   - text, image, video, audio (incl. voice-note flag), document, sticker
//     by link or by previously-uploaded media id                  → CH-7
//   - interactive reply-button cards and CTA-URL cards            → CH-8
//   - reaction sends                                              → CH-9 outbound
//   HTML is NOT a native WhatsApp message type: buildWhatsAppMedia throws
//   for it instead of silently degrading — send HTML as a document
//   attachment (kind 'document') or a link in a text/CTA body.
//
//   Webhook trust: GET verification handshake (hub.verify_token) and POST
//   signature check (X-Hub-Signature-256 = HMAC-SHA256(rawBody, appSecret)).
//
// Zero network in tests: the transport takes an injectable fetch.

import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Inbound typing
// ---------------------------------------------------------------------------

export type WhatsAppAttachmentKind =
  | 'image'
  | 'document'
  | 'video'
  | 'audio'
  | 'voice'
  | 'sticker';

export interface WhatsAppAttachment {
  kind: WhatsAppAttachmentKind;
  /** Provider media id — fetch the bytes via the Graph media endpoint. */
  mediaId: string;
  mimeType?: string;
  filename?: string;
  caption?: string;
  sha256?: string;
}

export interface WhatsAppQuotedRef {
  /** Provider message id (wamid) of the quoted message. */
  providerMessageId: string;
  from?: string;
}

export type WhatsAppInboundEvent =
  | {
      kind: 'message';
      providerMessageId: string;
      from: string;
      chatId: string;
      timestampMs: number;
      text?: string;
      attachment?: WhatsAppAttachment;
      location?: { latitude: number; longitude: number; name?: string; address?: string };
      quoted?: WhatsAppQuotedRef;
      contactName?: string;
    }
  | {
      kind: 'reaction';
      providerMessageId: string;
      from: string;
      chatId: string;
      timestampMs: number;
      /** Provider id of the message being reacted to. */
      targetProviderMessageId: string;
      /** Empty string = reaction removed. */
      emoji: string;
    }
  | {
      kind: 'interactive-reply';
      providerMessageId: string;
      from: string;
      chatId: string;
      timestampMs: number;
      /** 'button_reply' | 'list_reply' — both are structured, id-carrying taps. */
      replyType: 'button_reply' | 'list_reply';
      /** The exact id embedded when the card was sent. Never free text. */
      replyId: string;
      /** Display title of the tapped control (informational only). */
      replyTitle?: string;
    }
  | {
      kind: 'status';
      providerMessageId: string;
      status: string;
      timestampMs: number;
    };

interface WaRawMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: WaRawMedia;
  document?: WaRawMedia;
  video?: WaRawMedia;
  audio?: WaRawMedia & { voice?: boolean };
  sticker?: WaRawMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?: { message_id?: string; emoji?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  context?: { id?: string; from?: string };
  errors?: unknown;
}

interface WaRawMedia {
  id?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
  sha256?: string;
}

function mediaAttachment(kind: WhatsAppAttachmentKind, raw: WaRawMedia | undefined): WhatsAppAttachment | undefined {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return undefined;
  return {
    kind,
    mediaId: raw.id,
    ...(raw.mime_type ? { mimeType: raw.mime_type } : {}),
    ...(raw.filename ? { filename: raw.filename } : {}),
    ...(raw.caption ? { caption: raw.caption } : {}),
    ...(raw.sha256 ? { sha256: raw.sha256 } : {}),
  };
}

function parseOneMessage(m: WaRawMessage, profileName?: string): WhatsAppInboundEvent | null {
  if (typeof m.from !== 'string' || !m.from || typeof m.id !== 'string' || !m.id) return null;
  const base = {
    providerMessageId: m.id,
    from: m.from,
    chatId: m.from, // WhatsApp 1:1: the chat IS the counterparty number.
    timestampMs: (Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000,
  };
  const quoted: WhatsAppQuotedRef | undefined =
    m.context && typeof m.context.id === 'string' && m.context.id
      ? { providerMessageId: m.context.id, ...(m.context.from ? { from: m.context.from } : {}) }
      : undefined;

  switch (m.type) {
    case 'text':
      return { kind: 'message', ...base, text: m.text?.body ?? '', ...(quoted ? { quoted } : {}), ...(profileName ? { contactName: profileName } : {}) };
    case 'image':
    case 'document':
    case 'video':
    case 'sticker': {
      const att = mediaAttachment(m.type, m[m.type]);
      if (!att) return null;
      return { kind: 'message', ...base, attachment: att, ...(att.caption ? { text: att.caption } : {}), ...(quoted ? { quoted } : {}) };
    }
    case 'audio': {
      const att = mediaAttachment(m.audio?.voice === true ? 'voice' : 'audio', m.audio);
      if (!att) return null;
      return { kind: 'message', ...base, attachment: att, ...(quoted ? { quoted } : {}) };
    }
    case 'location':
      if (typeof m.location?.latitude !== 'number' || typeof m.location?.longitude !== 'number') return null;
      return {
        kind: 'message',
        ...base,
        location: {
          latitude: m.location.latitude,
          longitude: m.location.longitude,
          ...(m.location.name ? { name: m.location.name } : {}),
          ...(m.location.address ? { address: m.location.address } : {}),
        },
        ...(quoted ? { quoted } : {}),
      };
    case 'reaction':
      if (typeof m.reaction?.message_id !== 'string' || !m.reaction.message_id) return null;
      return {
        kind: 'reaction',
        ...base,
        targetProviderMessageId: m.reaction.message_id,
        emoji: typeof m.reaction.emoji === 'string' ? m.reaction.emoji : '',
      };
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      const replyType = m.interactive?.button_reply ? 'button_reply' : 'list_reply';
      if (!reply || typeof reply.id !== 'string' || !reply.id) return null;
      return {
        kind: 'interactive-reply',
        ...base,
        replyType,
        replyId: reply.id,
        ...(reply.title ? { replyTitle: reply.title } : {}),
      };
    }
    case 'button': {
      // Legacy template quick-reply button: payload text is NOT a structured
      // id, so surface it as plain text — it can never resolve an approval.
      const btn = (m as unknown as { button?: { text?: string; payload?: string } }).button;
      return { kind: 'message', ...base, text: btn?.text ?? '', ...(quoted ? { quoted } : {}) };
    }
    default:
      // contacts / order / system / unsupported → typed as a bare message so
      // the mirror keeps the transcript complete without inventing fields.
      return { kind: 'message', ...base, text: undefined, ...(quoted ? { quoted } : {}) };
  }
}

/** Parse a full WhatsApp webhook POST body into typed events (never throws). */
export function parseWhatsAppWebhook(payload: unknown): WhatsAppInboundEvent[] {
  const events: WhatsAppInboundEvent[] = [];
  if (typeof payload !== 'object' || payload === null) return events;
  const root = payload as { entry?: unknown };
  if (!Array.isArray(root.entry)) return events;
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> }).value;
      if (typeof value !== 'object' || value === null) continue;
      const profileName = (() => {
        const contacts = value.contacts as Array<{ profile?: { name?: string }; wa_id?: string }> | undefined;
        return contacts?.[0]?.profile?.name;
      })();
      const messages = value.messages as WaRawMessage[] | undefined;
      if (Array.isArray(messages)) {
        for (const m of messages) {
          try {
            const ev = parseOneMessage(m, profileName);
            if (ev) events.push(ev);
          } catch {
            // one malformed message must not drop the rest of the batch
          }
        }
      }
      const statuses = value.statuses as Array<{ id?: string; status?: string; timestamp?: string }> | undefined;
      if (Array.isArray(statuses)) {
        for (const s of statuses) {
          if (typeof s.id === 'string' && s.id && typeof s.status === 'string') {
            events.push({
              kind: 'status',
              providerMessageId: s.id,
              status: s.status,
              timestampMs: (Number(s.timestamp) || Math.floor(Date.now() / 1000)) * 1000,
            });
          }
        }
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Webhook trust
// ---------------------------------------------------------------------------

/** GET handshake: returns the challenge to echo, or null when verification fails. */
export function verifyWhatsAppWebhookHandshake(
  query: Record<string, string | undefined>,
  expectedVerifyToken: string,
): string | null {
  if (!expectedVerifyToken) return null;
  if (query['hub.mode'] !== 'subscribe') return null;
  const token = query['hub.verify_token'] ?? '';
  const a = Buffer.from(token);
  const b = Buffer.from(expectedVerifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const challenge = query['hub.challenge'];
  return typeof challenge === 'string' ? challenge : null;
}

/** POST signature: X-Hub-Signature-256 must equal sha256=HMAC(rawBody, appSecret). */
export function verifyWhatsAppWebhookSignature(appSecret: string, rawBody: string, signatureHeader: string): boolean {
  if (!appSecret || !signatureHeader.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Outbound payload builders (pure — unit-testable without any transport)
// ---------------------------------------------------------------------------

export type WhatsAppMediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface WhatsAppMediaInput {
  kind: WhatsAppMediaKind | 'html';
  /** Public URL of the media (Graph fetches it), OR */
  link?: string;
  /** id of media previously uploaded to the Graph media endpoint. */
  mediaId?: string;
  caption?: string;
  filename?: string;
}

const WA_MEDIA_TYPE: Record<WhatsAppMediaKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  document: 'document',
  sticker: 'sticker',
};

/**
 * Build a media message payload. `voice` maps to the Cloud API audio type
 * with no extra flags (voice notes are audio with voice=true on upload;
 * when sending by link/id the audio type is what the API accepts).
 * Throws for 'html' (not a WhatsApp type) and for missing link/mediaId.
 */
export function buildWhatsAppMediaPayload(to: string, input: WhatsAppMediaInput): Record<string, unknown> {
  if (!to) throw new Error('WhatsApp media send: "to" is required');
  if (input.kind === 'html') {
    throw new Error(
      'WhatsApp has no HTML message type — send the HTML as a document attachment (kind "document") or as a link in a text/CTA message.',
    );
  }
  if (!input.link && !input.mediaId) throw new Error('WhatsApp media send: link or mediaId is required');
  if (input.link && input.mediaId) throw new Error('WhatsApp media send: pass link OR mediaId, not both');
  const type = WA_MEDIA_TYPE[input.kind];
  const media: Record<string, unknown> = input.link ? { link: input.link } : { id: input.mediaId };
  if (input.caption && (input.kind === 'image' || input.kind === 'video' || input.kind === 'document')) {
    media.caption = input.caption;
  }
  if (input.filename && input.kind === 'document') media.filename = input.filename;
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type, [type]: media };
}

export function buildWhatsAppTextPayload(to: string, body: string, opts: { quotedProviderMessageId?: string } = {}): Record<string, unknown> {
  if (!to) throw new Error('WhatsApp text send: "to" is required');
  if (!body?.trim()) throw new Error('WhatsApp text send: body is required');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body, preview_url: false },
    ...(opts.quotedProviderMessageId ? { context: { message_id: opts.quotedProviderMessageId } } : {}),
  };
}

export function buildWhatsAppReactionPayload(to: string, targetProviderMessageId: string, emoji: string): Record<string, unknown> {
  if (!to) throw new Error('WhatsApp reaction send: "to" is required');
  if (!targetProviderMessageId) throw new Error('WhatsApp reaction send: target message id is required');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'reaction',
    reaction: { message_id: targetProviderMessageId, emoji },
  };
}

export interface WhatsAppButtonSpec {
  /** Structured id carried back verbatim on tap. Max 256 chars per API. */
  id: string;
  /** Button label, max 20 chars per API. */
  title: string;
}

/**
 * Interactive reply-button card (CH-8). Max 3 buttons per the Cloud API.
 * Button ids are the structured contract: receivers must match on `id`,
 * never on the title text.
 */
export function buildWhatsAppButtonsPayload(
  to: string,
  bodyText: string,
  buttons: WhatsAppButtonSpec[],
  opts: { headerText?: string; footerText?: string } = {},
): Record<string, unknown> {
  if (!to) throw new Error('WhatsApp buttons send: "to" is required');
  if (!bodyText?.trim()) throw new Error('WhatsApp buttons send: body text is required');
  if (!Array.isArray(buttons) || buttons.length === 0) throw new Error('WhatsApp buttons send: at least one button is required');
  if (buttons.length > 3) throw new Error('WhatsApp buttons send: at most 3 reply buttons per message');
  for (const b of buttons) {
    if (!b.id || b.id.length > 256) throw new Error('WhatsApp button id must be 1–256 chars');
    if (!b.title || b.title.length > 20) throw new Error(`WhatsApp button title "${b.title}" must be 1–20 chars`);
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(opts.headerText ? { header: { type: 'text', text: opts.headerText } } : {}),
      body: { text: bodyText },
      ...(opts.footerText ? { footer: { text: opts.footerText } } : {}),
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  };
}

/** CTA-URL card (CH-8 "open artifact" / "connect" style actions). */
export function buildWhatsAppCtaUrlPayload(
  to: string,
  bodyText: string,
  button: { displayText: string; url: string },
  opts: { headerText?: string; footerText?: string } = {},
): Record<string, unknown> {
  if (!to) throw new Error('WhatsApp CTA send: "to" is required');
  if (!bodyText?.trim()) throw new Error('WhatsApp CTA send: body text is required');
  if (!button.displayText || button.displayText.length > 20) throw new Error('WhatsApp CTA button text must be 1–20 chars');
  if (!/^https:\/\//.test(button.url)) throw new Error('WhatsApp CTA url must be https');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(opts.headerText ? { header: { type: 'text', text: opts.headerText } } : {}),
      body: { text: bodyText },
      ...(opts.footerText ? { footer: { text: opts.footerText } } : {}),
      action: { name: 'cta_url', parameters: { display_text: button.displayText, url: button.url } },
    },
  };
}

// ---------------------------------------------------------------------------
// Transport (injectable fetch; default global fetch)
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface WhatsAppTransport {
  sendPayload(payload: Record<string, unknown>): Promise<{ ok: true; id?: string }>;
  /**
   * Upload local file bytes to the Graph media endpoint and return the
   * provider media id (ADD-5: this is what makes "send a FILE" possible —
   * sendMedia alone can only reference a link or a previously-uploaded id).
   */
  uploadMedia(bytes: Uint8Array, opts: { mimeType: string; filename?: string }): Promise<{ ok: true; id: string }>;
  sendText(to: string, body: string, opts?: { quotedProviderMessageId?: string }): Promise<{ ok: true; id?: string }>;
  sendMedia(to: string, input: WhatsAppMediaInput): Promise<{ ok: true; id?: string }>;
  sendButtons(to: string, bodyText: string, buttons: WhatsAppButtonSpec[], opts?: { headerText?: string; footerText?: string }): Promise<{ ok: true; id?: string }>;
  sendCtaUrl(to: string, bodyText: string, button: { displayText: string; url: string }, opts?: { headerText?: string; footerText?: string }): Promise<{ ok: true; id?: string }>;
  sendReaction(to: string, targetProviderMessageId: string, emoji: string): Promise<{ ok: true; id?: string }>;
}

export function createWhatsAppTransport(opts: {
  token: string;
  phoneNumberId: string;
  fetchFn?: FetchFn;
  apiVersion?: string;
}): WhatsAppTransport {
  if (!opts.token) throw new Error('WhatsApp transport: token is required');
  if (!opts.phoneNumberId) throw new Error('WhatsApp transport: phone number id is required');
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const version = opts.apiVersion ?? 'v21.0';
  const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(opts.phoneNumberId)}/messages`;

  async function sendPayload(payload: Record<string, unknown>): Promise<{ ok: true; id?: string }> {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(payload),
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // fall through to error below
    }
    if (!res.ok) {
      const err = body.error as { message?: string } | undefined;
      throw new Error(`WhatsApp send failed: ${err?.message ?? `HTTP ${res.status}`}`);
    }
    const messages = body.messages as Array<{ id?: string }> | undefined;
    return { ok: true, id: messages?.[0]?.id };
  }

  const mediaEndpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(opts.phoneNumberId)}/media`;

  async function uploadMedia(
    bytes: Uint8Array,
    uploadOpts: { mimeType: string; filename?: string },
  ): Promise<{ ok: true; id: string }> {
    if (!bytes || bytes.length === 0) throw new Error('WhatsApp media upload: file bytes are required');
    if (!uploadOpts.mimeType) throw new Error('WhatsApp media upload: mimeType is required');
    // Multipart form upload per the Cloud API media endpoint. The file
    // part's filename is what recipients see for documents.
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', uploadOpts.mimeType);
    form.append(
      'file',
      new Blob([Buffer.from(bytes)], { type: uploadOpts.mimeType }),
      uploadOpts.filename ?? 'file',
    );
    const res = await fetchFn(mediaEndpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + opts.token },
      body: form,
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // fall through to the error below
    }
    if (!res.ok || typeof body.id !== 'string') {
      const err = body.error as { message?: string } | undefined;
      throw new Error(`WhatsApp media upload failed: ${err?.message ?? `HTTP ${res.status}`}`);
    }
    return { ok: true, id: body.id };
  }

  return {
    sendPayload,
    uploadMedia,
    sendText: (to, body, o) => sendPayload(buildWhatsAppTextPayload(to, body, o)),
    sendMedia: (to, input) => sendPayload(buildWhatsAppMediaPayload(to, input)),
    sendButtons: (to, bodyText, buttons, o) => sendPayload(buildWhatsAppButtonsPayload(to, bodyText, buttons, o)),
    sendCtaUrl: (to, bodyText, button, o) => sendPayload(buildWhatsAppCtaUrlPayload(to, bodyText, button, o)),
    sendReaction: (to, target, emoji) => sendPayload(buildWhatsAppReactionPayload(to, target, emoji)),
  };
}
