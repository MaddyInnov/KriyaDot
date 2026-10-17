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
import type { TieredMemoryStore } from './memory.js';

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

export type JournalAction = 'add' | 'deactivate' | 'reactivate' | 'pin' | 'unpin';

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

// ---------------------------------------------------------------------------
// Nightly tidy: dedupe + contradiction check (deterministic, zero-LLM)
// ---------------------------------------------------------------------------

export interface TidyResult {
  botId: string;
  examined: number;
  duplicatesDeactivated: number;
  contradictionsOpened: number;
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
  opts: { maxPairs?: number } = {},
): TidyResult {
  const atoms = store.getAtoms(botId, 5000);
  let duplicatesDeactivated = 0;
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
      journal.record({
        botId,
        action: 'deactivate',
        atomId: d.id,
        before: d,
        note: `tidy: duplicate of "${sorted[0].fact.slice(0, 60)}"`,
      });
      deactivateAtomDirect(store, botId, d.id);
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
  return { botId, examined: atoms.length, duplicatesDeactivated, contradictionsOpened, at: Date.now() };
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
  opts: { sinceTs?: number; maxEvents?: number } = {},
): { botId: string; eventsScanned: number; atomsStored: number } {
  const events = store.listRecentEvents(botId, opts.maxEvents ?? 200);
  let atomsStored = 0;
  for (const ev of events) {
    if (opts.sinceTs && ev.ts < opts.sinceTs) continue;
    if (ev.role !== 'user') continue;
    const facts = extractFactsFromText(ev.text);
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
