// SPDX-License-Identifier: Apache-2.0
// Tests for @mvp/vault: encryption at rest (no plaintext secrets on disk),
// audit entries never carry values, CRUD roundtrips, mock wallet flows.
// Temp dirs only — never the shared data dir.

import { mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockWalletProvider, SecureVault, isWalletError } from '../src/index.js';

const SECRET_VALUE = 's3cr3t-pl41nt3xt-never-on-disk';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'vault-'));
}

describe('SecureVault encryption at rest', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it('creates the machine key file with mode 0600', () => {
    const vault = new SecureVault(dir);
    vault.create('api-key', SECRET_VALUE);
    const mode = statSync(join(dir, '.vault-key')).mode & 0o777;
    // On platforms without POSIX perms the chmod is best-effort; assert the
    // file exists and (where supported) is 0600.
    expect(mode === 0o600 || process.platform === 'win32').toBe(true);
  });

  it('never stores plaintext secrets on disk', () => {
    const vault = new SecureVault(dir);
    vault.create('api-key', SECRET_VALUE, 'my key');
    const raw = readFileSync(vault.path(), 'utf8');
    expect(raw).not.toContain(SECRET_VALUE);
    // The file is an encrypted envelope.
    const envelope = JSON.parse(raw);
    expect(envelope.alg).toBe('aes-256-gcm');
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.tag).toBe('string');
    expect(typeof envelope.data).toBe('string');
  });

  it('round-trips through close/reopen', () => {
    const vault = new SecureVault(dir);
    vault.create('api-key', SECRET_VALUE);
    const reopened = new SecureVault(dir);
    expect(reopened.get('api-key')?.value).toBe(SECRET_VALUE);
  });

  it('fails closed when the key file is missing but the store is encrypted', () => {
    const vault = new SecureVault(dir);
    vault.create('api-key', SECRET_VALUE);
    // Remove the key → the encrypted store must be unreadable, never plaintext.
    unlinkSync(join(dir, '.vault-key'));
    const reopened = new SecureVault(dir);
    expect(() => reopened.get('api-key')).toThrow(/refusing to read/i);
  });

  it('rejects a tampered store file', () => {
    const vault = new SecureVault(dir);
    vault.create('api-key', SECRET_VALUE);
    const raw = readFileSync(vault.path(), 'utf8');
    const envelope = JSON.parse(raw);
    envelope.data = Buffer.from('tampered').toString('base64');
    writeFileSync(vault.path(), JSON.stringify(envelope));
    expect(() => new SecureVault(dir).get('api-key')).toThrow(/failed authentication|refusing/i);
  });
});

describe('SecureVault CRUD + audit', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it('creates, reads, updates, deletes; list never returns values', () => {
    const vault = new SecureVault(dir);
    const meta = vault.create('db-pass', 'hunter2');
    expect(meta.name).toBe('db-pass');
    expect(Object.keys(meta)).not.toContain('value');

    const list = vault.list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('hunter2');

    expect(vault.get('db-pass')?.value).toBe('hunter2');
    vault.update('db-pass', 'hunter3');
    expect(vault.get('db-pass')?.value).toBe('hunter3');
    expect(vault.get('missing')).toBeUndefined();

    expect(vault.delete('db-pass')).toBe(true);
    expect(vault.delete('db-pass')).toBe(false);
    expect(vault.list()).toHaveLength(0);
  });

  it('audits every mutation with names only — never secret values', () => {
    const vault = new SecureVault(dir);
    vault.create('tok', 'TOPSECRET1');
    vault.update('tok', 'TOPSECRET2');
    vault.get('tok');
    vault.get('nope');
    vault.delete('tok');
    const entries = vault.auditLog();
    expect(entries.map((e) => e.action)).toEqual(['create', 'update', 'read-denied', 'delete']);
    for (const e of entries) {
      expect(e.ts).toBeTypeOf('number');
      expect(e.actor).toBe('api');
    }
    const blob = JSON.stringify(entries);
    expect(blob).not.toContain('TOPSECRET1');
    expect(blob).not.toContain('TOPSECRET2');
  });

  it('isolates namespaces (per-user vaults)', () => {
    const a = new SecureVault(dir, 'user-a');
    const b = new SecureVault(dir, 'user-b');
    a.create('tok', 'secret-a');
    expect(b.get('tok')).toBeUndefined();
    expect(b.list()).toHaveLength(0);
  });

  it('validates names and values', () => {
    const vault = new SecureVault(dir);
    expect(() => vault.create('bad name!', 'x')).toThrow(/name/);
    expect(() => vault.create('', 'x')).toThrow(/name/);
    expect(() => vault.create('ok', '')).toThrow(/value/);
    vault.create('dup', 'x');
    expect(() => vault.create('dup', 'y')).toThrow(/already exists/);
  });
});

describe('MockWalletProvider', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  const card = { cardNumber: '4111 1111 1111 1111', expMonth: 12, expYear: 2030, holderName: 'Test User' };

  it('adds/lists/removes methods; only last4 persisted', () => {
    const wallet = new MockWalletProvider(dir);
    const method = wallet.addPaymentMethod(card);
    expect(method.brand).toBe('visa');
    expect(method.last4).toBe('1111');
    expect(Object.keys(method)).not.toContain('cardNumber');

    expect(wallet.listPaymentMethods()).toHaveLength(1);
    const raw = readFileSync(wallet.path(), 'utf8');
    // Encrypted at rest: no full PAN anywhere, and the envelope is ciphertext.
    expect(raw).not.toContain('4111111111111111');
    expect(JSON.parse(raw).alg).toBe('aes-256-gcm');

    expect(wallet.removePaymentMethod(method.id)).toBe(true);
    expect(wallet.removePaymentMethod(method.id)).toBe(false);
    expect(wallet.listPaymentMethods()).toHaveLength(0);
  });

  it('rejects invalid cards', () => {
    const wallet = new MockWalletProvider(dir);
    expect(() => wallet.addPaymentMethod({ ...card, cardNumber: '4111111111111112' })).toThrow(/invalid/);
    expect(() => wallet.addPaymentMethod({ ...card, expMonth: 13 })).toThrow(/month/);
    expect(() => wallet.addPaymentMethod({ ...card, expYear: 1999 })).toThrow(/year/);
  });

  it('refuses charges — no real money path exists', () => {
    const wallet = new MockWalletProvider(dir);
    expect(wallet.chargesEnabled).toBe(false);
    expect(() => wallet.charge({ methodId: 'pm_x', amountMinor: 100, currency: 'USD' })).toThrow(
      /never processes real charges/,
    );
    try {
      wallet.charge({ methodId: 'pm_x', amountMinor: 100, currency: 'USD' });
    } catch (err) {
      expect(isWalletError(err)).toBe(true);
    }
  });
});
