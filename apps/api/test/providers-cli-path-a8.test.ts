// SPDX-License-Identifier: Apache-2.0
// Timon parity A8 — user-pinnable CLI paths at the API layer:
// - pins persist in the existing encrypted settings store
//   (providers.local.json) with no plaintext path leakage concerns beyond
//   the envelope, and survive a re-read
// - saving a pin applies it LIVE to the runtime resolver (no restart):
//   resolveVerifiedCliExecutable honours it immediately
// - a pinned path is still identity-checked: status reports the plain
//   failure for a namesake / missing file
// - clearing the pin returns resolution to auto-detection

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCliPathPin, resetCliPathPins, resolveVerifiedCliExecutable } from '@mvp/agent-runtime';
import {
  cliPathStatusFor,
  getStoredCliPathPins,
  listProviders,
  localKeysPath,
  setStoredCliPathPin,
} from '../src/providers.js';

let dataDir = '';
let binDir = '';
let fakeHome = '';
const savedHome = process.env.HOME;

function plant(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

function plantRealCodex(dir: string): string {
  const p = join(dir, 'codex');
  writeFileSync(p, '#!/bin/sh\necho "codex-cli 3.2.1"\n');
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'a8-api-data-'));
  binDir = mkdtempSync(join(tmpdir(), 'a8-api-bin-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'a8-api-home-'));
  process.env.HOME = fakeHome;
  resetCliPathPins();
});

afterEach(() => {
  resetCliPathPins();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe('CLI path pin persistence (A8 §5)', () => {
  it('persists a pin in the encrypted settings store and reads it back', () => {
    const real = plantRealCodex(binDir);
    const status = setStoredCliPathPin(dataDir, 'codex', real);
    expect(status.cliPath).toBe(real);
    expect(status.cliPathError).toBeUndefined();
    expect(getStoredCliPathPins(dataDir)).toEqual({ codex: real });
    // Stored inside the AES-256-GCM envelope, like provider keys.
    const envelope = JSON.parse(readFileSync(localKeysPath(dataDir), 'utf8')) as Record<string, unknown>;
    expect(envelope.alg).toBe('aes-256-gcm');
  });

  it('applies the pin live to the runtime resolver', () => {
    const real = plantRealCodex(binDir);
    setStoredCliPathPin(dataDir, 'codex', real);
    expect(getCliPathPin('codex')).toBe(real);
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [], homeDir: fakeHome });
    expect(res.path).toBe(real);
    expect(res.pinned?.status).toBe('verified');
  });

  it('reports a pinned namesake plainly and does not resolve it', () => {
    const ns = plant('codex', '#!/bin/sh\necho "Traceback (most recent call last):"\nexit 1\n');
    const status = setStoredCliPathPin(dataDir, 'codex', ns);
    expect(status.cliPath).toBe(ns);
    expect(status.cliPathError).toContain('pinned');
    expect(status.cliPathError).toContain("isn't Codex CLI");
    expect(status.cliPathError).not.toContain('undefined');
    const res = resolveVerifiedCliExecutable('codex', { pathDirs: [], homeDir: fakeHome });
    expect(res.path).toBeUndefined();
  });

  it('reports a pinned missing file plainly', () => {
    const missing = join(binDir, 'nope');
    const status = setStoredCliPathPin(dataDir, 'codex', missing);
    expect(status.cliPathError).toContain("doesn't point to a file");
    expect(cliPathStatusFor(dataDir, 'codex').cliPathError).toContain("doesn't point to a file");
  });

  it('clearing the pin returns to auto-detection', () => {
    const real = plantRealCodex(binDir);
    setStoredCliPathPin(dataDir, 'codex', real);
    const cleared = setStoredCliPathPin(dataDir, 'codex', '');
    expect(cleared.cliPath).toBe('');
    expect(getStoredCliPathPins(dataDir)).toEqual({});
    expect(getCliPathPin('codex')).toBeUndefined();
  });

  it('rejects unknown bridges and malformed paths', () => {
    expect(() => setStoredCliPathPin(dataDir, 'nope', '/x')).toThrow(/Unknown bridge/);
    expect(() => setStoredCliPathPin(dataDir, 'codex', '/x\n/evil')).toThrow(/invalid characters/);
    expect(() => setStoredCliPathPin(dataDir, 'codex', 42)).toThrow(/must be a string/);
  });

  it('listProviders surfaces the pin and its error on the bridge provider', async () => {
    const ns = plant('codex', '#!/bin/sh\necho "hello from something else"\nexit 0\n');
    setStoredCliPathPin(dataDir, 'codex', ns);
    const infos = await listProviders(dataDir);
    const bridge = infos.find((p) => p.bridge === 'codex');
    expect(bridge).toBeDefined();
    expect(bridge!.cliPath).toBe(ns);
    expect(bridge!.cliPathError).toContain('pinned');
    expect(bridge!.detected).toBe(true);
  });
});
