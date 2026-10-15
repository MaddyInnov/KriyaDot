// SPDX-License-Identifier: Apache-2.0
// git-worktree tests. No paid APIs; tests init throwaway git repos in a temp
// dir with the local git CLI.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { WorktreeManager, createWorktreeTools } from '../src/worktrees.js';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kriyadot-wt-'));
  repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('creates, lists, and removes a clean worktree', () => {
    const mgr = new WorktreeManager(join(base, 'wts'));
    const info = mgr.create(repo, { branch: 'feature/one' });
    expect(info.branch).toBe('feature/one');
    expect(info.path.startsWith(mgr.root)).toBe(true);

    const list = mgr.list(repo);
    expect(list.some((w) => w.path === info.path && w.branch === 'feature/one')).toBe(true);

    mgr.remove(repo, info.path);
    expect(mgr.list(repo).some((w) => w.path === info.path)).toBe(false);
  });

  it('rejects unsafe branch names', () => {
    const mgr = new WorktreeManager(join(base, 'wts'));
    expect(() => mgr.create(repo, { branch: '../../etc' })).toThrow(/invalid branch/);
    expect(() => mgr.create(repo, { branch: '-rf' })).toThrow(/invalid branch/);
    expect(() => mgr.create(repo, { branch: 'a b' })).toThrow(/invalid branch/);
  });

  it('refuses a non-git repo', () => {
    const mgr = new WorktreeManager(join(base, 'wts'));
    expect(() => mgr.create(join(base, 'repo', 'nothing-here'), { branch: 'x' })).toThrow(/not a git repo/);
  });

  it('refuses to remove a dirty worktree without force, allows with force', () => {
    const mgr = new WorktreeManager(join(base, 'wts'));
    const info = mgr.create(repo, { branch: 'dirty' });
    writeFileSync(join(info.path, 'uncommitted.txt'), 'work in progress\n');
    expect(() => mgr.remove(repo, info.path)).toThrow(/uncommitted changes/);
    mgr.remove(repo, info.path, { force: true });
    expect(mgr.list(repo).some((w) => w.path === info.path)).toBe(false);
  });

  it('refuses to remove the main worktree and paths outside the root', () => {
    const mgr = new WorktreeManager(join(base, 'wts'));
    expect(() => mgr.remove(repo, repo)).toThrow(/outside the worktree root|main worktree/);
    expect(() => mgr.remove(repo, join(base, 'elsewhere'))).toThrow(/outside the worktree root/);
  });
});

describe('createWorktreeTools', () => {
  const ctx = { sessionId: 's1', botId: 'b1' };

  it('create/list/remove flow through the tools, confined to the workspace', async () => {
    const ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    // make the workspace itself a git repo so repo defaults work
    git(ws, 'init', '-q');
    git(ws, 'config', 'user.email', 'test@example.com');
    git(ws, 'config', 'user.name', 'test');
    writeFileSync(join(ws, 'f.txt'), 'x\n');
    git(ws, 'add', 'f.txt');
    git(ws, 'commit', '-qm', 'init');

    const tools = createWorktreeTools({ workspaceDir: ws });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['worktree_create', 'worktree_list', 'worktree_remove']);

    const created = (await byName['worktree_create']!.handler({ branch: 'tooltest' }, ctx)) as {
      ok: boolean;
      path: string;
      branch: string;
    };
    expect(created.ok).toBe(true);
    expect(created.branch).toBe('tooltest');
    expect(created.path.startsWith(join(ws, '.worktrees'))).toBe(true);

    const listed = (await byName['worktree_list']!.handler({}, ctx)) as {
      worktrees: Array<{ path: string }>;
    };
    expect(listed.worktrees.some((w) => w.path === created.path)).toBe(true);

    // path traversal is refused by the tool layer
    await expect(byName['worktree_create']!.handler({ repo: '../../escape', branch: 'x' }, ctx)).rejects.toThrow(
      /escapes workspace/,
    );

    const removed = (await byName['worktree_remove']!.handler({ path: created.path }, ctx)) as { ok: boolean };
    expect(removed.ok).toBe(true);
  });
});
