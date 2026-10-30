// SPDX-License-Identifier: Apache-2.0
// Maintained per-person / per-group pages (Muse parity audit §4.4: MEM-9).
//
// Entity tracing (muse-modules traceEntity, runtime EntityPage) answers a
// query; it is not a maintained page. This store IS the page: a durable,
// closeness-ordered directory built on top of the tiered memory store's
// entity pages (TieredMemoryStore.getEntities — the same atoms entity
// tracing reads), where each page keeps:
//
//   - facts:        the atoms recorded about the entity (id, fact,
//                   confidence, category, when learned);
//   - history:      a relationship timeline — one event per fact learned
//                   (dated, from the atom's createdAt), plus manual notes
//                   appended by the user/agent, preserved across refreshes;
//   - closeness:    a deterministic score (fact count, mean confidence,
//                   pinned facts, recency) used for ordering only — it is
//                   a sort key, not a judgement about a real relationship;
//   - kind:         'person' | 'group'. A name heuristic seeds it (team /
//                   group / family / community / club / department words
//                   → group); setKind() overrides it and the override is
//                   preserved across refreshes.
//
// Refresh is a merge, never a wipe: facts are deduped by atom id, manual
// notes and kind overrides survive, and a page whose entity disappears
// from memory keeps its manual history (its facts simply stop growing).
//
// Storage: <dataDir>/people-pages.db (SQLite, node:sqlite via agent-runtime
// openDb) — its own DB so no migration is needed elsewhere.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, type TieredMemoryStore } from '@mvp/agent-runtime';

export type PageKind = 'person' | 'group';

export interface PageFact {
  atomId: string;
  fact: string;
  confidence: number;
  category: string;
  pinned: boolean;
  learnedAt: number;
}

export interface PageHistoryEvent {
  at: number;
  kind: 'fact' | 'note' | 'kind';
  text: string;
}

export interface PersonPage {
  name: string;
  kind: PageKind;
  summary: string;
  closeness: number;
  facts: PageFact[];
  history: PageHistoryEvent[];
  updatedAt: number;
}

const GROUP_WORDS = ['team', 'group', 'family', 'community', 'club', 'department', 'committee', 'society', 'association'];

export function guessPageKind(name: string): PageKind {
  const lower = ` ${name.toLowerCase()} `;
  return GROUP_WORDS.some((w) => lower.includes(` ${w} `) || lower.includes(` ${w}s `)) ? 'group' : 'person';
}

export function pageKeyFor(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Deterministic closeness score: more (and more confident, more recent)
 * recorded facts ⇒ closer. Documented formula, used for ordering only:
 *   10 per fact (cap 100) + 20 × mean confidence + 5 per pinned fact
 *   + recency bonus: 10 points decaying linearly over 30 days since the
 *   newest fact.
 */
export function closenessScore(facts: PageFact[], now: number): number {
  if (facts.length === 0) return 0;
  const meanConfidence = facts.reduce((s, f) => s + f.confidence, 0) / facts.length;
  const pinned = facts.filter((f) => f.pinned).length;
  const newest = Math.max(...facts.map((f) => f.learnedAt));
  const ageDays = Math.max(0, (now - newest) / (24 * 60 * 60 * 1000));
  const recency = Math.max(0, 10 - (ageDays / 30) * 10);
  return Math.round((Math.min(facts.length, 10) * 10 + meanConfidence * 20 + pinned * 5 + recency) * 100) / 100;
}

interface PageRow {
  name_key: string;
  name: string;
  kind: string;
  summary: string;
  closeness: number;
  facts_json: string;
  history_json: string;
  kind_locked: number;
  updated_at: number;
}

function rowToPage(r: PageRow): PersonPage {
  return {
    name: r.name,
    kind: r.kind === 'group' ? 'group' : 'person',
    summary: r.summary,
    closeness: r.closeness,
    facts: JSON.parse(r.facts_json) as PageFact[],
    history: JSON.parse(r.history_json) as PageHistoryEvent[],
    updatedAt: r.updated_at,
  };
}

export class PeoplePagesStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'people-pages.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people_pages (
        name_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        closeness REAL NOT NULL DEFAULT 0,
        facts_json TEXT NOT NULL DEFAULT '[]',
        history_json TEXT NOT NULL DEFAULT '[]',
        kind_locked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private getRow(nameKey: string): PageRow | undefined {
    return this.db.prepare('SELECT * FROM people_pages WHERE name_key = ?').get(nameKey) as unknown as PageRow | undefined;
  }

  private save(page: PersonPage & { kindLocked: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO people_pages (name_key, name, kind, summary, closeness, facts_json, history_json, kind_locked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, kind = excluded.kind,
           summary = excluded.summary, closeness = excluded.closeness, facts_json = excluded.facts_json,
           history_json = excluded.history_json, kind_locked = excluded.kind_locked, updated_at = excluded.updated_at`,
      )
      .run(
        pageKeyFor(page.name), page.name, page.kind, page.summary, page.closeness,
        JSON.stringify(page.facts), JSON.stringify(page.history), page.kindLocked ? 1 : 0, page.updatedAt,
      );
  }

  /**
   * Rebuild/refresh every page from the tiered memory store's entity
   * pages for one bot. Returns the refreshed pages (closeness-ordered).
   */
  refreshFromMemory(memory: TieredMemoryStore, botId: string, now: number = Date.now()): PersonPage[] {
    const touched: PersonPage[] = [];
    for (const entity of memory.getEntities(botId)) {
      const existingRow = this.getRow(pageKeyFor(entity.entity));
      const existing = existingRow ? rowToPage(existingRow) : undefined;
      const knownAtomIds = new Set((existing?.facts ?? []).map((f) => f.atomId));
      const facts: PageFact[] = [...(existing?.facts ?? [])];
      const history: PageHistoryEvent[] = [...(existing?.history ?? [])];
      for (const atomId of entity.atomIds) {
        if (knownAtomIds.has(atomId)) continue;
        const atom = memory.getAtom(botId, atomId);
        if (!atom) continue;
        const fact: PageFact = {
          atomId, fact: atom.fact, confidence: atom.confidence,
          category: atom.category, pinned: atom.pinned, learnedAt: atom.createdAt,
        };
        facts.push(fact);
        history.push({ at: atom.createdAt, kind: 'fact', text: atom.fact });
      }
      facts.sort((a, b) => a.learnedAt - b.learnedAt);
      history.sort((a, b) => a.at - b.at);
      const kindLocked = existingRow?.kind_locked === 1;
      const page: PersonPage & { kindLocked: boolean } = {
        name: entity.entity,
        kind: kindLocked && existing ? existing.kind : guessPageKind(entity.entity),
        summary: entity.summary,
        closeness: closenessScore(facts, now),
        facts,
        history,
        updatedAt: now,
        kindLocked,
      };
      this.save(page);
      touched.push(page);
    }
    return touched.sort((a, b) => b.closeness - a.closeness || a.name.localeCompare(b.name));
  }

  /** All maintained pages, closeness-ordered (ties: name A→Z). */
  listPages(): PersonPage[] {
    const rows = this.db.prepare('SELECT * FROM people_pages').all() as unknown as PageRow[];
    return rows.map(rowToPage).sort((a, b) => b.closeness - a.closeness || a.name.localeCompare(b.name));
  }

  getPage(name: string): PersonPage | null {
    const row = this.getRow(pageKeyFor(name));
    return row ? rowToPage(row) : null;
  }

  /** Append a manual note to a page's relationship history (creates the page when new). */
  appendNote(name: string, text: string, now: number = Date.now()): PersonPage {
    const clean = text.trim();
    if (!clean) throw new Error('note text must be non-empty');
    const existingRow = this.getRow(pageKeyFor(name));
    const existing = existingRow ? rowToPage(existingRow) : undefined;
    const page: PersonPage & { kindLocked: boolean } = {
      name: existing?.name ?? name.trim(),
      kind: existing?.kind ?? guessPageKind(name),
      summary: existing?.summary ?? '',
      closeness: existing?.closeness ?? 0,
      facts: existing?.facts ?? [],
      history: [...(existing?.history ?? []), { at: now, kind: 'note', text: clean }],
      updatedAt: now,
      kindLocked: existingRow?.kind_locked === 1,
    };
    this.save(page);
    return page;
  }

  /** Override a page's kind (person/group); the override survives refreshes. */
  setKind(name: string, kind: PageKind, now: number = Date.now()): PersonPage {
    if (kind !== 'person' && kind !== 'group') throw new Error('kind must be "person" or "group"');
    const existingRow = this.getRow(pageKeyFor(name));
    const existing = existingRow ? rowToPage(existingRow) : undefined;
    const page: PersonPage & { kindLocked: boolean } = {
      name: existing?.name ?? name.trim(),
      kind,
      summary: existing?.summary ?? '',
      closeness: existing?.closeness ?? 0,
      facts: existing?.facts ?? [],
      history: [...(existing?.history ?? []), { at: now, kind: 'kind', text: `Kind set to ${kind}.` }],
      updatedAt: now,
      kindLocked: true,
    };
    this.save(page);
    return page;
  }

  close(): void {
    this.db.close();
  }
}
