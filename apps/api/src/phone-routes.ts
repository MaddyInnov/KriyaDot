// SPDX-License-Identifier: Apache-2.0
// REST routes for remote-phone control v1. Mounted by routes.ts as
// router.use('/phone', phoneRouter). The WebSocket endpoint
// (/api/phone/ws) is handled by PhoneSessionHub.handleUpgrade, wired to the
// HTTP server's 'upgrade' event in index.ts.

import type { Request, Response, Router } from 'express';
import { PhoneSessionHub, PhoneStore, validateMessage } from './phone.js';
import { issueWsTicket } from './loopback-auth.js';
import { AdbPhoneProvider, isValidSerial } from './phone-adb.js';
import type { PhoneAudit } from './phone.js';

export interface PhoneRouteDeps {
  store: PhoneStore;
  hub: PhoneSessionHub;
  adb: AdbPhoneProvider;
  audit: PhoneAudit;
}

function err(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown';
}

const DEVICE_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const ADB_ID_PREFIX = 'adb:';

interface DeviceView {
  id: string;
  kind: 'paired' | 'adb';
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number;
  online: boolean;
}

export function registerPhoneRoutes(router: Router, deps: PhoneRouteDeps): void {
  const { store, hub, adb, audit } = deps;

  // ---- Devices ----------------------------------------------------------

  router.get('/devices', async (_req: Request, res: Response) => {
    const paired: DeviceView[] = store.listDevices().map((d) => ({
      id: d.id,
      kind: 'paired' as const,
      name: d.name,
      platform: d.platform,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      online: hub.isOnline(d.id),
    }));
    const virtual: DeviceView[] = [];
    if (await adb.isAvailable()) {
      for (const d of await adb.listDevices()) {
        if (d.state !== 'device') continue;
        virtual.push({
          id: `${ADB_ID_PREFIX}${d.serial}`,
          kind: 'adb' as const,
          name: `ADB ${d.serial}`,
          platform: 'android/adb',
          pairedAt: 0,
          lastSeen: Date.now(),
          online: true,
        });
      }
    }
    res.json({ ok: true, devices: [...paired, ...virtual], adbAvailable: await adb.isAvailable() });
  });

  // ---- Pairing -----------------------------------------------------------

  router.post('/pair/request', (req: Request, res: Response) => {
    const ch = store.requestPairingCode();
    audit('phone.pair_requested', {
      actor: 'api',
      toolName: 'phone',
      detail: { expiresAt: ch.expiresAt, ip: clientIp(req) },
    });
    res.json({ ok: true, pairingCode: ch.code, expiresAt: ch.expiresAt });
  });

  router.post('/pair/confirm', (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!store.rateLimiter.allow(ip)) {
      audit('phone.pair_rate_limited', { actor: 'api', toolName: 'phone', detail: { ip } });
      err(res, 429, 'rate_limited', 'Too many pairing attempts. Try again later.');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = store.confirmPairing({ code: body.code, deviceName: body.deviceName, platform: body.platform });
    if (!result.ok) {
      audit('phone.pair_failed', { actor: 'api', toolName: 'phone', detail: { reason: result.error, ip } });
      err(res, 400, result.error === 'expired_code' ? 'expired_code' : 'invalid_code');
      return;
    }
    audit('phone.paired', {
      actor: 'api',
      toolName: 'phone',
      detail: { deviceId: result.deviceId, ip },
    });
    res.json({ ok: true, deviceId: result.deviceId, token: result.token });
  });

  router.delete('/devices/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!DEVICE_ID_RE.test(id) || id.startsWith(ADB_ID_PREFIX)) {
      err(res, 400, 'invalid_device_id');
      return;
    }
    hub.kickDevice(id); // force-disconnect any live control session first
    const removed = store.unpair(id);
    if (!removed) {
      err(res, 404, 'device_not_found');
      return;
    }
    audit('phone.unpaired', { actor: 'api', toolName: 'phone', detail: { deviceId: id } });
    res.json({ ok: true });
  });

  // ---- Sessions (audit trail) ---------------------------------------------

  /**
   * Issue a one-time WS ticket for the phone watch socket. NOT exempt from
   * the loopback bearer token — the caller proves its auth here, then the
   * browser passes the ticket in its first `watch` message (browsers can't
   * send Authorization headers on WS handshakes). Tickets are single-use and
   * expire after 60s.
   */
  router.post('/watch-ticket', (req: Request, res: Response) => {
    if (!req.loopbackAuthed) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    res.json({ ok: true, ticket: issueWsTicket() });
  });

  router.get('/sessions', (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ ok: true, sessions: store.recentSessions(Number.isFinite(limit) ? limit : 50) });
  });

  // ---- ADB fallback ---------------------------------------------------------

  router.get('/adb/status', async (_req: Request, res: Response) => {
    const available = await adb.isAvailable();
    res.json({ ok: true, available, devices: available ? await adb.listDevices() : [] });
  });

  /** On-demand screen frame from an ADB-attached device (PNG, base64). */
  router.get('/adb/:serial/frame', async (req: Request, res: Response) => {
    const serial = req.params.serial;
    if (!isValidSerial(serial)) {
      err(res, 400, 'invalid_serial');
      return;
    }
    try {
      const f = await adb.grabFrame(serial);
      res.json({ ok: true, png: f.png.toString('base64'), w: f.w, h: f.h, ts: Date.now() });
    } catch (e) {
      err(res, 502, 'adb_frame_failed', e instanceof Error ? e.message : String(e));
    }
  });

  /** Input to an ADB-attached device. Body is validated with the same wire-protocol rules as WS input. */
  router.post('/adb/:serial/input', async (req: Request, res: Response) => {
    const serial = req.params.serial;
    if (!isValidSerial(serial)) {
      err(res, 400, 'invalid_serial');
      return;
    }
    const v = validateMessage(req.body);
    if (!v.ok) {
      err(res, 400, v.error);
      return;
    }
    const msg = v.msg;
    try {
      switch (msg.t) {
        case 'tap':
          await adb.tap(serial, msg.x, msg.y);
          break;
        case 'swipe':
          await adb.swipe(serial, msg.x1, msg.y1, msg.x2, msg.y2, msg.ms);
          break;
        case 'text':
          await adb.text(serial, msg.text);
          break;
        case 'key':
          await adb.key(serial, msg.key);
          break;
        default:
          err(res, 400, 'unexpected_message');
          return;
      }
      audit('phone.input_sent', {
        actor: 'api',
        toolName: 'phone',
        detail: { deviceId: `${ADB_ID_PREFIX}${serial}`, kind: 'adb', input: msg.t },
      });
      res.json({ ok: true });
    } catch (e) {
      err(res, 502, 'adb_input_failed', e instanceof Error ? e.message : String(e));
    }
  });

  /** Start an audited ADB control session (so it appears in the audit trail like WS sessions). */
  router.post('/adb/watch/start', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { serial?: unknown };
    const serial = await adb.resolveSerial(body.serial);
    if (!serial) {
      err(res, 404, 'adb_device_not_found');
      return;
    }
    const session = store.startSession(`${ADB_ID_PREFIX}${serial}`, 'adb');
    audit('phone.session_started', {
      actor: 'api',
      toolName: 'phone',
      detail: { deviceId: session.deviceId, sessionId: session.id, kind: 'adb' },
    });
    res.json({ ok: true, sessionId: session.id, deviceId: session.deviceId });
  });

  router.post('/adb/watch/end', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { sessionId?: unknown };
    if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
      err(res, 400, 'invalid_session_id');
      return;
    }
    const ended = store.endSession(body.sessionId);
    if (!ended) {
      err(res, 404, 'session_not_found');
      return;
    }
    audit('phone.session_ended', {
      actor: 'api',
      toolName: 'phone',
      detail: { deviceId: ended.deviceId, sessionId: ended.id, kind: 'adb' },
    });
    res.json({ ok: true });
  });


}
