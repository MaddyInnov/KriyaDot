// SPDX-License-Identifier: Apache-2.0
// Creator revenue share: per-creator install/usage tracking + a
// revenue-split ledger with a configurable creator percentage.
//
//   MARKETPLACE_CREATOR_SHARE=0.70  → creator keeps 70%, platform 30%.
//   Default: 0.70.
//
// Money is stored as integer USD cents. SQLite-backed, own file
// `<dbPath>` (callers pass e.g. `<dataDir>/marketplace.db`).

// vitest cannot statically resolve the `node:sqlite` specifier, so load it
// at runtime via the builtin-module API (same trick as agent-runtime stores).
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export type LedgerKind = 'sale' | 'install' | 'usage' | 'payout' | 'adjustment';

export interface LedgerEntry {
  id: string;
  ts: number;
  creator: string;
  kind: LedgerKind;
  /** Signed integer USD cents. */
  amountCents: number;
  entryId: string | null;
  note: string | null;
}

export interface CreatorSummary {
  creator: string;
  installs: number;
  usageTokens: number;
  /** Net USD cents across all ledger entries. */
  balanceCents: number;
  salesCents: number;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveCreatorShare(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARKETPLACE_CREATOR_SHARE;
  if (raw === undefined || raw === '') return 0.7;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`MARKETPLACE_CREATOR_SHARE must be a number between 0 and 1 (got ${raw})`);
  }
  return v;
}

export class RevenueLedger {
  private readonly db: DatabaseSyncType;
  private readonly creatorShare: number;

  constructor(dbPath: string, creatorShare?: number) {
    this.db = openDb(dbPath);
    this.creatorShare = creatorShare ?? resolveCreatorShare();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS marketplace_installs (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        creator TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        entry_kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS marketplace_usage (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        creator TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        tokens INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revenue_ledger (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        creator TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        entry_id TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_installs_creator ON marketplace_installs (creator);
      CREATE INDEX IF NOT EXISTS idx_usage_creator ON marketplace_usage (creator);
      CREATE INDEX IF NOT EXISTS idx_ledger_creator ON revenue_ledger (creator);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Record that someone installed a creator's entry (non-monetary event). */
  recordInstall(creator: string, entryId: string, entryKind: string): void {
    this.db
      .prepare(
        `INSERT INTO marketplace_installs (id, ts, creator, entry_id, entry_kind)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId('ins'), Date.now(), creator, entryId, entryKind);
  }

  /** Record token usage attributed to a creator's entry. */
  recordUsage(creator: string, entryId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error('tokens must be a non-negative number');
    this.db
      .prepare(
        `INSERT INTO marketplace_usage (id, ts, creator, entry_id, tokens)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId('use'), Date.now(), creator, entryId, Math.floor(tokens));
  }

  /**
   * Credit a paid sale of a creator's entry. Splits `amountCents` into a
   * creator credit (creatorShare) and a platform credit (1 - creatorShare).
   * Returns { creatorCents, platformCents }.
   */
  creditSale(opts: {
    creator: string;
    entryId: string;
    amountCents: number;
    note?: string;
  }): { creatorCents: number; platformCents: number } {
    const { creator, entryId, amountCents } = opts;
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      throw new Error('amountCents must be a non-negative integer');
    }
    const creatorCents = Math.round(amountCents * this.creatorShare);
    const platformCents = amountCents - creatorCents;
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO revenue_ledger (id, ts, creator, kind, amount_cents, entry_id, note)
       VALUES (?, ?, ?, 'sale', ?, ?, ?)`,
    );
    insert.run(newId('led'), now, creator, creatorCents, entryId, opts.note ?? `sale of ${entryId}`);
    insert.run(newId('led'), now, '__platform__', platformCents, entryId, `platform share of ${entryId}`);
    return { creatorCents, platformCents };
  }

  /** Record a payout to a creator (negative amount). */
  recordPayout(creator: string, amountCents: number, note?: string): LedgerEntry {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('payout amountCents must be a positive integer');
    }
    const entry: LedgerEntry = {
      id: newId('led'),
      ts: Date.now(),
      creator,
      kind: 'payout',
      amountCents: -amountCents,
      entryId: null,
      note: note ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO revenue_ledger (id, ts, creator, kind, amount_cents, entry_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.ts, entry.creator, entry.kind, entry.amountCents, entry.entryId, entry.note);
    return entry;
  }

  creatorSummary(creator: string): CreatorSummary {
    const installs = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM marketplace_installs WHERE creator = ?`)
        .get(creator) as { n: number }
    ).n;
    const tokens = (
      this.db
        .prepare(`SELECT COALESCE(SUM(tokens), 0) AS t FROM marketplace_usage WHERE creator = ?`)
        .get(creator) as { t: number }
    ).t;
    const money = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS bal,
                COALESCE(SUM(CASE WHEN kind = 'sale' THEN amount_cents ELSE 0 END), 0) AS sales
         FROM revenue_ledger WHERE creator = ?`,
      )
      .get(creator) as { bal: number; sales: number };
    return {
      creator,
      installs,
      usageTokens: tokens,
      balanceCents: money.bal,
      salesCents: money.sales,
    };
  }

  listCreators(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT creator FROM (
           SELECT creator FROM marketplace_installs
           UNION SELECT creator FROM marketplace_usage
           UNION SELECT creator FROM revenue_ledger
         ) WHERE creator != '__platform__' ORDER BY creator`,
      )
      .all() as Array<{ creator: string }>;
    return rows.map((r) => r.creator);
  }

  ledgerFor(creator: string, limit = 100): LedgerEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, creator, kind, amount_cents, entry_id, note
         FROM revenue_ledger WHERE creator = ? ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(creator, limit) as Array<{
      id: string;
      ts: number;
      creator: string;
      kind: string;
      amount_cents: number;
      entry_id: string | null;
      note: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      creator: r.creator,
      kind: r.kind as LedgerKind,
      amountCents: r.amount_cents,
      entryId: r.entry_id,
      note: r.note,
    }));
  }

  /** Net platform earnings across all sales (the '__platform__' bucket). */
  platformEarningsCents(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS bal FROM revenue_ledger WHERE creator = '__platform__'`)
      .get() as { bal: number };
    return row.bal;
  }
}
