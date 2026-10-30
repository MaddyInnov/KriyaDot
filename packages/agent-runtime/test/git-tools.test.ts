// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { __git_test__, createGitTools } from '../src/tools/git.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };

async function makeTools(): Promise<{ dir: string; byName: Map<string, ToolDefinition> }> {
  const dir = await mkdtemp(join(tmpdir(), 'git-tools-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  const tools = createGitTools({ workspaceDir: dir });
  return { dir, byName: new Map(tools.map((t) => [t.name, t])) };
}

describe('git tools', () => {
  it('registers all five tools', async () => {
    const { byName } = await makeTools();
    for (const name of ['git_status', 'git_diff', 'git_commit', 'git_branch', 'git_push']) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it('confine rejects traversal', () => {
    expect(() => __git_test__.confine('/tmp/ws', '../etc')).toThrow(/escapes/);
    expect(() => __git_test__.confine('/tmp/ws', '/etc/passwd')).toThrow(/escapes/);
  });

  it('git_status shows clean tree', async () => {
    const { byName } = await makeTools();
    const r = (await byName.get('git_status')!.handler({}, CTX)) as { status: string };
    expect(typeof r.status).toBe('string');
  });

  it('git_diff + git_commit round-trip', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'hello.txt'), 'hello\n');
    const diff = (await byName.get('git_diff')!.handler({}, CTX)) as { diff: string };
    expect(diff.diff).toContain('hello.txt');
    const commit = (await byName.get('git_commit')!.handler({ message: 'add hello' }, CTX)) as {
      committed: boolean;
    };
    expect(commit.committed).toBe(true);
    const status = (await byName.get('git_status')!.handler({}, CTX)) as { status: string };
    // Clean tree: only the branch header line (## master), no file entries.
    const fileLines = status.status.split('\n').filter((l) => l && !l.startsWith('##'));
    expect(fileLines).toEqual([]);
  });

  it('git_commit rejects empty message', async () => {
    const { byName } = await makeTools();
    await expect(byName.get('git_commit')!.handler({ message: '' }, CTX)).rejects.toThrow(/required/);
  });

  it('git_branch create/switch/list', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await byName.get('git_commit')!.handler({ message: 'base commit' }, CTX);
    const created = (await byName.get('git_branch')!.handler({ action: 'create', name: 'feature/x' }, CTX)) as {
      branch: string;
    };
    expect(created.branch).toBe('feature/x');
    const listed = (await byName.get('git_branch')!.handler({ action: 'list' }, CTX)) as {
      branches: string[];
    };
    expect(listed.branches.some((b) => b.includes('feature/x'))).toBe(true);
  });

  it('git_branch rejects bad names', async () => {
    const { byName } = await makeTools();
    await expect(
      byName.get('git_branch')!.handler({ action: 'create', name: '-bad' }, CTX),
    ).rejects.toThrow(/Invalid/);
    await expect(
      byName.get('git_branch')!.handler({ action: 'create', name: 'a..b' }, CTX),
    ).rejects.toThrow(/Invalid/);
  });

  it('git_push fails gracefully with no remote', async () => {
    const { byName } = await makeTools();
    await expect(byName.get('git_push')!.handler({}, CTX)).rejects.toThrow(/git push failed/);
  });
});

// #73: BotConfig.commitAttribution flows through ToolContext into
// git_commit output — the recorded commit message carries the
// attribution line, deduped and capped at 200 chars.
describe('git_commit attribution (#73)', () => {
  const ATTRIBUTION = 'Co-authored-by: KriyaDot Bot <bot@kriyadot.local>';

  function lastCommitBody(dir: string): string {
    return execSync('git log -1 --format=%B', { cwd: dir, encoding: 'utf8' });
  }

  it('appends the attribution from ctx to the commit message', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'a.txt'), 'a\n');
    const ctx: ToolContext = { ...CTX, commitAttribution: ATTRIBUTION };
    await byName.get('git_commit')!.handler({ message: 'add a' }, ctx);
    const body = lastCommitBody(dir);
    expect(body).toContain('add a');
    expect(body).toContain(ATTRIBUTION);
  });

  it('does not duplicate the attribution when the message already carries it', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'b.txt'), 'b\n');
    const ctx: ToolContext = { ...CTX, commitAttribution: ATTRIBUTION };
    await byName.get('git_commit')!.handler({ message: `add b\n\n${ATTRIBUTION}` }, ctx);
    const body = lastCommitBody(dir);
    expect(body.split(ATTRIBUTION).length - 1).toBe(1);
  });

  it('caps the attribution at 200 chars', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'c.txt'), 'c\n');
    const long = `Co-authored-by: ${'x'.repeat(300)}`;
    const ctx: ToolContext = { ...CTX, commitAttribution: long };
    await byName.get('git_commit')!.handler({ message: 'add c' }, ctx);
    const body = lastCommitBody(dir);
    expect(body).toContain(long.slice(0, 200));
    expect(body).not.toContain(long);
  });

  it('commits without attribution when ctx carries none', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'd.txt'), 'd\n');
    await byName.get('git_commit')!.handler({ message: 'add d' }, CTX);
    expect(lastCommitBody(dir).trim()).toBe('add d');
  });
});
