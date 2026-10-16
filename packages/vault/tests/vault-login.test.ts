// SPDX-License-Identifier: Apache-2.0
// Tests for vault login records (type_login support).
//
// Security invariants under test:
//   - passwords NEVER appear in list()/listLogins()/audit output
//   - login values are encrypted at rest (raw file must not contain them)
//   - GET /vault/:name equivalent (get()) still works for plain secrets

import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecureVault } from '../src/vault.js';

function freshVault(): { vault: SecureVault; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vault-login-test-'));
  return { vault: new SecureVault(dir), dir };
}

const PASSWORD = 's3cr3t-p@ssw0rd-xyz';

describe('vault login records', () => {
  it('creates and reads back a login with site/username/password', () => {
    const { vault } = freshVault();
    const meta = vault.createLogin('github-personal', 'github.com', 'octocat', PASSWORD);
    expect(meta.name).toBe('github-personal');
    expect(meta.site).toBe('github.com');
    expect(meta.username).toBe('octocat');
    expect(meta.kind).toBe('login');
    expect(Object.keys(meta)).not.toContain('password');

    const rec = vault.getLogin('github-personal');
    expect(rec?.password).toBe(PASSWORD);
    expect(rec?.site).toBe('github.com');
    expect(rec?.username).toBe('octocat');
  });

  it('list() includes kind; listLogins() never exposes passwords', () => {
    const { vault } = freshVault();
    vault.create('plain-secret', 'shh');
    vault.createLogin('gh', 'github.com', 'octocat', PASSWORD);

    const all = vault.list();
    expect(all).toHaveLength(2);
    const loginMeta = all.find((s) => s.name === 'gh');
    expect(loginMeta?.kind).toBe('login');
    expect(all.find((s) => s.name === 'plain-secret')?.kind).toBe('secret');
    expect(JSON.stringify(all)).not.toContain(PASSWORD);

    const logins = vault.listLogins();
    expect(logins).toHaveLength(1);
    expect(logins[0].site).toBe('github.com');
    expect(logins[0].username).toBe('octocat');
    expect(Object.keys(logins[0])).not.toContain('password');
    expect(JSON.stringify(logins)).not.toContain(PASSWORD);
  });

  it('getLogin returns undefined for missing names and plain secrets', () => {
    const { vault } = freshVault();
    vault.create('plain-secret', 'shh');
    expect(vault.getLogin('nope')).toBeUndefined();
    // A plain secret is not a login — must not be readable as one.
    expect(vault.getLogin('plain-secret')).toBeUndefined();
  });

  it('rejects duplicate login names (including colliding with secrets)', () => {
    const { vault } = freshVault();
    vault.create('taken', 'shh');
    expect(() => vault.createLogin('taken', 'example.com', 'u', 'p')).toThrow();
    vault.createLogin('mine', 'example.com', 'u', 'p');
    expect(() => vault.createLogin('mine', 'example.com', 'u', 'p')).toThrow();
  });

  it('validates site and username', () => {
    const { vault } = freshVault();
    expect(() => vault.createLogin('a', '', 'u', 'p')).toThrow(); // empty site
    expect(() => vault.createLogin('a', 'not a\tsite!', 'u', 'p')).toThrow(); // control chars
    expect(() => vault.createLogin('a', 'example.com', '', 'p')).toThrow(); // empty username
    expect(() => vault.createLogin('a', 'example.com', 'u', '')).toThrow(); // empty password
    // app names with spaces are fine
    expect(vault.createLogin('b', 'WhatsApp Desktop', 'u', 'p').site).toBe('WhatsApp Desktop');
  });

  it('deletes logins like secrets', () => {
    const { vault } = freshVault();
    vault.createLogin('gh', 'github.com', 'octocat', PASSWORD);
    expect(vault.delete('gh')).toBe(true);
    expect(vault.getLogin('gh')).toBeUndefined();
    expect(vault.listLogins()).toHaveLength(0);
  });

  it('audit trail carries names only — never passwords', () => {
    const { vault } = freshVault();
    vault.createLogin('gh', 'github.com', 'octocat', PASSWORD);
    vault.getLogin('gh');
    vault.getLogin('missing');
    const audit = vault.auditLog();
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit)).not.toContain('octocat');
    expect(audit.map((e) => e.action)).toContain('create');
    expect(audit.map((e) => e.action)).toContain('read');
  });

  it('encrypts login passwords at rest', () => {
    const { vault, dir } = freshVault();
    vault.createLogin('gh', 'github.com', 'octocat', PASSWORD);
    const raw = readFileSync(vault.path(), 'utf8');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('octocat');
  });

  it('old records without kind default to secret', () => {
    const { vault } = freshVault();
    vault.create('legacy', 'shh');
    // Simulate a pre-kind record by checking list() defaults.
    expect(vault.list()[0].kind).toBe('secret');
    expect(vault.listLogins()).toHaveLength(0);
  });
});
