// SPDX-License-Identifier: Apache-2.0
// Minimal markdown block/inline parser shared by the OOXML exporters
// (DOCX/XLSX) and available to other renderers. It intentionally covers the
// subset the artifact renderers already support: ATX headings, paragraphs,
// bullet/numbered lists, fenced code blocks, blockquotes, horizontal rules,
// GitHub-style pipe tables, and inline bold/italic/code/links. No deps.

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Link target when this run is a hyperlink. */
  link?: string;
}

export type MarkdownBlock =
  | { kind: 'heading'; level: number; runs: InlineRun[]; text: string }
  | { kind: 'paragraph'; runs: InlineRun[]; text: string }
  | { kind: 'list'; ordered: boolean; items: Array<{ runs: InlineRun[]; text: string }> }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; runs: InlineRun[]; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; rows: string[][]; heading?: string };

/** Strip inline markdown markers, returning plain text. */
export function plainText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join('');
}

/**
 * Parse inline markdown into runs. Handles `code`, **bold**, __bold__,
 * *italic*, _italic_, ***both*** and [text](url). Underscore emphasis only
 * applies at word boundaries so snake_case words stay intact.
 */
export function parseInline(src: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      runs.push({ text: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      runs.push({ text: m[1], code: true });
      i += m[0].length;
    } else if ((m = /^\*\*\*([^*]+)\*\*\*/.exec(rest)) || (m = /^___([^_]+)___/.exec(rest))) {
      flush();
      runs.push({ text: m[1], bold: true, italic: true });
      i += m[0].length;
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest)) || (m = /^__([^_]+)__/.exec(rest))) {
      flush();
      runs.push({ text: m[1], bold: true });
      i += m[0].length;
    } else if (
      (m =
        /^\*([^*\n]+)\*/.exec(rest) ??
        (i === 0 || /\s/.test(src[i - 1]!) ? /^_([^_\n]+)_/.exec(rest) : null)) !== null
    ) {
      flush();
      runs.push({ text: m[1]!, italic: true });
      i += m[0]!.length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      runs.push({ text: m[1], link: m[2] });
      i += m[0].length;
    } else {
      buf += src[i];
      i++;
    }
  }
  flush();
  return runs.length ? runs : [{ text: '' }];
}

/** Split a markdown table row into trimmed cells. */
export function splitTableRow(line: string): string[] {
  const t = line.trim();
  const inner = t.startsWith('|') && t.endsWith('|') && t.length > 1 ? t.slice(1, -1) : t;
  return inner.split('|').map((c) => c.trim());
}

export function isTableDelimRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** Parse markdown content into blocks, tracking the heading before tables. */
export function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];
  let lastHeading: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or EOF)
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const runs = parseInline(h[2]!.trim());
      lastHeading = plainText(runs);
      blocks.push({ kind: 'heading', level: h[1]!.length, runs, text: lastHeading });
      i++;
      continue;
    }

    // Table: header row followed by a delimiter row.
    if (line.includes('|') && i + 1 < lines.length && isTableDelimRow(splitTableRow(lines[i + 1]!))) {
      const rows: string[][] = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      blocks.push({ kind: 'table', rows, heading: lastHeading });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: Array<{ runs: InlineRun[]; text: string }> = [];
      while (i < lines.length) {
        const b = /^\s*[-*+]\s+(.*)$/.exec(lines[i]!);
        const n = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]!);
        const hit = ordered ? n : b;
        if (!hit) break;
        const runs = parseInline(hit[1]!);
        items.push({ runs, text: plainText(runs) });
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      const runs = parseInline(quote[1]!);
      blocks.push({ kind: 'quote', runs, text: plainText(runs) });
      i++;
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const paraLines: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('```') &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!) &&
      !(
        lines[i]!.includes('|') &&
        i + 1 < lines.length &&
        isTableDelimRow(splitTableRow(lines[i + 1]!))
      )
    ) {
      paraLines.push(lines[i]!.trim());
      i++;
    }
    const runs = parseInline(paraLines.join(' '));
    blocks.push({ kind: 'paragraph', runs, text: plainText(runs) });
  }
  return blocks;
}

export interface MarkdownTable {
  /** Preceding heading text, if any (used for XLSX sheet names). */
  heading?: string;
  rows: string[][];
}

/** Every markdown table in the content, in order. */
export function extractMarkdownTables(content: string): MarkdownTable[] {
  return parseMarkdown(content)
    .filter((b): b is Extract<MarkdownBlock, { kind: 'table' }> => b.kind === 'table')
    .map((b) => ({ heading: b.heading, rows: b.rows }));
}
