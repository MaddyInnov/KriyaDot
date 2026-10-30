// SPDX-License-Identifier: Apache-2.0
/**
 * Fast message router ("Jev" equivalent): pure, deterministic, zero-LLM.
 *
 * routeMessage(text, bots) → { botId, confidence, reason } picks the
 * best-fit bot for an inbound message using keyword/topic heuristics plus
 * per-bot persona keywords. No model call, no network, no randomness — the
 * same (text, bots) input always yields the same route, which makes it safe
 * to use on hot paths (e.g. inbound messaging mentions) and trivial to test.
 *
 * Scoring:
 *  - Each bot contributes a keyword set: tokens from its name +
 *    description + explicit `keywords` (per-bot persona keywords).
 *  - Built-in topic maps (code, writing, finance, ...) let a bot "cover" a
 *    topic when its keywords intersect the topic's vocabulary; message
 *    tokens hitting a covered topic add to the bot's score.
 *  - Exact multi-word keyword phrases in the message score a bonus.
 *  - Winner = highest score; ties resolve to the earliest bot (stable).
 *  - confidence = winnerScore / totalScore (0 when nothing matched).
 *
 * This is message→bot routing. It is deliberately separate from
 * routing.ts, which is model routing (task→model/provider).
 */

export interface RoutableBot {
  id: string;
  name: string;
  description?: string;
  /**
   * Per-bot persona/topic keywords that bias routing toward this bot.
   * May be single words or multi-word phrases ("pull request").
   */
  keywords?: string[];
}

export interface MessageRoute {
  botId: string;
  /** 0..1 — the winner's share of total keyword score. 0 = no match (fallback). */
  confidence: number;
  reason: string;
}

/**
 * Built-in topic → vocabulary. A bot "covers" a topic when any of its
 * keywords (name/description/keywords tokens) appears in the topic's list,
 * or when its name/description mentions the topic word itself.
 */
export const TOPIC_KEYWORDS: Record<string, string[]> = {
  code: [
    'code', 'coding', 'bug', 'debug', 'error', 'exception', 'stacktrace',
    'function', 'refactor', 'compile', 'build', 'deploy', 'test', 'tests',
    'git', 'commit', 'pull', 'merge', 'typescript', 'javascript', 'python',
    'rust', 'golang', 'api', 'sdk', 'cli', 'script', 'terminal', 'shell',
    'regex', 'json', 'yaml', 'docker', 'kubernetes', 'sql', 'database',
    'migration', 'package', 'npm', 'crash', 'segfault',
  ],
  writing: [
    'write', 'writing', 'essay', 'blog', 'article', 'story', 'novel',
    'poem', 'poetry', 'draft', 'edit', 'proofread', 'grammar', 'headline',
    'copy', 'copywriting', 'newsletter', 'caption', 'rewrite',
  ],
  finance: [
    'money', 'finance', 'financial', 'invest', 'investment', 'stock',
    'stocks', 'market', 'trading', 'portfolio', 'budget', 'tax', 'taxes',
    'invoice', 'revenue', 'profit', 'crypto', 'bitcoin', 'bank', 'loan',
    'debt', 'savings', 'expense', 'expenses', 'salary', 'dividend',
  ],
  research: [
    'research', 'paper', 'study', 'survey', 'analysis', 'analyze', 'data',
    'dataset', 'statistics', 'experiment', 'hypothesis', 'thesis',
    'literature', 'citation', 'benchmark', 'ablation',
  ],
  health: [
    'health', 'fitness', 'workout', 'diet', 'sleep', 'doctor', 'medical',
    'symptom', 'nutrition', 'exercise', 'yoga', 'meditation', 'mental',
    'calories', 'cardio',
  ],
  travel: [
    'travel', 'trip', 'flight', 'flights', 'hotel', 'visa', 'itinerary',
    'vacation', 'holiday', 'booking', 'airport', 'destination', 'luggage',
  ],
  music: [
    'music', 'song', 'songs', 'lyrics', 'melody', 'chord', 'guitar',
    'piano', 'sing', 'singing', 'album', 'band', 'concert', 'playlist',
  ],
  productivity: [
    'todo', 'task', 'tasks', 'remind', 'reminder', 'calendar', 'schedule',
    'meeting', 'notes', 'plan', 'planning', 'organize', 'deadline',
    'habit', 'checklist',
  ],
  shopping: [
    'buy', 'price', 'deal', 'deals', 'discount', 'order', 'product',
    'shopping', 'cart', 'coupon', 'refund', 'shipping',
  ],
};

const DIRECT_HIT_SCORE = 2;
const TOPIC_HIT_SCORE = 1;
const PHRASE_BONUS = 4;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

/** All matchable tokens for a bot: name + description + keyword tokens. */
function botKeywordSet(bot: RoutableBot): Set<string> {
  const set = new Set<string>();
  for (const t of tokenize(`${bot.name} ${bot.description ?? ''}`)) set.add(t);
  for (const kw of bot.keywords ?? []) {
    const k = kw.toLowerCase().trim();
    if (!k) continue;
    for (const t of tokenize(k)) set.add(t);
  }
  return set;
}

/** Multi-word keyword phrases for phrase-bonus matching. */
function botPhrases(bot: RoutableBot): string[] {
  const out: string[] = [];
  for (const kw of bot.keywords ?? []) {
    const k = kw.toLowerCase().trim();
    if (k.includes(' ') && k.length >= 4) out.push(k);
  }
  return out;
}

/** Topics this bot covers, given its keyword set and identity text. */
function coveredTopics(bot: RoutableBot, keywordSet: Set<string>): Set<string> {
  const identity = `${bot.name} ${bot.description ?? ''}`.toLowerCase();
  const covered = new Set<string>();
  for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
    if (identity.includes(topic)) {
      covered.add(topic);
      continue;
    }
    for (const w of words) {
      if (keywordSet.has(w)) {
        covered.add(topic);
        break;
      }
    }
  }
  return covered;
}

/**
 * Tunable scoring weights for the message router. This is NOT a learned
 * model — these are hand-set heuristic weights the user can tune
 * (GET/PUT /api/routing/weights). The router stays fully deterministic.
 */
export interface RouterWeights {
  directHit: number;
  topicHit: number;
  phraseBonus: number;
  /** Bumped whenever the weights change; recorded in the decision log. */
  version: number;
}

export const DEFAULT_ROUTER_WEIGHTS: RouterWeights = {
  directHit: DIRECT_HIT_SCORE,
  topicHit: TOPIC_HIT_SCORE,
  phraseBonus: PHRASE_BONUS,
  version: 1,
};

export interface ScoredBot {
  botId: string;
  botName: string;
  score: number;
  hits: string[];
}

/**
 * Score every bot for a message (the feature/score half of routing).
 * Pure and deterministic.
 */
export function scoreBotsForRouting(
  text: string,
  bots: RoutableBot[],
  weights: RouterWeights = DEFAULT_ROUTER_WEIGHTS,
): ScoredBot[] {
  const lowered = text.toLowerCase();
  const tokens = tokenize(text);
  return bots.map((bot) => {
    const kw = botKeywordSet(bot);
    const topics = coveredTopics(bot, kw);
    let score = 0;
    const hits: string[] = [];
    for (const phrase of botPhrases(bot)) {
      if (lowered.includes(phrase)) {
        score += weights.phraseBonus;
        hits.push(`"${phrase}"`);
      }
    }
    for (const token of tokens) {
      if (kw.has(token)) {
        score += weights.directHit;
        hits.push(token);
        continue;
      }
      for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
        if (words.includes(token) && topics.has(topic)) {
          score += weights.topicHit;
          hits.push(`${token}~${topic}`);
          break;
        }
      }
    }
    return { botId: bot.id, botName: bot.name, score, hits };
  });
}

/**
 * Route a message to the best-fit bot with explicit weights. Pure and
 * deterministic: no I/O, no LLM, no randomness.
 */
export function routeMessageWithWeights(
  text: string,
  bots: RoutableBot[],
  weights: RouterWeights = DEFAULT_ROUTER_WEIGHTS,
): MessageRoute {
  if (bots.length === 0) {
    return { botId: '', confidence: 0, reason: 'no bots available' };
  }
  const scored = scoreBotsForRouting(text, bots, weights);
  const botById = new Map(bots.map((b) => [b.id, b]));

  let winner = scored[0]!;
  for (const s of scored) {
    if (s.score > winner.score) winner = s; // strict > keeps the earliest bot on ties
  }
  const total = scored.reduce((acc, s) => acc + s.score, 0);

  if (winner.score === 0) {
    return {
      botId: bots[0]!.id,
      confidence: 0,
      reason: 'no keyword or topic match — fell back to the first bot',
    };
  }
  const confidence = Math.round((winner.score / total) * 100) / 100;
  const uniqueHits = [...new Set(winner.hits)].slice(0, 6).join(', ');
  const winnerBot = botById.get(winner.botId);
  return {
    botId: winner.botId,
    confidence,
    reason: `matched ${uniqueHits} for bot "${winnerBot?.name ?? winner.botId}"`,
  };
}

/**
 * Route a message to the best-fit bot. Pure and deterministic: no I/O,
 * no LLM, no randomness.
 */
export function routeMessage(text: string, bots: RoutableBot[]): MessageRoute {
  return routeMessageWithWeights(text, bots, DEFAULT_ROUTER_WEIGHTS);
}

// ---------------------------------------------------------------------------
// Model-assisted routing (closure #141/#28): the 'routing' purpose
// profile finally has a consumer. Deterministic routing stays the
// default and the fallback; only AMBIGUOUS deterministic decisions
// (confidence below threshold) ask the evaluate seam, and the model's
// choice is accepted only at/above the probability threshold —
// otherwise the router abstains back to the deterministic result.
// ---------------------------------------------------------------------------

import type { LLMProvider } from './types.js';
import { evaluateQuestion } from './evaluate.js';
import type { ModelProfiles, PurposeModelProfile } from './model-profiles.js';

export interface ModelAssistedRoute extends MessageRoute {
  /** 'deterministic' | 'evaluate' (model seam decided) | 'abstained' (model unsure → deterministic kept) */
  via: 'deterministic' | 'evaluate' | 'abstained';
}

export async function routeMessageWithModel(
  text: string,
  bots: RoutableBot[],
  provider: LLMProvider,
  opts: {
    profiles?: ModelProfiles;
    profile?: PurposeModelProfile;
    weights?: RouterWeights;
    /** Deterministic confidence below which the model seam is consulted. Default 0.6. */
    ambiguityThreshold?: number;
    /** Evaluate probability at/above which the model choice wins. Default 0.6. */
    acceptThreshold?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ModelAssistedRoute> {
  const det = routeMessageWithWeights(text, bots, opts.weights ?? DEFAULT_ROUTER_WEIGHTS);
  if (bots.length === 0) return { ...det, via: 'deterministic' };
  if (det.confidence >= (opts.ambiguityThreshold ?? 0.6)) return { ...det, via: 'deterministic' };
  // Ambiguous: ask the evaluate seam, resolved via the ROUTING purpose
  // profile (#141). Candidate set = the deterministic top scorers.
  const scored = scoreBotsForRouting(text, bots, opts.weights ?? DEFAULT_ROUTER_WEIGHTS)
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  const candidates = scored.length >= 2 ? scored.map((b) => b.botId) : bots.slice(0, 4).map((b) => b.id);
  if (candidates.length < 2) return { ...det, via: 'deterministic' };
  const nameOf = (id: string): string => bots.find((b) => b.id === id)?.name ?? id;
  const ans = await evaluateQuestion(
    provider,
    {
      kind: 'choice',
      question:
        `Which bot should handle this message? Message: ${text.slice(0, 500)}\n` +
        candidates.map((id) => `- ${id}: ${bots.find((b) => b.id === id)?.description ?? nameOf(id)}`).join('\n'),
      choices: candidates,
    },
    { profiles: opts.profiles, profile: opts.profile, signal: opts.signal, purpose: 'routing' },
  ).catch(() => null);
  if (!ans || typeof ans.value !== 'string') return { ...det, via: 'abstained' };
  if (ans.probability < (opts.acceptThreshold ?? 0.6)) {
    return { ...det, via: 'abstained' };
  }
  return {
    botId: ans.value,
    confidence: ans.probability,
    reason: `routing model chose "${nameOf(ans.value)}" (p=${ans.probability.toFixed(2)}): ${ans.reason ?? 'ambiguous deterministic route'}`,
    via: 'evaluate',
  };
}
