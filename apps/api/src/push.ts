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

import { createCipheriv, createDecipheriv, randomBytes, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';

export type PushKind = 'done' | 'needsInput' | 'failed';
export type PushPlatform = 'ios' | 'android';

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
  /** FCM registration token (android) or APNs device token (ios). */
  fcmToken: string;
  /** base64 push key, or null when the device paired before push keys existed. */
  pushKey: string | null;
  /** Device platform; absent is treated as 'android' (pre-iOS rows). */
  platform?: PushPlatform;
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

// ---- APNs (iOS) -------------------------------------------------------------
//
// Provider-token auth: an ES256 JWT signed with the app's .p8 key
// (header {alg:'ES256', kid}, claims {iss: teamId, iat}). Tokens are cached
// for ~50 minutes (Apple rejects tokens refreshed more than once per 20 min
// and tokens older than 1 hour). Delivery is HTTP/2 to
// api.push.apple.com (production) or api.sandbox.push.apple.com (sandbox),
// one stream per push on a reused session. The sealed-payload contract is
// unchanged: APNs sees only the generic fallback alert, routing fields and
// the sealed ciphertext — never the plaintext title/body.

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** PEM contents of the .p8 key. */
  keyPem: string;
  bundleId: string;
  env: 'production' | 'sandbox';
}

/** Resolve APNs config from env. Returns null when anything required is absent. */
export function resolveApnsConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  if (!keyId || !teamId || !bundleId) return null;
  let keyPem = env.APNS_KEY_PEM?.replace(/\\n/g, '\n').trim();
  if (!keyPem && env.APNS_KEY_PATH) {
    try { keyPem = readFile(env.APNS_KEY_PATH).trim(); } catch { return null; }
  }
  if (!keyPem) return null;
  return { keyId, teamId, bundleId, keyPem, env: env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production' };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Build (but do not cache) one APNs provider JWT. Exported for tests. */
export function buildApnsJwt(config: ApnsConfig, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: nowSec }));
  const signingInput = `${header}.${claims}`;
  const sig = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: config.keyPem,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(sig)}`;
}

export class ApnsError extends Error {
  constructor(public readonly status: number, public readonly reason?: string) {
    super(`APNs send failed: HTTP ${status}${reason ? ` (${reason})` : ''}`);
    this.name = 'ApnsError';
  }
  /** 410 Unregistered / BadDeviceToken: the token should be pruned. */
  get tokenInvalid(): boolean {
    return this.status === 410 || this.reason === 'BadDeviceToken' || this.reason === 'Unregistered';
  }
}

/** Minimal HTTP/2 session abstraction (injectable for tests). */
export interface ApnsSession {
  request(headers: Record<string, string>, body: string): Promise<{ status: number; body: string }>;
  close(): void;
}
export type ApnsSessionFactory = (host: string) => ApnsSession;

export const APNS_PRODUCTION_HOST = 'https://api.push.apple.com';
export const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

export function defaultApnsSessionFactory(host: string): ApnsSession {
  const session = http2.connect(host);
  session.on('error', () => { /* surfaced per-request */ });
  return {
    request(headers, body) {
      return new Promise((resolve, reject) => {
        const req = session.request(headers);
        let status = 0;
        const chunks: Buffer[] = [];
        req.on('response', (h) => { status = Number(h[':status'] ?? 0); });
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        req.on('error', reject);
        req.end(body);
      });
    },
    close() { try { session.close(); } catch { /* ignore */ } },
  };
}

export interface PushServiceDeps {
  /** Devices that registered a push token. */
  listPushDevices: () => PushDevice[];
  /** Per-bot notification preference; default 'all'. */
  getBotPref: (botId: string) => NotificationPref;
  /** Send one FCM data message. Injected for tests. */
  sendFcm?: (token: string, data: Record<string, string>) => Promise<void>;
  /** Send one APNs message. Injected for tests; overrides the HTTP/2 path. */
  sendApns?: (token: string, message: ApnsMessage) => Promise<void>;
  /** APNs config; defaults to resolveApnsConfig() from env. */
  apnsConfig?: ApnsConfig | null;
  /** HTTP/2 session factory (tests inject a stub). */
  apnsSessionFactory?: ApnsSessionFactory;
  /** Called when a push token is permanently invalid (e.g. APNs 410) so the host can prune it. */
  onTokenPruned?: (device: PushDevice, reason: string) => void;
  log?: (msg: string) => void;
}

export interface ApnsMessage {
  headers: Record<string, string>;
  /** JSON body: generic aps alert + routing fields + sealed ciphertext only. */
  body: Record<string, unknown>;
}

const FALLBACK_TITLE = 'KriyaDot';
const FALLBACK_BODY: Record<PushKind, string> = {
  done: 'A bot finished a task. Open KriyaDot to see the result.',
  needsInput: 'A bot needs your input. Open KriyaDot to review.',
  failed: 'A bot run failed. Open KriyaDot for details.',
};

export class PushService {
  private fcmWarned = false;
  private apnsWarned = false;
  private apnsJwtCache: { token: string; mintedAtSec: number } | null = null;
  private apnsSession: ApnsSession | null = null;

  constructor(private readonly deps: PushServiceDeps) {}

  /** Whether FCM delivery is configured (credentials present or sendFcm injected). */
  get fcmEnabled(): boolean {
    if (this.deps.sendFcm) return true;
    return Boolean(process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }

  /** Whether APNs delivery is configured (sendApns injected or full env config). */
  get apnsEnabled(): boolean {
    if (this.deps.sendApns) return true;
    return this.apnsConfig() !== null;
  }

  /** Whether any push delivery path is configured. */
  get enabled(): boolean {
    return this.fcmEnabled || this.apnsEnabled;
  }

  private apnsConfig(): ApnsConfig | null {
    if (this.deps.apnsConfig !== undefined) return this.deps.apnsConfig;
    return resolveApnsConfig();
  }

  /** Cached provider JWT (refreshed after 50 minutes). */
  apnsJwt(nowSec: number = Math.floor(Date.now() / 1000)): string {
    const cfg = this.apnsConfig();
    if (!cfg) throw new Error('APNs not configured');
    if (this.apnsJwtCache && nowSec - this.apnsJwtCache.mintedAtSec < 50 * 60) return this.apnsJwtCache.token;
    const token = buildApnsJwt(cfg, nowSec);
    this.apnsJwtCache = { token, mintedAtSec: nowSec };
    return token;
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
    // Route per platform; a device whose provider is unconfigured is
    // skipped (with a one-time warning) exactly like the FCM-only no-op.
    const eligible = devices.filter((d) => (d.platform === 'ios' ? this.apnsEnabled : this.fcmEnabled));
    if (eligible.length === 0) {
      if (devices.some((d) => d.platform === 'ios') && !this.apnsEnabled && !this.apnsWarned) {
        this.apnsWarned = true;
        (this.deps.log ?? console.warn)('[push] APNs not configured — iOS push disabled (set APNS_KEY_ID/APNS_TEAM_ID/APNS_KEY_PATH/APNS_BUNDLE_ID).');
      }
      if (devices.some((d) => d.platform !== 'ios') && !this.fcmEnabled) {
        this.warnOnce('FCM not configured — push notifications disabled (set FCM_SERVICE_ACCOUNT_JSON).');
      }
      return { attempted: 0, sent: 0 };
    }

    let sent = 0;
    for (const d of eligible) {
      try {
        if (d.platform === 'ios') await this.sendApns(d, req);
        else {
          const data = this.buildDataMessage(d, req);
          await this.send(d.fcmToken, data);
        }
        sent++;
      } catch (err) {
        // Best-effort: one bad token must not break the fan-out. A
        // permanently invalid token (APNs 410) is pruned via the callback.
        if (err instanceof ApnsError && err.tokenInvalid) {
          try { this.deps.onTokenPruned?.(d, err.reason ?? `http-${err.status}`); } catch { /* ignore */ }
        }
      }
    }
    return { attempted: eligible.length, sent };
  }

  /** Build the APNs message for one iOS device (sealed when possible). */
  buildApnsMessage(device: PushDevice, req: PushRequest): ApnsMessage {
    const cfg = this.apnsConfig();
    const data = this.buildDataMessage(device, req);
    const body: Record<string, unknown> = {
      aps: { alert: { title: FALLBACK_TITLE, body: FALLBACK_BODY[req.kind] }, sound: 'default' },
      ...data,
    };
    delete body.fallbackTitle;
    delete body.fallbackBody;
    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${device.fcmToken}`,
      'apns-topic': cfg?.bundleId ?? '',
      'apns-push-type': 'alert',
      'apns-priority': req.kind === 'needsInput' ? '10' : '5',
      authorization: `bearer ${cfg ? this.apnsJwt() : ''}`,
    };
    return { headers, body };
  }

  private async sendApns(device: PushDevice, req: PushRequest): Promise<void> {
    const message = this.buildApnsMessage(device, req);
    if (this.deps.sendApns) {
      await this.deps.sendApns(device.fcmToken, message);
      return;
    }
    const cfg = this.apnsConfig();
    if (!cfg) return;
    if (!this.apnsSession) {
      const factory = this.deps.apnsSessionFactory ?? defaultApnsSessionFactory;
      this.apnsSession = factory(cfg.env === 'sandbox' ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST);
    }
    const res = await this.apnsSession.request(message.headers, JSON.stringify(message.body));
    if (res.status === 200) return;
    let reason: string | undefined;
    try { reason = (JSON.parse(res.body) as { reason?: string }).reason; } catch { /* ignore */ }
    throw new ApnsError(res.status, reason);
  }

  /** Close the reused APNs HTTP/2 session (shutdown/tests). */
  closeApns(): void {
    try { this.apnsSession?.close(); } catch { /* ignore */ }
    this.apnsSession = null;
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
