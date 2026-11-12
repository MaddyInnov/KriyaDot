// SPDX-License-Identifier: Apache-2.0
// A14: `kriyadot doctor` CLI rendering + exit-code contract, against a
// fake API: warn never fails the run, fail exits 1, --json prints the
// raw report, and an unreachable server still gets a plain answer.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { KriyaDotApi } from '../src/api.js';
import type { DoctorReportShape } from '../src/service-commands.js';
import { makeDeps, makeFakeApi } from './fake-api.js';

function reportWith(checks: DoctorReportShape['checks']): DoctorReportShape {
  const counts = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
  return {
    at: 1_700_000_000_000,
    overall: counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'ok',
    exitCode: counts.fail > 0 ? 1 : 0,
    counts,
    checks,
  };
}

function depsWithReport(report: DoctorReportShape) {
  const fake = makeFakeApi({});
  const base = fake.asApi();
  const api = {
    ...base,
    request: async (path: string) => {
      if (path === '/doctor') return { ok: true, report };
      throw new Error(`unexpected path ${path}`);
    },
  } as unknown as KriyaDotApi;
  return makeDeps(fake, { api });
}

describe('kriyadot doctor', () => {
  it('renders one plain line per check and exits 0 when all ok', async () => {
    const deps = depsWithReport(
      reportWith([
        { id: 'server-self', label: 'Server self', status: 'ok', detail: 'Server process healthy.' },
        { id: 'data-dir', label: 'Data directory', status: 'ok', detail: 'Writable, 42 GB free.' },
      ]),
    );
    const code = await runCommand(parseArgs(['doctor']), deps);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toContain('OK    Server self — Server process healthy.');
    expect(deps.stdoutText()).toContain('Result: OK — 0 failing, 0 warning(s), 2 ok.');
  });

  it('warnings print their fix hint but do NOT fail the run', async () => {
    const deps = depsWithReport(
      reportWith([
        {
          id: 'bridge-codex',
          label: 'Bridge — Codex',
          status: 'warn',
          detail: 'Found a program named "codex" on this machine, but it isn\'t OpenAI Codex.',
          fix: 'Install the real Codex.',
        },
      ]),
    );
    const code = await runCommand(parseArgs(['doctor']), deps);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toContain('WARN  Bridge — Codex');
    expect(deps.stdoutText()).toContain('Fix: Install the real Codex.');
    expect(deps.stdoutText()).toContain('Result: WARN');
  });

  it('a fail exits 1', async () => {
    const deps = depsWithReport(
      reportWith([{ id: 'data-dir', label: 'Data directory', status: 'fail', detail: 'Not writable.', fix: 'Fix permissions.' }]),
    );
    const code = await runCommand(parseArgs(['doctor']), deps);
    expect(code).toBe(1);
    expect(deps.stdoutText()).toContain('FAIL  Data directory — Not writable.');
  });

  it('--json prints the raw report and keeps the exit code', async () => {
    const report = reportWith([{ id: 'x', label: 'X', status: 'fail', detail: 'bad' }]);
    const deps = depsWithReport(report);
    const code = await runCommand(parseArgs(['doctor', '--json']), deps);
    expect(code).toBe(1);
    expect(JSON.parse(deps.stdoutText())).toEqual(report);
  });

  it('--format json also yields the raw report', async () => {
    const report = reportWith([{ id: 'x', label: 'X', status: 'ok', detail: 'fine' }]);
    const deps = depsWithReport(report);
    const code = await runCommand(parseArgs(['doctor', '--format', 'json']), deps);
    expect(code).toBe(0);
    expect(JSON.parse(deps.stdoutText()).overall).toBe('ok');
  });

  it('an unreachable server produces one plain FAIL line and exit 1', async () => {
    const fake = makeFakeApi({});
    const base = fake.asApi();
    const api = {
      ...base,
      request: async () => {
        throw new Error('Cannot reach KriyaDot API at http://localhost:4000: fetch failed');
      },
    } as unknown as KriyaDotApi;
    const deps = makeDeps(fake, { api });
    const code = await runCommand(parseArgs(['doctor']), deps);
    expect(code).toBe(1);
    expect(deps.stdoutText()).toContain('FAIL  Server reachable');
    expect(deps.stdoutText()).toContain('Start the server');
  });
});
