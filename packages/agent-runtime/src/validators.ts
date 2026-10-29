// SPDX-License-Identifier: Apache-2.0
/**
 * End-of-turn validators (Octomind parity).
 *
 * A validator is a DECLARED check — from the bot's config or from a
 * skill's frontmatter — that runs automatically when a turn is about to
 * finish, instead of relying on the model to remember to verify. When a
 * validator fails, the runtime injects its output as the next
 * instruction and the turn continues (bounded retries), so the agent
 * self-corrects before the user ever sees a premature "done".
 *
 * Two kinds:
 *   - command validators: an argv array executed (no shell) in the
 *     bot's workspace; exit code 0 = pass.
 *   - the built-in `verify-changes` validator: the project's own
 *     checks via the verify tool machinery (tools/verify.ts).
 *
 * Validators only run when the turn actually DID something (at least
 * one tool executed) — a pure question-answer turn has nothing to
 * validate, and running project tests on every chat reply would be
 * pure cost.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TurnValidatorSpec } from './types.js';
import { runProjectChecks, type VerifyExecFn } from './tools/verify.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ValidatorRunResult {
  name: string;
  passed: boolean;
  /** Combined output excerpt (stdout+stderr or check summary). */
  output: string;
  durationMs: number;
  /** Set when the validator itself could not run (spawn error, timeout). */
  error?: string;
}

export type ValidatorExecFn = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultExec: ValidatorExecFn = async (command, cwd, timeoutMs) => {
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
};

function truncate(s: string): string {
  const t = s.trim();
  return t.length > MAX_OUTPUT_CHARS ? t.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]' : t;
}

/** Run one validator. Never throws — failures are data. */
export async function runValidator(
  spec: TurnValidatorSpec,
  opts: { workspaceDir: string; exec?: ValidatorExecFn },
): Promise<ValidatorRunResult> {
  const started = Date.now();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    if (spec.builtin === 'verify-changes') {
      const exec = opts.exec as VerifyExecFn | undefined;
      const result = await runProjectChecks(opts.workspaceDir, exec);
      const lines = result.checks.map(
        (c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name} (${c.command}): ${c.output.slice(0, 800)}`,
      );
      if (result.note) lines.push(result.note);
      return {
        name: spec.name,
        passed: result.passed,
        output: truncate(lines.join('\n') || 'no checks ran'),
        durationMs: Date.now() - started,
      };
    }
    if (!spec.command || spec.command.length === 0) {
      return {
        name: spec.name,
        passed: false,
        output: '',
        durationMs: Date.now() - started,
        error: 'validator has neither a command nor a builtin',
      };
    }
    const exec = opts.exec ?? defaultExec;
    const r = await exec(spec.command, opts.workspaceDir, timeoutMs);
    const combined = (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim();
    return {
      name: spec.name,
      passed: r.exitCode === 0,
      output: truncate(combined || '(no output)'),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      name: spec.name,
      passed: false,
      output: '',
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run all validators serially (they may mutate the workspace). */
export async function runTurnValidators(
  specs: TurnValidatorSpec[],
  opts: { workspaceDir: string; exec?: ValidatorExecFn },
): Promise<ValidatorRunResult[]> {
  const results: ValidatorRunResult[] = [];
  for (const spec of specs) {
    results.push(await runValidator(spec, opts));
  }
  return results;
}

/**
 * Render validator failures as the corrective instruction injected into
 * the turn. Returns '' when everything passed.
 */
export function validatorFailureMessage(results: ValidatorRunResult[]): string {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return '';
  const blocks = failed.map(
    (r) =>
      `Validator "${r.name}" FAILED${r.error ? ` (could not run: ${r.error})` : ''}:\n${r.output || '(no output)'}`,
  );
  return (
    'End-of-turn validation failed — the work is not done yet. Fix the problems below and ' +
    'finish again; validation will re-run.\n\n' +
    blocks.join('\n\n')
  );
}

/**
 * Split a shell-style command string into argv (for skill frontmatter
 * `validators: ["npm test"]`). Handles single/double quotes and
 * backslash escapes; no variable expansion, no shell operators — a
 * string containing shell metacharacters outside quotes is treated
 * literally, so frontmatter can never smuggle in a shell pipeline.
 */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Parse the `validators` frontmatter field of a skill into specs.
 * Accepts: a string ("npm test"), or a list of strings / objects
 * ({ name?, command: string | string[], builtin?, timeoutMs? }).
 * Malformed entries are skipped — a bad skill file must not break turns.
 */
export function parseValidatorSpecs(raw: unknown): TurnValidatorSpec[] {
  const specs: TurnValidatorSpec[] = [];
  const pushCommand = (name: string, commandLine: unknown): void => {
    if (typeof commandLine === 'string') {
      const argv = splitCommandLine(commandLine);
      if (argv.length > 0) specs.push({ name, command: argv });
    } else if (Array.isArray(commandLine) && commandLine.every((x) => typeof x === 'string')) {
      if (commandLine.length > 0) specs.push({ name, command: [...(commandLine as string[])] });
    }
  };
  if (typeof raw === 'string') {
    pushCommand('skill-validator', raw);
    return specs;
  }
  if (!Array.isArray(raw)) return specs;
  for (const entry of raw) {
    if (typeof entry === 'string') {
      pushCommand(entry.split(/\s+/)[0] ?? 'skill-validator', entry);
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' && e.name ? e.name : 'skill-validator';
    if (e.builtin === 'verify-changes') {
      specs.push({
        name,
        builtin: 'verify-changes',
        timeoutMs: typeof e.timeoutMs === 'number' ? e.timeoutMs : undefined,
      });
    } else if (e.command !== undefined) {
      const before = specs.length;
      pushCommand(name, e.command);
      if (specs.length > before && typeof e.timeoutMs === 'number') {
        specs[specs.length - 1]!.timeoutMs = e.timeoutMs;
      }
    }
  }
  return specs;
}
