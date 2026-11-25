// SPDX-License-Identifier: Apache-2.0
// Sweep 2026-11-25 (B-1): the `agent/<cli>/…` provider-id lane must
// honour the SAME Connect consent + identity-verified resolution as
// the catalog preset lane. Before the fix, createProvider built the
// ACP provider with no opts at all — it spawned the bare command name
// from PATH (a same-named impostor would run with the user's prompt),
// ignored pins, ran unconnected bridges without consent, and dropped
// the account env.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProvider } from '../src/providers/factory.js';
import { grantBridgeConsent, resetBridgeConsent } from '../src/providers/cli-bridge.js';
import type { CopilotAcpProvider } from '../src/providers/acp-engines.js';

let fakeBin = '';
let savedPath: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
  fakeBin = mkdtempSync(join(tmpdir(), 'b1-bin-'));
  process.env.PATH = fakeBin; // nothing on PATH unless planted
  resetBridgeConsent();
});

afterEach(() => {
  process.env.PATH = savedPath;
  resetBridgeConsent();
});

function plantCopilot(): string {
  const p = join(fakeBin, 'copilot');
  writeFileSync(
    p,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "copilot 1.0.0"; exit 0; fi\nexit 0\n',
  );
  chmodSync(p, 0o755);
  return p;
}

describe('B-1: agent/<bridge> lane — consent + verified resolution', () => {
  it('refuses an UNCONNECTED bridge instead of spawning the bare command name', () => {
    plantCopilot();
    expect(() => createProvider('agent/copilot/default')).toThrow(/not connected/i);
  });

  it('with consent, the provider spawns the IDENTITY-VERIFIED path — never the bare name', () => {
    const planted = plantCopilot();
    grantBridgeConsent('copilot');
    const provider = createProvider('agent/copilot/default') as CopilotAcpProvider;
    expect(provider.command).toBe(planted);
  });

  it('with consent but no verifiable binary on PATH, refuses (no namesake spawn)', () => {
    grantBridgeConsent('copilot');
    expect(() => createProvider('agent/copilot/default')).toThrow();
  });

  it('a same-named IMPOSTOR binary is refused even with consent', () => {
    const p = join(fakeBin, 'copilot');
    // The banner never names the tool — the identity probe rejects it
    // and resolution reports a namesake instead of a spawnable path.
    writeFileSync(p, '#!/bin/sh\necho "banana-tool 9.9.9"\nexit 0\n');
    chmodSync(p, 0o755);
    grantBridgeConsent('copilot');
    expect(() => createProvider('agent/copilot/default')).toThrow();
  });
});
