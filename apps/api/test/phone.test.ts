// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PhoneSessionHub,
  PhoneStore,
  validateMessage,
  type PhoneSocket,
} from '../src/phone.js';
import { registerPhoneRoutes } from '../src/phone-routes.js';
import { consumeWsTicket, issueWsTicket } from '../src/loopback-auth.js';
import { AdbPhoneProvider, parseAdbDevices, parsePngDims } from '../src/phone-adb.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return new PhoneStore(mkdtempSync(join(tmpdir(), 'phone-')));
}

interface AuditRec {
  action: string;
  fields: Record<string, unknown>;
}

/** In-process mock of the WebSocket transport (no real device, no network). */
class MockSocket implements PhoneSocket {
  sent: string[] = [];
  closedWith: number | null = null;
  private msgCb: ((t: string) => void) | null = null;
  private closeCb: (() => void) | null = null;

  sendText(t: string): void {
    this.sent.push(t);
  }
  close(code = 1000): void {
    if (this.closedWith === null) {
      this.closedWith = code;
      this.closeCb?.();
    }
  }
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  clientSend(obj: unknown): void {
    this.msgCb?.(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  lastJson(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// Pairing handshake
// ---------------------------------------------------------------------------

describe('PhoneStore pairing', () => {
  let store: PhoneStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('request → confirm succeeds and yields a 256-bit token', () => {
    const ch = store.requestPairingCode();
    expect(ch.code).toMatch(/^\d{6}$/);
    expect(ch.expiresAt).toBeGreaterThan(Date.now());
    const res = store.confirmPairing({ code: ch.code, deviceName: 'Pixel', platform: 'android' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.token).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex
      expect(store.verifyToken(res.deviceId, res.token)).toBe(true);
      expect(store.verifyToken(res.deviceId, 'wrong')).toBe(false);
    }
  });

  it('stores only the token hash, never the raw token', () => {
    const ch = store.requestPairingCode();
    const res = store.confirmPairing({ code: ch.code, deviceName: 'Pixel', platform: 'android' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const dev = store.getDevice(res.deviceId);
      expect(dev?.tokenHash).toBeDefined();
      expect(dev?.tokenHash).not.toContain(res.token);
      // Public listing must not leak the hash.
      const listed = store.listDevices().find((d) => d.id === res.deviceId);
      expect(listed).toBeDefined();
      expect('tokenHash' in (listed as object)).toBe(false);
    }
  });

  it('rejects unknown codes and enforces single-use', () => {
    const bad = store.confirmPairing({ code: '000000', deviceName: 'x', platform: 'android' });
    expect(bad).toEqual({ ok: false, error: 'invalid_code' });

    const ch = store.requestPairingCode();
    const first = store.confirmPairing({ code: ch.code, deviceName: 'x', platform: 'android' });
    expect(first.ok).toBe(true);
    const second = store.confirmPairing({ code: ch.code, deviceName: 'x', platform: 'android' });
    expect(second).toEqual({ ok: false, error: 'invalid_code' });
  });

  it('rejects expired codes', () => {
    const ch = store.requestPairingCode(-1); // already expired
    const res = store.confirmPairing({ code: ch.code, deviceName: 'x', platform: 'android' });
    expect(res).toEqual({ ok: false, error: 'expired_code' });
  });

  it('rejects malformed code shapes', () => {
    for (const code of ['12345', '1234567', 'abcdef', '', 123456, null]) {
      const res = store.confirmPairing({ code, deviceName: 'x', platform: 'android' });
      expect(res).toEqual({ ok: false, error: 'invalid_code' });
    }
  });

  it('unpair removes the device and its token', () => {
    const ch = store.requestPairingCode();
    const res = store.confirmPairing({ code: ch.code, deviceName: 'x', platform: 'android' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(store.unpair(res.deviceId)).toBe(true);
      expect(store.verifyToken(res.deviceId, res.token)).toBe(false);
      expect(store.unpair(res.deviceId)).toBe(false);
    }
  });

  it('rate-limits pairing attempts per IP', () => {
    const ip = '10.0.0.9';
    for (let i = 0; i < 10; i++) expect(store.rateLimiter.allow(ip)).toBe(true);
    expect(store.rateLimiter.allow(ip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('PhoneStore sessions', () => {
  it('tracks the session lifecycle', () => {
    const store = makeStore();
    const s = store.startSession('phone_abc', 'ws');
    expect(s.endedAt).toBeNull();
    store.bumpSession(s.id, 5, 2);
    const ended = store.endSession(s.id);
    expect(ended?.endedAt).not.toBeNull();
    expect(ended?.frameCount).toBe(5);
    expect(ended?.inputCount).toBe(2);
    const recent = store.recentSessions(10);
    expect(recent.some((r) => r.id === s.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Protocol validation
// ---------------------------------------------------------------------------

describe('validateMessage', () => {
  const good: Array<[string, unknown]> = [
    ['hello', { t: 'hello', deviceId: 'phone_abc', token: 'tok' }],
    ['watch', { t: 'watch', deviceId: 'phone_abc' }],
    ['frame', { t: 'frame', jpg: 'aGVsbG8=', w: 720, h: 1600, ts: 123 }],
    ['tap', { t: 'tap', x: 0.5, y: 0.5 }],
    ['swipe', { t: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, ms: 300 }],
    ['text', { t: 'text', text: 'hello' }],
    ['key', { t: 'key', key: 'back' }],
  ];
  for (const [name, msg] of good) {
    it(`accepts a valid ${name}`, () => {
      const v = validateMessage(msg);
      expect(v.ok).toBe(true);
    });
  }

  const bad: Array<[string, unknown]> = [
    ['not an object', 'nope'],
    ['null', null],
    ['unknown type', { t: 'explode' }],
    ['tap out of range', { t: 'tap', x: 1.5, y: 0.5 }],
    ['tap NaN', { t: 'tap', x: NaN, y: 0.5 }],
    ['tap missing', { t: 'tap', x: 0.5 }],
    ['swipe bad duration', { t: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, ms: 5 }],
    ['swipe huge duration', { t: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, ms: 99999 }],
    ['text too long', { t: 'text', text: 'x'.repeat(1025) }],
    ['text empty', { t: 'text', text: '' }],
    ['text not string', { t: 'text', text: 42 }],
    ['bad key', { t: 'key', key: 'volume_up' }],
    ['frame oversized dims', { t: 'frame', jpg: 'aGVsbG8=', w: 99999, h: 10, ts: 1 }],
    ['frame bad base64', { t: 'frame', jpg: '!!!not-base64!!!', w: 10, h: 10, ts: 1 }],
    ['frame too big', { t: 'frame', jpg: 'a'.repeat(3 * 1024 * 1024 + 1), w: 10, h: 10, ts: 1 }],
    ['hello bad device id', { t: 'hello', deviceId: '../../etc', token: 'tok' }],
    ['hello empty token', { t: 'hello', deviceId: 'phone_abc', token: '' }],
  ];
  for (const [name, msg] of bad) {
    it(`rejects ${name}`, () => {
      const v = validateMessage(msg);
      expect(v.ok).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// WS hub: auth + routing (in-process mock sockets)
// ---------------------------------------------------------------------------

describe('PhoneSessionHub', () => {
  let store: PhoneStore;
  let hub: PhoneSessionHub;
  let audits: AuditRec[];
  let deviceId: string;
  let token: string;

  beforeEach(() => {
    store = makeStore();
    audits = [];
    hub = new PhoneSessionHub(store, (action, fields) => audits.push({ action, fields }));
    const ch = store.requestPairingCode();
    const res = store.confirmPairing({ code: ch.code, deviceName: 'Pixel', platform: 'android' });
    if (!res.ok) throw new Error('pairing failed in test setup');
    deviceId = res.deviceId;
    token = res.token;
  });

  it('rejects a phone with a bad token and closes the socket', () => {
    const sock = new MockSocket();
    hub.acceptSocket(sock, '127.0.0.1');
    sock.clientSend({ t: 'hello', deviceId, token: 'bogus' });
    expect(sock.lastJson().t).toBe('error');
    expect(sock.closedWith).toBe(4401);
    expect(hub.isOnline(deviceId)).toBe(false);
    expect(audits.some((a) => a.action === 'phone.auth_failed')).toBe(true);
  });

  it('rejects unauthenticated first messages', () => {
    const sock = new MockSocket();
    hub.acceptSocket(sock, '127.0.0.1');
    sock.clientSend({ t: 'tap', x: 0.5, y: 0.5 });
    expect(sock.lastJson().t).toBe('error');
    expect(hub.isOnline(deviceId)).toBe(false);
  });

  it('authenticates a phone, relays frames to a watcher, routes input back', () => {
    const phone = new MockSocket();
    hub.acceptSocket(phone, '127.0.0.1');
    phone.clientSend({ t: 'hello', deviceId, token });
    expect(phone.lastJson().t).toBe('ok');
    expect(hub.isOnline(deviceId)).toBe(true);
    expect(audits.some((a) => a.action === 'phone.session_started')).toBe(true);

    const viewer = new MockSocket();
    hub.acceptSocket(viewer, '127.0.0.1');
    viewer.clientSend({ t: 'watch', deviceId, ticket: issueWsTicket() });
    expect(viewer.lastJson().t).toBe('ok');
    expect(viewer.lastJson().online).toBe(true);

    // phone → viewer frame relay
    phone.clientSend({ t: 'frame', jpg: 'aGVsbG8=', w: 720, h: 1600, ts: 42 });
    const relayed = viewer.lastJson();
    expect(relayed.t).toBe('frame');
    expect(relayed.w).toBe(720);

    // viewer → phone input routing
    viewer.clientSend({ t: 'tap', x: 0.25, y: 0.75 });
    const cmd = phone.lastJson();
    expect(cmd).toEqual({ t: 'tap', x: 0.25, y: 0.75 });
    expect(viewer.sent[viewer.sent.length - 1]).toContain('"ok"');

    // malformed message gets an error, not a crash
    viewer.clientSend('{not json');
    expect(viewer.lastJson().t).toBe('error');

    // disconnect ends the session + audits it
    phone.close();
    expect(hub.isOnline(deviceId)).toBe(false);
    const ended = audits.find((a) => a.action === 'phone.session_ended');
    expect(ended).toBeDefined();
    const sessions = store.recentSessions(5);
    const row = sessions.find((s) => s.deviceId === deviceId);
    expect(row?.frameCount).toBe(1);
    expect(row?.inputCount).toBe(1);
    expect(row?.endedAt).not.toBeNull();
  });

  it('does not route input when the device is offline', () => {
    const viewer = new MockSocket();
    hub.acceptSocket(viewer, '127.0.0.1');
    viewer.clientSend({ t: 'watch', deviceId, ticket: issueWsTicket() });
    expect(viewer.lastJson().online).toBe(false);
    viewer.clientSend({ t: 'tap', x: 0.5, y: 0.5 });
    expect(viewer.lastJson()).toEqual({ t: 'error', detail: 'device_offline' });
  });

  it('rejects a watch message without a valid one-time ticket', () => {
    const viewer = new MockSocket();
    hub.acceptSocket(viewer, '127.0.0.1');
    // No ticket at all → validation still passes (ticket optional), auth fails.
    viewer.clientSend({ t: 'watch', deviceId });
    expect(viewer.lastJson().t).toBe('error');
    expect(viewer.lastJson().detail).toBe('auth_failed');
    expect(viewer.closedWith).toBe(4401);
    expect(audits.some((a) => a.action === 'phone.auth_failed')).toBe(true);

    // Bogus ticket → same rejection.
    const viewer2 = new MockSocket();
    hub.acceptSocket(viewer2, '127.0.0.1');
    viewer2.clientSend({ t: 'watch', deviceId, ticket: 'nope' });
    expect(viewer2.closedWith).toBe(4401);

    // A ticket is single-use: reuse fails even though it was valid once.
    const ticket = issueWsTicket();
    const viewer3 = new MockSocket();
    hub.acceptSocket(viewer3, '127.0.0.1');
    viewer3.clientSend({ t: 'watch', deviceId, ticket });
    expect(viewer3.lastJson().t).toBe('ok');
    const viewer4 = new MockSocket();
    hub.acceptSocket(viewer4, '127.0.0.1');
    viewer4.clientSend({ t: 'watch', deviceId, ticket });
    expect(viewer4.closedWith).toBe(4401);
  });

  it('kickDevice force-disconnects a live phone', () => {
    const phone = new MockSocket();
    hub.acceptSocket(phone, '127.0.0.1');
    phone.clientSend({ t: 'hello', deviceId, token });
    expect(hub.isOnline(deviceId)).toBe(true);
    expect(hub.kickDevice(deviceId)).toBe(true);
    expect(phone.closedWith).toBe(1000);
    expect(hub.isOnline(deviceId)).toBe(false);
    expect(hub.kickDevice(deviceId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REST routes (real express app on an ephemeral port)
// ---------------------------------------------------------------------------

describe('phone REST routes', () => {
  let base: string;
  let server: ReturnType<typeof express.application.listen> | { close(cb?: () => void): void };
  let store: PhoneStore;
  let audits: AuditRec[];

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`);
  const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE' });

  beforeEach(async () => {
    store = makeStore();
    audits = [];
    const adb = new AdbPhoneProvider(
      async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 }),
      () => false, // adb absent
    );
    const hub = new PhoneSessionHub(store, (action, fields) => audits.push({ action, fields }));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerPhoneRoutes(router, { store, hub, adb, audit: (a, f) => audits.push({ action: a, fields: f }) });
    app.use('/api/phone', router);
    await new Promise<void>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve());
      server = s as unknown as typeof server;
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  it('pair request → confirm → devices → sessions → unpair', async () => {
    const req = await post('/api/phone/pair/request');
    expect(req.status).toBe(200);
    const { pairingCode } = (await req.json()) as { pairingCode: string };

    const confirm = await post('/api/phone/pair/confirm', { code: pairingCode, deviceName: 'Test', platform: 'android' });
    expect(confirm.status).toBe(200);
    const { deviceId, token } = (await confirm.json()) as { deviceId: string; token: string };
    expect(token).toHaveLength(64);

    const devs = (await (await get('/api/phone/devices')).json()) as {
      devices: Array<{ id: string; token?: string; tokenHash?: string }>;
    };
    const dev = devs.devices.find((d) => d.id === deviceId);
    expect(dev).toBeDefined();
    expect(dev?.token).toBeUndefined();
    expect(dev?.tokenHash).toBeUndefined();

    expect(audits.some((a) => a.action === 'phone.paired')).toBe(true);

    const un = await del(`/api/phone/devices/${deviceId}`);
    expect(un.status).toBe(200);
    expect(audits.some((a) => a.action === 'phone.unpaired')).toBe(true);
  });

  it('rate-limits pair/confirm at the HTTP layer', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await post('/api/phone/pair/confirm', { code: '000000' });
      expect(r.status).toBe(400);
    }
    const limited = await post('/api/phone/pair/confirm', { code: '000000' });
    expect(limited.status).toBe(429);
    expect(audits.some((a) => a.action === 'phone.pair_rate_limited')).toBe(true);
  });

  it('rejects adb endpoints gracefully when adb is absent', async () => {
    const status = (await (await get('/api/phone/adb/status')).json()) as { available: boolean; devices: unknown[] };
    expect(status.available).toBe(false);
    expect(status.devices).toEqual([]);
    const frame = await get('/api/phone/adb/FAKESERIAL/frame');
    expect(frame.status).toBe(502);
  });

  it('lists sessions (empty at first)', async () => {
    const r = (await (await get('/api/phone/sessions')).json()) as { sessions: unknown[] };
    expect(r.sessions).toEqual([]);
  });
});

describe('phone watch-ticket route', () => {
  let base = '';
  let server: { close(cb?: () => void): void } | null = null;

  /** Build the phone router with/without the loopback-auth flag set (index.ts sets it via requireLoopbackAuth). */
  async function boot(authed: boolean) {
    const store = makeStore();
    const adb = new AdbPhoneProvider(
      async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 }),
      () => false, // adb absent
    );
    const hub = new PhoneSessionHub(store, () => {});
    const app = express();
    app.use(express.json());
    if (authed) {
      app.use((req, _res, next) => {
        req.loopbackAuthed = true;
        next();
      });
    }
    const router = express.Router();
    registerPhoneRoutes(router, { store, hub, adb, audit: () => {} });
    app.use('/api/phone', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    base = `http://127.0.0.1:${addr.port}`;
  }

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('401s without the loopback-auth flag (defense in depth behind the global middleware)', async () => {
    await boot(false);
    const r = await fetch(`${base}/api/phone/watch-ticket`, { method: 'POST' });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('issues a unique single-use ticket for authed callers', async () => {
    await boot(true);
    const r1 = await fetch(`${base}/api/phone/watch-ticket`, { method: 'POST' });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { ok: boolean; ticket: string };
    expect(b1.ok).toBe(true);
    expect(typeof b1.ticket).toBe('string');
    expect(b1.ticket.length).toBeGreaterThan(0);
    const r2 = await fetch(`${base}/api/phone/watch-ticket`, { method: 'POST' });
    const b2 = (await r2.json()) as { ticket: string };
    expect(b2.ticket).not.toBe(b1.ticket);
    // The issued ticket is accepted exactly once by the hub.
    expect(consumeWsTicket(b1.ticket)).toBe(true);
    expect(consumeWsTicket(b1.ticket)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADB provider
// ---------------------------------------------------------------------------

function fakePng(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe('AdbPhoneProvider', () => {
  it('degrades gracefully when adb is absent', async () => {
    const adb = new AdbPhoneProvider(
      async () => {
        throw new Error('should not run');
      },
      () => false,
    );
    expect(await adb.isAvailable()).toBe(false);
    expect(await adb.listDevices()).toEqual([]);
    await expect(adb.grabFrame('XYZ')).rejects.toThrow('adb_device_not_found');
    await expect(adb.tap('XYZ', 0.5, 0.5)).rejects.toThrow('adb_device_not_found');
  });

  it('parses `adb devices` output', () => {
    const out = 'List of devices attached\nABC123\tdevice\nDEF456\tunauthorized\n\n';
    expect(parseAdbDevices(out)).toEqual([
      { serial: 'ABC123', state: 'device' },
      { serial: 'DEF456', state: 'unauthorized' },
    ]);
  });

  it('parses PNG dimensions', () => {
    expect(parsePngDims(fakePng(1080, 2400))).toEqual({ w: 1080, h: 2400 });
    expect(parsePngDims(Buffer.from('not a png'))).toBeNull();
  });

  it('validates the serial against the live device list before running adb', async () => {
    const calls: string[][] = [];
    const adb = new AdbPhoneProvider(async (cmd, args) => {
      calls.push([cmd, ...args]);
      const joined = args.join(' ');
      if (joined.includes('devices')) {
        return { stdout: Buffer.from('List of devices attached\nABC123\tdevice\n'), stderr: Buffer.alloc(0), code: 0 };
      }
      if (joined.includes('wm size')) {
        return { stdout: Buffer.from('Physical size: 1080x2400\n'), stderr: Buffer.alloc(0), code: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
    }, () => true);

    await adb.tap('ABC123', 0.5, 0.25);
    const tapCall = calls.find((c) => c.includes('tap'));
    expect(tapCall).toBeDefined();
    // 0.5*1080=540, 0.25*2400=600
    expect(tapCall?.slice(-2)).toEqual(['540', '600']);

    // serial not in `adb devices` → never runs
    const before = calls.length;
    await expect(adb.tap('EVIL; rm -rf /', 0.5, 0.5)).rejects.toThrow('adb_device_not_found');
    await expect(adb.tap('NOTATTACHED', 0.5, 0.5)).rejects.toThrow('adb_device_not_found');
    expect(calls.length).toBeLessThanOrEqual(before + 2); // only the `devices` probes
  });

  it('rejects oversized text and unsafe key names', async () => {
    const adb = new AdbPhoneProvider(async (cmd, args) => {
      if (args.includes('devices')) {
        return { stdout: Buffer.from('List of devices attached\nABC123\tdevice\n'), stderr: Buffer.alloc(0), code: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
    }, () => true);
    await expect(adb.text('ABC123', 'x'.repeat(1025))).rejects.toThrow('adb_bad_text');
    // @ts-expect-error testing invalid key at runtime
    await expect(adb.key('ABC123', 'volume_up')).rejects.toThrow('adb_bad_key');
  });
});
