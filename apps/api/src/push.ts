// SPDX-License-Identifier: Apache-2.0
// Encrypted push notifications for the KriyaDot companion app (Codync parity).
//
// Design (mirrors Codync's push-and-live-activity contract, adapted to FCM):
// - Alert kinds: 'done' | 'needsInput' | 'failed'.
// - The notification title/body are sealed with AES-256-GCM under a per-device
//   push key established at pairing time (see companion.ts exchangePairing).
//   FCM (and any relay in the path) only ever sees ciphertext + routing fields.
// - The Android app decrypts locally with the key from its encrypted prefs.
// - If a device has no push key (paired before this feature), the server sends
//   a generic fallback ("KriyaDot" / "You have a new message") with no content.
// - FCM is optional: without FCM credentials configured, PushService logs once
//   and all sends become no-ops. The companion WebSocket remains the live path.
//
// FCM credentials (server): set FCM_SERVICE_ACCOUNT_JSON to the path of a
// Firebase service-account JSON file, or rely on
// GOOGLE_APPLICATION_CREDENTIALS / Application Default Credentials.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type PushKind = 'done' | 'needsInput' | 'failed';

export type NotificationPref = 'all' | 'approvals' | 'none';

/** AES-256-GCM sealed payload, JSON-serialized then base64url'd into FCM data. */
export interface SealedPayload {
  v: 1;
  /** base64 nonce (12 bytes) */
  nonce: string;
  /** base64 ciphertext (AES-256-GCM, title/body JSON) */
  ct: string;
}

interface SealedContent {
  title: string;
  body: string;
}

const SEAL_VERSION = 1;
const TITLE_LIMIT = 80;
const BODY_LIMIT = 400;

/** Seal {title, body} under the device's push key (base64, 32 bytes). */
export function sealPayload(pushKeyB64: string, title: string, body: string): SealedPayload {
  const key = Buffer.from(pushKeyB64, 'base64');
  if (key.length !== 32) throw new Error('invalid push key length');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = JSON.stringify({
    title: title.slice(0, TITLE_LIMIT),
    body: body.slice(0, BODY_LIMIT),
  } satisfies SealedContent);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: SEAL_VERSION,
    nonce: nonce.toString('base64'),
    ct: Buffer.concat([ct, tag]).toString('base64'),
  };
}

/** Decrypt a sealed payload. Throws on wrong key / tampered data. */
export function unsealPayload(pushKeyB64: string, sealed: SealedPayload): SealedContent {
  const key = Buffer.from(pushKeyB64, 'base64');
  if (key.length !== 32) throw new Error('invalid push key length');
  if (sealed.v !== SEAL_VERSION) throw new Error('unsupported sealed payload version');
  const nonce = Buffer.from(sealed.nonce, 'base64');
  const raw = Buffer.from(sealed.ct, 'base64');
  if (raw.length < 17) throw new Error('sealed payload too short');
  const ct = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext) as SealedContent;
  if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
    throw new Error('malformed sealed content');
  }
  return parsed;
}

/** One push-capable device, as resolved from the companion store. */
export interface PushDevice {
  deviceId: string;
  fcmToken: string;
  /** base64 push key, or null when the device paired before push keys existed. */
  pushKey: string | null;
}

export interface PushRequest {
  kind: PushKind;
  botId: string;
  botName: string;
  /** Plaintext title/body — sealed per device before sending. */
  title: string;
  body: string;
  /** Routing fields (never sensitive). */
  chatId?: string;
  approvalId?: string;
}

export interface PushServiceDeps {
  /** Devices that registered an FCM token. */
  listPushDevices: () => PushDevice[];
  /** Per-bot notification preference; default 'all'. */
  getBotPref: (botId: string) => NotificationPref;
  /** Send one FCM data message. Injected for tests. */
  sendFcm?: (token: string, data: Record<string, string>) => Promise<void>;
  log?: (msg: string) => void;
}

const FALLBACK_TITLE = 'KriyaDot';
const FALLBACK_BODY: Record<PushKind, string> = {
  done: 'A bot finished a task. Open KriyaDot to see the result.',
  needsInput: 'A bot needs your input. Open KriyaDot to review.',
  failed: 'A bot run failed. Open KriyaDot for details.',
};

export class PushService {
  private fcmWarned = false;

  constructor(private readonly deps: PushServiceDeps) {}

  /** Whether FCM delivery is configured (credentials present or sendFcm injected). */
  get enabled(): boolean {
    if (this.deps.sendFcm) return true;
    return Boolean(process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }

  private warnOnce(msg: string): void {
    if (this.fcmWarned) return;
    this.fcmWarned = true;
    (this.deps.log ?? console.warn)(`[push] ${msg}`);
  }

  /**
   * Fan out a push to every registered device, honoring per-bot prefs.
   * Never throws — delivery is best-effort (mirrors Codync's contract).
   */
  async notify(req: PushRequest): Promise<{ attempted: number; sent: number }> {
    const pref = this.deps.getBotPref(req.botId);
    if (pref === 'none') return { attempted: 0, sent: 0 };
    if (pref === 'approvals' && req.kind !== 'needsInput') return { attempted: 0, sent: 0 };

    const devices = this.deps.listPushDevices();
    if (devices.length === 0) return { attempted: 0, sent: 0 };
    if (!this.enabled) {
      this.warnOnce('FCM not configured — push notifications disabled (set FCM_SERVICE_ACCOUNT_JSON).');
      return { attempted: 0, sent: 0 };
    }

    let sent = 0;
    for (const d of devices) {
      try {
        const data = this.buildDataMessage(d, req);
        await this.send(d.fcmToken, data);
        sent++;
      } catch {
        // Best-effort: one bad token must not break the fan-out.
      }
    }
    return { attempted: devices.length, sent };
  }

  /** Build the FCM data payload for one device (sealed when possible). */
  buildDataMessage(device: PushDevice, req: PushRequest): Record<string, string> {
    const data: Record<string, string> = {
      kind: req.kind,
      botId: req.botId,
      fallbackTitle: FALLBACK_TITLE,
      fallbackBody: FALLBACK_BODY[req.kind],
    };
    if (req.chatId) data.chatId = req.chatId;
    if (req.approvalId) data.approvalId = req.approvalId;
    if (device.pushKey) {
      try {
        const sealed = sealPayload(device.pushKey, req.title, req.body);
        data.sealed = Buffer.from(JSON.stringify(sealed), 'utf8').toString('base64url');
      } catch {
        // Sealing failed — fall back to the generic text below.
      }
    }
    return data;
  }

  private async send(token: string, data: Record<string, string>): Promise<void> {
    if (this.deps.sendFcm) {
      await this.deps.sendFcm(token, data);
      return;
    }
    const messaging = await getFcmMessaging();
    if (!messaging) {
      this.warnOnce('FCM not configured — push notifications disabled (set FCM_SERVICE_ACCOUNT_JSON).');
      return;
    }
    await messaging.send({ token, data });
  }

  // ---- Convenience triggers ------------------------------------------------

  /** Bot turn completed. Excerpt = start of the final reply (already capped). */
  notifyTurnDone(botId: string, botName: string, excerpt: string, chatId?: string): Promise<{ attempted: number; sent: number }> {
    return this.notify({
      kind: 'done',
      botId,
      botName,
      title: `${botName} — Task complete`,
      body: excerpt.slice(0, BODY_LIMIT) || 'Finished.',
      chatId,
    });
  }

  /** Approval requested — high priority on the client. */
  notifyApprovalNeeded(botId: string, botName: string, approvalId: string, toolName: string, summary: string): Promise<{ attempted: number; sent: number }> {
    return this.notify({
      kind: 'needsInput',
      botId,
      botName,
      title: `${botName} — Response needed`,
      body: `${toolName}: ${summary}`.slice(0, BODY_LIMIT),
      approvalId,
    });
  }

  /** Bot turn failed. */
  notifyTurnFailed(botId: string, botName: string, error: string, chatId?: string): Promise<{ attempted: number; sent: number }> {
    return this.notify({
      kind: 'failed',
      botId,
      botName,
      title: `${botName} — Task failed`,
      body: error.slice(0, BODY_LIMIT) || 'The run failed.',
      chatId,
    });
  }
}

// ---- FCM admin (lazy) -------------------------------------------------------

// firebase-admin is an optional dependency: the server runs fine without it
// (push becomes a no-op) so local-first installs don't need Firebase at all.
type FcmMessaging = { send: (msg: { token: string; data: Record<string, string> }) => Promise<string> };

let messagingPromise: Promise<FcmMessaging | null> | null = null;

async function getFcmMessaging(): Promise<FcmMessaging | null> {
  if (!messagingPromise) {
    messagingPromise = initFcm().catch(() => null);
  }
  return messagingPromise;
}

async function initFcm(): Promise<FcmMessaging | null> {
  const saPath = process.env.FCM_SERVICE_ACCOUNT_JSON;
  const hasAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!saPath && !hasAdc) return null;
  // Lazy require so the module loads without firebase-admin installed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const admin = require('firebase-admin') as typeof import('firebase-admin');
  if (admin.apps.length === 0) {
    if (saPath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sa = require(saPath) as import('firebase-admin').ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    } else {
      admin.initializeApp();
    }
  }
  return admin.messaging() as unknown as FcmMessaging;
}

/** Test hook: reset the cached FCM init. */
export function __resetFcmForTests(): void {
  messagingPromise = null;
}
