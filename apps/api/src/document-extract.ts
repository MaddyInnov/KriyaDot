// SPDX-License-Identifier: Apache-2.0
// Local document text extraction for chat attachments.
// Pure-JS, no cloud APIs, no native modules:
//   PDF  → pdfjs-dist (per-page text)
//   DOCX → fflate unzip + <w:t> text runs
//   PPTX → fflate unzip + <a:t> text runs per slide
//   XLSX → fflate unzip + shared strings + sheet XML → markdown tables
// Extracted text is capped (100KB) for chat-context injection.

import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

export const EXTRACT_TEXT_CAP = 100_000; // chars injected into chat context
const MAX_PDF_PAGES = 200;
const MAX_XLSX_SHEETS = 50;
const MAX_XLSX_ROWS_PER_SHEET = 1000;

export interface ExtractResult {
  /** Extracted plain text (capped). Empty string when nothing extractable. */
  text: string;
  /** True when text was truncated to the cap. */
  truncated: boolean;
  /** Human unit count, e.g. pages or sheets. */
  units?: number;
  /** Unit label: 'pages' | 'slides' | 'sheets'. */
  unitLabel?: string;
  /** Machine-readable kind. */
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text' | 'unsupported';
}

/** Decode XML entities in OOXML text runs. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Unzip an OOXML package (docx/pptx/xlsx) into name → xml string. */
function unzipXml(data: Uint8Array): Record<string, string> {
  const files = unzipSync(data);
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      try {
        out[name] = strFromU8(bytes);
      } catch {
        // skip undecodable entries
      }
    }
  }
  return out;
}

async function extractPdf(data: Uint8Array): Promise<ExtractResult> {
  // pdfjs-dist legacy Node build.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = data instanceof Uint8Array && !(data instanceof Buffer) ? data : new Uint8Array(data);
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const line = (tc.items as Array<{ str?: string }>)
        .map((it) => it.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (line) parts.push(line);
      await page.cleanup();
      if (parts.join('\n').length >= EXTRACT_TEXT_CAP) break;
    }
    const text = parts.join('\n');
    return {
      text: text.slice(0, EXTRACT_TEXT_CAP),
      truncated: text.length > EXTRACT_TEXT_CAP || doc.numPages > pages,
      units: doc.numPages,
      unitLabel: 'pages',
      kind: 'pdf',
    };
  } finally {
    await doc.cleanup();
  }
}

function extractDocx(data: Uint8Array): ExtractResult {
  const xml = unzipXml(data);
  const docXml = xml['word/document.xml'];
  if (!docXml) return { text: '', truncated: false, kind: 'docx' };
  // Paragraphs: split on </w:p> to preserve structure; text runs are <w:t>.
  const paragraphs = docXml.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const p of paragraphs) {
    const runs = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((m) => decodeXmlEntities(m[1]))
      .join('');
    if (runs.trim()) lines.push(runs);
    if (lines.join('\n').length >= EXTRACT_TEXT_CAP) break;
  }
  const text = lines.join('\n');
  return {
    text: text.slice(0, EXTRACT_TEXT_CAP),
    truncated: text.length > EXTRACT_TEXT_CAP,
    kind: 'docx',
  };
}

function extractPptx(data: Uint8Array): ExtractResult {
  const xml = unzipXml(data);
  const slideNames = Object.keys(xml)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      return na - nb;
    });
  const slides: string[] = [];
  for (const name of slideNames.slice(0, MAX_PDF_PAGES)) {
    const runs = [...xml[name].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => decodeXmlEntities(m[1]))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (runs) slides.push(runs);
    if (slides.join('\n\n').length >= EXTRACT_TEXT_CAP) break;
  }
  const text = slides.map((s, i) => `[Slide ${i + 1}]\n${s}`).join('\n\n');
  return {
    text: text.slice(0, EXTRACT_TEXT_CAP),
    truncated: text.length > EXTRACT_TEXT_CAP || slideNames.length > slides.length,
    units: slideNames.length,
    unitLabel: 'slides',
    kind: 'pptx',
  };
}

function extractXlsx(data: Uint8Array): ExtractResult {
  const xml = unzipXml(data);
  // Shared strings table.
  const shared: string[] = [];
  const ssXml = xml['xl/sharedStrings.xml'];
  if (ssXml) {
    for (const m of ssXml.matchAll(/<t>([\s\S]*?)<\/t>/g)) {
      shared.push(decodeXmlEntities(m[1]));
    }
  }
  const sheetNames = Object.keys(xml)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  const out: string[] = [];
  let truncated = false;
  for (const [si, name] of sheetNames.slice(0, MAX_XLSX_SHEETS).entries()) {
    const sheetXml = xml[name];
    // Rows: <row ...>...</row>, cells: <c r="A1" t="s"><v>3</v></c>
    const rows: string[][] = [];
    for (const rm of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_XLSX_ROWS_PER_SHEET) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const cm of rm[1].matchAll(/<c(\s[^>]*)?>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1] ?? '';
        const t = attrs.match(/\bt="([^"]*)"/)?.[1] ?? '';
        const inner = cm[2];
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const v = vMatch ? vMatch[1] : '';
        if (t === 's') {
          cells.push(shared[Number(v)] ?? '');
        } else if (t === 'inlineStr') {
          const tMatch = inner.match(/<t>([\s\S]*?)<\/t>/);
          cells.push(tMatch ? decodeXmlEntities(tMatch[1]) : '');
        } else {
          cells.push(v);
        }
      }
      // Trim trailing empty cells.
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) rows.push(cells);
    }
    if (rows.length) {
      const table = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
      out.push(`## Sheet ${si + 1}\n${table}`);
    }
    if (out.join('\n\n').length >= EXTRACT_TEXT_CAP) break;
  }
  const text = out.join('\n\n');
  return {
    text: text.slice(0, EXTRACT_TEXT_CAP),
    truncated: text.length > EXTRACT_TEXT_CAP || truncated || sheetNames.length > MAX_XLSX_SHEETS,
    units: sheetNames.length,
    unitLabel: 'sheets',
    kind: 'xlsx',
  };
}

/** Detect document kind from mime type and file name. */
export function detectDocKind(mimeType: string, fileName: string): ExtractResult['kind'] {
  const mt = mimeType.toLowerCase();
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') return 'docx';
  if (mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || ext === 'pptx') return 'pptx';
  if (mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || ext === 'xlsx') return 'xlsx';
  if (mt.startsWith('text/') || ['txt', 'md', 'json', 'csv', 'log'].includes(ext)) return 'text';
  return 'unsupported';
}

/**
 * Extract text from a document file on disk.
 * Never throws — returns { kind: 'unsupported', text: '' } on any failure.
 */
export async function extractDocumentText(
  absPath: string,
  mimeType: string,
  fileName: string,
): Promise<ExtractResult> {
  const kind = detectDocKind(mimeType, fileName);
  try {
    if (kind === 'text') {
      const text = readFileSync(absPath, 'utf8');
      return {
        text: text.slice(0, EXTRACT_TEXT_CAP),
        truncated: text.length > EXTRACT_TEXT_CAP,
        kind: 'text',
      };
    }
    const data = new Uint8Array(readFileSync(absPath));
    if (kind === 'pdf') return await extractPdf(data);
    if (kind === 'docx') return extractDocx(data);
    if (kind === 'pptx') return extractPptx(data);
    if (kind === 'xlsx') return extractXlsx(data);
    return { text: '', truncated: false, kind: 'unsupported' };
  } catch {
    return { text: '', truncated: false, kind };
  }
}
