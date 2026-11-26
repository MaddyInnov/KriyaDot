// SPDX-License-Identifier: Apache-2.0
/**
 * Workflow webhook secret hardening (Phase A, item A-12 — extension of
 * A-1 to the workflow TriggerStore in triggers.ts).
 *
 * DUPLICATION NOTE: this is a deliberate, small duplication of the
 * scheme in apps/api/src/legacy-webhook-secrets.ts. packages/workflows
 * cannot import apps/api code (wrong dependency direction), and no
 * lower-level package that both already depend on (@mvp/agent-runtime,
 * @mvp/governance) carries these helpers, so the scheme is implemented
 * here instead of creating a bad dependency. Keep the two in sync:
 *
 * HASH-AT-REST: a stored secret is `sha256:<hex>` where <hex> is the
 * SHA-256 hex of the plaintext secret. The prefix is load-bearing:
 * legacy plaintext secrets can themselves be hex strings, so a bare
 * hash would be indistinguishable from plaintext and migration could
 * not be idempotent. Open-time migration
 * (migrateWorkflowTriggerSecrets, run from the TriggerStore
 * constructor) rewrites every non-prefixed stored secret in place;
 * new secrets are hashed at creation; a plaintext secret is returned
 * to its owner exactly once (create / rotate), after which only the
 * hash exists and the secret is NOT recoverable.
 *
 * VERIFICATION: the presented secret (`x-webhook-secret` header) is
 * hashed and the digests compared with crypto.timingSafeEqual against
 * the stored hash — the A-1 / B5 pattern.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const WORKFLOW_SECRET_HASH_PREFIX = 'sha256:';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Storage form of a secret: `sha256:<hex of the plaintext>`. */
export function hashWorkflowSecret(plaintext: string): string {
  return WORKFLOW_SECRET_HASH_PREFIX + sha256Hex(plaintext);
}

export function isHashedWorkflowSecret(stored: string | null | undefined): stored is string {
  return (
    typeof stored === 'string' &&
    stored.startsWith(WORKFLOW_SECRET_HASH_PREFIX) &&
    /^[0-9a-f]{64}$/.test(stored.slice(WORKFLOW_SECRET_HASH_PREFIX.length))
  );
}

/** The stored hash hex for a stored secret (hashed or unmigrated plaintext). */
export function storedHashHex(stored: string): string | undefined {
  if (isHashedWorkflowSecret(stored)) return stored.slice(WORKFLOW_SECRET_HASH_PREFIX.length);
  if (stored) return sha256Hex(stored);
  return undefined;
}

/**
 * Timing-safe check of a directly presented secret against the stored
 * value. Both sides are reduced to fixed-size SHA-256 digests before
 * timingSafeEqual, so neither length nor content leaks through timing.
 */
export function verifyPresentedWorkflowSecret(
  presented: string | undefined,
  stored: string | null | undefined,
): boolean {
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
 * Rewrite every plaintext workflow webhook secret in the `triggers`
 * table to its `sha256:` hash form, in place. Idempotent: rows already
 * in hash form (and cron rows, whose secret is NULL) are untouched, so
 * re-running on every TriggerStore construction is a no-op. Returns
 * the number of rows migrated.
 */
export function migrateWorkflowTriggerSecrets(db: DatabaseSync): number {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'triggers'")
    .all() as unknown as Array<{ name: string }>;
  if (tables.length === 0) return 0;
  const rows = db.prepare('SELECT id, secret FROM triggers WHERE secret IS NOT NULL').all() as unknown as Array<{
    id: string;
    secret: string;
  }>;
  const upd = db.prepare('UPDATE triggers SET secret = ? WHERE id = ?');
  let migrated = 0;
  for (const row of rows) {
    if (row.secret && !isHashedWorkflowSecret(row.secret)) {
      upd.run(hashWorkflowSecret(row.secret), row.id);
      migrated++;
    }
  }
  return migrated;
}
