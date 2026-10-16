// SPDX-License-Identifier: Apache-2.0
// Per-user secure vault: AES-256-GCM encrypted secrets at rest.
//
// - Own machine key file `<dataDir>/.vault-key` (mode 0600), separate from
//   the provider-key machine key in providers.ts.
// - Store file `<dataDir>/vault.json` (or `vault.<namespace>.json`): every
//   write re-encrypts the whole payload under a fresh random 96-bit IV,
//   written atomically (temp + rename). Reads verify the GCM auth tag and
//   fail closed — never fall back to plaintext.
// - CRUD with an audit trail: every create/update/delete/failed-access is
//   appended to the in-envelope `audit` array carrying { ts, actor, action,
//   name } — NEVER the secret value. The API layer additionally fans out to
//   the governance audit endpoint.
// - Secret values NEVER appear in logs or thrown errors: errors reference
//   the secret name only; list() returns metadata without values.

import { join } from 'node:path';
import { readEncryptedJson, writeEncryptedJson } from './crypto.js';
// Privacy-tier classification for secrets (see @mvp/governance
// privacy-tiers.ts). Vault secrets default to `local-only` at write time.
import type { PrivacyTier } from '@mvp/governance';
import { isPrivacyTier, resolveTier } from '@mvp/governance';

export type SecretKind = 'secret' | 'login';

export interface SecretMeta {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Privacy tier (write-time tag). Vault secrets default to `local-only`:
   * they must never be sent to a cloud provider or any network egress.
   * Overridable per secret via create/update opts.
   */
  tier: PrivacyTier;
  /**
   * Record kind. 'secret' for plain secrets; 'login' for saved site logins
   * (used by the type_login tool). Absent on records written before kinds
   * existed — treated as 'secret'.
   */
  kind: SecretKind;
}

export interface Secret extends SecretMeta {
  value: string;
}

/**
 * A saved site login. The password is encrypted at rest inside the vault
 * envelope (same AES-256-GCM as secrets) and is only ever returned by
 * getLogin() — a server-side call. It must NEVER enter LLM context; the
 * type_login tool resolves it inside its handler.
 */
export interface LoginMeta {
  name: string;
  /** Domain (example.com) or app name the login belongs to. */
  site: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  tier: PrivacyTier;
  kind: 'login';
}

export interface LoginRecord extends LoginMeta {
  password: string;
}

export interface VaultAuditEntry {
  ts: number;
  actor: string;
  action: 'create' | 'update' | 'delete' | 'read' | 'read-denied';
  /** Secret name only — values are never written to the audit trail. */
  name: string;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_VALUE_BYTES = 64 * 1024;
/** Site: domain-ish or app name, 1-128 chars, no control chars. */
const SITE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\- ]{0,127}$/;
const MAX_USERNAME_BYTES = 1024;

interface StoredSecret extends SecretMeta {
  value: string;
}

/** Wire format of a login record stored as a secret value (encrypted). */
interface StoredLoginValue {
  site: string;
  username: string;
  password: string;
}

function requireSite(site: unknown): string {
  if (typeof site !== 'string' || !SITE_PATTERN.test(site.trim())) {
    throw vaultError(
      'login "site" must be 1-128 chars: a domain (example.com) or app name (letters, digits, space, ., _, -)',
    );
  }
  return site.trim();
}

function requireUsername(username: unknown): string {
  if (typeof username !== 'string' || username.length === 0) {
    throw vaultError('login "username" must be a non-empty string');
  }
  if (Buffer.byteLength(username, 'utf8') > MAX_USERNAME_BYTES) {
    throw vaultError('login "username" exceeds the 1 KiB limit');
  }
  return username;
}

interface VaultPayload {
  version: 1;
  secrets: StoredSecret[];
  audit: VaultAuditEntry[];
}

const EMPTY_PAYLOAD: VaultPayload = { version: 1, secrets: [], audit: [] };

const VAULT_ERROR = '__vault_error__';

function vaultError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = VAULT_ERROR;
  return err;
}

export function isVaultError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === VAULT_ERROR;
}

function requireName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw vaultError(
      'secret "name" must be 1-64 chars: letters, digits, _, - (must start with a letter or digit)',
    );
  }
  return name;
}

function requireValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw vaultError('secret "value" must be a non-empty string');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw vaultError('secret "value" exceeds the 64 KiB limit');
  }
  return value;
}

/**
 * Per-user encrypted secret store. `namespace` isolates users sharing a
 * data dir (the API passes the request's user id); 'default' otherwise.
 */
export class SecureVault {
  private readonly filePath: string;
  private readonly keyPath: string;
  private readonly actor: string;

  constructor(dataDir: string, namespace = 'default', actor = 'api') {
    const suffix = namespace === 'default' ? '' : `.${sanitizeNamespace(namespace)}`;
    this.filePath = join(dataDir, `vault${suffix}.json`);
    this.keyPath = join(dataDir, '.vault-key');
    this.actor = actor;
  }

  /** Absolute path of the encrypted store file (for debugging/tests). */
  path(): string {
    return this.filePath;
  }

  private load(): VaultPayload {
    const payload = readEncryptedJson<VaultPayload>(this.filePath, this.keyPath, EMPTY_PAYLOAD);
    if (!payload || payload.version !== 1 || !Array.isArray(payload.secrets) || !Array.isArray(payload.audit)) {
      throw vaultError(`vault store at ${this.filePath} is corrupt — refusing to read secrets`);
    }
    // Backward compatibility: secrets written before tiers existed have no
    // tier field — fail closed to `local-only` (secrets never silently
    // become egressable). Same for `kind` (pre-kind records are 'secret').
    for (const s of payload.secrets) {
      if (!isPrivacyTier((s as { tier?: unknown }).tier)) {
        (s as { tier: PrivacyTier }).tier = 'local-only';
      }
      const k = (s as { kind?: unknown }).kind;
      if (k !== 'secret' && k !== 'login') {
        (s as { kind: SecretKind }).kind = 'secret';
      }
    }
    return payload;
  }

  private save(payload: VaultPayload, entry: VaultAuditEntry): void {
    // Cap the audit trail so the envelope can't grow unbounded.
    const audit = [...payload.audit, entry].slice(-1000);
    writeEncryptedJson(this.filePath, this.keyPath, { ...payload, audit });
  }

  /** Metadata only — values are never listed. */
  list(): SecretMeta[] {
    const payload = this.load();
    return payload.secrets
      .map(({ name, description, createdAt, updatedAt, tier, kind }) => ({
        name,
        description,
        createdAt,
        updatedAt,
        tier,
        kind,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Login metadata only — sites and usernames are listed; passwords never. */
  listLogins(): LoginMeta[] {
    const payload = this.load();
    const out: LoginMeta[] = [];
    for (const s of payload.secrets) {
      if (s.kind !== 'login') continue;
      const parsed = parseLoginValue(s.name, s.value);
      if (!parsed) continue; // corrupt entry: skip, don't leak
      out.push({
        name: s.name,
        site: parsed.site,
        username: parsed.username,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        tier: s.tier,
        kind: 'login',
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create a secret. `opts.tier` overrides the write-time default
   * (`local-only` for vault secrets — see resolveTier).
   */
  create(name: unknown, value: unknown, description?: string, opts: { tier?: PrivacyTier } = {}): SecretMeta {
    const n = requireName(name);
    const v = requireValue(value);
    const tier = resolveTier('vault', opts.tier);
    const payload = this.load();
    if (payload.secrets.some((s) => s.name === n)) {
      throw vaultError(`secret "${n}" already exists`);
    }
    const now = Date.now();
    const meta: SecretMeta = {
      name: n,
      ...(typeof description === 'string' && description ? { description } : {}),
      createdAt: now,
      updatedAt: now,
      tier,
      kind: 'secret',
    };
    this.save(
      { ...payload, secrets: [...payload.secrets, { ...meta, value: v }] },
      { ts: now, actor: this.actor, action: 'create', name: n },
    );
    return meta;
  }

  /** Full read — the only method that returns a value. Success is audited (name-only). */
  get(name: unknown): Secret | undefined {
    const n = requireName(name);
    const payload = this.load();
    const found = payload.secrets.find((s) => s.name === n);
    if (!found) {
      this.save(payload, { ts: Date.now(), actor: this.actor, action: 'read-denied', name: n });
      return undefined;
    }
    this.save(payload, { ts: Date.now(), actor: this.actor, action: 'read', name: n });
    return { name: found.name, description: found.description, value: found.value, createdAt: found.createdAt, updatedAt: found.updatedAt, tier: found.tier, kind: found.kind };
  }

  /**
   * Create a saved site login. Stored as a 'login'-kind secret whose
   * encrypted value is { site, username, password } JSON. The password is
   * only ever returned by getLogin() (server-side); list()/listLogins()
   * never expose it.
   */
  createLogin(
    name: unknown,
    site: unknown,
    username: unknown,
    password: unknown,
    opts: { tier?: PrivacyTier } = {},
  ): LoginMeta {
    const n = requireName(name);
    const s = requireSite(site);
    const u = requireUsername(username);
    const p = requireValue(password);
    const tier = resolveTier('vault', opts.tier);
    const payload = this.load();
    if (payload.secrets.some((x) => x.name === n)) {
      throw vaultError(`secret "${n}" already exists`);
    }
    const now = Date.now();
    const stored: StoredSecret = {
      name: n,
      createdAt: now,
      updatedAt: now,
      tier,
      kind: 'login',
      value: JSON.stringify({ site: s, username: u, password: p } satisfies StoredLoginValue),
    };
    this.save(
      { ...payload, secrets: [...payload.secrets, stored] },
      { ts: now, actor: this.actor, action: 'create', name: n },
    );
    return { name: n, site: s, username: u, createdAt: now, updatedAt: now, tier, kind: 'login' };
  }

  /**
   * Full login read — the only method that returns a password. Server-side
   * only (used by the type_login tool handler); never expose to the model
   * plane. Success is audited name-only.
   */
  getLogin(name: unknown): LoginRecord | undefined {
    const n = requireName(name);
    const payload = this.load();
    const found = payload.secrets.find((s) => s.name === n);
    if (!found || found.kind !== 'login') {
      this.save(payload, { ts: Date.now(), actor: this.actor, action: 'read-denied', name: n });
      return undefined;
    }
    const parsed = parseLoginValue(n, found.value);
    if (!parsed) {
      this.save(payload, { ts: Date.now(), actor: this.actor, action: 'read-denied', name: n });
      return undefined;
    }
    this.save(payload, { ts: Date.now(), actor: this.actor, action: 'read', name: n });
    return {
      name: found.name,
      site: parsed.site,
      username: parsed.username,
      password: parsed.password,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
      tier: found.tier,
      kind: 'login',
    };
  }

  /** Update a secret; `opts.tier` re-tags it (explicit override only). */
  update(name: unknown, value?: unknown, description?: string, opts: { tier?: PrivacyTier } = {}): SecretMeta {
    const n = requireName(name);
    const payload = this.load();
    const idx = payload.secrets.findIndex((s) => s.name === n);
    if (idx === -1) throw vaultError(`unknown secret "${n}"`);
    const current = payload.secrets[idx];
    const next: StoredSecret = {
      ...current,
      value: value === undefined ? current.value : requireValue(value),
      description: description === undefined ? current.description : description || undefined,
      ...(opts.tier !== undefined ? { tier: resolveTier('vault', opts.tier) } : {}),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    const secrets = [...payload.secrets];
    secrets[idx] = next;
    this.save({ ...payload, secrets }, { ts: Date.now(), actor: this.actor, action: 'update', name: n });
    const { value: _v, ...meta } = next;
    return meta;
  }

  delete(name: unknown): boolean {
    const n = requireName(name);
    const payload = this.load();
    const secrets = payload.secrets.filter((s) => s.name !== n);
    if (secrets.length === payload.secrets.length) return false;
    this.save({ ...payload, secrets }, { ts: Date.now(), actor: this.actor, action: 'delete', name: n });
    return true;
  }

  /** Audit trail — entries carry names only, never secret values. */
  auditLog(): VaultAuditEntry[] {
    return this.load().audit.slice();
  }
}

/**
 * Parse a stored login value. Returns undefined (never throws, never leaks
 * the raw value) when the envelope is corrupt.
 */
function parseLoginValue(name: string, value: string): StoredLoginValue | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<StoredLoginValue>;
    if (
      typeof parsed.site === 'string' &&
      typeof parsed.username === 'string' &&
      typeof parsed.password === 'string' &&
      parsed.password.length > 0
    ) {
      return { site: parsed.site, username: parsed.username, password: parsed.password };
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

function sanitizeNamespace(namespace: string): string {
  const clean = namespace.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return clean || 'default';
}
