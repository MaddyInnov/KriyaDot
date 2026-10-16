// SPDX-License-Identifier: Apache-2.0
// Tests for workspace backup / restore / rollback (workspace-backup.ts):
// - secrets are NEVER in a backup (vault, wallet, provider keys, machine
//   key, connected-account tokens, .env, key material)
// - dry-run diff (added/overwritten/unchanged)
// - restore applies with an automatic pre-restore snapshot
// - hand-crafted archives cannot smuggle secrets back in
// - rollback restores the pre-restore snapshot
// - path traversal is rejected

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import {
  applyRestore,
  buildBackup,
  dryRunRestore,
  listBackupSnapshots,
  parseBackupArchive,
  resolveRestoreTarget,
  rollbackToSnapshot,
  secretExclusionReason,
  type BackupDeps,
} from '../src/workspace-backup.js';

const FAKE = {
  vault: JSON.stringify({ secrets: [{ name: 'OPENAI_KEY', value: 'sk-fake-secret-12345' }] }),
  wallet: JSON.stringify({ methods: [{ cardNumber: '4111111111111111' }] }),
  providerKeys: JSON.stringify({ encrypted: true }),
  machineKey: 'deadbeef'.repeat(8),
  composio: JSON.stringify({ accounts: [{ token: 'tok_fake' }] }),
  env: 'OPENAI_API_KEY=sk-fake-env-key\n',
  notes: JSON.stringify({ notes: [{ id: 'n1', text: 'hello' }] }),
  todo: '# my tasks\n- [ ] ship it\n',
};

describe('workspace backup', () => {
  let dir: string;
  let dataDir: string;
  let workspaceDir: string;
  let deps: BackupDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-backup-'));
    dataDir = join(dir, 'data');
    workspaceDir = join(dir, 'workspace');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(dataDir, 'vault.json'), FAKE.vault);
    writeFileSync(join(dataDir, 'vault.user.json'), FAKE.vault);
    writeFileSync(join(dataDir, 'wallet.json'), FAKE.wallet);
    writeFileSync(join(dataDir, 'providers.local.json'), FAKE.providerKeys);
    writeFileSync(join(dataDir, '.machine-key'), FAKE.machineKey);
    writeFileSync(join(dataDir, 'composio-accounts.json'), FAKE.composio);
    writeFileSync(join(dataDir, 'notes.json'), FAKE.notes);
    writeFileSync(join(workspaceDir, 'todo.md'), FAKE.todo);
    writeFileSync(join(workspaceDir, '.env'), FAKE.env);
    deps = { dataDir, workspaceDir, appVersion: 'test' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never includes secrets; lists every exclusion', async () => {
    const { zip, manifest } = await buildBackup(deps);
    const names = manifest.files.join('\n');
    // No credential patterns anywhere in the archive file list.
    expect(names).not.toMatch(/vault|wallet|providers\.local|machine-key|composio|\.env/i);
    // Safe files are present.
    expect(manifest.files).toContain('data/notes.json');
    expect(manifest.files).toContain('workspace/todo.md');
    // Every secret file is listed with a reason (the UI shows this).
    const excludedPaths = manifest.excluded.map((e) => e.path);
    for (const p of [
      'data/vault.json',
      'data/vault.user.json',
      'data/wallet.json',
      'data/providers.local.json',
      'data/.machine-key',
      'data/composio-accounts.json',
      'workspace/.env',
    ]) {
      expect(excludedPaths).toContain(p);
    }
    expect(manifest.excluded.every((e) => e.reason.length > 0)).toBe(true);
    // And the raw zip bytes contain no secret values either.
    const raw = zip.toString('latin1');
    expect(raw).not.toContain('sk-fake-secret-12345');
    expect(raw).not.toContain('4111111111111111');
    expect(raw).not.toContain('sk-fake-env-key');
  });

  it('secretExclusionReason catches token/secret/credential/key patterns', () => {
    expect(secretExclusionReason('a/my-tokens.json')).toBeTruthy();
    expect(secretExclusionReason('a/secrets.yaml')).toBeTruthy();
    expect(secretExclusionReason('a/credentials.txt')).toBeTruthy();
    expect(secretExclusionReason('a/id_rsa.key')).toBeTruthy();
    expect(secretExclusionReason('a/cert.pem')).toBeTruthy();
    expect(secretExclusionReason('a/notes.json')).toBeNull();
    expect(secretExclusionReason('workspace/todo.md')).toBeNull();
  });

  it('dry-run reports added/overwritten/unchanged', async () => {
    const { zip } = await buildBackup(deps);
    // Baseline: everything unchanged.
    let diff = await dryRunRestore(deps, zip);
    expect(diff.totals.added).toBe(0);
    expect(diff.totals.overwritten).toBe(0);
    expect(diff.totals.unchanged).toBeGreaterThan(0);

    // Change one file, delete another. Files created on disk AFTER the
    // backup are not archive entries, so the dry-run doesn't list them.
    writeFileSync(join(workspaceDir, 'todo.md'), '# changed\n');
    rmSync(join(dataDir, 'notes.json'));
    writeFileSync(join(workspaceDir, 'new.md'), 'new');
    diff = await dryRunRestore(deps, zip);
    const byPath = new Map(diff.entries.map((e) => [e.path, e.change]));
    expect(byPath.get('workspace/todo.md')).toBe('overwritten');
    expect(byPath.get('data/notes.json')).toBe('added');
    expect(byPath.has('workspace/new.md')).toBe(false);
    expect(diff.totals.added).toBe(1);
    expect(diff.totals.overwritten).toBe(1);
  });

  it('restore applies changes and takes an automatic pre-restore snapshot', async () => {
    const { zip } = await buildBackup(deps);
    writeFileSync(join(workspaceDir, 'todo.md'), '# changed after backup\n');
    const result = await applyRestore(deps, zip);
    expect(result.ok).toBe(true);
    expect(result.overwritten).toBeGreaterThan(0);
    expect(result.snapshot).toMatch(/^pre-restore-.*\.zip$/);
    // The changed file was restored to the backup content.
    expect(readFileSync(join(workspaceDir, 'todo.md'), 'utf8')).toBe(FAKE.todo);
    // Snapshot exists for rollback.
    expect(listBackupSnapshots(dataDir).map((s) => s.name)).toContain(result.snapshot);
  });

  it('a hand-crafted archive cannot smuggle secrets back in', async () => {
    // Build a valid backup, then inject a vault.json entry + path traversal.
    const { zip } = await buildBackup(deps);
    const parsed = await parseBackupArchive(zip);
    const evil = new JSZip();
    evil.file('backup-manifest.json', JSON.stringify({
      ...parsed.manifest,
      files: [...parsed.manifest.files, 'data/vault.json', 'data/../evil.txt'],
    }));
    for (const [p, content] of parsed.entries) evil.file(p, content);
    evil.file('data/vault.json', JSON.stringify({ secrets: [{ name: 'X', value: 'EVIL' }] }));
    evil.file('data/../evil.txt', 'traversal');
    const evilBuf = await evil.generateAsync({ type: 'nodebuffer' });

    const result = await applyRestore(deps, evilBuf);
    expect(result.skippedSecrets).toBeGreaterThanOrEqual(1);
    // vault.json was NOT overwritten with the attacker's content.
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).toBe(FAKE.vault);
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).not.toContain('EVIL');
  });

  it('rollback restores the pre-restore snapshot', async () => {
    const { zip } = await buildBackup(deps);
    writeFileSync(join(workspaceDir, 'todo.md'), '# changed after backup\n');
    const result = await applyRestore(deps, zip);
    // Now break it again, then roll back to the pre-restore snapshot
    // (which captured "# changed after backup").
    writeFileSync(join(workspaceDir, 'todo.md'), '# broken\n');
    const rb = await rollbackToSnapshot(deps, result.snapshot);
    expect(rb.ok).toBe(true);
    expect(readFileSync(join(workspaceDir, 'todo.md'), 'utf8')).toBe('# changed after backup\n');
  });

  it('rejects invalid archives and snapshot names', async () => {
    await expect(parseBackupArchive(Buffer.from('not a zip'))).rejects.toThrow();
    await expect(dryRunRestore(deps, Buffer.from('not a zip'))).rejects.toThrow();
    await expect(rollbackToSnapshot(deps, '../evil.zip')).rejects.toThrow();
    await expect(rollbackToSnapshot(deps, 'nope.zip')).rejects.toThrow();
  });

  it('resolveRestoreTarget rejects traversal and secret paths', () => {
    expect(resolveRestoreTarget('data/../evil.txt', deps)).toBeNull();
    expect(resolveRestoreTarget('data/vault.json', deps)).toBeNull();
    expect(resolveRestoreTarget('/abs/path.txt', deps)).toBeNull();
    expect(resolveRestoreTarget('other/file.txt', deps)).toBeNull();
    const ok = resolveRestoreTarget('workspace/todo.md', deps);
    expect(ok?.absPath).toBe(join(workspaceDir, 'todo.md'));
  });
});
