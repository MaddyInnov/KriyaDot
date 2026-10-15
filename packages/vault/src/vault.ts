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
}

export interface Secret extends SecretMeta {
  value: string;
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

interface StoredSecret extends SecretMeta {
  value: string;
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
    // become egressable).
    for (const s of payload.secrets) {
      if (!isPrivacyTier((s as { tier?: unknown }).tier)) {
        (s as { tier: PrivacyTier }).tier = 'local-only';
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
      .map(({ name, description, createdAt, updatedAt, tier }) => ({ name, description, createdAt, updatedAt, tier }))
      .sort((a, b) => a.name.localeCompare(b.name));
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
    };
    this.save(
      { ...payload, secrets: [...payload.secrets, { ...meta, value: v }] },
      { ts: now, actor: this.actor, action: 'create', name: n },
    );
    return meta;
  }

  /** Full read — the only method that returns a value. */
  get(name: unknown): Secret | undefined {
    const n = requireName(name);
    const payload = this.load();
    const found = payload.secrets.find((s) => s.name === n);
    if (!found) {
      this.save(payload, { ts: Date.now(), actor: this.actor, action: 'read-denied', name: n });
      return undefined;
    }
    return { name: found.name, description: found.description, value: found.value, createdAt: found.createdAt, updatedAt: found.updatedAt, tier: found.tier };
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

function sanitizeNamespace(namespace: string): string {
  const clean = namespace.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return clean || 'default';
}
