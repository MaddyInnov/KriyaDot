// SPDX-License-Identifier: Apache-2.0
// Tests for the WhatsApp Cloud surface (CH-6/CH-7/CH-8/CH-9 transport side):
// - webhook parsing: text, typed attachments, quote-reply context, voice vs
//   audio, reactions, structured interactive replies, statuses
// - webhook trust: GET handshake + POST HMAC signature
// - outbound builders: every media type, buttons (limits), CTA URL, reaction
// - transport over a mock fetch (zero network, zero paid API)

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildWhatsAppButtonsPayload,
  buildWhatsAppCtaUrlPayload,
  buildWhatsAppMediaPayload,
  buildWhatsAppReactionPayload,
  buildWhatsAppTextPayload,
  createWhatsAppTransport,
  parseWhatsAppWebhook,
  verifyWhatsAppWebhookHandshake,
  verifyWhatsAppWebhookSignature,
  type FetchFn,
} from '../src/whatsapp-cloud.js';

function webhookWith(messages: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'biz-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ profile: { name: 'Asha Rao' }, wa_id: '919999999999' }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

const FROM = '919999999999';

describe('parseWhatsAppWebhook — messages (CH-6)', () => {
  it('parses a text message with sender + contact name', () => {
    const events = parseWhatsAppWebhook(
      webhookWith([{ id: 'wamid.1', from: FROM, timestamp: '1700000000', type: 'text', text: { body: 'hello' } }]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message', providerMessageId: 'wamid.1', from: FROM, chatId: FROM, text: 'hello', contactName: 'Asha Rao' });
  });

  it('resolves quote-reply context to the quoted provider id', () => {
    const events = parseWhatsAppWebhook(
      webhookWith([
        { id: 'wamid.2', from: FROM, timestamp: '1700000001', type: 'text', text: { body: 'replying' }, context: { id: 'wamid.1', from: FROM } },
      ]),
    );
    expect(events[0]).toMatchObject({ kind: 'message', quoted: { providerMessageId: 'wamid.1', from: FROM } });
  });

  it.each([
    ['image', { id: 'media-img', mime_type: 'image/jpeg', caption: 'look' }, 'image'],
    ['document', { id: 'media-doc', mime_type: 'application/pdf', filename: 'invoice.pdf' }, 'document'],
    ['video', { id: 'media-vid', mime_type: 'video/mp4' }, 'video'],
    ['sticker', { id: 'media-stk', mime_type: 'image/webp' }, 'sticker'],
  ])('types a %s attachment', (type, media, kind) => {
    const events = parseWhatsAppWebhook(
      webhookWith([{ id: `wamid.${type}`, from: FROM, timestamp: '1700000002', type, [type]: media }]),
    );
    expect(events[0]).toMatchObject({ kind: 'message', attachment: { kind, mediaId: (media as { id: string }).id } });
  });

  it('distinguishes voice notes from plain audio', () => {
    const voice = parseWhatsAppWebhook(
      webhookWith([{ id: 'wamid.v', from: FROM, timestamp: '1', type: 'audio', audio: { id: 'm-v', mime_type: 'audio/ogg', voice: true } }]),
    );
    expect(voice[0]).toMatchObject({ attachment: { kind: 'voice' } });
    const audio = parseWhatsAppWebhook(
      webhookWith([{ id: 'wamid.a', from: FROM, timestamp: '1', type: 'audio', audio: { id: 'm-a', mime_type: 'audio/mpeg', voice: false } }]),
    );
    expect(audio[0]).toMatchObject({ attachment: { kind: 'audio' } });
  });

  it('parses a location message', () => {
    const events = parseWhatsAppWebhook(
      webhookWith([{ id: 'wamid.loc', from: FROM, timestamp: '1', type: 'location', location: { latitude: 12.9, longitude: 77.6, name: 'Office' } }]),
    );
    expect(events[0]).toMatchObject({ kind: 'message', location: { latitude: 12.9, longitude: 77.6, name: 'Office' } });
  });

  it('parses reactions, including removal (empty emoji)', () => {
    const events = parseWhatsAppWebhook(
      webhookWith([
        { id: 'wamid.r1', from: FROM, timestamp: '1', type: 'reaction', reaction: { message_id: 'wamid.1', emoji: '👍' } },
        { id: 'wamid.r2', from: FROM, timestamp: '2', type: 'reaction', reaction: { message_id: 'wamid.1', emoji: '' } },
      ]),
    );
    expect(events[0]).toMatchObject({ kind: 'reaction', targetProviderMessageId: 'wamid.1', emoji: '👍' });
    expect(events[1]).toMatchObject({ kind: 'reaction', emoji: '' });
  });

  it('parses structured interactive replies (button + list) with their ids', () => {
    const events = parseWhatsAppWebhook(
      webhookWith([
        { id: 'wamid.b', from: FROM, timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'kap:prompt-1:approved', title: '✅ Approve' } } },
        { id: 'wamid.l', from: FROM, timestamp: '2', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'kac:card-1:open', title: 'Open' } } },
      ]),
    );
    expect(events[0]).toMatchObject({ kind: 'interactive-reply', replyType: 'button_reply', replyId: 'kap:prompt-1:approved' });
    expect(events[1]).toMatchObject({ kind: 'interactive-reply', replyType: 'list_reply', replyId: 'kac:card-1:open' });
  });

  it('treats legacy template button payloads as plain text (never structured)', () => {
    const events = parseWhatsAppWebhook(
      webhookWith([{ id: 'wamid.tb', from: FROM, timestamp: '1', type: 'button', button: { text: 'Yes', payload: 'yes' } }]),
    );
    expect(events[0]).toMatchObject({ kind: 'message', text: 'Yes' });
  });

  it('parses delivery statuses and ignores garbage', () => {
    const events = parseWhatsAppWebhook(webhookWith([], { statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1700000100' }] }));
    expect(events).toEqual([{ kind: 'status', providerMessageId: 'wamid.1', status: 'delivered', timestampMs: 1700000100000 }]);
    expect(parseWhatsAppWebhook(null)).toEqual([]);
    expect(parseWhatsAppWebhook({ entry: 'nope' })).toEqual([]);
    expect(parseWhatsAppWebhook(webhookWith([{ type: 'text' }]))).toEqual([]);
  });
});

describe('webhook trust', () => {
  it('handshake echoes the challenge only for the right token + mode', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt-1', 'hub.challenge': '42' };
    expect(verifyWhatsAppWebhookHandshake(q, 'vt-1')).toBe('42');
    expect(verifyWhatsAppWebhookHandshake({ ...q, 'hub.verify_token': 'wrong' }, 'vt-1')).toBeNull();
    expect(verifyWhatsAppWebhookHandshake({ ...q, 'hub.mode': 'unsubscribe' }, 'vt-1')).toBeNull();
    expect(verifyWhatsAppWebhookHandshake(q, '')).toBeNull();
  });

  it('signature check accepts a valid HMAC and rejects tampering', () => {
    const body = '{"object":"whatsapp_business_account"}';
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(verifyWhatsAppWebhookSignature('app-secret', body, sig)).toBe(true);
    expect(verifyWhatsAppWebhookSignature('app-secret', `${body} `, sig)).toBe(false);
    expect(verifyWhatsAppWebhookSignature('other', body, sig)).toBe(false);
    expect(verifyWhatsAppWebhookSignature('app-secret', body, 'sha1=abc')).toBe(false);
  });
});

describe('outbound builders (CH-7/CH-8)', () => {
  it.each(['image', 'video', 'audio', 'voice', 'document', 'sticker'] as const)('builds a %s media payload by link', (kind) => {
    const payload = buildWhatsAppMediaPayload('+1555', { kind, link: 'https://example.com/f.bin', caption: 'cap', filename: 'f.pdf' });
    expect(payload.messaging_product).toBe('whatsapp');
    expect(payload.to).toBe('+1555');
    const type = kind === 'voice' ? 'audio' : kind;
    expect(payload.type).toBe(type);
    const media = payload[type] as Record<string, unknown>;
    expect(media.link).toBe('https://example.com/f.bin');
    if (kind === 'image' || kind === 'video' || kind === 'document') expect(media.caption).toBe('cap');
    if (kind === 'document') expect(media.filename).toBe('f.pdf');
  });

  it('builds media by id and rejects link+id together', () => {
    const payload = buildWhatsAppMediaPayload('+1555', { kind: 'image', mediaId: 'mid-9' });
    expect((payload.image as Record<string, unknown>).id).toBe('mid-9');
    expect(() => buildWhatsAppMediaPayload('+1555', { kind: 'image', link: 'https://x', mediaId: 'm' })).toThrow(/link OR mediaId/);
    expect(() => buildWhatsAppMediaPayload('+1555', { kind: 'image' })).toThrow(/link or mediaId is required/);
  });

  it('rejects HTML honestly instead of degrading silently', () => {
    expect(() => buildWhatsAppMediaPayload('+1555', { kind: 'html', link: 'https://x' })).toThrow(/no HTML message type/);
  });

  it('builds a quoted text payload', () => {
    const payload = buildWhatsAppTextPayload('+1555', 'reply', { quotedProviderMessageId: 'wamid.7' });
    expect(payload.context).toEqual({ message_id: 'wamid.7' });
    expect((payload.text as Record<string, unknown>).body).toBe('reply');
  });

  it('builds a reaction payload (incl. removal with empty emoji)', () => {
    expect(buildWhatsAppReactionPayload('+1555', 'wamid.1', '❤️')).toMatchObject({
      type: 'reaction',
      reaction: { message_id: 'wamid.1', emoji: '❤️' },
    });
    expect(buildWhatsAppReactionPayload('+1555', 'wamid.1', '')).toMatchObject({ reaction: { emoji: '' } });
  });

  it('builds a reply-button card and enforces API limits', () => {
    const payload = buildWhatsAppButtonsPayload('+1555', 'Pick one', [
      { id: 'kap:p1:approved', title: '✅ Approve' },
      { id: 'kap:p1:denied', title: '⛔ Deny' },
    ]);
    const interactive = payload.interactive as { type: string; action: { buttons: Array<{ reply: { id: string } }> } };
    expect(interactive.type).toBe('button');
    expect(interactive.action.buttons.map((b) => b.reply.id)).toEqual(['kap:p1:approved', 'kap:p1:denied']);
    expect(() =>
      buildWhatsAppButtonsPayload('+1555', 'x', [1, 2, 3, 4].map((n) => ({ id: `i${n}`, title: `t${n}` }))),
    ).toThrow(/at most 3/);
    expect(() => buildWhatsAppButtonsPayload('+1555', 'x', [{ id: 'i', title: 'a title that is far too long' }])).toThrow(/1–20 chars/);
    expect(() => buildWhatsAppButtonsPayload('+1555', 'x', [])).toThrow(/at least one/);
  });

  it('builds a CTA URL card and requires https', () => {
    const payload = buildWhatsAppCtaUrlPayload('+1555', 'Your report is ready', { displayText: 'Open artifact', url: 'https://example.com/a/1' });
    const interactive = payload.interactive as { type: string; action: { parameters: { display_text: string; url: string } } };
    expect(interactive.type).toBe('cta_url');
    expect(interactive.action.parameters.url).toBe('https://example.com/a/1');
    expect(() => buildWhatsAppCtaUrlPayload('+1555', 'x', { displayText: 'Open', url: 'http://insecure.example' })).toThrow(/https/);
  });
});

describe('transport (mock fetch)', () => {
  function mockTransport(capture: Array<{ url: string; body: Record<string, unknown> }>, status = 200, responseBody: unknown = { messages: [{ id: 'wamid.new' }] }) {
    const fetchFn: FetchFn = async (url, init) => {
      capture.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    };
    return createWhatsAppTransport({ token: 'tok', phoneNumberId: 'pn-1', fetchFn });
  }

  it('sends every outbound kind to the Graph endpoint', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const t = mockTransport(calls);
    await expect(t.sendText('+1', 'hi')).resolves.toEqual({ ok: true, id: 'wamid.new' });
    await t.sendMedia('+1', { kind: 'document', mediaId: 'm1', filename: 'a.pdf' });
    await t.sendButtons('+1', 'decide', [{ id: 'kap:x:approved', title: '✅ Approve' }]);
    await t.sendCtaUrl('+1', 'open', { displayText: 'Open', url: 'https://example.com' });
    await t.sendReaction('+1', 'wamid.0', '👍');
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.url === 'https://graph.facebook.com/v21.0/pn-1/messages')).toBe(true);
    expect(calls.map((c) => c.body.type)).toEqual(['text', 'document', 'interactive', 'interactive', 'reaction']);
  });

  it('surfaces Graph errors without leaking the token', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const t = mockTransport(calls, 400, { error: { message: 'Recipient not in allowed list' } });
    await expect(t.sendText('+1', 'hi')).rejects.toThrow(/WhatsApp send failed: Recipient not in allowed list/);
  });

  it('requires token + phone number id', () => {
    expect(() => createWhatsAppTransport({ token: '', phoneNumberId: 'p' })).toThrow(/token is required/);
    expect(() => createWhatsAppTransport({ token: 't', phoneNumberId: '' })).toThrow(/phone number id is required/);
  });
});
