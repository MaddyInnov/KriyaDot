// SPDX-License-Identifier: Apache-2.0
// Lightweight markdown → ANSI renderer for terminal surfaces (#31).
//
// Hand-rolled and dependency-free (the CLI deliberately carries no
// markdown/ANSI dependency): block parsing for headings, fenced code,
// lists, blockquotes and rules, plus inline spans for **bold**, *italic*,
// `code`, ~~strike~~ and [links](url) rendered as "text (url)". Anything
// unrecognized passes through as plain text, so arbitrary model output
// can never crash the renderer. Set { color: false } (or NO_COLOR) for a
// plain-text rendering with the same structure minus the escapes.

export interface MarkdownRenderOptions {
  /** Emit ANSI styling. Default: true unless NO_COLOR is set. */
  color?: boolean;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const MAGENTA = `${ESC}35m`;

interface Styler {
  on: boolean;
  wrap(code: string, text: string): string;
}

function makeStyler(on: boolean): Styler {
  return {
    on,
    wrap: (code, text) => (on && text ? `${code}${text}${RESET}` : text),
  };
}

/** Render inline spans within one line of text. */
export function renderInline(text: string, s: Styler): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      out += s.wrap(YELLOW, m[1]!);
      i += m[0].length;
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest)) || (m = /^__([^_]+)__/.exec(rest))) {
      out += s.wrap(BOLD, renderInline(m[1]!, s));
      i += m[0].length;
    } else if ((m = /^\*([^*]+)\*/.exec(rest)) || (m = /^_([^_]+)_/.exec(rest))) {
      out += s.wrap(ITALIC, renderInline(m[1]!, s));
      i += m[0].length;
    } else if ((m = /^~~([^~]+)~~/.exec(rest))) {
      out += s.on ? `${ESC}9m${m[1]}${RESET}` : m[1]!;
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      // Links render as styled text + the URL in dim parentheses.
      out += `${s.wrap(`${UNDERLINE}${CYAN}`, m[1]!)} ${s.wrap(DIM, `(${m[2]})`)}`;
      i += m[0].length;
    } else if ((m = /^https?:\/\/[^\s)]+/.exec(rest))) {
      out += s.wrap(`${UNDERLINE}${CYAN}`, m[0]);
      i += m[0].length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Very small code-fence highlighter: comments dim, strings green, numbers magenta. */
export function highlightCodeLine(line: string, s: Styler): string {
  if (!s.on) return line;
  if (/^\s*(#|\/\/)/.test(line)) return s.wrap(DIM, line);
  return line
    .replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, (q) => `${GREEN}${q}${RESET}`)
    .replace(/\b(\d+(?:\.\d+)?)\b/g, (n) => `${MAGENTA}${n}${RESET}`);
}

/** Render a markdown document to a terminal string (no trailing newline added). */
export function renderMarkdown(md: string, opts: MarkdownRenderOptions = {}): string {
  const color = opts.color ?? !process.env.NO_COLOR;
  const s = makeStyler(color);
  const lines = String(md ?? '').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLang = '';
  for (const line of lines) {
    const fence = /^```(\S*)\s*$/.exec(line.trim());
    if (fence) {
      if (inFence) {
        out.push(s.wrap(DIM, '```'));
        inFence = false;
        fenceLang = '';
      } else {
        inFence = true;
        fenceLang = fence[1] ?? '';
        out.push(s.wrap(DIM, fenceLang ? `\`\`\`${fenceLang}` : '```'));
      }
      continue;
    }
    if (inFence) {
      out.push(highlightCodeLine(line, s));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = renderInline(heading[2]!, s);
      out.push(level <= 2 ? s.wrap(`${BOLD}${CYAN}`, text) : s.wrap(BOLD, text));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(s.wrap(DIM, '─'.repeat(40)));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`${s.wrap(DIM, '│ ')}${s.wrap(ITALIC, renderInline(quote[1]!, s))}`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}${s.wrap(CYAN, '•')} ${renderInline(bullet[2]!, s)}`);
      continue;
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(`${numbered[1]}${s.wrap(CYAN, `${numbered[2]}.`)} ${renderInline(numbered[3]!, s)}`);
      continue;
    }
    out.push(renderInline(line, s));
  }
  if (inFence) out.push(s.wrap(DIM, '```'));
  return out.join('\n');
}

/** True when the text contains markdown markers worth rendering. */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)#{1,6}\s|```|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|(^|\n)>\s|(^|\n)\s*[-*+]\s/.test(text);
}
