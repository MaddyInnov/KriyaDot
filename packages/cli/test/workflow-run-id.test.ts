// SPDX-License-Identifier: Apache-2.0
// Regression (QA 2026-10-30, WS-A D4): `kriyadot workflows run` started
// the run but printed no run id — it read `res.id` while the API returns
// `{ runId }`. The started line must name the run so users can track it.

import { describe, expect, it } from 'vitest';
import { runWorkflowCommand } from '../src/workflow-commands.js';
import type { CommandDeps } from '../src/commands.js';
import type { ParsedArgs } from '../src/args.js';

function makeDeps(): { deps: CommandDeps; stdout: string[] } {
  const stdout: string[] = [];
  const api = {
    request: async (path: string) => {
      if (path === '/workflows') return [{ id: 'wf1', name: 'Nightly Digest', nodes: [] }];
      if (path === '/workflows/wf1/run') return { runId: 'run-abc-123' };
      throw new Error(`unexpected request ${path}`);
    },
  };
  const deps = {
    api,
    stdout: { write: (s: string) => (stdout.push(s), true) },
    stderr: { write: () => true },
  } as unknown as CommandDeps;
  return { deps, stdout };
}

const parsed = {
  positional: ['Nightly Digest'],
  flags: {},
  global: { format: 'text' },
  command: 'workflows',
  subcommand: 'run',
} as unknown as ParsedArgs;

describe('workflows run output', () => {
  it('prints the run id returned by the API', async () => {
    const { deps, stdout } = makeDeps();
    const code = await runWorkflowCommand(parsed, deps);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('run run-abc-123');
    expect(stdout.join('')).toContain('Nightly Digest');
  });
});
