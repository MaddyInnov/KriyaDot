// SPDX-License-Identifier: Apache-2.0
/**
 * Named self-improvement loops (audit §4.3): SI-1, SI-3, SI-4.
 *
 *   SI-1  DailyGoalStudyLoop — one named daily loop per goal set: a
 *         per-goal research briefing, a progress nudge when a goal has
 *         stalled, and implied-goal suggestions mined from signals
 *         (commitments / memory) the user has not made a goal yet.
 *         Registered as the "Daily goal study" routine (07:00).
 *   SI-3  SkillAuditLoop — the closing half of the skill loop: a
 *         scheduled audit cadence (routine "Skill audit", weekly) that
 *         retires shadow-trial losers ON EVIDENCE: enough trials with a
 *         losing agreement rate, or a shadow window that ran out with
 *         too few trials. Winners still promote via the existing bar.
 *         Every decision is written to an audit history file.
 *   SI-4  QuietMomentSweep — a bounded internalisation pass that runs
 *         once per quiet period: after `idleMs` of inactivity it calls
 *         the host's internalise() for at most `maxPerSweep` items,
 *         then stays quiet until new activity + a new idle window.
 *
 * All loops take an `isPaused` gate (the W14 global pause) and skip
 * silently while paused. Model/research work is injected — tests mock
 * it; no loop here calls a provider directly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyShadowPromotions,
  expireEvolutionCandidates,
  loadRoutingRules,
  retireEvolutionCandidate,
  retireRule,
  ruleStatus,
  saveRoutingRules,
  DEFAULT_SHADOW_BAR,
  type EvolutionCandidate,
  type LearnedRoutingRule,
} from '@mvp/agent-runtime';
import { GoalStore, type Goal } from '@mvp/muse-modules';
import type { ModuleDb } from '@mvp/muse-modules';
import type { RoutineStore } from './bot-routines.js';

// ---------------------------------------------------------------------------
// SI-1 — Daily goal study
// ---------------------------------------------------------------------------

export interface GoalStudyBriefing {
  goalId: string;
  title: string;
  progress: number;
  /** Research note for the goal (injected research fn output). */
  research: string;
  /** True when no progress was recorded within the stall window. */
  stalled: boolean;
  /** Human nudge when stalled; empty otherwise. */
  nudge: string;
}

export interface ImpliedGoalSuggestion {
  id: string;
  title: string;
  /** Signal text that implied the goal. */
  evidence: string;
  status: 'new' | 'accepted' | 'ignored';
  createdAt: number;
  /** Goal created when the suggestion was accepted. */
  goalId?: string;
}

export interface GoalStudyReport {
  at: number;
  briefings: GoalStudyBriefing[];
  newSuggestions: ImpliedGoalSuggestion[];
  skipped?: 'paused';
}

interface GoalStudyFile {
  suggestions: ImpliedGoalSuggestion[];
  lastRunAt?: number;
}

/** File-backed store for goal-study suggestions (dataDir/goal-study.json). */
export class GoalStudyStore {
  private readonly file: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'goal-study.json');
  }
  private readAll(): GoalStudyFile {
    try {
      if (!existsSync(this.file)) return { suggestions: [] };
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GoalStudyFile>;
      return { suggestions: parsed.suggestions ?? [], lastRunAt: parsed.lastRunAt };
    } catch {
      return { suggestions: [] };
    }
  }
  private writeAll(data: GoalStudyFile): void {
    writeFileSync(this.file, JSON.stringify({ ...data, suggestions: data.suggestions.slice(-200) }), 'utf8');
  }
  listSuggestions(status?: ImpliedGoalSuggestion['status']): ImpliedGoalSuggestion[] {
    return this.readAll().suggestions.filter((s) => !status || s.status === status);
  }
  addSuggestions(suggestions: ImpliedGoalSuggestion[]): void {
    const all = this.readAll();
    all.suggestions.push(...suggestions);
    this.writeAll(all);
  }
  markRun(at: number): void {
    const all = this.readAll();
    all.lastRunAt = at;
    this.writeAll(all);
  }
  /** Accept a suggestion: create the goal and link it. User action. */
  acceptSuggestion(id: string, goals: GoalStore): ImpliedGoalSuggestion | undefined {
    const all = this.readAll();
    const suggestion = all.suggestions.find((s) => s.id === id);
    if (!suggestion || suggestion.status !== 'new') return undefined;
    const goal = goals.create({ title: suggestion.title, description: `Suggested from: ${suggestion.evidence}` });
    suggestion.status = 'accepted';
    suggestion.goalId = goal.id;
    this.writeAll(all);
    return suggestion;
  }
  ignoreSuggestion(id: string): ImpliedGoalSuggestion | undefined {
    const all = this.readAll();
    const suggestion = all.suggestions.find((s) => s.id === id);
    if (!suggestion) return undefined;
    suggestion.status = 'ignored';
    this.writeAll(all);
    return suggestion;
  }
}

function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

export interface GoalStudyDeps {
  mdb: ModuleDb;
  store: GoalStudyStore;
  /** Research leg: returns a short briefing note for one goal. Mocked in tests. */
  research: (goal: Goal) => Promise<string>;
  /** Signals that may imply goals: commitment titles, memory snippets… */
  signals: () => string[] | Promise<string[]>;
  /** Optional model leg to phrase an implied goal from a signal. Falls back to the signal itself. */
  phraseGoal?: (signal: string) => Promise<string>;
  stallDays?: number;
  isPaused?: () => boolean;
  now?: () => number;
}

export class DailyGoalStudyLoop {
  static readonly ROUTINE_NAME = 'Daily goal study';
  constructor(private readonly deps: GoalStudyDeps) {}

  async run(): Promise<GoalStudyReport> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.deps.isPaused?.()) return { at: now, briefings: [], newSuggestions: [], skipped: 'paused' };
    const goals = new GoalStore(this.deps.mdb);
    const stallMs = (this.deps.stallDays ?? 7) * 24 * 60 * 60 * 1000;
    const briefings: GoalStudyBriefing[] = [];
    for (const goal of goals.list('active')) {
      let research = '';
      try {
        research = (await this.deps.research(goal)).slice(0, 1000);
      } catch {
        research = '';
      }
      const history = goals.history(goal.id);
      const lastProgressAt = history.length ? history[history.length - 1]!.createdAt : goal.createdAt;
      const stalled = goal.progress < 100 && now - lastProgressAt >= stallMs;
      briefings.push({
        goalId: goal.id,
        title: goal.title,
        progress: goal.progress,
        research,
        stalled,
        nudge: stalled
          ? `"${goal.title}" has had no recorded progress in ${Math.floor((now - lastProgressAt) / 86_400_000)} days (at ${goal.progress}%). One small next step today?`
          : '',
      });
    }
    // Implied goals: signals sharing almost no vocabulary with any
    // existing goal (active or completed) and not already suggested.
    const existingGoalTokens = goals.list().map((g) => tokensOf(`${g.title} ${g.description}`));
    const alreadySuggested = new Set(this.deps.store.listSuggestions().map((s) => s.title.toLowerCase()));
    const newSuggestions: ImpliedGoalSuggestion[] = [];
    for (const signal of (await this.deps.signals()).slice(0, 50)) {
      const text = signal.trim();
      if (text.length < 8) continue;
      const tokens = tokensOf(text);
      const covered = existingGoalTokens.some((gt) => overlap(tokens, gt) >= Math.min(3, tokens.size));
      if (covered) continue;
      const title = this.deps.phraseGoal ? (await this.deps.phraseGoal(text)).slice(0, 200) : text.slice(0, 200);
      if (!title || alreadySuggested.has(title.toLowerCase())) continue;
      alreadySuggested.add(title.toLowerCase());
      newSuggestions.push({
        id: `implied-${now}-${newSuggestions.length}`,
        title,
        evidence: text.slice(0, 300),
        status: 'new',
        createdAt: now,
      });
      if (newSuggestions.length >= 3) break;
    }
    if (newSuggestions.length) this.deps.store.addSuggestions(newSuggestions);
    this.deps.store.markRun(now);
    return { at: now, briefings, newSuggestions };
  }
}

/** Register (idempotently) the daily goal-study routine. */
export function ensureGoalStudyRoutine(routineStore: RoutineStore, botId: string, timezone = 'UTC'): boolean {
  const name = DailyGoalStudyLoop.ROUTINE_NAME;
  if (routineStore.list().some((r) => r.botId === botId && r.name === name)) return false;
  routineStore.create({
    name,
    botId,
    promptTemplate:
      'Daily goal study: for each active goal, prepare a short research briefing, nudge stalled goals, and suggest goals implied by recent commitments and memory.',
    schedule: { kind: 'daily', time: '07:00', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone, enabled: true, overlap: 'skip' },
  });
  return true;
}

// ---------------------------------------------------------------------------
// SI-3 — Skill audit cadence + retire-on-evidence
// ---------------------------------------------------------------------------

export interface SkillAuditPolicy {
  /** Shadow rules at/above this many trials with agreement below the promotion bar retire as losers. */
  minTrialsToJudge?: number;
  /** Agreement rate below this (with enough trials) = evidence of losing. */
  loseRateBelow?: number;
  /** Shadow rules older than this with too few trials retire as stale. */
  staleShadowDays?: number;
}

export const DEFAULT_SKILL_AUDIT_POLICY: Required<SkillAuditPolicy> = {
  minTrialsToJudge: DEFAULT_SHADOW_BAR.minTrials,
  loseRateBelow: DEFAULT_SHADOW_BAR.minAgreementRate,
  staleShadowDays: 14,
};

export interface SkillAuditDecision {
  subject: string;
  action: 'promoted' | 'retired-loser' | 'retired-stale' | 'kept';
  evidence: string;
}

export interface SkillAuditReport {
  at: string;
  decisions: SkillAuditDecision[];
}

/** Pure audit over learned routing rules (the persisted shadow population). */
export function auditRoutingRules(
  rules: LearnedRoutingRule[],
  policy: SkillAuditPolicy = {},
  now: string = new Date().toISOString(),
): { rules: LearnedRoutingRule[]; decisions: SkillAuditDecision[] } {
  const p = { ...DEFAULT_SKILL_AUDIT_POLICY, ...policy };
  const decisions: SkillAuditDecision[] = [];
  const nowMs = Date.parse(now);
  let working = rules.map((rule) => {
    if (ruleStatus(rule) !== 'shadow' || !rule.shadow) return rule;
    const { trials, agreements, since } = rule.shadow;
    const rate = trials > 0 ? agreements / trials : 0;
    if (trials >= p.minTrialsToJudge && rate < p.loseRateBelow) {
      decisions.push({
        subject: rule.id,
        action: 'retired-loser',
        evidence: `shadow trials ${trials}, agreement ${(rate * 100).toFixed(0)}% < ${(p.loseRateBelow * 100).toFixed(0)}% bar`,
      });
      return { ...rule, status: 'retired' as const };
    }
    if (trials < p.minTrialsToJudge && nowMs - Date.parse(since) >= p.staleShadowDays * 86_400_000) {
      decisions.push({
        subject: rule.id,
        action: 'retired-stale',
        evidence: `shadow for ${Math.floor((nowMs - Date.parse(since)) / 86_400_000)} days with only ${trials} trials`,
      });
      return { ...rule, status: 'retired' as const };
    }
    decisions.push({ subject: rule.id, action: 'kept', evidence: `shadow trials ${trials}, agreement ${(rate * 100).toFixed(0)}%` });
    return rule;
  });
  const { rules: promotedRules, promoted } = applyShadowPromotions(working, DEFAULT_SHADOW_BAR, now);
  working = promotedRules;
  for (const id of promoted) {
    const d = decisions.find((x) => x.subject === id);
    if (d) {
      d.action = 'promoted';
      d.evidence += '; cleared the promotion bar';
    } else {
      decisions.push({ subject: id, action: 'promoted', evidence: 'cleared the promotion bar' });
    }
  }
  return { rules: working, decisions };
}

/** Pure audit over generic evolution candidates (same evidence rules). */
export function auditEvolutionCandidates(
  candidates: EvolutionCandidate[],
  policy: SkillAuditPolicy = {},
  now: string = new Date().toISOString(),
): { candidates: EvolutionCandidate[]; decisions: SkillAuditDecision[] } {
  const p = { ...DEFAULT_SKILL_AUDIT_POLICY, ...policy };
  const decisions: SkillAuditDecision[] = [];
  const nowMs = Date.parse(now);
  const expired = expireEvolutionCandidates(candidates, now);
  const out = expired.map((candidate, i) => {
    if (candidates[i]!.status === 'shadow' && candidate.status === 'expired') {
      decisions.push({ subject: candidate.id, action: 'retired-stale', evidence: 'shadow trial window elapsed before promotion' });
      return candidate;
    }
    if (candidate.status !== 'shadow') return candidate;
    const rate = candidate.trials > 0 ? candidate.agreements / candidate.trials : 0;
    if (candidate.trials >= p.minTrialsToJudge && rate < p.loseRateBelow) {
      decisions.push({
        subject: candidate.id,
        action: 'retired-loser',
        evidence: `shadow trials ${candidate.trials}, agreement ${(rate * 100).toFixed(0)}% < ${(p.loseRateBelow * 100).toFixed(0)}% bar`,
      });
      return retireEvolutionCandidate(candidate);
    }
    const sinceMs = candidate.shadowSince ? Date.parse(candidate.shadowSince) : nowMs;
    if (candidate.trials < p.minTrialsToJudge && nowMs - sinceMs >= p.staleShadowDays * 86_400_000) {
      decisions.push({ subject: candidate.id, action: 'retired-stale', evidence: `shadow for ${Math.floor((nowMs - sinceMs) / 86_400_000)} days with only ${candidate.trials} trials` });
      return retireEvolutionCandidate(candidate);
    }
    decisions.push({ subject: candidate.id, action: 'kept', evidence: `shadow trials ${candidate.trials}, agreement ${(rate * 100).toFixed(0)}%` });
    return candidate;
  });
  return { candidates: out, decisions };
}

interface SkillAuditFile {
  runs: SkillAuditReport[];
}

/** Append one audit report to dataDir/skill-audit.json (bounded history). */
export function recordSkillAudit(dataDir: string, report: SkillAuditReport): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'skill-audit.json');
  let runs: SkillAuditReport[] = [];
  try {
    if (existsSync(file)) runs = (JSON.parse(readFileSync(file, 'utf8')) as SkillAuditFile).runs ?? [];
  } catch {
    runs = [];
  }
  runs.push(report);
  writeFileSync(file, JSON.stringify({ runs: runs.slice(-100) } satisfies SkillAuditFile), 'utf8');
}

export function readSkillAuditHistory(dataDir: string): SkillAuditReport[] {
  try {
    const file = join(dataDir, 'skill-audit.json');
    if (!existsSync(file)) return [];
    return (JSON.parse(readFileSync(file, 'utf8')) as SkillAuditFile).runs ?? [];
  } catch {
    return [];
  }
}

export interface SkillAuditLoopDeps {
  dataDir: string;
  policy?: SkillAuditPolicy;
  isPaused?: () => boolean;
  now?: () => string;
}

/** The scheduled audit: load rules → audit → persist rules + report. */
export class SkillAuditLoop {
  static readonly ROUTINE_NAME = 'Skill audit';
  constructor(private readonly deps: SkillAuditLoopDeps) {}

  run(): SkillAuditReport & { skipped?: 'paused' } {
    const at = this.deps.now?.() ?? new Date().toISOString();
    if (this.deps.isPaused?.()) return { at, decisions: [], skipped: 'paused' };
    const rules = loadRoutingRules(this.deps.dataDir);
    const { rules: audited, decisions } = auditRoutingRules(rules, this.deps.policy, at);
    saveRoutingRules(this.deps.dataDir, audited);
    const report: SkillAuditReport = { at, decisions };
    recordSkillAudit(this.deps.dataDir, report);
    return report;
  }
}

/** Register (idempotently) the weekly skill-audit routine. */
export function ensureSkillAuditRoutine(routineStore: RoutineStore, botId: string, timezone = 'UTC'): boolean {
  const name = SkillAuditLoop.ROUTINE_NAME;
  if (routineStore.list().some((r) => r.botId === botId && r.name === name)) return false;
  routineStore.create({
    name,
    botId,
    promptTemplate:
      'Skill audit: review shadow-trial skills and routing rules; promote clear winners, retire losers on trial evidence, and record the audit.',
    schedule: { kind: 'daily', time: '04:00', weekdays: [1], timezone, enabled: true, overlap: 'skip' },
  });
  return true;
}

// ---------------------------------------------------------------------------
// SI-4 — Quiet-moment internalisation sweep
// ---------------------------------------------------------------------------

export interface QuietSweepDeps {
  /** Run the internalisation for at most `limit` items; returns how many were processed. */
  internalise: (limit: number) => Promise<number>;
  /** Milliseconds of inactivity before a sweep may run. Default 20 min. */
  idleMs?: number;
  /** Hard bound on items per sweep. Default 25. */
  maxPerSweep?: number;
  isPaused?: () => boolean;
}

export interface QuietSweepRecord {
  at: number;
  processed: number;
}

/**
 * Bounded quiet-moment sweep. The host calls noteActivity() on every
 * turn/message and tick() on a timer. A sweep fires at most once per
 * quiet period: after idleMs with no activity, and not again until new
 * activity starts a fresh quiet period.
 */
export class QuietMomentSweep {
  private lastActivityAt = 0;
  private sweptForActivityAt = -1;
  readonly history: QuietSweepRecord[] = [];

  constructor(private readonly deps: QuietSweepDeps) {}

  noteActivity(at: number = Date.now()): void {
    this.lastActivityAt = at;
  }

  /** Would a sweep fire at `now`? (No side effects.) */
  due(now: number = Date.now()): boolean {
    if (this.lastActivityAt === 0) return false;
    if (this.sweptForActivityAt === this.lastActivityAt) return false;
    return now - this.lastActivityAt >= (this.deps.idleMs ?? 20 * 60 * 1000);
  }

  async tick(now: number = Date.now()): Promise<QuietSweepRecord | null> {
    if (this.deps.isPaused?.()) return null;
    if (!this.due(now)) return null;
    this.sweptForActivityAt = this.lastActivityAt;
    const processed = await this.deps.internalise(this.deps.maxPerSweep ?? 25);
    const record: QuietSweepRecord = { at: now, processed: Math.max(0, Math.min(processed, this.deps.maxPerSweep ?? 25)) };
    this.history.push(record);
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
    return record;
  }
}
