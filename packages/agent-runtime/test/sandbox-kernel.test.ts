// SPDX-License-Identifier: Apache-2.0
// Kernel sandbox backends: Landlock helper compile/probe/confinement
// (Linux, kernel permitting) and Seatbelt profile generation.

import { describe, expect, it } from 'vitest';
import {
  buildSeatbeltProfile,
  ensureLandlockHelper,
  landlockAbiVersion,
  runInLandlock,
} from '../src/tools/sandbox-kernel.js';

describe('seatbelt profile', () => {
  it('confines writes to the workdir and denies network by default', () => {
    const profile = buildSeatbeltProfile('/tmp/run-1');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(subpath "/tmp/run-1")');
    expect(profile).toContain('(deny network*)');
  });

  it('allows network only when opted in, and escapes quotes', () => {
    const profile = buildSeatbeltProfile('/tmp/we"ird', { network: true });
    expect(profile).toContain('(allow network*)');
    expect(profile).toContain('/tmp/we\\"ird');
  });

  // #119: profile CONTENT parity with Landlock's read paths. Execution
  // via sandbox-exec is macOS-gated and unverifiable on this Linux VM;
  // these tests assert the generated profile carries every rule the
  // Landlock policy implies.
  it('grants every Landlock read root plus whole-filesystem read (#119)', () => {
    const profile = buildSeatbeltProfile('/tmp/run-1');
    for (const root of [
      '/usr',
      '/System',
      '/Library',
      '/bin',
      '/sbin',
      '/etc',
      '/private/etc',
      '/dev',
      '/opt',
      '/usr/local',
      '/Users',
    ]) {
      expect(profile, `read root ${root}`).toContain(`(subpath "${root}")`);
    }
    // Landlock grants READ+EXECUTE on "/" as a whole.
    expect(profile).toContain('(allow file-read* (subpath "/"))');
    expect(profile).toContain('(allow process-exec* (subpath "/"))');
  });

  it('allows workspace read+write and temp writes, denies $HOME writes (#119)', () => {
    const profile = buildSeatbeltProfile('/Users/tester/ws', { homeDir: '/Users/tester' });
    // Workspace is readable + writable, as is the system temp dir.
    expect(profile).toContain(
      '(allow file-read* file-write* (subpath "/Users/tester/ws") (subpath "/tmp") (subpath "/private/tmp"))',
    );
    expect(profile).toContain('(allow file-write* (literal "/dev/null")');
    // $HOME write denial exists and precedes the workspace allow, so
    // Seatbelt's last-match rule keeps a $HOME-nested workspace
    // writable while the rest of $HOME is write-denied (Landlock parity).
    const denyIdx = profile.indexOf('(deny file-write* (subpath "/Users/tester"))');
    const allowIdx = profile.indexOf('(allow file-read* file-write* (subpath "/Users/tester/ws")');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(denyIdx);
    // …but $HOME stays READABLE (Landlock grants read on "/").
    expect(profile).not.toContain('(deny file-read*');
  });
});

describe('landlock backend', () => {
  it('compiles the helper and probes the kernel ABI', async () => {
    if (process.platform !== 'linux') return;
    const bin = await ensureLandlockHelper();
    expect(bin).not.toBeNull();
    const abi = await landlockAbiVersion();
    // The CI kernel may or may not enable Landlock; the helper must at
    // least exist and answer the probe either way.
    expect(typeof abi).toBe('number');
  });

  it('confines writes to the temp cwd when the kernel supports it', async () => {
    if (process.platform !== 'linux') return;
    const abi = await landlockAbiVersion();
    if (abi < 1) {
      // Kernel without Landlock: runInLandlock must fail closed, not run.
      await expect(runInLandlock('echo hi')).rejects.toThrow(/not enabled|unavailable/i);
      return;
    }
    const inside = await runInLandlock('echo confined-ok && touch local-file && ls local-file');
    expect(inside.exitCode).toBe(0);
    expect(inside.stdout).toContain('confined-ok');
    // Writing to $HOME must be denied by the ruleset.
    const home = process.env.HOME ?? '/root';
    const escape = await runInLandlock(`touch ${home}/landlock-escape-marker && echo ESCAPED || echo BLOCKED`);
    expect(escape.stdout).toContain('BLOCKED');
    expect(escape.stdout).not.toContain('ESCAPED');
  });

  it('uses the workspace dir as the writable root when supplied (#117)', async () => {
    if (process.platform !== 'linux') return;
    const abi = await landlockAbiVersion();
    if (abi < 1) return; // confinement assertion is ABI-gated (see above)
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ws = mkdtempSync(join(tmpdir(), 'kriyadot-landlock-ws-'));
    try {
      // A relative write lands in the workspace (cwd = workspace) and
      // persists after the run — the workspace, not a temp dir, is the
      // writable root.
      const inside = await runInLandlock('echo ws-write > marker.txt && cat marker.txt', {
        workspaceDir: ws,
      });
      expect(inside.exitCode).toBe(0);
      expect(inside.stdout).toContain('ws-write');
      expect(inside.backend).toBe('landlock');
      expect(inside.sandboxed).toBe(true);
      expect(existsSync(join(ws, 'marker.txt'))).toBe(true);
      // $HOME writes stay blocked with a workspace root set.
      const home = process.env.HOME ?? '/root';
      const escape = await runInLandlock(`touch ${home}/landlock-escape-marker && echo ESCAPED || echo BLOCKED`, {
        workspaceDir: ws,
      });
      expect(escape.stdout).toContain('BLOCKED');
      expect(escape.stdout).not.toContain('ESCAPED');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
