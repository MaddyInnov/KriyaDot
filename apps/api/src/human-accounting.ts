// SPDX-License-Identifier: Apache-2.0

/**
 * Human time & energy accounting (Octomind parity, Tier 3 small item).
 *
 * Bots consume human attention every time they stop and ask — an
 * approval card, a decision. This report makes that cost visible from
 * data the governance gateway already records (approval request and
 * decision timestamps), so "the agent saved time" claims stay honest:
 *
 *   - interventions: how often a human had to step in at all;
 *   - response time: request → decision latency. This is the time a
 *     bot sat blocked AND a proxy for human attention spent — it is
 *     labeled as exactly that, never as a precise time-tracking log;
 *   - pending: attention debt outstanding right now.
 *
 * GET /accounting/human serves the report (Activity surface).
 */

import type { Router } from 'express';
import type { GovernanceGateway } from '@mvp/governance';

export interface HumanAccountingReport {
  generatedAt: string;
  approvals: {
    requested: number;
    decided: number;
    approved: number;
    denied: number;
    pending: number;
    expired: number;
  };
  /** Request → decision latency over decided approvals (seconds). */
  humanResponse: {
    count: number;
    totalSeconds: number;
    medianSeconds: number;
    p90Seconds: number;
  };
  /** Bots ranked by how much human attention they consumed. */
  byBot: Array<{ botId: string; interventions: number; responseSeconds: number }>;
  /** Sessions ranked by human attention consumed (#47 per-session view). */
  bySession: Array<{ sessionId: string; botId: string; interventions: number; responseSeconds: number }>;
  /**
   * Estimated time saved — deliberately null. Approval data measures
   * human time SPENT (latency), never time saved; this module has no
   * complete autonomous-action ledger to ground an estimate, and a
   * fabricated figure would violate the honesty rule this report
   * exists for. The web renders null as "not provided by the API".
   */
  estimatedTimeSavedSeconds: null;
  note: string;
}

/** Per-session human accounting (#47): one session's interventions. */
export interface SessionHumanAccounting {
  sessionId: string;
  botId: string | null;
  requested: number;
  decided: number;
  approved: number;
  denied: number;
  pending: number;
  /** Decided approvals in this session (each one is a human stepping in). */
  interventions: number;
  responseSeconds: number;
  medianSeconds: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function computeHumanAccounting(
  gateway: GovernanceGateway,
  now: Date = new Date(),
): HumanAccountingReport {
  const all = gateway.listApprovals();
  const decided = all.filter((a) => a.decidedAt !== undefined);
  const latencies = decided
    .map((a) => Math.max(0, (a.decidedAt! - a.ts) / 1000))
    .sort((x, y) => x - y);
  const byBotMap = new Map<string, { interventions: number; responseSeconds: number }>();
  for (const a of decided) {
    const entry = byBotMap.get(a.botId) ?? { interventions: 0, responseSeconds: 0 };
    entry.interventions += 1;
    entry.responseSeconds += Math.max(0, (a.decidedAt! - a.ts) / 1000);
    byBotMap.set(a.botId, entry);
  }
  return {
    generatedAt: now.toISOString(),
    approvals: {
      requested: all.length,
      decided: decided.length,
      approved: all.filter((a) => a.status === 'approved').length,
      denied: all.filter((a) => a.status === 'denied').length,
      pending: all.filter((a) => a.status === 'pending').length,
      expired: all.filter((a) => a.status === 'expired').length,
    },
    humanResponse: {
      count: latencies.length,
      totalSeconds: Math.round(latencies.reduce((s, v) => s + v, 0)),
      medianSeconds: Math.round(percentile(latencies, 50) * 10) / 10,
      p90Seconds: Math.round(percentile(latencies, 90) * 10) / 10,
    },
    byBot: [...byBotMap.entries()]
      .map(([botId, v]) => ({ botId, interventions: v.interventions, responseSeconds: Math.round(v.responseSeconds) }))
      .sort((a, b) => b.interventions - a.interventions)
      .slice(0, 20),
    bySession: [...all.reduce((map, a) => {
      if (a.decidedAt === undefined) return map;
      const entry = map.get(a.sessionId) ?? { botId: a.botId, interventions: 0, responseSeconds: 0 };
      entry.interventions += 1;
      entry.responseSeconds += Math.max(0, (a.decidedAt - a.ts) / 1000);
      map.set(a.sessionId, entry);
      return map;
    }, new Map<string, { botId: string; interventions: number; responseSeconds: number }>()).entries()]
      .map(([sessionId, v]) => ({ sessionId, botId: v.botId, interventions: v.interventions, responseSeconds: Math.round(v.responseSeconds) }))
      .sort((a, b) => b.interventions - a.interventions)
      .slice(0, 20),
    estimatedTimeSavedSeconds: null,
    note: 'Response time is approval request → decision latency: bot blocked time and a proxy for human attention, not a time-tracking log.',
  };
}

/** One session's human accounting, from its approval records (#47). */
export function computeSessionHumanAccounting(
  gateway: GovernanceGateway,
  sessionId: string,
): SessionHumanAccounting {
  const all = gateway.listApprovals().filter((a) => a.sessionId === sessionId);
  const decided = all.filter((a) => a.decidedAt !== undefined);
  const latencies = decided
    .map((a) => Math.max(0, (a.decidedAt! - a.ts) / 1000))
    .sort((x, y) => x - y);
  return {
    sessionId,
    botId: all[0]?.botId ?? null,
    requested: all.length,
    decided: decided.length,
    approved: all.filter((a) => a.status === 'approved').length,
    denied: all.filter((a) => a.status === 'denied').length,
    pending: all.filter((a) => a.status === 'pending').length,
    interventions: decided.length,
    responseSeconds: Math.round(latencies.reduce((s, v) => s + v, 0)),
    medianSeconds: Math.round(percentile(latencies, 50) * 10) / 10,
  };
}

export function registerHumanAccountingRoute(
  router: Router,
  deps: { governance: GovernanceGateway },
): void {
  router.get('/accounting/human', (_req, res) => {
    try {
      res.json({ ok: true, ...computeHumanAccounting(deps.governance) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'accounting failed' });
    }
  });

  // Per-session view (#47): GET /human-accounting?sessionId=… returns
  // { session: {...} } for one session; without the param it serves the
  // same global report as /accounting/human (incl. the bySession list).
  router.get('/human-accounting', (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      if (sessionId) {
        res.json({ ok: true, session: computeSessionHumanAccounting(deps.governance, sessionId) });
        return;
      }
      res.json({ ok: true, ...computeHumanAccounting(deps.governance) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'accounting failed' });
    }
  });
}
