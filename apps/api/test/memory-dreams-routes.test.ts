// SPDX-License-Identifier: Apache-2.0
// A11 Dreams routes:
// - settings are OFF by default; PUT settings / run / decide are
//   user-gated (verified principal, OPEN-1 — x-user-id alone = 401)
// - a manual run works while the schedule is disabled and creates
//   leads from fixture audit data — mutating NOTHING else
// - accept maps rule leads to a PENDING A10 proposal (not a rule) and
//   routine leads to a DISABLED routine draft; 'none' leads are only
//   acknowledged
// - the scheduler does zero work when disabled, runs when enabled and
//   due, and does not re-run the same day

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DreamLeadStore, TieredMemoryStore, runDreamPass } from '@mvp/agent-runtime';
import {
  createMemoryDreamsRouter,
  getDreamSettings,
  saveDreamSettings,
  startDreamsScheduler,
  type DreamAuditSourceEntry,
} from '../src/memory-dreams-routes.js';
import { RoutineStore } from '../src/bot-routines.js';

const BOT_ID = 'bot-a';
const OWNER_TOKEN = 'a11-dreams-owner-token';
const DAY = 86_400_000;

let dir: string;
let store: TieredMemoryStore;
let leadStore: DreamLeadStore;
let routineStore: RoutineStore;
let server: { close(cb: () => void): void } | null = null;
let base: string;

/** Fixture audit trail: 5 tool failures + 5 manual repeats, recent. */
function fixtureAudit(now: number): DreamAuditSourceEntry[] {
  const entries: DreamAuditSourceEntry[] = [];
  for (let i = 0; i < 5; i++) {
    entries.push({ ts: now - i * 3_600_000, actor: BOT_ID, action: 'tool.execute', toolName: 'web_search', detail: JSON.stringify({ status: 'failed', botId: BOT_ID }) });
  }
  for (let i = 0; i < 5; i++) {
    entries.push({ ts: now - i * 3_600_000, actor: BOT_ID, action: 'notes.organize', toolName: 'notes', detail: JSON.stringify({ botId: BOT_ID }) });
  }
  return entries;
}

async function startApp(withPrincipal = true): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/memory',
    createMemoryDreamsRouter({
      dataDir: dir,
      tieredMemoryStore: store,
      leadStore,
      getBots: () => [{ id: BOT_ID }],
      ...(withPrincipal ? { principalContext: { dataDir: dir, loopbackToken: OWNER_TOKEN } } : {}),
      listAudit: () => fixtureAudit(Date.now()),
      createRoutineDraft: (draft) => {
        const created = routineStore.create({ name: draft.name, botId: draft.botId, promptTemplate: draft.promptTemplate });
        const disabled = routineStore.update(created.id, { enabled: false });
        return { id: (disabled ?? created).id };
      },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  base = `http://127.0.0.1:${addr.port}/api/memory`;
}

const ownerHeaders = { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a11-dreams-routes-'));
  store = new TieredMemoryStore(dir);
  leadStore = new DreamLeadStore(dir);
  routineStore = new RoutineStore(dir);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

async function runAndListLeads(): Promise<Array<{ id: string; kind: string; artefact: { type: string } }>> {
  const run = await fetch(`${base}/dreams/run`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ botId: BOT_ID }) });
  expect(run.status).toBe(200);
  const list = await (await fetch(`${base}/dreams/leads?botId=${BOT_ID}`)).json();
  return list.leads;
}

describe('settings: opt-in, OFF by default', () => {
  it('defaults to disabled with the nightly schedule; overview exposes it', async () => {
    await startApp();
    expect(getDreamSettings(dir, BOT_ID).enabled).toBe(false);
    const body = await (await fetch(`${base}/dreams?botId=${BOT_ID}`)).json();
    expect(body.settings).toMatchObject({ enabled: false, hour: 3, minute: 15, summarise: false });
    expect(body.leads).toEqual([]);
    expect(body.lastRunAt).toBeNull();
  });

  it('PUT settings requires a verified principal (x-user-id alone = 401)', async () => {
    await startApp();
    const headerOnly = await fetch(`${base}/dreams/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'mallory' },
      body: JSON.stringify({ botId: BOT_ID, enabled: true }),
    });
    expect(headerOnly.status).toBe(401);
    expect(getDreamSettings(dir, BOT_ID).enabled).toBe(false);
    const ok = await fetch(`${base}/dreams/settings`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, enabled: true, hour: 2, minute: 30 }),
    });
    expect(ok.status).toBe(200);
    expect(getDreamSettings(dir, BOT_ID)).toMatchObject({ enabled: true, hour: 2, minute: 30 });
  });
});

describe('manual run + propose-only invariant', () => {
  it('runs while disabled, creates leads, and mutates no rules/proposals/routines/settings', async () => {
    await startApp();
    store.storeAtom(BOT_ID, { fact: 'The user lives in Portland.', entities: [], confidence: 0.9 }, 't1', undefined, { category: 'fact' });
    const leads = await runAndListLeads();
    expect(leads.map((l) => l.kind).sort()).toEqual(['manual-pattern', 'recurring-failure']);
    // Nothing else changed: no rules, no rule proposals, no routines,
    // settings still off (a manual run is not an opt-in).
    expect(store.listRuleAtoms(BOT_ID)).toHaveLength(0);
    expect(store.listRuleProposals(BOT_ID, 'all')).toHaveLength(0);
    expect(routineStore.list()).toHaveLength(0);
    expect(getDreamSettings(dir, BOT_ID).enabled).toBe(false);
  });

  it('run requires a verified principal', async () => {
    await startApp();
    const res = await fetch(`${base}/dreams/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'mallory' },
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(res.status).toBe(401);
    expect(leadStore.list(BOT_ID, 'all')).toHaveLength(0);
  });
});

describe('decide: accept mapping / dismiss / snooze', () => {
  it('accepting a rule lead creates a PENDING A10 proposal — not a rule', async () => {
    await startApp();
    const leads = await runAndListLeads();
    const ruleLead = leads.find((l) => l.kind === 'recurring-failure')!;
    const res = await fetch(`${base}/dreams/leads/${ruleLead.id}/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'accept' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead.status).toBe('accepted');
    expect(body.lead.acceptedArtefact.type).toBe('rule-proposal');
    const proposals = store.listRuleProposals(BOT_ID, 'pending');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.text).toContain('web_search');
    // The proposal is NOT a rule: promotion is still the user's A10 call.
    expect(store.listRuleAtoms(BOT_ID)).toHaveLength(0);
  });

  it('accepting a routine lead creates a DISABLED routine draft', async () => {
    await startApp();
    const leads = await runAndListLeads();
    const routineLead = leads.find((l) => l.kind === 'manual-pattern')!;
    const res = await fetch(`${base}/dreams/leads/${routineLead.id}/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'accept' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead.acceptedArtefact.type).toBe('routine-draft');
    const routines = routineStore.list();
    expect(routines).toHaveLength(1);
    expect(routines[0]!.enabled).toBe(false);
    expect(routines[0]!.id).toBe(body.lead.acceptedArtefact.id);
  });

  it('dismiss is remembered (re-run suppresses) and snooze hides until expiry', async () => {
    await startApp();
    const leads = await runAndListLeads();
    const failure = leads.find((l) => l.kind === 'recurring-failure')!;
    const manual = leads.find((l) => l.kind === 'manual-pattern')!;
    for (const [id, action] of [[failure.id, 'dismiss'], [manual.id, 'snooze']] as const) {
      const res = await fetch(`${base}/dreams/leads/${id}/decide`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ botId: BOT_ID, action, snoozeDays: 7 }),
      });
      expect(res.status).toBe(200);
    }
    // A fresh pass over an explicit window regenerates the same
    // candidates — both keys are suppressed by the decisions above.
    const again = await runDreamPass(
      {
        memory: store,
        leads: leadStore,
        auditEvents: async () =>
          fixtureAudit(Date.now()).map((e) => ({
            ts: e.ts,
            botId: BOT_ID,
            action: e.action,
            ...(e.toolName ? { toolName: e.toolName } : {}),
            ...(e.decision ? { decision: e.decision } : {}),
            detail: JSON.parse(e.detail as string),
          })),
      },
      BOT_ID,
      { since: Date.now() - DAY, until: Date.now() },
    );
    expect(again.created).toHaveLength(0);
    expect(again.suppressed).toBeGreaterThanOrEqual(2);
    expect(leadStore.list(BOT_ID, 'dismissed')).toHaveLength(1);
    expect(leadStore.list(BOT_ID, 'snoozed')[0]!.snoozedUntil).toBeGreaterThan(Date.now());
  });

  it('decide is user-gated and fails closed on unknown leads', async () => {
    await startApp();
    const leads = await runAndListLeads();
    const noAuth = await fetch(`${base}/dreams/leads/${leads[0]!.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: BOT_ID, action: 'dismiss' }),
    });
    expect(noAuth.status).toBe(401);
    const unknown = await fetch(`${base}/dreams/leads/nope/decide`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ botId: BOT_ID, action: 'dismiss' }),
    });
    expect(unknown.status).toBe(404);
  });
});

describe('scheduler (opt-in + schedule registration idiom)', () => {
  // Local 04:00 on a fixed date — after the default 03:15 schedule.
  const dueNow = new Date(2026, 0, 15, 4, 0, 0).getTime();

  it('does ZERO work when never enabled (audit source untouched)', async () => {
    const listAudit = vi.fn(() => fixtureAudit(dueNow));
    const scheduler = startDreamsScheduler({
      dataDir: dir,
      tieredMemoryStore: store,
      leadStore,
      getBots: () => [{ id: BOT_ID }],
      listAudit,
      now: () => dueNow,
      intervalMs: 60_000,
    });
    await scheduler.tick();
    scheduler.stop();
    expect(listAudit).not.toHaveBeenCalled();
    expect(leadStore.list(BOT_ID, 'all')).toHaveLength(0);
    expect(leadStore.lastRunAt(BOT_ID)).toBeUndefined();
  });

  it('runs when enabled and due; does not re-run the same local day', async () => {
    saveDreamSettings(dir, BOT_ID, { enabled: true, hour: 3, minute: 15 });
    const listAudit = vi.fn(() => fixtureAudit(dueNow));
    const scheduler = startDreamsScheduler({
      dataDir: dir,
      tieredMemoryStore: store,
      leadStore,
      getBots: () => [{ id: BOT_ID }],
      listAudit,
      now: () => dueNow,
      intervalMs: 60_000,
    });
    await scheduler.tick();
    expect(leadStore.list(BOT_ID, 'pending').length).toBeGreaterThanOrEqual(2);
    expect(leadStore.lastRunAt(BOT_ID)).toBe(dueNow);
    const callsAfterFirst = listAudit.mock.calls.length;
    await scheduler.tick(); // same day → skipped before reading audit
    scheduler.stop();
    expect(listAudit.mock.calls.length).toBe(callsAfterFirst);
    // Next day it runs again (watermark moved on).
    void DAY;
  });

  it('does not run before the configured local time', async () => {
    saveDreamSettings(dir, BOT_ID, { enabled: true, hour: 5, minute: 0 });
    const listAudit = vi.fn(() => fixtureAudit(dueNow));
    const scheduler = startDreamsScheduler({
      dataDir: dir,
      tieredMemoryStore: store,
      leadStore,
      getBots: () => [{ id: BOT_ID }],
      listAudit,
      now: () => dueNow, // 04:00 < 05:00
      intervalMs: 60_000,
    });
    await scheduler.tick();
    scheduler.stop();
    expect(listAudit).not.toHaveBeenCalled();
  });
});
