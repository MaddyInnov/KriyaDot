// SPDX-License-Identifier: Apache-2.0
// Packaged outbound business calling (Muse parity §4.10 CT-1..CT-5).
//
// The flow a user actually experiences:
//   1. BRIEF — a bot (or the UI) drafts a call brief: counterparty name +
//      number, purpose, talking points, and a per-call script sheet
//      (CT-3: voice pick, AI-disclosure opening line, guardrails, closing).
//   2. APPROVAL — nothing dials without authorization, exactly one of:
//        a. a governance approval card for THIS brief, approved by a human
//           (the purchases pattern: create never executes; execution checks
//           the linked approval is genuinely 'approved'), or
//        b. a bounded ONE-CALL pre-approval (CT-4) created by the user,
//           bound to the exact normalized number + counterparty name,
//           single-use, expiring — consumed atomically at dial time.
//      There is no always-allow for calls and no code path that dials from
//      'draft' / 'pending-approval' / 'denied'.
//   3. CALL — placed through the telephony provider interface
//      (telephony.ts; mock by default, Twilio-class adapter env-gated).
//      While a call is live the user can be brought in (CT-5, provider
//      permitting).
//   4. REPORT — a deterministic report (outcome, duration, transcript) is
//      composed and delivered back into chat via the injected deliverer,
//      and the whole lifecycle is audit-logged. Mock-provider reports are
//      labelled SIMULATED so they can never pass as real calls.
//
// CT-2 scheduled calls sit on top: a scheduled entry binds a brief to a
// fire time (+ optionally a routine id, and a once-schedule built with the
// real routine-schedules validator for the coordinator to attach to a
// BotRoutine). At fire time authorization is re-evaluated — scheduling
// never smuggles approval past the fire moment.
//
// Storage: <dataDir>/outbound-calls.db (node:sqlite via openDb).

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, type BotPolicyRule, type ToolContext, type ToolDefinition } from '@mvp/agent-runtime';
import type { ProviderCall, TelephonyProvider, TelephonyScript, TranscriptTurn } from './telephony.js';
import { validateRoutineSchedule, type RoutineSchedule } from './routine-schedules.js';

// ---------------------------------------------------------------------------
// Validation + script sheet (CT-3)
// ---------------------------------------------------------------------------

const NUMBER_STRIP_RE = /[\s()\-./]/g;

/** Normalize a phone number for exact binding: keep a leading +, digits only otherwise. */
export function normalizeCallNumber(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('"number" must be a string');
  const stripped = raw.trim().replace(NUMBER_STRIP_RE, '');
  if (!/^\+?\d{5,15}$/.test(stripped)) {
    throw new Error('"number" must be a phone number (5–15 digits, optional leading +)');
  }
  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}

export function normalizeCounterparty(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('"counterpartyName" is required');
  return raw.trim().slice(0, 120);
}

/** Comparison key for counterparty binding (case/space-insensitive). */
export function counterpartyKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const CALL_GUARDRAILS: readonly string[] = [
  'Disclose at the start that this is an AI assistant calling on behalf of the user.',
  'Never claim to be a human being.',
  'Never promise payment, a discount, or a contract term the brief does not state.',
  'Never share credentials, payment details, or personal data beyond the brief.',
  'If the counterparty asks to speak to the user directly, offer the callback bring-in or end politely.',
  'Stay on the talking points; if asked something outside them, say the user will follow up.',
];

export interface ScriptSheet extends TelephonyScript {
  counterpartyName: string;
  purpose: string;
  /** Voice pick (CT-3): TTS voice id chosen for this call, free-form per catalog. */
  voiceId?: string;
  callerType: 'ai';
}

export interface CallBriefInput {
  botId: string;
  counterpartyName: string;
  number: string;
  purpose: string;
  talkingPoints?: string[];
  openingLine?: string;
  closingLine?: string;
  voiceId?: string;
  maxDurationSec?: number;
}

/** Build the per-call script sheet (CT-3) from a brief. Pure + deterministic. */
export function buildScriptSheet(input: {
  counterpartyName: string;
  purpose: string;
  talkingPoints?: string[];
  openingLine?: string;
  closingLine?: string;
  voiceId?: string;
  botName?: string;
}): ScriptSheet {
  const points = (input.talkingPoints ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 8);
  if (points.length === 0) points.push(input.purpose);
  const caller = input.botName?.trim() ? `${input.botName}` : 'an AI assistant';
  return {
    counterpartyName: input.counterpartyName,
    purpose: input.purpose,
    talkingPoints: points,
    openingLine:
      input.openingLine?.trim() ||
      `Hello, this is ${caller}, an AI assistant calling on behalf of my user. I'm calling about ${input.purpose}. Is now a good moment?`,
    closingLine:
      input.closingLine?.trim() ||
      'Thank you for your time. My user will receive a full report of this call. Goodbye.',
    guardrails: [...CALL_GUARDRAILS],
    ...(input.voiceId?.trim() ? { voiceId: input.voiceId.trim().slice(0, 80) } : {}),
    callerType: 'ai',
  };
}

function validateBriefInput(raw: CallBriefInput): Required<Omit<CallBriefInput, 'talkingPoints' | 'openingLine' | 'closingLine' | 'voiceId'>> & CallBriefInput {
  if (typeof raw.botId !== 'string' || !raw.botId.trim()) throw new Error('"botId" is required');
  if (typeof raw.purpose !== 'string' || !raw.purpose.trim()) throw new Error('"purpose" is required');
  const maxDurationSec = raw.maxDurationSec === undefined ? 600 : raw.maxDurationSec;
  if (typeof maxDurationSec !== 'number' || !Number.isFinite(maxDurationSec) || maxDurationSec < 30 || maxDurationSec > 1800) {
    throw new Error('"maxDurationSec" must be between 30 and 1800');
  }
  return {
    ...raw,
    botId: raw.botId.trim(),
    counterpartyName: normalizeCounterparty(raw.counterpartyName),
    number: normalizeCallNumber(raw.number),
    purpose: raw.purpose.trim().slice(0, 500),
    maxDurationSec,
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type CallBriefStatus = 'draft' | 'pending-approval' | 'approved' | 'denied' | 'placed' | 'completed' | 'failed';

export interface CallBrief {
  id: string;
  botId: string;
  counterpartyName: string;
  number: string;
  purpose: string;
  scriptSheet: ScriptSheet;
  maxDurationSec: number;
  status: CallBriefStatus;
  approvalId?: string;
  preApprovalId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CallPreApproval {
  id: string;
  /** Exact normalized number this pre-approval is bound to. */
  number: string;
  /** Exact counterparty (display form; matching uses counterpartyKey). */
  counterpartyName: string;
  maxDurationSec: number;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  consumedByBriefId?: string;
  revokedAt?: number;
}

export interface CallReport {
  briefId: string;
  providerCallId: string;
  providerId: string;
  status: ProviderCall['status'];
  simulated: boolean;
  durationSec?: number;
  transcript: TranscriptTurn[];
  participants: string[];
  /** One-paragraph plain-language outcome for the chat report-back. */
  summary: string;
  completedAt: number;
}

export interface CallRecord {
  briefId: string;
  providerCallId: string;
  providerId: string;
  status: ProviderCall['status'];
  simulated: boolean;
  startedAt: number;
  report?: CallReport;
}

export type ScheduledCallStatus = 'pending' | 'fired' | 'blocked' | 'cancelled';

export interface ScheduledCall {
  id: string;
  briefId: string;
  runAt: number;
  routineId?: string;
  status: ScheduledCallStatus;
  reason?: string;
  callBriefId?: string;
  createdAt: number;
}

interface BriefRow { id: string; payload: string }
interface PreRow { id: string; payload: string }
interface RecordRow { brief_id: string; payload: string }
interface SchedRow { id: string; payload: string }

export class OutboundCallStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'outbound-calls.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS call_briefs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS call_preapprovals (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS call_records (brief_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_calls (id TEXT PRIMARY KEY, payload TEXT NOT NULL, run_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sched_run ON scheduled_calls (run_at);
    `);
  }

  saveBrief(brief: CallBrief): void {
    this.db.prepare('INSERT INTO call_briefs (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(brief.id, JSON.stringify(brief));
  }
  getBrief(id: string): CallBrief | undefined {
    const r = this.db.prepare('SELECT payload FROM call_briefs WHERE id = ?').get(id) as BriefRow | undefined;
    return r ? (JSON.parse(r.payload) as CallBrief) : undefined;
  }
  listBriefs(limit = 100): CallBrief[] {
    const rows = this.db.prepare('SELECT payload FROM call_briefs').all() as unknown as BriefRow[];
    return rows.map((r) => JSON.parse(r.payload) as CallBrief)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(500, limit)));
  }

  savePreApproval(p: CallPreApproval): void {
    this.db.prepare('INSERT INTO call_preapprovals (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(p.id, JSON.stringify(p));
  }
  getPreApproval(id: string): CallPreApproval | undefined {
    const r = this.db.prepare('SELECT payload FROM call_preapprovals WHERE id = ?').get(id) as PreRow | undefined;
    return r ? (JSON.parse(r.payload) as CallPreApproval) : undefined;
  }
  listPreApprovals(): CallPreApproval[] {
    const rows = this.db.prepare('SELECT payload FROM call_preapprovals').all() as unknown as PreRow[];
    return rows.map((r) => JSON.parse(r.payload) as CallPreApproval).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Find + atomically consume the one-call pre-approval bound to this exact
   * number + counterparty (CT-4). Single-use: a consumed, revoked or expired
   * pre-approval never matches twice. Duration cap: the brief's cap must be
   * within the pre-approval's cap.
   */
  consumePreApproval(number: string, counterpartyName: string, maxDurationSec: number, briefId: string, now: number): CallPreApproval | undefined {
    const key = counterpartyKey(counterpartyName);
    for (const p of this.listPreApprovals()) {
      if (p.number !== number || counterpartyKey(p.counterpartyName) !== key) continue;
      if (p.consumedAt || p.revokedAt || p.expiresAt <= now) continue;
      if (maxDurationSec > p.maxDurationSec) continue;
      const consumed: CallPreApproval = { ...p, consumedAt: now, consumedByBriefId: briefId };
      this.savePreApproval(consumed);
      return consumed;
    }
    return undefined;
  }

  saveRecord(rec: CallRecord): void {
    this.db.prepare('INSERT INTO call_records (brief_id, payload) VALUES (?, ?) ON CONFLICT(brief_id) DO UPDATE SET payload = excluded.payload')
      .run(rec.briefId, JSON.stringify(rec));
  }
  getRecord(briefId: string): CallRecord | undefined {
    const r = this.db.prepare('SELECT payload FROM call_records WHERE brief_id = ?').get(briefId) as RecordRow | undefined;
    return r ? (JSON.parse(r.payload) as CallRecord) : undefined;
  }

  saveScheduled(s: ScheduledCall): void {
    this.db.prepare('INSERT INTO scheduled_calls (id, payload, run_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, run_at = excluded.run_at')
      .run(s.id, JSON.stringify(s), s.runAt);
  }
  getScheduled(id: string): ScheduledCall | undefined {
    const r = this.db.prepare('SELECT payload FROM scheduled_calls WHERE id = ?').get(id) as SchedRow | undefined;
    return r ? (JSON.parse(r.payload) as ScheduledCall) : undefined;
  }
  listScheduled(): ScheduledCall[] {
    const rows = this.db.prepare('SELECT payload FROM scheduled_calls ORDER BY run_at ASC').all() as unknown as SchedRow[];
    return rows.map((r) => JSON.parse(r.payload) as ScheduledCall);
  }
  dueScheduled(now: number): ScheduledCall[] {
    return this.listScheduled().filter((s) => s.status === 'pending' && s.runAt <= now);
  }

  close(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// Report composition (deterministic — the bot never invents an outcome)
// ---------------------------------------------------------------------------

export function composeCallReport(brief: CallBrief, call: ProviderCall, providerId: string, now: number): CallReport {
  const lastCounterparty = [...call.transcript].reverse().find((t) => t.speaker === 'counterparty')?.text;
  const outcome =
    call.status === 'completed' ? 'The call completed.'
    : call.status === 'no-answer' ? 'There was no answer.'
    : `The call failed${call.failureReason ? `: ${call.failureReason}` : '.'}`;
  const summary =
    `${outcome} Called ${brief.counterpartyName} about: ${brief.purpose}.` +
    (call.durationSec !== undefined ? ` Duration ${call.durationSec}s.` : '') +
    (lastCounterparty ? ` Last thing they said: "${lastCounterparty}"` : '') +
    (call.simulated ? ' NOTE: this was a SIMULATED call on the mock provider — no real call took place.' : '');
  return {
    briefId: brief.id,
    providerCallId: call.providerCallId,
    providerId,
    status: call.status,
    simulated: call.simulated,
    ...(call.durationSec !== undefined ? { durationSec: call.durationSec } : {}),
    transcript: call.transcript,
    participants: call.participants,
    summary,
    completedAt: now,
  };
}

/** The chat report-back text (CT-1 step 4). */
export function callReportChatText(brief: CallBrief, report: CallReport): string {
  const lines = [
    `📞 Call report — ${brief.counterpartyName}`,
    report.summary,
  ];
  if (report.transcript.length > 0) {
    lines.push('Transcript:');
    for (const t of report.transcript) {
      lines.push(`- ${t.speaker === 'agent' ? 'Agent' : t.speaker === 'counterparty' ? brief.counterpartyName : 'System'}: ${t.text}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface OutboundCallDeps {
  store: OutboundCallStore;
  provider: TelephonyProvider;
  /** Raise a governance approval card for a brief; returns the approval id. */
  raiseApproval: (brief: CallBrief) => Promise<string> | string;
  /** Live status of a governance approval: 'approved' | 'denied' | 'pending' | undefined. */
  approvalStatus: (approvalId: string) => string | undefined;
  /** Report-back into chat (injected; stubbed in tests). */
  deliverChat: (args: { botId: string; text: string; briefId: string }) => Promise<void> | void;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  isPaused?: () => boolean;
  now?: () => number;
  botName?: (botId: string) => string | undefined;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export class OutboundCallService {
  constructor(private readonly deps: OutboundCallDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private audit(action: string, fields: Record<string, unknown>): void {
    try { this.deps.audit?.(action, fields); } catch { /* audit never breaks calls */ }
  }

  /** Step 1: draft a brief + its script sheet. Creates NOTHING outbound. */
  createBrief(input: CallBriefInput): CallBrief {
    const v = validateBriefInput(input);
    const now = this.now();
    const brief: CallBrief = {
      id: `cbrief_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      botId: v.botId,
      counterpartyName: v.counterpartyName,
      number: v.number,
      purpose: v.purpose,
      scriptSheet: buildScriptSheet({
        counterpartyName: v.counterpartyName, purpose: v.purpose,
        talkingPoints: v.talkingPoints, openingLine: v.openingLine, closingLine: v.closingLine,
        voiceId: v.voiceId, botName: this.deps.botName?.(v.botId),
      }),
      maxDurationSec: v.maxDurationSec,
      status: 'draft',
      createdAt: now, updatedAt: now,
    };
    this.deps.store.saveBrief(brief);
    this.audit('outbound_call.brief_created', { briefId: brief.id, botId: brief.botId, counterparty: brief.counterpartyName });
    return brief;
  }

  getBrief(id: string): CallBrief | undefined { return this.deps.store.getBrief(id); }
  listBriefs(limit?: number): CallBrief[] { return this.deps.store.listBriefs(limit); }
  getRecord(briefId: string): CallRecord | undefined { return this.deps.store.getRecord(briefId); }

  /** CT-3: the pre-call script sheet for review/edit before approval. */
  getScriptSheet(briefId: string): ScriptSheet {
    const brief = this.mustBrief(briefId);
    return brief.scriptSheet;
  }

  /** Revise voice/opening/closing/talking points while the brief is not yet placed. */
  updateScriptSheet(briefId: string, patch: Partial<Pick<ScriptSheet, 'voiceId' | 'openingLine' | 'closingLine' | 'talkingPoints'>>): ScriptSheet {
    const brief = this.mustBrief(briefId);
    if (brief.status === 'placed' || brief.status === 'completed') throw httpError(409, 'the call has already been placed; the script sheet is frozen');
    brief.scriptSheet = buildScriptSheet({
      counterpartyName: brief.counterpartyName, purpose: brief.purpose,
      talkingPoints: patch.talkingPoints ?? brief.scriptSheet.talkingPoints,
      openingLine: patch.openingLine ?? brief.scriptSheet.openingLine,
      closingLine: patch.closingLine ?? brief.scriptSheet.closingLine,
      voiceId: patch.voiceId ?? brief.scriptSheet.voiceId,
      botName: this.deps.botName?.(brief.botId),
    });
    brief.updatedAt = this.now();
    this.deps.store.saveBrief(brief);
    return brief.scriptSheet;
  }

  /** Step 2a: raise the governance approval card for this exact brief. */
  async requestApproval(briefId: string): Promise<CallBrief> {
    const brief = this.mustBrief(briefId);
    if (brief.status === 'placed' || brief.status === 'completed') throw httpError(409, 'call already placed');
    const approvalId = await this.deps.raiseApproval(brief);
    brief.approvalId = approvalId;
    brief.status = 'pending-approval';
    brief.updatedAt = this.now();
    this.deps.store.saveBrief(brief);
    this.audit('outbound_call.approval_requested', { briefId, approvalId });
    return brief;
  }

  // -- CT-4: bounded one-call pre-approvals --------------------------------

  createPreApproval(input: { number: string; counterpartyName: string; maxDurationSec?: number; ttlMs?: number }): CallPreApproval {
    const maxDurationSec = input.maxDurationSec === undefined ? 600 : input.maxDurationSec;
    if (typeof maxDurationSec !== 'number' || maxDurationSec < 30 || maxDurationSec > 1800) {
      throw new Error('"maxDurationSec" must be between 30 and 1800');
    }
    const ttlMs = input.ttlMs === undefined ? 7 * 24 * 3600_000 : input.ttlMs;
    if (typeof ttlMs !== 'number' || ttlMs <= 0 || ttlMs > 30 * 24 * 3600_000) {
      throw new Error('"ttlMs" must be within (0, 30 days]');
    }
    const now = this.now();
    const p: CallPreApproval = {
      id: `cpre_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      number: normalizeCallNumber(input.number),
      counterpartyName: normalizeCounterparty(input.counterpartyName),
      maxDurationSec,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.deps.store.savePreApproval(p);
    this.audit('outbound_call.preapproval_created', { preApprovalId: p.id, counterparty: p.counterpartyName, expiresAt: p.expiresAt });
    return p;
  }

  revokePreApproval(id: string): CallPreApproval {
    const p = this.deps.store.getPreApproval(id);
    if (!p) throw httpError(404, `unknown pre-approval "${id}"`);
    const next = { ...p, revokedAt: this.now() };
    this.deps.store.savePreApproval(next);
    return next;
  }
  listPreApprovals(): CallPreApproval[] { return this.deps.store.listPreApprovals(); }

  // -- Steps 3+4: place, bring-in, finish, report ---------------------------

  /**
   * Authorization gate — the ONLY ways a call may dial:
   *  (a) the brief's linked governance approval is genuinely 'approved', or
   *  (b) a matching one-call pre-approval is consumed (CT-4).
   * Returns how the call was authorized. Throws 403 otherwise.
   */
  private authorize(brief: CallBrief): { via: 'approval' | 'pre-approval'; preApprovalId?: string } {
    if (brief.approvalId) {
      const status = this.deps.approvalStatus(brief.approvalId);
      if (status === 'approved') return { via: 'approval' };
      if (status === 'denied') {
        brief.status = 'denied'; brief.updatedAt = this.now(); this.deps.store.saveBrief(brief);
        throw httpError(403, 'the approval for this call was denied — it will not be placed');
      }
    }
    const consumed = this.deps.store.consumePreApproval(brief.number, brief.counterpartyName, brief.maxDurationSec, brief.id, this.now());
    if (consumed) return { via: 'pre-approval', preApprovalId: consumed.id };
    throw httpError(403, 'call is not authorized: it needs an approved approval card or a matching one-call pre-approval (number + counterparty)');
  }

  /** Step 3: place the call (authorization-checked), then step 4 when it ends. */
  async placeCall(briefId: string): Promise<CallRecord> {
    const brief = this.mustBrief(briefId);
    if (this.deps.isPaused?.()) throw httpError(423, 'system is paused — outbound calls are refused while paused');
    if (brief.status === 'placed') throw httpError(409, 'this brief has already been placed (one call per brief)');
    if (brief.status === 'completed' || brief.status === 'failed') throw httpError(409, `this brief is already ${brief.status}`);
    if (!this.deps.provider.configured) {
      throw httpError(400, `telephony provider "${this.deps.provider.id}" is not configured${this.deps.provider.hint ? `: ${this.deps.provider.hint}` : ''}`);
    }
    const auth = this.authorize(brief);
    if (auth.preApprovalId) brief.preApprovalId = auth.preApprovalId;
    brief.status = 'approved';
    this.deps.store.saveBrief(brief);

    const placed = await this.deps.provider.placeCall({
      to: brief.number,
      counterpartyName: brief.counterpartyName,
      purpose: brief.purpose,
      script: brief.scriptSheet,
      maxDurationSec: brief.maxDurationSec,
      correlationId: brief.id,
    });
    const record: CallRecord = {
      briefId: brief.id,
      providerCallId: placed.providerCallId,
      providerId: this.deps.provider.id,
      status: placed.status,
      simulated: placed.simulated,
      startedAt: this.now(),
    };
    this.deps.store.saveRecord(record);
    brief.status = 'placed';
    brief.updatedAt = this.now();
    this.deps.store.saveBrief(brief);
    this.audit('outbound_call.placed', {
      briefId: brief.id, provider: this.deps.provider.id, providerCallId: placed.providerCallId,
      authorizedVia: auth.via, simulated: placed.simulated, counterparty: brief.counterpartyName,
    });
    if (placed.status !== 'in-progress') {
      await this.finalize(brief, placed);
    }
    return this.deps.store.getRecord(brief.id) ?? record;
  }

  /** CT-5: bring a participant (usually the user) into a live call. */
  async bringIn(briefId: string, participantNumber: string): Promise<CallRecord> {
    const brief = this.mustBrief(briefId);
    const record = this.deps.store.getRecord(briefId);
    if (!record) throw httpError(404, 'no call has been placed for this brief');
    if (record.status !== 'in-progress') throw httpError(409, 'bring-in requires a live (in-progress) call');
    const number = normalizeCallNumber(participantNumber);
    const updated = await this.deps.provider.addParticipant(record.providerCallId, number);
    record.status = updated.status;
    this.deps.store.saveRecord(record);
    this.audit('outbound_call.bring_in', { briefId, providerCallId: record.providerCallId, participants: updated.participants.length });
    if (updated.status !== 'in-progress') await this.finalize(brief, updated);
    return this.deps.store.getRecord(briefId) ?? record;
  }

  /** Poll/finish a live call: fetch provider state; finalize + report when ended. */
  async refreshCall(briefId: string): Promise<CallRecord> {
    const brief = this.mustBrief(briefId);
    const record = this.deps.store.getRecord(briefId);
    if (!record) throw httpError(404, 'no call has been placed for this brief');
    if (record.status !== 'in-progress') return record;
    const current = await this.deps.provider.getCall(record.providerCallId);
    record.status = current.status;
    this.deps.store.saveRecord(record);
    if (current.status !== 'in-progress') await this.finalize(brief, current);
    return this.deps.store.getRecord(briefId) ?? record;
  }

  async endCall(briefId: string): Promise<CallRecord> {
    const record = this.deps.store.getRecord(briefId);
    if (!record) throw httpError(404, 'no call has been placed for this brief');
    if (record.status === 'in-progress') {
      await this.deps.provider.hangup(record.providerCallId);
      return this.refreshCall(briefId);
    }
    return record;
  }

  private async finalize(brief: CallBrief, call: ProviderCall): Promise<void> {
    const record = this.deps.store.getRecord(brief.id);
    if (!record || record.report) return; // report exactly once
    const report = composeCallReport(brief, call, this.deps.provider.id, this.now());
    record.status = call.status;
    record.report = report;
    this.deps.store.saveRecord(record);
    brief.status = call.status === 'completed' ? 'completed' : 'failed';
    brief.updatedAt = this.now();
    this.deps.store.saveBrief(brief);
    this.audit('outbound_call.report', { briefId: brief.id, status: call.status, simulated: call.simulated });
    try {
      await this.deps.deliverChat({ botId: brief.botId, text: callReportChatText(brief, report), briefId: brief.id });
    } catch { /* report is stored; chat delivery is best-effort */ }
  }

  // -- CT-2: scheduled calls -------------------------------------------------

  scheduleCall(briefId: string, runAt: number, opts: { routineId?: string } = {}): ScheduledCall {
    const brief = this.mustBrief(briefId);
    if (typeof runAt !== 'number' || !Number.isFinite(runAt) || runAt <= 0) throw new Error('"runAt" must be an epoch-ms time');
    const entry: ScheduledCall = {
      id: `csched_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      briefId: brief.id,
      runAt,
      ...(opts.routineId ? { routineId: opts.routineId } : {}),
      status: 'pending',
      createdAt: this.now(),
    };
    this.deps.store.saveScheduled(entry);
    this.audit('outbound_call.scheduled', { briefId, scheduledId: entry.id, runAt, routineId: opts.routineId });
    return entry;
  }

  cancelScheduled(id: string): ScheduledCall {
    const s = this.deps.store.getScheduled(id);
    if (!s) throw httpError(404, `unknown scheduled call "${id}"`);
    const next = { ...s, status: 'cancelled' as const };
    this.deps.store.saveScheduled(next);
    return next;
  }
  listScheduled(): ScheduledCall[] { return this.deps.store.listScheduled(); }

  /**
   * Fire due scheduled calls. Authorization is evaluated AT FIRE TIME: a
   * scheduled call whose approval is still pending (and with no matching
   * pre-approval) is marked 'blocked', never dialed.
   */
  async tickScheduled(nowMs?: number): Promise<ScheduledCall[]> {
    const now = nowMs ?? this.now();
    const fired: ScheduledCall[] = [];
    for (const entry of this.deps.store.dueScheduled(now)) {
      try {
        await this.placeCall(entry.briefId);
        const next = { ...entry, status: 'fired' as const, callBriefId: entry.briefId };
        this.deps.store.saveScheduled(next);
        fired.push(next);
      } catch (err) {
        const next = { ...entry, status: 'blocked' as const, reason: err instanceof Error ? err.message : 'blocked' };
        this.deps.store.saveScheduled(next);
        fired.push(next);
      }
    }
    return fired;
  }

  private mustBrief(id: string): CallBrief {
    const brief = this.deps.store.getBrief(id);
    if (!brief) throw httpError(404, `unknown call brief "${id}"`);
    return brief;
  }
}

/** A once-schedule for a scheduled call, validated by the real routine validator (CT-2 routine binding). */
export function buildScheduledCallRoutineSchedule(runAt: number, timeZone = 'UTC'): RoutineSchedule {
  return validateRoutineSchedule({
    kind: 'once',
    runAt: new Date(runAt).toISOString(),
    timezone: timeZone,
    enabled: true,
    overlap: 'skip',
  });
}

/** The routine prompt a coordinator attaches to a BotRoutine for a scheduled call (CT-2). */
export function scheduledCallRoutinePrompt(brief: CallBrief, scheduledId: string): string {
  return [
    `Place the scheduled outbound call for brief ${brief.id} (scheduled entry ${scheduledId}).`,
    `Use the request_outbound_call tool with briefId "${brief.id}" — it dials only if the call's approval is approved or a one-call pre-approval matches; otherwise report that the scheduled call was blocked and why.`,
    `Counterparty: ${brief.counterpartyName}. Purpose: ${brief.purpose}.`,
    'After the call, relay the call report in this chat.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Agent tool + governance policy
// ---------------------------------------------------------------------------

export const OUTBOUND_CALL_TOOL_NAME = 'request_outbound_call';

/** Governance: outbound calls are mutating + external — approval first, always. */
export function outboundCallPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'outbound-call-approval',
      toolPattern: `^${OUTBOUND_CALL_TOOL_NAME}$`,
      effect: 'require-approval',
      reason:
        'Placing a real outbound phone call to a third party always needs human authorization: either the approval card for the exact brief, or a bounded one-call pre-approval bound to the number + counterparty. There is no always-allow for calls.',
    },
  ];
}

export interface OutboundCallToolDeps {
  service: OutboundCallService;
}

export function createOutboundCallTool(deps: OutboundCallToolDeps): ToolDefinition {
  const { service } = deps;
  return {
    name: OUTBOUND_CALL_TOOL_NAME,
    mutating: true,
    description:
      'Draft an outbound business call and, once authorized, place it. With no briefId: creates a call brief + script sheet and raises its approval card (nothing dials yet). With a briefId: places that brief\'s call — only when its approval is approved or a one-call pre-approval matches the exact number + counterparty — and returns the call report. Optional scheduledFor (epoch ms) schedules the call instead of placing it now.',
    parameters: {
      type: 'object',
      properties: {
        briefId: { type: 'string', description: 'Existing brief to place/schedule (omit to draft a new brief)' },
        counterpartyName: { type: 'string', description: 'Who is being called (person or business name)' },
        number: { type: 'string', description: 'Phone number to call' },
        purpose: { type: 'string', description: 'Why the call is being made' },
        talkingPoints: { type: 'array', items: { type: 'string' }, description: 'Points the agent must cover' },
        openingLine: { type: 'string', description: 'Optional custom opening line (AI disclosure is enforced by the script sheet guardrails)' },
        voiceId: { type: 'string', description: 'Optional TTS voice id for this call' },
        scheduledFor: { type: 'number', description: 'Optional epoch ms to schedule the call for' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const scheduledFor = typeof args['scheduledFor'] === 'number' ? (args['scheduledFor'] as number) : undefined;
      if (typeof args['briefId'] === 'string' && args['briefId']) {
        const briefId = args['briefId'] as string;
        if (scheduledFor !== undefined) {
          const entry = service.scheduleCall(briefId, scheduledFor);
          return { ok: true, scheduled: entry };
        }
        const record = await service.placeCall(briefId);
        return { ok: true, record, report: record.report ?? null };
      }
      const brief = service.createBrief({
        botId: ctx.botId,
        counterpartyName: args['counterpartyName'] as string,
        number: args['number'] as string,
        purpose: args['purpose'] as string,
        talkingPoints: Array.isArray(args['talkingPoints']) ? (args['talkingPoints'] as string[]) : undefined,
        openingLine: typeof args['openingLine'] === 'string' ? (args['openingLine'] as string) : undefined,
        voiceId: typeof args['voiceId'] === 'string' ? (args['voiceId'] as string) : undefined,
      });
      if (scheduledFor !== undefined) {
        const entry = service.scheduleCall(brief.id, scheduledFor);
        const withApproval = await service.requestApproval(brief.id);
        return { ok: true, brief: withApproval, scheduled: entry, message: 'Scheduled call drafted; it will dial at the scheduled time only if its approval is approved (or a one-call pre-approval matches).' };
      }
      // Pre-approval fast path: an exact one-call pre-approval authorizes
      // this exact call without a fresh card (CT-4).
      try {
        const record = await service.placeCall(brief.id);
        return { ok: true, brief: service.getBrief(brief.id), record, report: record.report ?? null, authorizedVia: 'pre-approval' };
      } catch (err) {
        if ((err as { status?: unknown }).status !== 403) throw err;
        const pending = await service.requestApproval(brief.id);
        return {
          ok: true, brief: pending,
          message: 'Call brief drafted and its approval card raised. Nothing has dialed; the call places only after the user approves this exact brief (or creates a one-call pre-approval for this number + counterparty).',
        };
      }
    },
  };
}

/** Register the outbound-call tool into a registry (skips collisions). */
export function registerOutboundCallTools(registry: Map<string, ToolDefinition>, deps: OutboundCallToolDeps): void {
  const tool = createOutboundCallTool(deps);
  if (!registry.has(tool.name)) registry.set(tool.name, tool);
}
