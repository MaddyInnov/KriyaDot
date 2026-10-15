// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DatabaseRowStore,
  DatabaseStore,
  parseCsv,
  registerDatabasesRoutes,
} from '../src/databases.js';

const COLUMNS = [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'priority', name: 'Priority', type: 'select', options: ['low', 'high'] },
  { id: 'estimate', name: 'Estimate', type: 'number' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'done', name: 'Done', type: 'checkbox' },
] as const;

function makeDb(dir: string) {
  const store = new DatabaseStore(dir);
  const db = store.create({ name: 'Tasks', description: 'work', columns: COLUMNS });
  return { store, rows: new DatabaseRowStore(dir, store), db };
}

describe('DatabaseStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'databases-'));
  });

  it('creates, lists, gets, updates, and deletes databases', () => {
    const { store, db } = makeDb(dir);
    expect(db.name).toBe('Tasks');
    expect(db.columns).toHaveLength(5);
    expect(db.rowCount).toBe(0);

    // Persistence across instances (same dataDir → same databases.db).
    const reopened = new DatabaseStore(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(db.id)?.name).toBe('Tasks');

    const updated = reopened.update(db.id, { description: 'updated' });
    expect(updated.description).toBe('updated');

    reopened.remove(db.id);
    expect(reopened.get(db.id)).toBeUndefined();
    expect(reopened.list()).toEqual([]);
  });

  it('rejects invalid database input', () => {
    const store = new DatabaseStore(dir);
    expect(() => store.create({ name: '   ', columns: COLUMNS })).toThrow(/name/);
    expect(() => store.create({ name: 'x', columns: [] })).toThrow(/columns/);
    expect(() =>
      store.create({ name: 'x', columns: [{ id: 'a', name: 'A', type: 'bogus' }] }),
    ).toThrow(/type/);
    expect(() =>
      store.create({
        name: 'x',
        columns: [
          { id: 'a', name: 'A', type: 'text' },
          { id: 'a', name: 'B', type: 'text' },
        ],
      }),
    ).toThrow(/duplicate column id/);
    expect(() => store.update('missing', { name: 'y' })).toThrow(/unknown database/);
    expect(() => store.remove('missing')).toThrow(/unknown database/);
  });

  it('prunes row values when columns are removed', () => {
    const { store, rows, db } = makeDb(dir);
    const row = rows.create(db.id, { values: { title: 'a', estimate: 3 } });
    store.update(db.id, {
      columns: [
        { id: 'title', name: 'Title', type: 'text' },
        { id: 'priority', name: 'Priority', type: 'select' },
      ],
    });
    expect(rows.get(db.id, row.id)?.values).toEqual({ title: 'a' });
    expect(store.get(db.id)?.columns).toHaveLength(2);
  });
});

describe('DatabaseRowStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbrows-'));
  });

  it('creates, gets, updates, and deletes rows with type coercion', () => {
    const { rows, db } = makeDb(dir);
    const row = rows.create(db.id, {
      values: { title: 'Ship it', estimate: '3', done: 'yes', due: '2026-10-20' },
    });
    expect(row.values.estimate).toBe(3);
    expect(row.values.done).toBe(true);
    expect(row.values.due).toBe('2026-10-20');

    const patched = rows.update(db.id, row.id, { values: { done: false } });
    expect(patched.values.done).toBe(false);
    expect(patched.values.title).toBe('Ship it');

    rows.remove(db.id, row.id);
    expect(rows.get(db.id, row.id)).toBeUndefined();
    expect(() => rows.remove(db.id, row.id)).toThrow(/unknown row/);
  });

  it('auto-extends select options (Notion-like) and rejects bad cells', () => {
    const { store, rows, db } = makeDb(dir);
    const row = rows.create(db.id, { values: { priority: 'urgent' } });
    expect(row.values.priority).toBe('urgent');
    // The new option was persisted on the column.
    const refreshed = store.get(db.id)!;
    expect(refreshed.columns.find((c) => c.id === 'priority')?.options).toContain('urgent');

    expect(() => rows.create(db.id, { values: { estimate: 'not-a-number' } })).toThrow(/number/);
    expect(() => rows.create(db.id, { values: { due: '20/10/2026' } })).toThrow(/YYYY-MM-DD/);
    expect(() => rows.create(db.id, { values: { nope: 'x' } })).toThrow(/unknown column/);
  });

  it('sorts and filters rows', () => {
    const { rows, db } = makeDb(dir);
    rows.create(db.id, { values: { title: 'b task', estimate: 5, priority: 'low' } });
    rows.create(db.id, { values: { title: 'a task', estimate: 1, priority: 'high' } });
    rows.create(db.id, { values: { title: 'c task', estimate: 3, priority: 'high', done: true } });

    const byEstimate = rows.list(db.id, { sort: 'estimate:asc' });
    expect(byEstimate.map((r) => r.values.title)).toEqual(['a task', 'c task', 'b task']);

    const byTitleDesc = rows.list(db.id, { sort: 'title:desc' });
    expect(byTitleDesc.map((r) => r.values.title)).toEqual(['c task', 'b task', 'a task']);

    const high = rows.list(db.id, { columnFilters: { priority: 'high' } });
    expect(high).toHaveLength(2);

    const done = rows.list(db.id, { columnFilters: { done: 'true' } });
    expect(done).toHaveLength(1);

    const q = rows.list(db.id, { q: 'task b' });
    expect(q).toHaveLength(1);
    expect(q[0].values.title).toBe('b task');
  });

  it('imports CSV rows matching headers to columns', () => {
    const { store, rows, db } = makeDb(dir);
    const csv = 'Title,Estimate,Done,Unknown\nAlpha,2,true,x\nBeta,oops,no,y\n';
    const { imported, skipped } = rows.importCsv(db.id, csv);
    expect(imported).toBe(2);
    expect(skipped).toBe(1); // "oops" is not a number
    expect(store.rowCount(db.id)).toBe(2);
    const all = rows.list(db.id);
    expect(all[0].values.title).toBe('Alpha');
    expect(all[0].values.estimate).toBe(2);
    expect(all[0].values.done).toBe(true);
    expect(all[1].values.estimate).toBeNull();
  });
});

describe('parseCsv', () => {
  it('handles quotes, commas, and CRLF', () => {
    const rows = parseCsv('a,"b,c"\r\n"d""e",f\n');
    expect(rows).toEqual([
      ['a', 'b,c'],
      ['d"e', 'f'],
    ]);
  });
});

describe('databases HTTP routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof express>['listen']>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dbhttp-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerDatabasesRoutes(router, { dataDir: dir });
    app.use('/databases', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/databases`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const req = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  it('runs the full CRUD + rows + CSV lifecycle over HTTP', async () => {
    const created = await req('POST', '/', {
      name: 'Projects',
      columns: [
        { id: 'name', name: 'Name', type: 'text' },
        { id: 'status', name: 'Status', type: 'select', options: ['todo', 'done'] },
      ],
    });
    expect(created.status).toBe(201);
    const db = created.json as { id: string };

    const list = await req('GET', '/');
    expect(list.status).toBe(200);
    expect((list.json as unknown[])).toHaveLength(1);

    const bad = await req('POST', '/', { name: 'x', columns: [] });
    expect(bad.status).toBe(400);

    const row = await req('POST', `/${db.id}/rows`, { values: { name: 'KriyaDot', status: 'todo' } });
    expect(row.status).toBe(201);
    const rowId = (row.json as { id: string }).id;

    const sorted = await req('GET', `/${db.id}/rows?sort=name:asc&q=kriyadot`);
    expect(sorted.status).toBe(200);
    expect((sorted.json as unknown[])).toHaveLength(1);

    const patched = await req('PUT', `/${db.id}/rows/${rowId}`, { values: { status: 'done' } });
    expect(patched.status).toBe(200);
    expect((patched.json as { values: Record<string, unknown> }).values.status).toBe('done');

    const csv = await req('POST', `/${db.id}/import-csv`, { csv: 'Name,Status\nSecond,wip\n' });
    expect(csv.status).toBe(201);
    expect((csv.json as { imported: number }).imported).toBe(1);
    // "wip" was auto-added as a select option.
    const after = await req('GET', `/${db.id}`);
    const statusCol = ((after.json as { columns: Array<{ id: string; options?: string[] }> }).columns).find(
      (c) => c.id === 'status',
    );
    expect(statusCol?.options).toContain('wip');

    const del = await req('DELETE', `/${db.id}/rows/${rowId}`);
    expect(del.status).toBe(200);

    const missing = await req('GET', '/nope/rows');
    expect(missing.status).toBe(404);

    const delDb = await req('DELETE', `/${db.id}`);
    expect(delDb.status).toBe(200);
  });
});
