// SPDX-License-Identifier: Apache-2.0
// .gitignore / .kriyadotignore awareness for the coding file tools (CA-11).
//
// A deliberately small, dependency-free implementation of the gitignore
// pattern semantics the file tools need:
//   - blank lines and `#` comments (a leading `\#` / `\!` escapes the marker)
//   - `!pattern` negation (a later rule wins over an earlier one)
//   - trailing `/` = directories only
//   - a pattern with no slash (other than a trailing one) matches the
//     basename at any depth; a pattern with a slash is anchored to the
//     directory containing the ignore file
//   - `*` (no slash crossing), `?`, `[...]` character classes, `**`
//     (crosses directories; `**/` also matches zero directories)
//   - a matched directory prunes everything under it (unless a deeper
//     negation re-includes a path — handled by evaluating rules in order
//     against every path, with directory pruning only as a walk shortcut
//     when no negation could re-include anything below)
//
// Rules are loaded per directory during a walk: the workspace root's
// `.gitignore` + `.kriyadotignore`, plus any nested ones, each anchored
// to the directory that contains them.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IgnoreRule {
  /** RegExp tested against the path relative to `base` ('/'-separated). */
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
  /** Directory (relative to the walk root, '' = root) the rule is anchored to. */
  base: string;
  /** Raw pattern text, for debugging/tests. */
  pattern: string;
  /** True when the rule contains a `**` or could match nested paths (used to decide safe pruning). */
  hasNegationBelow?: boolean;
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Convert one gitignore pattern (already stripped of markers) to a RegExp. */
export function gitignorePatternToRegExp(pattern: string): RegExp {
  let p = pattern;
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  } else if (p.includes('/')) {
    // A slash anywhere (except trailing, already stripped) anchors the
    // pattern to the ignore file's directory.
    anchored = true;
  }
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` — crosses directory boundaries.
        if (p[i + 2] === '/') {
          re += '(?:[^/]+/)*'; // "**/" also matches zero directories
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
    } else if (c === '[') {
      // Character class, copied through (with [!...] → [^...]).
      let j = i + 1;
      let cls = '';
      if (p[j] === '!') {
        cls = '^';
        j += 1;
      }
      if (p[j] === ']') {
        cls += '\\]';
        j += 1;
      }
      while (j < p.length && p[j] !== ']') {
        cls += p[j] === '\\' ? '\\\\' : p[j];
        j += 1;
      }
      if (j >= p.length) {
        re += '\\['; // unterminated class → literal '['
        i += 1;
      } else {
        re += `[${cls}]`;
        i = j + 1;
      }
    } else {
      re += c.replace(REGEX_SPECIALS, '\\$&');
      i += 1;
    }
  }
  // Unanchored patterns match the basename at any depth.
  const body = anchored ? re : `(?:[^/]+/)*${re}`;
  // A pattern also matches everything INSIDE a matched directory.
  return new RegExp(`^${body}(?:/.*)?$`);
}

/** Parse ignore-file text into rules anchored at `base` ('' = walk root). */
export function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    // Trailing spaces are ignored unless backslash-escaped.
    line = line.replace(/(?<!\\) +$/, '');
    if (line === '') continue;
    let negated = false;
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1);
    } else if (line.startsWith('#')) {
      continue; // comment
    } else if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (line === '') continue;
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === '') continue;
    rules.push({
      regex: gitignorePatternToRegExp(line),
      negated,
      dirOnly,
      base,
      pattern: line,
    });
  }
  return rules;
}

/** Load `.gitignore` + `.kriyadotignore` from one directory, if present. */
export function loadIgnoreRules(dirAbs: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const name of ['.gitignore', '.kriyadotignore']) {
    const file = join(dirAbs, name);
    if (!existsSync(file)) continue;
    try {
      rules.push(...parseIgnoreFile(readFileSync(file, 'utf8'), base));
    } catch {
      // An unreadable ignore file must never break a walk.
    }
  }
  return rules;
}

/**
 * Ordered rule set for one walk. Rules from deeper directories are
 * appended later, so "last matching rule wins" gives nested ignore
 * files precedence over parent ones, exactly like git.
 */
export class IgnoreMatcher {
  private rules: IgnoreRule[] = [];

  constructor(rootAbs: string) {
    this.addDirectoryRules(rootAbs, '');
  }

  /** Register the ignore files found in a directory during the walk. */
  addDirectoryRules(dirAbs: string, base: string): void {
    this.rules.push(...loadIgnoreRules(dirAbs, base));
  }

  /** True when any negation rule exists (directory pruning must be careful). */
  get hasNegations(): boolean {
    return this.rules.some((r) => r.negated);
  }

  /**
   * Decide whether `relPath` ('/'-separated, relative to the walk root)
   * is ignored. Last matching rule wins.
   */
  isIgnored(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) {
        // A dir-only rule still ignores FILES under a matched directory:
        // the regex carries a `(?:/.*)?` tail, but the direct path of a
        // file whose parent dir matches must count. Handled by testing
        // the path with a trailing probe segment below.
        if (!this.matchesWithDirProbe(rule, relPath)) continue;
        ignored = !rule.negated;
        continue;
      }
      const rel = rule.base ? stripBase(relPath, rule.base) : relPath;
      if (rel === null) continue;
      if (rule.regex.test(rel)) ignored = !rule.negated;
    }
    return ignored;
  }

  private matchesWithDirProbe(rule: IgnoreRule, relPath: string): boolean {
    const rel = rule.base ? stripBase(relPath, rule.base) : relPath;
    if (rel === null) return false;
    // Probe: does any ancestor directory of this path match the rule?
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (rule.regex.test(parts.slice(0, i).join('/'))) return true;
    }
    return false;
  }
}

function stripBase(relPath: string, base: string): string | null {
  if (base === '') return relPath;
  if (relPath === base) return '';
  if (relPath.startsWith(base + '/')) return relPath.slice(base.length + 1);
  return null;
}
