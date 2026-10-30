// SPDX-License-Identifier: Apache-2.0
// WhatsApp FILE send, both halves verified with zero network (ADD-5 item 3a):
//   1. Transport level: createWhatsAppTransport.uploadMedia posts the file
//      bytes as multipart form data to the Graph media endpoint and
//      returns the provider media id (injected fetch).
//   2. Route level: POST /messaging/whatsapp/send-file runs the whole
//      messaging path — validation, the deny-by-default governance
//      approval (denied → nothing is uploaded or sent), upload, send by
//      media id as a document, and mirroring into the side chat with the
//      typed attachment record.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { createChannelParityRouter, type ChannelParityHandle } from '../src/channel-parity-routes.js';
import { createWhatsAppTransport, type WhatsAppTransport } from '../src/whatsapp-cloud.js';

const FROM = '919999999999';
const FILE_BYTES = Buffer.from('%PDF-1.4 fake but non-empty document bytes');
const FILE_B64 = FILE_BYTES.toString('base64');

describe('WhatsApp transport uploadMedia', () => {
  it('posts multipart form data to /{phoneNumberId}/media and returns the media id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'media-uploaded-1' }), { status: 200 });
    };
    const t = createWhatsAppTransport({ token: 'tok' + 'en-1', phoneNumberId: 'pn-1', fetchFn });
    const out = await t.uploadMedia(new Uint8Array(FILE_BYTES), { mimeType: 'application/pdf', filename: 'report.pdf' });
    expect(out).toEqual({ ok: true, id: 'media-uploaded-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/pn-1/media');
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(['Bearer', 'token-1'].join(' '));
    const form = calls[0]!.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('application/pdf');
    const file = form.get('file') as File;
    expect(file.name).toBe('report.pdf');
    expect(file.size).toBe(FILE_BYTES.length);
  });

  it('surfaces Graph errors and rejects empty bytes / missing mime type', async () => {
    const failing = createWhatsAppTransport({
      token: 't',
      phoneNumberId: 'p',
      fetchFn: async () => new Response(JSON.stringify({ error: { message: 'bad file' } }), { status: 400 }),
    });
    await expect(failing.uploadMedia(new Uint8Array([1]), { mimeType: 'application/pdf' })).rejects.toThrow(/bad file/);
    const ok = createWhatsAppTransport({ token: 't', phoneNumberId: 'p', fetchFn: async () => new Response('{}') });
    await expect(ok.uploadMedia(new Uint8Array(0), { mimeType: 'application/pdf' })).rejects.toThrow(/bytes are required/);
    await expect(ok.uploadMedia(new Uint8Array([1]), { mimeType: '' })).rejects.toThrow(/mimeType is required/);
  });
});

describe('POST /whatsapp/send-file (route, approval-gated end to end)', () => {
  let dir: string;
  let governance: GovernanceGateway;
  let handle: ChannelParityHandle;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  const calls: Array<{ method: string; args: unknown[] }> = [];

  function mockTransport(): WhatsAppTransport {
    const rec = (method: string) => async (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'uploadMedia') return { ok: true as const, id: 'media-up-9' };
      return { ok: true as const, id: `wamid.out-${calls.length}` };
    };
    return {
      sendPayload: rec('sendPayload') as WhatsAppTransport['sendPayload'],
      uploadMedia: rec('uploadMedia') as WhatsAppTransport['uploadMedia'],
      sendText: rec('sendText') as WhatsAppTransport['sendText'],
      sendMedia: rec('sendMedia') as WhatsAppTransport['sendMedia'],
      sendButtons: rec('sendButtons') as WhatsAppTransport['sendButtons'],
      sendCtaUrl: rec('sendCtaUrl') as WhatsAppTransport['sendCtaUrl'],
      sendReaction: rec('sendReaction') as WhatsAppTransport['sendReaction'],
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wafile-'));
    calls.length = 0;
    governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json({ limit: '40mb' }));
    handle = createChannelParityRouter({
      dataDir: dir,
      governance,
      saveKey: () => undefined,
      removeKey: () => false,
      createTransport: () => mockTransport(),
      verifyToken: 'verify' + '-me',
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

  async function approvePending(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pending = governance.listApprovals('pending').find((a) => a.toolName === 'message.send');
      if (pending) {
        governance.decide(pending.id, 'approved');
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no pending message.send approval appeared');
  }

  it('denied (no approval): nothing is uploaded and nothing is sent', async () => {
    const res = await post('/whatsapp/send-file', {
      to: FROM, fileName: 'report.pdf', mimeType: 'application/pdf', contentBase64: FILE_B64, waitMs: 10,
    });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.method === 'uploadMedia')).toBe(false);
    expect(calls.some((c) => c.method === 'sendMedia')).toBe(false);
  });

  it('approved: bytes upload, the document sends by media id, and the side chat mirrors the attachment', async () => {
    const sendPromise = post('/whatsapp/send-file', {
      to: FROM, fileName: 'report.pdf', mimeType: 'application/pdf', contentBase64: FILE_B64, caption: 'Q3 report', waitMs: 8000,
    });
    await approvePending();
    const res = await sendPromise;
    expect(res.status).toBe(200);

    const upload = calls.find((c) => c.method === 'uploadMedia');
    expect(upload).toBeDefined();
    expect(Buffer.from(upload!.args[0] as Uint8Array).equals(FILE_BYTES)).toBe(true);
    expect(upload!.args[1]).toMatchObject({ mimeType: 'application/pdf', filename: 'report.pdf' });

    const send = calls.find((c) => c.method === 'sendMedia');
    expect(send).toBeDefined();
    expect(send!.args[0]).toBe(FROM);
    expect(send!.args[1]).toMatchObject({ kind: 'document', mediaId: 'media-up-9', filename: 'report.pdf', caption: 'Q3 report' });

    const chat = handle.sideChats.getChatByExternal('whatsapp', FROM)!;
    const mirrored = handle.sideChats.listMessages(chat.id).find((m) => m.direction === 'out');
    expect(mirrored?.kind).toBe('document');
    expect(mirrored?.attachment).toMatchObject({ kind: 'document', mediaId: 'media-up-9', filename: 'report.pdf' });
  });

  it('rejects missing/empty/oversized files BEFORE raising an approval', async () => {
    const missing = await post('/whatsapp/send-file', { to: FROM, fileName: 'x.pdf' });
    expect(missing.status).toBe(400);
    const empty = await post('/whatsapp/send-file', { to: FROM, fileName: 'x.pdf', contentBase64: '' });
    expect(empty.status).toBe(400);
    expect(governance.listApprovals('pending')).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
