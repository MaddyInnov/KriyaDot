// SPDX-License-Identifier: Apache-2.0
// Artifact export formats (Muse parity, P3-E).
//
// ArtifactStore keeps versioned markdown. This module turns a markdown
// artifact into shippable formats with zero dependencies and zero paid APIs:
//   - html: self-contained web page (web artifact) with inline CSS
//   - csv:  first markdown table → CSV (spreadsheet interchange)
//   - pdf:  hand-rolled single-font PDF 1.4 (document export)
// All renderers are pure functions over strings/bytes, so they are cheaply
// unit-testable and never touch the network.

import { ValidationError } from '../errors.js';
import type { Artifact } from './index.js';

export type ArtifactExportFormat = 'html' | 'csv' | 'pdf';

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
// Minimal PDF writer (PDF 1.4, single Helvetica font, no dependencies).
// Lays the artifact out as wrapped text lines across letter-size pages.
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
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [''];
}

/**
 * Render the artifact as PDF bytes (Uint8Array). Headings get a larger bold
 * treatment via a second font size; everything else is 11pt Helvetica.
 */
export function renderArtifactPdf(artifact: Artifact): Uint8Array {
  const lines: Array<{ text: string; size: number }> = [
    { text: artifact.title, size: 18 },
    { text: '', size: 11 },
  ];
  for (const raw of artifact.content.split('\n')) {
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) {
      lines.push({ text: '', size: 11 });
      lines.push({ text: h[2].replace(/[*_`]/g, ''), size: h[1].length === 1 ? 15 : 13 });
      continue;
    }
    const clean = raw.replace(/[*_`]/g, '').replace(/^[-*]\s+/, '• ').replace(/^>\s?/, '');
    for (const w of wrapLine(clean, 95)) {
      lines.push({ text: w, size: 11 });
    }
  }

  // Paginate: letter 612x792, 50pt margins, line height = size * 1.35.
  const pages: Array<Array<{ text: string; size: number }>> = [[]];
  let y = 742;
  for (const ln of lines) {
    const lh = ln.size * 1.35;
    if (y - lh < 50) {
      pages.push([]);
      y = 742;
    }
    pages[pages.length - 1].push(ln);
    y -= lh;
  }

  const objects: string[] = [];
  // 1: catalog, 2: pages, 3..: page + content pairs in creation order, then font.
  const pageObjNums: number[] = [];
  let nextObj = 3;
  for (const page of pages) {
    const pageObj = nextObj++;
    const contentObj = nextObj++;
    pageObjNums.push(pageObj);
    let cy = 742;
    const ops: string[] = [];
    for (const ln of page) {
      ops.push(`BT /F1 ${ln.size} Tf 50 ${cy.toFixed(1)} Td (${pdfEscape(ln.text)}) Tj ET`);
      cy -= ln.size * 1.35;
    }
    const stream = ops.join('\n');
    // Emit page dict and its content stream back-to-back so `objects` stays
    // in creation order: [page1, stream1, page2, stream2, ..., font].
    objects.push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${nextObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`,
      `${contentObj} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }
  const fontObj = nextObj++;
  objects.push(
    `${fontObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );

  const header = '%PDF-1.4\n';
  const catalog = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  const pagesObj =
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>\nendobj\n`;

  const parts = [header, catalog, pagesObj, ...objects];
  const offsets: number[] = [];
  let pos = 0;
  const latin1len = (s: string): number => Buffer.byteLength(s, 'latin1');
  for (const p of parts) {
    offsets.push(pos);
    pos += latin1len(p);
  }
  const xrefPos = pos;
  const totalObjs = fontObj; // highest object number

  // Object creation order: [page1, content1, page2, content2, ..., font].
  // parts[0] = header (no object), parts[1] = obj 1, parts[2] = obj 2,
  // parts[3 + k] = k-th created object.
  const createdOrder: number[] = [];
  {
    let n = 3;
    for (let p = 0; p < pages.length; p++) {
      createdOrder.push(n++); // page dict obj
      createdOrder.push(n++); // content stream obj
    }
    createdOrder.push(n++); // font obj
  }
  const objPos = new Map<number, number>();
  objPos.set(1, offsets[1]);
  objPos.set(2, offsets[2]);
  for (let k = 0; k < createdOrder.length; k++) {
    objPos.set(createdOrder[k], offsets[3 + k]);
  }
  let xrefBody = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    const off = objPos.get(n) ?? 0;
    xrefBody += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  const full = parts.join('') + xrefBody + trailer;
  return new Uint8Array(Buffer.from(full, 'latin1'));
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
    default:
      throw new ValidationError(`unknown export format: ${String(format)} (want html | csv | pdf)`);
  }
}
