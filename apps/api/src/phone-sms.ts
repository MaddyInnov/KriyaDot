// SPDX-License-Identifier: Apache-2.0
// Direct SMS + "call from my number" on the paired phone
// (Muse parity §4.10 CT-6 / CT-7 / CT-8 / CT-9).
//
// Protocol additions (ADDITIVE — phone-PROTOCOL.md §8; older phone-agents
// answer unknown actions/queries with a clean error, never a crash):
//   action  `sms_send`    { number, text } — send an SMS directly through
//                         the phone's SmsManager (SEND_SMS permission),
//                         instead of driving a messaging app's UI.
//   action  `sms_compose` { number, text } — open the SMS composer prefilled
//                         (ACTION_SENDTO); composes only, NEVER sends.
//   action  `call`        (existing W14) — used by the packaged
//                         "call from my number" dial (CT-6).
//   query   `sms_search`  { query, limit } — archive search over SMS bodies
//                         + addresses on the phone (CT-9, READ_SMS).
//   query   `sms_thread`  { address, limit } — one conversation (CT-7 read).
//
// Governance contract (never weakened):
//   - Every send/dial tool below is require-approval via
//     phoneSmsPolicyRules(); read/search tools are require-approval too
//     (personal data, matching phone-data-tools).
//   - Draft-only mode (CT-8): when a device's texting mode is 'draft-only',
//     sendSms REFUSES to send — it stores a draft and (best-effort) opens
//     the on-phone composer prefilled. A draft can only become a send via a
//     fresh, separately approved sendSms call after the mode changes.
//   - Drafts live server-side (phone-sms.db) so they survive restarts and
//     are inspectable/revocable; draft text is stored because the user
//     asked for a draft — it is never audit-logged (audit holds metadata).
//   - The global pause refuses dispatch before anything reaches the phone.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, type BotPolicyRule, type ToolContext, type ToolDefinition } from '@mvp/agent-runtime';
import type { PhoneActionResult } from './phone.js';
import { PAUSED_MESSAGE } from './system-pause.js';
import { normalizeCallNumber } from './outbound-calls.js';

export const MAX_SMS_TEXT_LEN = 1600;

export type TextingMode = 'send' | 'draft-only';

// ---------------------------------------------------------------------------
// Dispatcher abstraction (hub in production, mock in tests)
// ---------------------------------------------------------------------------

export interface PhoneSmsDispatcher {
  dispatchAction(deviceId: string, action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<PhoneActionResult>;
  dispatchDataQuery(deviceId: string, query: string, params: Record<string, unknown>, timeoutMs?: number): Promise<PhoneActionResult>;
  isOnline(deviceId: string): boolean;
}

// ---------------------------------------------------------------------------
// Draft + mode store (phone-sms.db)
// ---------------------------------------------------------------------------

export interface SmsDraft {
  id: string;
  deviceId: string;
  number: string;
  contact?: string;
  text: string;
  createdAt: number;
  /** Why this is a draft: explicit request, or forced by draft-only mode. */
  reason: 'explicit' | 'draft-only-mode';
}

interface DraftRow { payload: string }
interface SettingRow { value: string }

export class PhoneSmsStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'phone-sms.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sms_drafts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS phone_sms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  saveDraft(d: SmsDraft): void {
    this.db.prepare('INSERT INTO sms_drafts (id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(d.id, JSON.stringify(d), d.createdAt);
  }
  getDraft(id: string): SmsDraft | undefined {
    const r = this.db.prepare('SELECT payload FROM sms_drafts WHERE id = ?').get(id) as DraftRow | undefined;
    return r ? (JSON.parse(r.payload) as SmsDraft) : undefined;
  }
  listDrafts(deviceId?: string): SmsDraft[] {
    const rows = this.db.prepare('SELECT payload FROM sms_drafts ORDER BY created_at DESC').all() as unknown as DraftRow[];
    const all = rows.map((r) => JSON.parse(r.payload) as SmsDraft);
    return deviceId ? all.filter((d) => d.deviceId === deviceId) : all;
  }
  deleteDraft(id: string): boolean {
    return this.db.prepare('DELETE FROM sms_drafts WHERE id = ?').run(id).changes > 0;
  }

  getTextingMode(deviceId: string): TextingMode {
    const r = this.db.prepare('SELECT value FROM phone_sms_settings WHERE key = ?').get(`mode:${deviceId}`) as SettingRow | undefined;
    return r?.value === 'draft-only' ? 'draft-only' : 'send';
  }
  setTextingMode(deviceId: string, mode: TextingMode): void {
    this.db.prepare('INSERT INTO phone_sms_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`mode:${deviceId}`, mode);
  }

  close(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface PhoneSmsDeps {
  store: PhoneSmsStore;
  dispatcher: PhoneSmsDispatcher;
  resolveDeviceId?: (requested?: string) => string | undefined;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  isPaused?: () => boolean;
  now?: () => number;
  timeoutMs?: number;
}

export interface SmsSendResult {
  sent: boolean;
  deviceId: string;
  draft?: SmsDraft;
  reason?: string;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function reqText(args: Record<string, unknown>): string {
  const v = args['text'];
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_SMS_TEXT_LEN) {
    throw new Error(`"text" is required (non-empty string, max ${MAX_SMS_TEXT_LEN} chars)`);
  }
  return v.trim();
}

export class PhoneSmsService {
  constructor(private readonly deps: PhoneSmsDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private audit(action: string, fields: Record<string, unknown>): void {
    try { this.deps.audit?.(action, fields); } catch { /* audit never breaks SMS */ }
  }

  private device(requested?: string): string {
    const deviceId = requested ?? this.deps.resolveDeviceId?.(undefined);
    if (!deviceId) throw httpError(409, 'no paired phone is online — open the Phone tab and connect the phone first');
    if (!this.deps.dispatcher.isOnline(deviceId)) throw httpError(409, `phone "${deviceId}" is not connected`);
    return deviceId;
  }
  private guardPaused(): void {
    if (this.deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
  }

  getTextingMode(deviceId: string): TextingMode { return this.deps.store.getTextingMode(deviceId); }
  setTextingMode(deviceId: string, mode: TextingMode): void {
    this.deps.store.setTextingMode(deviceId, mode);
    this.audit('phone_sms.texting_mode', { deviceId, mode });
  }
  listDrafts(deviceId?: string): SmsDraft[] { return this.deps.store.listDrafts(deviceId); }
  deleteDraft(id: string): boolean { return this.deps.store.deleteDraft(id); }

  /** Create a server-side draft (CT-8). Never dispatches a send. */
  createDraft(input: { deviceId?: string; number: string; text: string; contact?: string; reason?: SmsDraft['reason'] }): SmsDraft {
    const deviceId = input.deviceId ?? this.deps.resolveDeviceId?.(undefined) ?? 'unknown-device';
    const draft: SmsDraft = {
      id: `smsdraft_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      deviceId,
      number: normalizeCallNumber(input.number),
      ...(input.contact?.trim() ? { contact: input.contact.trim().slice(0, 100) } : {}),
      text: input.text,
      createdAt: this.now(),
      reason: input.reason ?? 'explicit',
    };
    this.deps.store.saveDraft(draft);
    this.audit('phone_sms.draft_created', { draftId: draft.id, deviceId, reason: draft.reason, contact: draft.contact });
    return draft;
  }

  /** Best-effort: open the on-phone composer prefilled with the draft (never sends). */
  async openComposer(draft: SmsDraft): Promise<boolean> {
    if (!this.deps.dispatcher.isOnline(draft.deviceId)) return false;
    const r = await this.deps.dispatcher.dispatchAction(draft.deviceId, 'sms_compose', { number: draft.number, text: draft.text }, this.deps.timeoutMs);
    return r.ok;
  }

  /**
   * CT-7 direct SMS send. In draft-only mode (CT-8) this REFUSES to send:
   * it stores a draft (+ opens the composer best-effort) and reports why.
   */
  async sendSms(input: { deviceId?: string; number: string; text: string; contact?: string }): Promise<SmsSendResult> {
    this.guardPaused();
    const number = normalizeCallNumber(input.number);
    const text = input.text?.trim();
    if (!text || text.length > MAX_SMS_TEXT_LEN) throw new Error(`"text" is required (max ${MAX_SMS_TEXT_LEN} chars)`);
    const deviceId = this.device(input.deviceId);
    if (this.deps.store.getTextingMode(deviceId) === 'draft-only') {
      const draft = this.createDraft({ deviceId, number, text, contact: input.contact, reason: 'draft-only-mode' });
      await this.openComposer(draft).catch(() => false);
      return { sent: false, deviceId, draft, reason: 'draft-only mode is on for this phone — the message was drafted, not sent' };
    }
    const result = await this.deps.dispatcher.dispatchAction(deviceId, 'sms_send', { number, text }, this.deps.timeoutMs);
    this.audit('phone_sms.sent', { deviceId, contact: input.contact, ok: result.ok });
    if (!result.ok) {
      throw new Error(
        result.error === 'timeout'
          ? 'the phone did not acknowledge the SMS in time (the phone-agent may be an older build without direct-SMS support)'
          : result.error === 'sms_permission_missing'
            ? 'the phone-agent does not have the SEND_SMS permission — grant it on the phone'
            : `SMS send failed: ${result.error ?? 'unknown error'}`,
      );
    }
    return { sent: true, deviceId };
  }

  /** CT-9: search the SMS archive on the paired phone. */
  async searchSms(input: { deviceId?: string; query: string; limit?: number }): Promise<unknown> {
    this.guardPaused();
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200) {
      throw new Error('"query" is required (max 200 chars)');
    }
    const deviceId = this.device(input.deviceId);
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    const result = await this.deps.dispatcher.dispatchDataQuery(deviceId, 'sms_search', { query: input.query.trim(), limit }, this.deps.timeoutMs);
    this.audit('phone_sms.search', { deviceId, ok: result.ok });
    if (!result.ok) {
      throw new Error(
        result.error === 'timeout'
          ? 'the phone did not answer the SMS search in time (the phone-agent may be an older build without archive search)'
          : `SMS search failed: ${result.error ?? 'unknown error'}`,
      );
    }
    return result.data ?? { messages: [] };
  }

  /** CT-7 read: one SMS conversation thread by address/number. */
  async readThread(input: { deviceId?: string; address: string; limit?: number }): Promise<unknown> {
    this.guardPaused();
    const deviceId = this.device(input.deviceId);
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    const result = await this.deps.dispatcher.dispatchDataQuery(deviceId, 'sms_thread', { address: input.address, limit }, this.deps.timeoutMs);
    this.audit('phone_sms.thread_read', { deviceId, ok: result.ok });
    if (!result.ok) throw new Error(`SMS thread read failed: ${result.error ?? 'unknown error'}`);
    return result.data ?? { messages: [] };
  }

  /**
   * CT-6: packaged "call from my number" — dials from the user's own paired
   * phone via the existing approved `call` action. The companion card
   * (buildTapToCallCard) is what the web UI renders for one-tap dialing.
   */
  async dialFromMyNumber(input: { deviceId?: string; number: string; contact?: string }): Promise<{ deviceId: string; number: string }> {
    this.guardPaused();
    const number = normalizeCallNumber(input.number);
    const deviceId = this.device(input.deviceId);
    const result = await this.deps.dispatcher.dispatchAction(deviceId, 'call', { number, ...(input.contact ? { contact: input.contact } : {}) }, this.deps.timeoutMs);
    this.audit('phone_sms.dial_from_my_number', { deviceId, contact: input.contact, ok: result.ok });
    if (!result.ok) throw new Error(`dial failed: ${result.error ?? 'unknown error'}`);
    return { deviceId, number };
  }
}

/** CT-6 tap-to-call card payload (rendered by the web TapToCallCard component). */
export interface TapToCallCard {
  kind: 'tap-to-call';
  title: string;
  counterpartyName?: string;
  number: string;
  /** tel: deep link for clients that can dial natively. */
  telUri: string;
  /** The packaged phone-agent dispatch the card's button performs (after approval). */
  dispatch: { action: 'call'; params: { number: string; contact?: string } };
  note: string;
}

export function buildTapToCallCard(input: { number: string; counterpartyName?: string }): TapToCallCard {
  const number = normalizeCallNumber(input.number);
  return {
    kind: 'tap-to-call',
    title: input.counterpartyName ? `Call ${input.counterpartyName}` : `Call ${number}`,
    ...(input.counterpartyName ? { counterpartyName: input.counterpartyName } : {}),
    number,
    telUri: `tel:${number}`,
    dispatch: { action: 'call', params: { number, ...(input.counterpartyName ? { contact: input.counterpartyName } : {}) } },
    note: 'Dials from your own number via your paired phone. Tapping raises an approval first.',
  };
}

// ---------------------------------------------------------------------------
// Tools + governance policy
// ---------------------------------------------------------------------------

export const PHONE_SMS_TOOL_NAMES = [
  'phone_sms_send',
  'phone_sms_draft',
  'phone_sms_search',
  'phone_sms_thread',
  'call_from_my_number',
] as const;

/** Governance: sends/dials always ask; reads/search ask too (personal data). */
export function phoneSmsPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'phone-sms-approval',
      toolPattern: '^phone_sms_(send|search|thread)$',
      effect: 'require-approval',
      reason:
        'Sending an SMS from the user\'s own phone, or reading/searching their SMS archive, is an external/personal action; needs human approval. The approval card shows the exact number and text (for sends).',
    },
    {
      id: 'call-from-my-number-approval',
      toolPattern: '^call_from_my_number$',
      effect: 'require-approval',
      reason: 'Dialing from the user\'s own number via their paired phone changes state on a personal device and places a real call; needs human approval.',
    },
  ];
}

export interface PhoneSmsToolDeps { service: PhoneSmsService }

function optDeviceId(args: Record<string, unknown>): string | undefined {
  const v = args['deviceId'];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 128 || !/^[A-Za-z0-9_:-]+$/.test(v)) throw new Error('"deviceId" is invalid');
  return v;
}

export function createPhoneSmsTools(deps: PhoneSmsToolDeps): ToolDefinition[] {
  const { service } = deps;
  const deviceProp = { type: 'string', description: 'Paired device id (optional; defaults to the online phone)' };
  return [
    {
      name: 'phone_sms_send',
      mutating: true,
      description: 'Send an SMS directly from the user\'s paired phone (via the phone\'s own SMS service, not by driving a messaging app). Requires human approval — the card shows the exact number and text. In draft-only mode this drafts instead of sending and says so.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Destination phone number' },
          text: { type: 'string', description: 'The exact SMS text to send' },
          contact: { type: 'string', description: 'Contact name (audit label, optional)' },
          deviceId: deviceProp,
        },
        required: ['number', 'text'], additionalProperties: false,
      },
      handler: async (args) => service.sendSms({
        deviceId: optDeviceId(args), number: args['number'] as string, text: reqText(args),
        contact: typeof args['contact'] === 'string' ? (args['contact'] as string) : undefined,
      }),
    },
    {
      name: 'phone_sms_draft',
      description: 'Draft an SMS (saved server-side + opens the prefilled composer on the paired phone when online). NEVER sends. Use when the user wants to review/edit before any send, or in draft-only contexts.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Destination phone number' },
          text: { type: 'string', description: 'Draft text' },
          contact: { type: 'string', description: 'Contact name (optional)' },
          deviceId: deviceProp,
        },
        required: ['number', 'text'], additionalProperties: false,
      },
      handler: async (args) => {
        const draft = service.createDraft({
          deviceId: optDeviceId(args), number: args['number'] as string, text: reqText(args),
          contact: typeof args['contact'] === 'string' ? (args['contact'] as string) : undefined,
        });
        const composerOpened = await service.openComposer(draft).catch(() => false);
        return { ok: true, draft, composerOpened, sent: false };
      },
    },
    {
      name: 'phone_sms_search',
      description: 'Search the SMS archive on the user\'s paired phone by text (matches message bodies and addresses). Requires human approval (personal data).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          limit: { type: 'number', description: 'Max results (1–200, default 50)' },
          deviceId: deviceProp,
        },
        required: ['query'], additionalProperties: false,
      },
      handler: async (args) => ({
        ok: true,
        data: await service.searchSms({ deviceId: optDeviceId(args), query: args['query'] as string, limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined }),
      }),
    },
    {
      name: 'phone_sms_thread',
      description: 'Read one SMS conversation thread on the user\'s paired phone by address/number. Requires human approval (personal data).',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Phone number / address of the thread' },
          limit: { type: 'number', description: 'Max messages (1–200, default 50)' },
          deviceId: deviceProp,
        },
        required: ['address'], additionalProperties: false,
      },
      handler: async (args) => ({
        ok: true,
        data: await service.readThread({ deviceId: optDeviceId(args), address: args['address'] as string, limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined }),
      }),
    },
    {
      name: 'call_from_my_number',
      mutating: true,
      description: 'Place a call FROM the user\'s own number via their paired phone (the packaged CT-6 dial). Requires human approval.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Number to call' },
          contact: { type: 'string', description: 'Contact name (audit label, optional)' },
          deviceId: deviceProp,
        },
        required: ['number'], additionalProperties: false,
      },
      handler: async (args) => ({
        ok: true,
        ...(await service.dialFromMyNumber({
          deviceId: optDeviceId(args), number: args['number'] as string,
          contact: typeof args['contact'] === 'string' ? (args['contact'] as string) : undefined,
        })),
        card: buildTapToCallCard({ number: args['number'] as string, counterpartyName: typeof args['contact'] === 'string' ? (args['contact'] as string) : undefined }),
      }),
    },
  ];
}

/** Register the phone-SMS tools into a registry (skips collisions). */
export function registerPhoneSmsTools(registry: Map<string, ToolDefinition>, deps: PhoneSmsToolDeps): void {
  for (const tool of createPhoneSmsTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
