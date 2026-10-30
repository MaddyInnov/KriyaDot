// SPDX-License-Identifier: Apache-2.0
/**
 * Project instruction files (Octomind parity + CA-7/CA-8).
 *
 * Layers, merged least-specific first so the most specific guidance
 * lands last in the prompt:
 *
 *   1. Global user instructions (CA-8): files in the user's KriyaDot
 *      config dir (`$KRIYADOT_CONFIG_DIR` or `~/.kriyadot/`):
 *      `instructions.md`, then `AGENTS.md`.
 *   2. Configured sources (CA-8): extra files matched by the
 *      `instructions` glob list from `.kriyadot/config.json` (or the
 *      `instructionSources` option), workspace-relative.
 *   3. Workspace files: AGENTS.md, KRIYADOT.md, .kriyadot/instructions.md.
 *   4. Path-scoped rules (CA-7): `.kriyadot/rules/*.md` whose `paths`
 *      frontmatter globs match the turn's touched paths. Rules with no
 *      `paths` always apply. Touched paths come from the caller
 *      (`touchedPaths`), plus path-like tokens in the latest user
 *      message when one is supplied.
 *
 * `@path` imports (CA-7): instruction files may reference other files
 * with `@relative/path.md`; the referenced content is inlined at load.
 * Imports are depth-capped (3), cycle-safe, and confined to the
 * workspace or the user config dir — an import that escapes either
 * root is replaced with a refusal note, never followed.
 *
 * Content is capped (per-file and total). Results are cached per
 * directory+signal and invalidated by mtime/size.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PROJECT_INSTRUCTION_CANDIDATES = [
  'AGENTS.md',
  'KRIYADOT.md',
  '.kriyadot/instructions.md',
] as const;

/** File names looked for in the user config dir (CA-8), in order. */
export const GLOBAL_INSTRUCTION_CANDIDATES = ['instructions.md', 'AGENTS.md'] as const;

const MAX_PER_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 24_000;
const MAX_IMPORT_DEPTH = 3;

/** The user's KriyaDot config dir: $KRIYADOT_CONFIG_DIR or ~/.kriyadot. */
export function resolveKriyadotConfigDir(homeDir?: string): string {
  const env = process.env.KRIYADOT_CONFIG_DIR;
  if (env && env.trim()) return resolve(env.trim());
  return join(homeDir ?? homedir(), '.kriyadot');
}

export interface ProjectInstructions {
  /** Rendered prompt section (headings + file contents), ready to append. */
  text: string;
  /** Workspace-relative (or `global:`-prefixed) paths of the files loaded. */
  files: string[];
}

export interface LoadProjectInstructionsOptions {
  /** Paths the current turn is touching (CA-7 scoping signal). */
  touchedPaths?: string[];
  /** Latest user message; path-like tokens join the scoping signal. */
  message?: string;
  /** User config dir override; `false` disables the global layer. */
  globalDir?: string | false;
  /** Home dir used to resolve the default global dir (tests). */
  homeDir?: string;
  /** Extra instruction source globs (CA-8), workspace-relative. */
  instructionSources?: string[];
}

// ---------------------------------------------------------------------------
// Glob matching (CA-7/CA-8): `**` crosses directories, `*` stays in one
// segment, `?` is one character. Paths are matched workspace-relative
// with forward slashes.
// ---------------------------------------------------------------------------

export function matchPathGlob(pattern: string, path: string): boolean {
  const pat = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const target = path.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === '*') {
      if (pat[i + 1] === '*') {
        re += '.*';
        i++;
        if (pat[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(target);
}

/** Path-like tokens in a message (file paths + directory prefixes). */
export function extractPathsFromMessage(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(/[\w@./-]+\.[a-zA-Z]{1,6}\b/g)) out.add(m[0]);
  for (const m of message.matchAll(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]*)/g)) if (m[1]) out.add(m[1]);
  return [...out];
}

// ---------------------------------------------------------------------------
// Frontmatter (minimal): `paths:` / `globs:` as inline list or dash list.
// ---------------------------------------------------------------------------

export function parseRuleFrontmatter(content: string): { paths: string[]; body: string } {
  if (!content.startsWith('---')) return { paths: [], body: content };
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { paths: [], body: content };
  const fm = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\n/, '');
  const paths: string[] = [];
  const lines = fm.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:paths|globs)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const rest = m[1]!.trim();
    if (rest.startsWith('[')) {
      for (const part of rest.replace(/^\[|\]$/g, '').split(',')) {
        const v = part.trim().replace(/^["']|["']$/g, '');
        if (v) paths.push(v);
      }
    } else if (rest) {
      paths.push(rest.replace(/^["']|["']$/g, ''));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s*-\s+(.+)$/.exec(lines[j]!);
        if (!item) break;
        paths.push(item[1]!.trim().replace(/^["']|["']$/g, ''));
      }
    }
  }
  return { paths, body };
}

// ---------------------------------------------------------------------------
// @path imports (CA-7)
// ---------------------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/**
 * Inline `@path.md` imports in `content`. `baseDir` is the importing
 * file's directory; imports must resolve inside `allowedRoots`.
 * Depth-capped and cycle-safe; failures become explicit notes.
 */
export function expandInstructionImports(
  content: string,
  baseDir: string,
  allowedRoots: string[],
  depth = 0,
  seen: Set<string> = new Set(),
): string {
  return content.replace(/@((?:\.\.?\/)?[\w@./-]+\.md)\b/g, (whole, ref: string) => {
    if (depth >= MAX_IMPORT_DEPTH) return `[import depth limit reached: @${ref}]`;
    const target = resolve(baseDir, ref);
    if (!allowedRoots.some((root) => isInside(root, target))) {
      return `[import refused — outside the workspace/config dir: @${ref}]`;
    }
    if (seen.has(target)) return `[import skipped — cycle: @${ref}]`;
    let imported: string;
    try {
      imported = readFileSync(target, 'utf8').trim();
    } catch {
      return `[import not found: @${ref}]`;
    }
    if (!imported) return '';
    const nextSeen = new Set(seen).add(target);
    const expanded = expandInstructionImports(imported, dirname(target), allowedRoots, depth + 1, nextSeen);
    return `\n\n<!-- imported from ${ref} -->\n${expanded}\n<!-- end import ${ref} -->\n\n`;
  });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface CacheEntry {
  signature: string;
  result: ProjectInstructions | undefined;
}

const cache = new Map<string, CacheEntry>();

function statPart(label: string, file: string): string {
  try {
    const s = statSync(file);
    return `${label}:${s.mtimeMs}:${s.size}`;
  } catch {
    return `${label}:-`;
  }
}

function configuredSources(dir: string, opts: LoadProjectInstructionsOptions): string[] {
  const out: string[] = [...(opts.instructionSources ?? [])];
  try {
    const raw = readFileSync(join(dir, '.kriyadot', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { instructions?: unknown };
    if (Array.isArray(parsed.instructions)) {
      for (const v of parsed.instructions) if (typeof v === 'string' && v) out.push(v);
    }
  } catch {
    // No config / unparseable config: no configured sources.
  }
  return [...new Set(out)];
}

/** Files in `dir` matching a workspace-relative glob (one directory walk, shallow-capped). */
function globFiles(dir: string, pattern: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 6 || out.length > 50) return;
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child, depth + 1);
      else if (matchPathGlob(pattern, child)) out.push(child);
    }
  };
  walk('', 0);
  return out.sort();
}

function listRuleFiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, '.kriyadot', 'rules'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `.kriyadot/rules/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load instructions for a workspace, merged global → configured →
 * workspace → path-scoped (most specific last). Returns undefined when
 * nothing exists anywhere. Never throws.
 */
export function loadProjectInstructions(
  dir: string,
  opts: LoadProjectInstructionsOptions = {},
): ProjectInstructions | undefined {
  if (!dir) return undefined;
  const globalDir = opts.globalDir === false ? undefined : (opts.globalDir ?? resolveKriyadotConfigDir(opts.homeDir));
  const sources = configuredSources(dir, opts);
  const sourceFiles = sources.flatMap((g) => globFiles(dir, g));
  const ruleFiles = listRuleFiles(dir);
  const touched = [...new Set([...(opts.touchedPaths ?? []), ...(opts.message ? extractPathsFromMessage(opts.message) : [])])];

  const sigParts: string[] = [
    ...PROJECT_INSTRUCTION_CANDIDATES.map((rel) => statPart(rel, join(dir, rel))),
    ...(globalDir ? GLOBAL_INSTRUCTION_CANDIDATES.map((rel) => statPart(`global:${rel}`, join(globalDir, rel))) : []),
    statPart('.kriyadot/config.json', join(dir, '.kriyadot', 'config.json')),
    ...sourceFiles.map((rel) => statPart(`src:${rel}`, join(dir, rel))),
    ...ruleFiles.map((rel) => statPart(rel, join(dir, rel))),
  ];
  const signature = sigParts.join('|');
  const cacheKey = `${dir}::${[...touched].sort().join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.signature === signature) return cached.result;

  const allowedRoots = [dir, ...(globalDir ? [globalDir] : [])];
  const sections: string[] = [];
  const files: string[] = [];
  let total = 0;
  const push = (label: string, fileLabel: string, raw: string, baseDir: string): boolean => {
    let body = expandInstructionImports(raw.trim(), baseDir, allowedRoots).slice(0, MAX_PER_FILE_CHARS);
    if (raw.length > MAX_PER_FILE_CHARS) body += '\n…[truncated]';
    if (!body.trim()) return true;
    if (total + body.length > MAX_TOTAL_CHARS) {
      body = body.slice(0, Math.max(0, MAX_TOTAL_CHARS - total));
      if (!body) return false;
    }
    total += body.length;
    files.push(fileLabel);
    sections.push(`## ${label}\n${body}`);
    return true;
  };
  const read = (abs: string): string | undefined => {
    try {
      return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };

  // 1. Global layer (CA-8).
  if (globalDir) {
    for (const rel of GLOBAL_INSTRUCTION_CANDIDATES) {
      const raw = read(join(globalDir, rel));
      if (raw) push(`Global instructions — ${rel}`, `global:${rel}`, raw, globalDir);
    }
  }
  // 2. Configured sources (CA-8).
  for (const rel of sourceFiles) {
    const raw = read(join(dir, rel));
    if (raw) push(`Project instructions — ${rel} (configured source)`, rel, raw, dirname(join(dir, rel)));
  }
  // 3. Workspace files.
  for (const rel of PROJECT_INSTRUCTION_CANDIDATES) {
    const raw = read(join(dir, rel));
    if (raw) push(`Project instructions — ${rel}`, rel, raw, dirname(join(dir, rel)));
  }
  // 4. Path-scoped rules (CA-7): lazy — only rules whose globs match a
  // touched path load; rules without globs always load.
  for (const rel of ruleFiles) {
    const raw = read(join(dir, rel));
    if (raw === undefined) continue;
    const parsed = parseRuleFrontmatter(raw);
    const applies =
      parsed.paths.length === 0 || touched.some((t) => parsed.paths.some((g) => matchPathGlob(g, t)));
    if (!applies) continue;
    push(`Project rule — ${rel}`, rel, parsed.body, dirname(join(dir, rel)));
  }

  const result = sections.length > 0 ? { text: sections.join('\n\n'), files } : undefined;
  cache.set(cacheKey, { signature, result });
  return result;
}

/** Test hook: drop the cache (files changed underneath us). */
export function clearProjectInstructionsCache(): void {
  cache.clear();
}
