// SPDX-License-Identifier: Apache-2.0
// Generic syntax highlighting for code fences (#186): a small hand-rolled
// tokenizer shared across languages — comments, strings, numbers and a
// common keyword set (JS/TS/Python/Go/Rust overlap). No dependencies; the
// goal is readable code in the terminal, not compiler-grade parsing.
// Unterminated strings/comments simply run to the end of the input.

export type TokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'plain';

export interface CodeToken {
  text: string;
  kind: TokenKind;
}

const KEYWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'class', 'extends', 'import', 'from', 'export', 'default', 'async',
  'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'super',
  'type', 'interface', 'enum', 'implements', 'readonly', 'static', 'public', 'private', 'protected',
  'void', 'null', 'undefined', 'true', 'false',
  // Python
  'def', 'lambda', 'pass', 'raise', 'with', 'as', 'yield', 'global', 'nonlocal', 'assert', 'del',
  'elif', 'except', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'print',
  // Go / Rust / misc
  'func', 'package', 'go', 'defer', 'fn', 'mut', 'impl', 'trait', 'match', 'mod', 'pub', 'struct',
  'use', 'where', 'unsafe', 'extern', 'int', 'string', 'bool', 'char', 'double', 'float', 'long',
]);

function push(tokens: CodeToken[], text: string, kind: TokenKind): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

/** Tokenize a code block into styled spans. Pure and total: never throws. */
export function tokenizeCode(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const src = String(code ?? '');
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\/\/[^\n]*/.exec(rest)) || (m = /^#[^\n]*/.exec(rest)) || (m = /^\/\*[\s\S]*?\*\//.exec(rest))) {
      push(tokens, m[0], 'comment');
      i += m[0].length;
    } else if ((m = /^'(?:\\.|[^'\\\n])*'/.exec(rest)) || (m = /^"(?:\\.|[^"\\\n])*"/.exec(rest)) || (m = /^`(?:\\.|[^`\\])*`/.exec(rest))) {
      push(tokens, m[0], 'string');
      i += m[0].length;
    } else if ((m = /^\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/.exec(rest))) {
      push(tokens, m[0], 'number');
      i += m[0].length;
    } else if ((m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest))) {
      push(tokens, m[0], KEYWORDS.has(m[0]) ? 'keyword' : 'plain');
      i += m[0].length;
    } else {
      push(tokens, src[i]!, 'plain');
      i += 1;
    }
  }
  return tokens;
}
