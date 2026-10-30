// SPDX-License-Identifier: Apache-2.0
// Coding tools for the agent runtime: patch (unified diff), edit (surgical
// string replace), glob, grep, semantic search, notebook tools, and the
// LSP tool family (diagnostics / definition / hover / references) backed
// by the managed language-server fleet in src/lsp/ (CA-9).
//
// Wave-3 coding-core closure (ADD-7):
//   CA-9  — LSP tools run against LspManager (persistent servers, lazy
//           per-root spawn, reuse, idle shutdown); after edit/patch the
//           edited file's diagnostics are appended to the tool result.
//   CA-10 — after edit/patch, the project formatter runs on the file
//           (tools/formatters.ts); failures are notes, never failures.
//   CA-11 — glob/grep/semantic-search honour .gitignore +
//           .kriyadotignore (tools/ignore.ts); includeIgnored overrides.
//   CA-14 — notebook_read / notebook_edit for .ipynb (tools/notebook.ts).
//   CA-26 — multi-root sessions: the primary workspace plus additional
//           roots (factory-seeded, per-turn via ToolContext, or added
//           mid-session with add_workspace_dir), each confined to itself.
//
// Every tool is confined to a workspace root (same confine() pattern as
// tools/builtin.ts): any path that resolves outside ALL roots throws.
// These tools return plain ToolDefinitions and flow through the normal
// governance path (the tool registry evaluates policy before dispatch).

import {
  Dirent,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolContext, ToolDefinition } from '../types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';
import { confineRealpath } from '../confine.js';
import { lineHash } from './line-hash.js';
import { cosineSimilarity, type SyncEmbedder } from '../hybrid-search.js';
import { LspManager, summarizeDiagnostics, type LspManagerOptions } from '../lsp/manager.js';
import { formatFile, type FormatterRunner, type FormatterSpec } from './formatters.js';
import { IgnoreMatcher } from './ignore.js';
import { notebookEditTool, notebookReadTool } from './notebook.js';

/**
 * Embedder injection for `search_code_semantic` (#60): the platform
 * embedder reaches coding tools through the factory options — the
 * same dependency path other tool factories use for services (cf.
 * WebSearchOptions' fetchFn/env in builtin.ts), since ToolContext
 * carries no embedder. Hosts pass the runtime's embedder (neural when
 * configured); unset → the tool degrades to lexical-only and says so.
 */
export interface CodingToolsOptions {
  workspaceDir: WorkspaceSource;
  embedder?: SyncEmbedder;
  /**
   * CA-9: a shared LspManager (host-owned lifecycle — the host disposes
   * it). When omitted, the factory creates one per tool set.
   */
  lspManager?: LspManager;
  /** CA-9: options for the factory-created LspManager (ignored when lspManager is given). */
  lsp?: LspManagerOptions;
  /** CA-10: formatter overrides (extension → spec|null), winning over `.kriyadot/formatters.json`. */
  formatters?: Record<string, FormatterSpec | null>;
  /** CA-10: injectable formatter process runner (tests fake it; no real formatters run). */
  formatterRunner?: FormatterRunner;
  /** CA-26: extra workspace roots seeded for every session using these tools. */
  additionalRoots?: string[];
  /**
   * Post-edit pipeline (CA-9 diagnostics + CA-10 formatting) run by the
   * edit/patch tools. Default true; set false to disable both halves.
   */
  postEdit?: boolean;
}

/**
 * Resolve `p` inside `workspaceDir`, following symlinks (M3). Throws if the
 * real path escapes the workspace (directory traversal or symlink escape).
 * Mirrors tools/builtin.ts.
 */
function confine(workspaceDir: string, p: string): string {
  return confineRealpath(workspaceDir, p);
}

function wsRelative(workspaceDir: string, abs: string): string {
  return relative(resolve(workspaceDir), abs);
}

// ---------------------------------------------------------------------------
// Multi-root confinement (CA-26)
// ---------------------------------------------------------------------------

/**
 * Session-scoped state for one tool set: roots added mid-session via
 * add_workspace_dir. Factory-seeded roots and per-turn roots
 * (ToolContext.additionalWorkspaceRoots) are merged in per call.
 */
export interface MultiRootState {
  addedRoots: string[];
}

export function createMultiRootState(): MultiRootState {
  return { addedRoots: [] };
}

interface ResolvedPath {
  abs: string;
  /** The root the path was confined to. */
  root: string;
  /** Path relative to that root ('/'-separated). */
  rel: string;
  /** True when the root is not the primary workspace. */
  extra: boolean;
}

/** All effective roots for a call: primary first, then seeded/turn/session extras. */
function effectiveRoots(
  primary: string,
  opts: CodingToolsOptions,
  state: MultiRootState,
  ctx: ToolContext | undefined,
): string[] {
  const roots: string[] = [resolve(primary)];
  const push = (r: string) => {
    const abs = resolve(r);
    if (!roots.includes(abs)) roots.push(abs);
  };
  for (const r of opts.additionalRoots ?? []) push(r);
  for (const r of ctx?.additionalWorkspaceRoots ?? []) push(r);
  for (const r of state.addedRoots) push(r);
  return roots;
}

/**
 * Confine `p` against the root list. Absolute paths must land inside one
 * root; relative paths resolve against the first root where the target
 * already exists, else the primary root. A path escaping EVERY root
 * throws — each root confines independently (CA-26).
 */
function confineAny(roots: string[], p: string): ResolvedPath {
  if (isAbsolute(p)) {
    for (let i = 0; i < roots.length; i++) {
      try {
        const abs = confineRealpath(roots[i]!, p);
        return { abs, root: roots[i]!, rel: relative(roots[i]!, abs).split(sep).join('/'), extra: i > 0 };
      } catch {
        // Not inside this root — try the next.
      }
    }
    throw new Error(`Path escapes workspace: "${p}"`);
  }
  // Relative: prefer the root where the path already exists.
  for (let i = 0; i < roots.length; i++) {
    const candidate = resolve(roots[i]!, p);
    if (existsSync(candidate)) {
      const abs = confineRealpath(roots[i]!, p);
      return { abs, root: roots[i]!, rel: relative(roots[i]!, abs).split(sep).join('/'), extra: i > 0 };
    }
  }
  const abs = confineRealpath(roots[0]!, p);
  return { abs, root: roots[0]!, rel: relative(roots[0]!, abs).split(sep).join('/'), extra: false };
}

/** Display path for results: primary-root files stay plain; extra-root files are prefixed with the root's directory name. */
function displayPath(rp: ResolvedPath): string {
  return rp.extra ? `${basename(rp.root)}/${rp.rel}` : rp.rel;
}

// ---------------------------------------------------------------------------
// Shared per-tool-set environment + the post-edit pipeline (CA-9 + CA-10)
// ---------------------------------------------------------------------------

interface CodingEnv {
  opts: CodingToolsOptions;
  state: MultiRootState;
  lsp: LspManager;
}

function rootsFor(env: CodingEnv, ctx: ToolContext): string[] {
  const primary = resolveWorkspaceDir(env.opts.workspaceDir, ctx);
  return effectiveRoots(primary, env.opts, env.state, ctx);
}

function confineFor(env: CodingEnv, ctx: ToolContext, p: string): ResolvedPath {
  return confineAny(rootsFor(env, ctx), p);
}

const MAX_POST_EDIT_FILES = 5;

/**
 * Post-edit pipeline, called by the mutating coding tools (edit, patch)
 * after a successful write — the seam the task prefers over runtime.ts
 * surgery: the coding-tool layer enriches its own results. Hosts whose
 * write path lives elsewhere (builtin write_file) can call the exported
 * runPostEditPipeline with the same manager/formatters the factory uses.
 *
 * Formatting runs first (it may change the file), then diagnostics are
 * read for the final content. Everything is best-effort: formatter
 * failures and unavailable language servers become `notes`, never errors.
 */
async function postEditEnrich(
  env: CodingEnv,
  files: ResolvedPath[],
): Promise<Record<string, unknown>> {
  if (env.opts.postEdit === false || files.length === 0) return {};
  const formatting: unknown[] = [];
  const notes: string[] = [];
  const targets = files.slice(0, MAX_POST_EDIT_FILES);
  for (const f of targets) {
    const outcome = formatFile(f.root, f.abs, displayPath(f), {
      runner: env.opts.formatterRunner,
      overrides: env.opts.formatters,
    });
    if (outcome.formatted) {
      formatting.push(outcome);
    } else if (outcome.error) {
      formatting.push(outcome);
      notes.push(`formatter failed for ${displayPath(f)}: ${outcome.error}`);
    } else if (outcome.skipped && !outcome.skipped.startsWith('no formatter')) {
      notes.push(`formatting skipped for ${displayPath(f)}: ${outcome.skipped}`);
    }
  }
  const diagnostics: unknown[] = [];
  for (const f of targets) {
    if (!env.lsp.supportsFile(f.root, f.abs)) continue;
    const res = await env.lsp.getDiagnostics(f.root, f.abs);
    if (!res.ok) {
      notes.push(`diagnostics unavailable for ${displayPath(f)}: ${res.unavailable}`);
      continue;
    }
    const summary = summarizeDiagnostics(displayPath(f), res.value);
    if (summary.total > 0) diagnostics.push(summary);
  }
  return {
    ...(formatting.length > 0 ? { formatting } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Exported post-edit pipeline for hosts/tools outside the coding factory
 * (e.g. builtin write_file): formats `absPath` and computes its LSP
 * diagnostics summary. Never throws.
 */
export async function runPostEditPipeline(args: {
  root: string;
  absPath: string;
  relPath: string;
  lsp: LspManager;
  formatters?: Record<string, FormatterSpec | null>;
  formatterRunner?: FormatterRunner;
}): Promise<Record<string, unknown>> {
  const env: CodingEnv = {
    opts: {
      workspaceDir: args.root,
      formatters: args.formatters,
      formatterRunner: args.formatterRunner,
    },
    state: createMultiRootState(),
    lsp: args.lsp,
  };
  const rp: ResolvedPath = {
    abs: args.absPath,
    root: args.root,
    rel: args.relPath.split(sep).join('/'),
    extra: false,
  };
  try {
    return await postEditEnrich(env, [rp]);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// patch — unified diff
// ---------------------------------------------------------------------------

interface ParsedHunk {
  oldStart: number; // 1-based
  oldLines: number;
  newStart: number; // 1-based
  newLines: number;
  lines: { kind: 'context' | 'add' | 'remove'; text: string }[];
}

interface ParsedFileDiff {
  oldPath: string | null; // null => /dev/null (new file)
  newPath: string | null; // null => /dev/null (deleted file)
  hunks: ParsedHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripDiffPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  // Accept a/ b/ prefixes, plain paths, and quoted paths.
  let s = p.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** Parse a unified diff into per-file hunk lists. Throws on malformed input. */
function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = diff.split('\n');
  let current: ParsedFileDiff | null = null;
  let currentHunk: ParsedHunk | null = null;

  const pushFile = () => {
    if (current) files.push(current);
    current = null;
    currentHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      pushFile();
      current = { oldPath: stripDiffPrefix(line.slice(4)), newPath: null, hunks: [] };
    } else if (line.startsWith('+++ ')) {
      if (!current) throw new Error('unified diff: "+++" without preceding "---"');
      current.newPath = stripDiffPrefix(line.slice(4));
    } else if (line.startsWith('@@')) {
      if (!current) throw new Error('unified diff: hunk without file header');
      const m = HUNK_HEADER.exec(line);
      if (!m) throw new Error(`unified diff: malformed hunk header: "${line}"`);
      currentHunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      current.hunks.push(currentHunk);
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" marker — informational only.
      continue;
    } else if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line === '')) {
      // A truly empty line inside a diff body is a context line with empty text
      // (diff strips the leading space). Treat '' as context ''.
      const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context';
      const text = line === '' ? '' : line.slice(1);
      currentHunk.lines.push({ kind, text });
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      // git extended headers — informational, ignore.
      continue;
    } else if (line.trim() === '' && !currentHunk) {
      continue;
    } else if (current && currentHunk) {
      throw new Error(`unified diff: unexpected line ${i + 1}: "${line.slice(0, 60)}"`);
    }
  }
  pushFile();

  if (files.length === 0) throw new Error('unified diff: no file diffs found');
  for (const f of files) {
    if (f.hunks.length === 0) throw new Error('unified diff: file diff with no hunks');
  }
  return files;
}

/** Apply parsed hunks to `original` lines. Returns new lines or throws. */
function applyHunks(original: string[], fileDiff: ParsedFileDiff, label: string): string[] {
  const out: string[] = [];
  let cursor = 0; // 0-based index into original consumed so far

  for (const hunk of fileDiff.hunks) {
    const hunkStart = hunk.oldStart - 1; // 0-based
    if (hunkStart < cursor) {
      throw new Error(`patch failed for "${label}": overlapping hunks`);
    }
    // Copy unchanged lines before the hunk.
    out.push(...original.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const l of hunk.lines) {
      if (l.kind === 'context') {
        if (original[cursor] !== l.text) {
          throw new Error(
            `patch failed for "${label}": context mismatch at line ${cursor + 1} ` +
              `(expected ${JSON.stringify(l.text.slice(0, 60))}, found ${JSON.stringify((original[cursor] ?? '').slice(0, 60))})`,
          );
        }
        out.push(l.text);
        cursor += 1;
      } else if (l.kind === 'remove') {
        if (original[cursor] !== l.text) {
          throw new Error(
            `patch failed for "${label}": removal mismatch at line ${cursor + 1} ` +
              `(expected ${JSON.stringify(l.text.slice(0, 60))}, found ${JSON.stringify((original[cursor] ?? '').slice(0, 60))})`,
          );
        }
        cursor += 1;
      } else {
        out.push(l.text);
      }
    }
  }
  out.push(...original.slice(cursor));
  return out;
}

interface PatchFileResult {
  path: string;
  ok: boolean;
  error?: string;
  action?: 'modified' | 'created' | 'deleted';
}

function patchTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'patch',
    mutating: true,
    description:
      'Apply a unified diff to files inside the workspace. Context lines are verified ' +
      'before applying; the whole file fails if any hunk mismatches. Set dryRun=true ' +
      'to validate without writing. Diffs that escape the workspace are refused.',
    parameters: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Unified diff text (--- / +++ headers, @@ hunks)' },
        dryRun: { type: 'boolean', description: 'Validate only, do not write (default false)' },
      },
      required: ['diff'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const diff = String(args.diff ?? '');
      const dryRun = args.dryRun === true;
      if (!diff.trim()) throw new Error('patch: "diff" must not be empty');
      const fileDiffs = parseUnifiedDiff(diff);
      const results: PatchFileResult[] = [];
      const pending: { abs: string; rel: string; resolved: ResolvedPath; lines: string[]; action: 'modified' | 'created' | 'deleted' }[] = [];

      for (const fd of fileDiffs) {
        const target = fd.newPath ?? fd.oldPath;
        if (!target) throw new Error('patch: diff has neither old nor new path');
        let rel: string;
        let abs: string;
        let resolvedPath: ResolvedPath;
        try {
          rel = target;
          resolvedPath = confineFor(env, ctx, rel);
          abs = resolvedPath.abs;
        } catch (err) {
          results.push({ path: target, ok: false, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        const isNew = fd.oldPath === null;
        const isDelete = fd.newPath === null;
        const exists = existsSync(abs);
        if (isNew && exists) {
          results.push({ path: rel, ok: false, error: 'patch: file already exists (new-file diff)' });
          continue;
        }
        if (!isNew && !exists) {
          results.push({ path: rel, ok: false, error: 'patch: target file does not exist' });
          continue;
        }
        const original = isNew ? [] : readFileSync(abs, 'utf8').split('\n');
        try {
          const next = applyHunks(original, fd, rel);
          const action = isDelete ? 'deleted' : isNew ? 'created' : 'modified';
          pending.push({ abs, rel, resolved: resolvedPath, lines: next, action });
          results.push({ path: rel, ok: true, action });
        } catch (err) {
          results.push({ path: rel, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (!dryRun) {
        for (const p of pending) {
          if (p.action === 'deleted') {
            unlinkSync(p.abs);
          } else {
            mkdirSync(dirname(p.abs), { recursive: true });
            writeFileSync(p.abs, p.lines.join('\n'), 'utf8');
          }
        }
      }
      const applied = results.filter((r) => r.ok).map((r) => r.path);
      // CA-9/CA-10: format + diagnose the files we just wrote.
      const enrich = dryRun
        ? {}
        : await postEditEnrich(env, pending.filter((p) => p.action !== 'deleted').map((p) => p.resolved));
      return { applied, dryRun, files: results, ...enrich };
    },
  };
}

// ---------------------------------------------------------------------------
// edit — surgical string replace
// ---------------------------------------------------------------------------

function editTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'edit',
    mutating: true,
    description:
      'Surgically replace text in a workspace file. Two modes: (1) exact-string mode — ' +
      'replace oldText with newText; fails if oldText is not found, or if the number of ' +
      'occurrences does not match expectedCount (when given). (2) Range mode (#184) — ' +
      'replace lines startLine..endLine (1-based, inclusive) with newText, but ONLY when ' +
      'expectedStartHash/expectedEndHash match the current boundary-line hashes from a ' +
      'read_file withHashes read; a mismatch fails with a stale-file error and writes nothing.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        oldText: { type: 'string', description: 'Exact text to replace (exact-string mode)' },
        newText: { type: 'string', description: 'Replacement text (both modes; empty string deletes the range in range mode)' },
        expectedCount: {
          type: 'number',
          description: 'Require exactly this many occurrences of oldText (default: 1; exact-string mode)',
        },
        startLine: { type: 'number', description: 'Range mode: first line to replace (1-based)' },
        endLine: { type: 'number', description: 'Range mode: last line to replace (1-based, inclusive)' },
        expectedStartHash: {
          type: 'string',
          description: 'Range mode: hash of the current startLine content, from read_file withHashes (e.g. "a3f9c2")',
        },
        expectedEndHash: {
          type: 'string',
          description: 'Range mode: hash of the current endLine content, from read_file withHashes',
        },
      },
      required: ['path', 'newText'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const resolvedPath = confineFor(env, ctx, String(args.path));
      const file = resolvedPath.abs;
      if (!existsSync(file)) throw new Error(`edit: file does not exist: "${args.path}"`);
      const content = readFileSync(file, 'utf8');

      // --- Range mode (#184): hashed boundary lines, stale-safe. ---
      if (args.startLine !== undefined || args.endLine !== undefined) {
        const startLine = Number(args.startLine);
        const endLine = Number(args.endLine);
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
          throw new Error('edit: range mode needs integer line numbers with 1 <= startLine <= endLine');
        }
        const expectedStartHash = typeof args.expectedStartHash === 'string' ? args.expectedStartHash : '';
        const expectedEndHash = typeof args.expectedEndHash === 'string' ? args.expectedEndHash : '';
        if (!expectedStartHash || !expectedEndHash) {
          throw new Error(
            'edit: range mode requires expectedStartHash and expectedEndHash (from read_file with withHashes=true) — refusing an unverified range edit',
          );
        }
        const lines = content.split('\n');
        if (endLine > lines.length) {
          throw new Error(`edit: endLine ${endLine} is past the end of "${args.path}" (${lines.length} lines)`);
        }
        const startActual = lineHash(lines[startLine - 1]!);
        if (startActual !== expectedStartHash) {
          throw new Error(
            `edit: stale file — line ${startLine} of "${args.path}" has hash ${startActual}, expected ${expectedStartHash}. ` +
              'The file changed since it was read; re-read it with read_file (withHashes=true) and retry.',
          );
        }
        const endActual = lineHash(lines[endLine - 1]!);
        if (endActual !== expectedEndHash) {
          throw new Error(
            `edit: stale file — line ${endLine} of "${args.path}" has hash ${endActual}, expected ${expectedEndHash}. ` +
              'The file changed since it was read; re-read it with read_file (withHashes=true) and retry.',
          );
        }
        const newText = String(args.newText ?? '');
        const replacement = newText === '' ? [] : newText.split('\n');
        const nextLines = [
          ...lines.slice(0, startLine - 1),
          ...replacement,
          ...lines.slice(endLine),
        ];
        writeFileSync(file, nextLines.join('\n'), 'utf8');
        const enrich = await postEditEnrich(env, [resolvedPath]);
        return {
          path: String(args.path),
          mode: 'range',
          replacements: 1,
          linesReplaced: endLine - startLine + 1,
          ...enrich,
        };
      }

      // --- Exact-string mode (unchanged behaviour). ---
      const oldText = String(args.oldText ?? '');
      const newText = String(args.newText ?? '');
      if (oldText.length === 0) throw new Error('edit: "oldText" must not be empty');
      const count = content.split(oldText).length - 1;
      const expected = args.expectedCount === undefined ? 1 : Number(args.expectedCount);
      if (!Number.isInteger(expected) || expected < 1) {
        throw new Error('edit: "expectedCount" must be a positive integer');
      }
      if (count === 0) throw new Error(`edit: oldText not found in "${args.path}"`);
      if (count !== expected) {
        throw new Error(
          `edit: found ${count} occurrence(s) of oldText in "${args.path}", expected ${expected} — refusing ambiguous replace`,
        );
      }
      const next = content.split(oldText).join(newText);
      writeFileSync(file, next, 'utf8');
      const enrich = await postEditEnrich(env, [resolvedPath]);
      return { path: String(args.path), replacements: count, ...enrich };
    },
  };
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const MAX_GLOB_RESULTS = 200;

/** Convert a glob pattern (*, ?, **) to a RegExp over '/'-separated paths. */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches across separators; "**/" also matches zero dirs.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if ('\\.+^${}()|[]'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Collect files under one root, honouring .gitignore/.kriyadotignore
 * (CA-11) unless includeIgnored is set. `.git` internals are always
 * skipped; `node_modules` keeps its historical default skip unless
 * includeIgnored is set or an ignore-file negation re-includes it.
 * Nested ignore files are picked up as the walk descends.
 */
function collectFiles(root: string, includeIgnored: boolean, out: string[]): void {
  const matcher = includeIgnored ? null : new IgnoreMatcher(root);
  const walk = (dir: string, relBase: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (matcher && relBase !== '') matcher.addDirectoryRules(dir, relBase);
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (!includeIgnored && e.name === 'node_modules') continue;
        if (matcher && matcher.isIgnored(rel, true)) continue;
        walk(abs, rel);
      } else if (e.isFile()) {
        if (matcher && matcher.isIgnored(rel, false)) continue;
        out.push(abs);
      }
    }
  };
  walk(root, '');
}

/** Back-compat walk used where ignore handling is not parameterised. */
function walkFiles(root: string, out: string[]): void {
  collectFiles(root, false, out);
}

function globTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'glob',
    description:
      'Find files in the workspace matching a glob pattern (*, ?, ** supported). ' +
      'Honours .gitignore and .kriyadotignore by default (set includeIgnored=true to ' +
      'search ignored files too). Searches all session roots (CA-26); files in extra ' +
      'roots are prefixed with that root\'s directory name. Returns paths capped at 200.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
        includeIgnored: { type: 'boolean', description: 'Include files matched by ignore rules (default false)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const pattern = String(args.pattern ?? '');
      if (!pattern) throw new Error('glob: "pattern" must not be empty');
      const rx = globToRegExp(pattern);
      const includeIgnored = args.includeIgnored === true;
      const roots = rootsFor(env, ctx);
      const matched: string[] = [];
      for (const root of roots) {
        const all: string[] = [];
        collectFiles(root, includeIgnored, all);
        for (const abs of all) {
          const rel = wsRelative(root, abs).split(sep).join('/');
          const display = root === roots[0] ? rel : `${basename(root)}/${rel}`;
          if (rx.test(rel) || rx.test(display)) matched.push(display);
        }
      }
      const unique = [...new Set(matched)].sort().slice(0, MAX_GLOB_RESULTS);
      return { pattern, matches: unique, truncated: unique.length === MAX_GLOB_RESULTS };
    },
  };
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const MAX_GREP_MATCHES = 50;
const BINARY_PROBE_BYTES = 8192;

function isBinaryFile(abs: string): boolean {
  let fd = -1;
  try {
    const st = statSync(abs);
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, st.size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.includes(0);
  } catch {
    return true; // unreadable => skip
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function grepTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'grep',
    description:
      'Regex content search across workspace files. Returns up to 50 matches with ' +
      'line numbers. Binary files are skipped. Honours .gitignore/.kriyadotignore ' +
      'by default (includeIgnored=true searches ignored files too). Without a path, ' +
      'searches all session roots (CA-26).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex pattern' },
        path: { type: 'string', description: 'Workspace-relative file or directory (default: all roots)' },
        filePattern: { type: 'string', description: 'Glob filter for file paths, e.g. "*.ts"' },
        includeIgnored: { type: 'boolean', description: 'Include files matched by ignore rules (default false)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const pattern = String(args.pattern ?? '');
      if (!pattern) throw new Error('grep: "pattern" must not be empty');
      let rx: RegExp;
      try {
        rx = new RegExp(pattern);
      } catch (err) {
        throw new Error(`grep: invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const includeIgnored = args.includeIgnored === true;
      const fileRx = args.filePattern === undefined ? null : globToRegExp(String(args.filePattern));
      const roots = rootsFor(env, ctx);

      // Candidate files, each tagged with its display path.
      const candidates: { abs: string; display: string }[] = [];
      if (args.path !== undefined) {
        const rp = confineFor(env, ctx, String(args.path));
        let st;
        try {
          st = statSync(rp.abs);
        } catch {
          throw new Error(`grep: path does not exist: "${args.path}"`);
        }
        if (st.isDirectory()) {
          const found: string[] = [];
          collectFiles(rp.abs, includeIgnored, found);
          for (const abs of found) {
            const rel = wsRelative(rp.root, abs).split(sep).join('/');
            candidates.push({ abs, display: rp.extra ? `${basename(rp.root)}/${rel}` : rel });
          }
        } else {
          candidates.push({ abs: rp.abs, display: displayPath(rp) });
        }
      } else {
        for (const root of roots) {
          const found: string[] = [];
          collectFiles(root, includeIgnored, found);
          for (const abs of found) {
            const rel = wsRelative(root, abs).split(sep).join('/');
            candidates.push({ abs, display: root === roots[0] ? rel : `${basename(root)}/${rel}` });
          }
        }
      }

      const matches: { path: string; line: number; text: string }[] = [];
      outer: for (const cand of candidates) {
        if (fileRx && !fileRx.test(cand.display)) continue;
        if (isBinaryFile(cand.abs)) continue;
        let content: string;
        try {
          content = readFileSync(cand.abs, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i])) {
            matches.push({ path: cand.display, line: i + 1, text: lines[i].slice(0, 500) });
            if (matches.length >= MAX_GREP_MATCHES) break outer;
          }
        }
      }
      return { pattern, matches, truncated: matches.length === MAX_GREP_MATCHES };
    },
  };
}

// ---------------------------------------------------------------------------
// search_code_semantic (#60) — hybrid lexical + embedding code search
// ---------------------------------------------------------------------------

const MAX_SEMANTIC_FILES = 500;
const MAX_SEMANTIC_FILE_CHARS = 8_000;
const DEFAULT_SEMANTIC_LIMIT = 10;
const MAX_SEMANTIC_LIMIT = 50;

interface SemanticIndexEntry {
  rel: string;
  mtimeMs: number;
  size: number;
  /** Content excerpt used for lexical scoring + snippets. */
  text: string;
  /** Embedding of `text`, tagged with the embedder that produced it. */
  vector?: Float32Array;
  vectorEmbedder?: string;
}

/**
 * In-memory index cache, keyed by workspace root. Entries are
 * validated per call against file mtime/size — a changed file is
 * re-read (and re-embedded) on the next search, a deleted file drops
 * out. No on-disk index: the scan is on-demand by design.
 */
const semanticIndexCache = new Map<string, Map<string, SemanticIndexEntry>>();

/** Test hook: drop the semantic index cache. */
export function clearSemanticIndexCache(): void {
  semanticIndexCache.clear();
}

function lexicalTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tok of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (tok.length < 2) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return counts;
}

/** Lexical score: fraction-weighted query-token coverage of one file. */
function lexicalScore(queryTokens: Map<string, number>, fileTokens: Map<string, number>): number {
  let score = 0;
  for (const [tok, qCount] of queryTokens) {
    const fCount = fileTokens.get(tok) ?? 0;
    if (fCount > 0) score += Math.min(qCount, 2) * (1 + Math.log(fCount));
  }
  return score;
}

function snippetFor(text: string, queryTokens: Map<string, number>): string {
  const lines = text.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const tok of queryTokens.keys()) {
      if (lower.includes(tok)) return line.trim().slice(0, 200);
    }
  }
  const first = lines.find((l) => l.trim().length > 0);
  return (first ?? '').trim().slice(0, 200);
}

function semanticSearchTool(
  env: CodingEnv,
  embedder: SyncEmbedder | undefined,
): ToolDefinition {
  return {
    name: 'search_code_semantic',
    description:
      'Search workspace code by MEANING, not just keywords: hybrid ranking that fuses a lexical ' +
      'scan with embedding similarity over file contents, so a query like "car handling" can find ' +
      'the file about "automobile steering". With no embedder configured it degrades to ' +
      'lexical-only ranking and says so in the result (mode: "lexical-only").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of the code you are looking for' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(env.opts.workspaceDir, ctx);
      const root = resolve(ws);
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('search_code_semantic: "query" must not be empty');
      const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_SEMANTIC_LIMIT;
      const limit = Math.min(MAX_SEMANTIC_LIMIT, Math.max(1, limitRaw));

      // On-demand scan with an mtime-keyed in-memory cache.
      const all: string[] = [];
      walkFiles(root, all);
      let cache = semanticIndexCache.get(root);
      if (!cache) {
        cache = new Map();
        semanticIndexCache.set(root, cache);
      }
      const seen = new Set<string>();
      const entries: SemanticIndexEntry[] = [];
      for (const abs of all.slice(0, MAX_SEMANTIC_FILES * 4)) {
        if (entries.length >= MAX_SEMANTIC_FILES) break;
        if (isBinaryFile(abs)) continue;
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        const rel = wsRelative(ws, abs).split(sep).join('/');
        seen.add(rel);
        const cached = cache.get(rel);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          entries.push(cached);
          continue;
        }
        let text: string;
        try {
          text = readFileSync(abs, 'utf8').slice(0, MAX_SEMANTIC_FILE_CHARS);
        } catch {
          continue;
        }
        const entry: SemanticIndexEntry = { rel, mtimeMs: st.mtimeMs, size: st.size, text };
        cache.set(rel, entry);
        entries.push(entry);
      }
      for (const rel of [...cache.keys()]) {
        if (!seen.has(rel)) cache.delete(rel);
      }

      const queryTokens = lexicalTokens(query);
      const scored = entries.map((entry) => ({
        entry,
        lexical: lexicalScore(queryTokens, lexicalTokens(`${entry.rel} ${entry.text}`)),
      }));

      // Embedding leg (skipped entirely with no embedder configured).
      let semanticScores: Map<string, number> | null = null;
      let embedderName: string | undefined;
      if (embedder) {
        try {
          const needEmbed = entries.filter((e) => !e.vector || e.vectorEmbedder !== embedder.name);
          if (needEmbed.length > 0) {
            const vectors = await embedder.embed(needEmbed.map((e) => `${e.rel}\n${e.text}`));
            needEmbed.forEach((e, i) => {
              e.vector = vectors[i];
              e.vectorEmbedder = embedder.name;
            });
          }
          const [queryVector] = await embedder.embed([query]);
          if (queryVector) {
            semanticScores = new Map(
              entries.map((e) => [e.rel, e.vector ? cosineSimilarity(queryVector, e.vector) : 0] as const),
            );
            embedderName = embedder.name;
          }
        } catch {
          // A failing embedder degrades to lexical-only, honestly labelled.
          semanticScores = null;
        }
      }

      const maxLexical = Math.max(1, ...scored.map((s) => s.lexical));
      const results = scored
        .map((s) => {
          const lexicalNorm = s.lexical / maxLexical;
          const semantic = semanticScores ? Math.max(0, semanticScores.get(s.entry.rel) ?? 0) : undefined;
          // Hybrid fusion: the embedding leg carries the meaning
          // signal (0.6) over normalized lexical overlap (0.4) when it
          // ran — lexical alone is the degraded mode, not the peer.
          const score = semantic !== undefined ? 0.4 * lexicalNorm + 0.6 * semantic : lexicalNorm;
          return {
            path: s.entry.rel,
            score: Number(score.toFixed(4)),
            lexicalScore: Number(s.lexical.toFixed(4)),
            ...(semantic !== undefined ? { semanticScore: Number(semantic.toFixed(4)) } : {}),
            snippet: snippetFor(s.entry.text, queryTokens),
          };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, limit);

      return {
        query,
        mode: semanticScores ? 'hybrid' : 'lexical-only',
        ...(embedderName ? { embedder: embedderName } : {}),
        ...(semanticScores
          ? {}
          : {
              note: embedder
                ? 'The configured embedder failed for this search — results are lexical-only.'
                : 'No embedder is configured for semantic code search — results are lexical-only. Configure the platform embedder to enable meaning-based ranking.',
            }),
        filesScanned: entries.length,
        results,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// LSP tools (CA-9) — backed by the managed fleet in src/lsp/.
//
// The previous implementation spawned `typescript-language-server` fresh
// for every request and supported definition/hover only. These tools go
// through LspManager: persistent per-root servers for TS/JS, Python, Go
// and Rust (+ config-extensible registry), lazy spawn, reuse, idle
// shutdown, and graceful degradation — an unavailable server yields
// { degraded: true, error } and NEVER throws the turn.
// ---------------------------------------------------------------------------

function lspPositionParams(args: Record<string, unknown>): { line: number; character: number } {
  return { line: Number(args.line), character: Number(args.character) };
}

function normalizeLocations(result: unknown): { uri?: string; line?: number; character?: number }[] {
  const raw = result as
    | { uri?: string; targetUri?: string; range?: { start?: { line?: number; character?: number } }; targetSelectionRange?: { start?: { line?: number; character?: number } } }
    | null;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((l) => ({
    uri: l.uri ?? l.targetUri,
    line: l.range?.start?.line ?? l.targetSelectionRange?.start?.line,
    character: l.range?.start?.character ?? l.targetSelectionRange?.start?.character,
  }));
}

function lspDefinitionTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'lsp_definition',
    description:
      'Go-to-definition via the workspace language server (TypeScript/JavaScript, Python, ' +
      'Go, Rust — managed fleet). Returns { degraded: true } when no language server is ' +
      'available — never throws.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        line: { type: 'number', description: '0-based line number' },
        character: { type: 'number', description: '0-based character offset' },
      },
      required: ['path', 'line', 'character'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const rp = confineFor(env, ctx, String(args.path));
      const res = await env.lsp.definition(rp.root, rp.abs, lspPositionParams(args));
      if (!res.ok) return { degraded: true, error: res.unavailable };
      return { locations: normalizeLocations(res.value) };
    },
  };
}

function lspHoverTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'lsp_hover',
    description:
      'Hover type information via the workspace language server (managed fleet). ' +
      'Returns { degraded: true } when no language server is available — never throws.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        line: { type: 'number', description: '0-based line number' },
        character: { type: 'number', description: '0-based character offset' },
      },
      required: ['path', 'line', 'character'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const rp = confineFor(env, ctx, String(args.path));
      const res = await env.lsp.hover(rp.root, rp.abs, lspPositionParams(args));
      if (!res.ok) return { degraded: true, error: res.unavailable };
      const hover = res.value as { contents?: unknown } | null;
      return { contents: hover?.contents ?? null };
    },
  };
}

function lspReferencesTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'lsp_references',
    description:
      'Find all references to the symbol at a position via the workspace language ' +
      'server (managed fleet). Returns { degraded: true } when no language server ' +
      'is available — never throws.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        line: { type: 'number', description: '0-based line number' },
        character: { type: 'number', description: '0-based character offset' },
      },
      required: ['path', 'line', 'character'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const rp = confineFor(env, ctx, String(args.path));
      const res = await env.lsp.references(rp.root, rp.abs, lspPositionParams(args));
      if (!res.ok) return { degraded: true, error: res.unavailable };
      return { locations: normalizeLocations(res.value) };
    },
  };
}

const MAX_WORKSPACE_DIAGNOSTIC_FILES = 25;

function lspDiagnosticsTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'lsp_diagnostics',
    description:
      'Diagnostics (errors/warnings) from the workspace language servers. With a ' +
      'path: diagnostics for that file. Without: scans workspace files served by a ' +
      'language server (capped) and reports the files that have diagnostics. ' +
      'Returns { degraded: true } when no language server is available — never throws.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path (optional)' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (typeof args.path === 'string' && args.path) {
        const rp = confineFor(env, ctx, args.path);
        const res = await env.lsp.getDiagnostics(rp.root, rp.abs);
        if (!res.ok) return { degraded: true, error: res.unavailable };
        return { diagnostics: [summarizeDiagnostics(displayPath(rp), res.value)] };
      }
      // Workspace mode: every root, files a server can serve, capped.
      const summaries: ReturnType<typeof summarizeDiagnostics>[] = [];
      let filesChecked = 0;
      let unavailable: string | null = null;
      outer: for (const root of rootsFor(env, ctx)) {
        const all: string[] = [];
        collectFiles(root, false, all);
        for (const abs of all) {
          if (filesChecked >= MAX_WORKSPACE_DIAGNOSTIC_FILES) break outer;
          if (!env.lsp.supportsFile(root, abs)) continue;
          filesChecked += 1;
          const res = await env.lsp.getDiagnostics(root, abs);
          if (!res.ok) {
            unavailable = res.unavailable;
            continue;
          }
          const rel = wsRelative(root, abs).split(sep).join('/');
          const display = root === rootsFor(env, ctx)[0] ? rel : `${basename(root)}/${rel}`;
          const summary = summarizeDiagnostics(display, res.value);
          if (summary.total > 0) summaries.push(summary);
        }
      }
      if (filesChecked === 0) {
        return { degraded: true, error: 'no files in this workspace are served by a configured language server' };
      }
      if (summaries.length === 0 && unavailable) {
        return { degraded: true, error: unavailable };
      }
      return { diagnostics: summaries, filesChecked };
    },
  };
}

// ---------------------------------------------------------------------------
// add_workspace_dir (CA-26)
// ---------------------------------------------------------------------------

function addWorkspaceDirTool(env: CodingEnv): ToolDefinition {
  return {
    name: 'add_workspace_dir',
    mutating: true,
    description:
      'Add an extra workspace root to THIS session (multi-root, CA-26). Coding tools ' +
      'then resolve paths against the primary workspace plus every added root; each ' +
      'root confines paths to itself — a path escaping all roots is still refused. ' +
      'Use for monorepo-plus-sibling-repo work in one session.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to add (absolute, or relative to the primary workspace)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const primary = resolveWorkspaceDir(env.opts.workspaceDir, ctx);
      const raw = String(args.path ?? '');
      if (!raw) throw new Error('add_workspace_dir: "path" must not be empty');
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(primary, raw);
      let st;
      try {
        st = statSync(abs);
      } catch {
        throw new Error(`add_workspace_dir: directory does not exist: "${raw}"`);
      }
      if (!st.isDirectory()) throw new Error(`add_workspace_dir: not a directory: "${raw}"`);
      const roots = rootsFor(env, ctx);
      if (!roots.includes(abs)) env.state.addedRoots.push(abs);
      return { added: abs, roots: rootsFor(env, ctx) };
    },
  };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Build the coding tool set, confined to `workspaceDir` (plus any extra
 * roots — CA-26). Returned tools are plain ToolDefinitions; the tool
 * registry applies governance (deny-by-default / approvals) exactly as
 * for built-in tools. `opts.embedder` (optional) powers
 * `search_code_semantic`'s semantic leg; without it that tool runs
 * lexical-only (#60).
 *
 * The tool set owns an LspManager (CA-9) unless the host passes its own
 * via `opts.lspManager` — hosts that do should dispose it at shutdown;
 * factory-created managers idle-shutdown their servers automatically.
 */
export function createCodingTools(opts: CodingToolsOptions): ToolDefinition[] {
  const env: CodingEnv = {
    opts,
    state: createMultiRootState(),
    lsp: opts.lspManager ?? new LspManager(opts.lsp),
  };
  const confineFn = (ws: string, p: string) => confineAny(effectiveRoots(ws, opts, env.state, undefined), p).abs;
  return [
    patchTool(env),
    editTool(env),
    globTool(env),
    grepTool(env),
    semanticSearchTool(env, opts.embedder),
    lspDefinitionTool(env),
    lspHoverTool(env),
    lspReferencesTool(env),
    lspDiagnosticsTool(env),
    notebookReadTool(opts.workspaceDir, confineFn),
    notebookEditTool(opts.workspaceDir, confineFn),
    addWorkspaceDirTool(env),
  ];
}

// Re-exported for unit tests (pure functions).
export const __test__ = { parseUnifiedDiff, applyHunks, globToRegExp, confine, confineAny, effectiveRoots };
