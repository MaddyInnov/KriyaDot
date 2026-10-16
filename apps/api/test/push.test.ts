// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionStore } from '../src/companion.js';
import {
  PushService,
  sealPayload,
  unsealPayload,
  type NotificationPref,
  type PushDevice,
} from '../src/push.js';

const keyB64 = () => randomBytes(32).toString('base64');

/** Realistic-length FCM registration token for tests. */
const FCM_TOKEN = 'fcm-test-token-'.padEnd(64, 'x');

const device = (over: Partial<PushDevice> = {}): PushDevice => ({
  deviceId: 'comp_1',
  fcmToken: FCM_TOKEN,
  pushKey: keyB64(),
  ...over,
});

function service(opts: {
  devices: PushDevice[];
  prefs?: Record<string, NotificationPref>;
  sent?: Array<{ token: string; data: Record<string, string> }>;
}) {
  const sent = opts.sent ?? [];
  const svc = new PushService({
    listPushDevices: () => opts.devices,
    getBotPref: (botId) => opts.prefs?.[botId] ?? 'all',
    sendFcm: async (token, data) => {
      sent.push({ token, data });
    },
  });
  return { svc, sent };
}

describe('sealPayload / unsealPayload', () => {
  it('round-trips title and body', () => {
    const key = keyB64();
    const sealed = sealPayload(key, 'Hello', 'World body');
    expect(sealed.v).toBe(1);
    expect(unsealPayload(key, sealed)).toEqual({ title: 'Hello', body: 'World body' });
  });

  it('rejects a wrong key', () => {
    const sealed = sealPayload(keyB64(), 't', 'b');
    expect(() => unsealPayload(keyB64(), sealed)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const key = keyB64();
    const sealed = sealPayload(key, 't', 'b');
    const raw = Buffer.from(sealed.ct, 'base64');
    raw[0] ^= 0xff;
    expect(() => unsealPayload(key, { ...sealed, ct: raw.toString('base64') })).toThrow();
  });

  it('truncates overlong title/body (Codync limits: 80/400)', () => {
    const key = keyB64();
    const sealed = sealPayload(key, 'x'.repeat(200), 'y'.repeat(1000));
    const out = unsealPayload(key, sealed);
    expect(out.title.length).toBe(80);
    expect(out.body.length).toBe(400);
  });

  it('rejects malformed keys', () => {
    expect(() => sealPayload('not-base64!!', 't', 'b')).toThrow();
    expect(() => sealPayload(randomBytes(16).toString('base64'), 't', 'b')).toThrow();
  });
});

describe('PushService.notify', () => {

  it('seals content per device and never includes plaintext', async () => {
    const { svc, sent } = service({ devices: [device()] });
    const r = await svc.notify({ kind: 'done', botId: 'b1', botName: 'Scout', title: 'T', body: 'secret body' });
    expect(r).toEqual({ attempted: 1, sent: 1 });
    const data = sent[0].data;
    expect(data.sealed).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain('secret body');
    expect(data.kind).toBe('done');
    expect(data.botId).toBe('b1');
  });

  it('falls back to generic text when the device has no push key', async () => {
    const { svc, sent } = service({ devices: [device({ pushKey: null })] });
    await svc.notify({ kind: 'needsInput', botId: 'b1', botName: 'Scout', title: 'T', body: 'secret' });
    const data = sent[0].data;
    expect(data.sealed).toBeUndefined();
    expect(data.fallbackTitle).toBe('KriyaDot');
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it("respects pref 'none'", async () => {
    const { svc, sent } = service({ devices: [device()], prefs: { b1: 'none' } });
    const r = await svc.notify({ kind: 'done', botId: 'b1', botName: 'S', title: 'T', body: 'B' });
    expect(r).toEqual({ attempted: 0, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("pref 'approvals' allows needsInput but suppresses done/failed", async () => {
    const { svc, sent } = service({ devices: [device()], prefs: { b1: 'approvals' } });
    await svc.notify({ kind: 'needsInput', botId: 'b1', botName: 'S', title: 'T', body: 'B', approvalId: 'a1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].data.approvalId).toBe('a1');
    await svc.notify({ kind: 'done', botId: 'b1', botName: 'S', title: 'T', body: 'B' });
    await svc.notify({ kind: 'failed', botId: 'b1', botName: 'S', title: 'T', body: 'B' });
    expect(sent).toHaveLength(1);
  });

  it('is a no-op with no devices and never throws', async () => {
    const { svc } = service({ devices: [] });
    await expect(
      svc.notify({ kind: 'done', botId: 'b1', botName: 'S', title: 'T', body: 'B' }),
    ).resolves.toEqual({ attempted: 0, sent: 0 });
  });

  it('continues fan-out when one device send fails', async () => {
    const sent: Array<{ token: string; data: Record<string, string> }> = [];
    const svc = new PushService({
      listPushDevices: () => [device({ deviceId: 'a', fcmToken: 't-a' }), device({ deviceId: 'b', fcmToken: 't-b' })],
      getBotPref: () => 'all',
      sendFcm: async (token, data) => {
        if (token === 't-a') throw new Error('bad token');
        sent.push({ token, data });
      },
    });
    const r = await svc.notify({ kind: 'done', botId: 'b1', botName: 'S', title: 'T', body: 'B' });
    expect(r).toEqual({ attempted: 2, sent: 1 });
  });
});

describe('CompanionStore push fields', () => {
  const pair = (store: CompanionStore) => {
    const rec = store.requestPairingOTT();
    const res = store.exchangePairing({ ott: rec.ott, deviceName: 'Pixel', platform: 'android' });
    if (!res.ok) throw new Error('pairing failed');
    return res;
  };

  it('exchangePairing issues a 256-bit push key', () => {
    const store = new CompanionStore(mkdtempSync(join(tmpdir(), 'push-')));
    const res = pair(store);
    expect(Buffer.from(res.pushKey, 'base64').length).toBe(32);
  });

  it('setFcmToken + listPushDevices round-trip', () => {
    const store = new CompanionStore(mkdtempSync(join(tmpdir(), 'push-')));
    const res = pair(store);
    expect(store.listPushDevices()).toHaveLength(0);
    expect(store.setFcmToken(res.deviceId, FCM_TOKEN)).toBe(true);
    const devices = store.listPushDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe(res.deviceId);
    expect(devices[0].fcmToken).toBe(FCM_TOKEN);
    expect(devices[0].pushKey).toBe(res.pushKey);
  });

  it('setFcmToken rejects bad device ids and tokens', () => {
    const store = new CompanionStore(mkdtempSync(join(tmpdir(), 'push-')));
    const res = pair(store);
    expect(store.setFcmToken('nope', 'fcm-abc')).toBe(false);
    expect(store.setFcmToken(res.deviceId, '')).toBe(false);
    expect(store.setFcmToken(res.deviceId, 'x')).toBe(false);
    expect(store.setFcmToken(res.deviceId, FCM_TOKEN + ' ok'.padEnd(5000, 'y'))).toBe(false);
  });

  it('sealed payload decrypts with the paired push key', () => {
    const store = new CompanionStore(mkdtempSync(join(tmpdir(), 'push-')));
    const res = pair(store);
    store.setFcmToken(res.deviceId, FCM_TOKEN);
    const [dev] = store.listPushDevices();
    const sealed = sealPayload(dev.pushKey!, 'Scout — Task complete', 'Did the thing');
    expect(unsealPayload(res.pushKey, sealed)).toEqual({
      title: 'Scout — Task complete',
      body: 'Did the thing',
    });
  });
});

describe('PushService convenience triggers', () => {
  it('convenience triggers shape title/body correctly', async () => {
    const { svc, sent } = service({ devices: [device()] });
    await svc.notifyTurnDone('b1', 'Scout', 'Here is the result…', 'chat-9');
    expect(sent[0].data.kind).toBe('done');
    expect(sent[0].data.chatId).toBe('chat-9');
    await svc.notifyApprovalNeeded('b1', 'Scout', 'apr-1', 'computer_click', 'wants to run computer_click');
    expect(sent[1].data.kind).toBe('needsInput');
    await svc.notifyTurnFailed('b1', 'Scout', 'boom');
    expect(sent[2].data.kind).toBe('failed');
  });
});
