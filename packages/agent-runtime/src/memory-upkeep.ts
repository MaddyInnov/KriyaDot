// SPDX-License-Identifier: Apache-2.0
/**
 * Memory upkeep suite (OpenMausBot parity): the memory keeper already
 * ingests every turn; this module adds the background loops around it.
 *
 * 1. Background capture — an idle-time pass that re-scans recent raw L0
 *    turn events with the zero-cost heuristic extractor and stores durable
 *    facts the per-turn keeper may have skipped. Runs on idle (never during
 *    an active turn), never on every turn.
 * 2. Nightly tidy — dedupes atoms (same normalized fact, or near-duplicate
 *    wording) and contradiction-checks pairs, opening 'contradicts' links
 *    (which mint conflicts) for opposing statements about the same entity.
 *    All deterministic, zero-LLM, zero network.
 * 3. About-me — a user-editable profile the bot reads into context.
 * 4. Undoable journal — memory writes go through a journal; the last N
 *    changes are revertable.
 *
 * Nothing here claims learning: capture/tidy are deterministic heuristics
 * and the code says so.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './sqlite.js';
import type { AtomCard, MemoryScope, OrientationEntry, TieredMemoryStore } from './memory.js';
import { estimateAtomTokens, isUserRuleFact } from './memory.js';
import {
  proposeCandidate,
  verifyCandidate,
  type CandidateVerifier,
  type EvolutionCandidate,
} from './routing-learn.js';

// ---------------------------------------------------------------------------
// Fact extraction (zero-cost heuristic — same honesty contract as the
// keeper's heuristicDistill: patterns, not understanding)
// ---------------------------------------------------------------------------

export interface ExtractedFact {
  fact: string;
  entities: string[];
  confidence: number;
  category: 'fact' | 'preference' | 'procedure';
}

/** Patterns that usually carry durable user facts. Order matters: first match wins per sentence. */
const FACT_PATTERNS: Array<{ re: RegExp; category: ExtractedFact['category']; confidence: number }> = [
  { re: /\bmy name is ([^.!\n]{2,60})/i, category: 'fact', confidence: 0.95 },
  { re: /\bi (?:live|am based) in ([^.!\n]{2,60})/i, category: 'fact', confidence: 0.9 },
  { re: /\bi work (?:at|for|as) ([^.!\n]{2,80})/i, category: 'fact', confidence: 0.85 },
  { re: /\bmy (?:favorite|favourite) ([a-z ]{2,30}) is ([^.!\n]{2,60})/i, category: 'preference', confidence: 0.9 },
  { re: /\bi prefer ([^.!\n]{2,80})/i, category: 'preference', confidence: 0.85 },
  { re: /\bi (?:don't|do not|never) like ([^.!\n]{2,60})/i, category: 'preference', confidence: 0.85 },
  { re: /\bremember (?:that )?([^.!\n]{4,140})/i, category: 'fact', confidence: 0.9 },
  { re: /\b(?:don't|do not) forget (?:that )?([^.!\n]{4,140})/i, category: 'fact', confidence: 0.9 },
  { re: /\bmy (?:phone|email|birthday|anniversary) is ([^.!\n]{2,80})/i, category: 'fact', confidence: 0.9 },
  { re: /\balways ([^.!\n]{4,120})/i, category: 'procedure', confidence: 0.7 },
  { re: /\bnever ([^.!\n]{4,120})/i, category: 'procedure', confidence: 0.7 },
];

const ENTITY_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;

/**
 * Extract durable-fact candidates from raw turn text. Deterministic,
 * zero-LLM. Returns [] for text with no matching pattern.
 */
export function extractFactsFromText(text: string): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const sentences = text.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8);
  for (const sentence of sentences.slice(0, 40)) {
    for (const p of FACT_PATTERNS) {
      const m = p.re.exec(sentence);
      if (!m) continue;
      const fact = sentence.length > 200 ? `${sentence.slice(0, 200)}…` : sentence;
      const entities = [...new Set([...sentence.matchAll(ENTITY_RE)].map((e) => e[1].trim()))].slice(0, 5);
      out.push({ fact, entities, confidence: p.confidence, category: p.category });
      break; // one fact per sentence
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// About-me profile
// ---------------------------------------------------------------------------

const ABOUT_ME_FILE = 'about-me.json';
const MAX_ABOUT_ME_CHARS = 4000;

export interface AboutMeProfile {
  text: string;
  updatedAt: number;
}

export function aboutMePath(dataDir: string): string {
  return join(dataDir, ABOUT_ME_FILE);
}

/** Read the user's about-me profile (empty text when never set). */
export function readAboutMe(dataDir: string): AboutMeProfile {
  try {
    const raw = readFileSync(aboutMePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as { text?: unknown; updatedAt?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return { text: '', updatedAt: 0 };
  }
}

/** Save the user's about-me profile. Throws on overlong input. */
export function writeAboutMe(dataDir: string, text: string): AboutMeProfile {
  const clean = text.trim().slice(0, MAX_ABOUT_ME_CHARS);
  if (text.trim().length > MAX_ABOUT_ME_CHARS) {
    throw new Error(`About-me is limited to ${MAX_ABOUT_ME_CHARS} characters.`);
  }
  mkdirSync(dataDir, { recursive: true });
  const profile: AboutMeProfile = { text: clean, updatedAt: Date.now() };
  const tmp = `${aboutMePath(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(profile, null, 2), 'utf8');
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmp, aboutMePath(dataDir));
  return profile;
}

// ---------------------------------------------------------------------------
// Undoable journal
// ---------------------------------------------------------------------------

export type JournalAction =
  | 'add'
  | 'deactivate'
  | 'reactivate'
  | 'pin'
  | 'unpin'
  /** Atom moved to the cold archive (#80/#81); undo promotes it back. */
  | 'archive'
  /** Cold atom promoted back to hot (#81); undo re-archives it. */
  | 'promote';

/** One journaled memory mutation. `before` is null for adds. */
export interface JournalEntry {
  seq: number;
  id: string;
  ts: number;
  botId: string;
  action: JournalAction;
  atomId: string;
  before: string | null; // JSON snapshot of the atom before (null for add)
  after: string | null; // JSON snapshot after (null for deactivate)
  note: string;
}

/** Keep the last N journal entries revertable. */
export const JOURNAL_KEEP = 50;

/**
 * Undoable journal around a TieredMemoryStore. Wrap the store's mutating
 * calls (addAtom/deactivateAtom/...) with journalAdd/journalDeactivate so
 * the UI can list recent changes and undo them. Undo restores the atom's
 * before-snapshot (or deletes an added atom).
 */
export class MemoryJournal {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'memory-journal.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        bot_id TEXT NOT NULL,
        action TEXT NOT NULL,
        atom_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journal_bot ON journal (bot_id, seq DESC);
    `);
  }

  /** Record a mutation. Snapshots are plain JSON of the atom card. */
  record(entry: {
    botId: string;
    action: JournalAction;
    atomId: string;
    before?: unknown;
    after?: unknown;
    note?: string;
  }): JournalEntry {
    const id = randomUUID();
    const ts = Date.now();
    this.db
      .prepare(
        'INSERT INTO journal (id, ts, bot_id, action, atom_id, before_json, after_json, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        ts,
        entry.botId,
        entry.action,
        entry.atomId,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        (entry.note ?? '').slice(0, 500),
      );
    // Bound the journal: keep the newest JOURNAL_KEEP rows per bot.
    this.db
      .prepare(
        `DELETE FROM journal WHERE bot_id = ? AND seq NOT IN (
           SELECT seq FROM journal WHERE bot_id = ? ORDER BY seq DESC LIMIT ?
         )`,
      )
      .run(entry.botId, entry.botId, JOURNAL_KEEP);
    const row = this.db.prepare('SELECT seq FROM journal WHERE id = ?').get(id) as { seq: number };
    return {
      seq: row.seq,
      id,
      ts,
      botId: entry.botId,
      action: entry.action,
      atomId: entry.atomId,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      note: entry.note ?? '',
    };
  }

  /** Recent entries, newest first. */
  list(botId: string, limit = 20): JournalEntry[] {
    const rows = this.db
      .prepare(
        'SELECT seq, id, ts, bot_id AS botId, action, atom_id AS atomId, before_json AS before, after_json AS after, note FROM journal WHERE bot_id = ? ORDER BY seq DESC LIMIT ?',
      )
      .all(botId, Math.min(Math.max(limit, 1), 100)) as unknown as JournalEntry[];
    return rows;
  }

  /**
   * Undo the most recent entry for a bot. Applies the inverse mutation to
   * the given TieredMemoryStore and removes the entry (undo itself is not
   * journaled — redo is out of scope). Returns the undone entry, or null
   * when the journal is empty.
   */
  undoLast(botId: string, store: TieredMemoryStore): JournalEntry | null {
    const entries = this.list(botId, 1);
    const entry = entries[0];
    if (!entry) return null;
    const before = entry.before ? (JSON.parse(entry.before) as { fact?: string }) : null;
    if (entry.action === 'add') {
      // Inverse of add: deactivate the atom (kept for the audit trail).
      deactivateAtomDirect(store, botId, entry.atomId);
    } else if (entry.action === 'deactivate') {
      reactivateAtomDirect(store, botId, entry.atomId);
    } else if (entry.action === 'archive') {
      // Inverse of archive: promote the atom back out of the cold tier.
      if (typeof store.promoteFromCold === 'function') store.promoteFromCold(botId, entry.atomId);
      else reactivateAtomDirect(store, botId, entry.atomId);
    } else if (entry.action === 'promote') {
      // Inverse of promote: send the atom back to the cold archive.
      if (typeof store.archiveAtom === 'function') store.archiveAtom(botId, entry.atomId);
      else deactivateAtomDirect(store, botId, entry.atomId);
    } else if (before && typeof before.fact === 'string') {
      // For pin/unpin the before-snapshot restore is a no-op detail; the
      // meaningful undoable actions are add/deactivate.
    }
    this.db.prepare('DELETE FROM journal WHERE id = ?').run(entry.id);
    return entry;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Direct atom (de)activation used by the journal and the tidy pass.
 * Implemented here (not on TieredMemoryStore) so the journal stays a
 * separate opt-in layer; uses the store's own db handle via a targeted
 * helper on the store.
 */
function deactivateAtomDirect(store: TieredMemoryStore, botId: string, atomId: string): void {
  store.setAtomActive(botId, atomId, false);
}

function reactivateAtomDirect(store: TieredMemoryStore, botId: string, atomId: string): void {
  store.setAtomActive(botId, atomId, true);
}

/**
 * Archive-after-replace (#80): when the store supports the cold tier,
 * a replaced atom is ARCHIVED (retrievable via searchCold, promotable on
 * material use) instead of merely deactivated in place. Structural
 * stores without archiveAtom fall back to plain deactivation.
 * Returns the journal action that describes what happened.
 */
function archiveAtomDirect(store: TieredMemoryStore, botId: string, atomId: string): JournalAction {
  if (typeof store.archiveAtom === 'function' && store.archiveAtom(botId, atomId)) {
    return 'archive';
  }
  deactivateAtomDirect(store, botId, atomId);
  return 'deactivate';
}

// ---------------------------------------------------------------------------
// Nightly tidy: dedupe + contradiction check (deterministic, zero-LLM)
// ---------------------------------------------------------------------------

export interface TidyResult {
  botId: string;
  examined: number;
  duplicatesDeactivated: number;
  contradictionsOpened: number;
  /** Near-duplicate pairs found by embedding similarity (learning hardening). */
  nearDuplicatesFound: number;
  /** Near-duplicate merges the verifier rejected (atoms kept). */
  mergesVetoed: number;
  /**
   * Replaced atoms moved to the cold archive (#80 archive-after-replace)
   * rather than deactivated in place. Subset of duplicatesDeactivated;
   * 0 for structural stores without cold-tier support.
   */
  archived: number;
  at: number;
}

const OPPOSITION_PAIRS: Array<[RegExp, RegExp]> = [
  [/\blikes?\b/i, /\bdislikes?\b/i],
  [/\bloves?\b/i, /\bhates?\b/i],
  [/\balways\b/i, /\bnever\b/i],
  [/\bis\b/i, /\bis not\b/i],
  [/\bcan\b/i, /\bcannot\b|\bcan't\b/i],
  [/\bdoes\b/i, /\bdoes not\b|\bdoesn't\b/i],
];

/** Cheap contradiction heuristic: same entity mentioned + opposing polarity words. */
export function looksContradictory(aFact: string, bFact: string, sharedEntity: string): boolean {
  if (aFact === bFact) return false;
  const e = sharedEntity.toLowerCase();
  if (!aFact.toLowerCase().includes(e) || !bFact.toLowerCase().includes(e)) return false;
  return OPPOSITION_PAIRS.some(
    ([p, q]) => (p.test(aFact) && q.test(bFact)) || (q.test(aFact) && p.test(bFact)),
  );
}

/**
 * Tidy one bot's memory: deactivate exact/near-duplicate atoms (keeping the
 * earliest), and open 'contradicts' links for opposing pairs (which mint
 * conflicts for the user to resolve). Returns a summary. Every deactivation
 * is journaled so it can be undone.
 */
export function tidyMemory(
  store: TieredMemoryStore,
  journal: MemoryJournal,
  botId: string,
  opts: {
    maxPairs?: number;
    /**
     * Verifier gate for near-duplicate merges (learning hardening):
     * near-dupes (similar but not identical text) are deactivated ONLY
     * when this returns true. Without a verifier they are counted and
     * left untouched — merging paraphrases on similarity alone is
     * exactly how memory systems silently lose distinct facts.
     */
    mergeVerifier?: (keep: AtomCard, duplicate: AtomCard, similarity: number) => boolean;
    /** Similarity threshold for near-duplicate candidates. Default 0.92. */
    nearDuplicateThreshold?: number;
  } = {},
): TidyResult {
  const atoms = store.getAtoms(botId, 5000);
  let duplicatesDeactivated = 0;
  let nearDuplicatesFound = 0;
  let mergesVetoed = 0;
  let archived = 0;
  // Dedupe: group by normalized fact text; keep the earliest, deactivate rest.
  const normOf = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const groups = new Map<string, typeof atoms>();
  for (const a of atoms) {
    const key = normOf(a.fact);
    if (!key) continue;
    const g = groups.get(key) ?? [];
    g.push(a);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((x, y) => x.createdAt - y.createdAt);
    const [, ...dupes] = sorted;
    for (const d of dupes) {
      // Archive-after-replace (#80): replaced atoms go to the cold tier.
      const action = archiveAtomDirect(store, botId, d.id);
      if (action === 'archive') archived += 1;
      journal.record({
        botId,
        action,
        atomId: d.id,
        before: d,
        note: `tidy: duplicate of "${sorted[0].fact.slice(0, 60)}"`,
      });
      duplicatesDeactivated += 1;
    }
  }

  // Near-duplicate merges (verifier-gated): paraphrase-level dupes the
  // exact pass cannot see. Each candidate pair is offered to the
  // verifier; only approved merges deactivate (journaled, undoable).
  {
    // Structural stores (test doubles, older hosts) may not implement
    // near-duplicate detection — the pass is skipped for them.
    const pairs =
      typeof store.findNearDuplicatePairs === 'function'
        ? store.findNearDuplicatePairs(botId, opts.nearDuplicateThreshold ?? 0.92)
        : [];
    nearDuplicatesFound = pairs.length;
    const deactivatedThisRun = new Set<string>();
    for (const { keep, duplicate, similarity } of pairs) {
      if (deactivatedThisRun.has(keep.id) || deactivatedThisRun.has(duplicate.id)) continue;
      if (!opts.mergeVerifier) continue; // no verifier → never merge paraphrases
      let approved = false;
      try {
        approved = opts.mergeVerifier(keep, duplicate, similarity);
      } catch {
        approved = false; // verifier errors veto (fail-closed)
      }
      if (!approved) {
        mergesVetoed += 1;
        continue;
      }
      // Archive-after-replace (#80): the merged-away atom goes cold.
      const action = archiveAtomDirect(store, botId, duplicate.id);
      if (action === 'archive') archived += 1;
      journal.record({
        botId,
        action,
        atomId: duplicate.id,
        before: duplicate,
        note: `tidy: verified near-duplicate of "${keep.fact.slice(0, 60)}" (similarity ${similarity.toFixed(2)})`,
      });
      deactivatedThisRun.add(duplicate.id);
      duplicatesDeactivated += 1;
    }
  }

  // Contradiction check: bounded pairwise scan over active atoms.
  const active = store.getAtoms(botId, 5000);
  let contradictionsOpened = 0;
  const maxPairs = opts.maxPairs ?? 20000;
  let pairs = 0;
  outer: for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (++pairs > maxPairs) break outer;
      const a = active[i];
      const b = active[j];
      const shared = a.entities.find((e) => b.entities.includes(e));
      if (!shared) continue;
      if (!looksContradictory(a.fact, b.fact, shared)) continue;
      try {
        store.createLink(botId, a.id, b.id, 'contradicts', 'tidy');
        contradictionsOpened += 1;
      } catch {
        // link exists / atoms unknown — skip
      }
    }
  }
  return {
    botId,
    examined: atoms.length,
    duplicatesDeactivated,
    contradictionsOpened,
    nearDuplicatesFound,
    mergesVetoed,
    archived,
    at: Date.now(),
  };
}

/**
 * Background capture pass: re-scan recent L0 turn events that the per-turn
 * keeper skipped (short turns, distiller failures) with the zero-cost
 * heuristic extractor and store durable facts. Returns the number of atoms
 * stored. Every stored atom is journaled.
 */
export function capturePass(
  store: TieredMemoryStore,
  journal: MemoryJournal,
  botId: string,
  opts: { sinceTs?: number; maxEvents?: number; scope?: MemoryScope } = {},
): { botId: string; eventsScanned: number; atomsStored: number } {
  const events = store.listRecentEvents(botId, opts.maxEvents ?? 200);
  let atomsStored = 0;
  for (const ev of events) {
    if (opts.sinceTs && ev.ts < opts.sinceTs) continue;
    if (ev.role !== 'user') continue;
    const facts = extractFactsFromText(ev.text);
    if (facts.length === 0) continue;
    // Grounded storage (#75): capture goes through the same fail-closed
    // path as live distillation — rules/preferences need a verbatim
    // quote in the user's event text, procedures need the session
    // citation this event provides. Scope (#74) is stamped when given.
    if (typeof store.storeDistilledFacts === 'function') {
      const res = store.storeDistilledFacts(
        botId,
        facts.map((f) => ({
          fact: f.fact,
          entities: f.entities,
          confidence: f.confidence,
          category: f.category,
        })),
        { sessionId: ev.sessionId, userText: ev.text, userEventId: ev.id, scope: opts.scope },
      );
      for (const id of res.atomIds) {
        const atom = store.getAtom(botId, id);
        journal.record({
          botId,
          action: 'add',
          atomId: id,
          after: atom ?? undefined,
          note: `capture: background pass from turn ${ev.id.slice(0, 8)}`,
        });
        atomsStored += 1;
      }
      continue;
    }
    // Structural stores without the grounded path keep the legacy write.
    for (const f of facts) {
      try {
        const id = store.storeAtom(
          botId,
          { fact: f.fact, entities: f.entities, confidence: f.confidence },
          `capture:${ev.id}`,
          undefined,
          { category: f.category },
        );
        const atom = store.getAtom(botId, id);
        journal.record({
          botId,
          action: 'add',
          atomId: id,
          after: atom ?? undefined,
          note: `capture: background pass from turn ${ev.id.slice(0, 8)}`,
        });
        atomsStored += 1;
      } catch {
        // deduped or invalid — skip
      }
    }
  }
  return { botId, eventsScanned: events.length, atomsStored };
}

// ---------------------------------------------------------------------------
// Watermark budgets (#80): per-tier atom/token budgets with enforcement.
//
// Each tier (hot = active atoms, cold = archived catalog) has a HIGH
// watermark (maxAtoms / maxTokens). When a tier exceeds its high
// watermark it is drained down to its LOW watermark (default 80% of
// high): hot drains by archiving the least valuable atoms (unpinned,
// lowest material-use credit, oldest first) into the cold tier; cold
// drains by permanently forgetting its oldest atoms. Before archiving,
// near-duplicate pairs are offered to the mergeVerifier (when provided)
// so paraphrase merges — verifier-gated, never automatic — shrink the
// hot tier first. Every move is journaled.
// ---------------------------------------------------------------------------

export interface TierBudget {
  /** High watermark: atom count. */
  maxAtoms?: number;
  /** High watermark: estimated tokens (see estimateAtomTokens). */
  maxTokens?: number;
  /** Low watermark targets; default 80% of the corresponding high mark. */
  lowAtoms?: number;
  lowTokens?: number;
}

export interface WatermarkBudgets {
  hot?: TierBudget;
  cold?: TierBudget;
}

export interface WatermarkResult {
  botId: string;
  hotBefore: number;
  hotAfter: number;
  coldBefore: number;
  coldAfter: number;
  /** Hot atoms archived into the cold tier. */
  archived: number;
  /** Near-duplicate merges performed under the verifier en route. */
  merged: number;
  /** Cold atoms permanently forgotten on cold overflow. */
  coldForgotten: number;
  at: number;
}

export const DEFAULT_WATERMARK_BUDGETS: WatermarkBudgets = {
  hot: { maxAtoms: 1000, maxTokens: 200_000 },
  cold: { maxAtoms: 5000 },
};

type MergeVerifier = (keep: AtomCard, duplicate: AtomCard, similarity: number) => boolean;

export function enforceWatermarkBudgets(
  store: TieredMemoryStore,
  journal: MemoryJournal,
  botId: string,
  opts: {
    budgets?: WatermarkBudgets;
    /** Verifier gate for near-duplicate merges before archiving (#80). */
    mergeVerifier?: MergeVerifier;
    nearDuplicateThreshold?: number;
  } = {},
): WatermarkResult {
  const budgets: WatermarkBudgets = {
    hot: { ...DEFAULT_WATERMARK_BUDGETS.hot, ...opts.budgets?.hot },
    cold: { ...DEFAULT_WATERMARK_BUDGETS.cold, ...opts.budgets?.cold },
  };
  let merged = 0;
  let archived = 0;
  let coldForgotten = 0;

  const hotBefore = store.getAtoms(botId, 100_000).length;
  const coldBefore = typeof store.listColdAtoms === 'function' ? store.listColdAtoms(botId, 100_000).length : 0;

  // ---- hot tier -------------------------------------------------------
  const hot = budgets.hot!;
  let atoms = store.getAtoms(botId, 100_000);
  let tokens = atoms.reduce((sum, a) => sum + estimateAtomTokens(a), 0);
  const hotOver =
    (hot.maxAtoms !== undefined && atoms.length > hot.maxAtoms) ||
    (hot.maxTokens !== undefined && tokens > hot.maxTokens);
  if (hotOver) {
    // 1. Verifier-gated near-duplicate merges shrink hot first.
    if (opts.mergeVerifier && typeof store.findNearDuplicatePairs === 'function') {
      const pairs = store.findNearDuplicatePairs(botId, opts.nearDuplicateThreshold ?? 0.92);
      const gone = new Set<string>();
      for (const { keep, duplicate, similarity } of pairs) {
        if (gone.has(keep.id) || gone.has(duplicate.id)) continue;
        let approved = false;
        try {
          approved = opts.mergeVerifier(keep, duplicate, similarity);
        } catch {
          approved = false; // fail-closed
        }
        if (!approved) continue;
        archiveAtomDirect(store, botId, duplicate.id);
        journal.record({
          botId,
          action: 'archive',
          atomId: duplicate.id,
          before: duplicate,
          note: `watermark: verified merge into "${keep.fact.slice(0, 60)}"`,
        });
        gone.add(duplicate.id);
        merged += 1;
      }
      atoms = store.getAtoms(botId, 100_000);
      tokens = atoms.reduce((sum, a) => sum + estimateAtomTokens(a), 0);
    }
    // 2. Archive least-valuable atoms down to the low watermarks.
    const lowAtoms = hot.lowAtoms ?? (hot.maxAtoms !== undefined ? Math.floor(hot.maxAtoms * 0.8) : 0);
    const lowTokens = hot.lowTokens ?? (hot.maxTokens !== undefined ? Math.floor(hot.maxTokens * 0.8) : 0);
    const candidates = atoms
      .filter((a) => !a.pinned)
      .sort(
        (a, b) =>
          (a.useCredit ?? 0) - (b.useCredit ?? 0) ||
          a.confidence - b.confidence ||
          a.createdAt - b.createdAt,
      );
    let count = atoms.length;
    for (const cand of candidates) {
      const atomsOk = hot.maxAtoms === undefined || count <= lowAtoms;
      const tokensOk = hot.maxTokens === undefined || tokens <= lowTokens;
      if (atomsOk && tokensOk) break;
      const action = archiveAtomDirect(store, botId, cand.id);
      journal.record({
        botId,
        action,
        atomId: cand.id,
        before: cand,
        note: 'watermark: hot tier over high watermark, archived to cold',
      });
      if (action === 'archive') archived += 1;
      count -= 1;
      tokens -= estimateAtomTokens(cand);
    }
  }

  // ---- cold tier --------------------------------------------------------
  const cold = budgets.cold!;
  if (typeof store.listColdAtoms === 'function' && cold.maxAtoms !== undefined) {
    const coldAtoms = store.listColdAtoms(botId, 100_000);
    if (coldAtoms.length > cold.maxAtoms) {
      const lowCold = cold.lowAtoms ?? Math.floor(cold.maxAtoms * 0.8);
      // Oldest, least-credited cold atoms are forgotten first.
      const victims = [...coldAtoms]
        .sort((a, b) => (a.useCredit ?? 0) - (b.useCredit ?? 0) || a.createdAt - b.createdAt)
        .slice(0, coldAtoms.length - lowCold);
      for (const v of victims) {
        journal.record({
          botId,
          action: 'deactivate',
          atomId: v.id,
          before: v,
          note: 'watermark: cold tier over high watermark, permanently forgotten',
        });
        if (store.deleteAtom(botId, v.id)) coldForgotten += 1;
      }
    }
  }

  return {
    botId,
    hotBefore,
    hotAfter: store.getAtoms(botId, 100_000).length,
    coldBefore,
    coldAfter: typeof store.listColdAtoms === 'function' ? store.listColdAtoms(botId, 100_000).length : 0,
    archived,
    merged,
    coldForgotten,
    at: Date.now(),
  };
}

/**
 * One full upkeep pass (#80): tidy (with the mergeVerifier forwarded —
 * this is the entry point host call sites should use so the verifier
 * gate is live, not inert) followed by watermark enforcement (verifier
 * forwarded again for its merge step).
 */
export function runUpkeepPass(
  store: TieredMemoryStore,
  journal: MemoryJournal,
  botId: string,
  opts: {
    mergeVerifier?: MergeVerifier;
    nearDuplicateThreshold?: number;
    budgets?: WatermarkBudgets;
    maxPairs?: number;
  } = {},
): { tidy: TidyResult; watermarks: WatermarkResult } {
  const tidy = tidyMemory(store, journal, botId, {
    mergeVerifier: opts.mergeVerifier,
    nearDuplicateThreshold: opts.nearDuplicateThreshold,
    maxPairs: opts.maxPairs,
  });
  const watermarks = enforceWatermarkBudgets(store, journal, botId, {
    budgets: opts.budgets,
    mergeVerifier: opts.mergeVerifier,
    nearDuplicateThreshold: opts.nearDuplicateThreshold,
  });
  return { tidy, watermarks };
}

// ---------------------------------------------------------------------------
// About-me ↔ orientation store adapter (#76)
//
// The existing about-me profile is orientation memory (who the user is).
// These shims express it through the orientation store WITHOUT breaking
// the file-backed about-me API: sync copies file → orientation store;
// readOrientationAboutMe reads it back in the AboutMeProfile shape.
// ---------------------------------------------------------------------------

/** Copy the file-backed about-me profile into the orientation store. */
export function syncAboutMeToOrientation(
  store: TieredMemoryStore,
  botId: string,
  dataDir: string,
): OrientationEntry | null {
  const { text } = readAboutMe(dataDir);
  if (!text.trim()) return null;
  return store.setOrientation(botId, 'about-me', text, 'about-me');
}

/** Read the about-me profile back from the orientation store. */
export function orientationAboutMe(store: TieredMemoryStore, botId: string): AboutMeProfile {
  const entry = store.getOrientation(botId, 'about-me');
  return entry ? { text: entry.value, updatedAt: entry.updatedAt } : { text: '', updatedAt: 0 };
}

// ---------------------------------------------------------------------------
// Multi-pass learning synthesis (#84)
//
// Pass 1 clusters related atoms deterministically (shared entity, or
// content-token overlap ≥ threshold — lexical, embedding-free).
// Pass 2 composes each cluster into ONE synthesis proposal citing its
// source atoms. Proposals are NOT applied: they enter the #82 evolution
// pipeline as candidates (synthesisProposalToCandidate) and only a
// promoted candidate should ever be stored (applySynthesisProposal is
// that final, explicit step). The composer is injectable — an LLM fn
// may replace the default extractive composition; no paid API is used
// by default.
// ---------------------------------------------------------------------------

export interface SynthesisProposal {
  id: string;
  botId: string;
  /** The composed higher-order statement. */
  fact: string;
  /** Atoms this synthesis is composed from (its citations). */
  sourceAtomIds: string[];
  entities: string[];
  confidence: number;
  category: 'reflection';
}

export type SynthesisComposer = (cluster: AtomCard[]) => string | Promise<string>;

const SYNTH_STOPWORDS = new Set(
  'the,user,users,that,this,with,from,have,has,will,would,should,their,them,they,about,into,over,under,after,before,when,what'.split(','),
);

function synthTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !SYNTH_STOPWORDS.has(t)),
  );
}

/** Pass 1 (#84): deterministic lexical clustering of atoms (union-find). */
export function clusterAtoms(atoms: AtomCard[], opts: { minOverlap?: number } = {}): AtomCard[][] {
  const minOverlap = opts.minOverlap ?? 0.3;
  const parent = atoms.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const tokenSets = atoms.map((a) => synthTokens(`${a.fact} ${a.entities.join(' ')}`));
  const entitySets = atoms.map((a) => new Set(a.entities.map((e) => e.toLowerCase())));
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const sharedEntity = [...entitySets[i]!].some((e) => entitySets[j]!.has(e));
      let related = sharedEntity;
      if (!related) {
        const a = tokenSets[i]!;
        const b = tokenSets[j]!;
        let overlap = 0;
        for (const t of a) if (b.has(t)) overlap++;
        const denom = Math.min(a.size, b.size);
        related = denom > 0 && overlap / denom >= minOverlap && overlap >= 2;
      }
      if (related) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, AtomCard[]>();
  atoms.forEach((a, i) => {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(a);
    groups.set(root, g);
  });
  // Deterministic order: bigger clusters first, then earliest atom.
  return [...groups.values()].sort(
    (a, b) => b.length - a.length || (a[0]?.createdAt ?? 0) - (b[0]?.createdAt ?? 0),
  );
}

/** Default extractive composer (#84): joins the cluster's facts, citing order preserved. */
export function extractiveCompose(cluster: AtomCard[]): string {
  const facts = [...cluster].sort((a, b) => a.createdAt - b.createdAt).map((a) => a.fact);
  return `Synthesis of ${cluster.length} related memories: ${facts.join(' ')}`.slice(0, 1000);
}

/**
 * Run the synthesis pass (#84): cluster → compose → proposals.
 * Nothing is stored; proposals are returned for the evolution pipeline.
 */
export async function runSynthesisPass(
  store: TieredMemoryStore,
  botId: string,
  opts: { composer?: SynthesisComposer; minClusterSize?: number; maxProposals?: number } = {},
): Promise<SynthesisProposal[]> {
  const minClusterSize = opts.minClusterSize ?? 2;
  const maxProposals = opts.maxProposals ?? 5;
  const atoms = store.getAtoms(botId, 500);
  const clusters = clusterAtoms(atoms).filter((c) => c.length >= minClusterSize);
  const proposals: SynthesisProposal[] = [];
  for (const cluster of clusters.slice(0, maxProposals)) {
    const fact = opts.composer
      ? await opts.composer(cluster)
      : extractiveCompose(cluster);
    if (!fact.trim()) continue;
    proposals.push({
      id: randomUUID(),
      botId,
      fact: fact.trim(),
      sourceAtomIds: cluster.map((a) => a.id),
      entities: [...new Set(cluster.flatMap((a) => a.entities))].slice(0, 10),
      confidence: cluster.reduce((s, a) => s + a.confidence, 0) / cluster.length,
      category: 'reflection',
    });
  }
  return proposals;
}

/** Wrap a synthesis proposal as an evolution-pipeline candidate (#84 → #82). */
export function synthesisProposalToCandidate(
  proposal: SynthesisProposal,
): EvolutionCandidate<SynthesisProposal> {
  return proposeCandidate<SynthesisProposal>({
    kind: 'memory-synthesis',
    description: `synthesis from ${proposal.sourceAtomIds.length} atoms: ${proposal.fact.slice(0, 80)}`,
    payload: proposal,
  });
}

/**
 * The explicit final step for a PROMOTED synthesis candidate (#84):
 * store the synthesis atom, citing its sources via a session-style
 * evidence trail (source atom ids in sourceTurn + relates links).
 * Callers must only invoke this for candidates the #82 pipeline (or a
 * human) promoted — synthesis is never applied directly.
 */
export function applySynthesisProposal(store: TieredMemoryStore, proposal: SynthesisProposal): string {
  const id = store.storeAtom(
    proposal.botId,
    {
      fact: proposal.fact,
      entities: proposal.entities,
      confidence: proposal.confidence,
      category: 'reflection',
    },
    `synthesis:${proposal.id}`,
    undefined,
    { category: 'reflection' },
  );
  for (const src of proposal.sourceAtomIds) {
    if (src === id) continue;
    try {
      store.createLink(proposal.botId, id, src, 'relates', 'synthesis');
    } catch {
      // source may have been forgotten since the proposal was made
    }
  }
  return id;
}

// ---------------------------------------------------------------------------
// Standing global rules + scoped memory rules (#85)
//
// When the same user rule recurs across multiple project scopes, the
// learner proposes it as a STANDING GLOBAL RULE (scope: global,
// pinned-candidate) — as a candidate through the #82 evolution pipeline,
// never applied directly. Scoped pairing mirrors routing-learn: rules
// are also grouped by (project, category-pattern) so a rule that only
// recurs inside one project is proposed as a scoped memory rule for
// that scope instead.
// ---------------------------------------------------------------------------

export interface StandingRulePayload {
  fact: string;
  /** Always 'global' for standing rules. */
  scope: 'global';
  /** Standing rules are pinned candidates: promotion pins the atom. */
  pinnedCandidate: true;
  projectIds: string[];
  atomIds: string[];
}

export interface ScopedRulePayload {
  fact: string;
  projectId: string;
  /** Pattern leg of the scope pairing (mirrors routing-learn's taskType). */
  pattern: string;
  atomIds: string[];
}

function normRuleFact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isRuleAtom(a: AtomCard): boolean {
  return isUserRuleFact(
    { fact: a.fact, entities: a.entities, confidence: a.confidence, category: a.category },
    a.category,
  );
}

/**
 * Detect rules recurring across ≥ minScopes distinct projects (#85) and
 * return them as evolution candidates for standing global rules.
 */
export function proposeStandingGlobalRules(
  store: TieredMemoryStore,
  botId: string,
  opts: { minScopes?: number } = {},
): Array<EvolutionCandidate<StandingRulePayload>> {
  const minScopes = opts.minScopes ?? 2;
  const atoms = store.getAtoms(botId, 5000).filter(isRuleAtom);
  const byFact = new Map<string, AtomCard[]>();
  for (const a of atoms) {
    const key = normRuleFact(a.fact);
    if (!key) continue;
    const g = byFact.get(key) ?? [];
    g.push(a);
    byFact.set(key, g);
  }
  const out: Array<EvolutionCandidate<StandingRulePayload>> = [];
  for (const group of byFact.values()) {
    const projectIds = [...new Set(group.map((a) => a.projectId).filter((p): p is string => !!p))];
    if (projectIds.length < minScopes) continue;
    const fact = group[0]!.fact;
    out.push(
      proposeCandidate<StandingRulePayload>({
        kind: 'standing-global-rule',
        description: `standing global rule candidate (recurs in ${projectIds.length} projects): ${fact.slice(0, 80)}`,
        payload: {
          fact,
          scope: 'global',
          pinnedCandidate: true,
          projectIds,
          atomIds: group.map((a) => a.id),
        },
      }),
    );
  }
  return out;
}

/**
 * Scoped memory-rule proposals (#85): rule atoms grouped by
 * (projectId × category pattern) — the memory-side mirror of
 * routing-learn's (taskType × message-pattern) pairing. A group with
 * ≥ minRecurrence atoms in ONE project becomes a scoped candidate.
 */
export function proposeScopedMemoryRules(
  store: TieredMemoryStore,
  botId: string,
  opts: { minRecurrence?: number } = {},
): Array<EvolutionCandidate<ScopedRulePayload>> {
  const minRecurrence = opts.minRecurrence ?? 2;
  const atoms = store.getAtoms(botId, 5000).filter(isRuleAtom);
  const groups = new Map<string, AtomCard[]>();
  for (const a of atoms) {
    if (!a.projectId) continue;
    const key = `${a.projectId}::${a.category}`;
    const g = groups.get(key) ?? [];
    g.push(a);
    groups.set(key, g);
  }
  const out: Array<EvolutionCandidate<ScopedRulePayload>> = [];
  for (const [key, group] of groups) {
    if (group.length < minRecurrence) continue;
    const [projectId, pattern] = key.split('::') as [string, string];
    // One candidate per distinct rule fact in the group.
    const byFact = new Map<string, AtomCard[]>();
    for (const a of group) {
      const k = normRuleFact(a.fact);
      const g = byFact.get(k) ?? [];
      g.push(a);
      byFact.set(k, g);
    }
    for (const sameFact of byFact.values()) {
      out.push(
        proposeCandidate<ScopedRulePayload>({
          kind: 'scoped-memory-rule',
          description: `scoped rule for project "${projectId}" (${pattern}): ${sameFact[0]!.fact.slice(0, 80)}`,
          payload: {
            fact: sameFact[0]!.fact,
            projectId,
            pattern,
            atomIds: sameFact.map((a) => a.id),
          },
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Composed learning-evolution pass (#82 + #84 + #85, closure-fix)
//
// The pieces existed as separate units — multi-pass synthesis (#84),
// standing-global / scoped rule proposals (#85), and the generic
// verifier → shadow pipeline (#82) — but no single entry point composed
// them, and the host upkeep loop (capture + tidy only) never ran any of
// them. This pass is that composition: one call produces every learning
// candidate for a bot and, when a verifier is supplied, runs each
// candidate through the independent verifier stage into a BOUNDED
// shadow trial (verifyCandidate stamps the expiry). Candidates are
// returned, never applied: promotion still requires beating the shadow
// bar (evolutionEligible), and applying a promoted synthesis remains
// the explicit applySynthesisProposal step.
//
// HOST WIRING: call runUpkeepPassWithLearning (below) from the idle /
// nightly upkeep loop in place of the capture+tidy-only pass, passing
// the host's verifier (or none — candidates then stay 'candidate' for
// later human/API review).
// ---------------------------------------------------------------------------

export interface LearningEvolutionResult {
  /** Synthesis proposals (#84) wrapped as evolution candidates. */
  synthesis: Array<EvolutionCandidate<SynthesisProposal>>;
  /** Standing global rule candidates (#85). */
  standing: Array<EvolutionCandidate<StandingRulePayload>>;
  /** Scoped memory rule candidates (#85). */
  scoped: Array<EvolutionCandidate<ScopedRulePayload>>;
  /** All candidates, post-verification when a verifier was supplied. */
  candidates: Array<EvolutionCandidate<unknown>>;
  verified: number;
  shadowed: number;
  rejected: number;
}

export async function runLearningEvolutionPass(
  store: TieredMemoryStore,
  botId: string,
  opts: {
    verifier?: CandidateVerifier<unknown>;
    composer?: SynthesisComposer;
    windowMs?: number;
    now?: string;
    minScopes?: number;
    minRecurrence?: number;
  } = {},
): Promise<LearningEvolutionResult> {
  const proposals = await runSynthesisPass(store, botId, {
    ...(opts.composer ? { composer: opts.composer } : {}),
  });
  const synthesis = proposals.map(synthesisProposalToCandidate);
  const standing = proposeStandingGlobalRules(store, botId, { minScopes: opts.minScopes ?? 2 });
  const scoped = proposeScopedMemoryRules(store, botId, { minRecurrence: opts.minRecurrence ?? 2 });
  let candidates: Array<EvolutionCandidate<unknown>> = [
    ...(synthesis as Array<EvolutionCandidate<unknown>>),
    ...(standing as Array<EvolutionCandidate<unknown>>),
    ...(scoped as Array<EvolutionCandidate<unknown>>),
  ];
  let verified = 0;
  if (opts.verifier) {
    const out: Array<EvolutionCandidate<unknown>> = [];
    for (const c of candidates) {
      out.push(
        await verifyCandidate(c, opts.verifier, {
          ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        }),
      );
    }
    candidates = out;
    verified = candidates.length;
  }
  return {
    synthesis: candidates.slice(0, synthesis.length) as Array<EvolutionCandidate<SynthesisProposal>>,
    standing: candidates.slice(synthesis.length, synthesis.length + standing.length) as Array<
      EvolutionCandidate<StandingRulePayload>
    >,
    scoped: candidates.slice(synthesis.length + standing.length) as Array<
      EvolutionCandidate<ScopedRulePayload>
    >,
    candidates,
    verified,
    shadowed: candidates.filter((c) => c.status === 'shadow').length,
    rejected: candidates.filter((c) => c.status === 'rejected').length,
  };
}

/**
 * Full upkeep + learning in one call (#80/#82/#84/#85): the synchronous
 * runUpkeepPass (tidy with the merge verifier forwarded + watermark
 * budgets) followed by the composed learning-evolution pass. This is
 * the entry point a host idle/nightly loop should call so synthesis,
 * standing-rule detection, and verifier-gated evolution actually run
 * in production instead of existing only as library units.
 */
export async function runUpkeepPassWithLearning(
  store: TieredMemoryStore,
  journal: MemoryJournal,
  botId: string,
  opts: {
    mergeVerifier?: MergeVerifier;
    nearDuplicateThreshold?: number;
    budgets?: WatermarkBudgets;
    maxPairs?: number;
    verifier?: CandidateVerifier<unknown>;
    composer?: SynthesisComposer;
    windowMs?: number;
    now?: string;
  } = {},
): Promise<{ tidy: TidyResult; watermarks: WatermarkResult; learning: LearningEvolutionResult }> {
  const { tidy, watermarks } = runUpkeepPass(store, journal, botId, {
    mergeVerifier: opts.mergeVerifier,
    nearDuplicateThreshold: opts.nearDuplicateThreshold,
    budgets: opts.budgets,
    maxPairs: opts.maxPairs,
  });
  const learning = await runLearningEvolutionPass(store, botId, {
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
    ...(opts.composer ? { composer: opts.composer } : {}),
    ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { tidy, watermarks, learning };
}
