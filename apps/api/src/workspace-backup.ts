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
  renameSync,
  rmSync,
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

// ---------------------------------------------------------------------------
// Scheduled backups + retention + full-deployment archive export
// (OpenMausBot §1.18 scheduled backups; Octop deployment parity).
//
// Schedules persist in <dataDir>/backup-schedules.json. The scheduler's
// clock and timer functions are injectable so tests drive firing with a
// fake clock — no real waiting, no fake-timer library.
// ---------------------------------------------------------------------------

export interface BackupSchedule {
  id: string;
  intervalMs: number;
  enabled: boolean;
  /** Retention: keep at most this many scheduled archives. */
  keepCount?: number;
  /** Retention: drop scheduled archives older than this many days. */
  keepDays?: number;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastArchive?: string;
}

export interface BackupSchedulerOptions {
  /** Clock injection (tests). Default: Date.now. */
  now?: () => number;
  /** Timer injection (tests). Must return a handle accepted by clearTimer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Directory scheduled archives land in. Default <dataDir>/backups. */
  snapshotDir?: string;
}

const SCHEDULES_FILE = 'backup-schedules.json';
export const SCHEDULED_BACKUP_PREFIX = 'scheduled-';

export function scheduledBackupFilename(scheduleId: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeId = scheduleId.replace(/[^A-Za-z0-9_-]/g, '');
  return `${SCHEDULED_BACKUP_PREFIX}${safeId}-${stamp}.zip`;
}

/**
 * Prune scheduled archives in `dir` per retention policy. Only files with
 * the scheduled- prefix are considered (pre-restore snapshots are never
 * pruned here). Returns the removed filenames.
 */
export function pruneScheduledBackups(
  dir: string,
  policy: { keepCount?: number; keepDays?: number },
  nowMs: number = Date.now(),
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(SCHEDULED_BACKUP_PREFIX) && n.endsWith('.zip'));
  } catch {
    return [];
  }
  const entries = names
    .map((name) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(dir, name)).mtimeMs;
      } catch { /* ignore */ }
      return { name, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1)); // newest first
  const removed: string[] = [];
  entries.forEach((entry, idx) => {
    const tooMany = policy.keepCount !== undefined && idx >= policy.keepCount;
    const tooOld =
      policy.keepDays !== undefined && nowMs - entry.mtimeMs > policy.keepDays * 86_400_000;
    if (tooMany || tooOld) {
      try {
        rmSync(join(dir, entry.name));
        removed.push(entry.name);
      } catch { /* ignore */ }
    }
  });
  return removed;
}

export class BackupScheduler {
  private readonly deps: BackupDeps;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly snapshotDir: string;
  private readonly timers = new Map<string, unknown>();
  private schedules: BackupSchedule[];

  constructor(deps: BackupDeps, opts: BackupSchedulerOptions = {}) {
    this.deps = deps;
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
        return t;
      });
    this.clearTimer =
      opts.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.snapshotDir = opts.snapshotDir ?? join(deps.dataDir, BACKUP_SNAPSHOTS_DIR);
    this.schedules = this.load();
  }

  private schedulesPath(): string {
    return join(this.deps.dataDir, SCHEDULES_FILE);
  }

  private load(): BackupSchedule[] {
    try {
      const parsed = JSON.parse(readFileSync(this.schedulesPath(), 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (s): s is BackupSchedule =>
          typeof s === 'object' && s !== null &&
          typeof (s as BackupSchedule).id === 'string' &&
          typeof (s as BackupSchedule).intervalMs === 'number',
      );
    } catch {
      return [];
    }
  }

  private persist(): void {
    mkdirSync(this.deps.dataDir, { recursive: true });
    const tmp = `${this.schedulesPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.schedules, null, 2), 'utf8');
    renameSync(tmp, this.schedulesPath());
  }

  listSchedules(): BackupSchedule[] {
    return this.schedules.map((s) => ({ ...s }));
  }

  getSchedule(id: string): BackupSchedule | undefined {
    const s = this.schedules.find((x) => x.id === id);
    return s ? { ...s } : undefined;
  }

  createSchedule(input: {
    id: string;
    intervalMs: number;
    enabled?: boolean;
    keepCount?: number;
    keepDays?: number;
  }): BackupSchedule {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new Error(`invalid schedule id: ${input.id}`);
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
      throw new Error('schedule intervalMs must be a positive number');
    }
    if (this.schedules.some((s) => s.id === input.id)) throw new Error(`schedule already exists: ${input.id}`);
    const nowIso = new Date(this.now()).toISOString();
    const schedule: BackupSchedule = {
      id: input.id,
      intervalMs: Math.floor(input.intervalMs),
      enabled: input.enabled ?? true,
      keepCount: input.keepCount,
      keepDays: input.keepDays,
      createdAt: nowIso,
      nextRunAt: new Date(this.now() + input.intervalMs).toISOString(),
    };
    this.schedules.push(schedule);
    this.persist();
    if (schedule.enabled) this.arm(schedule);
    return { ...schedule };
  }

  deleteSchedule(id: string): boolean {
    const before = this.schedules.length;
    this.disarm(id);
    this.schedules = this.schedules.filter((s) => s.id !== id);
    if (this.schedules.length !== before) this.persist();
    return this.schedules.length !== before;
  }

  /** Arm timers for every enabled schedule (call at boot). */
  startAll(): void {
    for (const s of this.schedules) if (s.enabled) this.arm(s);
  }

  stopAll(): void {
    for (const id of [...this.timers.keys()]) this.disarm(id);
  }

  private arm(schedule: BackupSchedule): void {
    this.disarm(schedule.id);
    const handle = this.setTimer(() => {
      void this.runSchedule(schedule.id).catch(() => {
        // A failed scheduled backup must never take the scheduler down;
        // lastRunAt/nextRunAt still advance on the next manual inspection.
      });
    }, schedule.intervalMs);
    this.timers.set(schedule.id, handle);
  }

  private disarm(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.timers.delete(id);
    }
  }

  /**
   * Run one schedule now: build a backup, write it as a scheduled archive,
   * stamp last/next run, and prune per the schedule's retention policy.
   */
  async runSchedule(id: string): Promise<{ archive: string; pruned: string[]; schedule: BackupSchedule }> {
    const schedule = this.schedules.find((s) => s.id === id);
    if (!schedule) throw new Error(`unknown backup schedule: ${id}`);
    const { zip } = await buildBackup(this.deps);
    mkdirSync(this.snapshotDir, { recursive: true });
    const archive = scheduledBackupFilename(id, new Date(this.now()));
    writeFileSync(join(this.snapshotDir, archive), zip);
    const nowIso = new Date(this.now()).toISOString();
    schedule.lastRunAt = nowIso;
    schedule.lastArchive = archive;
    schedule.nextRunAt = new Date(this.now() + schedule.intervalMs).toISOString();
    this.persist();
    const pruned = pruneScheduledBackups(
      this.snapshotDir,
      { keepCount: schedule.keepCount, keepDays: schedule.keepDays },
      this.now(),
    );
    return { archive, pruned, schedule: { ...schedule } };
  }
}

// ---------------------------------------------------------------------------
// Full-deployment archive export
// ---------------------------------------------------------------------------

export interface DeploymentArchiveDeps extends BackupDeps {
  /** Explicit config files to include under `config/` (secret-named files are excluded by the same blocklist). */
  configFiles?: string[];
  /** Knowledge-base store files to include under `kb/`. */
  kbFiles?: string[];
  /** Extra roots walked like the workspace, under `extra/<label>/`. */
  extraRoots?: Array<{ label: string; dir: string }>;
}

export interface DeploymentManifest extends BackupManifestFile {
  kind: 'deployment';
  configFiles: string[];
  kbFiles: string[];
}

/**
 * Build a full-deployment archive: the standard workspace backup (data/ +
 * workspace/, secrets excluded) PLUS explicit config files, KB store
 * files, and any extra roots — all through the same secret blocklist.
 */
export async function buildDeploymentArchive(
  deps: DeploymentArchiveDeps,
): Promise<{ zip: Buffer; manifest: DeploymentManifest }> {
  const base = await buildBackup(deps);
  const zip = await JSZip.loadAsync(base.zip);
  const extraManifest = zip.file(BACKUP_MANIFEST_NAME);
  const baseManifest = JSON.parse(await extraManifest!.async('string')) as BackupManifestFile;
  const files = [...baseManifest.files];
  const excluded = [...baseManifest.excluded];

  const addFile = (absPath: string, archivePath: string): void => {
    const reason = secretExclusionReason(archivePath);
    if (reason) {
      excluded.push({ path: archivePath, reason });
      return;
    }
    if (!existsSync(absPath)) return;
    zip.file(archivePath, readFileSync(absPath));
    files.push(archivePath);
  };

  const configFiles: string[] = [];
  for (const cfg of deps.configFiles ?? []) {
    const archivePath = `config/${cfg.split('/').pop() ?? cfg}`;
    const before = files.length;
    addFile(cfg, archivePath);
    if (files.length > before) configFiles.push(archivePath);
  }
  const kbFiles: string[] = [];
  for (const kb of deps.kbFiles ?? []) {
    const archivePath = `kb/${kb.split('/').pop() ?? kb}`;
    const before = files.length;
    addFile(kb, archivePath);
    if (files.length > before) kbFiles.push(archivePath);
  }
  for (const root of deps.extraRoots ?? []) {
    const collected = collectBackupFiles(root.dir, `extra/${root.label}/`);
    for (const f of collected.files) {
      zip.file(f.archivePath, readFileSync(f.absPath));
      files.push(f.archivePath);
    }
    excluded.push(...collected.excluded);
  }

  const manifest: DeploymentManifest = {
    ...baseManifest,
    kind: 'deployment',
    files,
    excluded,
    configFiles,
    kbFiles,
  };
  zip.file(BACKUP_MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { zip: buffer, manifest };
}
