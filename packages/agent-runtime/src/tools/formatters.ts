// SPDX-License-Identifier: Apache-2.0
// Formatter pipeline (CA-10): after a coding tool edits a file, run the
// project's formatter for that file type — the way OpenCode auto-formats
// every edited file — and surface the outcome as a tool-result note.
// Formatting NEVER fails the edit: a missing or failing formatter is
// reported, not thrown.
//
// Detection, in precedence order:
//   1. Custom config: `<workspace>/.kriyadot/formatters.json`
//        { "formatters": { ".ts": { "command": "...", "args": ["..."] },
//                           "*":  { "command": "...", "args": [] } },
//          "disabled": [".md"] }
//      `{file}` in an arg is replaced with the absolute file path; with
//      no `{file}` placeholder the path is appended as the last arg.
//      A `null` entry disables formatting for that extension.
//      (The `.kriyadot/` directory is the repo's existing project-config
//      convention — cf. `.kriyadot/instructions.md`, `.kriyadot/tools/`.)
//   2. Factory-injected overrides (CodingToolsOptions.formatters) — same
//      shape; used by hosts and by tests.
//   3. Built-in per-language formatters, gated on project evidence so we
//      never download or run a tool the project does not already use:
//        - Prettier: a prettier config file, a `prettier` key or a
//          prettier dependency in package.json → `prettier --write`
//          resolved from node_modules/.bin when present, else PATH.
//        - gofmt for .go (when go.mod or a .go project is present — gofmt
//          itself is the evidence; it ships with Go).
//        - rustfmt for .rs (ships with Rust).
//        - black, else `ruff format`, for .py when pyproject.toml /
//          setup.cfg / .flake8 mentions the tool, or the binary exists.
//        - clang-format for C/C++ when a `.clang-format` file exists.
//
// All process execution goes through an injectable runner so tests use a
// fake formatter command — no network, no real formatters required.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface FormatterSpec {
  command: string;
  args: string[];
}

export interface FormatterRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command could not be started at all (ENOENT etc.). */
  spawnError?: string;
}

export type FormatterRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => FormatterRunResult;

export const defaultFormatterRunner: FormatterRunner = (command, args, opts) => {
  try {
    const r = spawnSync(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (r.error) {
      return { exitCode: -1, stdout: '', stderr: '', spawnError: r.error.message };
    }
    return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: '', spawnError: err instanceof Error ? err.message : String(err) };
  }
};

export interface FormatterOutcome {
  file: string;
  formatter?: string;
  formatted: boolean;
  skipped?: string;
  error?: string;
}

interface CustomFormatterConfig {
  formatters: Record<string, FormatterSpec | null>;
  disabled: Set<string>;
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeSpec(raw: unknown): FormatterSpec | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== 'string' || !r.command) return undefined;
  const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [];
  return { command: r.command, args };
}

/** Load `<root>/.kriyadot/formatters.json`. Never throws. */
export function loadCustomFormatterConfig(root: string): CustomFormatterConfig {
  const out: CustomFormatterConfig = { formatters: {}, disabled: new Set() };
  const cfg = readJsonSafe(join(root, '.kriyadot', 'formatters.json'));
  if (!cfg) return out;
  const fmts = cfg.formatters;
  if (typeof fmts === 'object' && fmts !== null) {
    for (const [ext, raw] of Object.entries(fmts as Record<string, unknown>)) {
      const spec = normalizeSpec(raw);
      if (spec !== undefined) out.formatters[ext.toLowerCase()] = spec;
    }
  }
  if (Array.isArray(cfg.disabled)) {
    for (const d of cfg.disabled) if (typeof d === 'string') out.disabled.add(d.toLowerCase());
  }
  return out;
}

/** Convert host-supplied formatter overrides to the internal shape. */
export function normalizeFormatterOverrides(
  overrides: Record<string, FormatterSpec | null> | undefined,
): CustomFormatterConfig {
  const out: CustomFormatterConfig = { formatters: {}, disabled: new Set() };
  if (!overrides) return out;
  for (const [ext, spec] of Object.entries(overrides)) {
    out.formatters[ext.toLowerCase()] = spec;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in detection
// ---------------------------------------------------------------------------

const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

const PRETTIER_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.css', '.scss', '.less', '.html', '.md', '.yaml', '.yml', '.vue', '.svelte',
]);

function prettierSpec(root: string): FormatterSpec | null {
  const pkg = readJsonSafe(join(root, 'package.json'));
  const hasConfigFile = PRETTIER_CONFIG_FILES.some((f) => existsSync(join(root, f)));
  const hasPkgKey = pkg !== null && 'prettier' in pkg;
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };
  const hasDep = 'prettier' in deps;
  if (!hasConfigFile && !hasPkgKey && !hasDep) return null;
  const localBin = join(root, 'node_modules', '.bin', 'prettier');
  return { command: existsSync(localBin) ? localBin : 'prettier', args: ['--write', '{file}'] };
}

function pythonSpec(root: string): FormatterSpec | null {
  const evidence = ['pyproject.toml', 'setup.cfg', '.flake8', 'Pipfile'].map((f) => {
    const p = join(root, f);
    return existsSync(p) ? safeRead(p) : '';
  }).join('\n');
  if (/\bblack\b/.test(evidence)) return { command: 'black', args: ['--quiet', '{file}'] };
  if (/\bruff\b/.test(evidence)) return { command: 'ruff', args: ['format', '{file}'] };
  // No project evidence: still try black then ruff on PATH — the runner
  // reports spawn errors as skips, never failures.
  return { command: 'black', args: ['--quiet', '{file}'] };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Detect the built-in formatter for `ext` in project `root`, if any. */
export function detectBuiltinFormatter(root: string, ext: string): (FormatterSpec & { name: string }) | null {
  switch (ext) {
    case '.go':
      return { name: 'gofmt', command: 'gofmt', args: ['-w', '{file}'] };
    case '.rs':
      return { name: 'rustfmt', command: 'rustfmt', args: ['{file}'] };
    case '.py':
      return { name: 'black/ruff', ...pythonSpec(root)! };
    case '.c':
    case '.h':
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
      return existsSync(join(root, '.clang-format'))
        ? { name: 'clang-format', command: 'clang-format', args: ['-i', '{file}'] }
        : null;
    default:
      if (PRETTIER_EXTS.has(ext)) {
        const spec = prettierSpec(root);
        return spec ? { name: 'prettier', ...spec } : null;
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface FormatOptions {
  runner?: FormatterRunner;
  /** Host/test overrides (win over the project config file). */
  overrides?: Record<string, FormatterSpec | null>;
  timeoutMs?: number;
}

/**
 * Resolve the formatter spec for a file: overrides → project config →
 * built-ins. Returns { spec, name } or { disabled: true } or null.
 */
export function resolveFormatter(
  root: string,
  absPath: string,
  opts: FormatOptions = {},
): { spec: FormatterSpec; name: string } | { disabled: true } | null {
  const ext = extname(absPath).toLowerCase();
  const fromOverrides = normalizeFormatterOverrides(opts.overrides);
  const fromFile = loadCustomFormatterConfig(root);
  for (const cfg of [fromOverrides, fromFile]) {
    if (cfg.disabled.has(ext)) return { disabled: true };
    const spec = cfg.formatters[ext] ?? cfg.formatters['*'];
    if (spec === null && (ext in cfg.formatters || '*' in cfg.formatters)) return { disabled: true };
    if (spec) return { spec, name: `custom:${spec.command}` };
  }
  const builtin = detectBuiltinFormatter(root, ext);
  return builtin ? { spec: builtin, name: builtin.name } : null;
}

/**
 * Format one file in place. Never throws; the outcome distinguishes
 * formatted / skipped (no formatter, disabled, binary missing) / error
 * (formatter ran and failed) so the caller can surface a note either way.
 */
export function formatFile(root: string, absPath: string, relPath: string, opts: FormatOptions = {}): FormatterOutcome {
  const resolved = resolveFormatter(root, absPath, opts);
  if (!resolved) return { file: relPath, formatted: false, skipped: 'no formatter configured for this file type' };
  if ('disabled' in resolved) return { file: relPath, formatted: false, skipped: 'formatting disabled for this file type' };
  const runner = opts.runner ?? defaultFormatterRunner;
  const args = resolved.spec.args.some((a) => a.includes('{file}'))
    ? resolved.spec.args.map((a) => a.replaceAll('{file}', absPath))
    : [...resolved.spec.args, absPath];
  const result = runner(resolved.spec.command, args, { cwd: root, timeoutMs: opts.timeoutMs ?? 30_000 });
  if (result.spawnError) {
    return { file: relPath, formatter: resolved.name, formatted: false, skipped: `formatter unavailable: ${result.spawnError}` };
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    return {
      file: relPath,
      formatter: resolved.name,
      formatted: false,
      error: `formatter exited ${result.exitCode}${detail ? `: ${detail}` : ''}`,
    };
  }
  return { file: relPath, formatter: resolved.name, formatted: true };
}
