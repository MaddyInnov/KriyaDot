// SPDX-License-Identifier: Apache-2.0
/**
 * Classification learning from corrections (Laya-inspired, adapted — not
 * copied: Laya's adaptive-classification idea reimplemented from scratch).
 *
 * When the user corrects a routing decision ("no — route code questions to
 * X"), this module extracts a *generalizable rule* from the correction and
 * stores it so the correction sticks. The learning mechanism is fully local
 * and needs no LLM: pattern → rule template.
 *
 * Pipeline:
 * 1. `recordRoutingCorrection(dataDir, correction)` — the host calls this
 *    when the user corrects a routing/priority/persona decision.
 * 2. `learnFromCorrection(correction, existing)` (pure) — derives rules:
 *      a. a task-type rule:  `taskType = "code" → route to X`
 *      b. a keyword rule:     `taskType = "code" AND message matches
 *         \b(deploy|docker|k8s)\b → route to X` — the distinctive words are
 *         extracted locally from the corrected message.
 *    Repeated identical corrections bump the rule's `count` instead of
 *    duplicating it; a correction that contradicts an earlier rule for the
 *    same scope replaces it (latest correction wins).
 * 3. Rules persist as JSON in the bot/data dir (`routing-rules.json`) via
 *    `loadRoutingRules` / `saveRoutingRules`.
 * 4. Injection: `routeModel()` (routing.ts) accepts `learnedRules` and
 *    `message`; the most specific matching rule (keyword rule before
 *    general task-type rule) wins over the built-in heuristics — but never
 *    over an explicit user override, and never against the free-only guard.
 *    `formatRoutingRulesPrompt()` renders the rules as a markdown section
 *    for injection into any LLM-based router prompt.
 *
 * Nothing here performs network I/O or touches credentials.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskType } from './routing.js';

/** File name (inside the bot/data dir) holding the learned rules. */
export const ROUTING_RULES_FILENAME = 'routing-rules.json';
const RULES_FORMAT_VERSION = 1;

export interface RoutingCorrection {
  /** Task type the router was deciding for. */
  taskType: TaskType;
  /** What the router picked (the decision the user corrected). */
  routedProviderId: string;
  routedModelId: string;
  /** What the user corrected it to. */
  correctedProviderId: string;
  correctedModelId: string;
  /**
   * The user message that triggered the decision, if available. Used ONLY
   * for local keyword extraction — it is never sent anywhere.
   */
  message?: string;
  /** ISO timestamp; defaults to now. */
  at?: string;
}

export interface LearnedRoutingRuleWhen {
  /** Task type this rule applies to (absent = any). */
  taskType?: TaskType;
  /**
   * Safe regex source (case-insensitive) matched against the user message.
   * Built only from escaped literal words extracted from corrected
   * messages — never from raw user input.
   */
  messagePattern?: string;
}

export type RoutingRuleStatus = 'shadow' | 'active' | 'retired';

/** Shadow-trial evidence for a candidate rule (Octomind parity, Tier 3). */
export interface ShadowTrialStats {
  /** Corrections the rule matched while in shadow. */
  trials: number;
  /** Trials where the rule's pick equalled the user's corrected pick. */
  agreements: number;
  /** Trials where the rule matched but picked something else. */
  disagreements: number;
  /** ISO timestamp the shadow trial started. */
  since: string;
}

export interface LearnedRoutingRule {
  /** Stable id, e.g. "rr-20261009-0001". */
  id: string;
  /** Human-readable, e.g. 'route "code" tasks to groq/gpt-oss-20b'. */
  description: string;
  when: LearnedRoutingRuleWhen;
  then: { providerId: string; modelId: string };
  /** How many user corrections support this rule. */
  count: number;
  updatedAt: string;
  /**
   * Evolution lifecycle (shadow-trial pipeline): absent = 'active'
   * (rules learned before the pipeline existed stay live). Candidate
   * rules start 'shadow' — scored against incoming corrections but
   * never routed — and are promoted to 'active' only when their
   * trial record beats the bar (or a human promotes them). 'retired'
   * is the rollback state: kept for audit, never matched.
   */
  status?: RoutingRuleStatus;
  shadow?: ShadowTrialStats;
  promotedAt?: string;
}

/** A rule's effective lifecycle status (legacy rules are active). */
export function ruleStatus(rule: LearnedRoutingRule): RoutingRuleStatus {
  return rule.status ?? 'active';
}

export interface MatchInput {
  taskType: TaskType;
  message?: string;
}

// ---------------------------------------------------------------------------
// Local keyword extraction (no LLM).
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'a,an,the,and,or,but,if,then,else,for,with,from,that,this,these,those,are,was,were,been,has,have,had,will,would,can,could,should,not,no,yes,you,your,they,them,their,what,when,where,which,who,whom,how,why,please,just,like,into,over,under,about,also,than,too,very,into,onto,does,did,doing,done,make,made,using,use,used,get,got,let'.split(
    ',',
  ),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract up to `maxWords` distinctive lowercase words (≥4 chars, no
 * stopwords, in order of first appearance) from a message. These become the
 * alternation of the keyword rule's message pattern.
 */
export function extractKeywords(message: string, maxWords = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of message.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= maxWords) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule learning (pure).
// ---------------------------------------------------------------------------

let ruleCounter = 0;

function newRuleId(): string {
  ruleCounter += 1;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `rr-${day}-${String(ruleCounter).padStart(4, '0')}`;
}

function sameTarget(a: { providerId: string; modelId: string }, b: { providerId: string; modelId: string }): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

function sameScope(a: LearnedRoutingRuleWhen, b: LearnedRoutingRuleWhen): boolean {
  return a.taskType === b.taskType && (a.messagePattern ?? '') === (b.messagePattern ?? '');
}

/**
 * Recover the trigger words from a pattern built as `\b(a|b|c)\b`.
 * Extraction only ever emits `[a-z0-9_]+` words (escaping is a no-op on
 * them), so splitting the alternation is lossless here.
 */
function parseAlternation(pattern: string): string[] {
  const m = /^\\b\((.*)\)\\b$/.exec(pattern);
  if (!m) return [];
  return m[1]!.split('|').filter((w) => w.length > 0);
}

function cloneRules(rules: LearnedRoutingRule[]): LearnedRoutingRule[] {
  return rules.map((r) => ({ ...r, when: { ...r.when }, then: { ...r.then } }));
}

/**
 * Derive generalizable rules from one user correction and merge them into
 * the existing rule list (newest first). Pure — no I/O.
 *
 * Emits at most two rules: a keyword rule (when the message yields ≥2
 * distinctive words) and a task-type rule. Identical re-corrections bump
 * `count`; a contradictory correction for the same scope replaces the old
 * rule (latest correction wins). A correction that changes nothing is a
 * no-op.
 */
export function learnFromCorrection(
  correction: RoutingCorrection,
  existing: LearnedRoutingRule[] = [],
): LearnedRoutingRule[] {
  const routed = { providerId: correction.routedProviderId, modelId: correction.routedModelId };
  const corrected = { providerId: correction.correctedProviderId, modelId: correction.correctedModelId };
  if (sameTarget(routed, corrected)) return cloneRules(existing); // no-op correction

  const at = correction.at ?? new Date().toISOString();
  const rules = cloneRules(existing);
  const targetDesc = `${corrected.providerId}/${corrected.modelId}`;

  const upsert = (when: LearnedRoutingRuleWhen, description: string): void => {
    const idx = rules.findIndex((r) => sameScope(r.when, when));
    if (idx >= 0) {
      const prev = rules[idx]!;
      if (sameTarget(prev.then, corrected)) {
        // Same correction again: strengthen, move to front (newest wins on match).
        rules.splice(idx, 1);
        rules.unshift({ ...prev, count: prev.count + 1, updatedAt: at });
      } else {
        // Contradiction for the same scope: latest correction wins.
        rules.splice(idx, 1);
        rules.unshift({
          id: newRuleId(),
          description,
          when,
          then: corrected,
          count: 1,
          updatedAt: at,
        });
      }
      return;
    }
    rules.unshift({ id: newRuleId(), description, when, then: corrected, count: 1, updatedAt: at });
  };

  const keywordDescription = (taskType: TaskType, keywords: string[], target: string): string =>
    `route "${taskType}" tasks mentioning ${keywords.map((k) => `"${k}"`).join(', ')} to ${target}`;

  // General task-type rule first, then the more specific keyword rule, so
  // the final list reads newest/most-specific first.
  upsert(
    { taskType: correction.taskType },
    `route "${correction.taskType}" tasks to ${targetDesc}`,
  );

  if (correction.message) {
    const keywords = extractKeywords(correction.message);
    if (keywords.length >= 2) {
      // Generalize: fold new keywords into an existing keyword rule for the
      // same task type + target (union of trigger words) instead of
      // accumulating near-duplicate rules.
      const mergeIdx = rules.findIndex(
        (r) =>
          r.when.taskType === correction.taskType &&
          r.when.messagePattern !== undefined &&
          sameTarget(r.then, corrected),
      );
      if (mergeIdx >= 0) {
        const prev = rules[mergeIdx]!;
        const merged = [...parseAlternation(prev.when.messagePattern!)];
        for (const k of keywords) {
          if (!merged.includes(k)) merged.push(k);
        }
        const pattern = `\\b(${merged.map(escapeRegExp).join('|')})\\b`;
        rules.splice(mergeIdx, 1);
        rules.unshift({
          ...prev,
          when: { taskType: correction.taskType, messagePattern: pattern },
          description: keywordDescription(correction.taskType, merged, targetDesc),
          count: prev.count + 1,
          updatedAt: at,
        });
      } else {
        const pattern = `\\b(${keywords.map(escapeRegExp).join('|')})\\b`;
        upsert(
          { taskType: correction.taskType, messagePattern: pattern },
          keywordDescription(correction.taskType, keywords, targetDesc),
        );
      }
    }
  }
  return rules;
}

/**
 * Find the best matching rule. Specificity outranks recency: rules carrying
 * a message pattern are tried before general task-type rules (so a keyword
 * rule can never be shadowed by a general rule learned later); newest wins
 * within a tier. A rule with a messagePattern requires a message and a
 * case-insensitive regex hit; malformed patterns fail closed (rule skipped).
 */
export function matchLearnedRule(
  rules: LearnedRoutingRule[],
  input: MatchInput,
): LearnedRoutingRule | undefined {
  for (const wantPattern of [true, false]) {
    for (const rule of rules) {
      // Shadow candidates are scored, never routed; retired rules are dead.
      if (ruleStatus(rule) !== 'active') continue;
      if ((rule.when.messagePattern !== undefined) !== wantPattern) continue;
      if (rule.when.taskType !== undefined && rule.when.taskType !== input.taskType) continue;
      if (rule.when.messagePattern !== undefined) {
        if (!input.message) continue;
        let re: RegExp;
        try {
          re = new RegExp(rule.when.messagePattern, 'i');
        } catch {
          continue; // fail closed on a bad pattern
        }
        if (!re.test(input.message)) continue;
      }
      return rule;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Persistence (JSON in the bot/data dir).
// ---------------------------------------------------------------------------

interface RulesEnvelope {
  version: number;
  rules: LearnedRoutingRule[];
}

function isPlausibleRule(r: unknown): r is LearnedRoutingRule {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  const then = o.then as Record<string, unknown> | undefined;
  return (
    typeof o.id === 'string' &&
    typeof o.description === 'string' &&
    typeof o.when === 'object' &&
    o.when !== null &&
    typeof then?.providerId === 'string' &&
    typeof then?.modelId === 'string' &&
    typeof o.count === 'number'
  );
}

/** Load learned rules; returns [] when the file is absent or corrupt. */
export function loadRoutingRules(dataDir: string): LearnedRoutingRule[] {
  const path = join(dataDir, ROUTING_RULES_FILENAME);
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const env = parsed as Partial<RulesEnvelope>;
    if (!Array.isArray(env.rules)) return [];
    return env.rules.filter(isPlausibleRule);
  } catch {
    return [];
  }
}

/** Persist learned rules (mkdir -p the data dir; pretty-printed JSON). */
export function saveRoutingRules(dataDir: string, rules: LearnedRoutingRule[]): void {
  mkdirSync(dataDir, { recursive: true });
  const env: RulesEnvelope = { version: RULES_FORMAT_VERSION, rules };
  writeFileSync(join(dataDir, ROUTING_RULES_FILENAME), JSON.stringify(env, null, 2) + '\n', 'utf8');
}

/**
 * Record one user correction: learn from it and persist the updated rules.
 * Returns the updated rule list (newest first). This is the entry point
 * hosts call from a "correction" UI action.
 */
export function recordRoutingCorrection(dataDir: string, correction: RoutingCorrection): LearnedRoutingRule[] {
  const rules = learnFromCorrection(correction, loadRoutingRules(dataDir));
  saveRoutingRules(dataDir, rules);
  return rules;
}

// ---------------------------------------------------------------------------
// Shadow-trial evolution pipeline (Octomind parity, Tier 3).
//
// New candidate rules do NOT go live on the strength of one correction.
// They enter 'shadow': every subsequent correction is a trial — if the
// shadow rule matches the correction's input, its pick is compared
// against the user's corrected pick (the control outcome: the routed
// pick was wrong by definition). A rule is promoted to 'active' only
// when it has enough trials and its agreement rate clears the bar —
// it must demonstrably beat the control. Humans can also promote or
// roll back (retire) any rule through the API surface.
// ---------------------------------------------------------------------------

export interface ShadowPromotionBar {
  /** Minimum matched corrections before promotion is considered. */
  minTrials: number;
  /** agreements / trials must reach this rate (0..1). */
  minAgreementRate: number;
}

export const DEFAULT_SHADOW_BAR: ShadowPromotionBar = { minTrials: 3, minAgreementRate: 0.8 };

/** Does this rule's scope match a correction's input (ignoring status)? */
function ruleMatchesInput(rule: LearnedRoutingRule, input: MatchInput): boolean {
  if (rule.when.taskType !== undefined && rule.when.taskType !== input.taskType) return false;
  if (rule.when.messagePattern !== undefined) {
    if (!input.message) return false;
    try {
      return new RegExp(rule.when.messagePattern, 'i').test(input.message);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Learn from a correction as CANDIDATE rules: anything newly created
 * or whose target changed enters shadow with fresh trial stats;
 * rules merely strengthened by the correction keep their status.
 */
export function proposeFromCorrection(
  correction: RoutingCorrection,
  existing: LearnedRoutingRule[] = [],
): LearnedRoutingRule[] {
  const learned = learnFromCorrection(correction, existing);
  const before = new Map(existing.map((r) => [r.id, r]));
  const at = correction.at ?? new Date().toISOString();
  return learned.map((rule) => {
    const prev = before.get(rule.id);
    if (prev && sameTarget(prev.then, rule.then) && ruleStatus(prev) !== 'retired') {
      return rule; // strengthened or untouched — status unchanged
    }
    return {
      ...rule,
      status: 'shadow' as const,
      shadow: { trials: 0, agreements: 0, disagreements: 0, since: at },
      promotedAt: undefined,
    };
  });
}

/**
 * Score every shadow rule against one correction (mutates a clone).
 * The creating correction counts as the rule's first trial — it
 * trivially agrees with it, which is honest: one data point, and the
 * bar demands more.
 */
export function scoreShadowRules(
  rules: LearnedRoutingRule[],
  correction: RoutingCorrection,
): LearnedRoutingRule[] {
  const corrected = { providerId: correction.correctedProviderId, modelId: correction.correctedModelId };
  const input: MatchInput = { taskType: correction.taskType, message: correction.message };
  return rules.map((rule) => {
    if (ruleStatus(rule) !== 'shadow') return rule;
    if (!ruleMatchesInput(rule, input)) return rule;
    const stats = rule.shadow ?? { trials: 0, agreements: 0, disagreements: 0, since: correction.at ?? new Date().toISOString() };
    const agree = sameTarget(rule.then, corrected);
    return {
      ...rule,
      shadow: {
        ...stats,
        trials: stats.trials + 1,
        agreements: stats.agreements + (agree ? 1 : 0),
        disagreements: stats.disagreements + (agree ? 0 : 1),
      },
    };
  });
}

/** Promotion eligibility under a bar (default DEFAULT_SHADOW_BAR). */
export function eligibleForPromotion(
  rule: LearnedRoutingRule,
  bar: ShadowPromotionBar = DEFAULT_SHADOW_BAR,
): boolean {
  if (ruleStatus(rule) !== 'shadow' || !rule.shadow) return false;
  if (rule.shadow.trials < bar.minTrials) return false;
  return rule.shadow.agreements / rule.shadow.trials >= bar.minAgreementRate;
}

/** Promote every shadow rule that clears the bar. Returns promoted ids. */
export function applyShadowPromotions(
  rules: LearnedRoutingRule[],
  bar: ShadowPromotionBar = DEFAULT_SHADOW_BAR,
  at: string = new Date().toISOString(),
): { rules: LearnedRoutingRule[]; promoted: string[] } {
  const promoted: string[] = [];
  const out = rules.map((rule) => {
    if (!eligibleForPromotion(rule, bar)) return rule;
    promoted.push(rule.id);
    return { ...rule, status: 'active' as const, promotedAt: at };
  });
  return { rules: out, promoted };
}

/** Human promote (bypasses the bar). Unknown id → rules unchanged. */
export function promoteRule(rules: LearnedRoutingRule[], id: string, at: string = new Date().toISOString()): LearnedRoutingRule[] {
  return rules.map((rule) =>
    rule.id === id && ruleStatus(rule) !== 'retired'
      ? { ...rule, status: 'active' as const, promotedAt: at }
      : rule,
  );
}

/** Rollback: retire a rule (kept for audit; never matched again). */
export function retireRule(rules: LearnedRoutingRule[], id: string): LearnedRoutingRule[] {
  return rules.map((rule) => (rule.id === id ? { ...rule, status: 'retired' as const } : rule));
}

/**
 * The shadow-pipeline correction entry point: propose candidates,
 * score all shadow rules against the correction, auto-promote those
 * clearing the bar, persist. Returns the rules + promoted rule ids.
 */
export function recordShadowCorrection(
  dataDir: string,
  correction: RoutingCorrection,
  bar: ShadowPromotionBar = DEFAULT_SHADOW_BAR,
): { rules: LearnedRoutingRule[]; promoted: string[] } {
  const proposed = proposeFromCorrection(correction, loadRoutingRules(dataDir));
  const scored = scoreShadowRules(proposed, correction);
  const { rules, promoted } = applyShadowPromotions(scored, bar, correction.at ?? new Date().toISOString());
  saveRoutingRules(dataDir, rules);
  return { rules, promoted };
}

// ---------------------------------------------------------------------------
// Prompt/context injection for LLM-based routers.
// ---------------------------------------------------------------------------

/**
 * Render learned rules as a markdown section to inject into a router
 * prompt (LLM-based routers) or a routing-debug context. Empty string when
 * there are no rules. Rules are listed newest-first; the router should apply
 * the first matching rule.
 */
export function formatRoutingRulesPrompt(rules: LearnedRoutingRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r) => {
    const conds: string[] = [];
    if (r.when.taskType) conds.push(`task type is "${r.when.taskType}"`);
    if (r.when.messagePattern) conds.push(`the user message matches \`${r.when.messagePattern}\``);
    const when = conds.length > 0 ? conds.join(' and ') : 'always';
    const n = r.count === 1 ? '1 user correction' : `${r.count} user corrections`;
    return `- When ${when}, route to \`${r.then.providerId}/${r.then.modelId}\` (learned from ${n}).`;
  });
  return (
    '## Learned routing rules (user corrections)\n' +
    'These rules override the default routing heuristics. Apply the first matching rule.\n' +
    lines.join('\n')
  );
}

