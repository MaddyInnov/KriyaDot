// SPDX-License-Identifier: Apache-2.0
// A14: doctor aggregation + exit codes with fake sections, the REAL
// bridge section against a namesake shim (A8 refusal in plain words)
// and a bad pin (FAIL), and the GET /api/doctor route over a real
// ResourceGuard (B3 seam). Zero paid APIs; all state in tmpdirs.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeChecks, runDoctor, type DoctorCheck, type DoctorSections } from '../src/doctor.js';
import { createDoctorRouter } from '../src/doctor-routes.js';
import {
  NodePressureSampler,
  ResourceGuard,
  loadResourceGuardSettings,
} from '../src/resource-guard.js';
import { resetCliIdentityCache } from '@mvp/agent-runtime';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-a14-'));
  resetCliIdentityCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function section(checks: DoctorCheck[]): DoctorSections {
  const one = (c: DoctorCheck) => () => c;
  return {
    self: one(checks[0] ?? { id: 'server-self', label: 'Server self', status: 'ok', detail: 'fine' }),
    dataDir: one({ id: 'data-dir', label: 'Data directory', status: 'ok', detail: 'fine' }),
    bridges: () => [],
    providers: async () => [{ id: 'providers', label: 'Providers', status: 'ok', detail: 'fine' }],
    pcAccess: one({ id: 'pc-access', label: 'PC file access grants', status: 'ok', detail: 'fine' }),
    sandbox: one({ id: 'plugin-sandbox', label: 'Plugin sandbox', status: 'ok', detail: 'fine' }),
    resourceGuard: one({ id: 'resource-guard', label: 'Resource guard', status: 'ok', detail: 'fine' }),
  };
}

describe('runDoctor aggregation', () => {
  it('all-ok report exits 0', async () => {
    const report = await runDoctor({ dataDir: dir, sections: section([]) });
    expect(report.overall).toBe('ok');
    expect(report.exitCode).toBe(0);
    expect(report.counts).toEqual({ ok: 6, warn: 0, fail: 0 });
  });

  it('a warning does NOT fail the run', async () => {
    const sections = section([]);
    sections.sandbox = () => ({ id: 'plugin-sandbox', label: 'Plugin sandbox', status: 'warn', detail: 'no backend', fix: 'use Linux' });
    const report = await runDoctor({ dataDir: dir, sections });
    expect(report.overall).toBe('warn');
    expect(report.exitCode).toBe(0);
  });

  it('any fail flips the exit code to 1', async () => {
    const sections = section([]);
    sections.dataDir = () => ({ id: 'data-dir', label: 'Data directory', status: 'fail', detail: 'not writable', fix: 'chmod' });
    const report = await runDoctor({ dataDir: dir, sections });
    expect(report.overall).toBe('fail');
    expect(report.exitCode).toBe(1);
    expect(report.counts.fail).toBe(1);
  });

  it('a throwing section degrades to a FAIL line, never a crash', async () => {
    const sections = section([]);
    sections.providers = async () => {
      throw new Error('providers store exploded');
    };
    const report = await runDoctor({ dataDir: dir, sections });
    const providers = report.checks.find((c) => c.id === 'providers');
    expect(providers?.status).toBe('fail');
    expect(providers?.detail).toMatch(/providers store exploded/);
    expect(report.exitCode).toBe(1);
    // The rest of the report still ran.
    expect(report.checks.length).toBe(6);
  });
});

describe('bridge section — real A8 machinery', () => {
  it('a namesake CLI present → the refusal is reported in plain words (warn)', () => {
    const binDir = join(dir, 'bin');
    const home = join(dir, 'home');
    // A "codex" that is really a Python program: banner is a traceback.
    mkdirSync(binDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const shim = join(binDir, 'codex');
    writeFileSync(shim, '#!/bin/sh\necho "Traceback (most recent call last):" >&2\necho "ModuleNotFoundError: No module named codex" >&2\nexit 1\n');
    chmodSync(shim, 0o755);

    const checks = bridgeChecks({ pathDirs: [binDir], homeDir: home });
    const codex = checks.find((c) => c.id === 'bridge-codex');
    expect(codex).toBeDefined();
    expect(codex!.status).toBe('warn');
    expect(codex!.detail).toContain('Found a program named "codex"');
    expect(codex!.detail).toContain("isn't");
    expect(codex!.fix).toMatch(/pin the correct binary|Install the real/);
    // All eight A2 bridges get exactly one line each.
    expect(checks).toHaveLength(8);
  });

  it('a pinned path that does not exist is a FAIL with the pinned wording', () => {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const checks = bridgeChecks({
      pathDirs: [],
      homeDir: home,
      cliPathPins: { claude: join(dir, 'no-such-claude') },
    });
    const claude = checks.find((c) => c.id === 'bridge-claude');
    expect(claude!.status).toBe('fail');
    expect(claude!.detail).toContain('pinned');
    expect(claude!.detail).toContain("doesn't point to a file");
  });

  it('no bridges installed at all is ok (bridges are optional)', () => {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const checks = bridgeChecks({ pathDirs: [join(dir, 'empty-bin')], homeDir: home });
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(checks[0]!.detail).toMatch(/not installed/);
  });
});

describe('GET /api/doctor route (real guard, B3 seam)', () => {
  it('serves the full report shape', async () => {
    const guard = new ResourceGuard({
      settings: loadResourceGuardSettings(dir),
      sampler: new NodePressureSampler(dir),
    });
    guard.sampleNow();
    const app = express();
    app.use('/api/doctor', createDoctorRouter({ dataDir: dir, guard }));
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/doctor`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; report: { checks: DoctorCheck[]; exitCode: number } };
      expect(body.ok).toBe(true);
      const ids = body.report.checks.map((c) => c.id);
      expect(ids).toContain('server-self');
      expect(ids).toContain('data-dir');
      expect(ids).toContain('providers');
      expect(ids).toContain('pc-access');
      expect(ids).toContain('plugin-sandbox');
      expect(ids).toContain('resource-guard');
      expect(ids.filter((i) => i.startsWith('bridge-'))).toHaveLength(8);
      expect([0, 1]).toContain(body.report.exitCode);
    } finally {
      server.close();
      guard.close();
    }
  });
});
