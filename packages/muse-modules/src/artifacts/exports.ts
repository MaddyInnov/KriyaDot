// SPDX-License-Identifier: Apache-2.0
// Artifact export formats (Muse parity, P3-E; OOXML added for FL-1/FL-2).
//
// ArtifactStore keeps versioned markdown. This module turns a markdown
// artifact into shippable formats with zero dependencies and zero paid APIs:
//   - html: self-contained web page (web artifact) with inline CSS
//   - csv:  first markdown table → CSV (spreadsheet interchange)
//   - pdf:  hand-rolled, typeset PDF 1.4 (document export; see PDF section)
//   - docx: real Word document (see ./docx.ts)
//   - xlsx: real workbook, one sheet per markdown table (see ./xlsx.ts)
// PPTX for slide decks lives in ./pptx.ts (exportDeckPptx).
// All renderers are pure functions over strings/bytes, so they are cheaply
// unit-testable and never touch the network.

import { ValidationError } from '../errors.js';
import { parseInline, parseMarkdown, plainText } from './markdown.js';
import { renderArtifactDocx } from './docx.js';
import { renderArtifactXlsx } from './xlsx.js';
import type { Artifact } from './index.js';

export type ArtifactExportFormat = 'html' | 'csv' | 'pdf' | 'docx' | 'xlsx';

export const ARTIFACT_EXPORT_FORMATS: ArtifactExportFormat[] = ['html', 'csv', 'pdf', 'docx', 'xlsx'];

/** Minimal HTML escaping. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline markdown (bold/italic/code/links) → HTML. Order matters. */
function inlineMd(s: string): string {
  let out = escHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

/** Split a markdown table row into cells. */
function splitRow(line: string): string[] {
  const t = line.trim();
  const inner = t.startsWith('|') && t.endsWith('|') ? t.slice(1, -1) : t;
  return inner.split('|').map((c) => c.trim());
}

function isDelimRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Render a markdown artifact as a self-contained HTML page (inline CSS, no
 * external assets). Supports headings, paragraphs, lists, code blocks,
 * blockquotes, tables, and inline bold/italic/code/links.
 */
export function renderArtifactHtml(artifact: Artifact): string {
  const lines = artifact.content.split('\n');
  const html: string[] = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  let tableRows: string[][] = [];

  const closeList = (): void => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };
  const closeTable = (): void => {
    if (inTable) {
      html.push('</tbody></table>');
      inTable = false;
      tableRows = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      closeList();
      closeTable();
      inCode = !inCode;
      html.push(inCode ? '<pre><code>' : '</code></pre>');
      continue;
    }
    if (inCode) {
      html.push(escHtml(line));
      continue;
    }
    // Table: header row followed by a delimiter row.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isDelimRow(splitRow(lines[i + 1]))
    ) {
      closeList();
      const header = splitRow(line);
      html.push('<table><thead><tr>' + header.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>');
      inTable = true;
      tableRows = [header];
      i++; // consume the delimiter row
      continue;
    }
    if (inTable && line.includes('|')) {
      tableRows.push(splitRow(line));
      const cells = splitRow(line);
      html.push('<tr>' + cells.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      closeList();
      html.push(`<blockquote>${inlineMd(bq[1])}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  closeTable();
  if (inCode) html.push('</code></pre>');

  const title = escHtml(artifact.title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.6}
h1,h2,h3{line-height:1.25}
code{background:#f3f4f6;padding:.1em .3em;border-radius:4px;font-size:.9em}
pre{background:#111827;color:#e5e7eb;padding:1rem;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
blockquote{border-left:3px solid #d1d5db;margin:1em 0;padding:.2em 1em;color:#4b5563}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #d1d5db;padding:.5rem;text-align:left}
th{background:#f9fafb}
.meta{color:#6b7280;font-size:.85rem;margin-bottom:1.5rem}
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">Exported from KriyaDot &middot; v${artifact.version} &middot; ${new Date(artifact.updatedAt).toISOString()}</div>
${html.join('\n')}
</body>
</html>`;
}

/** Quote one CSV field per RFC 4180. */
function csvField(s: string): string {
  const v = s.replace(/`/g, '').trim();
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Extract the FIRST markdown table from the artifact and render it as CSV.
 * Throws ValidationError when the artifact contains no table.
 */
export function renderArtifactCsv(artifact: Artifact): string {
  const lines = artifact.content.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && isDelimRow(splitRow(lines[i + 1]))) {
      const rows: string[][] = [splitRow(lines[i])];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|')) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
    }
  }
  throw new ValidationError('artifact contains no markdown table to export as CSV');
}

// ---------------------------------------------------------------------------
// Hand-rolled PDF writer (PDF 1.4, no dependencies), improved typesetting:
//   - 56pt margins on letter pages, 500pt text column
//   - four base-14 fonts: Helvetica, Helvetica-Bold, Helvetica-Oblique,
//     Courier (code blocks, shaded, 9pt)
//   - title 20pt bold, headings 16/14/12.5pt bold with space before,
//     body 11pt with 1.35 leading, paragraph spacing, bullet/numbered
//     lists with hanging prefixes, tables as bold-header ruled text rows
//   - footer on every page: artifact title (left) + "Page X of Y" (right)
// No stronger in-repo PDF path exists to reuse: the Pages pipeline renders
// HTML, and apps/api's document-extract only *reads* PDFs (pdfjs). Keeping
// this writer dependency-free preserves the module's zero-dep contract.
// ---------------------------------------------------------------------------

const PDF_CHAR_MAP: Record<string, string> = {
  '•': '-',
  '–': '-',
  '—': '-',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '→': '->',
  '←': '<-',
  '₹': 'Rs.',
  '€': 'EUR',
  '£': 'GBP',
};

function pdfEscape(s: string): string {
  // PDF text strings are latin-1; map common punctuation, '?' the rest.
  return s
    .split('')
    .map((ch) => {
      if (PDF_CHAR_MAP[ch] !== undefined) return PDF_CHAR_MAP[ch];
      const code = ch.codePointAt(0) ?? 63;
      return code > 255 ? '?' : ch;
    })
    .join('')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Word-wrap one logical line into display lines of at most maxChars. */
function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const words = line.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (w.length > maxChars) {
      if (cur) out.push(cur);
      for (let k = 0; k < w.length; k += maxChars) out.push(w.slice(k, k + maxChars));
      cur = '';
    } else if ((cur + ' ' + w).trim().length > maxChars && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [''];
}

type PdfFont = 'F1' | 'F2' | 'F3' | 'F4';
interface PdfLine {
  text: string;
  size: number;
  font: PdfFont;
  indent?: number;
  spaceBefore?: number;
  shade?: boolean;
}

/** Approx character budget for a font size: Helvetica averages ~0.5em. */
function charsFor(size: number, font: PdfFont, indent = 0): number {
  const perChar = font === 'F3' ? size * 0.6 : size * (font === 'F2' ? 0.53 : 0.5);
  return Math.max(10, Math.floor((500 - indent) / perChar));
}

function pdfLinesForArtifact(artifact: Artifact): PdfLine[] {
  const lines: PdfLine[] = [
    { text: artifact.title, size: 20, font: 'F2' },
    { text: '', size: 8, font: 'F1' },
  ];
  const pushWrapped = (
    text: string,
    size: number,
    font: PdfFont,
    opts: { indent?: number; prefix?: string; shade?: boolean; spaceBefore?: number } = {},
  ): void => {
    const prefix = opts.prefix ?? '';
    const budget = charsFor(size, font, opts.indent ?? 0) - prefix.length;
    const wrapped = wrapLine(text, Math.max(10, budget));
    wrapped.forEach((w, idx) => {
      lines.push({
        text: (idx === 0 ? prefix : ' '.repeat(prefix.length)) + w,
        size,
        font,
        indent: opts.indent,
        shade: opts.shade,
        spaceBefore: idx === 0 ? opts.spaceBefore : undefined,
      });
    });
  };

  for (const block of parseMarkdown(artifact.content)) {
    switch (block.kind) {
      case 'heading': {
        const size = block.level === 1 ? 16 : block.level === 2 ? 14 : 12.5;
        pushWrapped(block.text, size, 'F2', { spaceBefore: 10 });
        break;
      }
      case 'paragraph':
        pushWrapped(block.text, 11, 'F1', { spaceBefore: 4 });
        break;
      case 'quote':
        pushWrapped(block.text, 11, 'F4', { indent: 18, spaceBefore: 4 });
        break;
      case 'list':
        block.items.forEach((item, idx) => {
          pushWrapped(item.text, 11, 'F1', {
            indent: 14,
            prefix: block.ordered ? `${idx + 1}. ` : '- ',
          });
        });
        lines.push({ text: '', size: 5, font: 'F1' });
        break;
      case 'code':
        for (const raw of block.text.split('\n')) {
          for (const chunk of wrapLine(raw, charsFor(9, 'F3'))) {
            lines.push({ text: chunk || ' ', size: 9, font: 'F3', indent: 8, shade: true });
          }
        }
        lines.push({ text: '', size: 5, font: 'F1' });
        break;
      case 'table':
        block.rows.forEach((row, ri) => {
          pushWrapped(row.map((c) => plainText(parseInline(c))).join('  |  '), 10.5, ri === 0 ? 'F2' : 'F1', {
            spaceBefore: ri === 0 ? 6 : undefined,
          });
        });
        lines.push({ text: '', size: 5, font: 'F1' });
        break;
      case 'rule':
        lines.push({ text: '-'.repeat(72), size: 9, font: 'F1', spaceBefore: 6 });
        break;
    }
  }
  return lines;
}

/** Render the artifact as typeset PDF bytes (Uint8Array). */
export function renderArtifactPdf(artifact: Artifact): Uint8Array {
  const MARGIN = 56;
  const TOP = 792 - MARGIN;
  const BOTTOM = MARGIN + 14; // keep clear of the footer at y=32

  interface PlacedLine extends PdfLine {
    y: number;
  }
  const pages: PlacedLine[][] = [[]];
  let y = TOP;
  for (const ln of pdfLinesForArtifact(artifact)) {
    const lh = ln.size * 1.35;
    let need = lh + (ln.spaceBefore ?? 0);
    if (y - need < BOTTOM && pages[pages.length - 1]!.length > 0) {
      pages.push([]);
      y = TOP;
      need = lh; // no leading space at the top of a fresh page
    }
    y -= ln.spaceBefore && pages[pages.length - 1]!.length > 0 ? ln.spaceBefore : 0;
    y -= lh;
    pages[pages.length - 1]!.push({ ...ln, y });
  }

  const FONT_BASE: Record<PdfFont, string> = {
    F1: 'Helvetica',
    F2: 'Helvetica-Bold',
    F3: 'Courier',
    F4: 'Helvetica-Oblique',
  };
  const fontObjStart = 3 + pages.length * 2;
  const fontObj = (f: PdfFont): number => fontObjStart + (['F1', 'F2', 'F3', 'F4'] as PdfFont[]).indexOf(f);
  const fontRes = (['F1', 'F2', 'F3', 'F4'] as PdfFont[])
    .map((f) => `/${f} ${fontObj(f)} 0 R`)
    .join(' ');

  const objects: Array<{ id: number; body: string }> = [];
  const pageObjNums: number[] = [];
  let nextObj = 3;
  pages.forEach((page, pageIdx) => {
    const pageObj = nextObj++;
    const contentObj = nextObj++;
    pageObjNums.push(pageObj);
    const ops: string[] = [];
    for (const ln of page) {
      const x = MARGIN + (ln.indent ?? 0);
      if (ln.shade) {
        ops.push(`0.93 g ${MARGIN} ${(ln.y - 2.5).toFixed(1)} 500 ${(ln.size * 1.35).toFixed(1)} re f 0 g`);
      }
      if (ln.text) {
        ops.push(`BT /${ln.font} ${ln.size} Tf ${x.toFixed(1)} ${ln.y.toFixed(1)} Td (${pdfEscape(ln.text)}) Tj ET`);
      }
    }
    // Footer: title left, page number right, 8pt gray.
    const footerTitle = artifact.title.length > 60 ? artifact.title.slice(0, 57) + '...' : artifact.title;
    ops.push(`BT /F1 8 Tf 0.45 g ${MARGIN} 32 Td (${pdfEscape(footerTitle)}) Tj ET`);
    const pageLabel = `Page ${pageIdx + 1} of ${pages.length}`;
    ops.push(`BT /F1 8 Tf 0.45 g ${(612 - MARGIN - pageLabel.length * 4.2).toFixed(1)} 32 Td (${pageLabel}) Tj ET`);
    const stream = ops.join('\n');
    objects.push(
      {
        id: pageObj,
        body: `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fontRes} >> >> /Contents ${contentObj} 0 R >>\nendobj\n`,
      },
      {
        id: contentObj,
        body: `${contentObj} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`,
      },
    );
  });
  for (const f of ['F1', 'F2', 'F3', 'F4'] as PdfFont[]) {
    const id = fontObj(f);
    objects.push({
      id,
      body: `${id} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_BASE[f]} >>\nendobj\n`,
    });
  }

  const header = '%PDF-1.4\n';
  const catalog = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  const pagesObj =
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>\nendobj\n`;
  const totalObjs = fontObj('F4');
  const byId = new Map(objects.map((o) => [o.id, o.body]));
  const parts = [header, catalog, pagesObj];
  for (let n = 3; n <= totalObjs; n++) parts.push(byId.get(n)!);

  const offsets = new Map<number, number>();
  let pos = 0;
  const latin1len = (s: string): number => Buffer.byteLength(s, 'latin1');
  offsets.set(1, latin1len(header));
  pos = latin1len(header) + latin1len(catalog);
  offsets.set(2, offsets.get(1)! + latin1len(catalog));
  pos = offsets.get(2)! + latin1len(pagesObj);
  for (let n = 3; n <= totalObjs; n++) {
    offsets.set(n, pos);
    pos += latin1len(byId.get(n)!);
  }
  const xrefPos = pos;
  let xrefBody = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    xrefBody += `${String(offsets.get(n) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(parts.join('') + xrefBody + trailer, 'latin1'));
}

/**
 * Export an artifact in the requested format. Returns bytes plus the
 * content type and a suggested filename for the HTTP layer.
 */
export function exportArtifact(
  artifact: Artifact,
  format: ArtifactExportFormat,
): { bytes: Uint8Array; contentType: string; filename: string } {
  const slug = artifact.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'artifact';
  switch (format) {
    case 'html': {
      const html = renderArtifactHtml(artifact);
      return {
        bytes: new Uint8Array(Buffer.from(html, 'utf8')),
        contentType: 'text/html; charset=utf-8',
        filename: `${slug}.html`,
      };
    }
    case 'csv': {
      const csv = renderArtifactCsv(artifact);
      return {
        bytes: new Uint8Array(Buffer.from(csv, 'utf8')),
        contentType: 'text/csv; charset=utf-8',
        filename: `${slug}.csv`,
      };
    }
    case 'pdf': {
      return {
        bytes: renderArtifactPdf(artifact),
        contentType: 'application/pdf',
        filename: `${slug}.pdf`,
      };
    }
    case 'docx': {
      return {
        bytes: renderArtifactDocx(artifact),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: `${slug}.docx`,
      };
    }
    case 'xlsx': {
      return {
        bytes: renderArtifactXlsx(artifact),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${slug}.xlsx`,
      };
    }
    default:
      throw new ValidationError(
        `unknown export format: ${String(format)} (want html | csv | pdf | docx | xlsx)`,
      );
  }
}
