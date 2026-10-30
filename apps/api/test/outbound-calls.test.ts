// SPDX-License-Identifier: Apache-2.0
// Packaged outbound calling (CT-1..CT-5): telephony providers (mock +
// Twilio adapter request shapes via injected fetch — ZERO paid use),
// brief → approval → call → report flow, one-call pre-approvals,
// script sheets, scheduled calls, bring-in, and the HTTP routes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MockTelephonyProvider,
  TwilioTelephonyProvider,
  buildTwilioTwiml,
  selectTelephonyProvider,
  twilioConfigFromEnv,
} from '../src/telephony.js';
import {
  OutboundCallService,
  OutboundCallStore,
  buildScriptSheet,
  buildScheduledCallRoutineSchedule,
  createOutboundCallTool,
  normalizeCallNumber,
  outboundCallPolicyRules,
  scheduledCallRoutinePrompt,
} from '../src/outbound-calls.js';
import { createOutboundCallRouter } from '../src/outbound-call-routes.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'outbound-calls-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeService(opts: {
  provider?: MockTelephonyProvider;
  approvalStatus?: string;
} = {}) {
  const dataDir = tmp();
  const store = new OutboundCallStore(dataDir);
  const provider = opts.provider ?? new MockTelephonyProvider();
  const approvals = new Map<string, string>();
  const chat: Array<{ botId: string; text: string }> = [];
  const service = new OutboundCallService({
    store,
    provider,
    raiseApproval: (brief) => {
      const id = `appr_${brief.id}`;
      approvals.set(id, opts.approvalStatus ?? 'pending');
      return id;
    },
    approvalStatus: (id) => approvals.get(id),
    deliverChat: (args) => { chat.push(args); },
    audit: () => {},
    botName: () => 'Scout',
  });
  return { service, store, provider, approvals, chat, dataDir };
}

const briefInput = {
  botId: 'bot-1',
  counterpartyName: 'Acme Dental',
  number: '+1 (555) 010-2233',
  purpose: 'reschedule the cleaning appointment',
  talkingPoints: ['Ask for a morning slot next week', 'Confirm the address'],
};

describe('number normalization + script sheet (CT-3)', () => {
  it('normalizes numbers to +digits', () => {
    expect(normalizeCallNumber('+1 (555) 010-2233')).toBe('+15550102233');
    expect(normalizeCallNumber('555 010 2233')).toBe('+5550102233');
    expect(() => normalizeCallNumber('abc')).toThrow(/phone number/);
    expect(() => normalizeCallNumber('12')).toThrow(/phone number/);
  });

  it('builds a sheet with disclosure opening, guardrails, points, voice', () => {
    const sheet = buildScriptSheet({
      counterpartyName: 'Acme Dental', purpose: 'reschedule', botName: 'Scout', voiceId: 'voice-9',
    });
    expect(sheet.openingLine).toContain('AI assistant');
    expect(sheet.openingLine).toContain('Scout');
    expect(sheet.guardrails.join(' ')).toContain('Never claim to be a human');
    expect(sheet.talkingPoints).toEqual(['reschedule']);
    expect(sheet.voiceId).toBe('voice-9');
    expect(sheet.callerType).toBe('ai');
  });
});

describe('CT-1 brief → approval → call → report', () => {
  it('refuses to dial from draft / pending approval, dials after approval, reports in chat', async () => {
    const { service, provider, approvals, chat } = makeService();
    const brief = service.createBrief(briefInput);
    expect(brief.status).toBe('draft');
    expect(brief.number).toBe('+15550102233');
    await expect(service.placeCall(brief.id)).rejects.toThrow(/not authorized/);
    expect(provider.placed).toHaveLength(0);

    const pending = await service.requestApproval(brief.id);
    expect(pending.status).toBe('pending-approval');
    await expect(service.placeCall(brief.id)).rejects.toThrow(/not authorized/);

    approvals.set(pending.approvalId!, 'approved');
    const record = await service.placeCall(brief.id);
    expect(record.status).toBe('completed');
    expect(record.simulated).toBe(true);
    expect(record.report?.summary).toContain('SIMULATED');
    expect(record.report?.transcript.some((t) => t.speaker === 'counterparty')).toBe(true);
    expect(chat).toHaveLength(1);
    expect(chat[0]!.text).toContain('Call report — Acme Dental');
    expect(service.getBrief(brief.id)?.status).toBe('completed');
    // One call per brief.
    await expect(service.placeCall(brief.id)).rejects.toThrow(/already/);
  });

  it('denied approval blocks the call permanently', async () => {
    const { service, approvals, provider } = makeService();
    const brief = service.createBrief(briefInput);
    const pending = await service.requestApproval(brief.id);
    approvals.set(pending.approvalId!, 'denied');
    await expect(service.placeCall(brief.id)).rejects.toThrow(/denied/);
    expect(service.getBrief(brief.id)?.status).toBe('denied');
    expect(provider.placed).toHaveLength(0);
  });

  it('script sheet can be revised (voice pick) before placing, frozen after', async () => {
    const { service } = makeService({ approvalStatus: 'approved' });
    const brief = service.createBrief(briefInput);
    const sheet = service.updateScriptSheet(brief.id, { voiceId: 'voice-42' });
    expect(sheet.voiceId).toBe('voice-42');
    await service.requestApproval(brief.id);
    await service.placeCall(brief.id);
    expect(() => service.updateScriptSheet(brief.id, { voiceId: 'x' })).toThrow(/frozen/);
  });
});

describe('CT-4 one-call pre-approval', () => {
  it('authorizes exactly one matching call; bound to number + counterparty + duration cap', async () => {
    const { service, provider } = makeService();
    const pre = service.createPreApproval({ number: '1 555 010 2233', counterpartyName: 'acme dental', maxDurationSec: 600 });
    expect(pre.number).toBe('+15550102233');

    // Wrong counterparty does not consume it.
    const other = service.createBrief({ ...briefInput, counterpartyName: 'Other Clinic' });
    await expect(service.placeCall(other.id)).rejects.toThrow(/not authorized/);
    expect(service.listPreApprovals()[0]!.consumedAt).toBeUndefined();

    // Duration cap: brief asking for more than the pre-approval cap fails.
    const longBrief = service.createBrief({ ...briefInput, maxDurationSec: 900 });
    await expect(service.placeCall(longBrief.id)).rejects.toThrow(/not authorized/);

    // Exact match dials (case-insensitive counterparty), consuming it.
    const brief = service.createBrief(briefInput);
    const record = await service.placeCall(brief.id);
    expect(record.status).toBe('completed');
    expect(service.getBrief(brief.id)?.preApprovalId).toBe(pre.id);
    expect(service.listPreApprovals()[0]!.consumedAt).toBeDefined();

    // Single-use: a second matching brief cannot reuse it.
    const brief2 = service.createBrief(briefInput);
    await expect(service.placeCall(brief2.id)).rejects.toThrow(/not authorized/);
    expect(provider.placed).toHaveLength(1);
  });

  it('expired and revoked pre-approvals never authorize', async () => {
    const { service } = makeService();
    const expired = service.createPreApproval({ number: briefInput.number, counterpartyName: briefInput.counterpartyName, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const brief = service.createBrief(briefInput);
    await expect(service.placeCall(brief.id)).rejects.toThrow(/not authorized/);
    expect(expired.expiresAt).toBeLessThan(Date.now());

    const pre2 = service.createPreApproval({ number: briefInput.number, counterpartyName: briefInput.counterpartyName });
    service.revokePreApproval(pre2.id);
    await expect(service.placeCall(brief.id)).rejects.toThrow(/not authorized/);
  });
});

describe('CT-2 scheduled calls', () => {
  it('fires only when due AND authorized at fire time', async () => {
    const { service, approvals, provider } = makeService();
    const brief = service.createBrief(briefInput);
    const entry = service.scheduleCall(brief.id, Date.now() + 60_000);
    expect(await service.tickScheduled()).toHaveLength(0); // not due

    const fired = await service.tickScheduled(entry.runAt + 1);
    expect(fired[0]!.status).toBe('blocked'); // approval still missing at fire time
    expect(provider.placed).toHaveLength(0);

    const brief2 = service.createBrief(briefInput);
    const pending = await service.requestApproval(brief2.id);
    approvals.set(pending.approvalId!, 'approved');
    const entry2 = service.scheduleCall(brief2.id, Date.now() - 1);
    const fired2 = await service.tickScheduled();
    expect(fired2.find((f) => f.id === entry2.id)?.status).toBe('fired');
    expect(provider.placed).toHaveLength(1);
  });

  it('builds a validated once routine schedule + routine prompt', () => {
    const { service } = makeService();
    const brief = service.createBrief(briefInput);
    const schedule = buildScheduledCallRoutineSchedule(Date.UTC(2026, 10, 5, 14, 0), 'Asia/Kolkata');
    expect(schedule.kind).toBe('once');
    const prompt = scheduledCallRoutinePrompt(brief, 'csched_x');
    expect(prompt).toContain(brief.id);
    expect(prompt).toContain('request_outbound_call');
  });

  it('cancelled scheduled calls never fire', async () => {
    const { service, provider } = makeService();
    const brief = service.createBrief(briefInput);
    const entry = service.scheduleCall(brief.id, Date.now() - 1);
    service.cancelScheduled(entry.id);
    expect(await service.tickScheduled()).toHaveLength(0);
    expect(provider.placed).toHaveLength(0);
  });
});

describe('CT-5 callback bring-in', () => {
  it('brings the user into a live call; rejects when not live', async () => {
    const provider = new MockTelephonyProvider({ stayLive: true });
    const { service } = makeService({ provider, approvalStatus: 'approved' });
    const brief = service.createBrief(briefInput);
    await expect(service.bringIn(brief.id, '+15559998877')).rejects.toThrow(/no call/);
    await service.requestApproval(brief.id);
    const record = await service.placeCall(brief.id);
    expect(record.status).toBe('in-progress');
    const after = await service.bringIn(brief.id, '+1 555 999 8877');
    expect(after.status).toBe('in-progress');
    const done = await service.refreshCall(brief.id);
    expect(done.status).toBe('completed');
    expect(done.report?.participants).toContain('+15559998877');
    await expect(service.bringIn(brief.id, '+15559998877')).rejects.toThrow(/live/);
  });
});

describe('telephony providers', () => {
  it('selects mock by default, twilio only with full env, explicit twilio without env is unconfigured', () => {
    expect(selectTelephonyProvider(undefined, {}).id).toBe('mock');
    expect(twilioConfigFromEnv({ TWILIO_ACCOUNT_SID: 'AC1' })).toBeNull();
    const unconf = selectTelephonyProvider('twilio', {});
    expect(unconf.configured).toBe(false);
    expect(unconf.hint).toContain('TWILIO_ACCOUNT_SID');
    const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550001111' };
    expect(selectTelephonyProvider(undefined, env).id).toBe('twilio');
    expect(() => selectTelephonyProvider('carrier-pigeon', {})).toThrow(/unknown telephony provider/);
  });

  it('Twilio adapter sends the right REST shapes (injected fetch, zero paid use)', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return {
        ok: true, status: 200,
        text: async () => '',
        json: async () => (url.includes('/Calls.json') && init.method === 'POST' && !String((init.body as string) ?? '').includes('Status=')
          ? { sid: 'CA123', status: 'in-progress' }
          : { sid: 'CA123', status: 'completed', duration: '42' }),
      };
    });
    const provider = new TwilioTelephonyProvider(
      { accountSid: 'AC1', authToken: 'tok', fromNumber: '+15550001111', conferenceBridge: true },
      fetchFn as never,
    );
    const sheet = buildScriptSheet({ counterpartyName: 'Acme', purpose: 'reschedule' });
    const placed = await provider.placeCall({ to: '+15550102233', counterpartyName: 'Acme', purpose: 'reschedule', script: sheet, maxDurationSec: 600, correlationId: 'cbrief_1' });
    expect(placed.providerCallId).toBe('CA123');
    expect(placed.simulated).toBe(false);
    const body = String((calls[0]!.init.body as string) ?? '');
    expect(calls[0]!.url).toContain('/Accounts/AC1/Calls.json');
    expect(body).toContain('To=%2B15550102233');
    expect(body).toContain('Conference');
    // Bring-in hits the conference participants API in bridge mode.
    const after = await provider.addParticipant('CA123', '+15559998877');
    expect(after.participants).toContain('+15559998877');
    expect(calls.some((c) => c.url.includes('/Conferences/kd-cbrief_1/Participants.json'))).toBe(true);
    // TwiML carries the disclosure opening.
    expect(buildTwilioTwiml({ to: '+1', counterpartyName: 'A', purpose: 'p', script: sheet, maxDurationSec: 1, correlationId: 'x' }, false)).toContain('AI assistant');
  });

  it('Twilio bring-in without conference mode fails honestly', async () => {
    const provider = new TwilioTelephonyProvider({ accountSid: 'AC1', authToken: 't', fromNumber: '+1' }, (async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ sid: 'CA1' }) })) as never);
    await provider.placeCall({ to: '+15550102233', counterpartyName: 'A', purpose: 'p', script: buildScriptSheet({ counterpartyName: 'A', purpose: 'p' }), maxDurationSec: 60, correlationId: 'b1' });
    await expect(provider.addParticipant('CA1', '+15559998877')).rejects.toThrow(/conference mode/);
  });
});

describe('agent tool + policy', () => {
  it('policy forces require-approval for request_outbound_call', () => {
    const rules = outboundCallPolicyRules();
    expect(rules[0]!.effect).toBe('require-approval');
    expect(rules[0]!.toolPattern).toContain('request_outbound_call');
  });

  it('tool drafts + raises approval when unauthorized; places when pre-approved', async () => {
    const { service, chat } = makeService();
    const tool = createOutboundCallTool({ service });
    const ctx = { botId: 'bot-1', sessionId: 's1' } as never;
    const drafted = await tool.handler({ counterpartyName: 'Acme Dental', number: '+15550102233', purpose: 'reschedule' }, ctx) as { brief: { status: string }; message: string };
    expect(drafted.brief.status).toBe('pending-approval');
    expect(drafted.message).toContain('approval card raised');
    expect(chat).toHaveLength(0);

    service.createPreApproval({ number: '+442071234567', counterpartyName: 'London Clinic' });
    const placed = await tool.handler({ counterpartyName: 'London Clinic', number: '+442071234567', purpose: 'confirm booking' }, ctx) as { authorizedVia?: string; report?: { simulated: boolean } };
    expect(placed.authorizedVia).toBe('pre-approval');
    expect(placed.report?.simulated).toBe(true);
  });
});

describe('HTTP routes', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    const { service, provider } = makeService({ approvalStatus: 'approved' });
    const app = express();
    app.use(express.json());
    app.use('/api/calls', createOutboundCallRouter({ service, provider }));
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/calls`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('brief → sheet → approval → place → report over HTTP', async () => {
    const created = await fetch(`${base}/briefs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(briefInput) });
    expect(created.status).toBe(201);
    const { brief } = (await created.json()) as { brief: { id: string } };

    const sheetRes = await fetch(`${base}/briefs/${brief.id}/script-sheet`);
    const { scriptSheet } = (await sheetRes.json()) as { scriptSheet: { openingLine: string } };
    expect(scriptSheet.openingLine).toContain('AI assistant');

    const early = await fetch(`${base}/briefs/${brief.id}/place`, { method: 'POST' });
    expect(early.status).toBe(403);

    await fetch(`${base}/briefs/${brief.id}/request-approval`, { method: 'POST' });
    const placed = await fetch(`${base}/briefs/${brief.id}/place`, { method: 'POST' });
    expect(placed.status).toBe(200);

    const reportRes = await fetch(`${base}/briefs/${brief.id}/report`);
    const { report } = (await reportRes.json()) as { report: { simulated: boolean } };
    expect(report.simulated).toBe(true);

    const providers = await (await fetch(`${base}/providers`)).json() as { providers: Array<{ id: string }> };
    expect(providers.providers[0]!.id).toBe('mock');
  });

  it('pre-approval CRUD over HTTP', async () => {
    const res = await fetch(`${base}/preapprovals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: '+15550102233', counterpartyName: 'Acme Dental' }) });
    expect(res.status).toBe(201);
    const { preApproval } = (await res.json()) as { preApproval: { id: string } };
    const del = await fetch(`${base}/preapprovals/${preApproval.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list = await (await fetch(`${base}/preapprovals`)).json() as { preApprovals: Array<{ revokedAt?: number }> };
    expect(list.preApprovals[0]!.revokedAt).toBeDefined();
  });
});
