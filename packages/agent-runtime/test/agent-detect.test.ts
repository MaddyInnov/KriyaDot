// SPDX-License-Identifier: Apache-2.0
// Tests for ACP agent auto-detection (agent-detect.ts + agent-registry.json).
// The real filesystem is never touched: whichSync is tested via PATH
// manipulation in a temp dir, and --version probes use a fake executable.

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadAgentRegistry,
  validateRegistry,
  whichSync,
  scanAgents,
  listAgents,
  rescanAgents,
  type DetectedAgent,
} from '../src/providers/agent-detect.js';

describe('agent registry', () => {
  it('loads and passes validation', () => {
    const entries = loadAgentRegistry();
    expect(entries.length).toBeGreaterThanOrEqual(30);
    expect(validateRegistry(entries)).toEqual([]);
  });

  it('has unique ids and required fields', () => {
    const entries = loadAgentRegistry();
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(entries.length);
    for (const e of entries) {
      expect(e.bins.length).toBeGreaterThan(0);
      expect(e.installHint).toBeTruthy();
      expect(e.homepage).toMatch(/^https:\/\//);
    }
  });

  it('covers the major agents', () => {
    const ids = new Set(loadAgentRegistry().map((e) => e.id));
    for (const must of ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'opencode', 'pi', 'grok']) {
      expect(ids.has(must)).toBe(true);
    }
  });
});

describe('whichSync', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-detect-test-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
    rescanAgents();
  });

  it('finds an executable shell script on PATH', () => {
    const bin = join(dir, process.platform === 'win32' ? 'fakedaude.cmd' : 'fakedaude');
    writeFileSync(bin, process.platform === 'win32' ? '@echo 1.2.3' : '#!/bin/sh\necho 1.2.3\n');
    if (process.platform !== 'win32') chmodSync(bin, 0o755);
    const name = process.platform === 'win32' ? 'fakedaude' : 'fakedaude';
    expect(whichSync(name)).toBe(bin);
  });

  it('returns null for a missing binary', () => {
    expect(whichSync('definitely-not-a-real-binary-xyz')).toBeNull();
  });
});

describe('scanAgents', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-scan-test-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
    rescanAgents();
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
    rescanAgents();
  });

  function plantFake(bin: string, version: string): void {
    const isWin = process.platform === 'win32';
    const file = join(dir, isWin ? bin + '.cmd' : bin);
    writeFileSync(file, isWin ? `@echo ${version}` : `#!/bin/sh\necho "${version}"\n`);
    if (!isWin) chmodSync(file, 0o755);
  }

  it('detects a planted fake claude binary with version', async () => {
    plantFake('claude', '1.0.99-test');
    const found = await scanAgents({ force: true });
    const claude = found.find((a: DetectedAgent) => a.id === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.bin).toBe('claude');
    expect(claude!.version).toContain('1.0.99-test');
    expect(claude!.acpCompatible).toBe(true);
  });

  it('caches results until rescan', async () => {
    plantFake('codex', '0.1.0');
    const first = await scanAgents({ force: true });
    expect(first.some((a) => a.id === 'codex')).toBe(true);
    // Remove the binary; cached scan should still report it
    rmSync(join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex'), { force: true });
    const cached = await scanAgents();
    expect(cached.some((a) => a.id === 'codex')).toBe(true);
    // Forced rescan drops it
    const fresh = await scanAgents({ force: true });
    expect(fresh.some((a) => a.id === 'codex')).toBe(false);
  });

  it('listAgents puts detected first, then install hints', async () => {
    plantFake('opencode', '0.9.9');
    const all = await listAgents({ force: true });
    expect(all[0].installed).toBe(true);
    const notInstalled = all.find((a) => !a.installed);
    expect(notInstalled).toBeDefined();
    expect((notInstalled as { installHint: string }).installHint).toBeTruthy();
  });

  it('handles a binary whose --version fails', async () => {
    const isWin = process.platform === 'win32';
    const file = join(dir, isWin ? 'gemini.cmd' : 'gemini');
    writeFileSync(file, isWin ? '@exit 1' : '#!/bin/sh\nexit 1\n');
    if (!isWin) chmodSync(file, 0o755);
    const found = await scanAgents({ force: true });
    const gemini = found.find((a: DetectedAgent) => a.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.version).toBeNull();
  });
});
