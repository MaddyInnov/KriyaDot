// SPDX-License-Identifier: Apache-2.0
// Kernel-sandbox broadening (#117): the kernel backend is the DEFAULT
// confinement for run_command when no container backend is configured;
// the writable root is the bot workspace; unsandboxed host execution
// requires an explicit opt-out (or is a loudly-flagged fallback).
//
// These tests use the REAL backend chain (no mocks): on this Linux VM
// Docker is absent and E2B is unset, so the chain must land on
// Landlock. Assertions about confinement follow the ABI-gated pattern
// of sandbox-kernel.test.ts.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeSandboxedCommand, sandboxBackend } from '../src/tools/sandbox.js';
import { ensureLandlockHelper, landlockAbiVersion } from '../src/tools/sandbox-kernel.js';
import { createBuiltInTools } from '../src/tools/builtin.js';
import type { ToolContext } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };
const KEYS = [
  'E2B_API_KEY',
  'SANDBOX_BACKEND',
  'SANDBOX_KERNEL_FALLBACK',
  'SANDBOX_DISABLE_KERNEL',
  'SANDBOX_ALLOW_HOST',
  'SANDBOX_HOST_FALLBACK',
  'SANDBOX_STRICT',
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('default sandbox resolution (#117)', () => {
  it('picks the kernel backend by default on this Linux VM (no container configured)', async () => {
    if (process.platform !== 'linux') return;
    // Compile the helper first (first-use compile is async; the sync
    // resolver requires the compiled helper to exist).
    const bin = await ensureLandlockHelper();
    expect(bin).not.toBeNull();
    // No E2B key, no Docker on this VM → container legs are out.
    expect(sandboxBackend()).toBe('landlock');
  });

  it('executes confined with the workspace as writable root; $HOME writes blocked', async () => {
    if (process.platform !== 'linux') return;
    await ensureLandlockHelper();
    const abi = await landlockAbiVersion();
    if (abi < 1) return; // ABI-gated, mirroring sandbox-kernel tests
    const ws = mkdtempSync(join(tmpdir(), 'kriyadot-sandbox-default-'));
    try {
      const res = await executeSandboxedCommand('echo in-workspace > marker.txt && cat marker.txt', {
        workspaceDir: ws,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('in-workspace');
      expect(res.sandboxed).toBe(true);
      expect(res.backend).toBe('landlock');
      expect(existsSync(join(ws, 'marker.txt'))).toBe(true);

      const home = process.env.HOME ?? '/root';
      const escape = await executeSandboxedCommand(
        `touch ${home}/sandbox-default-escape && echo ESCAPED || echo BLOCKED`,
        { workspaceDir: ws },
      );
      expect(escape.stdout).toContain('BLOCKED');
      expect(escape.stdout).not.toContain('ESCAPED');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('run_command (builtin) is sandboxed by default and reports its backend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-run-command-'));
    try {
      const tools = createBuiltInTools({ workspaceDir: dir });
      const run = tools.find((t) => t.name === 'run_command')!;
      const res = (await run.handler({ command: 'echo default-confined' }, CTX)) as {
        exitCode: number;
        stdout: string;
        sandboxed: boolean;
        backend: string;
        warning?: string;
      };
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('default-confined');
      if (process.platform === 'linux' && (await landlockAbiVersion()) >= 1) {
        expect(res.sandboxed).toBe(true);
        expect(res.backend).toBe('landlock');
        expect(res.warning).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('host execution happens only with the explicit opt-out, flagged in metadata', async () => {
    process.env.SANDBOX_DISABLE_KERNEL = '1';
    process.env.SANDBOX_ALLOW_HOST = '1';
    // No E2B, no Docker on this VM, kernel opted out of → host opt-out.
    expect(sandboxBackend()).toBe('host');
    const res = await executeSandboxedCommand('echo on-host');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('on-host');
    expect(res.sandboxed).toBe(false);
    expect(res.backend).toBe('host');
    expect(res.warning).toMatch(/UNSANDBOXED/);
  });

  it('strict mode fails closed when no backend is available', async () => {
    process.env.SANDBOX_DISABLE_KERNEL = '1';
    process.env.SANDBOX_STRICT = '1';
    // Docker is absent on this VM and E2B is unset, so nothing can
    // confine the run; strict mode must refuse rather than fall back.
    await expect(executeSandboxedCommand('echo never')).rejects.toThrow(/No sandbox backend available/);
  });
});
