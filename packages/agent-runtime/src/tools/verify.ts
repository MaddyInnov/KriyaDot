// SPDX-License-Identifier: Apache-2.0
// Verify-before-commit tools (Atomic parity): `verify_changes` runs the
// project's own checks (test/lint/build) before the agent claims work is
// done, and `diff_review` summarizes what changed in this session.
//
// Both are ordinary registry tools — they flow through governance like any
// other tool. The tool descriptions instruct the model to call
// `verify_changes` before telling the user the work is complete.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ToolCall, ToolContext, ToolDefinition } from '../types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';

const execFileAsync = promisify(execFile);

const MAX_CHECK_OUTPUT = 12 * 1024; // 12KB per check
const MAX_DIFF_BYTES = 50 * 1024; // 50KB diff cap

/** Project kinds we know how to verify. */
export type ProjectKind =
  | 'node'
  | 'go'
  | 'rust'
  | 'python'
  | 'java-maven'
  | 'java-gradle'
  | 'unknown';

export interface ProjectCheck {
  name: string;
  command: string[];
  cwd: string;
  timeoutMs: number;
}

export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
  skipped?: string;
}

/**
 * Detect the project kind from marker files in the workspace root.
 * Pure (no exec) — safe to unit test.
 */
export function detectProject(wsDir: string): { kind: ProjectKind; root: string } {
  const root = resolve(wsDir);
  if (existsSync(join(root, 'package.json'))) return { kind: 'node', root };
  if (existsSync(join(root, 'go.mod'))) return { kind: 'go', root };
  if (existsSync(join(root, 'Cargo.toml'))) return { kind: 'rust', root };
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py')))
    return { kind: 'python', root };
  if (existsSync(join(root, 'pom.xml'))) return { kind: 'java-maven', root };
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts')))
    return { kind: 'java-gradle', root };
  return { kind: 'unknown', root };
}

/**
 * Select the verification checks for a project kind. Pure (no exec) —
 * safe to unit test. Node checks come from package.json scripts so we
 * never invent a command the project doesn't define.
 */
export function checksForProject(kind: ProjectKind, wsDir: string): ProjectCheck[] {
  switch (kind) {
    case 'node': {
      let scripts: Record<string, string> = {};
      try {
        const pkg = JSON.parse(readFileSync(join(wsDir, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        scripts = pkg.scripts ?? {};
      } catch {
        scripts = {};
      }
      const checks: ProjectCheck[] = [];
      const testScript = scripts.test ?? '';
      // npm's default placeholder test always fails — don't run it.
      if (testScript && !/echo "Error: no test specified"/.test(testScript)) {
        checks.push({ name: 'test', command: ['npm', 'test'], cwd: wsDir, timeoutMs: 180_000 });
      }
      if (scripts.lint) {
        checks.push({ name: 'lint', command: ['npm', 'run', 'lint'], cwd: wsDir, timeoutMs: 120_000 });
      }
      if (scripts.build) {
        checks.push({ name: 'build', command: ['npm', 'run', 'build'], cwd: wsDir, timeoutMs: 300_000 });
      }
      return checks;
    }
    case 'go':
      return [{ name: 'test', command: ['go', 'test', './...'], cwd: wsDir, timeoutMs: 300_000 }];
    case 'rust':
      return [{ name: 'test', command: ['cargo', 'test'], cwd: wsDir, timeoutMs: 600_000 }];
    case 'python':
      return [
        { name: 'test', command: ['python3', '-m', 'pytest', '-x', '-q'], cwd: wsDir, timeoutMs: 300_000 },
      ];
    case 'java-maven':
      return [{ name: 'test', command: ['mvn', '-q', 'test'], cwd: wsDir, timeoutMs: 600_000 }];
    case 'java-gradle':
      return [{ name: 'test', command: ['./gradlew', 'test'], cwd: wsDir, timeoutMs: 600_000 }];
    default:
      return [];
  }
}

export type VerifyExecFn = (command: string[], cwd: string, timeoutMs: number) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

async function defaultExec(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(command[0]!, command.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  return Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8') + `\n…[truncated]`;
}

/**
 * Run the project's checks. Exported for tests; the `verify_changes` tool
 * handler wraps it with workspace resolution.
 */
export async function runProjectChecks(
  wsDir: string,
  exec: VerifyExecFn = defaultExec,
): Promise<{ project: ProjectKind; passed: boolean; checks: CheckResult[]; note?: string }> {
  const { kind, root } = detectProject(wsDir);
  const selected = checksForProject(kind, root);
  if (selected.length === 0) {
    return {
      project: kind,
      passed: true,
      checks: [],
      note:
        kind === 'unknown'
          ? 'No recognizable project markers (package.json, go.mod, Cargo.toml, …) — nothing to verify.'
          : 'Project detected but defines no verifiable scripts — nothing to run.',
    };
  }
  const checks: CheckResult[] = [];
  let passed = true;
  for (const check of selected) {
    let result: CheckResult;
    try {
      const r = await exec(check.command, check.cwd, check.timeoutMs);
      const ok = r.exitCode === 0;
      if (!ok) passed = false;
      const combined = (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim();
      result = {
        name: check.name,
        command: check.command.join(' '),
        passed: ok,
        exitCode: r.exitCode,
        output: truncate(combined || '(no output)', MAX_CHECK_OUTPUT),
      };
    } catch (err) {
      passed = false;
      result = {
        name: check.name,
        command: check.command.join(' '),
        passed: false,
        exitCode: null,
        output: `Failed to run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    checks.push(result);
    // Stop at the first failure — no point running lint when tests fail.
    if (!result.passed) break;
  }
  return { project: kind, passed, checks };
}

/** Optional session history reader for diff_review (wired by the host). */
export interface SessionChangeTracker {
  getToolCalls(sessionId: string): Array<Pick<ToolCall, 'name' | 'args'>>;
}

const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'create_file', 'patch', 'delete_file', 'remove_file']);

export interface DiffFileEntry {
  path: string;
  added: number;
  removed: number;
  status: 'modified' | 'new' | 'deleted' | 'untracked';
}

export interface DiffReview {
  files: DiffFileEntry[];
  totalAdded: number;
  totalRemoved: number;
  /** Workspace-relative paths touched by write tools this session. */
  sessionTouched: string[];
  truncated: boolean;
  note?: string;
}

/** Parse `git diff --numstat` output into per-file entries. */
export function parseNumstat(numstat: string): DiffFileEntry[] {
  const files: DiffFileEntry[] = [];
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) continue;
    files.push({
      path: m[3]!.trim(),
      added: m[1] === '-' ? 0 : Number(m[1]),
      removed: m[2] === '-' ? 0 : Number(m[2]),
      status: 'modified',
    });
  }
  return files;
}

/**
 * Build a diff review for the workspace. Exported for tests.
 * Prefers git numstat (accurate line counts); falls back to the session
 * tool-call history for non-git workspaces.
 */
export async function buildDiffReview(
  wsDir: string,
  sessionId: string,
  exec: VerifyExecFn = defaultExec,
  tracker?: SessionChangeTracker,
): Promise<DiffReview> {
  const sessionTouched: string[] = [];
  if (tracker) {
    for (const call of tracker.getToolCalls(sessionId)) {
      if (!WRITE_TOOL_NAMES.has(call.name)) continue;
      const p = (call.args as Record<string, unknown>).path;
      if (typeof p === 'string' && p && !sessionTouched.includes(p)) sessionTouched.push(p);
    }
  }

  // Is this a git repo?
  const revParse = await exec(['git', 'rev-parse', '--is-inside-work-tree'], wsDir, 10_000).catch(() => ({
    stdout: '',
    stderr: '',
    exitCode: 1,
  }));
  if (revParse.exitCode !== 0 || revParse.stdout.trim() !== 'true') {
    return {
      files: sessionTouched.map((path) => ({ path, added: 0, removed: 0, status: 'modified' as const })),
      totalAdded: 0,
      totalRemoved: 0,
      sessionTouched,
      truncated: false,
      note: 'Not a git repository — showing files touched by write tools this session (no line counts).',
    };
  }

  const numstat = await exec(['git', 'diff', 'HEAD', '--numstat'], wsDir, 15_000).catch(() => ({
    stdout: '',
    stderr: '',
    exitCode: 1,
  }));
  const files = numstat.exitCode === 0 ? parseNumstat(numstat.stdout) : [];
  // Untracked files don't appear in the diff — list them from status.
  const status = await exec(['git', 'status', '--porcelain'], wsDir, 15_000).catch(() => ({
    stdout: '',
    stderr: '',
    exitCode: 1,
  }));
  if (status.exitCode === 0) {
    for (const line of status.stdout.split('\n')) {
      if (line.startsWith('??')) {
        const p = line.slice(2).trim();
        if (p && !files.some((f) => f.path === p)) {
          files.push({ path: p, added: 0, removed: 0, status: 'untracked' });
        }
      }
    }
  }
  const truncated = files.length > 100;
  const kept = files.slice(0, 100);
  return {
    files: kept,
    totalAdded: kept.reduce((n, f) => n + f.added, 0),
    totalRemoved: kept.reduce((n, f) => n + f.removed, 0),
    sessionTouched,
    truncated,
  };
}

function verifyChangesTool(
  workspaceDir: WorkspaceSource,
  exec?: VerifyExecFn,
): ToolDefinition {
  return {
    name: 'verify_changes',
    description:
      'Run this project\'s own checks (tests, lint, build) BEFORE telling the user the work is done. ' +
      'Detects the project type (npm/go/cargo/python/maven/gradle) and runs its standard verification. ' +
      'Returns pass/fail per check with output excerpts. If anything fails, fix it and re-run — ' +
      'do not claim completion with failing checks.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args, ctx: ToolContext) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      return runProjectChecks(ws, exec);
    },
  };
}

function diffReviewTool(
  workspaceDir: WorkspaceSource,
  exec?: VerifyExecFn,
  tracker?: SessionChangeTracker,
): ToolDefinition {
  return {
    name: 'diff_review',
    description:
      'Show a summary of what changed in the workspace during this session: files touched, ' +
      'lines added/removed per file, and untracked files. Use it to review your own changes ' +
      'before committing or declaring the work complete.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args, ctx: ToolContext) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      return buildDiffReview(ws, ctx.sessionId, exec, tracker);
    },
  };
}

/** Verify-before-commit tools (Atomic parity). Read-only except for running the project's own test commands. */
export function createVerifyTools(opts: {
  workspaceDir: WorkspaceSource;
  exec?: VerifyExecFn;
  sessionTracker?: SessionChangeTracker;
}): ToolDefinition[] {
  return [
    verifyChangesTool(opts.workspaceDir, opts.exec),
    diffReviewTool(opts.workspaceDir, opts.exec, opts.sessionTracker),
  ];
}
