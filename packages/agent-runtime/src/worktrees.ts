// SPDX-License-Identifier: Apache-2.0
// git-worktree support for coding sessions (OpenCode parity).
//
// Verified 2026-10-09: NO worktree support existed anywhere in the repo
// (grep for "worktree" across agent-runtime and apps/api returned zero
// hits). This module adds it:
//
//   - WorktreeManager: create/list/remove git worktrees with safety rails —
//     branch names are sanitized, removal refuses dirty worktrees unless
//     forced, refuses paths outside the manager root, and refuses the repo's
//     main worktree.
//   - createWorktreeTools(): ToolDefinitions (`worktree_create`,
//     `worktree_list`, `worktree_remove`) confined to the workspace, flowing
//     through the normal governance approval path like the other coding tools.
//   - Session worktree links (SessionStore.attachWorktree/getWorktree):
//     a coding session can be bound to a worktree path. "Switch worktree per
//     session" is wired by passing a WorkspaceSource resolver to the coding
//     tools, e.g.:
//
//         const ws: WorkspaceSource = (ctx) =>
//           sessionStore.getWorktree(ctx.sessionId) ?? defaultWorkspaceDir;
//         createCodingTools({ workspaceDir: ws });
//
//     That gives every coding session its own isolated checkout on demand,
//     while `worktree_remove` gives safe cleanup (dirty check + force flag).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ToolContext, ToolDefinition } from './types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from './workspaces.js';

export interface CreateWorktreeOptions {
  /**
   * Branch name for the new worktree. Sanitized to
   * /^[A-Za-z0-9._\/-]+$/ (must not start with '-', no '..').
   * Defaults to `kriyadot-<rand>`.
   */
  branch?: string;
  /** Base ref to branch from (default: HEAD). */
  base?: string;
  /** Allow creating over an existing (empty) directory. */
  force?: boolean;
}

export interface WorktreeInfo {
  /** Absolute path of the worktree. */
  path: string;
  /** HEAD sha of the worktree (from `git worktree list --porcelain`). */
  head: string;
  /** Branch name, or null when detached. */
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

function randomSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class WorktreeManager {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private git(repoPath: string, args: string[], opts: { allowFailure?: boolean } = {}): string {
    const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0 && !opts.allowFailure) {
      const detail = (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 500);
      throw new Error(`git ${args[0]} failed: ${detail}`);
    }
    return r.stdout ?? '';
  }

  isGitRepo(path: string): boolean {
    try {
      return this.git(path, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
    } catch {
      return false;
    }
  }

  private sanitizeBranch(branch: string): string {
    if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.includes('..')) {
      throw new Error(`worktree: invalid branch name "${branch}"`);
    }
    return branch;
  }

  /** Absolute path of the repo's main worktree (the directory the repo lives in). */
  mainWorktree(repoPath: string): string {
    return resolve(this.git(repoPath, ['rev-parse', '--show-toplevel']).trim());
  }

  list(repoPath: string): WorktreeInfo[] {
    if (!this.isGitRepo(repoPath)) throw new Error(`worktree: not a git repo: "${repoPath}"`);
    const out = this.git(repoPath, ['worktree', 'list', '--porcelain']);
    const infos: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> & { path?: string } = {};
    const flush = () => {
      if (cur.path) {
        infos.push({
          path: cur.path,
          head: cur.head ?? '',
          branch: cur.branch ?? null,
          detached: cur.detached ?? false,
          locked: cur.locked ?? false,
          prunable: cur.prunable ?? false,
        });
      }
      cur = {};
    };
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        cur = { path: resolve(line.slice(9).trim()) };
      } else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      else if (line === 'detached') cur.detached = true;
      else if (line === 'locked') cur.locked = true;
      else if (line === 'prunable') cur.prunable = true;
    }
    flush();
    return infos;
  }

  /**
   * Create a worktree for `repoPath` under the manager root. Returns the
   * WorktreeInfo of the new worktree. Refuses when the repo path is not a
   * git repo or the branch name is unsafe.
   */
  create(repoPath: string, opts: CreateWorktreeOptions = {}): WorktreeInfo {
    const repo = resolve(repoPath);
    if (!this.isGitRepo(repo)) throw new Error(`worktree: not a git repo: "${repoPath}"`);
    const branch = opts.branch === undefined ? `kriyadot-${randomSuffix()}` : this.sanitizeBranch(opts.branch);
    const dirName = branch.replace(/\//g, '__');
    const target = join(this.root, dirName);
    if (existsSync(target) && !opts.force) {
      throw new Error(`worktree: target already exists: "${target}" (pass force to reuse)`);
    }
    const args = ['worktree', 'add'];
    if (opts.force) args.push('--force');
    args.push(target, '-b', branch);
    if (opts.base) args.push(opts.base);
    this.git(repo, args);
    const info = this.list(repo).find((w) => w.path === target);
    if (!info) throw new Error('worktree: created but not listed (unexpected)');
    return info;
  }

  /**
   * Remove a worktree with safety rails:
   * - the path must resolve inside the manager root (refuses the main
   *   worktree / repo root / arbitrary directories),
   * - a dirty worktree (uncommitted changes) is refused unless `force`.
   * Removal goes through `git worktree remove` so git's bookkeeping stays
   * consistent.
   */
  remove(repoPath: string, worktreePath: string, opts: { force?: boolean } = {}): void {
    const repo = resolve(repoPath);
    if (!this.isGitRepo(repo)) throw new Error(`worktree: not a git repo: "${repoPath}"`);
    const target = resolve(worktreePath);
    const rel = relative(this.root, target);
    if (rel === '' || rel.startsWith('..') || target === this.root) {
      throw new Error(`worktree: refusing to remove path outside the worktree root: "${worktreePath}"`);
    }
    const main = this.mainWorktree(repo);
    if (target === main || target === repo) {
      throw new Error('worktree: refusing to remove the main worktree');
    }
    const known = this.list(repo).some((w) => w.path === target);
    if (!known) throw new Error(`worktree: not a registered worktree of this repo: "${worktreePath}"`);
    if (!opts.force) {
      const dirty = this.git(target, ['status', '--porcelain']).trim();
      if (dirty) {
        throw new Error(
          `worktree: uncommitted changes in "${worktreePath}" — refusing. Pass force to discard them.`,
        );
      }
    }
    const args = ['worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(target);
    this.git(repo, args);
  }
}

// ---------------------------------------------------------------------------
// ToolDefinitions (confined to the workspace, governance-gated like coding)
// ---------------------------------------------------------------------------

function confine(workspaceDir: string, p: string): string {
  const root = resolve(workspaceDir);
  const resolved = resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: "${p}"`);
  }
  return resolved;
}

export interface CreateWorktreeToolsOptions {
  workspaceDir: WorkspaceSource;
  /**
   * Root directory new worktrees are created under. MUST be inside the
   * workspace; defaults to `<workspace>/.worktrees`.
   */
  worktreeRoot?: WorkspaceSource;
}

export function createWorktreeTools(opts: CreateWorktreeToolsOptions): ToolDefinition[] {
  const managerFor = (ctx: ToolContext): WorktreeManager => {
    const ws = resolveWorkspaceDir(opts.workspaceDir, ctx);
    const root = opts.worktreeRoot === undefined ? join(ws, '.worktrees') : resolveWorkspaceDir(opts.worktreeRoot, ctx);
    const rootResolved = resolve(root);
    const wsResolved = resolve(ws);
    if (rootResolved !== wsResolved && !rootResolved.startsWith(wsResolved + sep)) {
      throw new Error('worktree: worktreeRoot must be inside the workspace');
    }
    return new WorktreeManager(rootResolved);
  };

  const createTool: ToolDefinition = {
    name: 'worktree_create',
    description:
      'Create a git worktree (isolated checkout) for a coding session. Returns the ' +
      'absolute path of the new worktree. The worktree is created under the ' +
      'worktree root inside the workspace. Goes through the normal approval flow.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace-relative path of the git repo (default: workspace root)' },
        branch: { type: 'string', description: 'Branch name for the new worktree (default: kriyadot-<random>)' },
        base: { type: 'string', description: 'Base ref to branch from (default: HEAD)' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(opts.workspaceDir, ctx);
      const mgr = managerFor(ctx);
      const repo = args.repo === undefined ? ws : confine(ws, String(args.repo));
      const info = mgr.create(repo, {
        branch: args.branch === undefined ? undefined : String(args.branch),
        base: args.base === undefined ? undefined : String(args.base),
      });
      return { ok: true, path: info.path, branch: info.branch, head: info.head };
    },
  };

  const listTool: ToolDefinition = {
    name: 'worktree_list',
    description: 'List git worktrees of a repo.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace-relative path of the git repo (default: workspace root)' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(opts.workspaceDir, ctx);
      const mgr = managerFor(ctx);
      const repo = args.repo === undefined ? ws : confine(ws, String(args.repo));
      return { worktrees: mgr.list(repo) };
    },
  };

  const removeTool: ToolDefinition = {
    name: 'worktree_remove',
    description:
      'Remove a git worktree created under the worktree root. Refuses dirty ' +
      'worktrees unless force=true. Refuses paths outside the worktree root ' +
      'and the main worktree. Goes through the normal approval flow.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace-relative path of the git repo (default: workspace root)' },
        path: { type: 'string', description: 'Worktree path to remove (absolute, or workspace-relative)' },
        force: { type: 'boolean', description: 'Discard uncommitted changes (default false)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(opts.workspaceDir, ctx);
      const mgr = managerFor(ctx);
      const repo = args.repo === undefined ? ws : confine(ws, String(args.repo));
      const raw = String(args.path ?? '');
      const target = raw.startsWith('/') ? raw : resolve(ws, raw);
      mgr.remove(repo, target, { force: args.force === true });
      return { ok: true, removed: target };
    },
  };

  return [createTool, listTool, removeTool];
}
