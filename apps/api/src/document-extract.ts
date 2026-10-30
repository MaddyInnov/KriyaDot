// SPDX-License-Identifier: Apache-2.0
// Local document text extraction for chat attachments.
// Pure-JS, no cloud APIs, no native modules:
//   PDF  → pdfjs-dist (per-page text)
//   DOCX → fflate unzip + <w:t> text runs
//   PPTX → fflate unzip + <a:t> text runs per slide
//   XLSX → fflate unzip + shared strings + sheet XML → markdown tables
// Extracted text is capped (100KB) for chat-context injection.

import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';
import { findExecutable, resolveOcrProvider, type OcrProvider } from './ocr.js';
import { parseImageMetadata } from './vision-pipeline.js';
import { detectImageContainer, UnsupportedImageFormatError } from './file-intake.js';

const execFileAsync = promisify(execFile);

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
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text' | 'image' | 'unsupported';
  /** True when the text came from OCR (image input, or a textless PDF). */
  ocr?: boolean;
  /** OCR provider name that produced the text (e.g. 'tesseract', 'http'). */
  ocrProvider?: string;
  /** §2.12 #128: parsed image metadata (dimensions/EXIF) for image inputs. */
  imageMeta?: import('./vision-pipeline.js').ImageAttachmentMetadata;
}

export interface ExtractOptions {
  /** Injected OCR provider (tests pass a fake — no real OCR, no network). */
  ocrProvider?: OcrProvider;
  /** Injected OCR provider list; chained in order. */
  ocrProviders?: OcrProvider[];
  /** Set false to skip the OCR fallback entirely. */
  ocr?: boolean;
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
 * Image inputs stay 'unsupported' in detectDocKind (legacy contract: the
 * chat pipeline only claims a kind it can extract without OCR). The OCR
 * route in extractDocumentText upgrades them to kind 'image' when a
 * provider actually produces text.
 */
export function isImageInput(mimeType: string, fileName: string): boolean {
  const mt = mimeType.toLowerCase();
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp'].includes(ext);
}

/**
 * FL-10: HEIC/AVIF uploads cannot be OCR'd or thumbnailed by this build
 * (no decoder in the dependency tree — see file-intake.ts). Returns the
 * user-facing guidance message when the bytes/name are HEIC/AVIF, else
 * null. The upload path surfaces this instead of a silent empty extract.
 */
export function unsupportedImageFormatNote(data: Uint8Array, fileName: string): string | null {
  const format = detectImageContainer(data);
  const byExt = /\.hei[cf]$/i.test(fileName) ? 'heic' : /\.avif$/i.test(fileName) ? 'avif' : format;
  if (byExt === 'heic' || byExt === 'avif') return new UnsupportedImageFormatError(byExt).message;
  return null;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
};

/**
 * Rasterize PDF pages to PNG buffers with `pdftoppm` (poppler) when the
 * binary is available. Returns [] when pdftoppm is missing or fails —
 * callers treat that as "OCR path unavailable", never an error.
 */
export async function rasterizePdfPages(
  absPath: string,
  opts?: { maxPages?: number; dpi?: number },
): Promise<Buffer[]> {
  const bin = findExecutable('pdftoppm');
  if (!bin) return [];
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-pdf-ocr-'));
  try {
    await execFileAsync(bin, [
      '-png',
      '-r',
      String(opts?.dpi ?? 200),
      '-l',
      String(opts?.maxPages ?? 20),
      absPath,
      join(dir, 'page'),
    ]);
    const names = readdirSync(dir)
      .filter((n) => n.endsWith('.png'))
      .sort();
    return names.map((n) => readFileSync(join(dir, n)));
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run OCR over image bytes; null when no provider can run. */
async function tryOcr(
  image: Buffer,
  mimeType: string,
  provider: OcrProvider,
): Promise<{ text: string; provider: string } | null> {
  try {
    if (!(await provider.isAvailable())) return null;
    const text = await provider.recognize(image, mimeType);
    const name =
      (provider as { lastProviderName?: string }).lastProviderName ?? provider.name;
    return { text, provider: name };
  } catch {
    return null;
  }
}

/**
 * Extract text from a document file on disk.
 * Never throws — returns { kind: 'unsupported', text: '' } on any failure.
 */
export async function extractDocumentText(
  absPath: string,
  mimeType: string,
  fileName: string,
  opts?: ExtractOptions,
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
    const raw = readFileSync(absPath);
    const data = new Uint8Array(raw);
    if (kind === 'unsupported' && isImageInput(mimeType, fileName)) {
      // §2.12 #128: image metadata (dimensions + EXIF orientation) is
      // parsed regardless of whether OCR runs or succeeds.
      const imageMeta = parseImageMetadata(raw);
      if (opts?.ocr === false) return { text: '', truncated: false, kind: 'unsupported', imageMeta };
      const ext = fileName.toLowerCase().split('.').pop() ?? '';
      const provider = resolveOcrProvider(opts);
      const hit = await tryOcr(raw, mimeType.startsWith('image/') ? mimeType : IMAGE_MIME_BY_EXT[ext] ?? 'image/png', provider);
      if (!hit) return { text: '', truncated: false, kind: 'unsupported', imageMeta };
      return {
        text: hit.text.slice(0, EXTRACT_TEXT_CAP),
        truncated: hit.text.length > EXTRACT_TEXT_CAP,
        kind: 'image',
        ocr: true,
        ocrProvider: hit.provider,
        imageMeta,
      };
    }
    if (kind === 'pdf') {
      const result = await extractPdf(data);
      // Textless (scanned) PDF: rasterize pages and OCR them.
      if (!result.text.trim() && opts?.ocr !== false) {
        const provider = resolveOcrProvider(opts);
        const pages = await rasterizePdfPages(absPath);
        if (pages.length > 0) {
          const parts: string[] = [];
          let providerName: string | undefined;
          for (const pagePng of pages) {
            const hit = await tryOcr(pagePng, 'image/png', provider);
            if (hit) {
              providerName = hit.provider;
              if (hit.text.trim()) parts.push(hit.text.trim());
            }
            if (parts.join('\n').length >= EXTRACT_TEXT_CAP) break;
          }
          if (parts.length > 0) {
            const text = parts.join('\n');
            return {
              ...result,
              text: text.slice(0, EXTRACT_TEXT_CAP),
              truncated: result.truncated || text.length > EXTRACT_TEXT_CAP,
              ocr: true,
              ocrProvider: providerName,
            };
          }
        }
      }
      return result;
    }
    if (kind === 'docx') return extractDocx(data);
    if (kind === 'pptx') return extractPptx(data);
    if (kind === 'xlsx') return extractXlsx(data);
    return { text: '', truncated: false, kind: 'unsupported' };
  } catch {
    return { text: '', truncated: false, kind };
  }
}
