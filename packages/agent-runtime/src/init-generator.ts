// SPDX-License-Identifier: Apache-2.0
/**
 * /init generator (CA-6): analyse a workspace and draft a starter
 * instruction file (AGENTS.md) from what is actually there — detected
 * languages, build/test/lint commands (from package.json scripts,
 * Cargo.toml, pyproject.toml, go.mod, Makefile targets), the top-level
 * layout, and any instruction files that already exist.
 *
 * The template text is original to KriyaDot. Detection is pure file
 * reading: nothing is executed, nothing leaves the machine. Generation
 * refuses to guess commands it cannot evidence in a manifest — unknown
 * slots become explicit "<fill in>" placeholders instead of inventions.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspaceAnalysis {
  languages: string[];
  /** Detected commands by purpose, only when evidenced in a manifest. */
  commands: { build?: string; test?: string; lint?: string; run?: string };
  /** Top-level entries (dirs suffixed with '/'), sorted, capped. */
  layout: string[];
  /** Instruction files already present (workspace-relative). */
  existingInstructionFiles: string[];
  packageManager?: string;
}

const INSTRUCTION_FILES = ['AGENTS.md', 'KRIYADOT.md', '.kriyadot/instructions.md'];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', 'coverage', '.kriyadot']);

function readText(dir: string, rel: string): string | undefined {
  try {
    const p = join(dir, rel);
    if (!existsSync(p) || !statSync(p).isFile()) return undefined;
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function has(dir: string, rel: string): boolean {
  return existsSync(join(dir, rel));
}

function detectPackageManager(dir: string): string | undefined {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return 'bun';
  if (has(dir, 'package-lock.json')) return 'npm';
  return undefined;
}

function makeTarget(makefile: string, name: string): boolean {
  return new RegExp(`^${name}\\s*:`, 'm').test(makefile);
}

/** Analyse a workspace directory. Never throws. */
export function analyzeWorkspace(dir: string): WorkspaceAnalysis {
  const languages = new Set<string>();
  const commands: WorkspaceAnalysis['commands'] = {};
  let packageManager: string | undefined;

  const pkgRaw = readText(dir, 'package.json');
  if (pkgRaw) {
    languages.add('JavaScript/TypeScript');
    packageManager = detectPackageManager(dir) ?? 'npm';
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const run = (name: string) => `${packageManager} run ${name}`;
      if (scripts['build']) commands.build = run('build');
      if (scripts['test']) commands.test = run('test');
      if (scripts['lint']) commands.lint = run('lint');
      if (scripts['dev']) commands.run = run('dev');
      else if (scripts['start']) commands.run = run('start');
    } catch {
      // Unparseable package.json — language still detected, commands stay empty.
    }
  }
  if (has(dir, 'Cargo.toml')) {
    languages.add('Rust');
    commands.build ??= 'cargo build';
    commands.test ??= 'cargo test';
    if (!commands.lint && has(dir, 'rustfmt.toml')) commands.lint = 'cargo fmt --check';
  }
  const pyproject = readText(dir, 'pyproject.toml');
  if (pyproject || has(dir, 'requirements.txt') || has(dir, 'setup.py')) {
    languages.add('Python');
    commands.test ??= 'pytest';
    if (pyproject && /\[tool\.ruff/.test(pyproject)) commands.lint ??= 'ruff check .';
  }
  if (has(dir, 'go.mod')) {
    languages.add('Go');
    commands.build ??= 'go build ./...';
    commands.test ??= 'go test ./...';
  }
  const makefile = readText(dir, 'Makefile');
  if (makefile) {
    if (makeTarget(makefile, 'build')) commands.build ??= 'make build';
    if (makeTarget(makefile, 'test')) commands.test ??= 'make test';
    if (makeTarget(makefile, 'lint')) commands.lint ??= 'make lint';
  }
  if (has(dir, 'tsconfig.json') && !languages.has('JavaScript/TypeScript')) languages.add('TypeScript');

  let layout: string[] = [];
  try {
    layout = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 30);
  } catch {
    layout = [];
  }

  return {
    languages: [...languages].sort(),
    commands,
    layout,
    existingInstructionFiles: INSTRUCTION_FILES.filter((f) => has(dir, f)),
    ...(packageManager ? { packageManager } : {}),
  };
}

/** Render the starter instruction file from an analysis. Original template. */
export function renderInstructionFile(analysis: WorkspaceAnalysis, projectName: string): string {
  const cmd = (label: string, value: string | undefined) =>
    `- ${label}: ${value ? `\`${value}\`` : '<fill in the command, or delete this line>'}`;
  const langs = analysis.languages.length > 0 ? analysis.languages.join(', ') : '<fill in the main languages>';
  const layout = analysis.layout.length > 0 ? analysis.layout.map((e) => `- ${e}`).join('\n') : '- <fill in the top-level layout>';
  return [
    `# ${projectName} — instructions for AI coding agents`,
    '',
    'This file tells any agent working in this repository how the project is',
    'built, checked, and organised. Keep it short and factual; update it when',
    'the commands or layout change.',
    '',
    '## Stack',
    '',
    `- Languages: ${langs}`,
    ...(analysis.packageManager ? [`- Package manager: ${analysis.packageManager}`] : []),
    '',
    '## Commands',
    '',
    cmd('Build', analysis.commands.build),
    cmd('Test', analysis.commands.test),
    cmd('Lint / format', analysis.commands.lint),
    cmd('Run / dev', analysis.commands.run),
    '',
    'Run the test command after every change and report the result honestly,',
    'including failures.',
    '',
    '## Layout',
    '',
    layout,
    '',
    '## Conventions',
    '',
    '- <fill in: naming, formatting, and review conventions the team follows>',
    '- <fill in: anything an agent must never do in this repo (secrets, generated files, vendored code)>',
    '',
  ].join('\n');
}

export interface InitGenerationResult {
  analysis: WorkspaceAnalysis;
  /** The rendered starter file content. */
  content: string;
  /** Suggested target file name. */
  fileName: 'AGENTS.md';
}

/** Analyse `dir` and render a starter AGENTS.md for it. Pure; writes nothing. */
export function generateInitInstructions(dir: string): InitGenerationResult {
  const analysis = analyzeWorkspace(dir);
  let projectName = 'Project';
  const pkgRaw = readText(dir, 'package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { name?: string };
      if (typeof pkg.name === 'string' && pkg.name) projectName = pkg.name.replace(/^@[^/]+\//, '');
    } catch { /* keep default */ }
  }
  if (projectName === 'Project') {
    const base = dir.split('/').filter(Boolean).pop();
    if (base) projectName = base;
  }
  return { analysis, content: renderInstructionFile(analysis, projectName), fileName: 'AGENTS.md' };
}
