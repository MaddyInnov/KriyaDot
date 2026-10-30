// SPDX-License-Identifier: Apache-2.0
// Universal Chat — per-user universal session store + deterministic router.
//
// The universal thread is the bot-less front door to KriyaDot: the user
// types, and each message is routed automatically —
//
//   direct     → answered by the anchor bot (the configured Chief of
//                Staff when one is set; otherwise the first roster bot),
//                in the universal session itself.
//   specialist → executed by the one bot whose domain the message clearly
//                matches (or the bot the user @mentioned), in that bot's
//                own shadow session; the exchange is mirrored into the
//                universal thread with attribution.
//   split      → decomposed and executed by the Fusion engine (planner →
//                parallel workers → one synthesized answer).
//
// Routing here is RULES-ONLY and fully deterministic — no LLM call is made
// to decide a route, so the common direct path pays zero extra latency and
// the zero-key first-run path (runTurn's keyless fallback chain) is never
// gated on a classifier being reachable. Decision order:
//
//   1. Explicit @mention of a bot      → specialist (forced, confidence 1)
//   2. Clear multi-part structure      → split
//   3. Strong keyword/topic score for a non-anchor bot → specialist
//   4. Everything else                 → direct (when unsure, direct)
//
// Every decision is also recorded in the unified invocation decision log
// (kind 'routing') by the routes module — this file stays pure/storage.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  openDb,
  scoreBotsForRouting,
  type BotConfig,
  type RouterWeights,
} from '@mvp/agent-runtime';

export type UniversalPath = 'direct' | 'specialist' | 'split';

export type UniversalRouteVia = 'mention' | 'split-rules' | 'keyword-score' | 'default';

export interface UniversalRouteDecision {
  path: UniversalPath;
  /** Bot that executes: anchor for direct/split, target for specialist. */
  botId: string;
  botName: string;
  /** Human-readable reason — shown in Pro mode and stored in the decision log. */
  reason: string;
  /** 0..1 — heuristic confidence (1 for mention-forced routes). */
  confidence: number;
  via: UniversalRouteVia;
}

/** Minimum keyword score for an unforced specialist route. */
export const SPECIALIST_MIN_SCORE = 4;
/** Minimum winner-share confidence for an unforced specialist route. */
export const SPECIALIST_MIN_CONFIDENCE = 0.5;

/**
 * The anchor bot for universal chat: the configured Chief of Staff when
 * one is set, else a bot flagged chiefOfStaff, else the first roster bot.
 * Returns undefined when the roster is empty.
 */
export function resolveAnchorBot(bots: BotConfig[], chiefBotId: string | null): BotConfig | undefined {
  if (chiefBotId) {
    const chief = bots.find((b) => b.id === chiefBotId);
    if (chief) return chief;
  }
  return bots.find((b) => b.chiefOfStaff === true) ?? bots[0];
}

/**
 * Parse an explicit @mention of a bot: `@<bot name>` or `@<bot id>`,
 * case-insensitive, longest match wins (names contain spaces, e.g.
 * "@Data Analyst"). Mirrors the web composer's mention insertion format.
 */
export function parseBotMention(text: string, bots: BotConfig[]): BotConfig | undefined {
  const lowered = text.toLowerCase();
  let best: BotConfig | undefined;
  let bestLen = 0;
  for (const bot of bots) {
    for (const label of [bot.name, bot.id]) {
      const needle = `@${label.toLowerCase()}`;
      if (needle.length > bestLen && lowered.includes(needle)) {
        best = bot;
        bestLen = needle.length;
      }
    }
  }
  return best;
}

/** Action verbs that mark a clause as an executable subtask. */
const ACTION_VERBS = new Set([
  'research', 'find', 'search', 'write', 'draft', 'create', 'build', 'make',
  'summarize', 'summarise', 'compare', 'analyze', 'analyse', 'review',
  'check', 'plan', 'translate', 'explain', 'list', 'outline', 'design',
  'fix', 'debug', 'test', 'prepare', 'generate', 'collect', 'gather',
  'evaluate', 'assess', 'describe', 'identify', 'calculate', 'book',
  'schedule', 'send', 'organize', 'organise', 'estimate', 'propose',
]);

function clauseHasAction(clause: string): boolean {
  const tokens = clause.toLowerCase().match(/[a-z]+/g) ?? [];
  return tokens.some((t) => ACTION_VERBS.has(t));
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

/**
 * Deterministic multi-part detection. Deliberately conservative — a split
 * is only claimed on CLEAR structure, per the routing contract ("when
 * unsure, route direct"):
 *
 *  - explicit decomposition phrasing ("split this into…", "in parallel");
 *  - a list of ≥2 items (bullets or numbered lines);
 *  - ≥2 distinct questions in one message;
 *  - ≥2 action-bearing clauses joined by "and then" / ";" / ", and" /
 *    sentence boundaries, in a message long enough to be a compound task.
 */
export function detectSplit(text: string): { split: boolean; reason: string } {
  const trimmed = text.trim();

  if (
    /\b(split|break)\s+(this|it|the\s+task|that)\b[^.?!]*\b(into|down|up)\b/i.test(trimmed) ||
    /\bin parallel\b/i.test(trimmed) ||
    /\b(do|run|handle)\s+these\s+in\s+parallel\b/i.test(trimmed)
  ) {
    return { split: true, reason: 'explicit request to split the task' };
  }

  const listLines = trimmed
    .split('\n')
    .filter((line) => /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/.test(line));
  if (listLines.length >= 2) {
    return { split: true, reason: `${listLines.length}-item list structure` };
  }

  const questions = trimmed.split('?').filter((q) => wordCount(q) >= 3);
  if ((trimmed.match(/\?/g) ?? []).length >= 2 && questions.length >= 2) {
    return { split: true, reason: 'multiple distinct questions in one message' };
  }

  if (wordCount(trimmed) >= 14) {
    const clauses = trimmed
      .split(/\band then\b|;|\.\s+|,\s+and\s+/i)
      .map((c) => c.trim())
      .filter((c) => wordCount(c) >= 3);
    const actionClauses = clauses.filter(clauseHasAction);
    if (actionClauses.length >= 2) {
      return {
        split: true,
        reason: `compound request with ${actionClauses.length} action clauses`,
      };
    }
  }

  return { split: false, reason: 'no clear multi-part structure' };
}

/**
 * Decide the universal route for one message. Pure and deterministic:
 * same (text, bots, anchor, weights) → same decision. Never throws on
 * odd input; degenerate rosters collapse to direct.
 */
export function decideUniversalRoute(
  text: string,
  bots: BotConfig[],
  anchor: BotConfig,
  weights?: RouterWeights,
): UniversalRouteDecision {
  // 1. Explicit @mention forces the named bot.
  const mentioned = parseBotMention(text, bots);
  if (mentioned) {
    if (mentioned.id === anchor.id) {
      return {
        path: 'direct',
        botId: anchor.id,
        botName: anchor.name,
        reason: `you mentioned ${anchor.name}, the universal anchor — answered directly`,
        confidence: 1,
        via: 'mention',
      };
    }
    return {
      path: 'specialist',
      botId: mentioned.id,
      botName: mentioned.name,
      reason: `you mentioned ${mentioned.name}`,
      confidence: 1,
      via: 'mention',
    };
  }

  // 2. Clear multi-part structure → split (executed by the anchor's fusion).
  const split = detectSplit(text);
  if (split.split) {
    return {
      path: 'split',
      botId: anchor.id,
      botName: anchor.name,
      reason: split.reason,
      confidence: 0.9,
      via: 'split-rules',
    };
  }

  // 3. Strong keyword/topic match for a non-anchor bot → specialist.
  const candidates = bots.filter((b) => b.id !== anchor.id);
  if (candidates.length > 0) {
    const scored = scoreBotsForRouting(
      text,
      candidates.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        keywords: b.routeKeywords,
      })),
      weights,
    );
    const total = scored.reduce((acc, s) => acc + s.score, 0);
    let winner = scored[0]!;
    for (const s of scored) if (s.score > winner.score) winner = s;
    const confidence = total > 0 ? Math.round((winner.score / total) * 100) / 100 : 0;
    if (winner.score >= SPECIALIST_MIN_SCORE && confidence >= SPECIALIST_MIN_CONFIDENCE) {
      const bot = candidates.find((b) => b.id === winner.botId)!;
      const hits = [...new Set(winner.hits)].slice(0, 4).join(', ');
      return {
        path: 'specialist',
        botId: bot.id,
        botName: bot.name,
        reason: `strong domain match for ${bot.name} (${hits})`,
        confidence,
        via: 'keyword-score',
      };
    }
  }

  // 4. Default: the anchor answers directly.
  return {
    path: 'direct',
    botId: anchor.id,
    botName: anchor.name,
    reason: 'no strong specialist match — the anchor answers directly',
    confidence: 0,
    via: 'default',
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface UniversalAttribution {
  id: number;
  sessionId: string;
  userId: string;
  path: UniversalPath;
  botId: string;
  botName: string;
  reason: string;
  confidence: number;
  via: UniversalRouteVia;
  ts: string;
}

/** Persistent universal-chat state: <dataDir>/universal-chat.db (SQLite). */
export class UniversalChatStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'universal-chat.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS universal_sessions (
        user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        anchor_bot_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS universal_attributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        path TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        via TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_universal_attr_session
        ON universal_attributions(session_id, id);
    `);
  }

  getSessionId(userId: string): string | undefined {
    const row = this.db
      .prepare('SELECT session_id FROM universal_sessions WHERE user_id = ?')
      .get(userId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  setSession(userId: string, sessionId: string, anchorBotId: string): void {
    this.db
      .prepare(
        `INSERT INTO universal_sessions (user_id, session_id, anchor_bot_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id,
           anchor_bot_id = excluded.anchor_bot_id`,
      )
      .run(userId, sessionId, anchorBotId, new Date().toISOString());
  }

  recordAttribution(rec: Omit<UniversalAttribution, 'id' | 'ts'>): UniversalAttribution {
    const ts = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO universal_attributions
           (session_id, user_id, path, bot_id, bot_name, reason, confidence, via, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.sessionId, rec.userId, rec.path, rec.botId, rec.botName, rec.reason, rec.confidence, rec.via, ts);
    return { ...rec, id: Number(info.lastInsertRowid), ts };
  }

  listAttributions(sessionId: string, limit = 50): UniversalAttribution[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, user_id, path, bot_id, bot_name, reason, confidence, via, ts
         FROM universal_attributions WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, Math.max(1, Math.min(200, limit))) as unknown as Array<{
      id: number;
      session_id: string;
      user_id: string;
      path: UniversalPath;
      bot_id: string;
      bot_name: string;
      reason: string;
      confidence: number;
      via: UniversalRouteVia;
      ts: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      userId: r.user_id,
      path: r.path,
      botId: r.bot_id,
      botName: r.bot_name,
      reason: r.reason,
      confidence: r.confidence,
      via: r.via,
      ts: r.ts,
    }));
  }
}
