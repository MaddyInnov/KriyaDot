// SPDX-License-Identifier: Apache-2.0
/**
 * Legacy webhook secret hardening (Phase A, item A-1 — the USER DECISION
 * item left open by the 2026-11-25 defect sweep, Cluster D tail).
 *
 * The two legacy inbound webhook surfaces — header-secret routine
 * triggers (webhooks.ts, `routine_webhook_triggers` table) and the
 * per-routine public hook (routine-hooks.ts, `bot_routines.webhook_secret`
 * column) — historically stored their secrets in PLAINTEXT in
 * bot-routines.db, while the newer B5 surface
 * (routine-webhook-inbound.ts) stores only SHA-256 hashes, journals
 * failed auth, and throttles that journal. This module is the shared
 * discipline for the legacy surfaces:
 *
 * HASH-AT-REST: a stored secret is `sha256:<hex>` where <hex> is the
 * SHA-256 hex of the plaintext secret. The prefix matters: legacy
 * plaintext secrets are themselves 64-char hex strings (32 random
 * bytes), so a bare hash would be indistinguishable from a plaintext
 * secret and the migration could not be idempotent. Boot-time
 * migration (migrateLegacyWebhookSecrets, run from bot-routines.ts
 * openDb) rewrites every non-prefixed stored secret in place; new
 * secrets are hashed at creation; a plaintext secret is returned to
 * its owner exactly once (create / rotate), after which only the hash
 * exists and the secret is NOT recoverable.
 *
 * DIRECT AUTH (header / Bearer / URL path): the presented secret is
 * hashed and the digests are compared with crypto.timingSafeEqual
 * against the stored hash — the B5 pattern.
 *
 * HMAC AUTH — COMPATIBILITY BREAK, recorded deliberately: HMAC
 * verification mathematically requires the key, and the stored hash
 * cannot be turned back into the secret. The signing scheme is
 * therefore migrated: the HMAC key is the SHA-256 HEX of the secret
 * (`key = sha256hex(secret)`), which any legitimate sender can derive
 * from the secret they already hold — no new secret is needed. The
 * stored hash hex IS that key, so verification is
 * HMAC(key = storedHashHex, body) compared timing-safe. Signatures
 * produced with the OLD scheme (key = the raw secret) stop verifying
 * at migration; senders re-derive the key from their existing secret.
 *
 * FAILED-AUTH DISCIPLINE (mirrors B5, does not invent a lockout):
 * failures are journalled (source IP + target + reason) into
 * `legacy_webhook_auth_journal`, with journal writes throttled per
 * (IP, target, reason) so the log cannot be flooded, and old rows
 * pruned. Repeated failures from one IP against one target are
 * additionally rate-limited: once an IP exceeds the failure budget in
 * the window, further FAILED attempts from that IP+target answer 429
 * instead of 401 — but a request that AUTHENTICATES is never blocked
 * by the failure limiter, so an attacker spraying bad secrets cannot
 * lock out the legitimate sender (who may share the attacker's IP
 * behind NAT). Token entropy (256-bit secrets) remains the primary
 * guessing defence, exactly as in B5's reasoning.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';

export const LEGACY_SECRET_HASH_PREFIX = 'sha256:';
/** Failed-auth budget per (source IP, target) before failures answer 429. */
export const LEGACY_WEBHOOK_FAILED_AUTH_LIMIT = 20;
export const LEGACY_WEBHOOK_FAILED_AUTH_WINDOW_MS = 60_000;
const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const JOURNAL_THROTTLE_MS = 10_000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Storage form of a secret: `sha256:<hex of the plaintext>`. */
export function hashLegacySecret(plaintext: string): string {
  return LEGACY_SECRET_HASH_PREFIX + sha256Hex(plaintext);
}

export function isHashedLegacySecret(stored: string | null | undefined): stored is string {
  return (
    typeof stored === 'string' &&
    stored.startsWith(LEGACY_SECRET_HASH_PREFIX) &&
    /^[0-9a-f]{64}$/.test(stored.slice(LEGACY_SECRET_HASH_PREFIX.length))
  );
}

/** The stored hash hex (== the migrated HMAC key) for a stored secret. */
export function storedHashHex(stored: string): string | undefined {
  if (isHashedLegacySecret(stored)) return stored.slice(LEGACY_SECRET_HASH_PREFIX.length);
  // Unmigrated legacy plaintext (a DB the migration has not run on yet):
  // its hash hex is still well-defined and lets auth keep working until
  // the boot migration rewrites the row.
  if (stored) return sha256Hex(stored);
  return undefined;
}

/**
 * Timing-safe check of a directly presented secret (header / Bearer /
 * path) against the stored value. Both sides are reduced to fixed-size
 * SHA-256 digests before timingSafeEqual, so neither length nor content
 * leaks through timing.
 */
export function verifyPresentedSecret(presented: string | undefined, stored: string | null | undefined): boolean {
  if (!presented || !stored) return false;
  const expectedHex = storedHashHex(stored);
  if (!expectedHex) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = Buffer.from(expectedHex, 'hex');
  if (b.length !== a.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * The migrated HMAC key for a PLAINTEXT secret the caller holds:
 * sha256hex(secret), used as a UTF-8 string key.
 */
export function hmacKeyForSecret(plaintextSecret: string): string {
  return sha256Hex(plaintextSecret);
}

/** HMAC-SHA256 hex of `body` under the migrated scheme for a plaintext secret. */
export function signWithSecret(body: Buffer, plaintextSecret: string): string {
  return createHmac('sha256', hmacKeyForSecret(plaintextSecret)).update(body).digest('hex');
}

/**
 * Verify a `sha256=<hex>` (or bare hex) signature against a STORED
 * secret value (hashed or unmigrated plaintext). The HMAC key is the
 * stored hash hex — see the scheme note in the module header.
 */
export function verifySignatureAgainstStored(signature: string, body: Buffer, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const key = storedHashHex(stored);
  if (!key) return false;
  const hex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = createHmac('sha256', key).update(body).digest('hex');
  const a = Buffer.from(hex.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Boot-time hash-at-rest migration
// ---------------------------------------------------------------------------

/**
 * Rewrite every plaintext legacy webhook secret in bot-routines.db to
 * its `sha256:` hash form, in place. Covers both legacy stores:
 * `routine_webhook_triggers.secret` and `bot_routines.webhook_secret`.
 * Idempotent: rows already in hash form are untouched, so re-running
 * (every store constructor over the same file does) is a no-op.
 * Returns the number of rows migrated.
 */
export function migrateLegacyWebhookSecrets(db: DatabaseSync): number {
  let migrated = 0;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as Array<{ name: string }>;
  const has = (t: string) => tables.some((r) => r.name === t);
  if (has('routine_webhook_triggers')) {
    const rows = db.prepare('SELECT id, secret FROM routine_webhook_triggers').all() as unknown as Array<{
      id: string;
      secret: string;
    }>;
    const upd = db.prepare('UPDATE routine_webhook_triggers SET secret = ? WHERE id = ?');
    for (const row of rows) {
      if (row.secret && !isHashedLegacySecret(row.secret)) {
        upd.run(hashLegacySecret(row.secret), row.id);
        migrated++;
      }
    }
  }
  if (has('bot_routines')) {
    const cols = db.prepare('PRAGMA table_info(bot_routines)').all() as unknown as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'webhook_secret')) {
      const rows = db.prepare('SELECT id, webhook_secret FROM bot_routines').all() as unknown as Array<{
        id: string;
        webhook_secret: string | null;
      }>;
      const upd = db.prepare('UPDATE bot_routines SET webhook_secret = ? WHERE id = ?');
      for (const row of rows) {
        if (row.webhook_secret && !isHashedLegacySecret(row.webhook_secret)) {
          upd.run(hashLegacySecret(row.webhook_secret), row.id);
          migrated++;
        }
      }
    }
  }
  return migrated;
}

// ---------------------------------------------------------------------------
// Failed-auth journal + failure rate limiter (B5 discipline)
// ---------------------------------------------------------------------------

export interface LegacyAuthJournalEntry {
  id: string;
  sourceIp: string;
  target: string;
  reason: string;
  createdAt: number;
}

export interface LegacyWebhookAuthGuardOptions {
  /** When set, journal rows persist in <dataDir>/bot-routines.db. */
  dataDir?: string;
  maxFailuresPerWindow?: number;
  windowMs?: number;
  now?: () => number;
}

function openJournalDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = openSqliteDb(join(dataDir, 'bot-routines.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_webhook_auth_journal (
      id TEXT PRIMARY KEY,
      source_ip TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_journal_created ON legacy_webhook_auth_journal(created_at);
  `);
  return db;
}

/**
 * Per-surface failed-auth guard: a throttled durable journal plus an
 * in-memory failure rate limiter. One instance per router by default;
 * the host may share one across the legacy surfaces.
 */
export class LegacyWebhookAuthGuard {
  private readonly db: DatabaseSync | null;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;
  private readonly journalThrottle = new Map<string, number>();
  private readonly failures = new Map<string, number[]>();
  private readonly memoryJournal: LegacyAuthJournalEntry[] = [];

  constructor(opts: LegacyWebhookAuthGuardOptions = {}) {
    this.db = opts.dataDir ? openJournalDb(opts.dataDir) : null;
    this.maxFailures = opts.maxFailuresPerWindow ?? LEGACY_WEBHOOK_FAILED_AUTH_LIMIT;
    this.windowMs = opts.windowMs ?? LEGACY_WEBHOOK_FAILED_AUTH_WINDOW_MS;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  private failureKey(sourceIp: string, target: string): string {
    return `${sourceIp}|${target}`;
  }

  /** True when this (IP, target) has exhausted its failure budget. Only
   *  consulted on the failure path — successful auth is never blocked. */
  failureRateLimited(sourceIp: string, target: string, now?: number): boolean {
    const at = now ?? this.nowFn();
    const list = this.failures.get(this.failureKey(sourceIp, target)) ?? [];
    const fresh = list.filter((t) => at - t < this.windowMs);
    if (fresh.length !== list.length) this.failures.set(this.failureKey(sourceIp, target), fresh);
    return fresh.length >= this.maxFailures;
  }

  /**
   * Record a failed-auth attempt: counts toward the failure rate limit
   * and journals the attempt (journal writes throttled per
   * (IP, target, reason), B5-style). Returns { journaled, rateLimited }
   * where rateLimited describes the state AFTER this failure.
   */
  recordFailedAuth(input: { sourceIp: string; target: string; reason: string; now?: number }): {
    journaled: boolean;
    rateLimited: boolean;
  } {
    const now = input.now ?? this.nowFn();
    const key = this.failureKey(input.sourceIp, input.target);
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.failures.set(key, list);
    if (this.failures.size > 4096) this.failures.clear();

    let journaled = false;
    const throttleKey = `${key}|${input.reason}`;
    const last = this.journalThrottle.get(throttleKey) ?? 0;
    if (now - last >= JOURNAL_THROTTLE_MS) {
      this.journalThrottle.set(throttleKey, now);
      if (this.journalThrottle.size > 4096) this.journalThrottle.clear();
      const entry: LegacyAuthJournalEntry = {
        id: randomUUID(),
        sourceIp: input.sourceIp.slice(0, 128),
        target: input.target.slice(0, 128),
        reason: input.reason.slice(0, 64),
        createdAt: now,
      };
      if (this.db) {
        this.db.prepare('DELETE FROM legacy_webhook_auth_journal WHERE created_at < ?').run(now - JOURNAL_RETENTION_MS);
        this.db
          .prepare('INSERT INTO legacy_webhook_auth_journal (id, source_ip, target, reason, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(entry.id, entry.sourceIp, entry.target, entry.reason, entry.createdAt);
      } else {
        this.memoryJournal.push(entry);
        if (this.memoryJournal.length > 500) this.memoryJournal.splice(0, this.memoryJournal.length - 500);
      }
      journaled = true;
    }
    return { journaled, rateLimited: list.length >= this.maxFailures };
  }

  listAuthJournal(limit = 50): LegacyAuthJournalEntry[] {
    const capped = Math.max(1, Math.min(500, limit));
    if (this.db) {
      const rows = this.db
        .prepare('SELECT * FROM legacy_webhook_auth_journal ORDER BY created_at DESC LIMIT ?')
        .all(capped) as unknown as Array<{
          id: string; source_ip: string; target: string; reason: string; created_at: number;
        }>;
      return rows.map((r) => ({ id: r.id, sourceIp: r.source_ip, target: r.target, reason: r.reason, createdAt: r.created_at }));
    }
    return this.memoryJournal.slice(-capped).reverse();
  }

  close(): void {
    this.db?.close();
  }
}

/** Source IP for journal/limiter keys, B5-style. */
export function legacySourceIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return (req.ip ?? req.socket?.remoteAddress ?? '').slice(0, 128);
}
