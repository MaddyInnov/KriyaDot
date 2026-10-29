// SPDX-License-Identifier: Apache-2.0
// Scheduled backups: fake-clock/timer firing, retention pruning, and the
// full-deployment archive export round-trip.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  BackupScheduler,
  buildDeploymentArchive,
  parseBackupArchive,
  pruneScheduledBackups,
  scheduledBackupFilename,
  type BackupDeps,
} from '../src/workspace-backup.js';

describe('scheduled backups', () => {
  let dir: string;
  let dataDir: string;
  let workspaceDir: string;
  let deps: BackupDeps;
  let nowMs: number;
  let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-sched-'));
    dataDir = join(dir, 'data');
    workspaceDir = join(dir, 'workspace');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(dataDir, 'notes.json'), '{"notes":[]}');
    writeFileSync(join(workspaceDir, 'todo.md'), '# todo\n');
    deps = { dataDir, workspaceDir, appVersion: 'test' };
    nowMs = Date.parse('2026-10-29T00:00:00Z');
    timers = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeScheduler(): BackupScheduler {
    return new BackupScheduler(deps, {
      now: () => nowMs,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    });
  }

  it('persists schedules and fires on the injected timer', async () => {
    const scheduler = makeScheduler();
    const schedule = scheduler.createSchedule({ id: 'nightly', intervalMs: 60_000, keepCount: 5 });
    expect(schedule.nextRunAt).toBe(new Date(nowMs + 60_000).toISOString());
    expect(existsSync(join(dataDir, 'backup-schedules.json'))).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(60_000);

    // Fire the captured timer callback; the run is async — flush microtasks.
    timers[0].fn();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const after = scheduler.getSchedule('nightly');
    expect(after?.lastRunAt).toBe(new Date(nowMs).toISOString());
    expect(after?.lastArchive).toBe(scheduledBackupFilename('nightly', new Date(nowMs)));
    const backupsDir = join(dataDir, 'backups');
    expect(readdirSync(backupsDir)).toContain(after!.lastArchive!);
    // The archive itself is a valid backup.
    const parsed = await parseBackupArchive(readFileSync(join(backupsDir, after!.lastArchive!)));
    expect(parsed.manifest.files).toContain('workspace/todo.md');

    // A fresh scheduler instance reloads the persisted schedule.
    const reloaded = makeScheduler();
    expect(reloaded.listSchedules().map((s) => s.id)).toEqual(['nightly']);
    expect(scheduler.deleteSchedule('nightly')).toBe(true);
    expect(timers[0].cleared).toBe(true);
  });

  it('runSchedule stamps times and prunes by keepCount', async () => {
    const scheduler = makeScheduler();
    scheduler.createSchedule({ id: 'hourly', intervalMs: 1000, keepCount: 2 });
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      nowMs += 61_000;
      // Distinct mtimes so newest-first ordering is deterministic.
      const { archive } = await scheduler.runSchedule('hourly');
      runs.push(archive);
      const p = join(dataDir, 'backups', archive);
      const t = new Date(nowMs);
      utimesSync(p, t, t);
    }
    const remaining = readdirSync(join(dataDir, 'backups')).filter((n) => n.startsWith('scheduled-'));
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(runs[0]); // oldest pruned
    expect(remaining).toContain(runs[2]);
  });

  it('pruneScheduledBackups honors keepDays and never touches pre-restore snapshots', () => {
    const backupsDir = join(dataDir, 'backups');
    mkdirSync(backupsDir, { recursive: true });
    const old = join(backupsDir, 'scheduled-a-old.zip');
    const fresh = join(backupsDir, 'scheduled-a-fresh.zip');
    const preRestore = join(backupsDir, 'pre-restore-2026-01-01.zip');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    writeFileSync(preRestore, 'x');
    const now = Date.parse('2026-10-29T00:00:00Z');
    utimesSync(old, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
    utimesSync(fresh, new Date(now - 1 * 86_400_000), new Date(now - 1 * 86_400_000));
    utimesSync(preRestore, new Date(now - 90 * 86_400_000), new Date(now - 90 * 86_400_000));
    const removed = pruneScheduledBackups(backupsDir, { keepDays: 30 }, now);
    expect(removed).toEqual(['scheduled-a-old.zip']);
    expect(existsSync(preRestore)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('full-deployment archive export', () => {
  it('zips workspace + config + KB stores, excludes secrets, round-trips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-archive-'));
    try {
      const dataDir = join(dir, 'data');
      const workspaceDir = join(dir, 'workspace');
      const configDir = join(dir, 'config');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(workspaceDir, 'plan.md'), '# plan');
      writeFileSync(join(dataDir, 'notes.json'), '{}');
      const cfg = join(configDir, 'settings.json');
      writeFileSync(cfg, '{"theme":"dark"}');
      const secretCfg = join(configDir, 'api-secret.json');
      writeFileSync(secretCfg, '{"key":"nope"}');
      const kbFile = join(dataDir, 'kb-managed.json');
      writeFileSync(kbFile, '{"corpora":[]}');

      const { zip, manifest } = await buildDeploymentArchive({
        dataDir,
        workspaceDir,
        appVersion: 'test',
        configFiles: [cfg, secretCfg],
        kbFiles: [kbFile],
      });
      expect(manifest.kind).toBe('deployment');
      expect(manifest.files).toContain('workspace/plan.md');
      expect(manifest.files).toContain('config/settings.json');
      expect(manifest.files).toContain('kb/kb-managed.json');
      expect(manifest.files.join('\n')).not.toMatch(/secret/i);
      expect(manifest.excluded.map((e) => e.path)).toContain('config/api-secret.json');

      // Round-trip: the archive parses as a backup and the entries exist.
      const parsed = await parseBackupArchive(zip);
      expect(parsed.manifest.files).toContain('config/settings.json');
      const zipObj = await JSZip.loadAsync(zip);
      expect(await zipObj.file('kb/kb-managed.json')!.async('string')).toBe('{"corpora":[]}');
      expect(zipObj.file('config/api-secret.json')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
