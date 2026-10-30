// SPDX-License-Identifier: Apache-2.0
// Daily Ideas curation (I-6): rank candidate ideas by feasibility / fit /
// novelty from the user's real context (goals + memory snippets), then
// file the best ones into the IdeaStore so dreaming feeds the Ideas tab,
// not only the morning briefing.
//
// Scoring is deterministic and offline (no model call): token overlap
// against goals/memory for fit, scope heuristics for feasibility, and
// Jaccard distance from ideas already in the store for novelty. Every
// filed idea carries its scores, a plain-language rationale and the
// evidence strings behind it — the provenance SI-5 looks up.

import { IdeaStore, type Idea, type IdeaScores } from './index.js';

export interface IdeaCandidate {
  title: string;
  description?: string;
  /** Where the candidate came from, e.g. 'dream', 'goal-study'. */
  origin?: string;
}

export interface CurationContext {
  /** Active goal titles/descriptions — fit is measured against these. */
  goals: string[];
  /** Recent memory snippets/episodes — secondary fit signal. */
  memorySnippets: string[];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'your', 'you', 'that', 'this', 'it', 'is', 'are', 'be', 'from', 'into', 'using', 'use', 'app', 'tool',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const ACTION_VERBS = [
  'build', 'create', 'write', 'track', 'plan', 'automate', 'compare', 'review', 'learn', 'practice', 'record', 'list', 'draft', 'summarise', 'summarize', 'organise', 'organize', 'schedule', 'analyse', 'analyze',
];
const HEAVY_MARKERS = [
  'raise funding', 'hire a team', 'hire team', 'patent', 'ipo', 'acquire a company', 'build a factory', 'launch a satellite',
];

export interface ScoredCandidate {
  candidate: IdeaCandidate;
  scores: IdeaScores;
  rationale: string;
  evidence: string[];
  /** Goal/memory strings the candidate matched (subset of evidence). */
  matchedContext: string[];
}

/** Score one candidate against the user's context and existing ideas. */
export function scoreCandidate(
  candidate: IdeaCandidate,
  ctx: CurationContext,
  existing: Array<{ title: string; description: string }>,
): ScoredCandidate {
  const text = `${candidate.title} ${candidate.description ?? ''}`;
  const tokens = tokenize(text);

  // Fit: strongest single goal match dominates; memory adds a smaller leg.
  let bestGoal = 0;
  let bestGoalText = '';
  const matched: string[] = [];
  for (const goal of ctx.goals) {
    const s = jaccard(tokens, tokenize(goal));
    if (s > bestGoal) {
      bestGoal = s;
      bestGoalText = goal;
    }
  }
  let bestMemory = 0;
  let bestMemoryText = '';
  for (const snippet of ctx.memorySnippets) {
    const s = jaccard(tokens, tokenize(snippet));
    if (s > bestMemory) {
      bestMemory = s;
      bestMemoryText = snippet;
    }
  }
  const fit = Math.min(1, bestGoal * 1.6 + bestMemory * 0.8);
  if (bestGoal >= 0.08 && bestGoalText) matched.push(`goal: ${bestGoalText.slice(0, 120)}`);
  if (bestMemory >= 0.08 && bestMemoryText) matched.push(`memory: ${bestMemoryText.slice(0, 120)}`);

  // Feasibility: scoped + actionable reads as doable; heavy markers cost.
  let feasibility = 0.5;
  const lower = text.toLowerCase();
  if ((candidate.description ?? '').trim().length >= 40) feasibility += 0.15;
  if (ACTION_VERBS.some((v) => lower.includes(v))) feasibility += 0.15;
  if (tokens.size > 0 && tokens.size <= 18) feasibility += 0.1;
  if (HEAVY_MARKERS.some((m) => lower.includes(m))) feasibility -= 0.35;
  feasibility = Math.min(1, Math.max(0, feasibility));

  // Novelty: distance from the closest idea already in the store.
  let maxSim = 0;
  for (const idea of existing) {
    maxSim = Math.max(maxSim, jaccard(tokens, tokenize(`${idea.title} ${idea.description}`)));
  }
  const novelty = 1 - maxSim;

  const rank = Math.min(1, Math.max(0, 0.4 * fit + 0.35 * feasibility + 0.25 * novelty));
  const scores: IdeaScores = { feasibility, fit, novelty, rank };
  const rationale =
    `rank ${rank.toFixed(2)} = fit ${fit.toFixed(2)} (goals/memory overlap), ` +
    `feasibility ${feasibility.toFixed(2)}, novelty ${novelty.toFixed(2)}` +
    (candidate.origin ? `; source: ${candidate.origin}` : '');
  return { candidate, scores, rationale, evidence: matched, matchedContext: matched };
}

/** Rank candidates best-first without filing anything. */
export function rankCandidates(
  candidates: IdeaCandidate[],
  ctx: CurationContext,
  existing: Array<{ title: string; description: string }>,
): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(c, ctx, existing))
    .sort((a, b) => b.scores.rank - a.scores.rank);
}

export interface CurationResult {
  created: Idea[];
  skipped: Array<{ title: string; reason: 'duplicate' | 'below-threshold' | 'over-limit' }>;
}

export interface CuratorOptions {
  /** How many ideas one curation pass files at most. */
  maxKeep?: number;
  /** Minimum rank to file. */
  minRank?: number;
  /** Novelty below this counts as a duplicate of an existing idea. */
  duplicateNoveltyBelow?: number;
  /** TTL stamped on filed ideas (I-5 expiry input). */
  ttlMs?: number;
  now?: number;
}

/**
 * The daily curation pass: score → dedupe → file the top candidates into
 * the IdeaStore with provenance. The host wires candidate sources
 * (dreaming output, goal-study suggestions) and the context (goals +
 * memory); this class owns the ranking and filing rules.
 */
export class DailyIdeaCurator {
  constructor(
    private readonly store: IdeaStore,
    private readonly opts: CuratorOptions = {},
  ) {}

  curate(candidates: IdeaCandidate[], ctx: CurationContext): CurationResult {
    const maxKeep = this.opts.maxKeep ?? 5;
    const minRank = this.opts.minRank ?? 0.25;
    const dupBelow = this.opts.duplicateNoveltyBelow ?? 0.35;
    const ttlMs = this.opts.ttlMs ?? 14 * 24 * 60 * 60 * 1000;
    const now = this.opts.now ?? Date.now();

    const existing = this.store.list().filter((i) => i.status !== 'expired');
    const scored = rankCandidates(candidates, ctx, existing);
    const created: Idea[] = [];
    const skipped: CurationResult['skipped'] = [];
    const filedTokens: Array<Set<string>> = [];
    for (const s of scored) {
      if (s.scores.novelty < dupBelow) {
        skipped.push({ title: s.candidate.title, reason: 'duplicate' });
        continue;
      }
      const tokens = tokenize(`${s.candidate.title} ${s.candidate.description ?? ''}`);
      if (filedTokens.some((t) => jaccard(tokens, t) > 0.65)) {
        skipped.push({ title: s.candidate.title, reason: 'duplicate' });
        continue;
      }
      if (s.scores.rank < minRank) {
        skipped.push({ title: s.candidate.title, reason: 'below-threshold' });
        continue;
      }
      if (created.length >= maxKeep) {
        skipped.push({ title: s.candidate.title, reason: 'over-limit' });
        continue;
      }
      created.push(
        this.store.create({
          title: s.candidate.title,
          description: s.candidate.description ?? '',
          source: 'curation',
          scores: s.scores,
          rationale: s.rationale,
          evidence: s.evidence,
          expiresAt: now + ttlMs,
        }),
      );
      filedTokens.push(tokens);
    }
    return { created, skipped };
  }
}
