// SPDX-License-Identifier: Apache-2.0
/**
 * Native build-and-repair loop (closure ADD-6, OpenCode-style).
 *
 * The compile → check → fix cycle as a FIRST-CLASS runtime capability:
 *
 *   detect project → discover build/test commands → run (sandboxed,
 *   same path as run_command) → parse errors to file:line → patch →
 *   re-run → … until green or the ADD-4 attempt bound is hit →
 *   escalate with the full trail.
 *
 * Library shape: `runBuildRepair()` is the engine; the
 * `build_and_repair` tool (createBuildRepairTools) is a thin handler
 * over it. Patching goes through a `BuildRepairPatcher` seam: the
 * default patcher applies deterministic fixes directly on disk
 * (workspace-confined); the tool factory instead routes the same fix
 * plans through the coding tools' `edit` handler, so patches flow
 * through the exact tool layer the model uses. A host/model-driven
 * patcher can be injected via `patch` for richer repairs.
 *
 * Deterministic fixes are deliberately narrow and honest — literal
 * type mismatches the compiler itself diagnosed (string↔number↔
 * boolean literal assignability). Anything else produces NO patch,
 * the cycle counts as unproductive, and the loop escalates at the
 * bound with the trail instead of thrashing.
 *
 * Attempt bound: `maxCycles` defaults to the ADD-4 execution-policy
 * default (DEFAULT_MAX_ATTEMPTS_PER_STEP) and is clamped to [1, 10].
 * Every cycle is recorded ({cycle, command, exitCode, errorCount,
 * filesPatched}); when the calling turn carries an AttemptLedger the
 * host can fold `result.cycles` into the run record's attempts via
 * `cyclesToAttemptRecords()` — the tool handler cannot reach the
 * per-turn ledger through ToolContext, so the trail rides the tool
 * RESULT (and is rendered by formatBuildRepairTrail). See WIRING note.
 *
 * Placement: the loop runs wherever this runtime runs — the user's
 * local app or their cloud instance — because it only uses the local
 * workspace + sandbox path. No remote executor is built or needed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolContext, ToolDefinition } from './types.js';
import { DEFAULT_MAX_ATTEMPTS_PER_STEP } from './execution-policy.js';
import { resolveWorkspaceDir, type WorkspaceSource } from './workspaces.js';
import { confineRealpath } from './confine.js';
import { createCodingTools } from './tools/coding.js';
import { executeSandboxedCommand } from './tools/sandbox.js';
import { isCatastrophicCommand } from './tools/builtin.js';

// ---------------------------------------------------------------------------
// Project detection + command discovery
// ---------------------------------------------------------------------------

export type BuildProjectKind = 'node' | 'rust' | 'python' | 'go' | 'make' | 'unknown';

export interface BuildProjectInfo {
  kind: BuildProjectKind;
  root: string;
  /** Shell command for the build/check step, or null when none exists. */
  buildCommand: string | null;
  /** Shell command for the test step, or null when none exists. */
  testCommand: string | null;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Detect the project kind and discover its build/test commands. Pure I/O reads only. */
export function detectBuildProject(projectDir: string): BuildProjectInfo {
  const root = resolve(projectDir);
  if (existsSync(join(root, 'package.json'))) {
    const pkg = readJsonFile(join(root, 'package.json'));
    const scripts =
      pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null
        ? (pkg.scripts as Record<string, unknown>)
        : {};
    const script = (name: string): string | null =>
      typeof scripts[name] === 'string' && (scripts[name] as string).trim() ? (scripts[name] as string) : null;
    let buildCommand: string | null = null;
    if (script('build')) buildCommand = 'npm run build';
    else if (script('typecheck')) buildCommand = 'npm run typecheck';
    else if (existsSync(join(root, 'tsconfig.json'))) buildCommand = 'npx --no-install tsc --noEmit';
    let testCommand: string | null = null;
    const test = script('test');
    if (test && !/echo "Error: no test specified"/.test(test)) testCommand = 'npm test';
    return { kind: 'node', root, buildCommand, testCommand };
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    return { kind: 'rust', root, buildCommand: 'cargo build', testCommand: 'cargo test' };
  }
  if (existsSync(join(root, 'go.mod'))) {
    return { kind: 'go', root, buildCommand: 'go build ./...', testCommand: 'go test ./...' };
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py'))) {
    return { kind: 'python', root, buildCommand: null, testCommand: 'python3 -m pytest -x -q' };
  }
  if (existsSync(join(root, 'Makefile'))) {
    let buildCommand: string | null = null;
    let testCommand: string | null = null;
    try {
      const mk = readFileSync(join(root, 'Makefile'), 'utf8');
      if (/^build\s*:/m.test(mk)) buildCommand = 'make build';
      if (/^test\s*:/m.test(mk)) testCommand = 'make test';
      if (!buildCommand && !testCommand && /^all\s*:/m.test(mk)) buildCommand = 'make all';
    } catch {
      // Unreadable Makefile — no commands.
    }
    return { kind: 'make', root, buildCommand, testCommand };
  }
  return { kind: 'unknown', root, buildCommand: null, testCommand: null };
}

// ---------------------------------------------------------------------------
// Error parsing
// ---------------------------------------------------------------------------

export interface ParsedBuildError {
  /** Project-relative (or as-printed) file path. */
  file: string;
  line: number;
  col?: number;
  /** Compiler/linter code, e.g. TS2322. */
  code?: string;
  message: string;
  source: 'tsc' | 'eslint' | 'cargo' | 'go' | 'pytest' | 'generic';
}

const TS_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+(?:error|warning)\s+(TS\d+):\s+(.*)$/;
const CARGO_LOCATION_RE = /^\s*-->\s+(.+?):(\d+):(\d+)\s*$/;
const ESLINT_FILE_RE = /^(\/\S.*|\S+\.(?:ts|tsx|js|jsx|mjs|cjs))$/;
const ESLINT_RULE_RE = /^\s+(\d+):(\d+)\s+(?:error|warning)\s+(.*?)(?:\s{2,}\S+)?$/;
const PYTEST_LOCATION_RE = /^(.+?\.py):(\d+)(?::\s*(.*))?$/;
const GENERIC_LOCATION_RE = /^(.+?):(\d+)(?::(\d+))?:\s+(.*)$/;

/** Parse compiler/test output into file:line errors. Pure. */
export function parseBuildErrors(output: string): ParsedBuildError[] {
  const errors: ParsedBuildError[] = [];
  const seen = new Set<string>();
  const push = (e: ParsedBuildError): void => {
    const key = `${e.file}:${e.line}:${e.col ?? ''}:${e.code ?? ''}:${e.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(e);
  };
  const lines = output.split('\n');
  let eslintFile: string | null = null;
  let cargoMessage: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // tsc: src/index.ts(1,14): error TS2322: Type 'string' is not assignable...
    const ts = TS_ERROR_RE.exec(line);
    if (ts) {
      push({ file: ts[1]!, line: Number(ts[2]), col: Number(ts[3]), code: ts[4]!, message: ts[5]!, source: 'tsc' });
      continue;
    }
    // cargo: "error[E0308]: ..." then "  --> src/main.rs:2:5"
    if (/^error(?:\[E\d+\])?:\s+/.test(line)) {
      cargoMessage = line.replace(/^error(?:\[E\d+\])?:\s+/, '');
      continue;
    }
    const cargoLoc = CARGO_LOCATION_RE.exec(line);
    if (cargoLoc && cargoMessage) {
      push({ file: cargoLoc[1]!, line: Number(cargoLoc[2]), col: Number(cargoLoc[3]), message: cargoMessage, source: 'cargo' });
      cargoMessage = null;
      continue;
    }
    // ESLint stylish: a bare file line, then "  1:5  error  message  rule"
    if (eslintFile) {
      const rule = ESLINT_RULE_RE.exec(line);
      if (rule) {
        push({ file: eslintFile, line: Number(rule[1]), col: Number(rule[2]), message: rule[3]!.trim(), source: 'eslint' });
        continue;
      }
      if (line.trim() === '') continue;
      eslintFile = null; // fall through with the new line
    }
    if (ESLINT_FILE_RE.test(line.trim()) && i + 1 < lines.length && ESLINT_RULE_RE.test(lines[i + 1]!)) {
      eslintFile = line.trim();
      continue;
    }
    // pytest: traceback frames "file.py:123: in test_x" / summary "file.py:12: error"
    if (/\.py:\d+/.test(line)) {
      const py = PYTEST_LOCATION_RE.exec(line.trim());
      if (py && (/^\//.test(py[1]!) || py[1]!.includes('/'))) {
        push({ file: py[1]!, line: Number(py[2]), message: (py[3] ?? line.trim()).slice(0, 200), source: 'pytest' });
        continue;
      }
    }
    // Generic file:line[:col]: message (go vet/build, javac, many others)
    const gen = GENERIC_LOCATION_RE.exec(line.trim());
    if (gen && /\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py|java|c|cc|cpp|h)$/.test(gen[1]!)) {
      push({
        file: gen[1]!,
        line: Number(gen[2]),
        ...(gen[3] ? { col: Number(gen[3]) } : {}),
        message: gen[4]!,
        source: gen[1]!.endsWith('.go') ? 'go' : 'generic',
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Deterministic fix planning
// ---------------------------------------------------------------------------

export interface FixPlan {
  /** Project-relative file path. */
  file: string;
  /** Exact text to replace (must occur exactly once). */
  oldText: string;
  newText: string;
  /** Why this fix was planned (audit trail). */
  rationale: string;
}

const ASSIGNABILITY_RE = /Type '([^']+)' is not assignable to type '([^']+)'/;

/**
 * Plan narrow, compiler-diagnosed literal fixes: when tsc says a literal
 * of one primitive type was assigned where another primitive is expected
 * and the literal sits on the error line, convert the literal. Anything
 * else yields no plan (honest escalation beats guessing).
 */
export function planDeterministicFixes(errors: ParsedBuildError[], projectDir: string): FixPlan[] {
  const plans: FixPlan[] = [];
  const root = resolve(projectDir);
  for (const err of errors) {
    const m = ASSIGNABILITY_RE.exec(err.message);
    if (!m) continue;
    const [, actual, expected] = m as unknown as [string, string, string];
    let abs: string;
    try {
      abs = isAbsolute(err.file) ? err.file : confineRealpath(root, relative(root, resolve(root, err.file)));
    } catch {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const lineText = lines[err.line - 1];
    if (lineText === undefined) continue;
    const relFile = relative(root, abs).split('\\').join('/');
    let plan: FixPlan | null = null;
    if (expected === 'number' && actual === 'string') {
      const lit = /"(-?\d+(?:\.\d+)?)"|'(-?\d+(?:\.\d+)?)'/.exec(lineText);
      if (lit) {
        plan = { file: relFile, oldText: lit[0], newText: lit[1] ?? lit[2]!, rationale: `TS: string literal ${lit[0]} → number (error at ${err.file}:${err.line})` };
      }
    } else if (expected === 'string' && actual === 'number') {
      const lit = /(?<![\w"'])(-?\d+(?:\.\d+)?)(?![\w"'])/.exec(lineText);
      if (lit) {
        plan = { file: relFile, oldText: lit[0], newText: `"${lit[1]}"`, rationale: `TS: number literal ${lit[0]} → string (error at ${err.file}:${err.line})` };
      }
    } else if (expected === 'boolean' && actual === 'string') {
      const lit = /"(true|false)"|'(true|false)'/.exec(lineText);
      if (lit) {
        plan = { file: relFile, oldText: lit[0], newText: lit[1] ?? lit[2]!, rationale: `TS: string literal ${lit[0]} → boolean (error at ${err.file}:${err.line})` };
      }
    }
    if (plan && content.split(plan.oldText).length - 1 === 1) plans.push(plan);
  }
  return plans;
}

/** A patcher turns parsed errors into patched files (relative paths). */
export type BuildRepairPatcher = (
  errors: ParsedBuildError[],
  projectDir: string,
) => Promise<string[]>;

/** Default patcher: apply deterministic fix plans directly on disk. */
export const deterministicPatcher: BuildRepairPatcher = async (errors, projectDir) => {
  const root = resolve(projectDir);
  const plans = planDeterministicFixes(errors, root);
  const patched: string[] = [];
  for (const plan of plans) {
    const abs = confineRealpath(root, plan.file);
    const content = readFileSync(abs, 'utf8');
    if (content.split(plan.oldText).length - 1 !== 1) continue;
    writeFileSync(abs, content.split(plan.oldText).join(plan.newText), 'utf8');
    if (!patched.includes(plan.file)) patched.push(plan.file);
  }
  return patched;
};

/**
 * Patcher that routes deterministic fix plans through the coding
 * tools' `edit` handler — patches flow through the same tool layer
 * (confinement, stale checks) the model itself uses.
 */
export function makeEditToolPatcher(workspaceDir: WorkspaceSource): BuildRepairPatcher {
  const edit = createCodingTools({ workspaceDir }).find((t) => t.name === 'edit');
  return async (errors, projectDir, ctx?: ToolContext) => {
    if (!edit) return deterministicPatcher(errors, projectDir);
    const plans = planDeterministicFixes(errors, projectDir);
    const patched: string[] = [];
    const toolCtx: ToolContext = ctx ?? { sessionId: 'build-repair', botId: 'build-repair' };
    for (const plan of plans) {
      try {
        await edit.handler(
          { path: plan.file, oldText: plan.oldText, newText: plan.newText, expectedCount: 1 },
          toolCtx,
        );
        if (!patched.includes(plan.file)) patched.push(plan.file);
      } catch {
        // The edit tool refused (stale/ambiguous) — leave the file
        // alone; the cycle records zero patches for it.
      }
    }
    return patched;
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface BuildRepairExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export type BuildRepairExec = (
  command: string,
  projectDir: string,
) => Promise<BuildRepairExecResult>;

/** Default exec: the same sandbox path as run_command. */
export const sandboxExec: BuildRepairExec = async (command, projectDir) => {
  if (isCatastrophicCommand(command)) {
    throw new Error(`Refused by command denylist: "${command.slice(0, 120)}"`);
  }
  const result = await executeSandboxedCommand(command, {
    timeoutMs: 300_000,
    maxOutputBytes: 512 * 1024,
    workspaceDir: projectDir,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
};

export interface BuildRepairCycle {
  cycle: number;
  phase: 'build' | 'test';
  command: string;
  exitCode: number;
  errorCount: number;
  filesPatched: string[];
  outputExcerpt: string;
}

export interface BuildRepairResult {
  status: 'green' | 'escalated' | 'no-commands';
  project: BuildProjectInfo;
  cycles: BuildRepairCycle[];
  /** Errors remaining when escalated. */
  errorsRemaining: ParsedBuildError[];
  /** Human-readable escalation summary when status is 'escalated'. */
  escalation?: string;
  note?: string;
}

export interface BuildRepairOptions {
  projectDir: string;
  /** Repair cycles allowed; default = ADD-4 default bound (3). */
  maxCycles?: number;
  exec?: BuildRepairExec;
  patch?: BuildRepairPatcher;
  /** Tool context forwarded to tool-layer patchers. */
  ctx?: ToolContext;
}

function clampCycles(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_MAX_ATTEMPTS_PER_STEP;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

export async function runBuildRepair(opts: BuildRepairOptions): Promise<BuildRepairResult> {
  const project = detectBuildProject(opts.projectDir);
  const maxCycles = clampCycles(opts.maxCycles);
  const exec = opts.exec ?? sandboxExec;
  const patch = opts.patch ?? deterministicPatcher;
  const cycles: BuildRepairCycle[] = [];

  const commands: Array<{ phase: 'build' | 'test'; command: string }> = [];
  if (project.buildCommand) commands.push({ phase: 'build', command: project.buildCommand });
  if (project.testCommand) commands.push({ phase: 'test', command: project.testCommand });
  if (commands.length === 0) {
    return {
      status: 'no-commands',
      project,
      cycles,
      errorsRemaining: [],
      note:
        project.kind === 'unknown'
          ? 'No recognizable project markers (package.json, Cargo.toml, pyproject.toml, go.mod, Makefile) — nothing to build or test.'
          : `Project detected (${project.kind}) but it defines no build/test commands to run.`,
    };
  }

  let lastErrors: ParsedBuildError[] = [];
  let cycleNo = 0;
  // One "cycle" = one full pass over the failing command + one patch
  // attempt. Build runs first; tests run only once the build is green.
  while (cycleNo < maxCycles) {
    cycleNo += 1;
    let failedPhase: { phase: 'build' | 'test'; command: string } | null = null;
    let failedOutput = '';
    let failedExit = 0;
    for (const step of commands) {
      const res = await exec(step.command, project.root);
      const combined = `${res.stdout}\n${res.stderr}`;
      if (res.exitCode === 0) {
        cycles.push({
          cycle: cycleNo,
          phase: step.phase,
          command: step.command,
          exitCode: 0,
          errorCount: 0,
          filesPatched: [],
          outputExcerpt: combined.trim().slice(0, 500),
        });
        continue;
      }
      failedPhase = step;
      failedOutput = combined;
      failedExit = res.exitCode;
      break; // stop at the first failing phase, like verify_changes
    }
    if (!failedPhase) {
      return { status: 'green', project, cycles, errorsRemaining: [] };
    }
    lastErrors = parseBuildErrors(failedOutput);
    let patched: string[] = [];
    if (cycleNo < maxCycles && lastErrors.length > 0) {
      try {
        patched = await (patch as (e: ParsedBuildError[], d: string, c?: ToolContext) => Promise<string[]>)(
          lastErrors,
          project.root,
          opts.ctx,
        );
      } catch {
        patched = [];
      }
    }
    cycles.push({
      cycle: cycleNo,
      phase: failedPhase.phase,
      command: failedPhase.command,
      exitCode: failedExit,
      errorCount: lastErrors.length,
      filesPatched: patched,
      outputExcerpt: failedOutput.trim().slice(0, 1000),
    });
    if (patched.length === 0) {
      // No productive patch: further cycles would repeat identically
      // (ADD-4's never-blind-repeat rule) — escalate now with the trail.
      break;
    }
  }

  const trail = cycles
    .map(
      (c) =>
        `- Cycle ${c.cycle} (${c.phase}: ${c.command}): exit ${c.exitCode}, ${c.errorCount} error(s)` +
        (c.filesPatched.length > 0 ? `, patched: ${c.filesPatched.join(', ')}` : ', no patch applied'),
    )
    .join('\n');
  const errLines = lastErrors
    .slice(0, 10)
    .map((e) => `- ${e.file}:${e.line}${e.col ? `:${e.col}` : ''} ${e.code ? `[${e.code}] ` : ''}${e.message}`)
    .join('\n');
  return {
    status: 'escalated',
    project,
    cycles,
    errorsRemaining: lastErrors,
    escalation:
      `Build-and-repair escalated after ${cycles.length} cycle(s) (bound: ${maxCycles}).\n` +
      `What was tried:\n${trail}\n` +
      (errLines ? `Remaining errors:\n${errLines}\n` : '') +
      'A different approach is needed: inspect the errors, patch manually, or ask the user.',
  };
}

/** Fold loop cycles into ADD-4 run-record attempt entries. */
export function cyclesToAttemptRecords(result: BuildRepairResult): Array<{
  step: string;
  attempt: number;
  change: string;
  action?: string;
  failure?: string;
  outcome: 'succeeded' | 'failed' | 'escalated';
}> {
  return result.cycles.map((c) => ({
    step: `build-repair:${c.phase}`,
    attempt: c.cycle,
    change: c.cycle <= 1 ? 'initial' : 'args',
    action: c.command.slice(0, 160),
    ...(c.exitCode !== 0 ? { failure: `${c.errorCount} error(s); exit ${c.exitCode}` } : {}),
    outcome: c.exitCode === 0 ? ('succeeded' as const) : ('failed' as const),
  }));
}

/** Plain-language summary of a loop run for Activity / chat. */
export function formatBuildRepairTrail(result: BuildRepairResult): string {
  if (result.status === 'green') {
    return `Build-and-repair: green after ${result.cycles.length} cycle(s) (${result.project.kind} project).`;
  }
  if (result.status === 'no-commands') {
    return `Build-and-repair: nothing to run — ${result.note ?? 'no build/test commands discovered.'}`;
  }
  return result.escalation ?? 'Build-and-repair escalated.';
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface BuildRepairToolsOptions {
  workspaceDir: WorkspaceSource;
  exec?: BuildRepairExec;
  /** Patcher override; default routes through the coding `edit` tool. */
  patch?: BuildRepairPatcher;
}

export function createBuildRepairTools(opts: BuildRepairToolsOptions): ToolDefinition[] {
  return [
    {
      name: 'build_and_repair',
      mutating: true,
      description:
        'Run the project\'s build (and tests) and repair failures in a loop: detect the project, ' +
        'run its commands sandboxed, parse errors to file:line, patch, and re-run — until green or ' +
        'the attempt bound (ADD-4 default) is hit, then escalate with the full trail. Use for ' +
        '"make it compile / make the tests pass" work instead of one-shot run_command calls.',
      parameters: {
        type: 'object',
        properties: {
          projectDir: {
            type: 'string',
            description: 'Workspace-relative project directory (default: workspace root)',
          },
          maxCycles: {
            type: 'number',
            description: 'Max build→patch cycles (default: ADD-4 attempt bound, clamped 1–10)',
          },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const ws = resolveWorkspaceDir(opts.workspaceDir, ctx);
        const projectDir =
          typeof args.projectDir === 'string' && args.projectDir
            ? confineRealpath(ws, args.projectDir)
            : resolve(ws);
        const patcher = opts.patch ?? makeEditToolPatcher(opts.workspaceDir);
        const result = await runBuildRepair({
          projectDir,
          maxCycles: typeof args.maxCycles === 'number' ? args.maxCycles : undefined,
          exec: opts.exec,
          patch: patcher,
          ctx,
        });
        return {
          status: result.status,
          projectKind: result.project.kind,
          buildCommand: result.project.buildCommand,
          testCommand: result.project.testCommand,
          cycles: result.cycles,
          attempts: cyclesToAttemptRecords(result),
          errorsRemaining: result.errorsRemaining.slice(0, 20),
          ...(result.escalation ? { escalation: result.escalation } : {}),
          ...(result.note ? { note: result.note } : {}),
          summary: formatBuildRepairTrail(result),
        };
      },
    },
  ];
}
