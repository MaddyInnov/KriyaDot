// SPDX-License-Identifier: Apache-2.0
// Notion-style Databases — the signature Notion surface: a database is a
// page-like object with a typed schema (columns: text / number / select /
// date / checkbox) whose records are stored as child rows. Backed by SQLite
// (`databases.db` under the data dir), zero paid APIs.
//
// Mount at boot, e.g.:
//   import { registerDatabasesRoutes } from './databases.js';
//   const databasesRouter = express.Router();
//   registerDatabasesRoutes(databasesRouter, { dataDir: config.dataDir });
//   router.use('/databases', databasesRouter);
//
// Routes (router mounted at /api/databases):
//   GET    /                        → Database[] (each with rowCount)
//   POST   /                        → { name, description?, columns } → Database (201)
//   GET    /:id                     → Database
//   PUT    /:id                     → { name?, description?, columns? } → Database
//   DELETE /:id                     → { ok: true }
//   GET    /:id/rows                → DatabaseRow[]  (?sort=colId:asc|desc, ?q=, ?col_<colId>=value)
//   POST   /:id/rows                → { values } → DatabaseRow (201)
//   GET    /:id/rows/:rowId         → DatabaseRow
//   PUT    /:id/rows/:rowId         → { values } → DatabaseRow (merged)
//   DELETE /:id/rows/:rowId         → { ok: true }
//   POST   /:id/import-csv          → { csv, hasHeader? } → { rows: DatabaseRow[], skipped: number }

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';

import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DatabaseColumnType = 'text' | 'number' | 'select' | 'date' | 'checkbox';

export interface DatabaseColumn {
  id: string;
  name: string;
  type: DatabaseColumnType;
  /** Allowed values for select columns. Auto-extended on write (Notion-like). */
  options?: string[];
}

export interface Database {
  id: string;
  name: string;
  description: string;
  columns: DatabaseColumn[];
  createdAt: number;
  updatedAt: number;
  /** Present on list responses. */
  rowCount?: number;
}

/** A cell value. Dates are ISO strings (YYYY-MM-DD); null = empty cell. */
export type CellValue = string | number | boolean | null;

export interface DatabaseRow {
  id: string;
  databaseId: string;
  /** Keyed by column id. */
  values: Record<string, CellValue>;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// SQLite storage
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notion_databases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    schema_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notion_database_rows (
    id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL,
    values_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_db_rows_db ON notion_database_rows(database_id, created_at ASC);
`;

function openDb(dataDir: string): DatabaseSync {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db = openSqliteDb(join(dataDir, 'databases.db'));
  db.exec(SCHEMA);
  return db;
}

interface DbRow {
  id: string;
  name: string;
  description: string;
  schema_json: string;
  created_at: number;
  updated_at: number;
}

interface RowRow {
  id: string;
  database_id: string;
  values_json: string;
  created_at: number;
  updated_at: number;
}

function parseColumns(raw: string): DatabaseColumn[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isDatabaseColumn) : [];
  } catch {
    return [];
  }
}

function parseValues(raw: string): Record<string, CellValue> {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, CellValue> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof k === 'string' && isCellValue(val)) out[k] = val;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

// ---------------------------------------------------------------------------
// Validation & coercion
// ---------------------------------------------------------------------------

const COLUMN_TYPES: DatabaseColumnType[] = ['text', 'number', 'select', 'date', 'checkbox'];
const NAME_MAX = 200;
const DESC_MAX = 2000;
const COLUMNS_MAX = 100;
const OPTIONS_MAX = 100;
const OPTION_MAX = 100;
const ROWS_MAX = 50000;

function isCellValue(v: unknown): v is CellValue {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isDatabaseColumn(v: unknown): v is DatabaseColumn {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.name === 'string' &&
    o.name.trim().length > 0 &&
    typeof o.type === 'string' &&
    (COLUMN_TYPES as string[]).includes(o.type) &&
    (o.options === undefined ||
      (Array.isArray(o.options) &&
        o.options.every((x) => typeof x === 'string' && x.length <= OPTION_MAX)))
  );
}

function requireName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX) {
    throw validationError('database "name" must be a non-empty string (max 200 chars)');
  }
  return name.trim();
}

function requireColumns(input: unknown): DatabaseColumn[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw validationError('database "columns" must be a non-empty array');
  }
  if (input.length > COLUMNS_MAX) {
    throw validationError(`database supports at most ${COLUMNS_MAX} columns`);
  }
  const seen = new Set<string>();
  const cols: DatabaseColumn[] = [];
  for (const raw of input) {
    if (!isDatabaseColumn(raw)) {
      throw validationError(
        'each column needs { id, name, type: text|number|select|date|checkbox, options? }',
      );
    }
    if (seen.has(raw.id)) throw validationError(`duplicate column id: ${raw.id}`);
    seen.add(raw.id);
    const col: DatabaseColumn = {
      id: raw.id,
      name: raw.name.trim().slice(0, 100),
      type: raw.type,
    };
    if (raw.type === 'select') {
      const opts = (raw.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (opts.length > OPTIONS_MAX) throw validationError('select column supports at most 100 options');
      col.options = [...new Set(opts)];
    }
    cols.push(col);
  }
  return cols;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce a raw cell value to a column's type. Returns the coerced value or
 * null for empty. Throws a validation error on uncoercible input.
 * Select columns auto-extend their option list (Notion-like); the caller
 * persists the updated column set via onSelectOptionAdded.
 */
export function coerceCell(
  column: DatabaseColumn,
  raw: unknown,
  onSelectOptionAdded?: (option: string) => void,
): CellValue {
  if (raw === null || raw === undefined) return null;
  switch (column.type) {
    case 'text': {
      const s = String(raw);
      return s.length > 10000 ? s.slice(0, 10000) : s;
    }
    case 'number': {
      if (typeof raw === 'boolean') throw validationError(`column "${column.name}" expects a number`);
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
      if (!Number.isFinite(n)) throw validationError(`column "${column.name}" expects a number`);
      return n;
    }
    case 'select': {
      const s = String(raw).trim();
      if (!s) return null;
      if (s.length > OPTION_MAX) throw validationError(`select value too long (max ${OPTION_MAX})`);
      if (!(column.options ?? []).includes(s)) onSelectOptionAdded?.(s);
      return s;
    }
    case 'date': {
      const s = String(raw).trim();
      if (!s) return null;
      if (!DATE_PATTERN.test(s)) {
        throw validationError(`column "${column.name}" expects a date as YYYY-MM-DD`);
      }
      const d = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw validationError(`column "${column.name}" is not a real date`);
      return s;
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on', 'checked'].includes(s)) return true;
      if (['false', '0', 'no', 'n', 'off', ''].includes(s)) return false;
      throw validationError(`column "${column.name}" expects a boolean`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export class DatabaseStore {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  list(): Database[] {
    const rows = this.db
      .prepare('SELECT * FROM notion_databases ORDER BY updated_at DESC')
      .all() as unknown as DbRow[];
    return rows.map((r) => this.toDatabase(r));
  }

  get(id: string): Database | undefined {
    const row = this.db.prepare('SELECT * FROM notion_databases WHERE id = ?').get(id) as unknown as
      | DbRow
      | undefined;
    return row ? this.toDatabase(row) : undefined;
  }

  create(input: { name: string; description?: string; columns: unknown }): Database {
    const name = requireName(input.name);
    const columns = requireColumns(input.columns);
    const description = typeof input.description === 'string' ? input.description.slice(0, DESC_MAX) : '';
    const now = Date.now();
    const db: Database = {
      id: randomUUID(),
      name,
      description,
      columns,
      createdAt: now,
      updatedAt: now,
      rowCount: 0,
    };
    this.db
      .prepare(
        'INSERT INTO notion_databases (id, name, description, schema_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(db.id, db.name, db.description, JSON.stringify(columns), db.createdAt, db.updatedAt);
    return db;
  }

  /**
   * Update name/description/schema. When the schema changes, row values for
   * removed columns are pruned (inside a transaction).
   */
  update(
    id: string,
    input: { name?: unknown; description?: unknown; columns?: unknown },
  ): Database {
    const current = this.get(id);
    if (!current) throw dbNotFound(id);
    const name = input.name === undefined ? current.name : requireName(input.name);
    const description =
      input.description === undefined
        ? current.description
        : typeof input.description === 'string'
          ? input.description.slice(0, DESC_MAX)
          : '';
    const columns = input.columns === undefined ? current.columns : requireColumns(input.columns);
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('UPDATE notion_databases SET name = ?, description = ?, schema_json = ?, updated_at = ? WHERE id = ?')
        .run(name, description, JSON.stringify(columns), updatedAt, id);
      const keep = new Set(columns.map((c) => c.id));
      if (keep.size !== current.columns.length || columns.some((c) => !keep.has(c.id))) {
        // Schema membership changed → prune values of removed columns.
        const rows = this.db
          .prepare('SELECT id, values_json FROM notion_database_rows WHERE database_id = ?')
          .all(id) as unknown as Array<{ id: string; values_json: string }>;
        const upd = this.db.prepare('UPDATE notion_database_rows SET values_json = ? WHERE id = ?');
        for (const r of rows) {
          const vals = parseValues(r.values_json);
          let changed = false;
          for (const k of Object.keys(vals)) {
            if (!keep.has(k)) {
              delete vals[k];
              changed = true;
            }
          }
          if (changed) upd.run(JSON.stringify(vals), r.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // rollback itself failed; original error is what matters
      }
      throw err;
    }
    const next = this.get(id);
    if (!next) throw dbNotFound(id);
    return next;
  }

  remove(id: string): void {
    const current = this.get(id);
    if (!current) throw dbNotFound(id);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM notion_database_rows WHERE database_id = ?').run(id);
      this.db.prepare('DELETE FROM notion_databases WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // rollback itself failed; original error is what matters
      }
      throw err;
    }
  }

  rowCount(id: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM notion_database_rows WHERE database_id = ?')
      .get(id) as unknown as { n: number };
    return row.n;
  }

  /** Persist an extended select option list (auto-created options). */
  saveColumns(id: string, columns: DatabaseColumn[]): void {
    this.db.prepare('UPDATE notion_databases SET schema_json = ? WHERE id = ?').run(JSON.stringify(columns), id);
  }

  private toDatabase(r: DbRow): Database {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      columns: parseColumns(r.schema_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      rowCount: this.rowCount(r.id),
    };
  }
}

export interface RowQuery {
  sort?: string;
  q?: string;
  columnFilters?: Record<string, string>;
}

export class DatabaseRowStore {
  protected readonly db: DatabaseSync;
  private readonly databases: DatabaseStore;

  constructor(dataDir: string, databases?: DatabaseStore) {
    this.db = openDb(dataDir);
    this.databases = databases ?? new DatabaseStore(dataDir);
  }

  list(databaseId: string, query: RowQuery = {}): DatabaseRow[] {
    const db = this.databases.get(databaseId);
    if (!db) throw dbNotFound(databaseId);
    const rows = this.db
      .prepare('SELECT * FROM notion_database_rows WHERE database_id = ? ORDER BY created_at ASC')
      .all(databaseId) as unknown as RowRow[];
    let out = rows.map((r) => this.toRow(r));
    // Column equality filters: ?col_<columnId>=value
    if (query.columnFilters) {
      for (const [colId, want] of Object.entries(query.columnFilters)) {
        const col = db.columns.find((c) => c.id === colId);
        if (!col) continue;
        const norm = want.trim().toLowerCase();
        out = out.filter((r) => {
          const v = r.values[colId];
          if (col.type === 'checkbox') {
            return String(!!v).toLowerCase() === norm || (norm === '1' && v === true) || (norm === '0' && v === false);
          }
          return v !== null && String(v).toLowerCase() === norm;
        });
      }
    }
    // Free-text search across all cells.
    if (query.q && query.q.trim()) {
      const terms = query.q.trim().toLowerCase().split(/\s+/);
      out = out.filter((r) =>
        terms.every((t) =>
          Object.values(r.values).some((v) => v !== null && String(v).toLowerCase().includes(t)),
        ),
      );
    }
    // Sorting.
    if (query.sort) {
      const m = /^(.+?):(asc|desc)$/.exec(query.sort);
      const col = m ? db.columns.find((c) => c.id === m[1]) : undefined;
      if (col) {
        const dir = m![2] === 'desc' ? -1 : 1;
        out = [...out].sort((a, b) => compareCells(col, a.values[col.id] ?? null, b.values[col.id] ?? null) * dir);
      }
    }
    return out;
  }

  get(databaseId: string, rowId: string): DatabaseRow | undefined {
    if (!this.databases.get(databaseId)) throw dbNotFound(databaseId);
    const row = this.db
      .prepare('SELECT * FROM notion_database_rows WHERE database_id = ? AND id = ?')
      .get(databaseId, rowId) as unknown as RowRow | undefined;
    return row ? this.toRow(row) : undefined;
  }

  create(databaseId: string, input: { values?: unknown }): DatabaseRow {
    const db = this.databases.get(databaseId);
    if (!db) throw dbNotFound(databaseId);
    if (this.databases.rowCount(databaseId) >= ROWS_MAX) {
      throw validationError(`database supports at most ${ROWS_MAX} rows`);
    }
    const values = this.coerceValues(db, input.values);
    const now = Date.now();
    const row: DatabaseRow = {
      id: randomUUID(),
      databaseId,
      values,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO notion_database_rows (id, database_id, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, row.databaseId, JSON.stringify(values), row.createdAt, row.updatedAt);
    return row;
  }

  /** Merge new values into the existing row (unknown/removed columns pruned). */
  update(databaseId: string, rowId: string, input: { values?: unknown }): DatabaseRow {
    const db = this.databases.get(databaseId);
    if (!db) throw dbNotFound(databaseId);
    const current = this.get(databaseId, rowId);
    if (!current) throw rowNotFound(rowId);
    const patch = this.coerceValues(db, input.values);
    const values = { ...current.values, ...patch };
    const keep = new Set(db.columns.map((c) => c.id));
    for (const k of Object.keys(values)) if (!keep.has(k)) delete values[k];
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
    this.db
      .prepare('UPDATE notion_database_rows SET values_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(values), updatedAt, rowId);
    const next = this.get(databaseId, rowId);
    if (!next) throw rowNotFound(rowId);
    return next;
  }

  remove(databaseId: string, rowId: string): void {
    if (!this.databases.get(databaseId)) throw dbNotFound(databaseId);
    const r = this.db
      .prepare('DELETE FROM notion_database_rows WHERE database_id = ? AND id = ?')
      .run(databaseId, rowId);
    if (r.changes === 0) throw rowNotFound(rowId);
  }

  /**
   * Import rows from CSV text (e.g. a Notion database CSV export).
   * Header names match column *names* (case-insensitive); unknown headers
   * are skipped. Cells that fail coercion become null and are counted.
   */
  importCsv(
    databaseId: string,
    csv: string,
    hasHeader = true,
  ): { rows: DatabaseRow[]; imported: number; skipped: number } {
    const db = this.databases.get(databaseId);
    if (!db) throw dbNotFound(databaseId);
    const records = parseCsv(csv);
    if (records.length === 0) return { rows: [], imported: 0, skipped: 0 };
    const header = hasHeader ? records[0] : records[0].map((_, i) => `Column ${i + 1}`);
    const data = hasHeader ? records.slice(1) : records;
    const byName = new Map(db.columns.map((c) => [c.name.toLowerCase(), c]));
    const mapping: Array<DatabaseColumn | null> = header.map((h) => byName.get(h.trim().toLowerCase()) ?? null);
    const rows: DatabaseRow[] = [];
    let skipped = 0;
    for (const rec of data) {
      if (rec.every((c) => !c.trim())) continue; // blank line
      const values: Record<string, CellValue> = {};
      for (let i = 0; i < mapping.length; i++) {
        const col = mapping[i];
        if (!col) continue;
        const cell = rec[i] ?? '';
        if (!cell.trim()) continue;
        try {
          values[col.id] = coerceCell(col, cell, (opt) => this.addSelectOption(db, col, opt));
        } catch {
          skipped++;
          values[col.id] = null;
        }
      }
      rows.push(this.create(databaseId, { values }));
    }
    return { rows, imported: rows.length, skipped };
  }

  /** Coerce a raw values object against the schema (unknown keys rejected). */
  private coerceValues(db: Database, raw: unknown): Record<string, CellValue> {
    const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const byId = new Map(db.columns.map((c) => [c.id, c]));
    const out: Record<string, CellValue> = {};
    for (const [key, val] of Object.entries(obj)) {
      const col = byId.get(key);
      if (!col) throw validationError(`unknown column id: ${key}`);
      out[key] = coerceCell(col, val, (opt) => this.addSelectOption(db, col, opt));
    }
    return out;
  }

  private addSelectOption(db: Database, column: DatabaseColumn, option: string): void {
    if ((column.options ?? []).includes(option)) return;
    column.options = [...(column.options ?? []), option].slice(0, OPTIONS_MAX);
    this.databases.saveColumns(db.id, db.columns);
  }

  private toRow(r: RowRow): DatabaseRow {
    return {
      id: r.id,
      databaseId: r.database_id,
      values: parseValues(r.values_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

function compareCells(col: DatabaseColumn, a: CellValue, b: CellValue): number {
  // Empty cells always sort last.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  switch (col.type) {
    case 'number':
      return (a as number) - (b as number);
    case 'date':
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    case 'checkbox':
      return Number(!!a) - Number(!!b);
    default:
      return String(a).localeCompare(String(b));
  }
}

/** Minimal RFC-4180-ish CSV parser: quotes, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      pushField();
      i++;
    } else if (ch === '\r') {
      i++;
    } else if (ch === '\n') {
      pushRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  pushRow();
  // Drop the trailing empty row produced by a final newline.
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface DatabasesDeps {
  dataDir: string;
  /** Optional pre-built stores (tests). */
  databaseStore?: DatabaseStore;
  rowStore?: DatabaseRowStore;
}

export function registerDatabasesRoutes(router: Router, deps: DatabasesDeps): void {
  const databases = deps.databaseStore ?? new DatabaseStore(deps.dataDir);
  const rows = deps.rowStore ?? new DatabaseRowStore(deps.dataDir, databases);

  const ok = <T>(res: Response, body: T, status = 200): void => {
    res.status(status).json(body);
  };
  const fail = (res: Response, err: unknown, fallback: string): void => {
    const message = errMessage(err, fallback);
    res.status(isNotFoundError(err) ? 404 : isValidationError(err) ? 400 : 500).json({ error: message });
  };

  // ---- Databases ------------------------------------------------------------
  router.get('/', (_req: Request, res: Response) => {
    try {
      ok(res, databases.list());
    } catch (err) {
      fail(res, err, 'failed to list databases');
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; columns?: unknown };
      ok(
        res,
        databases.create({ name: body.name as string, description: body.description as string | undefined, columns: body.columns }),
        201,
      );
    } catch (err) {
      fail(res, err, 'failed to create database');
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    const db = databases.get(req.params.id);
    if (!db) {
      res.status(404).json({ error: `unknown database: ${req.params.id}` });
      return;
    }
    ok(res, db);
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; columns?: unknown };
      ok(res, databases.update(req.params.id, body));
    } catch (err) {
      fail(res, err, 'failed to update database');
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      databases.remove(req.params.id);
      ok(res, { ok: true });
    } catch (err) {
      fail(res, err, 'failed to delete database');
    }
  });

  // ---- Rows ------------------------------------------------------------------
  router.get('/:id/rows', (req: Request, res: Response) => {
    try {
      const columnFilters: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (k.startsWith('col_') && typeof v === 'string') columnFilters[k.slice(4)] = v;
      }
      ok(
        res,
        rows.list(req.params.id, {
          sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
          q: typeof req.query.q === 'string' ? req.query.q : undefined,
          columnFilters,
        }),
      );
    } catch (err) {
      fail(res, err, 'failed to list rows');
    }
  });

  router.post('/:id/rows', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { values?: unknown };
      ok(res, rows.create(req.params.id, { values: body.values }), 201);
    } catch (err) {
      fail(res, err, 'failed to create row');
    }
  });

  router.get('/:id/rows/:rowId', (req: Request, res: Response) => {
    try {
      const row = rows.get(req.params.id, req.params.rowId);
      if (!row) {
        res.status(404).json({ error: `unknown row: ${req.params.rowId}` });
        return;
      }
      ok(res, row);
    } catch (err) {
      fail(res, err, 'failed to get row');
    }
  });

  router.put('/:id/rows/:rowId', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { values?: unknown };
      ok(res, rows.update(req.params.id, req.params.rowId, { values: body.values }));
    } catch (err) {
      const message = errMessage(err, 'failed to update row');
      if (isRowNotFoundError(err)) {
        res.status(404).json({ error: message });
        return;
      }
      fail(res, err, message);
    }
  });

  router.delete('/:id/rows/:rowId', (req: Request, res: Response) => {
    try {
      rows.remove(req.params.id, req.params.rowId);
      ok(res, { ok: true });
    } catch (err) {
      const message = errMessage(err, 'failed to delete row');
      if (isRowNotFoundError(err)) {
        res.status(404).json({ error: message });
        return;
      }
      fail(res, err, message);
    }
  });

  // ---- CSV import (Notion database CSV exports) -------------------------------
  router.post('/:id/import-csv', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { csv?: unknown; hasHeader?: unknown };
      if (typeof body.csv !== 'string' || !body.csv.trim()) {
        res.status(400).json({ error: '"csv" must be a non-empty string' });
        return;
      }
      if (body.csv.length > 2_000_000) {
        res.status(400).json({ error: 'CSV payload too large (max 2MB)' });
        return;
      }
      const result = rows.importCsv(
        req.params.id,
        body.csv,
        body.hasHeader === undefined ? true : body.hasHeader === true,
      );
      ok(res, { imported: result.imported, skipped: result.skipped, rows: result.rows }, 201);
    } catch (err) {
      fail(res, err, 'failed to import CSV');
    }
  });
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

const NOT_FOUND_MARK = '__database_not_found__';
const ROW_NOT_FOUND_MARK = '__database_row_not_found__';
const VALIDATION_MARK = '__database_validation__';

function dbNotFound(id: string): Error {
  const err = new Error(`unknown database: ${id}`);
  (err as Error & { code?: string }).code = NOT_FOUND_MARK;
  return err;
}

function rowNotFound(id: string): Error {
  const err = new Error(`unknown row: ${id}`);
  (err as Error & { code?: string }).code = ROW_NOT_FOUND_MARK;
  return err;
}

function validationError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = VALIDATION_MARK;
  return err;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === NOT_FOUND_MARK;
}

function isRowNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === ROW_NOT_FOUND_MARK;
}

function isValidationError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === VALIDATION_MARK;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
