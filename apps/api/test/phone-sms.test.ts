// SPDX-License-Identifier: Apache-2.0
// Direct phone SMS + call-from-my-number (CT-6..CT-9): direct sms_send
// dispatch, draft-only mode, drafts, archive search, thread reads,
// tap-to-call card, tools + policy, HTTP routes. The phone is a mock
// dispatcher — zero real messages, zero real calls.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhoneActionResult } from '../src/phone.js';
import {
  PhoneSmsService,
  PhoneSmsStore,
  buildTapToCallCard,
  createPhoneSmsTools,
  phoneSmsPolicyRules,
  type PhoneSmsDispatcher,
} from '../src/phone-sms.js';
import { createPhoneSmsRouter } from '../src/phone-sms-routes.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'phone-sms-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Dispatched { kind: 'action' | 'query'; name: string; params: Record<string, unknown> }

function makeService(opts: { failWith?: string; online?: boolean } = {}) {
  const store = new PhoneSmsStore(tmp());
  const dispatched: Dispatched[] = [];
  const dispatcher: PhoneSmsDispatcher = {
    dispatchAction: async (_deviceId, action, params) => {
      dispatched.push({ kind: 'action', name: action, params });
      return opts.failWith ? { ok: false, error: opts.failWith } : { ok: true };
    },
    dispatchDataQuery: async (_deviceId, query, params) => {
      dispatched.push({ kind: 'query', name: query, params });
      if (opts.failWith) return { ok: false, error: opts.failWith };
      const data: PhoneActionResult['data'] = { messages: [{ address: '+15550102233', body: 'Your OTP is 123456', date: 1, type: 1 }] };
      return { ok: true, data };
    },
    isOnline: () => opts.online ?? true,
  };
  const service = new PhoneSmsService({
    store, dispatcher, resolveDeviceId: () => 'phone_1', audit: () => {},
  });
  return { service, store, dispatched };
}

describe('CT-7 direct SMS send', () => {
  it('dispatches sms_send with the exact approved number + text', async () => {
    const { service, dispatched } = makeService();
    const r = await service.sendSms({ number: '+1 555 010 2233', text: 'Running 10 minutes late' });
    expect(r.sent).toBe(true);
    expect(dispatched).toEqual([{ kind: 'action', name: 'sms_send', params: { number: '+15550102233', text: 'Running 10 minutes late' } }]);
  });

  it('surfaces permission + old-agent failures cleanly', async () => {
    const perm = makeService({ failWith: 'sms_permission_missing' });
    await expect(perm.service.sendSms({ number: '+15550102233', text: 'hi' })).rejects.toThrow(/SEND_SMS permission/);
    const old = makeService({ failWith: 'unknown_action' });
    await expect(old.service.sendSms({ number: '+15550102233', text: 'hi' })).rejects.toThrow(/unknown_action/);
  });

  it('refuses when no phone is online', async () => {
    const { service } = makeService({ online: false });
    await expect(service.sendSms({ number: '+15550102233', text: 'hi' })).rejects.toThrow(/not connected/);
  });
});

describe('CT-8 draft-only mode', () => {
  it('sendSms drafts instead of sending; drafts persist and the composer opens', async () => {
    const { service, store, dispatched } = makeService();
    service.setTextingMode('phone_1', 'draft-only');
    const r = await service.sendSms({ number: '+15550102233', text: 'Draft me' });
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('draft-only');
    expect(r.draft?.reason).toBe('draft-only-mode');
    // The ONLY dispatch was the composer — never sms_send.
    expect(dispatched.map((d) => d.name)).toEqual(['sms_compose']);
    expect(store.listDrafts('phone_1')).toHaveLength(1);
    // Mode is per-device and persists in the store.
    expect(store.getTextingMode('phone_1')).toBe('draft-only');
    expect(store.getTextingMode('phone_2')).toBe('send');
  });

  it('explicit drafts never send and can be deleted', async () => {
    const { service, dispatched } = makeService();
    const draft = service.createDraft({ number: '+15550102233', text: 'later' });
    expect(await service.openComposer(draft)).toBe(true);
    expect(dispatched.map((d) => d.name)).toEqual(['sms_compose']);
    expect(service.deleteDraft(draft.id)).toBe(true);
    expect(service.listDrafts()).toHaveLength(0);
  });
});

describe('CT-9 archive search + CT-7 thread read', () => {
  it('dispatches sms_search / sms_thread data queries with bounded limits', async () => {
    const { service, dispatched } = makeService();
    const found = await service.searchSms({ query: 'OTP', limit: 5000 }) as { messages: unknown[] };
    expect(found.messages).toHaveLength(1);
    expect(dispatched[0]).toEqual({ kind: 'query', name: 'sms_search', params: { query: 'OTP', limit: 200 } });
    await service.readThread({ address: '+15550102233' });
    expect(dispatched[1]!.name).toBe('sms_thread');
    await expect(service.searchSms({ query: '' })).rejects.toThrow(/query/);
  });
});

describe('CT-6 call from my number + tap-to-call card', () => {
  it('card payload carries tel: link + the packaged dispatch', () => {
    const card = buildTapToCallCard({ number: '+1 555 010 2233', counterpartyName: 'Acme Dental' });
    expect(card.kind).toBe('tap-to-call');
    expect(card.telUri).toBe('tel:+15550102233');
    expect(card.dispatch).toEqual({ action: 'call', params: { number: '+15550102233', contact: 'Acme Dental' } });
    expect(card.note).toContain('approval');
  });

  it('dial dispatches the existing call action on the paired phone', async () => {
    const { service, dispatched } = makeService();
    const r = await service.dialFromMyNumber({ number: '+15550102233', contact: 'Acme' });
    expect(r.number).toBe('+15550102233');
    expect(dispatched).toEqual([{ kind: 'action', name: 'call', params: { number: '+15550102233', contact: 'Acme' } }]);
  });
});

describe('tools + policy', () => {
  it('all send/dial + read/search tools are require-approval', () => {
    const rules = phoneSmsPolicyRules();
    expect(rules.every((r) => r.effect === 'require-approval')).toBe(true);
    const tools = createPhoneSmsTools({ service: makeService().service });
    expect(tools.map((t) => t.name)).toEqual(['phone_sms_send', 'phone_sms_draft', 'phone_sms_search', 'phone_sms_thread', 'call_from_my_number']);
    expect(tools.find((t) => t.name === 'phone_sms_send')!.mutating).toBe(true);
    expect(tools.find((t) => t.name === 'phone_sms_draft')!.mutating).toBeFalsy();
  });

  it('phone_sms_draft tool returns sent:false always', async () => {
    const { service } = makeService();
    const tool = createPhoneSmsTools({ service }).find((t) => t.name === 'phone_sms_draft')!;
    const out = await tool.handler({ number: '+15550102233', text: 'hi' }, { botId: 'b', sessionId: 's' } as never) as { sent: boolean };
    expect(out.sent).toBe(false);
  });
});

describe('HTTP routes', () => {
  let server: Server;
  let base: string;
  let svc: ReturnType<typeof makeService>;
  beforeEach(async () => {
    svc = makeService();
    const app = express();
    app.use(express.json());
    app.use('/api/phone-sms', createPhoneSmsRouter({ service: svc.service }));
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/phone-sms`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('mode → draft-only makes POST /send draft; card + dial work', async () => {
    const put = await fetch(`${base}/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'phone_1', mode: 'draft-only' }) });
    expect(put.status).toBe(200);
    const sent = await (await fetch(`${base}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: '+15550102233', text: 'hi' }) })).json() as { sent: boolean };
    expect(sent.sent).toBe(false);
    const drafts = await (await fetch(`${base}/drafts`)).json() as { drafts: unknown[] };
    expect(drafts.drafts).toHaveLength(1);

    const card = await (await fetch(`${base}/tap-to-call-card`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: '+15550102233' }) })).json() as { card: { telUri: string } };
    expect(card.card.telUri).toBe('tel:+15550102233');
    const dial = await fetch(`${base}/dial`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: '+15550102233' }) });
    expect(dial.status).toBe(200);
  });
});
