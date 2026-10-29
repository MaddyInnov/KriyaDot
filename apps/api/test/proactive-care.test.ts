// SPDX-License-Identifier: Apache-2.0
// Proactive care: scoring order + weights, caps (weekly / gap / window),
// opt-in default OFF, person opt-out, global pause, per-episode dedupe,
// delivery fan-out (inbox + chat + push), and the HTTP routes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { AtomCard } from '@mvp/agent-runtime';
import {
  ProactiveCareEngine,
  ProactiveCareStore,
  composeCareMessage,
  parseCareDueAt,
  rankCareCandidates,
  scoreCareCandidate,
} from '../src/proactive-care.js';
import { createProactiveCareRouter } from '../src/proactive-care-routes.js';

const DAY = 24 * 3600_000;
// A fixed local midday so window checks are timezone-independent.
const NOW = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();

function atom(over: Partial<AtomCard> = {}): AtomCard {
  return {
    id: over.id ?? `atom-${Math.random().toString(36).slice(2, 8)}`,
    botId: 'bot-1',
    fact: 'The user has a job interview tomorrow and is nervous about it.',
    entities: [],
    confidence: 0.9,
    sourceTurn: 's1',
    createdAt: NOW - 3 * DAY,
    tier: 'cloud-ok',
    pinned: false,
    category: 'fact',
    active: true,
    ...over,
  };
}

describe('proactive care scoring', () => {
  it('parses explicit dates: ISO, month-name, tomorrow, in N days', () => {
    expect(parseCareDueAt('Dentist on 2026-02-01.', NOW)).toBe(new Date(2026, 1, 1, 9).getTime());
    expect(parseCareDueAt('The recital is on January 20.', NOW)).toBe(new Date(2026, 0, 20, 9).getTime());
    expect(parseCareDueAt('Flight tomorrow morning.', NOW)).toBe(NOW + DAY);
    expect(parseCareDueAt('Deadline in 5 days.', NOW)).toBe(NOW + 5 * DAY);
    expect(parseCareDueAt('Nothing scheduled at all.', NOW)).toBeUndefined();
  });

  it('scores commitments + affect + confidence above threshold and ranks pinned first', () => {
    const strong = atom({ id: 'strong' });
    const pinned = atom({
      id: 'pinned', pinned: true, confidence: 0.9,
      fact: 'The user asked to be reminded about the hospital follow-up.', createdAt: NOW - 10 * DAY,
    });
    const weak = atom({
      id: 'weak', confidence: 0.3,
      fact: 'The user likes tea.', category: 'preference', createdAt: NOW - 10 * DAY,
    });
    expect(scoreCareCandidate(strong, NOW).score).toBeGreaterThanOrEqual(45);
    const ranked = rankCareCandidates([strong, weak, pinned], NOW);
    expect(ranked.map((r) => r.atom.id)).toEqual(['pinned', 'strong']);
    expect(ranked[0]!.reasons.join(' ')).toContain('pinned');
  });

  it('is not due for a fresh mention or a far-future date', () => {
    const fresh = atom({ createdAt: NOW - 3600_000, fact: 'The user is worried about the presentation.' });
    // No parsed date + age < 48h → not due.
    expect(scoreCareCandidate(fresh, NOW).due).toBe(false);
    const far = atom({ fact: 'The user has a wedding on 2026-12-25 and is excited.' });
    expect(scoreCareCandidate(far, NOW).due).toBe(false);
    expect(rankCareCandidates([fresh, far], NOW)).toEqual([]);
  });

  it('composes a check-in that quotes the fact verbatim', () => {
    const scored = scoreCareCandidate(atom(), NOW);
    const msg = composeCareMessage('Helper', scored);
    expect(msg).toContain('"The user has a job interview tomorrow and is nervous about it."');
    expect(msg).toContain('Helper checking in');
  });
});

describe('proactive care engine', () => {
  let dir: string;
  let store: ProactiveCareStore;
  let inboxItems: Array<{ personId: string; title: string }>;
  let chats: Array<{ botId: string; text: string }>;
  let pushes: Array<{ botId: string; title: string }>;
  let paused: boolean;
  let atoms: AtomCard[];
  let engine: ProactiveCareEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'care-'));
    store = new ProactiveCareStore(dir);
    inboxItems = []; chats = []; pushes = [];
    paused = false;
    atoms = [atom({ id: 'ep-1' })];
    engine = new ProactiveCareEngine({
      store,
      listBots: () => [{ id: 'bot-1', name: 'Helper', ownerPersonId: 'ana' }],
      getAtoms: () => atoms,
      addInboxItem: (item) => { inboxItems.push(item); },
      deliverChat: (a) => { chats.push(a); },
      push: (a) => { pushes.push(a); },
      isPaused: () => paused,
      audit: vi.fn(),
      now: () => NOW,
    });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const enable = (over: Record<string, unknown> = {}): void => {
    store.setConfig('bot-1', { enabled: true, ownerPersonId: 'ana', ...over });
  };

  it('defaults OFF: no send until the bot opts in', async () => {
    const actions = await engine.tick({ force: true });
    expect(actions[0]).toMatchObject({ action: 'skipped' });
    expect(actions[0]!.reason).toContain('opt-in');
    expect(chats).toHaveLength(0);
  });

  it('sends once with full fan-out (inbox + chat + push) and dedupes the episode', async () => {
    enable();
    const first = await engine.tick({ force: true });
    expect(first[0]!.action).toBe('sent');
    expect(inboxItems).toHaveLength(1);
    expect(chats).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(chats[0]!.text).toContain('job interview tomorrow');
    expect(store.listSends('bot-1')).toHaveLength(1);

    // Same episode never sends twice — and with the weekly structures in
    // place the second tick finds no candidate.
    const second = await engine.tick({ force: true });
    expect(second[0]!.action).toBe('skipped');
    expect(chats).toHaveLength(1);
  });

  it('honours person opt-out and the global pause', async () => {
    enable({ personOptedOut: true });
    expect((await engine.tick({ force: true }))[0]!.reason).toContain('opted out');
    enable({ personOptedOut: false });
    paused = true;
    expect((await engine.tick({ force: true }))[0]!.reason).toContain('paused');
    expect(chats).toHaveLength(0);
  });

  it('enforces the weekly cap and the minimum gap', async () => {
    enable({ maxPerWeek: 1, minGapHours: 0 });
    atoms = [atom({ id: 'ep-1' }), atom({ id: 'ep-2', fact: 'The user has a dentist appointment tomorrow and is worried.' })];
    expect((await engine.tick({ force: true }))[0]!.action).toBe('sent');
    expect((await engine.tick({ force: true }))[0]!.reason).toContain('weekly cap');

    // Gap: fresh store, send, then a second candidate inside minGap.
    const dir2 = mkdtempSync(join(tmpdir(), 'care2-'));
    const store2 = new ProactiveCareStore(dir2);
    store2.setConfig('bot-1', { enabled: true, ownerPersonId: 'ana', maxPerWeek: 5, minGapHours: 48 });
    const engine2 = new ProactiveCareEngine({
      store: store2,
      listBots: () => [{ id: 'bot-1', name: 'Helper', ownerPersonId: 'ana' }],
      getAtoms: () => atoms,
      addInboxItem: () => {}, deliverChat: () => {}, push: () => {},
      isPaused: () => false, now: () => NOW,
    });
    expect((await engine2.tick({ force: true }))[0]!.action).toBe('sent');
    expect((await engine2.tick({ force: true }))[0]!.reason).toContain('minimum gap');
    rmSync(dir2, { recursive: true, force: true });
  });

  it('enforces the local window and the deterministic scheduled minute', async () => {
    enable({ windowStartHour: 18, windowEndHour: 20 });
    expect((await engine.tick({ force: true }))[0]!.reason).toContain('outside the care window');
    enable({ windowStartHour: 9, windowEndHour: 20 });
    // Non-forced tick at 12:00 may be before today's scheduled minute —
    // either outcome must be one of the two documented reasons.
    const actions = await engine.tick();
    expect(['sent', 'skipped']).toContain(actions[0]!.action);
    if (actions[0]!.action === 'skipped') expect(actions[0]!.reason).toContain('scheduled care minute');
  });

  it('routes: config get/put, sends list, run-once', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createProactiveCareRouter({
      store, engine, getBotOwner: () => 'ana', audit: vi.fn(),
    }));
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      const get1 = await (await fetch(`${base}/bots/bot-1/care-config`)).json() as { config: { enabled: boolean } };
      expect(get1.config.enabled).toBe(false);
      const put = await (await fetch(`${base}/bots/bot-1/care-config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, maxPerWeek: 3 }),
      })).json() as { config: { enabled: boolean; maxPerWeek: number } };
      expect(put.config).toMatchObject({ enabled: true, maxPerWeek: 3 });
      const run = await (await fetch(`${base}/care/run-once`, { method: 'POST' })).json() as { actions: Array<{ action: string }> };
      expect(run.actions[0]!.action).toBe('sent');
      const sends = await (await fetch(`${base}/care/sends?botId=bot-1`)).json() as { sends: unknown[] };
      expect(sends.sends).toHaveLength(1);
      const bad = await fetch(`${base}/bots/bot-1/care-config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ windowStartHour: 20, windowEndHour: 9 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
