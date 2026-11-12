// SPDX-License-Identifier: Apache-2.0
// Timon parity A8 — deeper CLI binary identity + user-pinnable CLI path:
// - identity patterns are DECLARED data for all 3 bridges and drive probing
// - probe results are cached per file by (path + size + mtime): an
//   unchanged file is never re-spawned (counted via a shim that logs
//   every invocation); a size OR mtime change invalidates the entry
// - matching is ReDoS-safe: a hostile shim printing pathological output
//   completes within a bound, and dangerous regex declarations are refused
// - refusals quote the program's first printed line with secrets redacted
// - user pins are honoured, still identity-checked, and clearing a pin
//   returns resolution to auto-detection

import { chmodSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLI_IDENTITY_DECLARATIONS,
  assertSafeRegexPattern,
  bridgeNamesakeMessage,
  bridgePinnedMessage,
  bridgeResolutionFailureMessage,
  getCliPathPin,
  matchIdentity,
  pinnedCliCandidates,
  probeCliIdentity,
  redactCliSecrets,
  resetCliIdentityCache,
  resetCliPathPins,
  resolveVerifiedCliExecutable,
  setCliPathPin,
  summarizeCliFailure,
} from '../src/index.js';

let binA = '';
let binB = '';
let home = '';

function script(lines: string[]): string {
  return ['#!/bin/sh', ...lines, ''].join('\n');
}

function plant(binDir: string, name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

/** Shim that counts its own invocations in a sibling log file. */
function plantCounting(binDir: string, name: string, versionLine: string): { exe: string; countFile: string } {
  const countFile = join(binDir, `${name}.count`);
  writeFileSync(countFile, '0');
  const exe = plant(
    binDir,
    name,
    script([
      `c=$(cat ${JSON.stringify(countFile)}); echo $((c+1)) > ${JSON.stringify(countFile)}`,
      `if [ "$1" = "--version" ]; then echo ${JSON.stringify(versionLine)}; exit 0; fi`,
      'exit 0',
    ]),
  );
  return { exe, countFile };
}

function countOf(countFile: string): number {
  return Number.parseInt(readFileSync(countFile, 'utf8').trim(), 10);
}

beforeEach(() => {
  binA = mkdtempSync(join(tmpdir(), 'a8-binA-'));
  binB = mkdtempSync(join(tmpdir(), 'a8-binB-'));
  home = mkdtempSync(join(tmpdir(), 'a8-home-'));
  resetCliIdentityCache();
  resetCliPathPins();
  delete process.env.KRIYADOT_CLI_PATH_CLAUDE;
  delete process.env.KRIYADOT_CLI_PATH_CODEX;
  delete process.env.KRIYADOT_CLI_PATH_OPENCODE;
});

afterEach(() => {
  resetCliIdentityCache();
  resetCliPathPins();
  delete process.env.KRIYADOT_CLI_PATH_CLAUDE;
  delete process.env.KRIYADOT_CLI_PATH_CODEX;
  delete process.env.KRIYADOT_CLI_PATH_OPENCODE;
});

describe('declared identity patterns (A8 §1)', () => {
  it('declares plain-data probes for all 3 bridges', () => {
    expect(Object.keys(CLI_IDENTITY_DECLARATIONS).sort()).toEqual(['claude', 'codex', 'opencode']);
    for (const decl of Object.values(CLI_IDENTITY_DECLARATIONS)) {
      expect(decl.versionArgs).toEqual(['--version']);
      expect(decl.commandName.length).toBeGreaterThan(0);
      // Manifest-ready: the declaration survives a JSON round-trip
      // unchanged (no RegExp objects, no functions).
      expect(JSON.parse(JSON.stringify(decl))).toEqual(decl);
    }
    expect(CLI_IDENTITY_DECLARATIONS.opencode.helpArgs).toEqual(['--help']);
  });

  it('declared patterns resolve the real banner of each bridge', () => {
    const claude = plant(binA, 'claude', script(['echo "2.1.316 (Claude Code)"']));
    expect(probeCliIdentity('claude', claude)).toMatchObject({ ok: true, version: '2.1.316' });
    const codex = plant(binA, 'codex', script(['echo "codex-cli 0.142.0"']));
    expect(probeCliIdentity('codex', codex)).toMatchObject({ ok: true, version: '0.142.0' });
    const opencode = plant(binA, 'opencode', script(['echo "1.0.119"']));
    expect(probeCliIdentity('opencode', opencode)).toMatchObject({ ok: true, version: '1.0.119' });
  });

  it('declared patterns reject wrong banners for each bridge', () => {
    const claude = plant(binA, 'claude', script(['echo "some other tool 9.9.9"']));
    expect(probeCliIdentity('claude', claude).ok).toBe(false);
    // "codex" mentioned mid-line is not the anchored codex-cli banner.
    const codex = plant(binA, 'codex', script(['echo "error in /x/codex/main.py"']));
    expect(probeCliIdentity('codex', codex).ok).toBe(false);
    // opencode fallback: a non-semver --version falls through to the
    // declared --help match, and a help text that never names the tool
    // is rejected. (A bare semver --version is accepted on its own —
    // that is the shipped v0.2.2 behaviour the declaration restates.)
    const opencode = plant(
      binA,
      'opencode',
      script([
        'if [ "$1" = "--version" ]; then echo "not-a-version"; exit 0; fi',
        'echo "totally different help"',
      ]),
    );
    expect(probeCliIdentity('opencode', opencode).ok).toBe(false);
    const opencode2 = plant(
      binB,
      'opencode',
      script([
        'if [ "$1" = "--version" ]; then echo "not-a-version"; exit 0; fi',
        'echo "opencode - the terminal coding agent"',
      ]),
    );
    expect(probeCliIdentity('opencode', opencode2).ok).toBe(true);
  });
});

describe('probe cache keyed by path + size + mtime (A8 §2)', () => {
  it('does not re-spawn an unchanged binary across probes and resolves', () => {
    const { exe, countFile } = plantCounting(binA, 'codex', 'codex-cli 1.0.0');
    expect(probeCliIdentity('codex', exe).ok).toBe(true);
    expect(probeCliIdentity('codex', exe).ok).toBe(true);
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home });
    expect(res.path).toBe(exe);
    const res2 = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home });
    expect(res2.path).toBe(exe);
    expect(countOf(countFile)).toBe(1);
  });

  it('invalidates when mtime changes', () => {
    const { exe, countFile } = plantCounting(binA, 'codex', 'codex-cli 1.0.0');
    expect(probeCliIdentity('codex', exe).ok).toBe(true);
    expect(countOf(countFile)).toBe(1);
    const later = new Date(Date.now() + 60_000);
    utimesSync(exe, later, later);
    expect(probeCliIdentity('codex', exe).ok).toBe(true);
    expect(countOf(countFile)).toBe(2);
  });

  it('invalidates when size changes even if mtime is restored', () => {
    const { exe, countFile } = plantCounting(binA, 'codex', 'codex-cli 1.0.0');
    expect(probeCliIdentity('codex', exe).ok).toBe(true);
    expect(countOf(countFile)).toBe(1);
    // Rewrite with different content (different size), then force the
    // ORIGINAL mtime back — size alone must still invalidate.
    const before = statSync(exe);
    plant(binA, 'codex', script(['# longer padding comment line to change the size', 'echo "codex-cli 2.0.0"']));
    utimesSync(exe, before.atime, before.mtime);
    const res = probeCliIdentity('codex', exe);
    expect(res.ok).toBe(true);
    expect(res.version).toBe('2.0.0');
    // The counting shim was replaced by a plain one; prove re-probe by
    // version change (a cache hit would have returned 1.0.0).
    expect(countOf(countFile)).toBe(1);
  });
});

describe('ReDoS safety (A8 §3)', () => {
  it('a hostile shim printing pathological output completes within a bound', () => {
    const evil = plant(
      binA,
      'codex',
      script([
        `printf 'codex'; awk 'BEGIN{for(i=0;i<200000;i++)printf "a"}'; printf '\\n'`,
        `awk 'BEGIN{for(i=0;i<200000;i++)printf "("; print ""}'`,
        'exit 0',
      ]),
    );
    const started = Date.now();
    const res = probeCliIdentity('codex', evil, { timeoutMs: 5000 });
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeLessThan(4000);
  });

  it('the matcher itself is bounded on pathological strings', () => {
    const bait = `${'a'.repeat(200_000)}!`;
    const started = Date.now();
    expect(matchIdentity({ kind: 'firstLinePrefix', needle: 'codex-cli' }, bait)).toBe(false);
    expect(matchIdentity({ kind: 'firstLineContains', needle: 'claude code' }, bait)).toBe(false);
    expect(matchIdentity({ kind: 'firstLineSemver' }, bait)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('dangerous regex declarations are refused by the safety gate', () => {
    expect(assertSafeRegexPattern('(a+)+$')).toBe(false);
    expect(assertSafeRegexPattern('(.*)*b')).toBe(false);
    expect(assertSafeRegexPattern('(a|aa)+$')).toBe(false);
    expect(assertSafeRegexPattern('(x)\\1')).toBe(false);
    expect(assertSafeRegexPattern('^codex-cli\\b')).toBe(true);
    expect(assertSafeRegexPattern('claude code')).toBe(true);
    // A refused pattern never matches, even against a would-be hit.
    expect(matchIdentity({ kind: 'regex', source: '(a+)+$' }, 'aaaaaaaa')).toBe(false);
  });
});

describe('refusal quoting + redaction (A8 §4)', () => {
  it('namesake refusals quote the first printed line with secrets redacted', () => {
    const ns = plant(
      binA,
      'codex',
      script(['echo "mytool failed api_key=sk-ant-oat01-SECRETSECRET99"', 'exit 1']),
    );
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home });
    expect(res.path).toBeUndefined();
    expect(res.namesake?.firstLine).toContain('[REDACTED]');
    expect(res.namesake?.firstLine).not.toContain('SECRETSECRET');
    const msg = bridgeNamesakeMessage('codex', res.namesake!);
    expect(msg).toContain('It printed:');
    expect(msg).not.toContain('SECRETSECRET');
    expect(msg).toContain('[REDACTED]');
  });

  it('redactCliSecrets covers the bridge token shapes and leaves prose alone', () => {
    expect(redactCliSecrets('key sk-abcdefgh12345678 end')).toBe('key [REDACTED] end');
    expect(redactCliSecrets('Authorization: Bearer abcdefgh12345678')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactCliSecrets('ImportError: er.query.foreign_keys cannot be imported')).toBe(
      'ImportError: er.query.foreign_keys cannot be imported',
    );
  });

  it('summarizeCliFailure redacts secrets from the quoted line', () => {
    const s = summarizeCliFailure({
      cliLabel: 'The Codex CLI',
      how: 'exited with code 1',
      stderr: 'Error: login failed for access_token=eyJabcdefghij.klmnopqrst.uvwxyz1234',
    });
    expect(s).not.toContain('eyJabcdefghij');
    expect(s).toContain('[REDACTED]');
  });
});

describe('user-pinnable CLI path (A8 §5)', () => {
  function plantRealCodex(dir: string): string {
    return plant(dir, 'codex', script(['echo "codex-cli 9.9.9"']));
  }

  it('honours a pin pointing outside PATH', () => {
    const real = plantRealCodex(binB);
    setCliPathPin('codex', real);
    expect(getCliPathPin('codex')).toBe(real);
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home });
    expect(res.path).toBe(real);
    expect(res.pinned).toMatchObject({ path: real, status: 'verified' });
  });

  it('honours a per-call pin override', () => {
    const real = plantRealCodex(binB);
    const res = resolveVerifiedCliExecutable('codex', {
      pathDirs: [binA],
      homeDir: home,
      cliPathPins: { codex: real },
    });
    expect(res.path).toBe(real);
  });

  it('a pin is still identity-checked: a namesake at the pinned path fails plainly', () => {
    const ns = plant(binB, 'codex', script(['echo "Traceback (most recent call last):"', 'exit 1']));
    // A real codex also exists on PATH — the pin must NOT fall back to it.
    plantRealCodex(binA);
    setCliPathPin('codex', ns);
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home });
    expect(res.path).toBeUndefined();
    expect(res.pinned?.status).toBe('identity-failed');
    const msg = bridgeResolutionFailureMessage('codex', res);
    expect(msg).toContain('pinned');
    expect(msg).toContain(ns);
    expect(msg).toContain('still has to be the real CLI');
    expect(bridgePinnedMessage('codex', res.pinned!)).toContain('Traceback');
  });

  it('a pin pointing at a missing file fails plainly as not-found', () => {
    const missing = join(binB, 'no-such-codex');
    setCliPathPin('codex', missing);
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home });
    expect(res.path).toBeUndefined();
    expect(res.pinned).toMatchObject({ path: missing, status: 'not-found' });
    expect(bridgeResolutionFailureMessage('codex', res)).toContain("doesn't point to a file");
  });

  it('clearing the pin returns to auto-detection', () => {
    const real = plantRealCodex(binA);
    const elsewhere = plantRealCodex(binB);
    setCliPathPin('codex', elsewhere);
    expect(resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home }).path).toBe(elsewhere);
    setCliPathPin('codex', '');
    expect(getCliPathPin('codex')).toBeUndefined();
    expect(resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home }).path).toBe(real);
  });

  it('reads a pin mirrored into the env var (boot path)', () => {
    const real = plantRealCodex(binB);
    process.env.KRIYADOT_CLI_PATH_CODEX = real;
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: home });
    expect(res.path).toBe(real);
  });

  it('win32 pin enumeration tries .exe/.cmd/.bat for an extensionless pin', () => {
    plant(binB, 'codex.exe', '');
    plant(binB, 'codex.bat', '');
    const found = pinnedCliCandidates(join(binB, 'codex'), 'win32');
    expect(found).toEqual([join(binB, 'codex.exe'), join(binB, 'codex.bat')]);
    // A pin that already carries an extension resolves to itself only.
    expect(pinnedCliCandidates(join(binB, 'codex.exe'), 'win32')).toEqual([join(binB, 'codex.exe')]);
    // POSIX: no extension games.
    expect(pinnedCliCandidates(join(binB, 'codex'), 'linux')).toEqual([]);
  });
});
