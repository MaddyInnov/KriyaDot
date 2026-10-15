// SPDX-License-Identifier: Apache-2.0
// Tests for the `mvp-server scan` subcommand (apps/api/src/cli.ts):
// - parseScanArgs: defaults, flags, usage errors
// - runScanCli with an injected scan stub: never touches the real fs walk
//   beyond the dir check, never the network; asserts JSON/pretty output
//   shapes, exit codes, and error paths.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCAN_USAGE, ScanArgError, parseScanArgs, runScanCli } from '../src/cli.js';
import type { ScanCliDeps } from '../src/cli.js';
import type { ScanResult } from '@mvp/marketplace';

const RESULT: ScanResult = {
  dir: '/tmp/demo',
  signals: {
    dir: '/tmp/demo',
    languages: ['node'],
    typescript: false,
    apiServer: false,
    frontend: false,
    hasDockerfile: true,
    hasCompose: false,
    hasCI: false,
    hasGit: false,
    hasTests: false,
    hasDocs: false,
    hasDatabase: false,
    hasCsv: false,
    hasMakefile: false,
    dependencies: ['express'],
  },
  recommendations: [
    { id: 'code-reviewer', kind: 'bot', name: 'Code Reviewer', reason: 'source code detected' },
  ],
  catalogSource: 'marketplace-registry',
  catalogSize: 43,
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];
let errs: string[];

function captureConsole() {
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
}

afterEach(() => {
  logSpy?.mockRestore();
  errSpy?.mockRestore();
});

function depsWith(dir: string, overrides: Partial<ScanCliDeps> = {}): { deps: ScanCliDeps; seen: { dir?: string } } {
  const seen: { dir?: string } = {};
  const deps: ScanCliDeps = {
    scan: (d: string) => {
      seen.dir = d;
      return { ...RESULT, dir: d };
    },
    cwd: () => dir,
    ...overrides,
  };
  return { deps, seen };
}

describe('parseScanArgs', () => {
  it('defaults to cwd with pretty output', () => {
    const parsed = parseScanArgs(['scan']);
    expect(parsed.dir).toBeUndefined();
    expect(parsed).toMatchObject({ json: false, pretty: true, help: false });
  });

  it('accepts a dir and --json', () => {
    expect(parseScanArgs(['scan', '/tmp/x', '--json'])).toMatchObject({ dir: '/tmp/x', json: true, pretty: false });
  });

  it('rejects unknown flags and a second positional', () => {
    expect(() => parseScanArgs(['scan', '--nope'])).toThrow(ScanArgError);
    expect(() => parseScanArgs(['scan', 'a', 'b'])).toThrow(/only one dir/);
  });

  it('exposes usage text', () => {
    expect(SCAN_USAGE).toMatch(/mvp-server scan/);
  });
});

describe('runScanCli', () => {
  it('prints pretty output and exits 0', async () => {
    captureConsole();
    const dir = mkdtempSync(join(tmpdir(), 'scan-cli-'));
    const { deps, seen } = depsWith(dir);
    const code = await runScanCli(['scan'], deps);
    expect(code).toBe(0);
    expect(seen.dir).toBe(dir);
    const out = logs.join('\n');
    expect(out).toMatch(/kriyadot scan/);
    expect(out).toMatch(/code-reviewer \(bot\)/);
    expect(out).toMatch(/offline/);
  });

  it('prints a single JSON object with --json', async () => {
    captureConsole();
    const dir = mkdtempSync(join(tmpdir(), 'scan-cli-'));
    const { deps } = depsWith(dir);
    const code = await runScanCli(['scan', '--json'], deps);
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.recommendations[0].id).toBe('code-reviewer');
    expect(parsed.signals.hasDockerfile).toBe(true);
  });

  it('resolves a relative dir against cwd', async () => {
    captureConsole();
    const dir = mkdtempSync(join(tmpdir(), 'scan-cli-'));
    const { deps, seen } = depsWith(dir);
    const code = await runScanCli(['scan', '.'], deps);
    expect(code).toBe(0);
    expect(seen.dir).toBe(dir);
  });

  it('exits 1 for a missing directory', async () => {
    captureConsole();
    const dir = mkdtempSync(join(tmpdir(), 'scan-cli-'));
    const { deps } = depsWith(dir);
    const code = await runScanCli(['scan', join(dir, 'nope')]);
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/not a directory/);
  });

  it('exits 1 for a missing directory in JSON mode (machine-readable)', async () => {
    captureConsole();
    const dir = mkdtempSync(join(tmpdir(), 'scan-cli-'));
    const { deps } = depsWith(dir);
    const code = await runScanCli(['scan', join(dir, 'nope'), '--json'], deps);
    expect(code).toBe(1);
    expect(JSON.parse(logs[0]).error).toMatch(/not a directory/);
  });

  it('shows usage for --help and exits 0 without scanning', async () => {
    captureConsole();
    let scanned = false;
    const code = await runScanCli(['scan', '--help'], {
      scan: () => {
        scanned = true;
        return RESULT;
      },
    });
    expect(code).toBe(0);
    expect(scanned).toBe(false);
    expect(logs.join('\n')).toMatch(/mvp-server scan/);
  });

  it('exits 1 on bad flags', async () => {
    captureConsole();
    const code = await runScanCli(['scan', '--bogus']);
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/unknown flag/);
  });
});
