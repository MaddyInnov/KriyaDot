// SPDX-License-Identifier: Apache-2.0
// Tests for the shared SQLite opener (src/sqlite.ts). Fully offline.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, SQLITE_BUSY_TIMEOUT_MS } from '../src/sqlite.js';

describe('openDb', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('applies WAL, busy_timeout and synchronous=NORMAL pragmas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-test-'));
    dirs.push(dir);
    const db = openDb(join(dir, 't.db'));
    try {
      const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
      expect(mode.toLowerCase()).toBe('wal');
      const busy = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
      expect(busy).toBe(SQLITE_BUSY_TIMEOUT_MS);
      const sync = (db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
      expect(sync).toBe(1); // NORMAL
      // The database is usable.
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
      expect((db.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('hello');
    } finally {
      db.close();
    }
  });

  it('works on :memory: databases (pragma application is a harmless no-op)', () => {
    const db = openDb(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.prepare('INSERT INTO t DEFAULT VALUES').run();
      expect((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});
