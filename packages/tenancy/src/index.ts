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

// ---------------------------------------------------------------------------
// JWT sessions for tenancy (HS256, node:crypto HMAC — no new deps)
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TenancyJwtClaims {
  /** Subject: tenancy user id. */
  sub: string;
  orgId: string;
  role?: Role;
  email?: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Sign an HS256 tenancy session JWT. `ttlMs` defaults to 8 hours. */
export function signTenancyJwt(
  claims: { sub: string; orgId: string; role?: Role; email?: string; [key: string]: unknown },
  secret: string,
  ttlMs = 8 * 60 * 60 * 1000,
  now = Date.now(),
): string {
  if (!secret) throw tenancyError('JWT secret is required');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: TenancyJwtClaims = {
    ...claims,
    sub: claims.sub,
    orgId: claims.orgId,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac(secret, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

/**
 * Verify an HS256 tenancy JWT. Returns claims or null (fail closed on bad
 * signature, malformed input, wrong alg, or expiry).
 */
export function verifyTenancyJwt(token: unknown, secret: string, now = Date.now()): TenancyJwtClaims | null {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
    if (parsedHeader.alg !== 'HS256') return null;
    const expected = hmac(secret, `${header}.${body}`);
    const provided = Buffer.from(sig, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TenancyJwtClaims;
    if (typeof claims.sub !== 'string' || typeof claims.orgId !== 'string') return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Extract + verify a `Bearer <jwt>` Authorization header. */
export function tenancyJwtFromHeader(header: string | undefined, secret: string): TenancyJwtClaims | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return verifyTenancyJwt(header.slice('Bearer '.length).trim(), secret);
}

// ---------------------------------------------------------------------------
// Tenancy depth: users, role templates, groups, resource audience, quotas
// ---------------------------------------------------------------------------

export interface TenancyUser {
  userId: string;
  email: string;
  name: string;
  provider?: string;
  externalId?: string;
  createdAt: number;
  lastLoginAt: number;
}

export interface RoleTemplate {
  id: string;
  orgId: string;
  name: string;
  role: Role;
  permissions: string[];
  createdAt: number;
}

export interface UserGroup {
  id: string;
  orgId: string;
  name: string;
  memberIds: string[];
  createdAt: number;
}

export type ResourceType = 'bot' | 'skill' | 'kb';
export type GrantLevel = 'read' | 'use';
export type ResourceVisibility = 'org' | 'groups' | 'private';

export interface GroupGrant {
  groupId: string;
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  level: GrantLevel;
}

export interface ResourceAudience {
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  visibility: ResourceVisibility;
  allowedGroupIds: string[];
  ownerUserId?: string;
}

export interface UserQuota {
  orgId: string;
  userId: string;
  storageBytes: number;
  monthlyTokens: number;
}

export interface UserUsage {
  orgId: string;
  userId: string;
  storageBytes: number;
  /** Tokens consumed in `month` (YYYY-MM). */
  month: string;
  monthlyTokens: number;
}

const EXTRAS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tenancy_users (
    user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    provider TEXT, external_id TEXT, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS role_templates (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
    permissions_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE (org_id, name)
  );
  CREATE TABLE IF NOT EXISTS user_groups (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE (org_id, name)
  );
  CREATE TABLE IF NOT EXISTS user_group_members (
    group_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS group_grants (
    group_id TEXT NOT NULL, org_id TEXT NOT NULL, resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL, level TEXT NOT NULL,
    PRIMARY KEY (group_id, resource_type, resource_id)
  );
  CREATE TABLE IF NOT EXISTS resource_audience (
    org_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
    visibility TEXT NOT NULL, allowed_group_ids_json TEXT NOT NULL, owner_user_id TEXT,
    PRIMARY KEY (org_id, resource_type, resource_id)
  );
  CREATE TABLE IF NOT EXISTS user_quotas (
    org_id TEXT NOT NULL, user_id TEXT NOT NULL, storage_bytes INTEGER NOT NULL,
    monthly_tokens INTEGER NOT NULL, PRIMARY KEY (org_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS user_usage (
    org_id TEXT NOT NULL, user_id TEXT NOT NULL, month TEXT NOT NULL,
    storage_bytes INTEGER NOT NULL DEFAULT 0, monthly_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, user_id, month)
  );
`;

function userIdFromEmail(email: string): string {
  const slug = email.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'user';
  return `u-${slug}`;
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Depth store sharing the tenancy.db file (own tables, same openDb helper).
 * Holds SSO/LDAP-mapped users, role templates, groups + grants, per-resource
 * audience, and per-user quotas/usage.
 */
export class TenancyExtrasStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(EXTRAS_SCHEMA);
  }

  // -- users (SSO/LDAP mapping) ------------------------------------------

  upsertExternalUser(input: {
    email: string;
    name?: string;
    provider: string;
    externalId?: string;
  }): TenancyUser {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw tenancyError('user "email" must be a valid email address');
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM tenancy_users WHERE email = ?').get(email) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE tenancy_users SET name = ?, provider = ?, external_id = ?, last_login_at = ? WHERE email = ?')
        .run(input.name?.trim() || (existing.name as string), input.provider, input.externalId ?? (existing.external_id as string) ?? null, now, email);
      return this.getUserByEmail(email) as TenancyUser;
    }
    const user: TenancyUser = {
      userId: userIdFromEmail(email),
      email,
      name: input.name?.trim() || email.split('@')[0] || email,
      provider: input.provider,
      externalId: input.externalId,
      createdAt: now,
      lastLoginAt: now,
    };
    this.db
      .prepare('INSERT INTO tenancy_users (user_id, email, name, provider, external_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.userId, user.email, user.name, user.provider ?? null, user.externalId ?? null, now, now);
    return user;
  }

  getUserByEmail(email: string): TenancyUser | undefined {
    const row = this.db.prepare('SELECT * FROM tenancy_users WHERE email = ?').get(email.trim().toLowerCase()) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      userId: row.user_id as string,
      email: row.email as string,
      name: row.name as string,
      provider: (row.provider as string) ?? undefined,
      externalId: (row.external_id as string) ?? undefined,
      createdAt: row.created_at as number,
      lastLoginAt: row.last_login_at as number,
    };
  }

  // -- role templates ------------------------------------------------------

  createRoleTemplate(orgId: string, name: string, role: Role, permissions: string[] = []): RoleTemplate {
    if (!isRole(role)) throw tenancyError(`invalid role "${role}"`);
    if (typeof name !== 'string' || !name.trim()) throw tenancyError('role template "name" is required');
    const tpl: RoleTemplate = {
      id: `rtpl_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      orgId,
      name: name.trim().slice(0, 80),
      role,
      permissions: [...new Set(permissions.filter((p) => typeof p === 'string'))].slice(0, 50),
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO role_templates (id, org_id, name, role, permissions_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, name) DO UPDATE SET role = excluded.role, permissions_json = excluded.permissions_json')
      .run(tpl.id, orgId, tpl.name, role, JSON.stringify(tpl.permissions), tpl.createdAt);
    return this.getRoleTemplateByName(orgId, tpl.name) as RoleTemplate;
  }

  getRoleTemplateByName(orgId: string, name: string): RoleTemplate | undefined {
    const row = this.db.prepare('SELECT * FROM role_templates WHERE org_id = ? AND name = ?').get(orgId, name) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      orgId: row.org_id as string,
      name: row.name as string,
      role: row.role as Role,
      permissions: JSON.parse(row.permissions_json as string) as string[],
      createdAt: row.created_at as number,
    };
  }

  listRoleTemplates(orgId: string): RoleTemplate[] {
    const names = this.db.prepare('SELECT name FROM role_templates WHERE org_id = ? ORDER BY created_at').all(orgId) as Array<{ name: string }>;
    return names.map((r) => this.getRoleTemplateByName(orgId, r.name)).filter((t): t is RoleTemplate => Boolean(t));
  }

  // -- groups ---------------------------------------------------------------

  createGroup(orgId: string, name: string, memberIds: string[] = []): UserGroup {
    if (typeof name !== 'string' || !name.trim()) throw tenancyError('group "name" is required');
    const id = `grp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const existing = this.db.prepare('SELECT id FROM user_groups WHERE org_id = ? AND name = ?').get(orgId, name.trim()) as { id: string } | undefined;
    const groupId = existing?.id ?? id;
    if (!existing) {
      this.db.prepare('INSERT INTO user_groups (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(groupId, orgId, name.trim().slice(0, 80), Date.now());
    }
    for (const m of memberIds) this.addGroupMember(groupId, m);
    return this.getGroup(groupId) as UserGroup;
  }

  getGroup(groupId: string): UserGroup | undefined {
    const row = this.db.prepare('SELECT * FROM user_groups WHERE id = ?').get(groupId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const members = this.db.prepare('SELECT user_id FROM user_group_members WHERE group_id = ? ORDER BY user_id').all(groupId) as Array<{ user_id: string }>;
    return {
      id: row.id as string,
      orgId: row.org_id as string,
      name: row.name as string,
      memberIds: members.map((m) => m.user_id),
      createdAt: row.created_at as number,
    };
  }

  listGroups(orgId: string): UserGroup[] {
    const rows = this.db.prepare('SELECT id FROM user_groups WHERE org_id = ? ORDER BY created_at').all(orgId) as Array<{ id: string }>;
    return rows.map((r) => this.getGroup(r.id)).filter((g): g is UserGroup => Boolean(g));
  }

  addGroupMember(groupId: string, userId: string): void {
    this.db.prepare('INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(groupId, userId);
  }

  groupsForUser(orgId: string, userId: string): UserGroup[] {
    return this.listGroups(orgId).filter((g) => g.memberIds.includes(userId));
  }

  // -- grants + audience ------------------------------------------------------

  grantToGroup(grant: GroupGrant): GroupGrant {
    if (!['read', 'use'].includes(grant.level)) throw tenancyError('grant level must be read|use');
    this.db
      .prepare('INSERT INTO group_grants (group_id, org_id, resource_type, resource_id, level) VALUES (?, ?, ?, ?, ?) ON CONFLICT (group_id, resource_type, resource_id) DO UPDATE SET level = excluded.level')
      .run(grant.groupId, grant.orgId, grant.resourceType, grant.resourceId, grant.level);
    return grant;
  }

  listGrantsForGroup(groupId: string): GroupGrant[] {
    const rows = this.db.prepare('SELECT * FROM group_grants WHERE group_id = ?').all(groupId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      groupId: r.group_id as string,
      orgId: r.org_id as string,
      resourceType: r.resource_type as ResourceType,
      resourceId: r.resource_id as string,
      level: r.level as GrantLevel,
    }));
  }

  setResourceAudience(audience: ResourceAudience): ResourceAudience {
    if (!['org', 'groups', 'private'].includes(audience.visibility)) throw tenancyError('visibility must be org|groups|private');
    this.db
      .prepare('INSERT INTO resource_audience (org_id, resource_type, resource_id, visibility, allowed_group_ids_json, owner_user_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, resource_type, resource_id) DO UPDATE SET visibility = excluded.visibility, allowed_group_ids_json = excluded.allowed_group_ids_json, owner_user_id = excluded.owner_user_id')
      .run(audience.orgId, audience.resourceType, audience.resourceId, audience.visibility, JSON.stringify(audience.allowedGroupIds), audience.ownerUserId ?? null);
    return audience;
  }

  getResourceAudience(orgId: string, resourceType: ResourceType, resourceId: string): ResourceAudience | undefined {
    const row = this.db
      .prepare('SELECT * FROM resource_audience WHERE org_id = ? AND resource_type = ? AND resource_id = ?')
      .get(orgId, resourceType, resourceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      orgId: row.org_id as string,
      resourceType: row.resource_type as ResourceType,
      resourceId: row.resource_id as string,
      visibility: row.visibility as ResourceVisibility,
      allowedGroupIds: JSON.parse(row.allowed_group_ids_json as string) as string[],
      ownerUserId: (row.owner_user_id as string) ?? undefined,
    };
  }

  // -- quotas + usage ---------------------------------------------------------

  setQuota(quota: UserQuota): UserQuota {
    this.db
      .prepare('INSERT INTO user_quotas (org_id, user_id, storage_bytes, monthly_tokens) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET storage_bytes = excluded.storage_bytes, monthly_tokens = excluded.monthly_tokens')
      .run(quota.orgId, quota.userId, Math.max(0, Math.floor(quota.storageBytes)), Math.max(0, Math.floor(quota.monthlyTokens)));
    return this.getQuota(quota.orgId, quota.userId) as UserQuota;
  }

  getQuota(orgId: string, userId: string): UserQuota | undefined {
    const row = this.db.prepare('SELECT * FROM user_quotas WHERE org_id = ? AND user_id = ?').get(orgId, userId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { orgId, userId, storageBytes: row.storage_bytes as number, monthlyTokens: row.monthly_tokens as number };
  }

  recordUsage(orgId: string, userId: string, delta: { storageBytes?: number; monthlyTokens?: number }, month = currentMonth()): UserUsage {
    this.db
      .prepare('INSERT INTO user_usage (org_id, user_id, month, storage_bytes, monthly_tokens) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, user_id, month) DO UPDATE SET storage_bytes = storage_bytes + excluded.storage_bytes, monthly_tokens = monthly_tokens + excluded.monthly_tokens')
      .run(orgId, userId, month, Math.max(0, Math.floor(delta.storageBytes ?? 0)), Math.max(0, Math.floor(delta.monthlyTokens ?? 0)));
    return this.getUsage(orgId, userId, month);
  }

  getUsage(orgId: string, userId: string, month = currentMonth()): UserUsage {
    const row = this.db.prepare('SELECT * FROM user_usage WHERE org_id = ? AND user_id = ? AND month = ?').get(orgId, userId, month) as Record<string, unknown> | undefined;
    return {
      orgId,
      userId,
      month,
      storageBytes: (row?.storage_bytes as number) ?? 0,
      monthlyTokens: (row?.monthly_tokens as number) ?? 0,
    };
  }

  /** True when the user is within quota (no quota row = unlimited). */
  checkQuota(orgId: string, userId: string, delta: { storageBytes?: number; monthlyTokens?: number } = {}, month = currentMonth()): { ok: boolean; reason?: string; quota?: UserQuota; usage: UserUsage } {
    const quota = this.getQuota(orgId, userId);
    const usage = this.getUsage(orgId, userId, month);
    if (!quota) return { ok: true, usage };
    if (quota.storageBytes > 0 && usage.storageBytes + (delta.storageBytes ?? 0) > quota.storageBytes) {
      return { ok: false, reason: 'storage quota exceeded', quota, usage };
    }
    if (quota.monthlyTokens > 0 && usage.monthlyTokens + (delta.monthlyTokens ?? 0) > quota.monthlyTokens) {
      return { ok: false, reason: 'monthly token quota exceeded', quota, usage };
    }
    return { ok: true, quota, usage };
  }
}

/**
 * Authorization check combining org membership, resource audience, and
 * group grants. Rules (deny by default):
 *  - non-members: no access.
 *  - owner/admin members: full access within their org.
 *  - no audience record: org-visible to members (level 'use').
 *  - visibility 'org': any member; 'private': only the owner user;
 *    'groups': members of an allowed group, further requiring a group grant
 *    at the requested level when a grant row exists for that group/resource.
 */
export function canUserAccessResource(
  tenants: TenantStore,
  extras: TenancyExtrasStore,
  input: { orgId: string; userId: string; resourceType: ResourceType; resourceId: string; level?: GrantLevel },
): boolean {
  const membership = tenants.getMembership(input.orgId, input.userId);
  if (!membership) return false;
  if (membership.role === 'owner' || membership.role === 'admin') return true;
  const audience = extras.getResourceAudience(input.orgId, input.resourceType, input.resourceId);
  if (!audience) return true;
  if (audience.visibility === 'org') return true;
  if (audience.visibility === 'private') return audience.ownerUserId === input.userId;
  // groups visibility
  const level = input.level ?? 'read';
  const myGroups = extras.groupsForUser(input.orgId, input.userId).filter((g) => audience.allowedGroupIds.includes(g.id));
  if (myGroups.length === 0) return false;
  // If any grant rows exist for these groups on this resource, the level must be satisfied.
  let sawGrant = false;
  for (const g of myGroups) {
    for (const grant of extras.listGrantsForGroup(g.id)) {
      if (grant.resourceType === input.resourceType && grant.resourceId === input.resourceId) {
        sawGrant = true;
        if (grant.level === 'use' || grant.level === level) return true;
      }
    }
  }
  return !sawGrant;
}
