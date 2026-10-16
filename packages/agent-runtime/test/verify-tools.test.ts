// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDiffReview,
  checksForProject,
  createVerifyTools,
  detectProject,
  parseNumstat,
  runProjectChecks,
} from '../src/tools/verify.js';

function makeWs(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-test-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(dir, name.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

describe('detectProject', () => {
  it('detects node via package.json', () => {
    const ws = makeWs({ 'package.json': '{}' });
    expect(detectProject(ws).kind).toBe('node');
  });
  it('detects go via go.mod', () => {
    const ws = makeWs({ 'go.mod': 'module x' });
    expect(detectProject(ws).kind).toBe('go');
  });
  it('detects rust via Cargo.toml', () => {
    const ws = makeWs({ 'Cargo.toml': '[package]' });
    expect(detectProject(ws).kind).toBe('rust');
  });
  it('detects python via pyproject.toml', () => {
    const ws = makeWs({ 'pyproject.toml': '[project]' });
    expect(detectProject(ws).kind).toBe('python');
  });
  it('returns unknown for empty dirs', () => {
    const ws = makeWs({});
    expect(detectProject(ws).kind).toBe('unknown');
  });
  it('prefers package.json when multiple markers exist', () => {
    const ws = makeWs({ 'package.json': '{}', 'go.mod': 'module x' });
    expect(detectProject(ws).kind).toBe('node');
  });
});

describe('checksForProject', () => {
  it('node: uses test/lint/build scripts when defined', () => {
    const ws = makeWs({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc' } }),
    });
    const checks = checksForProject('node', ws);
    expect(checks.map((c) => c.name)).toEqual(['test', 'lint', 'build']);
  });
  it('node: skips the npm placeholder test script', () => {
    const ws = makeWs({
      'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    });
    expect(checksForProject('node', ws)).toEqual([]);
  });
  it('go/rust/python produce single test commands', () => {
    const ws = makeWs({});
    expect(checksForProject('go', ws)[0]?.command).toEqual(['go', 'test', './...']);
    expect(checksForProject('rust', ws)[0]?.command).toEqual(['cargo', 'test']);
    expect(checksForProject('python', ws)[0]?.command[0]).toBe('python3');
  });
  it('unknown produces no checks', () => {
    expect(checksForProject('unknown', makeWs({}))).toEqual([]);
  });
});

describe('runProjectChecks', () => {
  it('runs checks and reports pass/fail with output', async () => {
    const ws = makeWs({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    const calls: string[][] = [];
    const result = await runProjectChecks(ws, async (cmd, cwd) => {
      calls.push(cmd);
      expect(cwd).toBe(ws);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    expect(result.project).toBe('node');
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.output).toContain('ok');
    expect(calls[0]).toEqual(['npm', 'test']);
  });
  it('stops at the first failure', async () => {
    const ws = makeWs({
      'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint' } }),
    });
    const calls: string[][] = [];
    const result = await runProjectChecks(ws, async (cmd) => {
      calls.push(cmd);
      return { stdout: 'FAIL', stderr: '', exitCode: 1 };
    });
    expect(result.passed).toBe(false);
    expect(calls).toHaveLength(1); // lint never ran
  });
  it('returns a note when nothing is verifiable', async () => {
    const ws = makeWs({});
    const result = await runProjectChecks(ws, async () => {
      throw new Error('should not run');
    });
    expect(result.passed).toBe(true);
    expect(result.note).toContain('No recognizable project');
  });
});

describe('parseNumstat', () => {
  it('parses added/removed per file', () => {
    const files = parseNumstat('10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts\n');
    expect(files).toEqual([
      { path: 'src/a.ts', added: 10, removed: 2, status: 'modified' },
      { path: 'src/b.ts', added: 0, removed: 5, status: 'modified' },
    ]);
  });
  it('handles binary files (dash counts)', () => {
    const files = parseNumstat('-\t-\timg.png\n');
    expect(files[0]).toMatchObject({ path: 'img.png', added: 0, removed: 0 });
  });
});

describe('buildDiffReview', () => {
  it('falls back to session touches outside git', async () => {
    const ws = makeWs({});
    const exec = async () => ({ stdout: '', stderr: 'not a repo', exitCode: 128 });
    const tracker = {
      getToolCalls: () => [
        { name: 'write_file', args: { path: 'a.txt' } },
        { name: 'read_file', args: { path: 'b.txt' } },
      ],
    };
    const review = await buildDiffReview(ws, 'sess-1', exec, tracker);
    expect(review.note).toContain('Not a git repository');
    expect(review.sessionTouched).toEqual(['a.txt']);
  });
  it('parses git numstat and untracked files', async () => {
    const ws = makeWs({});
    const exec = async (cmd: string[]) => {
      if (cmd[1] === 'rev-parse') return { stdout: 'true\n', stderr: '', exitCode: 0 };
      if (cmd[1] === 'diff') return { stdout: '3\t1\tf.ts\n', stderr: '', exitCode: 0 };
      return { stdout: '?? new.txt\n', stderr: '', exitCode: 0 };
    };
    const review = await buildDiffReview(ws, 'sess-1', exec);
    expect(review.files.map((f) => f.path)).toEqual(['f.ts', 'new.txt']);
    expect(review.totalAdded).toBe(3);
    expect(review.files[1]?.status).toBe('untracked');
  });
});

describe('createVerifyTools', () => {
  it('registers verify_changes and diff_review with completion guidance', () => {
    const tools = createVerifyTools({ workspaceDir: '/tmp/ws' });
    expect(tools.map((t) => t.name).sort()).toEqual(['diff_review', 'verify_changes']);
    const verify = tools.find((t) => t.name === 'verify_changes')!;
    expect(verify.description).toContain('BEFORE telling the user the work is done');
  });
});
