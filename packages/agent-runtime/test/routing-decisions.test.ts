// SPDX-License-Identifier: Apache-2.0
// Tests for routing-decisions.ts (honest "Jev equivalent" observability):
// - routeMessageLogged records a decision with features (no raw text)
// - computeRoutingStats reports volume + accuracy over JUDGED decisions only
// - recordMessageCorrection + loadMessageCorrections round-trip
// - saveRouterWeights/loadRouterWeights validate + persist

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeRoutingStats,
  DEFAULT_ROUTER_WEIGHTS,
  loadMessageCorrections,
  loadRouterWeights,
  recordMessageCorrection,
  RouterDecisionLog,
  routeMessageLogged,
  saveRouterWeights,
} from '../src/routing-decisions.js';

const BOTS = [
  { id: 'support', name: 'Support', description: 'customer support bot', keywords: ['refund', 'ticket'] },
  { id: 'dev', name: 'Dev', description: 'code bot', keywords: ['deploy', 'bug'] },
];

describe('routeMessageLogged', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'routerdec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs a decision with features and never the raw text', () => {
    const log = new RouterDecisionLog(dir);
    const result = routeMessageLogged('I need a refund for my ticket', BOTS, log, DEFAULT_ROUTER_WEIGHTS);
    expect(result.botId).toBe('support');
    const [entry] = log.list(1);
    expect(entry.winner).toBe('support');
    expect(entry.scores.length).toBeGreaterThan(0);
    expect(JSON.stringify(entry)).not.toContain('refund for my ticket');
    expect(entry.textHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeRoutingStats', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'routerstats-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures accuracy only over judged decisions', () => {
    const log = new RouterDecisionLog(dir);
    routeMessageLogged('refund please', BOTS, log, DEFAULT_ROUTER_WEIGHTS);
    routeMessageLogged('deploy the fix', BOTS, log, DEFAULT_ROUTER_WEIGHTS);
    recordMessageCorrection(dir, { message: 'refund please', routedBotId: 'support', correctedBotId: 'support' });
    const stats = computeRoutingStats(dir);
    expect(stats.totalDecisions).toBe(2);
    expect(stats.judged).toBe(1);
    expect(stats.accuracy).toBe(1);
  });
});

describe('router weights', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'routerw-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads defaults, saves and reloads user weights', () => {
    expect(loadRouterWeights(dir)).toEqual(DEFAULT_ROUTER_WEIGHTS);
    const saved = saveRouterWeights(dir, { directHit: 10, topicHit: 2 });
    expect(saved.directHit).toBe(10);
    expect(loadRouterWeights(dir).directHit).toBe(10);
  });
  it('rejects invalid weights', () => {
    expect(() => saveRouterWeights(dir, { directHit: -5 })).toThrow();
    expect(() => saveRouterWeights(dir, { topicHit: Number.NaN })).toThrow();
    // Unknown keys are ignored, not rejected.
    const saved = saveRouterWeights(dir, { bogus: 1 } as never);
    expect(saved.directHit).toBe(DEFAULT_ROUTER_WEIGHTS.directHit);
  });
  it('message corrections round-trip', () => {
    recordMessageCorrection(dir, { message: 'hi', routedBotId: 'a', correctedBotId: 'b' });
    const all = loadMessageCorrections(dir);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ routedBotId: 'a', correctedBotId: 'b' });
  });
});
