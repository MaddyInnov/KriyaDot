// SPDX-License-Identifier: Apache-2.0
/**
 * Scored decision log for the deterministic message router ("Jev
 * equivalent", packages/agent-runtime/src/message-router.ts).
 *
 * Honesty contract (stated plainly, also in the UI): this is NOT a learned
 * classifier. Routing is hand-written keyword/topic heuristics with
 * user-tunable weights. This module adds what a heuristic router CAN
 * honestly offer:
 *
 * 1. A decision log — every routing decision records its input features
 *    (matched keywords/topics), per-bot scores, the winner, and the
 *    weights version. Raw message text is NEVER logged (only a SHA-256 of
 *    the normalized text, used to join decisions to user feedback).
 * 2. Accuracy stats — when the user judges a decision (via a
 *    message-correction), accuracy is computed over JUDGED decisions only
 *    and labeled as such. Unjudged decisions don't count.
 * 3. Tunable weights — GET/PUT /api/routing/weights. Changing the weights
 *    bumps the version so the log shows which decisions used which weights.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ROUTER_WEIGHTS,
  routeMessageWithWeights,
  scoreBotsForRouting,
  type MessageRoute,
  type RoutableBot,
  type RouterWeights,
} from './message-router.js';

export type { RouterWeights };
export { DEFAULT_ROUTER_WEIGHTS };

const WEIGHTS_FILE = 'routing-weights.json';
const DECISIONS_FILE = 'routing-decisions.jsonl';
const CORRECTIONS_FILE = 'routing-message-corrections.json';
/** Cap the JSONL log so it can't grow unbounded. */
const MAX_DECISION_LINES = 5000;

/** SHA-256 of normalized text — joins decisions to feedback without storing text. */
export function hashRoutingText(text: string): string {
  return createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

function validWeight(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
}

/** Load tunable weights; defaults when absent or corrupt. */
export function loadRouterWeights(dataDir: string): RouterWeights {
  try {
    const raw = readFileSync(join(dataDir, WEIGHTS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RouterWeights>;
    if (validWeight(parsed.directHit) && validWeight(parsed.topicHit) && validWeight(parsed.phraseBonus)) {
      return {
        directHit: parsed.directHit,
        topicHit: parsed.topicHit,
        phraseBonus: parsed.phraseBonus,
        version: typeof parsed.version === 'number' ? parsed.version : 1,
      };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_ROUTER_WEIGHTS };
}

/**
 * Save tunable weights. Bumps `version` so the decision log records which
 * weights each decision used. Throws on invalid weights.
 */
export function saveRouterWeights(
  dataDir: string,
  weights: { directHit?: unknown; topicHit?: unknown; phraseBonus?: unknown },
): RouterWeights {
  const current = loadRouterWeights(dataDir);
  const next: RouterWeights = {
    directHit: weights.directHit === undefined ? current.directHit : weights.directHit as number,
    topicHit: weights.topicHit === undefined ? current.topicHit : weights.topicHit as number,
    phraseBonus: weights.phraseBonus === undefined ? current.phraseBonus : weights.phraseBonus as number,
    version: current.version + 1,
  };
  if (!validWeight(next.directHit) || !validWeight(next.topicHit) || !validWeight(next.phraseBonus)) {
    throw new Error('weights must be finite numbers in [0, 100]');
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, WEIGHTS_FILE), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

export interface RoutingDecisionEntry {
  ts: number;
  /** SHA-256 of normalized message text — raw text is never logged. */
  textHash: string;
  /** Input features: matched keyword/topic hits per bot. */
  scores: Array<{ botId: string; score: number; hits: string[] }>;
  winner: string;
  confidence: number;
  reason: string;
  weightsVersion: number;
}

export class RouterDecisionLog {
  private readonly path: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, DECISIONS_FILE);
  }

  record(entry: RoutingDecisionEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    // Bound the log: keep the newest MAX_DECISION_LINES lines.
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_DECISION_LINES) {
        writeFileSync(this.path, `${lines.slice(-MAX_DECISION_LINES).join('\n')}\n`, 'utf8');
      }
    } catch {
      // bounding is best-effort
    }
  }

  list(limit = 100): RoutingDecisionEntry[] {
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      return lines
        .slice(-Math.min(Math.max(limit, 1), MAX_DECISION_LINES))
        .map((l) => JSON.parse(l) as RoutingDecisionEntry)
        .reverse();
    } catch {
      return [];
    }
  }

  /** All entries (for stats); bounded by the log cap. */
  all(): RoutingDecisionEntry[] {
    try {
      return readFileSync(this.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RoutingDecisionEntry);
    } catch {
      return [];
    }
  }
}

/**
 * Route + log. The single entry point hosts should use for message routing
 * so every decision lands in the scored log.
 */
export function routeMessageLogged(
  text: string,
  bots: RoutableBot[],
  log: RouterDecisionLog,
  weights?: RouterWeights,
): MessageRoute {
  const w = weights ?? DEFAULT_ROUTER_WEIGHTS;
  const route = routeMessageWithWeights(text, bots, w);
  const scores = scoreBotsForRouting(text, bots, w).map((s) => ({
    botId: s.botId,
    score: s.score,
    hits: [...new Set(s.hits)].slice(0, 8),
  }));
  log.record({
    ts: Date.now(),
    textHash: hashRoutingText(text),
    scores,
    winner: route.botId,
    confidence: route.confidence,
    reason: route.reason,
    weightsVersion: w.version,
  });
  return route;
}

// ---------------------------------------------------------------------------
// User feedback (message-corrections) + accuracy stats
// ---------------------------------------------------------------------------

export interface MessageRoutingCorrection {
  /** The judged message (stored; used only for local hash-join). */
  message: string;
  routedBotId: string;
  correctedBotId: string;
  at: number;
}

function isPlausibleCorrection(o: unknown): o is MessageRoutingCorrection {
  if (typeof o !== 'object' || o === null) return false;
  const c = o as Record<string, unknown>;
  return (
    typeof c.message === 'string' &&
    typeof c.routedBotId === 'string' &&
    typeof c.correctedBotId === 'string'
  );
}

export function loadMessageCorrections(dataDir: string): MessageRoutingCorrection[] {
  try {
    const path = join(dataDir, CORRECTIONS_FILE);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { corrections?: unknown }).corrections;
    if (!Array.isArray(list)) return [];
    return list.filter(isPlausibleCorrection);
  } catch {
    return [];
  }
}

/**
 * Record that the user judged a routing decision: the router picked
 * routedBotId for `message`, the user says correctedBotId was right.
 * (correctedBotId === routedBotId records an explicit "correct" judgment.)
 */
export function recordMessageCorrection(
  dataDir: string,
  correction: { message: string; routedBotId: string; correctedBotId: string },
): MessageRoutingCorrection[] {
  const message = correction.message.trim().slice(0, 2000);
  if (!message) throw new Error('message is required');
  if (!correction.routedBotId.trim() || !correction.correctedBotId.trim()) {
    throw new Error('routedBotId and correctedBotId are required');
  }
  const corrections = loadMessageCorrections(dataDir);
  corrections.unshift({
    message,
    routedBotId: correction.routedBotId.trim(),
    correctedBotId: correction.correctedBotId.trim(),
    at: Date.now(),
  });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, CORRECTIONS_FILE),
    JSON.stringify({ version: 1, corrections: corrections.slice(0, 1000) }, null, 2) + '\n',
    'utf8',
  );
  return corrections;
}

export interface RoutingStats {
  /** Total logged decisions. */
  totalDecisions: number;
  /** Decisions the user judged (via a message-correction). */
  judged: number;
  /** Judged decisions where the router's pick matched the user's pick. */
  correct: number;
  /**
   * correct / judged, or null when nothing was judged. This is measured
   * agreement with the user — NOT a learned model's accuracy.
   */
  accuracy: number | null;
  avgConfidence: number;
  lowConfidenceRate: number;
  perBot: Record<string, { decisions: number; wins: number }>;
  weightsVersion: number;
  corrections: number;
}

/**
 * Compute honest stats: accuracy is measured ONLY over user-judged
 * decisions and labeled as agreement, never as model accuracy.
 */
export function computeRoutingStats(dataDir: string): RoutingStats {
  const log = new RouterDecisionLog(dataDir);
  const decisions = log.all();
  const corrections = loadMessageCorrections(dataDir);
  const judgedByHash = new Map<string, MessageRoutingCorrection>();
  for (const c of corrections) {
    const h = hashRoutingText(c.message);
    if (!judgedByHash.has(h)) judgedByHash.set(h, c);
  }
  let correct = 0;
  let judged = 0;
  let confSum = 0;
  let lowConf = 0;
  const perBot: Record<string, { decisions: number; wins: number }> = {};
  for (const d of decisions) {
    confSum += d.confidence;
    if (d.confidence < 0.5) lowConf += 1;
    const judgedAs = judgedByHash.get(d.textHash);
    if (judgedAs) {
      judged += 1;
      // A decision is correct when the router's pick equals the user's pick.
      // (The correction records routedBotId at judgment time; the user may
      // also explicitly confirm by setting correctedBotId === routedBotId.)
      if (judgedAs.routedBotId === judgedAs.correctedBotId || d.winner === judgedAs.correctedBotId) {
        correct += 1;
      }
    }
    for (const s of d.scores) {
      const e = perBot[s.botId] ?? { decisions: 0, wins: 0 };
      e.decisions += 1;
      if (s.botId === d.winner) e.wins += 1;
      perBot[s.botId] = e;
    }
  }
  const weights = loadRouterWeights(dataDir);
  return {
    totalDecisions: decisions.length,
    judged,
    correct,
    accuracy: judged > 0 ? Math.round((correct / judged) * 1000) / 1000 : null,
    avgConfidence: decisions.length > 0 ? Math.round((confSum / decisions.length) * 1000) / 1000 : 0,
    lowConfidenceRate: decisions.length > 0 ? Math.round((lowConf / decisions.length) * 1000) / 1000 : 0,
    perBot,
    weightsVersion: weights.version,
    corrections: corrections.length,
  };
}
