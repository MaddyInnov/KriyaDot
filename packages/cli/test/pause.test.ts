// SPDX-License-Identifier: Apache-2.0
// W14d CLI: `kriyadot pause` / `resume` / `status` (+ `pause status`)
// hit the system pause API correctly (mock API — no real server).

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { makeDeps, makeFakeApi } from './fake-api.js';

describe('kriyadot pause / resume / status', () => {
  it('pause calls POST /system/pause and reports the paused state', async () => {
    const fake = makeFakeApi();
    const deps = makeDeps(fake);
    const code = await runCommand(parseArgs(['pause']), deps);
    expect(code).toBe(0);
    expect(fake.pauseCalls).toEqual(['POST /system/pause']);
    expect(deps.stdoutText()).toContain('paused');
  });

  it('resume calls POST /system/resume and reports running normally', async () => {
    const fake = makeFakeApi();
    fake.pauseState = { paused: true, pausedAt: 1700000000000, pausedBy: 'web' };
    const deps = makeDeps(fake);
    const code = await runCommand(parseArgs(['resume']), deps);
    expect(code).toBe(0);
    expect(fake.pauseCalls).toEqual(['POST /system/resume']);
    expect(deps.stdoutText()).toContain('not paused');
  });

  it('status and pause status both read GET /system/pause-state', async () => {
    const fake = makeFakeApi();
    const deps = makeDeps(fake);
    expect(await runCommand(parseArgs(['status']), deps)).toBe(0);
    expect(await runCommand(parseArgs(['pause', 'status']), deps)).toBe(0);
    expect(fake.pauseCalls).toEqual(['GET /system/pause-state', 'GET /system/pause-state']);
  });

  it('--format json prints the raw state object', async () => {
    const fake = makeFakeApi();
    const deps = makeDeps(fake);
    const code = await runCommand(parseArgs(['pause', '--format', 'json']), deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(deps.stdoutText()) as { paused: boolean };
    expect(parsed.paused).toBe(true);
  });

  it('an invalid pause subcommand is a usage error (exit 2, no API call)', async () => {
    const fake = makeFakeApi();
    const deps = makeDeps(fake);
    const code = await runCommand(parseArgs(['pause', 'bogus']), deps);
    expect(code).toBe(2);
    expect(fake.pauseCalls).toEqual([]);
  });
});
