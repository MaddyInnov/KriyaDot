// SPDX-License-Identifier: Apache-2.0
// Coding tools for the agent runtime: patch (unified diff), edit (surgical
// string replace), glob, grep, and minimal LSP hooks (definition/hover).
//
// Every tool is confined to the workspace directory (same confine() pattern
// as tools/builtin.ts): any path that resolves outside the workspace throws.
// These tools return plain ToolDefinitions and flow through the normal
// governance path (the tool registry evaluates policy before dispatch).

import { spawn, spawnSync } from 'node:child_process';
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
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';
import { confineRealpath } from '../confine.js';
import { lineHash } from './line-hash.js';
import { cosineSimilarity, type SyncEmbedder } from '../hybrid-search.js';

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

function patchTool(workspaceDir: WorkspaceSource): ToolDefinition {
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
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const diff = String(args.diff ?? '');
      const dryRun = args.dryRun === true;
      if (!diff.trim()) throw new Error('patch: "diff" must not be empty');
      const fileDiffs = parseUnifiedDiff(diff);
      const results: PatchFileResult[] = [];
      const pending: { abs: string; rel: string; lines: string[]; action: 'modified' | 'created' | 'deleted' }[] = [];

      for (const fd of fileDiffs) {
        const target = fd.newPath ?? fd.oldPath;
        if (!target) throw new Error('patch: diff has neither old nor new path');
        let rel: string;
        let abs: string;
        try {
          rel = target;
          abs = confine(ws, rel);
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
          pending.push({ abs, rel, lines: next, action });
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
      return { applied, dryRun, files: results };
    },
  };
}

// ---------------------------------------------------------------------------
// edit — surgical string replace
// ---------------------------------------------------------------------------

function editTool(workspaceDir: WorkspaceSource): ToolDefinition {
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
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const file = confine(ws, String(args.path));
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
        return {
          path: String(args.path),
          mode: 'range',
          replacements: 1,
          linesReplaced: endLine - startLine + 1,
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
      return { path: String(args.path), replacements: count };
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

function walkFiles(root: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walkFiles(abs, out);
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
}

function globTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'glob',
    description:
      'Find files in the workspace matching a glob pattern (*, ?, ** supported). ' +
      'Returns workspace-relative paths, capped at 200.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' } },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const pattern = String(args.pattern ?? '');
      if (!pattern) throw new Error('glob: "pattern" must not be empty');
      const rx = globToRegExp(pattern);
      const root = resolve(ws);
      const all: string[] = [];
      walkFiles(root, all);
      const matched = all
        .map((abs) => wsRelative(ws, abs).split(sep).join('/'))
        .filter((rel) => rx.test(rel))
        .sort()
        .slice(0, MAX_GLOB_RESULTS);
      return { pattern, matches: matched, truncated: matched.length === MAX_GLOB_RESULTS };
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

function grepTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'grep',
    description:
      'Regex content search across workspace files. Returns up to 50 matches with ' +
      'line numbers. Binary files are skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex pattern' },
        path: { type: 'string', description: 'Workspace-relative file or directory (default: workspace root)' },
        filePattern: { type: 'string', description: 'Glob filter for file paths, e.g. "*.ts"' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const pattern = String(args.pattern ?? '');
      if (!pattern) throw new Error('grep: "pattern" must not be empty');
      let rx: RegExp;
      try {
        rx = new RegExp(pattern);
      } catch (err) {
        throw new Error(`grep: invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const baseAbs = args.path === undefined ? resolve(ws) : confine(ws, String(args.path));
      const fileRx = args.filePattern === undefined ? null : globToRegExp(String(args.filePattern));

      const candidates: string[] = [];
      let st;
      try {
        st = statSync(baseAbs);
      } catch {
        throw new Error(`grep: path does not exist: "${args.path}"`);
      }
      if (st.isDirectory()) walkFiles(baseAbs, candidates);
      else candidates.push(baseAbs);

      const matches: { path: string; line: number; text: string }[] = [];
      outer: for (const abs of candidates) {
        const rel = wsRelative(ws, abs).split(sep).join('/');
        if (fileRx && !fileRx.test(rel)) continue;
        if (isBinaryFile(abs)) continue;
        let content: string;
        try {
          content = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i])) {
            matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 500) });
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
  workspaceDir: WorkspaceSource,
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
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
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
// LSP hooks — minimal hand-rolled JSON-RPC client over stdio.
// ---------------------------------------------------------------------------

const LSP_TIMEOUT_MS = 15_000;
let lspProbeCache: boolean | null = null;

/** True when `typescript-language-server --stdio` can be spawned. Cached. */
function lspAvailable(): boolean {
  if (lspProbeCache !== null) return lspProbeCache;
  try {
    const r = spawnSync('typescript-language-server', ['--version'], { timeout: 5000 });
    lspProbeCache = r.status === 0;
  } catch {
    lspProbeCache = false;
  }
  return lspProbeCache;
}

function languageIdFor(abs: string): string {
  if (abs.endsWith('.tsx')) return 'typescriptreact';
  if (abs.endsWith('.ts')) return 'typescript';
  if (abs.endsWith('.jsx')) return 'javascriptreact';
  if (abs.endsWith('.js') || abs.endsWith('.mjs') || abs.endsWith('.cjs')) return 'javascript';
  return 'plaintext';
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Run a single LSP request against a freshly spawned typescript-language-server.
 * Never throws for server absence — the tools translate that to degraded mode.
 */
async function lspRequest(
  workspaceDir: string,
  absPath: string,
  method: 'textDocument/definition' | 'textDocument/hover',
  position: { line: number; character: number },
): Promise<unknown> {
  const root = resolve(workspaceDir);
  const content = readFileSync(absPath, 'utf8');
  const uri = 'file://' + absPath;
  const languageId = languageIdFor(absPath);

  const child = spawn('typescript-language-server', ['--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let settled = false;
  let seq = 0;
  const pending = new Map<number, (v: JsonRpcResponse) => void>();
  let buffer = Buffer.alloc(0);

  const send = (msg: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
    child.stdin.write(Buffer.concat([header, body]));
  };
  const request = (m: string, params: unknown): Promise<JsonRpcResponse> =>
    new Promise((resolveRpc) => {
      const id = ++seq;
      pending.set(id, resolveRpc);
      send({ jsonrpc: '2.0', id, method: m, params });
    });

  const cleanup = () => {
    if (!settled) {
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const mLen = /Content-Length:\s*(\d+)/i.exec(header);
      if (!mLen) break;
      const len = Number(mLen[1]);
      const total = headerEnd + 4 + len;
      if (buffer.length < total) break;
      const body = buffer.subarray(headerEnd + 4, total).toString('utf8');
      buffer = buffer.subarray(total);
      try {
        const msg = JSON.parse(body) as JsonRpcResponse & { method?: string };
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
        // server->client requests/notifications (e.g. window/logMessage) are ignored
      } catch {
        /* ignore malformed frame */
      }
    }
  });
  child.on('error', () => {
    for (const [, resolveRpc] of pending) {
      resolveRpc({ id: -1, error: { code: -32000, message: 'language server process error' } });
    }
    pending.clear();
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('language server request timed out')), LSP_TIMEOUT_MS),
  );

  try {
    const result = await Promise.race([
      (async () => {
        await request('initialize', {
          processId: process.pid,
          rootUri: 'file://' + root,
          capabilities: {},
        });
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: { textDocument: { uri, languageId, version: 1, text: content } },
        });
        const resp = await request(method, {
          textDocument: { uri },
          position: { line: position.line, character: position.character },
        });
        send({ jsonrpc: '2.0', id: ++seq, method: 'shutdown', params: {} });
        send({ jsonrpc: '2.0', method: 'exit', params: {} });
        if (resp.error) throw new Error(`language server error: ${resp.error.message}`);
        return resp.result ?? null;
      })(),
      timeout,
    ]);
    return result;
  } finally {
    cleanup();
  }
}

function lspDefinitionTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'lsp_definition',
    description:
      'Go-to-definition via the TypeScript language server (if installed). ' +
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
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      if (!lspAvailable()) {
        return { degraded: true, error: 'language server not available' };
      }
      const abs = confine(ws, String(args.path));
      if (!existsSync(abs)) throw new Error(`lsp_definition: file does not exist: "${args.path}"`);
      try {
        const result = await lspRequest(ws, abs, 'textDocument/definition', {
          line: Number(args.line),
          character: Number(args.character),
        });
        const locations = Array.isArray(result) ? result : result ? [result] : [];
        return {
          locations: locations.map((l: { uri?: string; range?: { start?: { line?: number; character?: number } } }) => ({
            uri: l.uri,
            line: l.range?.start?.line,
            character: l.range?.start?.character,
          })),
        };
      } catch (err) {
        return { degraded: true, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function lspHoverTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'lsp_hover',
    description:
      'Hover type information via the TypeScript language server (if installed). ' +
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
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      if (!lspAvailable()) {
        return { degraded: true, error: 'language server not available' };
      }
      const abs = confine(ws, String(args.path));
      if (!existsSync(abs)) throw new Error(`lsp_hover: file does not exist: "${args.path}"`);
      try {
        const result = (await lspRequest(ws, abs, 'textDocument/hover', {
          line: Number(args.line),
          character: Number(args.character),
        })) as { contents?: unknown } | null;
        return { contents: result?.contents ?? null };
      } catch (err) {
        return { degraded: true, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Build the coding tool set, confined to `workspaceDir`.
 * Returned tools are plain ToolDefinitions; the tool registry applies
 * governance (deny-by-default / approvals) exactly as for built-in tools.
 * `opts.embedder` (optional) powers `search_code_semantic`'s semantic
 * leg; without it that tool runs lexical-only (#60).
 */
export function createCodingTools(opts: CodingToolsOptions): ToolDefinition[] {
  const { workspaceDir } = opts;
  return [
    patchTool(workspaceDir),
    editTool(workspaceDir),
    globTool(workspaceDir),
    grepTool(workspaceDir),
    semanticSearchTool(workspaceDir, opts.embedder),
    lspDefinitionTool(workspaceDir),
    lspHoverTool(workspaceDir),
  ];
}

// Re-exported for unit tests (pure functions).
export const __test__ = { parseUnifiedDiff, applyHunks, globToRegExp, confine };
