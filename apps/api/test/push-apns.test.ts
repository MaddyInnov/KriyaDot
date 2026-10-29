// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionStore } from '../src/companion.js';
import {
  ApnsError,
  PushService,
  buildApnsJwt,
  resolveApnsConfig,
  type ApnsConfig,
  type ApnsSession,
  type PushDevice,
} from '../src/push.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const cfg: ApnsConfig = { keyId: 'KEY123', teamId: 'TEAM456', bundleId: 'com.kriyadot.app', keyPem, env: 'sandbox' };
const keyB64 = () => randomBytes(32).toString('base64');
const iosDevice = (over: Partial<PushDevice> = {}): PushDevice => ({ deviceId: 'ios1', fcmToken: 'apns-token-abc', pushKey: keyB64(), platform: 'ios', ...over });
const androidDevice = (): PushDevice => ({ deviceId: 'and1', fcmToken: 'fcm-token-xyz', pushKey: keyB64(), platform: 'android' });

describe('buildApnsJwt', () => {
  it('has ES256 header, iss/iat claims and a verifiable P-256 signature', () => {
    const jwt = buildApnsJwt(cfg, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ iss: 'TEAM456', iat: 1_700_000_000 });
    const ok = cryptoVerify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
  it('resolveApnsConfig requires all fields and reads key from PEM env', () => {
    expect(resolveApnsConfig({} as NodeJS.ProcessEnv)).toBeNull();
    const c = resolveApnsConfig({ APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_BUNDLE_ID: 'b', APNS_KEY_PEM: keyPem.replace(/\n/g, '\\n'), APNS_ENV: 'sandbox' } as NodeJS.ProcessEnv);
    expect(c?.env).toBe('sandbox');
    expect(c?.keyPem).toContain('PRIVATE KEY');
  });
});

describe('PushService APNs routing', () => {
  it('routes ios to APNs (stubbed http2 session) and android to FCM; payload stays sealed', async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const session: ApnsSession = { request: async (headers, body) => { calls.push({ headers, body }); return { status: 200, body: '' }; }, close: () => {} };
    const fcm: string[] = [];
    const svc = new PushService({
      listPushDevices: () => [iosDevice(), androidDevice()],
      getBotPref: () => 'all',
      sendFcm: async (t) => { fcm.push(t); },
      apnsConfig: cfg,
      apnsSessionFactory: () => session,
    });
    const r = await svc.notify({ kind: 'needsInput', botId: 'b1', botName: 'Scout', title: 'T', body: 'secret body' });
    expect(r).toEqual({ attempted: 2, sent: 2 });
    expect(fcm).toEqual(['fcm-token-xyz']);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers[':path']).toBe('/3/device/apns-token-abc');
    expect(calls[0].headers['apns-topic']).toBe('com.kriyadot.app');
    expect(calls[0].headers['apns-push-type']).toBe('alert');
    expect(calls[0].headers.authorization).toMatch(/^bearer eyJ/);
    expect(calls[0].body).not.toContain('secret body');
    const parsed = JSON.parse(calls[0].body) as { sealed?: string; aps: { alert: { title: string } } };
    expect(parsed.sealed).toBeTruthy();
    expect(parsed.aps.alert.title).toBe('KriyaDot');
  });

  it('is an unconfigured no-op for ios-only devices without APNs config', async () => {
    const logs: string[] = [];
    const svc = new PushService({ listPushDevices: () => [iosDevice()], getBotPref: () => 'all', apnsConfig: null, log: (m) => logs.push(m) });
    expect(svc.apnsEnabled).toBe(false);
    await expect(svc.notify({ kind: 'done', botId: 'b', botName: 'S', title: 't', body: 'b' })).resolves.toEqual({ attempted: 0, sent: 0 });
    expect(logs.join(' ')).toContain('APNs not configured');
  });

  it('maps APNs 410 to token pruning', async () => {
    const pruned: string[] = [];
    const session: ApnsSession = { request: async () => ({ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }), close: () => {} };
    const svc = new PushService({
      listPushDevices: () => [iosDevice()], getBotPref: () => 'all', apnsConfig: cfg,
      apnsSessionFactory: () => session, onTokenPruned: (d, reason) => pruned.push(`${d.deviceId}:${reason}`),
    });
    const r = await svc.notify({ kind: 'done', botId: 'b', botName: 'S', title: 't', body: 'b' });
    expect(r).toEqual({ attempted: 1, sent: 0 });
    expect(pruned).toEqual(['ios1:Unregistered']);
    expect(new ApnsError(410).tokenInvalid).toBe(true);
    expect(new ApnsError(400, 'BadDeviceToken').tokenInvalid).toBe(true);
    expect(new ApnsError(403, 'InvalidProviderToken').tokenInvalid).toBe(false);
  });
});

describe('CompanionStore platform registry', () => {
  it('setPushToken records platform and listPushDevices routes it; clearPushToken prunes', () => {
    const store = new CompanionStore(mkdtempSync(join(tmpdir(), 'push-apns-')));
    const rec = store.requestPairingOTT();
    const res = store.exchangePairing({ ott: rec.ott, deviceName: 'iPhone', platform: 'ios' });
    if (!res.ok) throw new Error('pair failed');
    expect(store.setPushToken(res.deviceId, 'apns-token-123456', 'ios')).toBe(true);
    const devices = store.listPushDevices();
    expect(devices[0].platform).toBe('ios');
    expect(store.clearPushToken(res.deviceId)).toBe(true);
    expect(store.listPushDevices()).toHaveLength(0);
  });
});
