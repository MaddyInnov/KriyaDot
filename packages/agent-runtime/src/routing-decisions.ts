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

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivationDecision, DiscoveryHit } from './discovery.js';
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
  /** Directory the log lives in (invocation log derives its path from it). */
  readonly dataDir: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.path = join(dataDir, DECISIONS_FILE);
  }

  /** The invocation-decision log sharing this log's directory. */
  invocationLog(): InvocationDecisionLog {
    return new InvocationDecisionLog(this.dataDir);
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
  // Invocation decision model: every routing decision is ALSO an
  // invocation decision (kind 'routing') in the unified log — this is the
  // real producer wiring for routing, since hosts already route through
  // this function. Best-effort: the unified log must never break routing.
  try {
    log.invocationLog().record({
      kind: 'routing',
      subject: route.botId,
      outcome: 'routed',
      confidence: route.confidence,
      rationale: route.reason,
      metadata: { textHash: hashRoutingText(text), weightsVersion: w.version, scores },
    });
  } catch {
    // best-effort
  }
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

// ---------------------------------------------------------------------------
// Invocation decision model (Octop §2.5 parity, original implementation)
// ---------------------------------------------------------------------------
//
// Routing is only one kind of invocation decision the system makes. This
// section generalizes the scored log above to every invocation decision:
//
//   kind               producer (real wiring)
//   -----------------  -----------------------------------------------------
//   routing            routeMessageLogged() above (same call, both logs)
//   skill-activation   discovery.ts decideAutoActivation() — it notifies a
//                      registered sink on EVERY decision (see discovery.ts
//                      registerDiscoveryDecisionSink); hosts register
//                      createInvocationSink(log) once at startup.
//   tool-invocation    the governance gateway — GatewayOptions.onDecision
//                      (packages/governance, a small optional callback) is
//                      invoked for every evaluate() outcome; hosts pass
//                      createGovernanceDecisionSink(log).
//   delegation         tools/delegate.ts — its optional recordDecision
//                      callback fires for subagent + ACP outcomes.
//
// Every record carries a confidence (0–1, producer-defined and documented
// per producer) and a human-readable rationale. Agreement stats are, like
// the routing stats above, computed ONLY over records a user judged
// (markJudged) and labelled agreement — never model accuracy. Raw user
// text is never stored: delegation records carry a hash of the task.

export type InvocationKind = 'routing' | 'skill-activation' | 'tool-invocation' | 'delegation';

export const INVOCATION_KINDS: readonly InvocationKind[] = [
  'routing', 'skill-activation', 'tool-invocation', 'delegation',
] as const;

export function isInvocationKind(v: unknown): v is InvocationKind {
  return typeof v === 'string' && (INVOCATION_KINDS as readonly string[]).includes(v);
}

export interface InvocationDecisionEntry {
  id: string;
  ts: number;
  kind: InvocationKind;
  /** What was invoked / chosen: bot id, skill id, tool name, delegate target. */
  subject: string;
  /** Producer vocabulary: routed|activated|abstained|allow|deny|ask|success|failed|… */
  outcome: string;
  confidence: number;
  rationale: string;
  botId?: string;
  actor?: string;
  /** User judgment: true = the decision was right, false = wrong, absent = unjudged. */
  judgedCorrect?: boolean;
  metadata?: Record<string, unknown>;
}

export type NewInvocationDecision = Omit<InvocationDecisionEntry, 'id' | 'ts'> & { ts?: number };

const INVOCATION_FILE = 'invocation-decisions.jsonl';
const MAX_INVOCATION_LINES = 5000;

function clampConfidence(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export class InvocationDecisionLog {
  private readonly path: string;
  readonly dataDir: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.path = join(dataDir, INVOCATION_FILE);
  }

  record(input: NewInvocationDecision): InvocationDecisionEntry {
    const entry: InvocationDecisionEntry = {
      ...input,
      confidence: clampConfidence(input.confidence),
      rationale: String(input.rationale ?? '').slice(0, 1000),
      subject: String(input.subject ?? '').slice(0, 200),
      outcome: String(input.outcome ?? '').slice(0, 64),
      id: `inv_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      ts: input.ts ?? Date.now(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_INVOCATION_LINES) {
        writeFileSync(this.path, `${lines.slice(-MAX_INVOCATION_LINES).join('\n')}\n`, 'utf8');
      }
    } catch {
      // bounding is best-effort
    }
    return entry;
  }

  list(limit = 100, kind?: InvocationKind): InvocationDecisionEntry[] {
    return this.all()
      .filter((e) => !kind || e.kind === kind)
      .slice(-Math.min(Math.max(limit, 1), MAX_INVOCATION_LINES))
      .reverse();
  }

  all(): InvocationDecisionEntry[] {
    try {
      return readFileSync(this.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as InvocationDecisionEntry)
        .filter((e) => e && isInvocationKind(e.kind));
    } catch {
      return [];
    }
  }

  /** Record a user judgment on one decision (agreement stats input). */
  markJudged(id: string, correct: boolean): InvocationDecisionEntry | undefined {
    const entries = this.all();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return undefined;
    entries[idx] = { ...entries[idx]!, judgedCorrect: correct };
    writeFileSync(this.path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
    return entries[idx];
  }
}

// ---- Producer adapters ------------------------------------------------------

/**
 * Sink for semantic-discovery activation decisions. Register once:
 *   registerDiscoveryDecisionSink(createInvocationSink(log))
 * (discovery.ts notifies the sink from decideAutoActivation — the exact
 * function runtime.ts calls — so skill activations are recorded without
 * touching the runtime.)
 * Confidence = top hit score when activating; when abstaining, the
 * confidence is in the ABSTENTION: 1 − top score (bounded).
 */
export function createInvocationSink(
  log: InvocationDecisionLog,
): (decision: ActivationDecision, hits: DiscoveryHit[]) => void {
  return (decision, hits) => {
    try {
      const top = hits[0]?.score ?? 0;
      if (decision.abstained || decision.activate.length === 0) {
        log.record({
          kind: 'skill-activation',
          subject: hits[0]?.item.id ?? '(none)',
          outcome: 'abstained',
          confidence: Math.min(1, Math.max(0, 1 - top)),
          rationale: decision.reason,
          metadata: { candidates: hits.slice(0, 8).map((h) => ({ id: h.item.id, score: h.score })) },
        });
        return;
      }
      for (const hit of decision.activate) {
        log.record({
          kind: 'skill-activation',
          subject: hit.item.id,
          outcome: 'activated',
          confidence: hit.score,
          rationale: decision.reason,
          metadata: { kind: hit.item.kind, score: hit.score },
        });
      }
    } catch {
      // Recording must never break discovery.
    }
  };
}

/** Structural shape of the governance gateway's onDecision event. */
export interface GovernanceDecisionEvent {
  toolName: string;
  effect: 'allow' | 'deny' | 'require-approval';
  botId: string;
  actor: string;
  sessionId: string;
  reason?: string;
  ruleId?: string;
  approvalId?: string;
}

/**
 * Sink for governance tool-invocation decisions. Pass to the gateway:
 *   new GovernanceGateway({ ..., onDecision: createGovernanceDecisionSink(log) })
 * Outcome vocabulary: allow | deny | ask (require-approval).
 * Confidence: 1 when an explicit policy rule / hard floor decided,
 * 0.6 when the policy default decided (documented heuristic, not a model).
 */
export function createGovernanceDecisionSink(
  log: InvocationDecisionLog,
): (event: GovernanceDecisionEvent) => void {
  return (event) => {
    try {
      log.record({
        kind: 'tool-invocation',
        subject: event.toolName,
        outcome: event.effect === 'require-approval' ? 'ask' : event.effect,
        confidence: event.ruleId || event.reason?.startsWith('hard floor') || event.reason?.includes('floor') ? 1 : 0.6,
        rationale: event.reason ?? `governance ${event.effect} for ${event.toolName}`,
        botId: event.botId,
        actor: event.actor,
        metadata: {
          sessionId: event.sessionId,
          ...(event.ruleId ? { ruleId: event.ruleId } : {}),
          ...(event.approvalId ? { approvalId: event.approvalId } : {}),
        },
      });
    } catch {
      // Recording must never break governance.
    }
  };
}

/** Recording callback shape consumed by tools/delegate.ts. */
export interface DelegationDecisionEvent {
  delegatingBotId: string;
  targetBotId: string;
  via: 'subagent' | 'acp';
  outcome: 'success' | 'failed';
  task: string;
  error?: string;
}

/**
 * Sink for delegation decisions, wired via createDelegateTools'
 * recordDecision option. The task text itself is NEVER stored — only its
 * SHA-256 (same honesty rule as routing text).
 * Confidence: 1 on success, 0 on failure (the outcome IS the evidence).
 */
export function createDelegationDecisionSink(
  log: InvocationDecisionLog,
): (event: DelegationDecisionEvent) => void {
  return (event) => {
    try {
      log.record({
        kind: 'delegation',
        subject: event.targetBotId,
        outcome: event.outcome,
        confidence: event.outcome === 'success' ? 1 : 0,
        rationale:
          event.outcome === 'success'
            ? `Delegation from ${event.delegatingBotId} to ${event.targetBotId} via ${event.via} completed`
            : `Delegation from ${event.delegatingBotId} to ${event.targetBotId} via ${event.via} failed: ${event.error ?? 'unknown error'}`.slice(0, 1000),
        botId: event.delegatingBotId,
        metadata: { via: event.via, taskHash: hashRoutingText(event.task) },
      });
    } catch {
      // Recording must never break delegation.
    }
  };
}

// ---- Stats ------------------------------------------------------------------

export interface InvocationKindStats {
  total: number;
  judged: number;
  correct: number;
  /** correct / judged over USER-JUDGED records only, or null when unjudged. */
  agreementRate: number | null;
  avgConfidence: number;
  outcomes: Record<string, number>;
}

export interface InvocationStats {
  total: number;
  judged: number;
  correct: number;
  agreementRate: number | null;
  perKind: Record<InvocationKind, InvocationKindStats>;
}

/** Aggregate invocation stats, optionally from an explicit entry list. */
export function computeInvocationStats(
  dataDirOrEntries: string | InvocationDecisionEntry[],
): InvocationStats {
  const entries = Array.isArray(dataDirOrEntries)
    ? dataDirOrEntries
    : new InvocationDecisionLog(dataDirOrEntries).all();
  const empty = (): InvocationKindStats => ({
    total: 0, judged: 0, correct: 0, agreementRate: null, avgConfidence: 0, outcomes: {},
  });
  const perKind = Object.fromEntries(INVOCATION_KINDS.map((k) => [k, empty()])) as Record<InvocationKind, InvocationKindStats>;
  const confSums = Object.fromEntries(INVOCATION_KINDS.map((k) => [k, 0])) as Record<InvocationKind, number>;
  let judged = 0;
  let correct = 0;
  for (const e of entries) {
    const s = perKind[e.kind];
    if (!s) continue;
    s.total += 1;
    confSums[e.kind] += e.confidence;
    s.outcomes[e.outcome] = (s.outcomes[e.outcome] ?? 0) + 1;
    if (typeof e.judgedCorrect === 'boolean') {
      s.judged += 1;
      judged += 1;
      if (e.judgedCorrect) { s.correct += 1; correct += 1; }
    }
  }
  for (const k of INVOCATION_KINDS) {
    const s = perKind[k];
    s.avgConfidence = s.total > 0 ? Math.round((confSums[k] / s.total) * 1000) / 1000 : 0;
    s.agreementRate = s.judged > 0 ? Math.round((s.correct / s.judged) * 1000) / 1000 : null;
  }
  return {
    total: entries.length,
    judged,
    correct,
    agreementRate: judged > 0 ? Math.round((correct / judged) * 1000) / 1000 : null,
    perKind,
  };
}
