// SPDX-License-Identifier: Apache-2.0
// Sentinel health scanner (OpenMausBot parity): a cheap scheduled
// self-check that verifies the server's own vitals and surfaces problems
// as warnings — before the user trips over them.
//
//   GET /api/health/detail → the latest report (runs the checks fresh when
//                            the cached report is older than the interval)
//
// Checks (all local, zero paid API calls, zero network):
// - databases: the data dir is writable and the core SQLite files open
// - disk: free space on the data-dir filesystem (warn < 1 GB, fail < 200 MB)
// - providers: for every provider id used by the bots, is a key configured
//   (env / stored key synced to env — presence only, never a live call)
// - memory: RSS vs thresholds (warn > 1.5 GB, fail > 2.5 GB)
// - uptime: process uptime is reported (informational)
//
// The scheduler (startSentinel, called from index.ts) re-runs the checks
// every 30 minutes, persists the report to <dataDir>/sentinel-report.json,
// and audit-logs it so it shows up in the Activity → audit trail. Failing
// checks surface as `warnings[]` (and `ok: false` when any check fails).
//
// HOST WIRING (index.ts):
//   import { createSentinelRouter, runSentinelChecks, startSentinel } from './sentinel.js';
//   router.use('/health', createSentinelRouter({ dataDir, getBots }));
//   startSentinel({ dataDir, getBots, audit });

import express, { type Router } from 'express';
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '@mvp/agent-runtime';
import { envKeyFor } from './providers.js';

export interface SentinelCheck {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

export interface SentinelReport {
  at: number;
  ok: boolean;
  warnings: string[];
  checks: SentinelCheck[];
}

const REPORT_FILE = 'sentinel-report.json';
/** Re-run the checks when the cached report is older than this. */
export const SENTINEL_INTERVAL_MS = 30 * 60 * 1000;
const DISK_WARN_BYTES = 1 * 1024 * 1024 * 1024;
const DISK_FAIL_BYTES = 200 * 1024 * 1024;
const MEM_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;
const MEM_FAIL_BYTES = 2.5 * 1024 * 1024 * 1024;

/** Core SQLite files that must open (subset — cheap smoke, not an inventory). */
const CORE_DBS = ['teams.db', 'tiered-memory.db', 'chat-threads.db', 'credential-proposals.db'];

export interface SentinelDeps {
  dataDir: string;
  getBots: () => Array<{ id: string; provider?: string }>;
  /** Override for tests (bytes free). */
  statfs?: (path: string) => { bfree: number; bsize: number };
  /** Override for tests (RSS bytes). */
  rssBytes?: () => number;
}

/** Run every check synchronously. Never throws — a failed check is a report row, not an exception. */
export function runSentinelChecks(deps: SentinelDeps): SentinelReport {
  const checks: SentinelCheck[] = [];
  const warnings: string[] = [];

  // 1. Databases open.
  try {
    mkdirSync(deps.dataDir, { recursive: true });
    const missing: string[] = [];
    for (const db of CORE_DBS) {
      try {
        const handle = openDb(join(deps.dataDir, db));
        handle.exec('SELECT 1');
        handle.close();
      } catch {
        missing.push(db);
      }
    }
    // The data dir itself must be writable.
    try {
      writeFileSync(join(deps.dataDir, '.sentinel-write-test'), 'ok', 'utf8');
    } catch {
      missing.push('(data dir not writable)');
    }
    const ok = missing.length === 0;
    checks.push({
      name: 'databases',
      ok,
      detail: ok ? `${CORE_DBS.length} core DBs open, data dir writable` : `problems: ${missing.join(', ')}`,
    });
    if (!ok) warnings.push(`Database check failed: ${missing.join(', ')}`);
  } catch (err) {
    checks.push({ name: 'databases', ok: false, detail: `check error: ${err instanceof Error ? err.message : String(err)}` });
    warnings.push('Database check errored');
  }

  // 2. Disk space.
  try {
    const st = deps.statfs ? deps.statfs(deps.dataDir) : statfsSync(deps.dataDir);
    const free = st.bfree * st.bsize;
    const gb = (free / 1024 ** 3).toFixed(2);
    if (free < DISK_FAIL_BYTES) {
      checks.push({ name: 'disk', ok: false, detail: `only ${gb} GB free on the data-dir filesystem` });
      warnings.push(`Disk critically low: ${gb} GB free`);
    } else if (free < DISK_WARN_BYTES) {
      checks.push({ name: 'disk', ok: true, warn: true, detail: `${gb} GB free on the data-dir filesystem` });
      warnings.push(`Disk low: ${gb} GB free`);
    } else {
      checks.push({ name: 'disk', ok: true, detail: `${gb} GB free on the data-dir filesystem` });
    }
  } catch (err) {
    checks.push({ name: 'disk', ok: false, detail: `statfs failed: ${err instanceof Error ? err.message : String(err)}` });
    warnings.push('Disk check errored');
  }

  // 3. Provider reachability — config presence ONLY (no paid calls, no network).
  try {
    const providers = [...new Set(deps.getBots().map((b) => b.provider ?? 'groq'))];
    const unconfigured = providers.filter((p) => {
      const envKey = envKeyFor(p);
      return !envKey || !process.env[envKey];
    });
    if (unconfigured.length === 0) {
      checks.push({ name: 'providers', ok: true, detail: `${providers.length} provider(s) have keys configured (presence only, no live calls)` });
    } else {
      checks.push({
        name: 'providers',
        ok: true,
        warn: true,
        detail: `no key configured for: ${unconfigured.join(', ')} (presence only, no live calls)`,
      });
      warnings.push(`Providers without keys: ${unconfigured.join(', ')}`);
    }
  } catch (err) {
    checks.push({ name: 'providers', ok: false, detail: `check error: ${err instanceof Error ? err.message : String(err)}` });
    warnings.push('Provider check errored');
  }

  // 4. Memory usage.
  try {
    const rss = deps.rssBytes ? deps.rssBytes() : process.memoryUsage().rss;
    const mb = Math.round(rss / 1024 ** 2);
    if (rss > MEM_FAIL_BYTES) {
      checks.push({ name: 'memory', ok: false, detail: `RSS ${mb} MB exceeds ${Math.round(MEM_FAIL_BYTES / 1024 ** 2)} MB` });
      warnings.push(`Memory critically high: RSS ${mb} MB`);
    } else if (rss > MEM_WARN_BYTES) {
      checks.push({ name: 'memory', ok: true, warn: true, detail: `RSS ${mb} MB` });
      warnings.push(`Memory high: RSS ${mb} MB`);
    } else {
      checks.push({ name: 'memory', ok: true, detail: `RSS ${mb} MB` });
    }
  } catch (err) {
    checks.push({ name: 'memory', ok: false, detail: `check error: ${err instanceof Error ? err.message : String(err)}` });
    warnings.push('Memory check errored');
  }

  // 5. Uptime (informational).
  const uptimeMin = Math.round(process.uptime() / 60);
  checks.push({ name: 'uptime', ok: true, detail: `process up ${uptimeMin} min` });

  const ok = checks.every((c) => c.ok);
  return { at: Date.now(), ok, warnings, checks };
}

function reportPath(dataDir: string): string {
  return join(dataDir, REPORT_FILE);
}

export function readSentinelReport(dataDir: string): SentinelReport | undefined {
  try {
    const raw = readFileSync(reportPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as SentinelReport;
    if (typeof parsed.at !== 'number' || !Array.isArray(parsed.checks)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeSentinelReport(dataDir: string, report: SentinelReport): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${reportPath(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmp, reportPath(dataDir));
}

export interface SentinelRouterDeps {
  dataDir: string;
  getBots: () => Array<{ id: string; provider?: string }>;
}

export function createSentinelRouter(deps: SentinelRouterDeps): Router {
  const router = express.Router();
  router.get('/detail', (_req, res) => {
    try {
      let report = readSentinelReport(deps.dataDir);
      if (!report || Date.now() - report.at > SENTINEL_INTERVAL_MS) {
        report = runSentinelChecks(deps);
        writeSentinelReport(deps.dataDir, report);
      }
      res.json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Sentinel check failed', detail: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}

export interface SentinelSchedulerDeps extends SentinelDeps {
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  intervalMs?: number;
}

/**
 * Scheduled self-check: run the checks every interval, persist the report,
 * and audit-log it (visible in Activity → audit). Unref'd timer.
 */
export function startSentinel(deps: SentinelSchedulerDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? SENTINEL_INTERVAL_MS;
  const run = (): void => {
    try {
      const report = runSentinelChecks(deps);
      writeSentinelReport(deps.dataDir, report);
      deps.audit('sentinel.report', {
        actor: 'system',
        detail: { ok: report.ok, warnings: report.warnings },
      });
    } catch {
      // sentinel must never break the server
    }
  };
  // First run shortly after boot so /health/detail is warm.
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, intervalMs);
  for (const t of [first, timer]) {
    if (typeof t.unref === 'function') t.unref();
  }
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
