// SPDX-License-Identifier: Apache-2.0
// Markdown parsing for the TUI (#186): turns assistant message text into
// renderable blocks (headings, paragraphs, fenced code, lists, quotes)
// with inline spans (bold, italic, code, links). Links keep their URL so
// the renderer can show styled text + the target. Pure functions — the
// Ink component (components/MarkdownText.tsx) is a thin skin over these.

export interface InlineSpan {
  text: string;
  style: 'text' | 'bold' | 'italic' | 'code' | 'link';
  /** Link target, only for style 'link'. */
  href?: string;
}

export type MarkdownBlock =
  | { kind: 'heading'; level: number; spans: InlineSpan[] }
  | { kind: 'paragraph'; spans: InlineSpan[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'list'; items: InlineSpan[][] }
  | { kind: 'quote'; spans: InlineSpan[] }
  | { kind: 'rule' };

/** Parse inline spans within one line. Unmatched markers stay literal. */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const push = (t: string, style: InlineSpan['style'], href?: string) => {
    if (!t) return;
    const last = spans[spans.length - 1];
    if (last && last.style === style && last.href === href) last.text += t;
    else spans.push({ text: t, style, ...(href ? { href } : {}) });
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      push(m[1]!, 'code');
      i += m[0].length;
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest)) || (m = /^__([^_]+)__/.exec(rest))) {
      push(m[1]!, 'bold');
      i += m[0].length;
    } else if ((m = /^\*([^*]+)\*/.exec(rest)) || (m = /^_([^_]+)_/.exec(rest))) {
      push(m[1]!, 'italic');
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      push(m[1]!, 'link', m[2]!);
      i += m[0].length;
    } else if ((m = /^https?:\/\/[^\s)]+/.exec(rest))) {
      push(m[0], 'link', m[0]);
      i += m[0].length;
    } else {
      push(text[i]!, 'text');
      i += 1;
    }
  }
  return spans;
}

/** Parse a markdown document into blocks. Total: arbitrary model output cannot throw here. */
export function parseMarkdown(md: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = String(md ?? '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\S*)\s*$/.exec(line.trim());
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push({ kind: 'code', lang: fence[1] ?? '', code: codeLines.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2]!) });
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', spans: parseInline(quoteLines.join(' ')) });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const items: InlineSpan[][] = [];
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]!) || /^\s*\d+[.)]\s+/.test(lines[i]!))) {
        items.push(parseInline(lines[i]!.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')));
        i += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    // Paragraph: gather until a blank line or another block start.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(para.join(' ')) });
  }
  return blocks;
}
