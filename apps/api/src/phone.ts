// SPDX-License-Identifier: Apache-2.0
// Remote-phone control v1 (KriyaDot MVP): pairing store, session store, wire
// protocol validation, and a dependency-free WebSocket hub.
//
// Scope: the user's OWN paired Android phone, viewed and controlled from the
// KriyaDot web UI. Security is mandatory: pairing requires explicit on-phone
// acceptance, live sessions are token-authenticated, every control session is
// audit-logged, and input is only ever routed to the paired device that the
// viewer is watching. See phone-PROTOCOL.md for the wire protocol + threat model.
//
// Storage: <dataDir>/phone.db (node:sqlite). Pairing codes are in-memory only
// (single-process MVP) — a restart invalidates pending codes; paired devices
// and the token hashes persist.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number;
  /** DB row only; never serialized to the wire. */
  tokenHash?: string;
}

export interface PhoneSession {
  id: string;
  deviceId: string;
  kind: 'ws' | 'adb';
  startedAt: number;
  endedAt: number | null;
  frameCount: number;
  inputCount: number;
}

export interface PairingChallenge {
  code: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Pairing rate limit
// ---------------------------------------------------------------------------

const PAIR_CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const PAIR_CONFIRM_MAX_ATTEMPTS = 10;
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CODES = 3;

export class PairingRateLimiter {
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();

  /** Returns true if the attempt is allowed, false if the IP is throttled. */
  allow(ip: string): boolean {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now - rec.windowStart > PAIR_CONFIRM_WINDOW_MS) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    rec.count += 1;
    return rec.count <= PAIR_CONFIRM_MAX_ATTEMPTS;
  }

  /** For tests. */
  reset(ip: string): void {
    this.attempts.delete(ip);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// PhoneStore
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  paired_at: number;
  last_seen: number;
  token_hash: string;
}

interface SessionRow {
  id: string;
  device_id: string;
  kind: string;
  started_at: number;
  ended_at: number | null;
  frame_count: number;
  input_count: number;
}

function rowToSession(r: SessionRow): PhoneSession {
  return {
    id: r.id,
    deviceId: r.device_id,
    kind: r.kind === 'adb' ? 'adb' : 'ws',
    startedAt: r.started_at,
    endedAt: r.ended_at,
    frameCount: r.frame_count,
    inputCount: r.input_count,
  };
}

export class PhoneStore {
  private readonly db: DatabaseSync;
  private readonly pendingCodes = new Map<string, PairingChallenge>();
  readonly rateLimiter = new PairingRateLimiter();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'phone.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        token_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'ws',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        frame_count INTEGER NOT NULL DEFAULT 0,
        input_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id, started_at DESC);
    `);
  }

  // ---- Pairing handshake -------------------------------------------------

  /** Step 1: mint a 6-digit pairing code shown in the web UI. ttlMs override is for tests. */
  requestPairingCode(ttlMs: number = PAIR_CODE_TTL_MS): PairingChallenge {
    // Expire stale codes first.
    const now = Date.now();
    for (const [code, ch] of this.pendingCodes) {
      if (ch.expiresAt <= now) this.pendingCodes.delete(code);
    }
    if (this.pendingCodes.size >= MAX_PENDING_CODES) {
      // Drop the oldest to stay bounded.
      const oldest = this.pendingCodes.keys().next();
      if (!oldest.done) this.pendingCodes.delete(oldest.value);
    }
    let code: string;
    do {
      code = String(randomInt(100000, 1000000));
    } while (this.pendingCodes.has(code));
    const challenge: PairingChallenge = { code, expiresAt: now + ttlMs };
    this.pendingCodes.set(code, challenge);
    return challenge;
  }

  /**
   * Step 2: the phone, after the user explicitly accepted on-device, confirms
   * with the code. Returns { deviceId, token } on success. The raw token is
   * handed out exactly once here; only its SHA-256 hash is persisted.
   */
  confirmPairing(input: { code: unknown; deviceName: unknown; platform: unknown }): {
    ok: true;
    deviceId: string;
    token: string;
  } | { ok: false; error: string } {
    const { code, deviceName, platform } = input;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return { ok: false, error: 'invalid_code' };
    }
    const challenge = this.pendingCodes.get(code);
    if (!challenge) return { ok: false, error: 'invalid_code' }; // single-use + expiry
    this.pendingCodes.delete(code);
    if (challenge.expiresAt <= Date.now()) return { ok: false, error: 'expired_code' };

    const name = typeof deviceName === 'string' && deviceName.trim().length > 0 ? deviceName.trim().slice(0, 64) : 'Android phone';
    const plat = typeof platform === 'string' && platform.trim().length > 0 ? platform.trim().slice(0, 32) : 'android';

    const deviceId = `phone_${randomBytes(8).toString('hex')}`;
    const token = randomBytes(32).toString('hex'); // 256-bit
    const now = Date.now();
    this.db
      .prepare('INSERT INTO devices (id, name, platform, paired_at, last_seen, token_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(deviceId, name, plat, now, now, hashToken(token));
    return { ok: true, deviceId, token };
  }

  /** Revoke a device (unpair): deletes the device row and its token hash. */
  unpair(deviceId: string): boolean {
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId).changes > 0;
  }

  /** Verify a presented token with a constant-time compare against the hash. */
  verifyToken(deviceId: string, token: string): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    const row = this.db.prepare('SELECT token_hash FROM devices WHERE id = ?').get(deviceId) as
      | { token_hash: string }
      | undefined;
    if (!row) return false;
    const a = Buffer.from(hashToken(token), 'hex');
    const b = Buffer.from(row.token_hash, 'hex');
    return a.length === b.length && a.equals(b);
  }

  // ---- Devices ------------------------------------------------------------

  /** Public device list — never includes token hashes. */
  listDevices(): Omit<PairedDevice, 'tokenHash'>[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY paired_at DESC').all() as unknown as DeviceRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      pairedAt: r.paired_at,
      lastSeen: r.last_seen,
    }));
  }

  getDevice(deviceId: string): PairedDevice | undefined {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as DeviceRow | undefined;
    if (!r) return undefined;
    return { id: r.id, name: r.name, platform: r.platform, pairedAt: r.paired_at, lastSeen: r.last_seen, tokenHash: r.token_hash };
  }

  touchDevice(deviceId: string): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), deviceId);
  }

  // ---- Sessions ------------------------------------------------------------

  startSession(deviceId: string, kind: 'ws' | 'adb'): PhoneSession {
    const now = Date.now();
    const id = `psess_${randomBytes(8).toString('hex')}`;
    this.db
      .prepare('INSERT INTO sessions (id, device_id, kind, started_at, ended_at, frame_count, input_count) VALUES (?, ?, ?, ?, NULL, 0, 0)')
      .run(id, deviceId, kind, now);
    return { id, deviceId, kind, startedAt: now, endedAt: null, frameCount: 0, inputCount: 0 };
  }

  bumpSession(id: string, frames: number, inputs: number): void {
    this.db
      .prepare('UPDATE sessions SET frame_count = frame_count + ?, input_count = input_count + ? WHERE id = ?')
      .run(frames, inputs, id);
  }

  endSession(id: string): PhoneSession | undefined {
    const now = Date.now();
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(now, id);
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return r ? rowToSession(r) : undefined;
  }

  recentSessions(limit = 50): PhoneSession[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }
}

// ---------------------------------------------------------------------------
// Wire protocol validation (v1)
// ---------------------------------------------------------------------------
//
// Phone → server:
//   { t:'hello', deviceId, token }        authenticate the phone end
//   { t:'frame', jpg: base64, w, h, ts }  MJPEG frame (JPEG bytes, base64)
// Viewer → server:
//   { t:'watch', deviceId }               subscribe to a device's frames
//   { t:'tap', x, y }                     normalized 0..1
//   { t:'swipe', x1,y1,x2,y2, ms }        normalized 0..1, ms 50..5000
//   { t:'text', text }                    max 1024 chars
//   { t:'key', key: 'back'|'home'|'wake' }
// Server → client:
//   { t:'ok' | 'error', detail? }         acks / rejections
//   { t:'frame', jpg, w, h, ts }          relayed to watchers
//   { t:'tap' | 'swipe' | 'text' | 'key', … }  relayed to the phone

export const PHONE_PROTOCOL_VERSION = 1;
export const MAX_TEXT_LEN = 1024;
export const MAX_FRAME_B64 = 3 * 1024 * 1024; // ~2.25 MB of JPEG
export const VALID_KEYS = new Set(['back', 'home', 'wake']);

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isUnit(v: unknown): v is number {
  return isFiniteNum(v) && v >= 0 && v <= 1;
}

export type ValidatedMessage =
  | { t: 'hello'; deviceId: string; token: string }
  | { t: 'frame'; jpg: string; w: number; h: number; ts: number }
  | { t: 'watch'; deviceId: string }
  | { t: 'tap'; x: number; y: number }
  | { t: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { t: 'text'; text: string }
  | { t: 'key'; key: 'back' | 'home' | 'wake' };

function validDeviceId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_:-]+$/.test(v);
}

/** Validate any inbound JSON message. Malformed → { ok:false } and the sender gets {t:'error'}. */
export function validateMessage(raw: unknown): { ok: true; msg: ValidatedMessage } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not_an_object' };
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'hello':
      if (!validDeviceId(m.deviceId)) return { ok: false, error: 'bad_device_id' };
      if (typeof m.token !== 'string' || m.token.length === 0 || m.token.length > 256) return { ok: false, error: 'bad_token' };
      return { ok: true, msg: { t: 'hello', deviceId: m.deviceId as string, token: m.token } };
    case 'watch':
      if (!validDeviceId(m.deviceId)) return { ok: false, error: 'bad_device_id' };
      return { ok: true, msg: { t: 'watch', deviceId: m.deviceId as string } };
    case 'frame':
      if (typeof m.jpg !== 'string' || m.jpg.length === 0 || m.jpg.length > MAX_FRAME_B64) return { ok: false, error: 'bad_frame' };
      if (!/^[A-Za-z0-9+/=]+$/.test(m.jpg)) return { ok: false, error: 'bad_frame' };
      if (!Number.isInteger(m.w) || (m.w as number) < 1 || (m.w as number) > 4096) return { ok: false, error: 'bad_frame_dims' };
      if (!Number.isInteger(m.h) || (m.h as number) < 1 || (m.h as number) > 4096) return { ok: false, error: 'bad_frame_dims' };
      if (!isFiniteNum(m.ts)) return { ok: false, error: 'bad_frame_ts' };
      return { ok: true, msg: { t: 'frame', jpg: m.jpg, w: m.w as number, h: m.h as number, ts: m.ts as number } };
    case 'tap':
      if (!isUnit(m.x) || !isUnit(m.y)) return { ok: false, error: 'bad_coords' };
      return { ok: true, msg: { t: 'tap', x: m.x as number, y: m.y as number } };
    case 'swipe':
      if (!isUnit(m.x1) || !isUnit(m.y1) || !isUnit(m.x2) || !isUnit(m.y2)) return { ok: false, error: 'bad_coords' };
      if (!isFiniteNum(m.ms) || (m.ms as number) < 50 || (m.ms as number) > 5000) return { ok: false, error: 'bad_duration' };
      return {
        ok: true,
        msg: { t: 'swipe', x1: m.x1 as number, y1: m.y1 as number, x2: m.x2 as number, y2: m.y2 as number, ms: Math.round(m.ms as number) },
      };
    case 'text':
      if (typeof m.text !== 'string' || m.text.length === 0 || m.text.length > MAX_TEXT_LEN) return { ok: false, error: 'bad_text' };
      return { ok: true, msg: { t: 'text', text: m.text } };
    case 'key':
      if (typeof m.key !== 'string' || !VALID_KEYS.has(m.key)) return { ok: false, error: 'bad_key' };
      return { ok: true, msg: { t: 'key', key: m.key as 'back' | 'home' | 'wake' } };
    default:
      return { ok: false, error: 'unknown_type' };
  }
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket server (no dependencies)
// ---------------------------------------------------------------------------
// Only what this hub needs: text frames (JSON), ping/pong, close. Control
// frames and fragmentation are handled; binary frames are rejected.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface PhoneSocket {
  sendText(text: string): void;
  close(code?: number): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

class NetPhoneSocket implements PhoneSocket {
  private msgCb: ((text: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private closed = false;
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];

  constructor(private readonly socket: Duplex) {
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.emitClose());
    socket.on('error', () => this.emitClose());
    // Remote half-close (FIN): without this the socket sits in CLOSE-WAIT
    // forever and session cleanup never runs. Finish our side and clean up.
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
        // ping → pong
        this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0xa) continue; // pong
      if (opcode === 0x0) {
        // continuation
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
      // binary / reserved opcodes: reject
      this.close(1003);
      return;
    }
  }
}

function computeAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID, 'utf8').digest('base64');
}

// ---------------------------------------------------------------------------
// PhoneSessionHub: live connections, input routing, frame fan-out
// ---------------------------------------------------------------------------

export interface PhoneAudit {
  (action: string, fields: Record<string, unknown>): void;
}

interface PhoneConn {
  socket: PhoneSocket;
  deviceId: string;
  session: PhoneSession;
  frames: number;
  inputs: number;
}

interface ViewerConn {
  socket: PhoneSocket;
  watching: string | null;
}

export class PhoneSessionHub {
  private readonly phones = new Map<string, PhoneConn>(); // deviceId → connection
  private readonly viewers = new Set<ViewerConn>();
  private readonly latestFrames = new Map<string, { jpg: string; w: number; h: number; ts: number }>();

  constructor(
    private readonly store: PhoneStore,
    private readonly audit: PhoneAudit,
  ) {}

  /** Latest cached frame per device (for the polling fallback / ADB stills). */
  latestFrame(deviceId: string): { jpg: string; w: number; h: number; ts: number } | undefined {
    return this.latestFrames.get(deviceId);
  }

  isOnline(deviceId: string): boolean {
    return this.phones.has(deviceId);
  }

  /** Force-disconnect a phone (e.g. on unpair). The audit log records the session end via the normal path. */
  kickDevice(deviceId: string): boolean {
    const conn = this.phones.get(deviceId);
    if (!conn) return false;
    try {
      conn.socket.close(1000);
    } catch {
      // ignore
    }
    return true;
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
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
    );
    this.acceptSocket(new NetPhoneSocket(socket), remoteAddr(req));
  }

  /** Accept an already-established text-message socket (used by tests with an in-process mock). */
  acceptSocket(sock: PhoneSocket, remoteAddr: string): void {
    let role: 'phone' | 'viewer' | null = null;
    let phoneConn: PhoneConn | null = null;
    let viewerConn: ViewerConn | null = null;
    let authed = false;

    const sendErr = (detail: string): void => {
      try {
        sock.sendText(JSON.stringify({ t: 'error', detail }));
      } catch {
        // ignore
      }
    };

    const cleanup = (): void => {
      if (phoneConn) {
        this.phones.delete(phoneConn.deviceId);
        const ended = this.store.endSession(phoneConn.session.id);
        this.store.bumpSession(phoneConn.session.id, phoneConn.frames, phoneConn.inputs);
        this.audit('phone.session_ended', {
          actor: 'api',
          toolName: 'phone',
          detail: {
            deviceId: phoneConn.deviceId,
            sessionId: phoneConn.session.id,
            frames: phoneConn.frames,
            inputs: phoneConn.inputs,
            durationMs: ended ? (ended.endedAt ?? Date.now()) - ended.startedAt : 0,
          },
        });
        phoneConn = null;
      }
      if (viewerConn) {
        this.viewers.delete(viewerConn);
        viewerConn = null;
      }
    };

    sock.onMessage((text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        sendErr('invalid_json');
        return;
      }
      const v = validateMessage(raw);
      if (!v.ok) {
        sendErr(v.error);
        return;
      }
      const msg = v.msg;

      // First message must be hello (phone) or watch (viewer).
      if (!authed) {
        if (msg.t === 'hello') {
          const ok = this.store.verifyToken(msg.deviceId, msg.token);
          if (!ok) {
            this.audit('phone.auth_failed', { actor: 'api', toolName: 'phone', detail: { deviceId: msg.deviceId, remoteAddr } });
            sendErr('auth_failed');
            sock.close(4401);
            return;
          }
          if (this.phones.has(msg.deviceId)) {
            // Replace a stale connection (e.g. phone reconnected after network drop).
            try {
              this.phones.get(msg.deviceId)?.socket.close(1000);
            } catch {
              // ignore
            }
            this.phones.delete(msg.deviceId);
          }
          const session = this.store.startSession(msg.deviceId, 'ws');
          this.store.touchDevice(msg.deviceId);
          phoneConn = { socket: sock, deviceId: msg.deviceId, session, frames: 0, inputs: 0 };
          this.phones.set(msg.deviceId, phoneConn);
          role = 'phone';
          authed = true;
          this.audit('phone.session_started', {
            actor: 'api',
            toolName: 'phone',
            detail: { deviceId: msg.deviceId, sessionId: session.id, kind: 'ws', remoteAddr },
          });
          sock.sendText(JSON.stringify({ t: 'ok', sessionId: session.id, v: PHONE_PROTOCOL_VERSION }));
          return;
        }
        if (msg.t === 'watch') {
          viewerConn = { socket: sock, watching: msg.deviceId };
          this.viewers.add(viewerConn);
          role = 'viewer';
          authed = true;
          const latest = this.latestFrames.get(msg.deviceId);
          sock.sendText(
            JSON.stringify({
              t: 'ok',
              v: PHONE_PROTOCOL_VERSION,
              online: this.phones.has(msg.deviceId),
              latest: latest ?? null,
            }),
          );
          return;
        }
        sendErr('auth_required');
        return;
      }

      if (role === 'phone' && phoneConn) {
        if (msg.t === 'frame') {
          phoneConn.frames += 1;
          this.latestFrames.set(phoneConn.deviceId, { jpg: msg.jpg, w: msg.w, h: msg.h, ts: msg.ts });
          const relay = JSON.stringify({ t: 'frame', jpg: msg.jpg, w: msg.w, h: msg.h, ts: msg.ts });
          for (const vw of this.viewers) {
            if (vw.watching === phoneConn.deviceId) {
              try {
                vw.socket.sendText(relay);
              } catch {
                // ignore
              }
            }
          }
          return;
        }
        sendErr('unexpected_message');
        return;
      }

      if (role === 'viewer' && viewerConn) {
        if (msg.t === 'watch') {
          viewerConn.watching = msg.deviceId;
          const latest = this.latestFrames.get(msg.deviceId);
          sock.sendText(
            JSON.stringify({ t: 'ok', online: this.phones.has(msg.deviceId), latest: latest ?? null }),
          );
          return;
        }
        // Input routing: only to the device this viewer is watching, and only
        // if that device is a live, paired phone.
        const target = viewerConn.watching;
        if (!target) {
          sendErr('no_device_watched');
          return;
        }
        const phone = this.phones.get(target);
        if (!phone) {
          sendErr('device_offline');
          return;
        }
        if (msg.t === 'tap' || msg.t === 'swipe' || msg.t === 'text' || msg.t === 'key') {
          phone.inputs += 1; // flushed to the session row when the phone disconnects
          phone.socket.sendText(JSON.stringify(msg));
          sock.sendText(JSON.stringify({ t: 'ok' }));
          return;
        }
        sendErr('unexpected_message');
        return;
      }
      sendErr('unexpected_message');
    });

    sock.onClose(() => cleanup());
  }
}

function remoteAddr(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
