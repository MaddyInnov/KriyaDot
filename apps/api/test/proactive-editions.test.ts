// SPDX-License-Identifier: Apache-2.0
// Proactive editions + pacing (CT-11 / CT-12): pacing gate (waking hours,
// daily cap, min gap, muted topics), steering order, edition packaging
// (multi-item, sourced), delivery outcomes, external-send accounting,
// and the HTTP routes. Delivery is an injected stub — nothing is sent.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProactiveEditionService,
  ProactiveEditionStore,
  buildEdition,
  decidePacing,
  defaultPacingConfig,
  steerItems,
  type PacingConfig,
} from '../src/proactive-editions.js';
import { createProactiveEditionRouter } from '../src/proactive-edition-routes.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'proactive-editions-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Fixed local times so window checks are timezone-independent.
const MIDDAY = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
const EARLY = new Date(2026, 0, 15, 5, 0, 0, 0).getTime();
const LATE = new Date(2026, 0, 15, 23, 0, 0, 0).getTime();

function cfg(over: Partial<PacingConfig> = {}): PacingConfig {
  return { ...defaultPacingConfig(), ...over };
}

const items = [
  { headline: 'CI is green again', sourceLabel: 'GitHub', sourceUrl: 'https://example.invalid/ci', topic: 'dev' },
  { headline: 'Standup moved to 10:00', summary: 'Calendar change', sourceLabel: 'Calendar', topic: 'work' },
  { headline: 'Crypto moon soon', sourceLabel: 'Blog', topic: 'crypto' },
];

describe('CT-12 pacing gate', () => {
  it('allows inside waking hours under cap with gap satisfied', () => {
    expect(decidePacing(cfg(), { sendsToday: 0 }, MIDDAY).allowed).toBe(true);
  });
  it('blocks before/after waking hours with a next-allowed time', () => {
    const early = decidePacing(cfg(), { sendsToday: 0 }, EARLY);
    expect(early.allowed).toBe(false);
    expect(early.reason).toContain('waking hours');
    expect(new Date(early.nextAllowedAt!).getHours()).toBe(8);
    const late = decidePacing(cfg(), { sendsToday: 0 }, LATE);
    expect(late.allowed).toBe(false);
    expect(new Date(late.nextAllowedAt!).getDate()).toBe(16);
  });
  it('blocks at the daily cap and when cap is 0 (proactive off)', () => {
    expect(decidePacing(cfg({ dailyCap: 3 }), { sendsToday: 3 }, MIDDAY).reason).toContain('cap reached');
    expect(decidePacing(cfg({ dailyCap: 0 }), { sendsToday: 0 }, MIDDAY).allowed).toBe(false);
  });
  it('blocks inside the minimum gap', () => {
    const d = decidePacing(cfg({ minGapMinutes: 120 }), { sendsToday: 1, lastSentAt: MIDDAY - 30 * 60_000 }, MIDDAY);
    expect(d.allowed).toBe(false);
    expect(d.nextAllowedAt).toBe(MIDDAY - 30 * 60_000 + 120 * 60_000);
  });
  it('blocks muted topics outright', () => {
    const d = decidePacing(cfg({ mutedTopics: ['crypto'] }), { sendsToday: 0 }, MIDDAY, 'Crypto');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('muted');
  });
  it('validates config: window order, bounds, topic normalization', () => {
    const store = new ProactiveEditionStore(tmp());
    expect(() => store.setPacingConfig({ wakingStartHour: 22, wakingEndHour: 6 })).toThrow(/after wakingStartHour/);
    expect(() => store.setPacingConfig({ dailyCap: 99 })).toThrow(/dailyCap/);
    const saved = store.setPacingConfig({ preferredTopics: [' Dev ', 'dev', 'Work'] });
    expect(saved.preferredTopics).toEqual(['dev', 'work']);
    store.close();
  });
});

describe('preference steering', () => {
  it('preferred topics sort first (stable), muted excluded at build time', () => {
    const c = cfg({ preferredTopics: ['work'], mutedTopics: ['crypto'] });
    expect(steerItems(c, items).map((i) => i.topic)).toEqual(['work', 'dev', 'crypto']);
    const { edition, excluded } = buildEdition(c, { title: 'Morning edition', items }, MIDDAY);
    expect(excluded.map((i) => i.topic)).toEqual(['crypto']);
    expect(edition.items.map((i) => i.headline)).toEqual(['Standup moved to 10:00', 'CI is green again']);
    expect(edition.items[0]!.position).toBe(1);
  });
});

describe('CT-11 editions', () => {
  it('composes a numbered, sourced digest text', () => {
    const { edition } = buildEdition(cfg(), { title: 'Morning edition', items }, MIDDAY);
    expect(edition.text).toContain('📰 Morning edition');
    expect(edition.text).toContain('1. CI is green again');
    expect(edition.text).toContain('Source: GitHub — https://example.invalid/ci');
    expect(edition.text).toContain('2. Standup moved to 10:00');
    expect(edition.status).toBe('draft');
  });

  it('an edition whose items are all muted is suppressed, never sent empty', () => {
    const { edition } = buildEdition(cfg({ mutedTopics: ['crypto', 'dev', 'work'] }), { title: 'X', items }, MIDDAY);
    expect(edition.status).toBe('suppressed');
    expect(edition.items).toHaveLength(0);
  });

  it('caps edition size at 8 items', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ headline: `Item ${i}`, sourceLabel: 'S' }));
    const { edition } = buildEdition(cfg(), { title: 'Big', items: many }, MIDDAY);
    expect(edition.items).toHaveLength(8);
  });
});

describe('delivery through the pacing gate', () => {
  function makeService(now: number, config?: Partial<PacingConfig>) {
    const store = new ProactiveEditionStore(tmp());
    if (config) store.setPacingConfig(config);
    const delivered: string[] = [];
    const service = new ProactiveEditionService({
      store,
      deliver: ({ text }) => { delivered.push(text); },
      audit: () => {},
      now: () => now,
    });
    return { service, store, delivered };
  }

  it('sends inside the window, records the send, and is idempotent', async () => {
    const { service, delivered } = makeService(MIDDAY);
    const { edition } = await service.publishEdition({ title: 'Morning edition', items });
    expect(edition.status).toBe('sent');
    expect(delivered).toHaveLength(1);
    const again = await service.deliverEdition(edition.id);
    expect(again.status).toBe('sent');
    expect(delivered).toHaveLength(1); // no double-send
    expect(service.pacingStatus(MIDDAY).sendsToday).toBe(1);
  });

  it('defers outside waking hours with the reason, delivers later', async () => {
    const { service, delivered } = makeService(EARLY);
    const { edition } = service.createEdition({ title: 'Early edition', items });
    const deferred = await service.deliverEdition(edition.id);
    expect(deferred.status).toBe('deferred');
    expect(deferred.statusReason).toContain('waking hours');
    expect(delivered).toHaveLength(0);
  });

  it('daily cap counts external sends (e.g. proactive care)', async () => {
    const { service, delivered } = makeService(MIDDAY, { dailyCap: 1 });
    service.recordExternalSend('proactive-care');
    const { edition } = await service.publishEdition({ title: 'Capped', items });
    expect(edition.status).toBe('deferred');
    expect(edition.statusReason).toContain('cap reached');
    expect(delivered).toHaveLength(0);
  });

  it('cap 0 suppresses delivery', async () => {
    const { service } = makeService(MIDDAY, { dailyCap: 0 });
    const { edition } = await service.publishEdition({ title: 'Off', items });
    expect(edition.status).toBe('suppressed');
  });
});

describe('HTTP routes', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    const store = new ProactiveEditionStore(tmp());
    const service = new ProactiveEditionService({ store, deliver: () => {}, audit: () => {}, now: () => MIDDAY });
    const app = express();
    app.use(express.json());
    app.use('/api/proactive', createProactiveEditionRouter({ service }));
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/proactive`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('pacing GET/PUT + publish flow', async () => {
    const pacing = await (await fetch(`${base}/pacing`)).json() as { config: { dailyCap: number }; decision: { allowed: boolean } };
    expect(pacing.config.dailyCap).toBe(3);
    expect(pacing.decision.allowed).toBe(true);

    const bad = await fetch(`${base}/pacing`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wakingStartHour: 20, wakingEndHour: 9 }) });
    expect(bad.status).toBe(400);

    const put = await fetch(`${base}/pacing`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mutedTopics: ['crypto'] }) });
    expect(put.status).toBe(200);

    const published = await fetch(`${base}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Morning edition', items }) });
    expect(published.status).toBe(201);
    const { edition, excludedCount } = (await published.json()) as { edition: { status: string; items: unknown[] }; excludedCount: number };
    expect(edition.status).toBe('sent');
    expect(excludedCount).toBe(1);
    expect(edition.items).toHaveLength(2);
  });
});
