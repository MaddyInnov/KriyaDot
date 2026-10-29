// SPDX-License-Identifier: Apache-2.0
// Git tools for the agent runtime: status, diff, commit, branch, push.
//
// Every operation is confined to the workspace directory (same confine()
// pattern as tools/builtin.ts and tools/coding.ts). Git commands run via
// spawnSync with cwd set to the workspace; no shell is involved.
//
// Agent workflow (Codex-style): write code → git_status/git_diff (review) →
// git_commit → git_push → create a PR via the platform's GitHub API
// (POST /api/github/pr). git_push and PR creation require human approval;
// git_commit and git_branch also require approval (they mutate history).
// git_status and git_diff are read-only and auto-allowed.

import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';

/**
 * Resolve `p` inside `workspaceDir`. Throws if the resolved path escapes the
 * workspace (directory traversal). Mirrors tools/builtin.ts.
 */
function confine(workspaceDir: string, p: string): string {
  const root = resolve(workspaceDir);
  const resolved = resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: "${p}"`);
  }
  return resolved;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Run a git subcommand in the workspace. No shell; args are passed directly. */
function runGit(workspaceDir: string, args: string[]): GitResult {
  const cwd = confine(workspaceDir, '.');
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    // Never let git prompt for credentials or open an editor.
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
    },
  });
  return {
    ok: proc.status === 0,
    stdout: (proc.stdout ?? '').toString(),
    stderr: (proc.stderr ?? '').toString(),
    exitCode: proc.status,
  };
}

function gitStatusTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'git_status',
    description:
      'Show git working-tree status (porcelain). Read-only. Use it to review ' +
      'what changed before committing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const r = runGit(ws, ['status', '--porcelain', '--branch']);
      if (!r.ok) throw new Error(`git status failed: ${r.stderr.trim() || r.stdout.trim()}`);
      return { status: r.stdout };
    },
  };
}

function gitDiffTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'git_diff',
    description:
      'Show the diff of uncommitted changes (git diff HEAD). Read-only. ' +
      'Use it to review code before git_commit. Set staged=true for the ' +
      'staged diff, or path to limit to one workspace-relative file.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged (cached) diff instead' },
        path: { type: 'string', description: 'Workspace-relative file path to limit the diff to' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const pathArg = typeof args.path === 'string' && args.path ? args.path : null;
      if (pathArg) confine(ws, pathArg); // validate early

      const headExists = runGit(ws, ['rev-parse', '--verify', 'HEAD']).ok;
      const gitArgs = ['diff', '--no-color'];
      if (args.staged === true) {
        // --cached works with or without HEAD.
        gitArgs.push('--cached');
        if (headExists) gitArgs.push('HEAD');
      } else if (headExists) {
        gitArgs.push('HEAD');
      } else {
        // Fresh repo, nothing committed yet: render untracked files as
        // new-file diffs.
        const st = runGit(ws, ['status', '--porcelain']);
        let untracked = st.stdout
          .split('\n')
          .filter((l) => l.startsWith('??'))
          .map((l) => l.slice(3).trim())
          .filter(Boolean);
        if (pathArg) untracked = untracked.filter((f) => f === pathArg);
        const parts: string[] = [];
        for (const f of untracked.slice(0, 20)) {
          try {
            const { readFileSync } = await import('node:fs');
            const content = readFileSync(confine(ws, f), 'utf-8').slice(0, 10_000);
            parts.push(
              `--- /dev/null\n+++ b/${f}\n` +
                content.split('\n').map((l) => `+${l}`).join('\n'),
            );
          } catch { /* skip unreadable */ }
        }
        const diff = parts.join('\n').slice(0, 50_000);
        return { diff, truncated: untracked.length > 20, note: 'no commits yet — showing untracked files' };
      }
      if (pathArg) gitArgs.push('--', confine(ws, pathArg));
      const r = runGit(ws, gitArgs);
      if (!r.ok) throw new Error(`git diff failed: ${r.stderr.trim() || r.stdout.trim()}`);
      const diff = r.stdout.slice(0, 50_000); // cap output
      return { diff, truncated: r.stdout.length > diff.length };
    },
  };
}

function gitCommitTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'git_commit',
    mutating: true,
    description:
      'Stage all changes and commit with a message. REQUIRES HUMAN APPROVAL. ' +
      'Part of the Codex-style loop: write code → review (git_status/git_diff) → ' +
      'git_commit → git_push → open a PR via POST /api/github/pr.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (required, 1-500 chars)' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const message = String(args.message ?? '').trim();
      if (!message || message.length > 500) {
        throw new Error('message is required (1-500 chars)');
      }
      const attribution = ctx.commitAttribution?.trim();
      const fullMessage =
        attribution && !message.includes(attribution)
          ? `${message}\n\n${attribution.slice(0, 200)}`
          : message;
      const add = runGit(ws, ['add', '-A']);
      if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
      const commit = runGit(ws, ['commit', '-m', fullMessage, '--no-verify']);
      if (!commit.ok) {
        throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
      }
      return { committed: true, output: commit.stdout.trim().slice(0, 2000) };
    },
  };
}

function gitBranchTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'git_branch',
    mutating: true,
    description:
      'Create and/or switch branches. REQUIRES HUMAN APPROVAL. ' +
      'Actions: "create" (new branch), "switch" (checkout existing), "list". ' +
      'Use it to start feature work on a fresh branch before opening a PR.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'switch', 'list'], description: 'Branch action' },
        name: { type: 'string', description: 'Branch name (required for create/switch)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const action = String(args.action ?? '');
      if (action === 'list') {
        const r = runGit(ws, ['branch', '--list']);
        if (!r.ok) throw new Error(`git branch failed: ${r.stderr.trim()}`);
        return { branches: r.stdout.trim().split('\n').map((b) => b.trim()).filter(Boolean) };
      }
      const name = String(args.name ?? '').trim();
      if (!name || !/^[A-Za-z0-9._/-]{1,100}$/.test(name)) {
        throw new Error('name is required for create/switch (letters, digits, . _ / -)');
      }
      if (name.startsWith('-') || name.includes('..')) {
        throw new Error('Invalid branch name');
      }
      const gitArgs = action === 'create' ? ['checkout', '-b', name] : ['checkout', name];
      const r = runGit(ws, gitArgs);
      if (!r.ok) throw new Error(`git ${action} failed: ${(r.stderr || r.stdout).trim()}`);
      return { ok: true, action, branch: name };
    },
  };
}

function gitPushTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'git_push',
    mutating: true,
    description:
      'Push the current branch to the remote. REQUIRES HUMAN APPROVAL ' +
      '(network + mutates the remote). After pushing, open a PR via ' +
      'POST /api/github/pr.',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remote name (default: origin)' },
        branch: { type: 'string', description: 'Branch to push (default: current)' },
        setUpstream: { type: 'boolean', description: 'Set upstream tracking (-u)' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const remote = String(args.remote ?? 'origin').trim() || 'origin';
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote)) throw new Error('Invalid remote name');
      const gitArgs = ['push'];
      if (args.setUpstream === true) gitArgs.push('-u');
      gitArgs.push(remote);
      const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : null;
      if (branch) {
        if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
          throw new Error('Invalid branch name');
        }
        gitArgs.push(branch);
      }
      const r = runGit(ws, gitArgs);
      if (!r.ok) {
        throw new Error(`git push failed: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
      }
      return { pushed: true, output: (r.stdout || r.stderr).trim().slice(0, 2000) };
    },
  };
}

export function createGitTools(opts: { workspaceDir: WorkspaceSource }): ToolDefinition[] {
  const { workspaceDir } = opts;
  return [
    gitStatusTool(workspaceDir),
    gitDiffTool(workspaceDir),
    gitCommitTool(workspaceDir),
    gitBranchTool(workspaceDir),
    gitPushTool(workspaceDir),
  ];
}

// Re-exported for unit tests (pure function).
export const __git_test__ = { confine };
