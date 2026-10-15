// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompanionHub, CompanionStore, type CompanionSocket } from '../src/companion.js';
import {
  buildHostedQrPayload,
  buildPairingPayload,
  buildQrPayload,
  getLanIp,
  pairingMode,
  registerCompanionRoutes,
  type ApprovalView,
  type CompanionRouteDeps,
} from '../src/companion-routes.js';
import { BriefingStore } from '../src/briefing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return new CompanionStore(mkdtempSync(join(tmpdir(), 'companion-')));
}

interface AuditRec {
  action: string;
  fields: Record<string, unknown>;
}

/** In-process mock of the WebSocket transport (no network). */
class MockSocket implements CompanionSocket {
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
  allJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function pairDevice(store: CompanionStore, name = 'Pixel'): { deviceId: string; token: string } {
  const rec = store.requestPairingOTT();
  const res = store.exchangePairing({ ott: rec.ott, deviceName: name, platform: 'android' });
  if (!res.ok) throw new Error('pairing failed in test setup');
  return { deviceId: res.deviceId, token: res.token };
}

// ---------------------------------------------------------------------------
// Store: pairing handshake
// ---------------------------------------------------------------------------

describe('CompanionStore pairing', () => {
  let store: CompanionStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('request OTT → exchange succeeds and yields a 256-bit token', () => {
    const rec = store.requestPairingOTT();
    expect(rec.ott).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.expiresAt).toBeGreaterThan(Date.now());
    const res = store.exchangePairing({ ott: rec.ott, deviceName: 'Pixel', platform: 'android' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.token).toMatch(/^[0-9a-f]{64}$/);
      expect(res.deviceId.startsWith('comp_')).toBe(true);
      expect(store.findDeviceByToken(res.token)?.id).toBe(res.deviceId);
      expect(store.findDeviceByToken('wrong')).toBeUndefined();
    }
  });

  it('stores only the token hash, never the raw token', () => {
    const { deviceId, token } = pairDevice(store);
    const dev = store.getDevice(deviceId);
    expect(dev?.tokenHash).toBeDefined();
    expect(dev?.tokenHash).not.toContain(token);
    const listed = store.listDevices().find((d) => d.id === deviceId);
    expect(listed).toBeDefined();
    expect('tokenHash' in (listed as object)).toBe(false);
  });

  it('enforces OTT single-use', () => {
    const rec = store.requestPairingOTT();
    const first = store.exchangePairing({ ott: rec.ott, deviceName: 'x', platform: 'android' });
    expect(first.ok).toBe(true);
    const second = store.exchangePairing({ ott: rec.ott, deviceName: 'x', platform: 'android' });
    expect(second).toEqual({ ok: false, error: 'invalid_ott' });
  });

  it('rejects unknown and malformed OTTs', () => {
    expect(store.exchangePairing({ ott: '0'.repeat(32), deviceName: 'x', platform: 'android' })).toEqual({
      ok: false,
      error: 'invalid_ott',
    });
    for (const ott of ['123456', 'zzzz', '', '0'.repeat(31), '0'.repeat(33), 42, null]) {
      expect(store.exchangePairing({ ott, deviceName: 'x', platform: 'android' })).toEqual({
        ok: false,
        error: 'invalid_ott',
      });
    }
  });

  it('rejects expired OTTs', () => {
    const rec = store.requestPairingOTT(-1); // already expired
    expect(store.exchangePairing({ ott: rec.ott, deviceName: 'x', platform: 'android' })).toEqual({
      ok: false,
      error: 'expired_ott',
    });
  });

  it('revoke removes the device and its token', () => {
    const { deviceId, token } = pairDevice(store);
    expect(store.revoke(deviceId)).toBe(true);
    expect(store.findDeviceByToken(token)).toBeUndefined();
    expect(store.revoke(deviceId)).toBe(false);
    expect(store.revoke('../../etc')).toBe(false);
  });

  it('rate-limits pairing attempts per IP', () => {
    const ip = '10.0.0.9';
    for (let i = 0; i < 10; i++) expect(store.rateLimiter.allow(ip)).toBe(true);
    expect(store.rateLimiter.allow(ip)).toBe(false);
  });

  it('tracks session pause marks', () => {
    expect(store.isSessionPaused('s1')).toBe(false);
    store.pauseSession('s1');
    expect(store.isSessionPaused('s1')).toBe(true);
    expect(store.listPausedSessions()).toEqual(['s1']);
    expect(store.resumeSession('s1')).toBe(true);
    expect(store.resumeSession('s1')).toBe(false);
    expect(store.isSessionPaused('s1')).toBe(false);
  });
});

describe('QR payload', () => {
  it('builds the kriyadot://pair payload the app parses', () => {
    expect(buildQrPayload('192.168.1.10', 4567, 'a'.repeat(32))).toBe(
      `kriyadot://pair?host=192.168.1.10&port=4567&token=${'a'.repeat(32)}`,
    );
  });

  it('getLanIp returns an IPv4 address', () => {
    expect(getLanIp()).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });
});

describe('QR payload flavors (LAN vs hosted)', () => {
  it('buildHostedQrPayload encodes the public URL', () => {
    expect(buildHostedQrPayload('https://kriyadot.example.com', 'a'.repeat(32))).toBe(
      `kriyadot://pair?url=https%3A%2F%2Fkriyadot.example.com&token=${'a'.repeat(32)}`,
    );
  });

  it('pairingMode is hosted when publicBaseUrl is set, lan otherwise', () => {
    expect(pairingMode({ publicBaseUrl: 'https://x.example.com' })).toBe('hosted');
    expect(pairingMode({})).toBe('lan');
    expect(pairingMode({ publicBaseUrl: '' })).toBe('lan');
  });

  it('buildPairingPayload selects the hosted flavor and label', () => {
    const p = buildPairingPayload(
      { publicBaseUrl: 'https://kriyadot.example.com', lanIp: '192.168.1.10', port: 4567 },
      'b'.repeat(32),
    );
    expect(p.mode).toBe('hosted');
    expect(p.qrPayload).toBe(`kriyadot://pair?url=https%3A%2F%2Fkriyadot.example.com&token=${'b'.repeat(32)}`);
    expect(p.serverLabel).toBe('https://kriyadot.example.com');
  });

  it('buildPairingPayload falls back to the LAN flavor', () => {
    const p = buildPairingPayload({ lanIp: '192.168.1.10', port: 4567 }, 'b'.repeat(32));
    expect(p.mode).toBe('lan');
    expect(p.qrPayload).toBe(`kriyadot://pair?host=192.168.1.10&port=4567&token=${'b'.repeat(32)}`);
    expect(p.serverLabel).toBe('192.168.1.10:4567');
  });
});

// ---------------------------------------------------------------------------
// Hub: auth + pushes (in-process mock sockets)
// ---------------------------------------------------------------------------

describe('CompanionHub', () => {
  let store: CompanionStore;
  let hub: CompanionHub;
  let audits: AuditRec[];
  let deviceId: string;
  let token: string;

  beforeEach(() => {
    store = makeStore();
    audits = [];
    hub = new CompanionHub(store, (action, fields) => audits.push({ action, fields }), {
      heartbeatMs: 0, // deterministic tests
      snapshot: () => ({ pendingApprovals: 3 }),
    });
    const paired = pairDevice(store);
    deviceId = paired.deviceId;
    token = paired.token;
    expect(token).toBeTruthy();
  });

  const device = () => {
    const d = store.getDevice(deviceId);
    if (!d) throw new Error('device missing');
    return { id: d.id, name: d.name, platform: d.platform, pairedAt: d.pairedAt, lastSeen: d.lastSeen };
  };

  it('requires hello as the first message, then acks with a snapshot', () => {
    const sock = new MockSocket();
    hub.acceptSocket(sock, '127.0.0.1', device());
    sock.clientSend({ t: 'ping' });
    expect(sock.lastJson()).toEqual(expect.objectContaining({ type: 'error', detail: 'hello_required' }));
    sock.clientSend({ t: 'hello', deviceId });
    const ack = sock.lastJson();
    expect(ack).toEqual(
      expect.objectContaining({ type: 'hello', ok: true, deviceId, snapshot: { pendingApprovals: 3 } }),
    );
    expect(audits.some((a) => a.action === 'companion.ws_connected')).toBe(true);
    // malformed JSON and unknown types get errors, not crashes
    sock.clientSend('{nope');
    expect(sock.lastJson().type).toBe('error');
    sock.clientSend({ t: 'bogus' });
    expect(sock.lastJson().type).toBe('error');
    // ping → pong
    sock.clientSend({ t: 'ping', ts: 42 });
    expect(sock.lastJson()).toEqual(expect.objectContaining({ type: 'pong', ts: 42 }));
  });

  it('broadcasts pushes to every connected phone', () => {
    const a = new MockSocket();
    const b = new MockSocket();
    hub.acceptSocket(a, '127.0.0.1', device());
    hub.acceptSocket(b, '127.0.0.1', device());
    a.clientSend({ t: 'hello' });
    b.clientSend({ t: 'hello' });
    hub.broadcast({ type: 'run-status', run: { id: 'r1', state: 'running' } });
    for (const s of [a, b]) {
      const last = s.lastJson();
      expect(last.type).toBe('run-status');
      expect((last.run as Record<string, unknown>).id).toBe('r1');
    }
    expect(hub.connectionCount()).toBe(2);
  });

  it('pushToDevice targets one device and dropDevice closes it', () => {
    const other = pairDevice(store, 'Other');
    const otherDev = store.getDevice(other.deviceId);
    if (!otherDev) throw new Error('other device missing');
    const a = new MockSocket();
    const b = new MockSocket();
    hub.acceptSocket(a, '127.0.0.1', device());
    hub.acceptSocket(b, '127.0.0.1', {
      id: otherDev.id,
      name: otherDev.name,
      platform: otherDev.platform,
      pairedAt: otherDev.pairedAt,
      lastSeen: otherDev.lastSeen,
    });
    a.clientSend({ t: 'hello' });
    b.clientSend({ t: 'hello' });
    expect(hub.pushToDevice(deviceId, { type: 'activity', summary: 'x' })).toBe(true);
    expect(a.lastJson().type).toBe('activity');
    expect(b.lastJson().type).toBe('hello'); // untouched
    expect(hub.pushToDevice('comp_nonexistent', { type: 'activity', summary: 'x' })).toBe(false);

    expect(hub.isConnected(deviceId)).toBe(true);
    expect(hub.dropDevice(deviceId)).toBe(true);
    expect(a.closedWith).toBe(1000);
    expect(b.closedWith).toBeNull();
    expect(hub.isConnected(deviceId)).toBe(false);
    expect(hub.dropDevice(deviceId)).toBe(false);
  });

  it('audits disconnects', () => {
    const sock = new MockSocket();
    hub.acceptSocket(sock, '127.0.0.1', device());
    sock.close();
    expect(audits.some((a) => a.action === 'companion.ws_disconnected')).toBe(true);
    expect(hub.connectionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REST routes (real express app on an ephemeral port)
// ---------------------------------------------------------------------------

function makeApproval(id: string, status = 'pending'): ApprovalView {
  return {
    id,
    ts: 1728400000000,
    sessionId: 'sess-1',
    botId: 'bot-1',
    actor: 'agent',
    toolName: 'run_command',
    args: { command: 'ls -la' },
    status,
  };
}

interface RouteTestCtx {
  base: string;
  dataDir: string;
  store: CompanionStore;
  hub: CompanionHub;
  audits: AuditRec[];
  governance: {
    approvals: Map<string, ApprovalView>;
    listApprovals(status?: string): ApprovalView[];
    getApproval(id: string): ApprovalView | undefined;
    decide(id: string, decision: 'approved' | 'denied', opts?: { note?: string; decidedBy?: string }): ApprovalView;
    listAudit(limit: number): Array<{ id: number; ts: number; action: string; actor: string }>;
  };
  runControls: {
    turns: Array<{ sessionId: string; botId: string; startedAt: number }>;
    aborted: string[];
    activeTurns(): Array<{ sessionId: string; botId: string; startedAt: number }>;
    abortTurn(sessionId: string): boolean;
  };
  queue: {
    items: Array<{ id: string; sessionId: string; botId: string; message: string; status: string; createdAt: number }>;
    removed: string[];
  };
  omniItems: Array<{ id: string; title: string; kind: string; createdAt: number }>;
  workflowRuns: Array<{ id: string; workflowId: string; status: string }>;
  close: () => Promise<void>;
  authHeader: (token: string) => Record<string, string>;
}

async function makeRouteCtx(overrides: Partial<CompanionRouteDeps> = {}): Promise<RouteTestCtx> {
  const dataDir = mkdtempSync(join(tmpdir(), 'companion-routes-'));
  const store = new CompanionStore(dataDir);
  const audits: AuditRec[] = [];
  const hub = new CompanionHub(store, (action, fields) => audits.push({ action, fields }), { heartbeatMs: 0 });
  const approvals = new Map<string, ApprovalView>();
  const governance = {
    approvals,
    listApprovals(status?: string): ApprovalView[] {
      const all = [...approvals.values()];
      return status ? all.filter((a) => a.status === status) : all;
    },
    getApproval(id: string): ApprovalView | undefined {
      return approvals.get(id);
    },
    decide(id: string, decision: 'approved' | 'denied', opts?: { note?: string; decidedBy?: string }): ApprovalView {
      const a = approvals.get(id);
      if (!a) throw new Error(`approval not found: ${id}`);
      if (a.status !== 'pending') throw new Error(`approval ${id} is ${a.status}`);
      const updated = { ...a, status: decision, decidedAt: Date.now(), decidedBy: opts?.decidedBy, note: opts?.note };
      approvals.set(id, updated);
      return updated;
    },
    listAudit(limit: number) {
      return [{ id: 1, ts: 1728400000000, action: 'tool.executed', actor: 'agent' }].slice(0, limit);
    },
  };
  const runControls = {
    turns: [] as Array<{ sessionId: string; botId: string; startedAt: number }>,
    aborted: [] as string[],
    activeTurns() {
      return this.turns;
    },
    abortTurn(sessionId: string) {
      const found = this.turns.some((t) => t.sessionId === sessionId);
      if (found) this.aborted.push(sessionId);
      return found;
    },
  };
  const queue = {
    items: [] as Array<{
      id: string;
      sessionId: string;
      botId: string;
      message: string;
      status: string;
      createdAt: number;
    }>,
    removed: [] as string[],
  };
  const omniItems: Array<{ id: string; title: string; kind: string; createdAt: number }> = [];
  const workflowRuns: Array<{ id: string; workflowId: string; status: string }> = [];

  const deps: CompanionRouteDeps = {
    store,
    hub,
    audit: (action, fields) => audits.push({ action, fields }),
    lanIp: '192.168.1.10',
    port: 4567,
    version: '0.1.0',
    localChatUrl: 'http://127.0.0.1:1/api/chat',
    governance,
    idResolver: { resolveApprovalId: (id: string) => id },
    workflowRunner: {
      listRuns: () => workflowRuns,
      getRun: (id: string) => workflowRuns.find((r) => r.id === id),
    },
    chatQueueStore: {
      list: () => queue.items,
      remove: (id: string) => {
        const i = queue.items.findIndex((q) => q.id === id);
        if (i < 0) return false;
        queue.items.splice(i, 1);
        queue.removed.push(id);
        return true;
      },
    },
    omniStore: { listItems: () => omniItems },
    dataDir,
    runControls,
    ...overrides,
  } as CompanionRouteDeps;

  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerCompanionRoutes(router, deps);
  app.use('/api/companion', router);

  let server: http.Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    dataDir,
    store,
    hub,
    audits,
    governance,
    runControls,
    queue,
    omniItems,
    workflowRuns,
    close: () =>
      new Promise<void>((resolve, reject) => {
        hub.close();
        server!.close((e) => (e ? reject(e) : resolve()));
      }),
    authHeader: (token: string) => ({ Authorization: `Bearer ${token}` }),
  };
}

describe('companion REST routes', () => {
  let ctx: RouteTestCtx;
  beforeEach(async () => {
    ctx = await makeRouteCtx();
  });

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${ctx.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${ctx.base}${path}`, { headers });
  const del = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${ctx.base}${path}`, { method: 'DELETE', headers });

  const authed = async () => {
    const rec = ctx.store.requestPairingOTT();
    const res = ctx.store.exchangePairing({ ott: rec.ott, deviceName: 'Test', platform: 'android' });
    if (!res.ok) throw new Error('pairing failed');
    return ctx.authHeader(res.token);
  };

  it('pairing: code → qrPayload → exchange → single-use', async () => {
    const codeRes = await post('/api/companion/pairing/code');
    expect(codeRes.status).toBe(200);
    const { ott, qrPayload, expiresAt } = (await codeRes.json()) as {
      ott: string;
      qrPayload: string;
      expiresAt: number;
    };
    expect(qrPayload).toBe(`kriyadot://pair?host=192.168.1.10&port=4567&token=${ott}`);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const qrRes = await get('/api/companion/pairing/qr');
    expect(qrRes.status).toBe(200);
    expect(((await qrRes.json()) as { qrPayload: string }).qrPayload.startsWith('kriyadot://pair?')).toBe(true);

    const ex = await post('/api/companion/pairing/exchange', { ott, deviceName: 'Pixel 8' });
    expect(ex.status).toBe(200);
    const { deviceToken, deviceId } = (await ex.json()) as { deviceToken: string; deviceId: string };
    expect(deviceToken).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceId.startsWith('comp_')).toBe(true);
    expect(ctx.audits.some((a) => a.action === 'companion.paired')).toBe(true);

    // OTT is single-use.
    const again = await post('/api/companion/pairing/exchange', { ott, deviceName: 'Pixel 8' });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe('invalid_ott');

    // Bad shape.
    const bad = await post('/api/companion/pairing/exchange', { ott: 'nope', deviceName: 'x' });
    expect(bad.status).toBe(400);
  });

  it('rate-limits pairing exchange at the HTTP layer', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await post('/api/companion/pairing/exchange', { ott: '0'.repeat(32), deviceName: 'x' });
      expect(r.status).toBe(400);
    }
    const limited = await post('/api/companion/pairing/exchange', { ott: '0'.repeat(32), deviceName: 'x' });
    expect(limited.status).toBe(429);
    expect(ctx.audits.some((a) => a.action === 'companion.pair_rate_limited')).toBe(true);
  });

  it('requires a device token on protected routes (401)', async () => {
    for (const [method, path] of [
      ['GET', '/api/companion/devices'],
      ['GET', '/api/companion/status'],
      ['GET', '/api/companion/runs'],
      ['GET', '/api/companion/approvals'],
      ['GET', '/api/companion/activity'],
      ['GET', '/api/companion/briefing'],
    ] as Array<['GET', string]>) {
      const r = method === 'GET' ? await get(path) : await post(path);
      expect(r.status).toBe(401);
    }
    const bad = await get('/api/companion/status', ctx.authHeader('bogus'));
    expect(bad.status).toBe(401);
    expect(ctx.audits.some((a) => a.action === 'companion.auth_failed')).toBe(true);
    // Pairing entry points stay open.
    expect((await post('/api/companion/pairing/code')).status).toBe(200);
  });

  it('devices list hides token hashes; revoke drops WS and invalidates the token', async () => {
    const headers = await authed();
    const sock = new MockSocket();
    const dev = ctx.store.listDevices()[0];
    const full = ctx.store.getDevice(dev.id);
    if (!full) throw new Error('device missing');
    ctx.hub.acceptSocket(sock, '127.0.0.1', {
      id: full.id,
      name: full.name,
      platform: full.platform,
      pairedAt: full.pairedAt,
      lastSeen: full.lastSeen,
    });
    expect(ctx.hub.isConnected(dev.id)).toBe(true);

    const list = (await (await get('/api/companion/devices', headers)).json()) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).not.toHaveProperty('tokenHash');
    expect(list.devices[0].online).toBe(true);

    const delRes = await del(`/api/companion/devices/${dev.id}`, headers);
    expect(delRes.status).toBe(200);
    expect(sock.closedWith).toBe(1000); // live push socket dropped
    expect(ctx.audits.some((a) => a.action === 'companion.unpaired')).toBe(true);

    // Token no longer works.
    expect((await get('/api/companion/devices', headers)).status).toBe(401);
    // Unknown device → 404 (with a still-valid token of a second device).
    const headers2 = await authed();
    expect((await del('/api/companion/devices/comp_nope', headers2)).status).toBe(404);
  });

  it('status reports runs and pending approvals', async () => {
    const headers = await authed();
    ctx.governance.approvals.set('a1', makeApproval('a1'));
    ctx.governance.approvals.set('a2', makeApproval('a2'));
    ctx.runControls.turns.push({ sessionId: 'sess-1', botId: 'bot-1', startedAt: Date.now() });
    const r = await get('/api/companion/status', headers);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      server: { name: string; version: string };
      activeRuns: number;
      pendingApprovals: number;
      runs: Array<{ id: string; kind: string; state: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.server).toEqual({ name: 'KriyaDot', version: '0.1.0' });
    expect(body.activeRuns).toBe(1);
    expect(body.pendingApprovals).toBe(2);
    expect(body.runs[0]).toEqual(expect.objectContaining({ id: 'sess-1', kind: 'chat-turn', state: 'running' }));
  });

  it('approvals: list, approve, deny, 404, 409', async () => {
    const headers = await authed();
    ctx.governance.approvals.set('a1', makeApproval('a1'));
    ctx.governance.approvals.set('a2', makeApproval('a2'));

    const list = (await (await get('/api/companion/approvals', headers)).json()) as {
      approvals: Array<{ id: string; title: string; detail: string; sessionId: string; createdAt: string }>;
    };
    expect(list.approvals).toHaveLength(2);
    expect(list.approvals[0].title).toContain('Run command');
    expect(list.approvals[0].detail).toContain('ls -la');

    // A connected phone gets the decision push.
    const sock = new MockSocket();
    const dev = ctx.store.listDevices()[0];
    ctx.hub.acceptSocket(sock, '127.0.0.1', { ...dev });
    sock.clientSend({ t: 'hello' });

    const approve = await post('/api/companion/approvals/a1/approve', { note: 'looks fine' }, headers);
    expect(approve.status).toBe(200);
    expect(ctx.governance.approvals.get('a1')?.status).toBe('approved');
    expect(ctx.audits.some((a) => a.action === 'companion.approval_decided')).toBe(true);
    const push = sock.lastJson();
    expect(push.type).toBe('approval');
    expect(push.event).toBe('decided');

    const deny = await post('/api/companion/approvals/a2/deny', {}, headers);
    expect(deny.status).toBe(200);
    expect(ctx.governance.approvals.get('a2')?.status).toBe('denied');

    expect((await post('/api/companion/approvals/nope/approve', {}, headers)).status).toBe(404);
    expect((await post('/api/companion/approvals/a1/approve', {}, headers)).status).toBe(409);
  });

  it('run controls: cancel aborts the turn; pause/resume mark the session', async () => {
    const headers = await authed();
    ctx.runControls.turns.push({ sessionId: 'sess-1', botId: 'bot-1', startedAt: Date.now() });

    const cancel = await post('/api/companion/runs/sess-1/cancel', {}, headers);
    expect(cancel.status).toBe(200);
    expect(ctx.runControls.aborted).toEqual(['sess-1']);
    expect(ctx.audits.some((a) => a.action === 'companion.run_cancelled')).toBe(true);

    expect((await post('/api/companion/runs/nope/cancel', {}, headers)).status).toBe(404);

    // pause (no active turn now) → session mark; runs list shows paused
    const pause = await post('/api/companion/runs/sess-1/pause', {}, headers);
    expect(pause.status).toBe(200);
    expect(ctx.store.isSessionPaused('sess-1')).toBe(true);
    const runs = (await (await get('/api/companion/runs', headers)).json()) as {
      runs: Array<{ id: string; state: string }>;
    };
    expect(runs.runs.find((r) => r.id === 'sess-1')?.state).toBe('paused');

    const resume = await post('/api/companion/runs/sess-1/resume', {}, headers);
    expect(resume.status).toBe(200);
    expect(ctx.store.isSessionPaused('sess-1')).toBe(false);
    expect(ctx.audits.some((a) => a.action === 'companion.run_paused')).toBe(true);
    expect(ctx.audits.some((a) => a.action === 'companion.run_resumed')).toBe(true);
  });

  it('run controls: queued messages cancel via dequeue; workflow runs are read-only', async () => {
    const headers = await authed();
    ctx.queue.items.push({
      id: 'q1',
      sessionId: 'sess-9',
      botId: 'bot-1',
      message: 'hello there',
      status: 'queued',
      createdAt: Date.now(),
    });
    ctx.workflowRuns.push({ id: 'wf-1', workflowId: 'daily', status: 'running' });

    const runs = (await (await get('/api/companion/runs', headers)).json()) as {
      runs: Array<{ id: string; kind: string; state: string }>;
    };
    expect(runs.runs.find((r) => r.id === 'q1')).toEqual(
      expect.objectContaining({ kind: 'queued-message', state: 'queued' }),
    );
    expect(runs.runs.find((r) => r.id === 'wf-1')).toEqual(
      expect.objectContaining({ kind: 'workflow-run', state: 'running' }),
    );

    ctx.queue.items.push({
      id: 'q2',
      sessionId: 'sess-8',
      botId: 'bot-1',
      message: 'second in line',
      status: 'queued',
      createdAt: Date.now(),
    });
    const cancelQ = await post('/api/companion/runs/q1/cancel', {}, headers);
    expect(cancelQ.status).toBe(200);
    expect(ctx.queue.removed).toEqual(['q1']);

    for (const op of ['pause', 'resume', 'cancel']) {
      const r = await post(`/api/companion/runs/wf-1/${op}`, {}, headers);
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe('not_supported');
    }
    expect((await post('/api/companion/runs/q2/pause', {}, headers)).status).toBe(409);
  });

  it('activity prefers omni recent, falls back to the audit feed', async () => {
    const headers = await authed();
    ctx.omniItems.push({ id: 'o1', title: 'Approval decided', kind: 'approval', createdAt: 1728400000000 });
    const omni = (await (await get('/api/companion/activity', headers)).json()) as {
      source: string;
      activity: Array<{ text: string; kind: string }>;
    };
    expect(omni.source).toBe('omni');
    expect(omni.activity[0]).toEqual(expect.objectContaining({ text: 'Approval decided', kind: 'approval' }));

    ctx.omniItems.length = 0;
    const audit = (await (await get('/api/companion/activity?limit=5', headers)).json()) as {
      source: string;
      activity: Array<{ text: string }>;
    };
    expect(audit.source).toBe('audit');
    expect(audit.activity[0].text).toContain('tool.executed');
  });

  it('briefing returns the latest briefing, 404 when none exists', async () => {
    const headers = await authed();
    expect((await get('/api/companion/briefing', headers)).status).toBe(404);

    // Seed through the same dataDir the companion routes use.
    const bs = new BriefingStore(ctx.dataDir);
    const now = Date.now();
    bs.saveBriefing('manual', {
      generatedAt: now,
      overnight: [{ title: 'Overnight item' }],
      calendar: [],
      approvals: [],
      summary: 'Test summary',
    });

    const r = await get('/api/companion/briefing', headers);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { briefing: { title: string; body: string; generatedAt: string } };
    expect(body.briefing.title).toBe('Daily briefing');
    expect(body.briefing.body).toBe('Test summary');
    expect(body.briefing.generatedAt).toBe(new Date(now).toISOString());
  });

  it('chat/send proxies to the local chat endpoint and requires fields', async () => {
    // Tiny stub of the /api/chat SSE endpoint.
    const chatServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"token","content":"hello "}\n\n');
      res.write('data: {"type":"token","content":"world"}\n\n');
      res.write('data: {"type":"done","usage":null}\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => chatServer.listen(0, '127.0.0.1', () => resolve()));
    const chatAddr = chatServer.address() as AddressInfo;
    const chatCtx = await makeRouteCtx({
      localChatUrl: `http://127.0.0.1:${chatAddr.port}/api/chat`,
    });
    try {
      const rec = chatCtx.store.requestPairingOTT();
      const ex = chatCtx.store.exchangePairing({ ott: rec.ott, deviceName: 'T', platform: 'android' });
      if (!ex.ok) throw new Error('pairing failed');
      const headers = chatCtx.authHeader(ex.token);

      const bad = await fetch(`${chatCtx.base}/api/companion/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(bad.status).toBe(400);

      const r = await fetch(`${chatCtx.base}/api/companion/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ botId: 'bot-1', message: 'hi', sessionId: 's1' }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      const text = await r.text();
      expect(text).toContain('"type":"token"');
      expect(text).toContain('"type":"done"');
      expect(chatCtx.audits.some((a) => a.action === 'companion.chat_send')).toBe(true);

      // No token → 401, nothing proxied.
      const unauth = await fetch(`${chatCtx.base}/api/companion/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'bot-1', message: 'hi' }),
      });
      expect(unauth.status).toBe(401);
    } finally {
      await chatCtx.close();
      await new Promise<void>((resolve, reject) => chatServer.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

// ---------------------------------------------------------------------------
// Hosted mode: KRIYADOT_PUBLIC_URL pairing over the internet
// ---------------------------------------------------------------------------

describe('companion hosted mode (publicBaseUrl)', () => {
  let ctx: RouteTestCtx;
  const PUBLIC = 'https://kriyadot.example.com';

  beforeEach(async () => {
    ctx = await makeRouteCtx({ publicBaseUrl: PUBLIC });
  });

  afterEach(async () => {
    await ctx.close();
  });

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${ctx.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${ctx.base}${path}`, { headers });

  it('pairing/code and pairing/qr encode the public URL with mode=hosted', async () => {
    const codeRes = await post('/api/companion/pairing/code');
    expect(codeRes.status).toBe(200);
    const code = (await codeRes.json()) as {
      ott: string;
      qrPayload: string;
      expiresAt: number;
      mode: string;
      serverLabel: string;
    };
    expect(code.mode).toBe('hosted');
    expect(code.serverLabel).toBe(PUBLIC);
    expect(code.qrPayload).toBe(`kriyadot://pair?url=${encodeURIComponent(PUBLIC)}&token=${code.ott}`);
    expect(code.qrPayload).not.toContain('host=');

    const qrRes = await get('/api/companion/pairing/qr');
    expect(qrRes.status).toBe(200);
    const qr = (await qrRes.json()) as { qrPayload: string; mode: string; serverLabel: string };
    expect(qr.mode).toBe('hosted');
    expect(qr.qrPayload.startsWith('kriyadot://pair?url=')).toBe(true);
  });

  it('full pair → exchange → authed API flow works with no LAN assumptions', async () => {
    const codeRes = await post('/api/companion/pairing/code');
    const { ott } = (await codeRes.json()) as { ott: string };
    const ex = await post('/api/companion/pairing/exchange', { ott, deviceName: 'Remote Pixel' });
    expect(ex.status).toBe(200);
    const { deviceToken } = (await ex.json()) as { deviceToken: string };
    const status = await get('/api/companion/status', ctx.authHeader(deviceToken));
    expect(status.status).toBe(200);
    expect(((await status.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('pairing endpoints honor X-Forwarded-For / X-Forwarded-Proto behind a proxy', async () => {
    const fwd = { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' };
    const r = await post('/api/companion/pairing/code', undefined, fwd);
    expect(r.status).toBe(200);
    // Rate limiting keys off the forwarded client IP, not the proxy's.
    for (let i = 0; i < 9; i++) {
      expect((await post('/api/companion/pairing/code', undefined, fwd)).status).toBe(200);
    }
    const limited = await post('/api/companion/pairing/code', undefined, fwd);
    expect(limited.status).toBe(429);
    expect(
      ctx.audits.some(
        (a) =>
          a.action === 'companion.pair_rate_limited' &&
          (a.fields.detail as Record<string, unknown>)?.ip === '203.0.113.9',
      ),
    ).toBe(true);
    // A different client IP is unaffected.
    const other = await post('/api/companion/pairing/code', undefined, {
      'X-Forwarded-For': '203.0.113.10',
    });
    expect(other.status).toBe(200);
  });
});
