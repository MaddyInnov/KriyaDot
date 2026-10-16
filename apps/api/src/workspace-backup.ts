// SPDX-License-Identifier: Apache-2.0
// Workspace backup / restore / rollback (OpenMausBot parity P1 #19).
//
// One-click zipped snapshot of the workspace vault + app state, with a
// hard guarantee: secrets NEVER enter the backup. A filename blocklist
// excludes the vault, wallet, provider keys, machine key, OAuth/connected-
// account caches, and anything that looks like a token/secret/credential.
// Restore is two-phase (dry-run diff, then apply) and always takes an
// automatic pre-restore snapshot so a bad restore can be rolled back.
//
// HTTP wiring lives in workspace-backup-routes.ts. Pure-ish logic here:
// only node:fs + jszip.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';

export const WORKSPACE_BACKUP_FORMAT = 'kriyadot.backup';
export const WORKSPACE_BACKUP_VERSION = '1';
export const BACKUP_SNAPSHOTS_DIR = 'backups';

/** Zip entry prefixes: where each side of the backup lands on restore. */
export const BACKUP_DATA_PREFIX = 'data/';
export const BACKUP_WORKSPACE_PREFIX = 'workspace/';
const BACKUP_MANIFEST_NAME = 'backup-manifest.json';

/**
 * Basename patterns that are NEVER backed up. Fail-closed: anything that
 * looks like a secret, token, credential, or private key is excluded, and
 * the exclusion is listed in the backup manifest so the UI can show it.
 */
const SECRET_BASENAME_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^vault(\..*)?\.json$/i, reason: 'secret vault (values never leave the device)' },
  { pattern: /^wallet(\..*)?\.json$/i, reason: 'payment wallet (card details never leave the device)' },
  { pattern: /^providers\.local\.json$/i, reason: 'encrypted provider API keys' },
  { pattern: /^\.machine-key$/i, reason: 'machine key (decrypts provider keys)' },
  { pattern: /^composio-accounts(\..*)?\.json$/i, reason: 'connected-app account tokens' },
  { pattern: /^composio-pending-links(\..*)?\.json$/i, reason: 'pending OAuth link state' },
  { pattern: /token/i, reason: 'looks like an auth token' },
  { pattern: /secret/i, reason: 'looks like a secret' },
  { pattern: /credential/i, reason: 'looks like a credential' },
  { pattern: /oauth/i, reason: 'looks like OAuth state' },
  { pattern: /\.pem$/i, reason: 'private key material' },
  { pattern: /\.key$/i, reason: 'private key material' },
  { pattern: /^\.env(\..*)?$/i, reason: 'environment file (may hold API keys)' },
];

/** Directories never walked during backup. */
const SKIPPED_DIRS = new Set([BACKUP_SNAPSHOTS_DIR, 'node_modules', '.git', '.cache']);

export interface ExcludedFile {
  path: string;
  reason: string;
}

export interface BackupManifestFile {
  format: typeof WORKSPACE_BACKUP_FORMAT;
  version: string;
  createdAt: string;
  appVersion: string;
  /** Archive paths, e.g. `data/notes.json`, `workspace/todo.md`. */
  files: string[];
  excluded: ExcludedFile[];
}

/** Null when the relative path is safe to back up; otherwise the reason. */
export function secretExclusionReason(relPath: string): string | null {
  const base = relPath.split('/').pop() ?? relPath;
  for (const { pattern, reason } of SECRET_BASENAME_PATTERNS) {
    if (pattern.test(base)) return reason;
  }
  return null;
}

function isSkippedDir(relDir: string): boolean {
  return relDir.split('/').some((seg) => SKIPPED_DIRS.has(seg));
}

export interface CollectedFile {
  /** Archive path (`data/...` or `workspace/...`). */
  archivePath: string;
  /** Absolute source path. */
  absPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Walk `rootDir`, collecting files for the backup under `archivePrefix`.
 * Secret-looking files are excluded (returned separately); skipped dirs
 * are not descended into.
 */
export function collectBackupFiles(
  rootDir: string,
  archivePrefix: string,
): { files: CollectedFile[]; excluded: ExcludedFile[] } {
  const files: CollectedFile[] = [];
  const excluded: ExcludedFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't fail the backup
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(rootDir, abs).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!isSkippedDir(rel)) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const reason = secretExclusionReason(rel);
      if (reason) {
        excluded.push({ path: `${archivePrefix}${rel}`, reason });
        continue;
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      files.push({
        archivePath: `${archivePrefix}${rel}`,
        absPath: abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  files.sort((a, b) => (a.archivePath < b.archivePath ? -1 : 1));
  return { files, excluded };
}

export interface BackupDeps {
  dataDir: string;
  workspaceDir: string;
  appVersion?: string;
}

export interface BuiltBackup {
  zip: Buffer;
  manifest: BackupManifestFile;
}

/** Build the full backup zip (in memory). */
export async function buildBackup(deps: BackupDeps): Promise<BuiltBackup> {
  const data = collectBackupFiles(deps.dataDir, BACKUP_DATA_PREFIX);
  const ws = collectBackupFiles(deps.workspaceDir, BACKUP_WORKSPACE_PREFIX);
  const files = [...data.files, ...ws.files];
  const excluded = [...data.excluded, ...ws.excluded];
  const manifest: BackupManifestFile = {
    format: WORKSPACE_BACKUP_FORMAT,
    version: WORKSPACE_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: deps.appVersion ?? 'kriyadot',
    files: files.map((f) => f.archivePath),
    excluded,
  };
  const zip = new JSZip();
  zip.file(BACKUP_MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  for (const f of files) {
    zip.file(f.archivePath, readFileSync(f.absPath));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { zip: buffer, manifest };
}

export function backupFilename(createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, '-').slice(0, 19);
  return `kriyadot-backup-${stamp}.zip`;
}

export interface ParsedBackup {
  manifest: BackupManifestFile;
  /** archivePath → content */
  entries: Map<string, Buffer>;
}

/** Parse + validate a backup zip. Throws on invalid archives. */
export async function parseBackupArchive(buf: Buffer): Promise<ParsedBackup> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('not a valid zip archive');
  }
  const manifestFile = zip.file(BACKUP_MANIFEST_NAME);
  if (!manifestFile) throw new Error('archive is not a KriyaDot backup (missing backup-manifest.json)');
  let manifest: BackupManifestFile;
  try {
    manifest = JSON.parse(await manifestFile.async('string')) as BackupManifestFile;
  } catch {
    throw new Error('backup-manifest.json is not valid JSON');
  }
  if (manifest.format !== WORKSPACE_BACKUP_FORMAT) {
    throw new Error(`unsupported backup format "${(manifest as { format?: string }).format}"`);
  }
  if (manifest.version !== WORKSPACE_BACKUP_VERSION) {
    throw new Error(`unsupported backup version "${manifest.version}"`);
  }
  if (!Array.isArray(manifest.files)) throw new Error('backup manifest is malformed');
  const entries = new Map<string, Buffer>();
  const listed = new Set(manifest.files);
  const jobs: Promise<void>[] = [];
  zip.forEach((relPath, file) => {
    if (file.dir || relPath === BACKUP_MANIFEST_NAME) return;
    if (!listed.has(relPath)) return; // ignore strays not in the manifest
    jobs.push(
      file.async('nodebuffer').then((content) => {
        entries.set(relPath, content);
      }),
    );
  });
  await Promise.all(jobs);
  return { manifest, entries };
}

/**
 * Resolve an archive path to its restore target. Returns null for unsafe
 * or secret-looking paths (fail-closed: skipped, never written).
 */
export function resolveRestoreTarget(
  archivePath: string,
  deps: BackupDeps,
): { absPath: string; rel: string } | null {
  let prefix: string;
  let root: string;
  if (archivePath.startsWith(BACKUP_DATA_PREFIX)) {
    prefix = BACKUP_DATA_PREFIX;
    root = deps.dataDir;
  } else if (archivePath.startsWith(BACKUP_WORKSPACE_PREFIX)) {
    prefix = BACKUP_WORKSPACE_PREFIX;
    root = deps.workspaceDir;
  } else {
    return null;
  }
  const rel = archivePath.slice(prefix.length);
  if (!rel || rel.startsWith('/') || rel.includes('\\')) return null;
  const normalized = normalize(rel);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith('../')) return null;
  // Even if the zip claims to contain one, a secret-looking path is never
  // restored — a hand-crafted archive cannot smuggle credentials back in.
  if (secretExclusionReason(normalized.split(sep).join('/'))) return null;
  const absPath = resolve(root, normalized);
  if (absPath !== resolve(root) && !absPath.startsWith(resolve(root) + sep)) return null;
  return { absPath, rel: normalized.split(sep).join('/') };
}

export interface RestoreDiffEntry {
  path: string;
  change: 'added' | 'overwritten' | 'unchanged';
  size: number;
}

export interface RestoreDiff {
  entries: RestoreDiffEntry[];
  skippedSecrets: { path: string; reason: string }[];
  totals: { added: number; overwritten: number; unchanged: number; skippedSecrets: number };
}

/** Dry-run: what would applying this archive change? No writes. */
export async function dryRunRestore(deps: BackupDeps, buf: Buffer): Promise<RestoreDiff> {
  const { manifest, entries } = await parseBackupArchive(buf);
  const diffEntries: RestoreDiffEntry[] = [];
  const skippedSecrets: { path: string; reason: string }[] = [];
  for (const archivePath of manifest.files) {
    const target = resolveRestoreTarget(archivePath, deps);
    if (!target) {
      skippedSecrets.push({ path: archivePath, reason: 'unsafe or secret-looking path — never restored' });
      continue;
    }
    const content = entries.get(archivePath);
    if (!content) continue; // listed but missing from zip — ignore
    let change: RestoreDiffEntry['change'];
    if (!existsSync(target.absPath)) {
      change = 'added';
    } else {
      let same = false;
      try {
        const current = readFileSync(target.absPath);
        same =
          current.length === content.length &&
          createHash('sha256').update(current).digest('hex') ===
            createHash('sha256').update(content).digest('hex');
      } catch {
        same = false;
      }
      change = same ? 'unchanged' : 'overwritten';
    }
    diffEntries.push({ path: archivePath, change, size: content.length });
  }
  return {
    entries: diffEntries,
    skippedSecrets,
    totals: {
      added: diffEntries.filter((e) => e.change === 'added').length,
      overwritten: diffEntries.filter((e) => e.change === 'overwritten').length,
      unchanged: diffEntries.filter((e) => e.change === 'unchanged').length,
      skippedSecrets: skippedSecrets.length,
    },
  };
}

export interface RestoreResult {
  ok: true;
  added: number;
  overwritten: number;
  skippedSecrets: number;
  /** Snapshot zip filename under <dataDir>/backups — rollback target. */
  snapshot: string;
}

/**
 * Apply a restore: first snapshot the CURRENT state (automatic, for
 * rollback), then write every safe archive entry. Secret-looking entries
 * are skipped even if present in the zip.
 */
export async function applyRestore(
  deps: BackupDeps,
  buf: Buffer,
  opts?: { skipSnapshot?: boolean },
): Promise<RestoreResult> {
  const { manifest, entries } = await parseBackupArchive(buf);
  let snapshot = '';
  if (!opts?.skipSnapshot) {
    snapshot = await takePreRestoreSnapshot(deps);
  }
  let added = 0;
  let overwritten = 0;
  let skippedSecrets = 0;
  for (const archivePath of manifest.files) {
    const target = resolveRestoreTarget(archivePath, deps);
    if (!target) {
      skippedSecrets += 1;
      continue;
    }
    const content = entries.get(archivePath);
    if (!content) continue;
    const existed = existsSync(target.absPath);
    mkdirSync(dirname(target.absPath), { recursive: true });
    writeFileSync(target.absPath, content);
    if (existed) overwritten += 1;
    else added += 1;
  }
  return { ok: true, added, overwritten, skippedSecrets, snapshot };
}

/** Snapshot the current state into <dataDir>/backups/. Returns the filename. */
export async function takePreRestoreSnapshot(deps: BackupDeps): Promise<string> {
  const { zip } = await buildBackup({ ...deps, appVersion: `pre-restore ${new Date().toISOString()}` });
  const dir = join(deps.dataDir, BACKUP_SNAPSHOTS_DIR);
  mkdirSync(dir, { recursive: true });
  const name = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
  writeFileSync(join(dir, name), zip);
  return name;
}

/** List available rollback snapshots (newest first). */
export function listBackupSnapshots(dataDir: string): { name: string; size: number; createdAt: string }[] {
  const dir = join(dataDir, BACKUP_SNAPSHOTS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.zip'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      let size = 0;
      try {
        size = statSync(join(dir, name)).size;
      } catch {
        // ignore
      }
      return { name, size, createdAt: name.replace(/^pre-restore-/, '').replace(/\.zip$/, '') };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/**
 * Roll back to a previously taken snapshot. The snapshot itself is just a
 * backup zip, so this re-applies it — but WITHOUT taking another snapshot
 * (the pre-restore snapshot already covers the current state; chaining
 * snapshots on every rollback would fill the disk).
 */
export async function rollbackToSnapshot(
  deps: BackupDeps,
  snapshotName: string,
): Promise<{ ok: true; added: number; overwritten: number; skippedSecrets: number }> {
  if (!/^pre-restore-[0-9TZ\-:.]+\.zip$/.test(snapshotName) || snapshotName.includes('..')) {
    throw new Error('invalid snapshot name');
  }
  const abs = resolve(join(deps.dataDir, BACKUP_SNAPSHOTS_DIR, snapshotName));
  if (abs !== join(resolve(deps.dataDir), BACKUP_SNAPSHOTS_DIR, snapshotName)) {
    throw new Error('invalid snapshot name');
  }
  if (!existsSync(abs)) throw new Error(`unknown snapshot "${snapshotName}"`);
  const buf = readFileSync(abs);
  const result = await applyRestore(deps, buf, { skipSnapshot: true });
  return { ok: true, added: result.added, overwritten: result.overwritten, skippedSecrets: result.skippedSecrets };
}
