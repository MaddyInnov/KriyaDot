// SPDX-License-Identifier: Apache-2.0
// Spend caps: config CRUD, pure enforcement check, statuses, message
// formatting. Zero paid API usage — everything is local SQLite + pure math.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker } from '../src/cost-breakdown.js';
import {
  checkSpendCaps,
  formatSpendCapMessage,
  spendCapStatuses,
  spendUsageWarnings,
  SpendCapStore,
} from '../src/spend-caps.js';
import type { SpendCapConfig, SpendLookup } from '../src/spend-caps.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-spendcaps-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = (): string => join(dir, 'billing.db');

function emptyCaps(): SpendCapConfig {
  return { global: { dailyCents: null, monthlyCents: null }, bots: {} };
}

describe('SpendCapStore', () => {
  it('defaults to unlimited everywhere', () => {
    const store = new SpendCapStore(dbPath());
    expect(store.getConfig()).toEqual(emptyCaps());
    store.close();
  });

  it('sets and clears global caps', () => {
    const store = new SpendCapStore(dbPath());
    store.setCap('global', undefined, 'day', 500);
    store.setCap('global', undefined, 'month', 10_000);
    expect(store.getConfig().global).toEqual({ dailyCents: 500, monthlyCents: 10_000 });
    store.setCap('global', undefined, 'day', null);
    expect(store.getConfig().global).toEqual({ dailyCents: null, monthlyCents: 10_000 });
    store.close();
  });

  it('sets per-bot caps and clears them', () => {
    const store = new SpendCapStore(dbPath());
    store.setCap('bot', 'scout', 'day', 250);
    store.setCap('bot', 'scout', 'month', 2000);
    store.setCap('bot', 'coder', 'month', 3000);
    const cfg = store.getConfig();
    expect(cfg.bots['scout']).toEqual({ dailyCents: 250, monthlyCents: 2000 });
    expect(cfg.bots['coder']).toEqual({ dailyCents: null, monthlyCents: 3000 });
    store.clearBotCaps('scout');
    expect(store.getConfig().bots['scout']).toBeUndefined();
    store.close();
  });

  it('rejects bad inputs', () => {
    const store = new SpendCapStore(dbPath());
    expect(() => store.setCap('bot', '', 'day', 100)).toThrow();
    expect(() => store.setCap('global', undefined, 'day', -5)).toThrow();
    expect(() => store.setCap('global', undefined, 'day', 1.5)).toThrow();
    expect(() => store.setCap('zzz' as never, undefined, 'day', 100)).toThrow();
    expect(() => store.setCap('global', undefined, 'year' as never, 100)).toThrow();
    store.close();
  });

  it('persists across reopen', () => {
    const s1 = new SpendCapStore(dbPath());
    s1.setCap('global', undefined, 'month', 9999);
    s1.close();
    const s2 = new SpendCapStore(dbPath());
    expect(s2.getConfig().global.monthlyCents).toBe(9999);
    s2.close();
  });
});

describe('checkSpendCaps', () => {
  // NOTE: CostTracker.record() stamps events with the real clock, so the
  // check's `now` must also be real — otherwise events fall outside the
  // computed day/month windows.
  const now = Date.now();

  /** Spend lookup backed by a CostTracker with scripted events. */
  function lookupWith(tracker: ReturnType<typeof makeTracker>): SpendLookup {
    return (since, until, botId) => tracker.spentCents({ since, until, botId });
  }
  function makeTracker(): InstanceType<typeof CostTracker> {
    return new CostTracker(join(dir, `ledger-${Math.random().toString(36).slice(2)}.db`));
  }

  it('allows everything when no caps are set', () => {
    const tracker = makeTracker();
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 1_000_000, outputTokens: 0, botId: 'scout' });
    const res = checkSpendCaps({
      caps: emptyCaps(),
      botId: 'scout',
      estimatedAdditionalCents: 10_000,
      spentLookup: lookupWith(tracker),
      now,
    });
    expect(res.allowed).toBe(true);
    expect(res.violations).toEqual([]);
    tracker.close();
  });

  it('blocks when the global daily cap would be exceeded', () => {
    const tracker = makeTracker();
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 480, botId: 'scout' });
    const caps = emptyCaps();
    caps.global.dailyCents = 500;
    const res = checkSpendCaps({
      caps,
      botId: 'scout',
      estimatedAdditionalCents: 30,
      spentLookup: lookupWith(tracker),
      now,
    });
    expect(res.allowed).toBe(false);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({ scope: 'global', period: 'day', capCents: 500, spentCents: 480 });
    tracker.close();
  });

  it('allows when spend + estimate stays under the cap', () => {
    const tracker = makeTracker();
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 100, botId: 'scout' });
    const caps = emptyCaps();
    caps.global.dailyCents = 500;
    const res = checkSpendCaps({ caps, botId: 'scout', estimatedAdditionalCents: 399, spentLookup: lookupWith(tracker), now });
    expect(res.allowed).toBe(true);
    tracker.close();
  });

  it('enforces per-bot caps in isolation (other bots unaffected)', () => {
    const tracker = makeTracker();
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 900, botId: 'scout' });
    const caps = emptyCaps();
    caps.bots['scout'] = { dailyCents: 1000, monthlyCents: null };
    const scout = checkSpendCaps({ caps, botId: 'scout', estimatedAdditionalCents: 200, spentLookup: lookupWith(tracker), now });
    expect(scout.allowed).toBe(false);
    expect(scout.violations[0]).toMatchObject({ scope: 'bot', botId: 'scout', period: 'day' });
    const coder = checkSpendCaps({ caps, botId: 'coder', estimatedAdditionalCents: 200, spentLookup: lookupWith(tracker), now });
    expect(coder.allowed).toBe(true);
    tracker.close();
  });

  it('checks daily and monthly windows separately', () => {
    const tracker = makeTracker();
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 900, botId: 'scout' });
    const caps = emptyCaps();
    caps.global.dailyCents = 950;
    caps.global.monthlyCents = 950;
    const res = checkSpendCaps({ caps, botId: 'scout', estimatedAdditionalCents: 100, spentLookup: lookupWith(tracker), now });
    // Today's spend 900 + 100 = 1000 > 950 daily AND monthly → two violations.
    expect(res.allowed).toBe(false);
    expect(res.violations.map((v) => v.period).sort()).toEqual(['day', 'month']);
    tracker.close();
  });

  it('spend from a previous month does not count (rollover)', () => {
    const tracker = makeTracker();
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 10_000, botId: 'scout' });
    const caps = emptyCaps();
    caps.global.monthlyCents = 500;
    // Jump the clock forward into next month: today's events fall outside.
    const nextMonth = new Date(2026, 10, 5, 12, 0, 0).getTime();
    const res = checkSpendCaps({ caps, botId: 'scout', estimatedAdditionalCents: 100, spentLookup: lookupWith(tracker), now: nextMonth });
    expect(res.allowed).toBe(true);
    tracker.close();
  });

  it('reports all applicable violations at once', () => {
    const tracker = makeTracker();
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 10_000, botId: 'scout' });
    const caps = emptyCaps();
    caps.global.dailyCents = 100;
    caps.global.monthlyCents = 200;
    caps.bots['scout'] = { dailyCents: 300, monthlyCents: 400 };
    const res = checkSpendCaps({ caps, botId: 'scout', estimatedAdditionalCents: 1, spentLookup: lookupWith(tracker), now });
    expect(res.violations).toHaveLength(4);
    tracker.close();
  });

  it('clamps negative estimates to zero', () => {
    const res = checkSpendCaps({ caps: emptyCaps(), botId: 'x', estimatedAdditionalCents: -50, spentLookup: () => 0, now });
    expect(res.allowed).toBe(true);
  });
});

describe('spendCapStatuses', () => {
  it('returns rows only for set caps with current spend', () => {
    const now = Date.now();
    const tracker = new CostTracker(join(dir, 'status.db'));
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 250, botId: 'scout' });
    const caps = emptyCaps();
    caps.global.dailyCents = 1000;
    caps.bots['scout'] = { dailyCents: null, monthlyCents: 500 };
    const statuses = spendCapStatuses({ caps, spentLookup: (s, u, b) => tracker.spentCents({ since: s, until: u, botId: b }), now });
    expect(statuses).toHaveLength(2);
    const globalDay = statuses.find((s) => s.scope === 'global')!;
    expect(globalDay.spentCents).toBe(250);
    expect(globalDay.exceeded).toBe(false);
    const botMonth = statuses.find((s) => s.scope === 'bot')!;
    expect(botMonth.botId).toBe('scout');
    expect(botMonth.spentCents).toBe(250);
    tracker.close();
  });
});

describe('formatSpendCapMessage', () => {
  it('mentions scope, period, amounts and the raise path', () => {
    const now = Date.now();
    const msg = formatSpendCapMessage({
      allowed: false,
      violations: [
        {
          scope: 'global',
          botId: null,
          period: 'day',
          capCents: 500,
          spentCents: 480,
          periodStart: now,
          periodEnd: now + 1,
        },
      ],
    });
    expect(msg).toContain('Spend cap reached');
    expect(msg).toContain('Global daily');
    expect(msg).toContain('$4.8000');
    expect(msg).toContain('$5.0000');
    expect(msg).toContain('Usage & costs');
  });
});

describe('CostTracker.listEvents / spentCents (usage ledger)', () => {
  it('lists events newest-first with filters and appends correctly', () => {
    const tracker = new CostTracker(join(dir, 'events.db'));
    const e1 = tracker.record({ feature: 'chat', step: 'turn', inputTokens: 100, outputTokens: 50, botId: 'scout', model: 'm1', sessionId: 's1' });
    const e2 = tracker.record({ feature: 'workflows', step: 'run', inputTokens: 10, outputTokens: 5, botId: 'coder', model: 'm2', sessionId: 's2' });
    const all = tracker.listEvents();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(e2.id); // newest first
    expect(all[0]).toMatchObject({ botId: 'coder', feature: 'workflows', step: 'run', model: 'm2', inputTokens: 10, outputTokens: 5 });
    expect(typeof all[0].costCents).toBe('number');
    expect(all[0].ts).toBeGreaterThanOrEqual(all[1].ts);
    expect(tracker.listEvents({ botId: 'scout' })).toHaveLength(1);
    expect(tracker.listEvents({ botId: 'scout' })[0].id).toBe(e1.id);
    expect(tracker.listEvents({ limit: 1 })).toHaveLength(1);
    tracker.close();
  });

  it('spentCents sums a window', () => {
    const tracker = new CostTracker(join(dir, 'spent.db'));
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 120, botId: 'a' });
    tracker.record({ feature: 'chat', step: 'turn', inputTokens: 0, outputTokens: 0, costCents: 80, botId: 'b' });
    const now = Date.now();
    expect(tracker.spentCents({ since: 0, until: now + 1 })).toBe(200);
    expect(tracker.spentCents({ since: 0, until: now + 1, botId: 'a' })).toBe(120);
    expect(tracker.spentCents({ since: now + 1000, until: now + 2000 })).toBe(0);
    tracker.close();
  });
});

describe('spendUsageWarnings (W1 near-limit)', () => {
  it('warns at >=80% of a cap and stays silent below / without caps', () => {
    const caps: SpendCapConfig = {
      global: { dailyCents: 500, monthlyCents: null },
      bots: { scout: { dailyCents: 1000, monthlyCents: null } },
    };
    const lookup: SpendLookup = (since, _until, botId) => (botId === 'scout' ? 400 : 460);
    const statuses = spendCapStatuses({ caps, spentLookup: lookup, now: Date.now() });
    const warnings = spendUsageWarnings(statuses);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ scope: 'global', usedPercent: 92 });
    expect(warnings[0]!.message).toContain('92% used');
    expect(spendUsageWarnings([])).toEqual([]);
  });
});
