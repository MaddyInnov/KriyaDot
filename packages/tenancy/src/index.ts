// SPDX-License-Identifier: Apache-2.0
// Multi-tenant organizations, roles, and data-isolation helpers
// (Phase 4, Workstream C).
//
// - Orgs/teams with membership + invites, roles: owner > admin > member > viewer.
// - Deny-by-default role checks: `canAct(actualRole, requiredRole)` returns
//   false for unknown roles; the API layer turns that into 403.
// - `tenantScope(tenantId)` returns a parameterized WHERE fragment other
//   stores can reuse so per-tenant queries never leak across tenants.
// - `maskForViewer(value)` extends the @mvp/governance redact pattern
//   (see packages/governance/src/redact.ts): recursive clone that masks
//   emails, phone-like values, and secret-looking values for the viewer role.
//   The input is never mutated; cycles are safe.
//
// Persistence: own SQLite file `<dataDir>/tenancy.db` (constructor takes the
// full db path, mirroring SubagentStore in @mvp/agent-runtime), so tenancy
// bookkeeping never contends with the session or governance databases.

import { randomUUID } from 'node:crypto';

// vitest cannot statically resolve `node:sqlite`, so load it at runtime via
// the builtin-module API (same trick as SubagentStore in @mvp/agent-runtime).
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Roles, lowest privilege last. owner > admin > member > viewer. */
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];

const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Deny-by-default role check: true only when `actual` is a known role whose
 * rank meets or exceeds `required`. Unknown/missing roles → false.
 */
export function canAct(actual: string | undefined, required: Role): boolean {
  if (!isRole(actual)) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ---------------------------------------------------------------------------
// Tenant-scoped query helper
// ---------------------------------------------------------------------------

export interface TenantFilter {
  /** Column name, e.g. 'org_id'. */
  column: string;
  /** Parameterized fragment, e.g. "org_id" = ?. */
  where: string;
  params: string[];
}

/**
 * Parameterized tenant filter for SQL stores. Other code builds queries like:
 *
 *   const f = tenantScope(orgId);
 *   db.prepare(`SELECT * FROM notes WHERE ${f.where} ORDER BY created_at`).all(...f.params);
 *
 * The tenant id is always bound as a parameter — never interpolated — so a
 * missing tenant id fails closed (empty string matches nothing) instead of
 * leaking rows.
 */
export function tenantScope(tenantId: string, column = 'org_id'): TenantFilter {
  return { column, where: `"${column}" = ?`, params: [tenantId] };
}

/**
 * In-memory equivalent: return only rows whose tenant key matches. Used by
 * stores that keep rows in arrays (and by tests).
 */
export function applyTenantScope<T extends Record<string, unknown>>(
  rows: T[],
  tenantId: string,
  key: 'orgId' | 'org_id' | 'tenantId' | 'tenant_id' = 'orgId',
): T[] {
  return rows.filter((row) => row[key] === tenantId);
}

// ---------------------------------------------------------------------------
// Viewer PII masking — extends the @mvp/governance redact pattern
// ---------------------------------------------------------------------------

/** Placeholder substituted for any secret value (same token as redact.ts). */
export const REDACTED = '[REDACTED]';
export const EMAIL_MASKED = '[EMAIL MASKED]';
export const PHONE_MASKED = '[PHONE MASKED]';

/** Keys whose values are secrets (mirrors SECRET_KEY_RE in redact.ts). */
const SECRET_KEY_RE = /api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie/i;

const EMAIL_KEY_RE = /e-?mail/i;
const PHONE_KEY_RE = /phone|mobile|tel\b|contact/i;

const EMAIL_VALUE_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

/** Count decimal digits in a string. */
function digitCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= '0' && ch <= '9') n++;
  return n;
}

/**
 * A string is phone-like when it contains only phone punctuation and at
 * least 7 digits. Deliberately strict so ids and short codes are untouched.
 */
function isPhoneLike(value: string): boolean {
  if (!/^\+?[0-9\s().\-]{7,24}$/.test(value)) return false;
  return digitCount(value) >= 7;
}

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return EMAIL_MASKED;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.charAt(0);
  return `${head}***@${domain}`;
}

function maskSecretValue(_value: unknown): string {
  return REDACTED;
}

function maskLeaf(key: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    return isSecretKey(key) ? maskSecretValue(value) : value;
  }
  if (isSecretKey(key)) return maskSecretValue(value);
  if (EMAIL_KEY_RE.test(key)) return maskPiiSubstrings(value);
  if (PHONE_KEY_RE.test(key)) return maskPhoneSubstrings(value);
  // Value-shaped PII even under an innocent key (e.g. "note": "reached a@b.com").
  return maskPiiSubstrings(value);
}

/** Global email pattern for substring masking. */
const EMAIL_GLOBAL_RE = /[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}/g;

/** Phone-ish runs inside prose: same strict shape as isPhoneLike. */
const PHONE_GLOBAL_RE = /\+?[0-9][0-9\s().\-]{6,22}/g;

function maskPhoneSubstring(match: string): string {
  const trimmed = match.trim();
  // Dates are not phone numbers — don't butcher them in viewer responses.
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) return match;
  return isPhoneLike(trimmed) ? PHONE_MASKED : match;
}

/** Mask email/phone substrings anywhere in a string (viewer privacy). */
function maskPiiSubstrings(value: string): string {
  return value.replace(EMAIL_GLOBAL_RE, (m) => maskEmail(m)).replace(PHONE_GLOBAL_RE, maskPhoneSubstring);
}

function maskPhoneSubstrings(value: string): string {
  return value.replace(PHONE_GLOBAL_RE, maskPhoneSubstring);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Recursively clone `value`, masking PII for the viewer role:
 * - secret-like keys → '[REDACTED]' (mirrors redactSecrets)
 * - email-like keys/values → 'j***@example.com' style masking
 * - phone-like keys/values → '[PHONE MASKED]'
 *
 * The input is never mutated. Cycle-safe: circular references are replaced
 * with '[CIRCULAR]'.
 */
export function maskForViewer<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'string' ? (maskLeaf('', value) as T) : value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => maskForViewer(item, seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    out[key] = isSecretKey(key)
      ? maskSecretValue(entryValue)
      : EMAIL_KEY_RE.test(key) || PHONE_KEY_RE.test(key)
        ? maskLeaf(key, entryValue)
        : typeof entryValue === 'string'
          ? maskLeaf(key, entryValue)
          : maskForViewer(entryValue, seen);
  }
  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface Org {
  id: string;
  name: string;
  createdAt: number;
}

export interface Membership {
  orgId: string;
  userId: string;
  role: Role;
  createdAt: number;
}

export interface Invite {
  orgId: string;
  email: string;
  role: Role;
  /** Opaque single-use token, returned once at creation time. */
  token: string;
  expiresAt: number;
  createdAt: number;
}

const TENANCY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    org_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id);
  CREATE INDEX IF NOT EXISTS idx_invites_token ON invites (token);
`;

const NAME_PATTERN = /^[\s\S]{1,100}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

const TENANCY_ERROR = '__tenancy_error__';

function tenancyError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = TENANCY_ERROR;
  return err;
}

export function isTenancyError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === TENANCY_ERROR;
}

function newOrgId(): string {
  return `org_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * SQLite-backed org/team + membership + invite store. Own file (tenancy.db),
 * so tenancy never contends with the session or governance databases.
 * Every read/write filters by org id — memberships of org A are never
 * returned when querying org B.
 */
export class TenantStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(TENANCY_SCHEMA);
  }

  // -- orgs -------------------------------------------------------------

  createOrg(name: string, creatorUserId: string): Org {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name.trim())) {
      throw tenancyError('org "name" must be a non-empty string (max 100 chars)');
    }
    requireUserId(creatorUserId);
    const org: Org = { id: newOrgId(), name: name.trim(), createdAt: Date.now() };
    this.db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(
      org.id,
      org.name,
      org.createdAt,
    );
    // The creator is the first (and initially only) owner.
    this.addMember(org.id, creatorUserId, 'owner');
    return org;
  }

  getOrg(id: string): Org | undefined {
    const row = this.db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) as
      | { id: string; name: string; created_at: number }
      | undefined;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : undefined;
  }

  /** Orgs `userId` belongs to, with the user's role in each. */
  listOrgsForUser(userId: string): Array<{ org: Org; role: Role }> {
    const rows = this.db
      .prepare(
        `SELECT o.id AS id, o.name AS name, o.created_at AS created_at, m.role AS role
         FROM memberships m JOIN orgs o ON o.id = m.org_id
         WHERE m.user_id = ? ORDER BY o.created_at ASC`,
      )
      .all(userId) as Array<{ id: string; name: string; created_at: number; role: string }>;
    return rows
      .filter((r) => isRole(r.role))
      .map((r) => ({
        org: { id: r.id, name: r.name, createdAt: r.created_at },
        role: r.role as Role,
      }));
  }

  // -- memberships ------------------------------------------------------

  getMembership(orgId: string, userId: string): Membership | undefined {
    const row = this.db
      .prepare('SELECT * FROM memberships WHERE org_id = ? AND user_id = ?')
      .get(orgId, userId) as
      | { org_id: string; user_id: string; role: string; created_at: number }
      | undefined;
    if (!row || !isRole(row.role)) return undefined;
    return { orgId: row.org_id, userId: row.user_id, role: row.role, createdAt: row.created_at };
  }

  listMembers(orgId: string): Membership[] {
    const rows = this.db
      .prepare('SELECT * FROM memberships WHERE org_id = ? ORDER BY created_at ASC')
      .all(orgId) as Array<{ org_id: string; user_id: string; role: string; created_at: number }>;
    return rows
      .filter((r) => isRole(r.role))
      .map((r) => ({ orgId: r.org_id, userId: r.user_id, role: r.role as Role, createdAt: r.created_at }));
  }

  addMember(orgId: string, userId: string, role: Role): Membership {
    requireOrg(orgId, this.getOrg(orgId));
    requireUserId(userId);
    if (!isRole(role)) throw tenancyError(`invalid role "${role}"`);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role',
      )
      .run(orgId, userId, role, now);
    return { orgId, userId, role, createdAt: now };
  }

  /** Change a member's role. Never lets the last owner be demoted. */
  setRole(orgId: string, userId: string, role: Role): Membership {
    const current = this.getMembership(orgId, userId);
    if (!current) throw tenancyError(`unknown member "${userId}" in org "${orgId}"`);
    if (!isRole(role)) throw tenancyError(`invalid role "${role}"`);
    if (current.role === 'owner' && role !== 'owner' && this.ownerCount(orgId) <= 1) {
      throw tenancyError('cannot demote the last owner of an org');
    }
    return this.addMember(orgId, userId, role);
  }

  /** Remove a member. Never lets the last owner be removed. */
  removeMember(orgId: string, userId: string): void {
    const current = this.getMembership(orgId, userId);
    if (!current) throw tenancyError(`unknown member "${userId}" in org "${orgId}"`);
    if (current.role === 'owner' && this.ownerCount(orgId) <= 1) {
      throw tenancyError('cannot remove the last owner of an org');
    }
    this.db.prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?').run(orgId, userId);
  }

  ownerCount(orgId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'")
      .get(orgId) as { n: number };
    return row.n;
  }

  // -- invites ----------------------------------------------------------

  createInvite(orgId: string, email: string, role: Role, ttlMs = 7 * 24 * 60 * 60 * 1000): Invite {
    requireOrg(orgId, this.getOrg(orgId));
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
      throw tenancyError('invite "email" must be a valid email address');
    }
    if (!isRole(role)) throw tenancyError(`invalid role "${role}"`);
    const normalized = email.trim().toLowerCase();
    const invite: Invite = {
      orgId,
      email: normalized,
      role,
      token: `inv_${randomUUID().replace(/-/g, '')}`,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO invites (org_id, email, role, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (org_id, email) DO UPDATE SET role = excluded.role, token = excluded.token, expires_at = excluded.expires_at',
      )
      .run(orgId, normalized, role, invite.token, invite.expiresAt, invite.createdAt);
    return invite;
  }

  getInviteByToken(token: string): Invite | undefined {
    const row = this.db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as
      | { org_id: string; email: string; role: string; token: string; expires_at: number; created_at: number }
      | undefined;
    if (!row || !isRole(row.role)) return undefined;
    if (row.expires_at <= Date.now()) return undefined;
    return {
      orgId: row.org_id,
      email: row.email,
      role: row.role,
      token: row.token,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  listInvites(orgId: string): Invite[] {
    const rows = this.db
      .prepare('SELECT * FROM invites WHERE org_id = ? AND expires_at > ? ORDER BY created_at ASC')
      .all(orgId, Date.now()) as Array<{
      org_id: string;
      email: string;
      role: string;
      token: string;
      expires_at: number;
      created_at: number;
    }>;
    return rows
      .filter((r) => isRole(r.role))
      .map((r) => ({
        orgId: r.org_id,
        email: r.email,
        role: r.role as Role,
        token: r.token,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      }));
  }

  /**
   * Accept an invite: consume the token and create/update the membership.
   * Tokens are single-use and expiry-checked (fail closed).
   */
  acceptInvite(token: string, userId: string): Membership {
    requireUserId(userId);
    const invite = this.getInviteByToken(token);
    if (!invite) throw tenancyError('invalid or expired invite token');
    this.db.prepare('DELETE FROM invites WHERE token = ?').run(token);
    return this.addMember(invite.orgId, userId, invite.role);
  }

  revokeInvite(orgId: string, email: string): boolean {
    const res = this.db
      .prepare('DELETE FROM invites WHERE org_id = ? AND email = ?')
      .run(orgId, email.trim().toLowerCase());
    return res.changes > 0;
  }
}

function requireUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw tenancyError('user id must be 1-64 chars: letters, digits, ., _, -');
  }
}

function requireOrg(orgId: string, org: Org | undefined): asserts org is Org {
  if (!org) throw tenancyError(`unknown org "${orgId}"`);
}
