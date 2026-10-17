// SPDX-License-Identifier: Apache-2.0
// Tests for the new CLI surface (G5 + W1) with a mocked API:
// - threads delete <id> --yes deletes via the API
// - routines runs <id> lists runs
// - team apply <file> handles .md and .json
// - team export <teamId> [--markdown]

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { makeDeps, makeFakeApi } from './fake-api.js';

function run(argv: string[], fake = makeFakeApi()) {
  const deps = makeDeps(fake);
  return runCommand(parseArgs(argv), deps).then((code) => ({ code, deps, fake }));
}

describe('threads delete', () => {
  it('deletes with --yes', async () => {
    const { code, deps, fake } = await run(['threads', 'delete', 'sess-1', '--yes']);
    expect(code).toBe(0);
    expect(fake.deletedThreads).toEqual(['sess-1']);
    expect(deps.stdoutText()).toContain('Deleted thread sess-1');
  });

  it('refuses without --yes', async () => {
    const { code, fake } = await run(['threads', 'delete', 'sess-1']);
    expect(code).toBe(1);
    expect(fake.deletedThreads).toEqual([]);
  });

  it('validates the subcommand', async () => {
    const { code } = await run(['threads', 'delete']);
    expect(code).toBe(1);
  });
});

describe('routines runs', () => {
  it('lists runs for a routine', async () => {
    const fake = makeFakeApi({
      routineRuns: [
        { id: 'run-1', routineId: 'r1', status: 'succeeded', startedAt: 1700000000000 },
        { id: 'run-2', routineId: 'r1', status: 'failed' },
      ],
    });
    const { code, deps } = await run(['routines', 'runs', 'r1'], fake);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toContain('run-1');
    expect(deps.stdoutText()).toContain('succeeded');
  });

  it('prints JSON with --format json', async () => {
    const fake = makeFakeApi({ routineRuns: [{ id: 'run-1', routineId: 'r1', status: 'ok' }] });
    const { code, deps } = await run(['routines', 'runs', 'r1', '--format', 'json'], fake);
    expect(code).toBe(0);
    expect(JSON.parse(deps.stdoutText())).toHaveLength(1);
  });
});

describe('team apply/export', () => {
  it('applies a markdown team doc', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamcli-'));
    try {
      const file = join(dir, 'team.md');
      writeFileSync(file, '# Team: Test\n\n## Members\n- **A** (role: member)\n', 'utf8');
      const { code, deps, fake } = await run(['team', 'apply', file]);
      expect(code).toBe(0);
      expect(fake.importedMarkdown).toContain('# Team: Test');
      expect(deps.stdoutText()).toContain('Team imported');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a JSON manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamcli-'));
    try {
      const file = join(dir, 'kriyadot.team.json');
      writeFileSync(file, JSON.stringify({ name: 'T', members: [] }), 'utf8');
      const { code, deps, fake } = await run(['team', 'apply', file]);
      expect(code).toBe(0);
      expect(fake.importedManifest).toMatchObject({ name: 'T' });
      expect(deps.stdoutText()).toContain('Team applied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports markdown with --markdown', async () => {
    const fake = makeFakeApi({ exportedMarkdown: '# Team: Exported\n\nBody here.\n' });
    const { code, deps } = await run(['team', 'export', 'team-1', '--markdown'], fake);
    expect(code).toBe(0);
    expect(deps.stdoutText()).toContain('# Team: Exported');
  });
});
