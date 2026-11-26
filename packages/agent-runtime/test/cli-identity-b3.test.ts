// SPDX-License-Identifier: Apache-2.0
// B-3 close-out (final cut, 2026-11-26) — scoped help corroboration.
//
// The 2026-11-25 sweep (B-3) reverted a blanket AND-tightening of CLI
// identity because it could false-reject real CLIs. The 2026-11-26
// real-binary pass then RECORDED both identity signals from the real
// pi and kimi binaries (vendor channels; raw outputs preserved in
// ~/workspace/scratch/a2-real-binary/outputs/, write-up in
// hidden_files/final-cut-2026-11-26/A2-REAL-BINARY.md):
// - pi 1.6.1: --version "1.6.1"; --help banner line "pi - AI coding
//   assistant with read, bash, edit, write tools" (the signed-out
//   warning line precedes it in the real output — replayed here too).
// - kimi 2.8.0: --version "2.8.0"; --help opens "Usage: kimi
//   [options] [command]".
// For those two bridges the probe now requires BOTH signals. This
// suite replays the recorded outputs verbatim, proves a bare-semver
// namesake whose --help does not corroborate is now rejected, and
// pins the deliberate residuals: opencode keeps its v0.2.2
// bare-semver acceptance (no recorded real --help output exists for
// it), and name-bearing bridges (copilot) still pass on the version
// banner alone.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HELP_CORROBORATION_BRIDGE_IDS,
  identityRequiresHelpCorroboration,
  probeCliIdentity,
  resetCliIdentityCache,
} from '../src/index.js';

let binDir = '';

function script(lines: string[]): string {
  return ['#!/bin/sh', ...lines, ''].join('\n');
}

function plant(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

/** A shim that answers --version and --help with fixed lines. */
function plantVersionHelp(name: string, versionLine: string, helpLines: string[]): string {
  return plant(
    name,
    script([
      `if [ "$1" = "--version" ]; then echo ${JSON.stringify(versionLine)}; exit 0; fi`,
      `if [ "$1" = "--help" ]; then ${helpLines.map((l) => `echo ${JSON.stringify(l)};`).join(' ')} exit 0; fi`,
      'exit 0',
    ]),
  );
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'b3-bin-'));
  resetCliIdentityCache();
});

describe('corroboration scope', () => {
  it('covers exactly pi and kimi — the bridges with recorded real outputs', () => {
    expect([...HELP_CORROBORATION_BRIDGE_IDS].sort()).toEqual(['kimi', 'pi']);
    expect(identityRequiresHelpCorroboration('pi')).toBe(true);
    expect(identityRequiresHelpCorroboration('kimi')).toBe(true);
    expect(identityRequiresHelpCorroboration('opencode')).toBe(false);
    expect(identityRequiresHelpCorroboration('claude')).toBe(false);
    expect(identityRequiresHelpCorroboration('codex')).toBe(false);
    expect(identityRequiresHelpCorroboration('copilot')).toBe(false);
    expect(identityRequiresHelpCorroboration('grok')).toBe(false);
    expect(identityRequiresHelpCorroboration('hermes')).toBe(false);
  });
});

describe('recorded real outputs still verify (verbatim replay)', () => {
  it('pi 1.6.1: bare-semver version + real --help banner (warning line first)', () => {
    const exe = plantVersionHelp('pi', '1.6.1', [
      'Warning: No models available. Use /login to log into a provider via OAuth or API key. See:',
      'pi - AI coding assistant with read, bash, edit, write tools',
      'Usage:',
      '  pi [options] [--] [@files...] [messages...]',
    ]);
    const res = probeCliIdentity('pi', exe);
    expect(res.ok).toBe(true);
    expect(res.version).toBe('1.6.1');
  });

  it('kimi 2.8.0: bare-semver version + real --help opening', () => {
    const exe = plantVersionHelp('kimi', '2.8.0', [
      'Usage: kimi [options] [command]',
      '',
      'The Starting Point for Next-Gen Agents',
    ]);
    const res = probeCliIdentity('kimi', exe);
    expect(res.ok).toBe(true);
    expect(res.version).toBe('2.8.0');
  });
});

describe('the tightening bites: bare semver alone no longer passes for pi / kimi', () => {
  it('pi: semver --version + a --help that never says "coding assistant" is rejected', () => {
    const exe = plantVersionHelp('pi', '9.9.9', ['some unrelated tool', 'Usage: thing [options]']);
    expect(probeCliIdentity('pi', exe).ok).toBe(false);
  });

  it('kimi: semver --version + a --help that never names kimi is rejected', () => {
    const exe = plantVersionHelp('kimi', '9.9.9', ['Usage: other [options] [command]']);
    expect(probeCliIdentity('kimi', exe).ok).toBe(false);
  });

  it('pi: semver --version + a traceback --help is rejected (reject markers apply to help too)', () => {
    const exe = plantVersionHelp('pi', '9.9.9', [
      'Traceback (most recent call last):',
      'ModuleNotFoundError: No module named x',
    ]);
    expect(probeCliIdentity('pi', exe).ok).toBe(false);
  });

  it('pi: a non-semver --version still falls back to the help match (fallback path unchanged)', () => {
    const exe = plantVersionHelp('pi', 'not-a-version', [
      'pi - AI coding assistant with read, bash, edit, write tools',
    ]);
    expect(probeCliIdentity('pi', exe).ok).toBe(true);
  });
});

describe('deliberate residuals stay exactly as shipped', () => {
  it('opencode: bare-semver --version alone is still accepted (v0.2.2, disclosed)', () => {
    // The shim answers EVERY invocation with the semver — its --help
    // never names the tool. OpenCode has no recorded real --help
    // output in the repo, so this acceptance is NOT tightened; the
    // weakness stays disclosed in cli-identity.ts and its manifest.
    const exe = plant('opencode', script(['echo "1.0.119"']));
    const res = probeCliIdentity('opencode', exe);
    expect(res.ok).toBe(true);
    expect(res.version).toBe('1.0.119');
  });

  it('copilot: the name-bearing version banner alone still passes (no corroboration)', () => {
    const exe = plant('copilot', script(['echo "GitHub Copilot CLI 1.0.116."']));
    expect(probeCliIdentity('copilot', exe).ok).toBe(true);
  });
});
