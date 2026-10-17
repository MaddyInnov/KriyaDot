// SPDX-License-Identifier: Apache-2.0
// Tests for cli-auth.ts antigravity support (G8):
// - CliAuthManager exposes loginStatus('antigravity') with cliPresent via
//   the `agy` command lookup
// - credentialsPresent is a documented file-shape heuristic (no keyring
//   reads from Node) and never throws when the file is absent

import { describe, expect, it } from 'vitest';
import { CliAuthManager } from '../src/providers/cli-auth.js';

describe('antigravity CLI auth', () => {
  it('resolves the agy command on PATH', () => {
    const mgr = new CliAuthManager({
      pathDirs: ['/usr/bin'],
      fileExists: () => false,
      spawnFn: () => {
        throw new Error('no spawn in test');
      },
    });
    // /usr/bin has no agy in CI — the lookup must simply be false.
    expect(mgr.cliPresent('antigravity')).toBe(false);
  });

  it('getStatus reports the credential heuristic without throwing', async () => {
    const mgr = new CliAuthManager({
      homeDir: '/nonexistent-home-for-test',
      pathDirs: [],
      fileExists: () => false,
      spawnFn: () => {
        throw new Error('no spawn in test');
      },
    });
    const status = await mgr.getStatus('antigravity');
    expect(status.cliId).toBe('antigravity');
    expect(status.cliPresent).toBe(false);
    expect(status.credentialsPresent).toBe(false);
    // signedIn is a heuristic — it must be boolean, never throw.
    expect(typeof status.signedIn).toBe('boolean');
  });
});
