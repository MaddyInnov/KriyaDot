// SPDX-License-Identifier: Apache-2.0
// KriyaDot companion (phone → PC remote control) v1: pairing store, device
// store, and a dependency-free WebSocket hub for server → phone pushes.
//
// This is the REVERSE of remote-phone v1 (/api/phone/*): here the phone is
// the remote control and the PC is controlled — run status, approvals,
// activity and chat are surfaced to the user's OWN paired phone app.
//
// Storage: <dataDir>/companion.db (node:sqlite) for paired devices (token
// hashes only — the raw device token is shown exactly once at exchange
// time). One-time pairing tokens (OTT) are in-memory only (single-process
// MVP) — a restart invalidates pending OTTs. Session pause marks are also
// in-memory.
//
// The RFC 6455 framing below mirrors apps/api/src/phone.ts (same proven
// pattern, duplicated so the phone direction stays untouched). Only what
// this hub needs: text frames (JSON), ping/pong, close.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompanionDevice {
  id: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number;
  /** DB row only; never serialized to the wire. */
  tokenHash?: string;
}

export interface PairingOTT {
  ott: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Pairing rate limit (mirrors phone.ts PairingRateLimiter)
// ---------------------------------------------------------------------------

const OTT_WINDOW_MS = 10 * 60 * 1000;
const OTT_MAX_ATTEMPTS = 10;
const OTT_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_OTTS = 5;

export class CompanionRateLimiter {
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();

  /** Returns true if the attempt is allowed, false if the IP is throttled. */
  allow(ip: string): boolean {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now - rec.windowStart > OTT_WINDOW_MS) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    rec.count += 1;
    return rec.count <= OTT_MAX_ATTEMPTS;
  }

  /** For tests. */
  reset(ip: string): void {
    this.attempts.delete(ip);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time buffer compare (avoids throwing on length mismatch). */
function hashEquals(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// CompanionStore
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  paired_at: number;
  last_seen: number;
  token_hash: string;
}

const DEVICE_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

export class CompanionStore {
  private readonly db: DatabaseSync;
  private readonly pendingOTTs = new Map<string, PairingOTT>();
  /** Chat sessions paused from the companion app (in-memory; restart clears). */
  private readonly pausedSessions = new Set<string>();
  readonly rateLimiter = new CompanionRateLimiter();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'companion.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        push_key TEXT,
        fcm_token TEXT
      );
    `);
    // Migrate pre-push databases.
    for (const col of ['push_key', 'fcm_token']) {
      const has = this.db
        .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('companion_devices') WHERE name = ?`)
        .get(col) as unknown as { n: number };
      if (has.n === 0) this.db.exec(`ALTER TABLE companion_devices ADD COLUMN ${col} TEXT`);
    }
  }

  // ---- Pairing handshake -------------------------------------------------

  /**
   * Step 1: mint a one-time token (OTT) embedded in the QR payload
   * (kriyadot://pair?host=…&port=…&token=<ott>) shown in the web UI.
   * ttlMs override is for tests.
   */
  requestPairingOTT(ttlMs: number = OTT_TTL_MS): PairingOTT {
    const now = Date.now();
    for (const [ott, rec] of this.pendingOTTs) {
      if (rec.expiresAt <= now) this.pendingOTTs.delete(ott);
    }
    if (this.pendingOTTs.size >= MAX_PENDING_OTTS) {
      const oldest = this.pendingOTTs.keys().next();
      if (!oldest.done) this.pendingOTTs.delete(oldest.value);
    }
    let ott: string;
    do {
      ott = randomBytes(16).toString('hex'); // 128-bit, URL-safe
    } while (this.pendingOTTs.has(ott));
    const rec: PairingOTT = { ott, expiresAt: now + ttlMs };
    this.pendingOTTs.set(ott, rec);
    return rec;
  }

  /**
   * Step 2: the phone exchanges the scanned OTT for a long-lived device
   * token. The OTT is consumed (single-use). The raw token is handed out
   * exactly once here; only its SHA-256 hash is persisted.
   */
  exchangePairing(input: { ott: unknown; deviceName: unknown; platform: unknown }): {
    ok: true;
    deviceId: string;
    token: string;
    /** base64 AES-256 key for sealed push payloads (stored on the device). */
    pushKey: string;
  } | { ok: false; error: string } {
    const { ott, deviceName, platform } = input;
    if (typeof ott !== 'string' || !/^[0-9a-f]{32}$/.test(ott)) {
      return { ok: false, error: 'invalid_ott' };
    }
    const rec = this.pendingOTTs.get(ott);
    if (!rec) return { ok: false, error: 'invalid_ott' }; // single-use + expiry
    this.pendingOTTs.delete(ott);
    if (rec.expiresAt <= Date.now()) return { ok: false, error: 'expired_ott' };

    const name =
      typeof deviceName === 'string' && deviceName.trim().length > 0 ? deviceName.trim().slice(0, 64) : 'Companion phone';
    const plat = typeof platform === 'string' && platform.trim().length > 0 ? platform.trim().slice(0, 32) : 'android';

    const deviceId = `comp_${randomBytes(8).toString('hex')}`;
    const token = randomBytes(32).toString('hex'); // 256-bit
    // Per-device push key for sealed notification payloads. Stored raw: the DB
    // lives on the user's own machine and the key is needed to seal pushes.
    const pushKey = randomBytes(32).toString('base64');
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO companion_devices (id, name, platform, paired_at, last_seen, token_hash, push_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(deviceId, name, plat, now, now, hashToken(token), pushKey);
    return { ok: true, deviceId, token, pushKey };
  }

  /** Revoke a device (unpair): deletes the device row and its token hash. */
  revoke(deviceId: string): boolean {
    if (!DEVICE_ID_RE.test(deviceId)) return false;
    return this.db.prepare('DELETE FROM companion_devices WHERE id = ?').run(deviceId).changes > 0;
  }

  /** Register (or refresh) the device's FCM registration token for push. */
  setFcmToken(deviceId: string, fcmToken: string): boolean {
    if (!DEVICE_ID_RE.test(deviceId)) return false;
    if (typeof fcmToken !== 'string' || fcmToken.length < 10 || fcmToken.length > 4096) return false;
    return (
      this.db.prepare('UPDATE companion_devices SET fcm_token = ? WHERE id = ?').run(fcmToken, deviceId)
        .changes > 0
    );
  }

  /**
   * Devices eligible for push: have an FCM token. Includes each device's
   * push key (null for devices paired before push keys existed — those get
   * the generic fallback payload).
   */
  listPushDevices(): Array<{ deviceId: string; fcmToken: string; pushKey: string | null }> {
    const rows = this.db
      .prepare(
        "SELECT id, fcm_token, push_key FROM companion_devices WHERE fcm_token IS NOT NULL AND fcm_token != ''",
      )
      .all() as unknown as Array<{ id: string; fcm_token: string; push_key: string | null }>;
    return rows.map((r) => ({ deviceId: r.id, fcmToken: r.fcm_token, pushKey: r.push_key ?? null }));
  }

  /**
   * Find the device that owns a presented bearer token (constant-time hash
   * compare per row). Returns undefined for missing/bad tokens.
   */
  findDeviceByToken(token: string): CompanionDevice | undefined {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return undefined;
    const want = hashToken(token);
    const rows = this.db.prepare('SELECT * FROM companion_devices').all() as unknown as DeviceRow[];
    for (const r of rows) {
      if (hashEquals(want, r.token_hash)) {
        return { id: r.id, name: r.name, platform: r.platform, pairedAt: r.paired_at, lastSeen: r.last_seen };
      }
    }
    return undefined;
  }

  /** Public device list — never includes token hashes. */
  listDevices(): Omit<CompanionDevice, 'tokenHash'>[] {
    const rows = this.db.prepare('SELECT * FROM companion_devices ORDER BY paired_at DESC').all() as unknown as DeviceRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      pairedAt: r.paired_at,
      lastSeen: r.last_seen,
    }));
  }

  getDevice(deviceId: string): CompanionDevice | undefined {
    const r = this.db.prepare('SELECT * FROM companion_devices WHERE id = ?').get(deviceId) as DeviceRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      platform: r.platform,
      pairedAt: r.paired_at,
      lastSeen: r.last_seen,
      tokenHash: r.token_hash,
    };
  }

  touchDevice(deviceId: string): void {
    this.db.prepare('UPDATE companion_devices SET last_seen = ? WHERE id = ?').run(Date.now(), deviceId);
  }

  // ---- Session pause marks (companion run controls) ------------------------
  // Pausing a chat session aborts its in-flight turn (via run controls) and
  // marks the session so no NEW turn may start on it until resumed — the
  // /api/chat handler rejects new turns on paused sessions with 423 (same
  // pattern as paused Spaces). Queued messages simply wait.

  pauseSession(sessionId: string): void {
    this.pausedSessions.add(sessionId);
  }

  resumeSession(sessionId: string): boolean {
    return this.pausedSessions.delete(sessionId);
  }

  isSessionPaused(sessionId: string): boolean {
    return this.pausedSessions.has(sessionId);
  }

  listPausedSessions(): string[] {
    return [...this.pausedSessions];
  }
}

// ---------------------------------------------------------------------------
// Wire protocol (server → phone pushes; phone → server acks)
// ---------------------------------------------------------------------------
//
// Phone → server (after the upgrade-time token auth):
//   { t:'hello', deviceId? }   announce; server replies {type:'hello', ok, snapshot?}
//   { t:'ping', ts? }           → {type:'pong', ts}
// Server → phone (pushes; the app dispatches on `type`):
//   { type:'hello', ok:true, deviceId, snapshot? }
//   { type:'run-status', run: {id, kind, label, state, detail} }
//   { type:'approval', event:'created'|'decided', approval: {...} }
//   { type:'activity', summary }          — hint to refetch GET /activity
//   { type:'ping', ts }                   — application heartbeat (30s)
//   { type:'error', detail }

export const COMPANION_PROTOCOL_VERSION = 1;

export type CompanionPush =
  | { type: 'run-status'; run: Record<string, unknown> }
  | { type: 'approval'; event: 'created' | 'decided'; approval: Record<string, unknown> }
  | { type: 'activity'; summary: string }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number }
  | { type: 'hello'; ok: true; deviceId: string; snapshot?: unknown }
  | { type: 'error'; detail: string };

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket framing (mirrors phone.ts — same proven code)
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface CompanionSocket {
  sendText(text: string): void;
  close(code?: number): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

class WireSocket implements CompanionSocket {
  private msgCb: ((text: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private closed = false;
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];

  constructor(private readonly socket: Duplex) {
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.emitClose());
    socket.on('error', () => this.emitClose());
    socket.on('end', () => this.close(1000));
  }

  onMessage(cb: (text: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  sendText(text: string): void {
    if (this.closed) return;
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.socket.write(Buffer.from([0x88, 0x02, payload[0], payload[1]]));
    } catch {
      // ignore
    }
    this.socket.destroy();
    this.emitClose();
  }

  private emitClose(): void {
    if (this.closed && this.closeCb) {
      const cb = this.closeCb;
      this.closeCb = null;
      cb();
      return;
    }
    if (!this.closed) {
      this.closed = true;
      this.closeCb?.();
      this.closeCb = null;
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(16 * 1024 * 1024)) {
          this.close(1009);
          return;
        }
        len = Number(big);
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
        payload = un;
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      if (opcode === 0x8) {
        this.close(1000);
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        this.frag.push(payload);
        if (fin) {
          const text = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          this.msgCb?.(text);
        }
        continue;
      }
      if (opcode === 0x1) {
        if (!fin) {
          this.frag = [payload];
          continue;
        }
        this.msgCb?.(payload.toString('utf8'));
        continue;
      }
      this.close(1003);
      return;
    }
  }
}

function computeAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID, 'utf8').digest('base64');
}

// ---------------------------------------------------------------------------
// CompanionHub: authenticated push channel to paired phones
// ---------------------------------------------------------------------------

export interface CompanionAudit {
  (action: string, fields: Record<string, unknown>): void;
}

export interface CompanionHubOptions {
  /** Snapshot payload sent with the hello ack (pending approvals, runs). */
  snapshot?: () => unknown;
  /** Application heartbeat interval ms (0 disables; mainly for tests). */
  heartbeatMs?: number;
}

interface PushConn {
  socket: CompanionSocket;
  device: CompanionDevice;
  remoteAddr: string;
}

const HEARTBEAT_MS = 30_000;

export class CompanionHub {
  private readonly conns = new Set<PushConn>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: CompanionStore,
    private readonly audit: CompanionAudit,
    private readonly opts: CompanionHubOptions = {},
  ) {}

  connectionCount(): number {
    return this.conns.size;
  }

  isConnected(deviceId: string): boolean {
    for (const c of this.conns) if (c.device.id === deviceId) return true;
    return false;
  }

  /** Push an event to every connected phone. Never throws. */
  broadcast(event: CompanionPush): void {
    let text: string;
    try {
      text = JSON.stringify({ ...event, v: COMPANION_PROTOCOL_VERSION });
    } catch {
      return;
    }
    for (const c of this.conns) {
      try {
        c.socket.sendText(text);
      } catch {
        // ignore
      }
    }
  }

  /** Push an event to one device's connections. Returns true if delivered. */
  pushToDevice(deviceId: string, event: CompanionPush): boolean {
    let text: string;
    try {
      text = JSON.stringify({ ...event, v: COMPANION_PROTOCOL_VERSION });
    } catch {
      return false;
    }
    let delivered = false;
    for (const c of this.conns) {
      if (c.device.id !== deviceId) continue;
      try {
        c.socket.sendText(text);
        delivered = true;
      } catch {
        // ignore
      }
    }
    return delivered;
  }

  /** Force-disconnect every connection owned by a device (e.g. on revoke). */
  dropDevice(deviceId: string): boolean {
    let dropped = false;
    for (const c of [...this.conns]) {
      if (c.device.id !== deviceId) continue;
      dropped = true;
      try {
        c.socket.close(1000);
      } catch {
        // ignore
      }
    }
    return dropped;
  }

  /** Stop the heartbeat timer (tests / shutdown). */
  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  // ---- HTTP Upgrade entry point ------------------------------------------

  handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers['upgrade'] ?? '').toLowerCase();
    if (upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Token auth happens at upgrade time: ?token=<deviceToken>.
    let token: string | null = null;
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      token = url.searchParams.get('token');
    } catch {
      token = null;
    }
    const device = token ? this.store.findDeviceByToken(token) : undefined;
    if (!device) {
      this.audit('companion.ws_auth_failed', {
        actor: 'api',
        toolName: 'companion',
        detail: { remoteAddr: remoteAddr(req) },
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
    );
    this.acceptSocket(new WireSocket(socket), remoteAddr(req), device);
  }

  /** Accept an already-authenticated text-message socket (used by tests with an in-process mock). */
  acceptSocket(sock: CompanionSocket, remoteAddrStr: string, device: CompanionDevice): void {
    const conn: PushConn = { socket: sock, device, remoteAddr: remoteAddrStr };
    this.conns.add(conn);
    this.store.touchDevice(device.id);
    this.ensureHeartbeat();
    this.audit('companion.ws_connected', {
      actor: 'api',
      toolName: 'companion',
      detail: { deviceId: device.id, remoteAddr: remoteAddrStr },
    });

    let helloed = false;
    const send = (event: CompanionPush): void => {
      try {
        sock.sendText(JSON.stringify({ ...event, v: COMPANION_PROTOCOL_VERSION }));
      } catch {
        // ignore
      }
    };

    sock.onMessage((text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        send({ type: 'error', detail: 'invalid_json' });
        return;
      }
      if (typeof raw !== 'object' || raw === null) {
        send({ type: 'error', detail: 'not_an_object' });
        return;
      }
      const t = (raw as Record<string, unknown>).t;
      if (!helloed) {
        if (t !== 'hello') {
          send({ type: 'error', detail: 'hello_required' });
          return;
        }
        helloed = true;
        let snapshot: unknown;
        try {
          snapshot = this.opts.snapshot?.();
        } catch {
          snapshot = undefined;
        }
        send({ type: 'hello', ok: true, deviceId: device.id, snapshot });
        return;
      }
      if (t === 'hello') {
        let snapshot: unknown;
        try {
          snapshot = this.opts.snapshot?.();
        } catch {
          snapshot = undefined;
        }
        send({ type: 'hello', ok: true, deviceId: device.id, snapshot });
        return;
      }
      if (t === 'ping') {
        const ts = (raw as Record<string, unknown>).ts;
        send({ type: 'pong', ts: typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now() });
        return;
      }
      send({ type: 'error', detail: 'unknown_type' });
    });

    sock.onClose(() => {
      this.conns.delete(conn);
      this.audit('companion.ws_disconnected', {
        actor: 'api',
        toolName: 'companion',
        detail: { deviceId: device.id, remoteAddr: remoteAddrStr },
      });
      if (this.conns.size === 0) this.close();
    });
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat || this.opts.heartbeatMs === 0) return;
    const ms = this.opts.heartbeatMs ?? HEARTBEAT_MS;
    const timer = setInterval(() => {
      this.broadcast({ type: 'ping', ts: Date.now() });
    }, ms);
    // Don't hold the process open for pushes.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.heartbeat = timer;
  }
}

function remoteAddr(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
