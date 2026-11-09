// SPDX-License-Identifier: Apache-2.0
// CLI identity validation (2026-11-09 field report): a same-named
// unrelated program on PATH (a Python tool literally named `codex`)
// must never be treated as the real CLI — not at detection, not at
// connect, not at model listing, not at spawn time. Covers candidate
// enumeration order (win32), identity accept/reject, the namesake-only
// state + copy, error summarization bounds, the driver's per-model
// --model round-trip for the curated bridge model lists, the Claude
// `auth status` parser, and the oauthAccount email hint.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bridgeAccountHint,
  bridgeConnectable,
  bridgeNamesakeMessage,
  buildCliSpawnCommand,
  enumerateCliCandidates,
  getBridgeModels,
  getProviderPreset,
  probeCliIdentity,
  resetBridgeModelsCache,
  resetCliIdentityCache,
  resolveVerifiedCliExecutable,
  summarizeCliFailure,
} from '../src/index.js';
import { parseClaudeAuthStatus } from '../src/providers/cli-auth.js';
import { getNativeCliSpec } from '../src/providers/cli-driver.js';

const ENV_KEYS = ['HOME', 'PATH', 'PROVIDERS_FILE'];
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

let fakeHome = '';
let binA = '';
let binB = '';

function plant(binDir: string, name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

function script(lines: string[]): string {
  return ['#!/bin/sh', ...lines, ''].join('\n');
}

/** A broken Python-style namesake: every invocation dumps a traceback. */
function plantPythonNamesake(binDir: string, name: string): string {
  return plant(binDir, name, script([
    'echo "Traceback (most recent call last):" >&2',
    'echo "  File \\"/x/codex/librarian/scribe/importer.py\\", line 1, in <module>" >&2',
    'echo "ImportError: er.query.foreign_keys" >&2',
    'exit 1',
  ]));
}

function plantRealCodex(binDir: string): string {
  return plant(binDir, 'codex', script([
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.44.0"; exit 0; fi',
    'if [ "$1" = "debug" ]; then echo "gpt-5"; echo "gpt-5-mini"; exit 0; fi',
    'exit 0',
  ]));
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'ident-home-'));
  binA = mkdtempSync(join(tmpdir(), 'ident-binA-'));
  binB = mkdtempSync(join(tmpdir(), 'ident-binB-'));
  process.env.HOME = fakeHome;
  process.env.PROVIDERS_FILE = join(tmpdir(), 'ident-no-providers.json');
  resetCliIdentityCache();
  resetBridgeModelsCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetCliIdentityCache();
  resetBridgeModelsCache();
});

describe('candidate enumeration (win32 order)', () => {
  it('prefers .exe over .cmd over .bat over bare, and earlier PATH dirs first', () => {
    plant(binB, 'claude.exe', '');
    plant(binB, 'claude.cmd', '');
    plant(binA, 'claude.cmd', '');
    plant(binA, 'claude.bat', '');
    plant(binA, 'claude', '');
    const found = enumerateCliCandidates('claude', {
      pathDirs: [binA, binB],
      platform: 'win32',
      homeDir: fakeHome,
    });
    expect(found[0]).toBe(join(binA, 'claude.cmd'));
    expect(found).toContain(join(binB, 'claude.exe'));
    expect(found.indexOf(join(binA, 'claude.bat'))).toBeLessThan(found.indexOf(join(binA, 'claude')));
  });
});

describe('identity probing', () => {
  it('accepts the real CLIs by their version banners', () => {
    const codex = plantRealCodex(binA);
    expect(probeCliIdentity('codex', codex).ok).toBe(true);
    const claude = plant(binA, 'claude', script(['echo "2.0.14 (Claude Code)"']));
    expect(probeCliIdentity('claude', claude).ok).toBe(true);
    const opencode = plant(binA, 'opencode', script(['echo "1.2.3"']));
    expect(probeCliIdentity('opencode', opencode).ok).toBe(true);
  });

  it('rejects a Python namesake and classifies what it looks like', () => {
    const ns = plantPythonNamesake(binA, 'codex');
    const res = probeCliIdentity('codex', ns);
    expect(res.ok).toBe(false);
    expect(res.looksLike).toBe('a Python program');
  });

  it('a verified real CLI later on PATH wins over a namesake earlier on PATH', () => {
    plantPythonNamesake(binA, 'codex');
    const real = plantRealCodex(binB);
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA, binB], homeDir: fakeHome });
    expect(res.path).toBe(real);
  });

  it('namesake-only resolution reports the namesake, never a path', () => {
    plantPythonNamesake(binA, 'codex');
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [binA], homeDir: fakeHome });
    expect(res.path).toBeUndefined();
    expect(res.namesake?.looksLike).toBe('a Python program');
    const msg = bridgeNamesakeMessage('codex', res.namesake!);
    expect(msg).toMatch(/isn't Codex CLI/);
    expect(msg).toMatch(/Python/);
    expect(msg).toMatch(/npm install -g @openai\/codex/);
  });
});

describe('connect + model listing against a namesake', () => {
  it('bridgeConnectable refuses with code namesake-cli even when credentials exist', () => {
    plantPythonNamesake(binA, 'codex');
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    process.env.PATH = binA;
    const r = bridgeConnectable('codex');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('namesake-cli');
    expect(r.reason).toMatch(/isn't Codex CLI/);
    expect(r.reason).toMatch(/Python program/);
  });

  it('getBridgeModels never interrogates a namesake and returns []', () => {
    plantPythonNamesake(binA, 'codex');
    process.env.PATH = binA;
    expect(getBridgeModels('codex')).toEqual([]);
  });

  it('getBridgeModels parses the verified CLI list (and caches it)', () => {
    plantRealCodex(binA);
    process.env.PATH = binA;
    const models = getBridgeModels('codex');
    expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(['gpt-5', 'gpt-5-mini']));
    expect(getBridgeModels('codex')).toBe(models); // cached reference
  });
});

describe('spawn command + failure summarization', () => {
  it('wraps .cmd/.bat through cmd.exe on win32 only', () => {
    expect(buildCliSpawnCommand('C:\\npm\\claude.cmd', ['--version'], 'win32'))
      .toEqual({ file: 'cmd.exe', args: ['/d', '/s', '/c', '"C:\\npm\\claude.cmd" --version'] });
    expect(buildCliSpawnCommand('C:\\bin\\claude.exe', ['--version'], 'win32'))
      .toEqual({ file: 'C:\\bin\\claude.exe', args: ['--version'] });
    expect(buildCliSpawnCommand('/usr/bin/claude', ['--version'], 'linux'))
      .toEqual({ file: '/usr/bin/claude', args: ['--version'] });
  });

  it('summarizes a long Python traceback to ONE bounded sentence', () => {
    const tb = [
      'Traceback (most recent call last):',
      '  File "/x/codex/librarian/scribe/importer.py", line 42, in <module>',
      '    from er.query.foreign_keys import (',
      'ImportError: er.query.foreign_keys cannot be imported',
      ...Array.from({ length: 60 }, (_, i) => `noise line ${i}`),
    ].join('\n');
    const s = summarizeCliFailure({ cliLabel: 'The Codex CLI', how: 'exited with code 1', stderr: tb });
    expect(s).not.toContain('\n');
    expect(s.length).toBeLessThanOrEqual(280);
    expect(s).toMatch(/^The Codex CLI exited with code 1: ImportError/);
    expect(s).not.toMatch(/File "\/x/);
  });

  it('summarizes empty stderr without inventing a cause', () => {
    const s = summarizeCliFailure({ cliLabel: 'The Codex CLI', how: 'exited with code 1', stderr: '  ' });
    expect(s).toBe('The Codex CLI exited with code 1 and produced no error output.');
  });
});

describe('claude auth status + account hint', () => {
  it('parses the JSON status shape both ways', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}'))
      .toEqual({ signedIn: true, accountHint: 'a@b.c' });
    expect(parseClaudeAuthStatus('{"loggedIn":false}')).toEqual({ signedIn: false });
    expect(parseClaudeAuthStatus('not json')).toBeUndefined();
    expect(parseClaudeAuthStatus('')).toBeUndefined();
  });

  it('bridgeAccountHint reads oauthAccount.emailAddress from ~/.claude.json', () => {
    writeFileSync(
      join(fakeHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'person@example.com' } }),
    );
    expect(bridgeAccountHint('claude', fakeHome)).toBe('person@example.com');
  });
});

describe('curated bridge model lists round-trip through the driver', () => {
  it('every codex-subscription catalog model reaches the CLI as --model <id>', () => {
    const preset = getProviderPreset('codex-subscription');
    expect(preset?.models.length).toBeGreaterThan(1);
    const spec = getNativeCliSpec('codex');
    for (const m of preset!.models) {
      const args = spec!.buildArgs({ model: m.id, prompt: 'hi', approvalMode: 'never' } as never);
      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(m.id);
    }
  });

  it('every claude-subscription catalog model reaches the CLI as --model <id>', () => {
    const preset = getProviderPreset('claude-subscription');
    expect(preset?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5']),
    );
    const spec = getNativeCliSpec('claude-code');
    for (const m of preset!.models) {
      const args = spec!.buildArgs({ model: m.id, prompt: 'hi', approvalMode: 'never' } as never);
      const idx = args.indexOf('--model');
      expect(args[idx + 1]).toBe(m.id);
    }
  });

  it('PATH delimiter sanity (test env)', () => {
    expect([binA, binB].join(delimiter)).toContain(binA);
  });
});
