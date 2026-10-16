// SPDX-License-Identifier: Apache-2.0
// Tests for remote screen viewing (apps/api/src/remote-screen.ts +
// remote-screen-routes.ts). Zero native deps: capture is always injected,
// governance is stubbed, viewer sockets are in-process fakes.

import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RemoteScreenService,
  pngDimensions,
  REMOTE_SCREEN_TOOL,
  type CapturedFrame,
  type RemoteScreenDeps,
} from '../src/remote-screen.js';
import { createRemoteScreenRouter, createRemoteScreenUpgrade } from '../src/remote-screen-routes.js';
import type { ViewerSocket } from '../src/computer-view.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ApprovalCall {
  toolName: string;
  args: Record<string, unknown>;
  ctx: { sessionId: string; botId: string; actor: string };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeGovernance(): {
  approvals: ApprovalCall[];
  pending: Map<string, ReturnType<typeof deferred<'approved' | 'denied'>>>;
  requestApproval: RemoteScreenDeps['requestApproval'];
  awaitDecision: RemoteScreenDeps['awaitDecision'];
} {
  const approvals: ApprovalCall[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<'approved' | 'denied'>>>();
  let n = 0;
  return {
    approvals,
    pending,
    requestApproval: (toolName, args, ctx) => {
      const id = `appr-${++n}`;
      approvals.push({ toolName, args, ctx });
      pending.set(id, deferred<'approved' | 'denied'>());
      return id;
    },
    awaitDecision: (approvalId, _timeoutMs) => {
      const d = pending.get(approvalId);
      if (!d) return Promise.reject(new Error('unknown approval'));
      return d.promise;
    },
  };
}

function makeService(
  gov: ReturnType<typeof makeGovernance>,
  opts: Partial<RemoteScreenDeps> = {},
): { service: RemoteScreenService; audits: Array<{ action: string; fields: Record<string, unknown> }> } {
  const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
  const frame: CapturedFrame = { png: Buffer.from([0x89, 0x50, 0x4e, 0x47]), w: 320, h: 200 };
  const service = new RemoteScreenService({
    captureFrame: async () => ({ ...frame }),
    requestApproval: gov.requestApproval,
    awaitDecision: gov.awaitDecision,
    audit: (action, fields) => audits.push({ action, fields }),
    fps: 50,
    maxDurationMs: 60_000,
    approvalTimeoutMs: 5_000,
    ...opts,
  });
  return { service, audits };
}

function fakeViewer(): {
  sock: ViewerSocket;
  sent: string[];
  closeFromClient: () => void;
  sendToServer: (text: string) => void;
} {
  const sent: string[] = [];
  let msgCb: ((text: string) => void) | null = null;
  const closeCbs: Array<() => void> = [];
  const sock: ViewerSocket = {
    sendText: (text) => {
      sent.push(text);
    },
    close: () => {
      for (const cb of closeCbs) cb();
    },
    onMessage: (cb) => {
      msgCb = cb;
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
  };
  return {
    sock,
    sent,
    closeFromClient: () => {
      for (const cb of closeCbs) cb();
    },
    sendToServer: (text) => msgCb?.(text),
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// pngDimensions
// ---------------------------------------------------------------------------

describe('pngDimensions', () => {
  it('parses width/height from a real PNG IHDR', () => {
    // Minimal valid PNG header: signature + IHDR with w=320,h=200.
    const buf = Buffer.alloc(26);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12);
    buf.writeUInt32BE(320, 16);
    buf.writeUInt32BE(200, 20);
    expect(pngDimensions(buf)).toEqual({ w: 320, h: 200 });
  });

  it('returns null for non-PNG bytes', () => {
    expect(pngDimensions(Buffer.from([1, 2, 3]))).toBeNull();
    expect(pngDimensions(Buffer.alloc(30))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

describe('RemoteScreenService lifecycle', () => {
  let gov: ReturnType<typeof makeGovernance>;
  let service: RemoteScreenService;
  let audits: Array<{ action: string; fields: Record<string, unknown> }>;

  beforeEach(() => {
    gov = makeGovernance();
    ({ service, audits } = makeService(gov));
  });

  afterEach(() => {
    service.close();
  });

  it('requestSession creates a pending session and mints an approval', () => {
    const { sessionId, approvalId, status } = service.requestSession('dev-1', 'Pixel 8');
    expect(status).toBe('pending');
    expect(sessionId).toBeTruthy();
    const session = service.getSession(sessionId);
    expect(session?.status).toBe('pending');
    expect(session?.deviceName).toBe('Pixel 8');
    expect(gov.approvals).toHaveLength(1);
    expect(gov.approvals[0].toolName).toBe(REMOTE_SCREEN_TOOL);
    expect(String(gov.approvals[0].args['request'])).toContain('Allow screen sharing');
    expect(String(gov.approvals[0].args['request'])).toContain('Pixel 8');
    expect(gov.pending.has(approvalId)).toBe(true);
    expect(audits.some((a) => a.action === 'remote-screen.requested')).toBe(true);
  });

  it('approval -> approved; deny -> denied; timeout -> expired (fail closed)', async () => {
    const a = service.requestSession('dev-1', 'Phone A');
    const b = service.requestSession('dev-2', 'Phone B');
    const c = service.requestSession('dev-3', 'Phone C');
    gov.pending.get(a.approvalId)!.resolve('approved');
    gov.pending.get(b.approvalId)!.resolve('denied');
    gov.pending.get(c.approvalId)!.reject(new Error('timeout'));
    await tick(20);
    expect(service.getSession(a.sessionId)?.status).toBe('approved');
    expect(service.getSession(b.sessionId)?.status).toBe('denied');
    expect(service.getSession(c.sessionId)?.status).toBe('expired');
    expect(audits.some((x) => x.action === 'remote-screen.approved')).toBe(true);
    expect(audits.some((x) => x.action === 'remote-screen.denied')).toBe(true);
    expect(audits.some((x) => x.action === 'remote-screen.expired')).toBe(true);
  });

  it('attachViewer on a pending session throws awaiting_approval', () => {
    const { sessionId } = service.requestSession('dev-1', 'Phone');
    const v = fakeViewer();
    expect(() => service.attachViewer(sessionId, v.sock)).toThrow('awaiting_approval');
  });

  it('attachViewer on denied/ended sessions throws', async () => {
    const { sessionId, approvalId } = service.requestSession('dev-1', 'Phone');
    gov.pending.get(approvalId)!.resolve('denied');
    await tick(20);
    expect(() => service.attachViewer(sessionId, fakeViewer().sock)).toThrow('not_approved');
    expect(() => service.attachViewer('nope', fakeViewer().sock)).toThrow('unknown_session');
  });

  it('approved session streams frames to the viewer and goes active', async () => {
    const { sessionId, approvalId } = service.requestSession('dev-1', 'Phone');
    gov.pending.get(approvalId)!.resolve('approved');
    await tick(20);
    const v = fakeViewer();
    service.attachViewer(sessionId, v.sock);
    await tick(50);
    expect(service.getSession(sessionId)?.status).toBe('active');
    const frames = v.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'frame');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].w).toBe(320);
    expect(frames[0].h).toBe(200);
    expect(typeof frames[0].png).toBe('string');
    expect(frames[0].n).toBeGreaterThan(0);
  });

  it('viewer input is rejected: the channel is view-only', async () => {
    const { sessionId, approvalId } = service.requestSession('dev-1', 'Phone');
    gov.pending.get(approvalId)!.resolve('approved');
    await tick(20);
    const v = fakeViewer();
    service.attachViewer(sessionId, v.sock);
    v.sendToServer(JSON.stringify({ t: 'click', x: 1, y: 2 }));
    await tick(10);
    const errs = v.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'error');
    expect(errs.some((e) => e.detail === 'view_only')).toBe(true);
  });

  it('stopSession ends the session and notifies viewers', async () => {
    const { sessionId, approvalId } = service.requestSession('dev-1', 'Phone');
    gov.pending.get(approvalId)!.resolve('approved');
    await tick(20);
    const v = fakeViewer();
    service.attachViewer(sessionId, v.sock);
    await tick(30);
    expect(service.stopSession(sessionId, 'device:dev-1')).toBe(true);
    const session = service.getSession(sessionId);
    expect(session?.status).toBe('ended');
    const ended = v.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'ended');
    expect(ended.length).toBeGreaterThan(0);
    expect(audits.some((a) => a.action === 'remote-screen.stopped')).toBe(true);
    expect(service.stopSession('unknown', 'x')).toBe(false);
  });

  it('device can cancel while still pending', () => {
    const { sessionId } = service.requestSession('dev-1', 'Phone');
    expect(service.stopSession(sessionId, 'device:dev-1')).toBe(true);
    expect(service.getSession(sessionId)?.status).toBe('ended');
  });

  it('activeSessions only lists approved/active sessions (web UI banner)', async () => {
    const a = service.requestSession('dev-1', 'A');
    const b = service.requestSession('dev-2', 'B');
    gov.pending.get(a.approvalId)!.resolve('approved');
    gov.pending.get(b.approvalId)!.resolve('denied');
    await tick(20);
    const active = service.activeSessions();
    expect(active.map((s) => s.id)).toEqual([a.sessionId]);
  });

  it('sessions auto-stop at maxDurationMs', async () => {
    const gov2 = makeGovernance();
    const { service: s2 } = makeService(gov2, { maxDurationMs: 120, fps: 50 });
    try {
      const { sessionId, approvalId } = s2.requestSession('dev-1', 'Phone');
      gov2.pending.get(approvalId)!.resolve('approved');
      await tick(20);
      s2.attachViewer(sessionId, fakeViewer().sock);
      await tick(250);
      expect(s2.getSession(sessionId)?.status).toBe('ended');
    } finally {
      s2.close();
    }
  });

  it('repeated capture failures tear the session down', async () => {
    const gov2 = makeGovernance();
    const audits2: Array<{ action: string; fields: Record<string, unknown> }> = [];
    const s2 = new RemoteScreenService({
      captureFrame: async () => {
        throw new Error('no display');
      },
      requestApproval: gov2.requestApproval,
      awaitDecision: gov2.awaitDecision,
      audit: (action, fields) => audits2.push({ action, fields }),
      fps: 100,
      maxDurationMs: 60_000,
    });
    try {
      const { sessionId, approvalId } = s2.requestSession('dev-1', 'Phone');
      gov2.pending.get(approvalId)!.resolve('approved');
      await tick(20);
      const v = fakeViewer();
      s2.attachViewer(sessionId, v.sock);
      await tick(900); // interval clamps to >=100ms; need 5 consecutive failures
      expect(s2.getSession(sessionId)?.status).toBe('ended');
      const msgs = v.sent.map((s) => JSON.parse(s));
      expect(msgs.some((m) => m.t === 'error' && m.detail === 'capture_failed')).toBe(true);
      expect(msgs.some((m) => m.t === 'ended' && m.reason === 'capture_unavailable')).toBe(true);
    } finally {
      s2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

describe('remote-screen routes', () => {
  let gov: ReturnType<typeof makeGovernance>;
  let service: RemoteScreenService;
  let base: string;
  let server: http.Server;
  let closeServer: () => Promise<void>;

  const TOKENS = new Map<string, { id: string; name: string }>([
    ['token-1', { id: 'dev-1', name: 'Pixel 8' }],
    ['token-2', { id: 'dev-2', name: 'Galaxy' }],
  ]);

  beforeEach(async () => {
    gov = makeGovernance();
    ({ service } = makeService(gov));
    const store = {
      findDeviceByToken: (token: string) => {
        const d = TOKENS.get(token);
        return d ? { ...d, tokenHash: 'x', createdAt: 0, lastSeen: 0 } : undefined;
      },
      touchDevice: (_id: string) => {},
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/api/remote-screen',
      createRemoteScreenRouter({
        store: store as never,
        service,
        audit: () => {},
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        service.close();
        server.close((e) => (e ? reject(e) : resolve()));
      });
  });

  afterEach(async () => {
    await closeServer();
  });

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${base}/api/remote-screen/start`, { method: 'POST' });
    expect(res.status).toBe(401);
    const res2 = await fetch(`${base}/api/remote-screen/status`);
    expect(res2.status).toBe(200); // the web UI banner needs no device token
  });

  it('full lifecycle: start -> poll pending -> approve -> status -> stop', async () => {
    const start = await fetch(`${base}/api/remote-screen/start`, {
      method: 'POST',
      headers: auth('token-1'),
    });
    expect(start.status).toBe(202);
    const started = (await start.json()) as { sessionId: string; approvalId: string; status: string; wsPath: string };
    expect(started.status).toBe('pending');
    expect(started.wsPath).toBe('/api/remote-screen/ws');

    // Phone polls while the owner hasn't decided yet.
    const poll1 = await fetch(`${base}/api/remote-screen/session/${started.sessionId}`, {
      headers: auth('token-1'),
    });
    expect(poll1.status).toBe(200);
    expect(((await poll1.json()) as { session: { status: string } }).session.status).toBe('pending');

    // A different device cannot see or stop this session.
    const other = await fetch(`${base}/api/remote-screen/session/${started.sessionId}`, {
      headers: auth('token-2'),
    });
    expect(other.status).toBe(403);
    const otherStop = await fetch(`${base}/api/remote-screen/stop`, {
      method: 'POST',
      headers: { ...auth('token-2'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: started.sessionId }),
    });
    expect(otherStop.status).toBe(403);

    // Owner approves in the web UI -> session becomes approved.
    gov.pending.get(started.approvalId)!.resolve('approved');
    await tick(20);
    const poll2 = await fetch(`${base}/api/remote-screen/session/${started.sessionId}`, {
      headers: auth('token-1'),
    });
    expect(((await poll2.json()) as { session: { status: string } }).session.status).toBe('approved');

    // Web UI banner sees it.
    const status = (await (await fetch(`${base}/api/remote-screen/status`)).json()) as {
      active: Array<{ sessionId: string; deviceName: string }>;
    };
    expect(status.active.map((s) => s.sessionId)).toContain(started.sessionId);
    expect(status.active[0].deviceName).toBe('Pixel 8');

    // Device stops it.
    const stop = await fetch(`${base}/api/remote-screen/stop`, {
      method: 'POST',
      headers: { ...auth('token-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: started.sessionId }),
    });
    expect(stop.status).toBe(200);

    // Banner is clear again.
    const status2 = (await (await fetch(`${base}/api/remote-screen/status`)).json()) as {
      active: unknown[];
    };
    expect(status2.active).toHaveLength(0);
  });

  it('local console can stop a session via /stop-local', async () => {
    const start = await fetch(`${base}/api/remote-screen/start`, {
      method: 'POST',
      headers: auth('token-1'),
    });
    const { sessionId } = (await start.json()) as { sessionId: string };
    const stop = await fetch(`${base}/api/remote-screen/stop-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    expect(stop.status).toBe(200);
    const missing = await fetch(`${base}/api/remote-screen/stop-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    });
    expect(missing.status).toBe(404);
  });

  it('validates request bodies', async () => {
    const bad = await fetch(`${base}/api/remote-screen/stop`, {
      method: 'POST',
      headers: { ...auth('token-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const unknown = await fetch(`${base}/api/remote-screen/session/nope`, { headers: auth('token-1') });
    expect(unknown.status).toBe(404);
  });

  it('exposes a WS upgrade handler that rejects bad handshakes', () => {
    const upgrade = createRemoteScreenUpgrade({
      store: {
        findDeviceByToken: () => undefined,
        touchDevice: () => {},
      } as never,
      service,
      audit: () => {},
    });
    expect(typeof upgrade.handleUpgrade).toBe('function');
  });

  it('local routes enforce the loopback token explicitly when wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/remote-screen',
      createRemoteScreenRouter({
        store: {
          findDeviceByToken: () => undefined,
          touchDevice: () => {},
        } as never,
        service,
        audit: () => {},
        loopbackToken: 'loopback-secret',
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/api/remote-screen`;
    try {
      // No token → 401 on both local routes.
      expect((await fetch(`${url}/status`)).status).toBe(401);
      expect(
        (
          await fetch(`${url}/stop-local`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'x' }),
          })
        ).status,
      ).toBe(401);
      // Wrong token → 401.
      expect(
        (await fetch(`${url}/status`, { headers: { Authorization: 'Bearer wrong' } })).status,
      ).toBe(401);
      // Right token → through (200 on status).
      expect(
        (await fetch(`${url}/status`, { headers: { Authorization: 'Bearer loopback-secret' } }))
          .status,
      ).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
