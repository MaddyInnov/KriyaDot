// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PhoneStore, PhoneSessionHub, validateMessage, type PhoneSocket } from '../src/phone.js';
import { createPhoneDataTools, phoneDataPolicyRules, validatePhoneDataQuery } from '../src/phone-data-tools.js';

describe('validatePhoneDataQuery', () => {
  it('normalizes + clamps params per tool', () => {
    expect(validatePhoneDataQuery('phone_calendar', { daysAhead: 999, limit: 0 })).toEqual({ query: 'calendar', params: { daysAhead: 31, limit: 1 }, deviceId: undefined });
    expect(validatePhoneDataQuery('phone_contacts', { query: '  Asha ' })).toMatchObject({ query: 'contacts', params: { query: 'Asha' } });
    expect(validatePhoneDataQuery('phone_messages_recent', {})).toMatchObject({ query: 'messages_recent', params: { limit: 20 } });
    expect(validatePhoneDataQuery('phone_location', {})).toEqual({ query: 'location', params: {}, deviceId: undefined });
    expect(() => validatePhoneDataQuery('phone_nope', {})).toThrow(/unknown/);
  });
  it('policy rules require approval for all four tools', () => {
    const rules = phoneDataPolicyRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].effect).toBe('require-approval');
    const re = new RegExp(rules[0].toolPattern, 'i');
    for (const n of ['phone_calendar', 'phone_contacts', 'phone_messages_recent', 'phone_location']) expect(re.test(n)).toBe(true);
  });
});

class FakeSocket implements PhoneSocket {
  sent: string[] = [];
  private msgCb: ((t: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  sendText(t: string): void { this.sent.push(t); }
  close(): void { this.closeCb?.(); }
  onMessage(cb: (t: string) => void): void { this.msgCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  receive(obj: unknown): void { this.msgCb?.(JSON.stringify(obj)); }
}

describe('data_query round-trip over the phone hub', () => {
  it('dispatchDataQuery correlates data_result by id and returns data; validateMessage caps payloads', async () => {
    const store = new PhoneStore(mkdtempSync(join(tmpdir(), 'phone-data-')));
    const pair = store.confirmPairing({ code: store.requestPairingCode().code, deviceName: 'Pixel', platform: 'android' });
    if (!pair.ok) throw new Error('pair failed');
    const hub = new PhoneSessionHub(store, () => {});
    const phoneSock = new FakeSocket();
    hub.acceptSocket(phoneSock, '127.0.0.1');
    phoneSock.receive({ t: 'hello', deviceId: pair.deviceId, token: pair.token });
    expect(hub.isOnline(pair.deviceId)).toBe(true);

    const pending = hub.dispatchDataQuery(pair.deviceId, 'location', {});
    const wire = JSON.parse(phoneSock.sent[phoneSock.sent.length - 1]) as { type: string; id: string; query: string };
    expect(wire.type).toBe('data_query');
    expect(wire.query).toBe('location');
    phoneSock.receive({ type: 'data_result', id: wire.id, ok: true, data: { available: true, latitude: 1, longitude: 2 } });
    await expect(pending).resolves.toEqual({ ok: true, data: { available: true, latitude: 1, longitude: 2 } });

    expect(validateMessage({ type: 'data_result', id: 'x', ok: true, data: { a: 1 } }).ok).toBe(true);
    expect(validateMessage({ type: 'data_result', id: 'x', ok: true, data: 'x'.repeat(300_000) }).ok).toBe(false);

    // Tool handler surfaces hub data and audits metadata only.
    const audits: unknown[] = [];
    const tools = createPhoneDataTools({
      dispatcher: { dispatchDataQuery: (d, q, p) => hub.dispatchDataQuery(d, q, p), isOnline: (d) => hub.isOnline(d) },
      resolveDeviceId: () => pair.deviceId,
      audit: (_a, f) => audits.push(f.detail),
    });
    const loc = tools.find((t) => t.name === 'phone_location')!;
    expect(loc.mutating).toBeUndefined();
    const call = loc.handler({}, { botId: 'b1', sessionId: 's1' } as never);
    const wire2 = JSON.parse(phoneSock.sent[phoneSock.sent.length - 1]) as { id: string };
    phoneSock.receive({ type: 'data_result', id: wire2.id, ok: true, data: { available: false } });
    await expect(call).resolves.toMatchObject({ ok: true, query: 'location', data: { available: false } });
    expect(JSON.stringify(audits)).not.toContain('available');
  });

  it('offline device gives a clean tool error', async () => {
    const tools = createPhoneDataTools({
      dispatcher: { dispatchDataQuery: async () => ({ ok: false, error: 'device_offline' }), isOnline: () => false },
      resolveDeviceId: () => 'phone_x',
    });
    await expect(tools[0].handler({}, { botId: 'b', sessionId: 's' } as never)).rejects.toThrow(/not connected/);
  });
});
