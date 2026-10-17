// SPDX-License-Identifier: Apache-2.0
// Tests for the Sentinel health scanner:
// - runSentinelChecks reports per-check status (DBs, disk, memory, providers)
// - failing checks surface as warnings in the report
// - GET /api/health/detail serves the last report (or runs a fresh one)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSentinelRouter, runSentinelChecks } from '../src/sentinel.js';

describe('runSentinelChecks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports all checks with no paid calls', () => {
    const report = runSentinelChecks({
      dataDir: dir,
      getBots: () => [{ id: 'b1', provider: 'mock' }],
    });
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks) {
      expect(typeof c.ok).toBe('boolean');
      expect(typeof c.detail).toBe('string');
    }
    // No check performs network I/O — provider check is key-presence only.
    expect(report.checks.some((c) => c.name.includes('provider'))).toBe(true);
  });

  it('flags critically low disk as not-ok via the statfs override', () => {
    const report = runSentinelChecks({
      dataDir: dir,
      getBots: () => [],
      statfs: () => ({ bfree: 1, bsize: 4096 }),
    });
    const disk = report.checks.find((c) => c.name === 'disk');
    expect(disk?.ok).toBe(false);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('flags high memory via the rssBytes override', () => {
    const report = runSentinelChecks({
      dataDir: dir,
      getBots: () => [],
      rssBytes: () => 8 * 1024 ** 3,
    });
    const mem = report.checks.find((c) => c.name === 'memory');
    expect(mem?.ok).toBe(false);
  });
});

describe('sentinel router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-r-'));
    const app = express();
    app.use(express.json());
    app.use('/api/health', createSentinelRouter({ dataDir: dir, getBots: () => [] }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/health`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /detail returns a report', async () => {
    const res = await fetch(`${baseUrl}/detail`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { checks: unknown[] } };
    expect(Array.isArray(body.report.checks)).toBe(true);
  });
});
