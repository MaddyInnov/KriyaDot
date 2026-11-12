// SPDX-License-Identifier: Apache-2.0
// A11 Dreams: the overnight self-improvement PROPOSAL pass.
// - deterministic scoring on fixture audit data yields the expected
//   leads, ranked, with evidence counts (no model involved)
// - dismissals/snoozes suppress similar leads for the cooling window
// - PROPOSE-ONLY invariant: a run mutates NO rules, proposals,
//   routines, or settings — only the dreams inbox + run watermark
// - a dismissed A10 rule proposal suppresses a matching dream rule lead
// - the optional model summariser is fail-closed (summary or nothing)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TieredMemoryStore } from '../src/memory.js';
import {
  DreamLeadStore,
  analyzeDreamWindow,
  classifyDreamEvent,
  runDreamPass,
  type DreamAuditEvent,
  type DreamMemorySignals,
} from '../src/dreams.js';

const BOT = 'bot-a';
const DAY = 86_400_000;
const T0 = 1_760_000_000_000; // fixed window anchor — determinism

let dir: string;
let store: TieredMemoryStore;
let leads: DreamLeadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a11-dreams-'));
  store = new TieredMemoryStore(dir);
  leads = new DreamLeadStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Fixture audit window: 5 failures, 3 denials, 2 cooldowns, 5 manual repeats. */
function fixtureEvents(): DreamAuditEvent[] {
  const events: DreamAuditEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push({ ts: T0 + i * 3_600_000, botId: BOT, action: 'tool.execute', toolName: 'web_search', detail: { status: 'failed' } });
  }
  for (let i = 0; i < 3; i++) {
    events.push({ ts: T0 + i * 3_600_000, botId: BOT, action: 'approval.decided', toolName: 'send_email', decision: 'denied' });
  }
  for (let i = 0; i < 2; i++) {
    events.push({ ts: T0 + i * 3_600_000, botId: BOT, action: 'tool.cooldown', toolName: 'web_search', decision: 'cooldown' });
  }
  for (let i = 0; i < 5; i++) {
    events.push({ ts: T0 + i * 3_600_000, botId: BOT, action: 'notes.organize', toolName: 'notes' });
  }
  // Noise that must NOT produce leads: system bookkeeping + one-offs.
  events.push({ ts: T0, botId: BOT, action: 'memory.upkeep_tidy' });
  events.push({ ts: T0, botId: BOT, action: 'tool.evaluate', toolName: 'web_search', decision: 'allow' });
  events.push({ ts: T0, botId: BOT, action: 'chat.turn', toolName: 'chat' });
  return events;
}

function fixtureMemory(): DreamMemorySignals {
  return {
    rules: [{ id: 'atom-stale', text: 'Always use British spelling.', createdAt: T0 - 45 * DAY, useCredit: 0 }],
    pendingProposalCount: 6,
    dismissedRuleTexts: [],
  };
}

describe('classifyDreamEvent', () => {
  it('classifies failure / denial / cooldown / other deterministically', () => {
    expect(classifyDreamEvent({ ts: 1, action: 'tool.execute', detail: { status: 'failed' } })).toBe('failure');
    expect(classifyDreamEvent({ ts: 1, action: 'approval.decided', decision: 'denied' })).toBe('denial');
    expect(classifyDreamEvent({ ts: 1, action: 'tool.rate_limit', toolName: 'x' })).toBe('cooldown');
    expect(classifyDreamEvent({ ts: 1, action: 'chat.turn' })).toBe('other');
    // detail as a JSON string (the governance audit shape) parses too
    expect(classifyDreamEvent({ ts: 1, action: 'tool.execute', detail: '{"ok":false}' })).toBe('failure');
  });
});

describe('analyzeDreamWindow (deterministic scoring)', () => {
  it('produces the expected leads, ranked, with evidence numbers', () => {
    const result = analyzeDreamWindow({
      botId: BOT,
      events: fixtureEvents(),
      memory: fixtureMemory(),
      windowStart: T0 - DAY,
      windowEnd: T0 + DAY,
    });
    // Scores: failure 40+10·5=90, friction 35+10·3=65, manual 30+6·5=60,
    // stale 25+min(45,30)=55, cooldown 30+8·2=46, backlog 20+3·6=38.
    expect(result.map((l) => l.kind)).toEqual([
      'recurring-failure',
      'approval-friction',
      'manual-pattern',
      'stale-rule',
      'cooldown-refusal',
      'proposal-backlog',
    ]);
    expect(result.map((l) => l.score)).toEqual([90, 65, 60, 55, 46, 38]);
    const failure = result.find((l) => l.kind === 'recurring-failure')!;
    expect(failure.score).toBe(90);
    expect(failure.evidence.count).toBe(5);
    expect(failure.evidence.examples).toHaveLength(3);
    expect(failure.artefact).toMatchObject({ type: 'rule', scope: { kind: 'agent', id: BOT } });
    const manual = result.find((l) => l.kind === 'manual-pattern')!;
    expect(manual.artefact).toMatchObject({ type: 'routine' });
    const stale = result.find((l) => l.kind === 'stale-rule')!;
    expect(stale.evidence.metrics).toMatchObject({ ageDays: 46, useCredit: 0 });
    expect(stale.artefact).toEqual({ type: 'none' });
  });

  it('is deterministic: identical inputs give identical output', () => {
    const input = { botId: BOT, events: fixtureEvents(), memory: fixtureMemory(), windowStart: T0 - DAY, windowEnd: T0 + DAY };
    expect(analyzeDreamWindow(input)).toEqual(analyzeDreamWindow(input));
  });

  it('respects thresholds: below-threshold patterns produce no leads', () => {
    const result = analyzeDreamWindow({
      botId: BOT,
      events: fixtureEvents().slice(0, 2), // only 2 failures
      memory: { rules: [], pendingProposalCount: 0, dismissedRuleTexts: [] },
      windowStart: T0 - DAY,
      windowEnd: T0 + DAY,
    });
    expect(result).toHaveLength(0);
  });

  it('ignores events outside the window', () => {
    const result = analyzeDreamWindow({
      botId: BOT,
      events: fixtureEvents(),
      memory: fixtureMemory(),
      windowStart: T0 + 2 * DAY,
      windowEnd: T0 + 3 * DAY,
    });
    // Audit-driven leads vanish; memory-driven leads (stale rule, backlog) remain.
    expect(result.map((l) => l.kind).sort()).toEqual(['proposal-backlog', 'stale-rule']);
  });

  it('suppresses a rule lead whose text matches a dismissed A10 proposal', () => {
    const result = analyzeDreamWindow({
      botId: BOT,
      events: fixtureEvents(),
      memory: {
        rules: [],
        pendingProposalCount: 0,
        dismissedRuleTexts: ['When web_search fails, stop and report the error instead of retrying repeatedly.'],
      },
      windowStart: T0 - DAY,
      windowEnd: T0 + DAY,
    });
    expect(result.some((l) => l.kind === 'recurring-failure')).toBe(false);
    expect(result.some((l) => l.kind === 'approval-friction')).toBe(true);
  });
});

describe('runDreamPass (propose-only)', () => {
  function snapshot() {
    return {
      atoms: store.getAtoms(BOT, 500).map((a) => [a.id, a.fact, a.isRule ?? false]),
      proposals: store.listRuleProposals(BOT, 'all', 500).map((p) => [p.id, p.status, p.text]),
      rules: store.listRuleAtoms(BOT).map((a) => a.id),
    };
  }

  it('creates ranked leads in the inbox and mutates NOTHING else', async () => {
    store.storeAtom(BOT, { fact: 'The user lives in Portland.', entities: [], confidence: 0.9 }, 't1', undefined, { category: 'fact' });
    const before = snapshot();
    const result = await runDreamPass(
      { memory: store, leads, auditEvents: async () => fixtureEvents(), now: () => T0 + DAY },
      BOT,
      { since: T0 - DAY, until: T0 + DAY },
    );
    expect(result.ok).toBe(true);
    expect(result.created.length).toBeGreaterThanOrEqual(4);
    expect(result.created[0]!.kind).toBe('recurring-failure');
    expect(leads.list(BOT, 'pending').length).toBe(result.created.length);
    // PROPOSE-ONLY: memory atoms, rule proposals, and rules are untouched.
    expect(snapshot()).toEqual(before);
  });

  it('advances the window watermark: an immediate re-run sees no new events', async () => {
    const auditEvents = vi.fn(async (_botId: string, since: number) =>
      fixtureEvents().filter((e) => e.ts >= since),
    );
    const first = await runDreamPass({ memory: store, leads, auditEvents, now: () => T0 + DAY }, BOT, {});
    expect(first.created.length).toBeGreaterThan(0);
    const second = await runDreamPass({ memory: store, leads, auditEvents, now: () => T0 + DAY }, BOT, {});
    expect(second.windowStart).toBe(T0 + DAY);
    expect(second.created).toHaveLength(0);
  });

  it('does not duplicate pending leads on a repeat run over the same window', async () => {
    const opts = { since: T0 - DAY, until: T0 + DAY };
    const deps = { memory: store, leads, auditEvents: async () => fixtureEvents(), now: () => T0 + DAY };
    const first = await runDreamPass(deps, BOT, opts);
    const second = await runDreamPass(deps, BOT, opts);
    expect(second.created).toHaveLength(0);
    expect(second.suppressed).toBe(first.created.length);
  });

  it('summariser is optional and fail-closed', async () => {
    const opts = { since: T0 - DAY, until: T0 + DAY };
    const failing = await runDreamPass(
      {
        memory: store,
        leads,
        auditEvents: async () => fixtureEvents(),
        summarizer: async () => {
          throw new Error('lane down');
        },
        now: () => T0 + DAY,
      },
      BOT,
      opts,
    );
    expect(failing.ok).toBe(true);
    expect(failing.summary).toBeUndefined();
    expect(failing.lane).toBe('deterministic');

    const leads2 = new DreamLeadStore(mkdtempSync(join(tmpdir(), 'a11-dreams2-')));
    const ok = await runDreamPass(
      {
        memory: store,
        leads: leads2,
        auditEvents: async () => fixtureEvents(),
        summarizer: async () => 'Failures dominate the window.',
        now: () => T0 + DAY,
      },
      BOT,
      opts,
    );
    expect(ok.summary).toBe('Failures dominate the window.');
    expect(ok.lane).toBe('deterministic+model');
  });
});

describe('DreamLeadStore suppression (dismissal / snooze cooling)', () => {
  const lead = {
    key: 'recurring-failure:web_search',
    kind: 'recurring-failure' as const,
    botId: BOT,
    title: 't',
    suggestedAction: 's',
    evidence: { count: 5, windowStart: T0 - DAY, windowEnd: T0, examples: [], metrics: {} },
    score: 90,
    artefact: { type: 'none' as const },
  };

  it('dismissed leads are suppressed for the cooling period, then allowed again', () => {
    const { created } = leads.addLeads([lead], T0);
    expect(created).toHaveLength(1);
    leads.decideLead(BOT, created[0]!.id, { action: 'dismiss', decidedBy: 'user-1', now: T0 });
    // Within cooling (default 30d): suppressed.
    expect(leads.addLeads([lead], T0 + 10 * DAY).created).toHaveLength(0);
    expect(leads.isSuppressed(BOT, lead.key, T0 + 10 * DAY)).toBe(true);
    // After cooling: a fresh lead may be created.
    expect(leads.addLeads([lead], T0 + 31 * DAY).created).toHaveLength(1);
  });

  it('snoozed leads are suppressed until the snooze expires', () => {
    const { created } = leads.addLeads([lead], T0);
    leads.decideLead(BOT, created[0]!.id, { action: 'snooze', decidedBy: 'user-1', now: T0, snoozeMs: 7 * DAY });
    expect(leads.isSuppressed(BOT, lead.key, T0 + 3 * DAY)).toBe(true);
    expect(leads.isSuppressed(BOT, lead.key, T0 + 8 * DAY)).toBe(false);
  });

  it('decideLead fails closed on unknown / already-decided leads', () => {
    const { created } = leads.addLeads([lead], T0);
    expect(() => leads.decideLead(BOT, 'nope', { action: 'dismiss', decidedBy: 'user-1' })).toThrow(/Unknown dream lead/);
    leads.decideLead(BOT, created[0]!.id, { action: 'accept', decidedBy: 'user-1', now: T0 });
    expect(() => leads.decideLead(BOT, created[0]!.id, { action: 'dismiss', decidedBy: 'user-1' })).toThrow(/already accepted/);
  });
});
