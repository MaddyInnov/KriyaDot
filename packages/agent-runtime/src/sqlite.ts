// SPDX-License-Identifier: Apache-2.0
//
// Shared node:sqlite opener. Every SQLite database in the platform goes
// through openDb() so all of them get the same crash-safety and
// concurrency settings:
//
//   PRAGMA journal_mode = WAL      — readers don't block writers (and the
//                                    DB survives a process kill mid-write)
//   PRAGMA busy_timeout = 5000     — wait up to 5s on a locked page instead
//                                    of throwing SQLITE_BUSY immediately
//   PRAGMA synchronous = NORMAL    — safe under WAL (fsync still happens on
//                                    checkpoint); full fsync-per-commit is
//                                    only needed for journal_mode=DELETE
//
// `node:sqlite` is loaded at runtime via process.getBuiltinModule instead
// of a top-level static import because vitest (Vite 5) cannot statically
// resolve the `node:sqlite` specifier in this repo.

import type { DatabaseSync } from 'node:sqlite';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Open a SQLite database with the platform-standard pragmas applied.
 * Drop-in replacement for `new DatabaseSync(path)`.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSyncImpl(path);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    db.exec('PRAGMA synchronous = NORMAL;');
  } catch {
    // Best-effort: a read-only or otherwise constrained open keeps working,
    // just without the tuned pragmas. (PRAGMA journal_mode=WAL on an
    // :memory: database is a harmless no-op that returns 'memory'.)
  }
  return db;
}
