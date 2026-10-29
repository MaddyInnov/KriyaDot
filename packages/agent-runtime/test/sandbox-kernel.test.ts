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
});
