// SPDX-License-Identifier: Apache-2.0
// Notion export importer — takes a Notion "Export → HTML" ZIP (or a list of
// pre-extracted files) and turns it into KriyaDot content:
//
//   - `*.html` files → Pages (via a small HTML→Markdown converter)
//   - `*.csv`  files → Notion-style Databases (schema inferred from cells)
//   - `*.md`   files → Pages (verbatim markdown)
//
// Sub-pages in a Notion export are separate files; they are imported as
// flat sibling pages (KriyaDot pages have no nesting yet) with a title suffix
// when names collide. Local asset files (images etc.) are skipped and
// reported in `warnings`.
//
// Mount at boot, e.g.:
//   import { registerNotionImportRoutes } from './notion-import.js';
//   const notionRouter = express.Router();
//   registerNotionImportRoutes(notionRouter, { dataDir: config.dataDir });
//   router.use('/notion', notionRouter);
//
// Routes (router mounted at /api/notion):
//   POST /import → { zip?: base64 } | { files?: [{ name, content }] }
//                  → { pages: Page[], databases: Database[], warnings: string[] } (201)

import { Router } from 'express';
import type { Request, Response } from 'express';
import { unzipSync } from 'fflate';
import { DatabaseRowStore, DatabaseStore, parseCsv, type DatabaseColumn } from './databases.js';
import { PageStore, type Page } from './pages.js';

export interface NotionImportFile {
  name: string;
  /** UTF-8 text content of the file. */
  content: string;
}

export interface NotionImportResult {
  pages: Page[];
  databases: Array<{ id: string; name: string; columns: DatabaseColumn[]; rowCount: number }>;
  warnings: string[];
}

const ZIP_MAX_BYTES = 10 * 1024 * 1024;
const FILE_MAX_BYTES = 2 * 1024 * 1024;
const FILES_MAX = 500;

export function registerNotionImportRoutes(
  router: Router,
  deps: { dataDir: string; pageStore?: PageStore; databaseStore?: DatabaseStore; rowStore?: DatabaseRowStore },
): void {
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);
  const databases = deps.databaseStore ?? new DatabaseStore(deps.dataDir);
  const rows = deps.rowStore ?? new DatabaseRowStore(deps.dataDir, databases);

  router.post('/import', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { zip?: unknown; files?: unknown };
      let files: NotionImportFile[];
      if (typeof body.zip === 'string') {
        files = filesFromZip(body.zip);
      } else if (Array.isArray(body.files)) {
        files = filesFromList(body.files);
      } else {
        res.status(400).json({ error: 'provide "zip" (base64) or "files" ([{ name, content }])' });
        return;
      }
      const result = importFiles(files, pages, databases, rows);
      res.status(201).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'notion import failed';
      const status = message.startsWith('invalid ') || message.startsWith('provide ') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });
}

function filesFromZip(zipBase64: string): NotionImportFile[] {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(zipBase64, 'base64');
  } catch {
    throw new Error('invalid zip: not valid base64');
  }
  if (bytes.length === 0) throw new Error('invalid zip: empty payload');
  if (bytes.length > ZIP_MAX_BYTES) throw new Error('invalid zip: larger than 10MB');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Error('invalid zip: cannot unzip');
  }
  const names = Object.keys(entries);
  if (names.length > FILES_MAX) throw new Error(`invalid zip: more than ${FILES_MAX} files`);
  const out: NotionImportFile[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const name of names) {
    if (name.endsWith('/')) continue; // directory entry
    const data = entries[name];
    if (data.length > FILE_MAX_BYTES) {
      out.push({ name, content: '' }); // flagged as skipped below
      continue;
    }
    out.push({ name, content: decoder.decode(data) });
  }
  return out;
}

function filesFromList(raw: unknown[]): NotionImportFile[] {
  if (raw.length > FILES_MAX) throw new Error(`invalid files: more than ${FILES_MAX} entries`);
  return raw.map((f, i) => {
    const o = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim()) {
      throw new Error(`invalid files[${i}]: "name" is required`);
    }
    if (typeof o.content !== 'string') {
      throw new Error(`invalid files[${i}]: "content" must be a string`);
    }
    if (o.content.length > FILE_MAX_BYTES) throw new Error(`invalid files[${i}]: larger than 2MB`);
    return { name: o.name, content: o.content };
  });
}

function importFiles(
  files: NotionImportFile[],
  pages: PageStore,
  databases: DatabaseStore,
  rows: DatabaseRowStore,
): NotionImportResult {
  const result: NotionImportResult = { pages: [], databases: [], warnings: [] };
  const usedTitles = new Set<string>();

  const uniqueTitle = (base: string): string => {
    let title = base || 'Untitled';
    let n = 2;
    while (usedTitles.has(title.toLowerCase())) {
      title = `${base || 'Untitled'} (${n})`;
      n++;
    }
    usedTitles.add(title.toLowerCase());
    return title;
  };

  for (const file of files) {
    const base = file.name.split('/').pop() ?? file.name;
    if (!file.content && base) {
      result.warnings.push(`skipped oversized file: ${file.name}`);
      continue;
    }
    if (/\.html?$/i.test(base)) {
      const markdown = htmlToMarkdown(file.content);
      const title = uniqueTitle(titleFromFileName(base));
      result.pages.push(pages.create({ title, content: markdown, createdBy: 'notion-import' }));
    } else if (/\.md$/i.test(base)) {
      const title = uniqueTitle(titleFromFileName(base));
      result.pages.push(pages.create({ title, content: file.content.slice(0, 200_000), createdBy: 'notion-import' }));
    } else if (/\.csv$/i.test(base)) {
      const db = importCsvAsDatabase(file, databases, rows, result.warnings);
      if (db) result.databases.push(db);
    } else if (/\.(png|jpe?g|gif|webp|svg|pdf|mp4|mov)$/i.test(base)) {
      result.warnings.push(`skipped asset file (not imported): ${file.name}`);
    } else {
      result.warnings.push(`skipped unsupported file: ${file.name}`);
    }
  }
  return result;
}

function titleFromFileName(name: string): string {
  // Notion exports look like "My Page 1a2b3c4d5e6f.html" — strip the 32-hex
  // page id suffix and the extension.
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/\s+[0-9a-f]{32}$/i, '')
    .trim()
    .slice(0, 200);
}

function importCsvAsDatabase(
  file: NotionImportFile,
  databases: DatabaseStore,
  rows: DatabaseRowStore,
  warnings: string[],
): NotionImportResult['databases'][number] | null {
  const records = parseCsv(file.content);
  if (records.length === 0) {
    warnings.push(`skipped empty CSV: ${file.name}`);
    return null;
  }
  const header = records[0];
  const data = records.slice(1).filter((r) => r.some((c) => c.trim()));
  if (header.length === 0 || header.every((h) => !h.trim())) {
    warnings.push(`skipped CSV with no header: ${file.name}`);
    return null;
  }
  const columns: DatabaseColumn[] = header.map((h, i) => ({
    id: `col_${i}`,
    name: (h.trim() || `Column ${i + 1}`).slice(0, 100),
    type: inferColumnType(data.map((r) => r[i] ?? '')),
  }));
  const db = databases.create({
    name: titleFromFileName(file.name.split('/').pop() ?? file.name),
    description: `Imported from Notion CSV: ${file.name}`,
    columns,
  });
  if (data.length > 0) {
    const csv = [header.join(','), ...data.map((r) => r.map(csvCell).join(','))].join('\n');
    const { skipped } = rows.importCsv(db.id, csv, true);
    if (skipped > 0) warnings.push(`${skipped} cell(s) in ${file.name} could not be coerced and were left empty`);
  }
  return { id: db.id, name: db.name, columns: db.columns, rowCount: databases.rowCount(db.id) };
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Infer a column type from a sample of cell strings. */
function inferColumnType(cells: string[]): DatabaseColumn['type'] {
  const vals = cells.map((c) => c.trim()).filter(Boolean);
  if (vals.length === 0) return 'text';
  if (vals.every((v) => /^(true|false|1|0|yes|no)$/i.test(v))) return 'checkbox';
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date';
  if (vals.every((v) => /^-?[\d,]+(\.\d+)?$/.test(v))) return 'number';
  return 'text';
}

// ---------------------------------------------------------------------------
// HTML → Markdown (Notion export flavor)
// ---------------------------------------------------------------------------

/**
 * Converts Notion HTML-export pages to Markdown. Handles headings,
 * paragraphs, lists, links, code, quotes, tables, images and horizontal
 * rules; everything else degrades to plain text. Deliberately dependency-
 * free and conservative — unknown markup becomes text, never markup soup.
 */
export function htmlToMarkdown(html: string): string {
  let s = html;
  // Drop head, scripts, styles.
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // Notion wraps the page in <div class="page-body">; use it when present.
  const bodyMatch = /<div[^>]*class="[^"]*page-body[^"]*"[^>]*>([\s\S]*)<\/div>\s*<\/body>/i.exec(s);
  if (bodyMatch) s = bodyMatch[1];

  const out: string[] = [];
  const inline = (frag: string): string => {
    let t = frag;
    // Links → [text](href)
    t = t.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = stripTags(text).trim() || href;
      return `[${label}](${href})`;
    });
    // Bold / italic / code / strikethrough
    t = t.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
    t = t.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*');
    t = t.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
    t = t.replace(/<(s|del|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~');
    t = stripTags(t);
    return decodeEntities(t).replace(/[ \t]+/g, ' ').trim();
  };

  // Headings
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
    out.push(`${'#'.repeat(Number(lvl))} ${inline(inner)}`);
    return '\u0000';
  });
  // Preformatted code blocks
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    out.push(`\`\`\`\n${decodeEntities(stripTags(inner)).trim()}\n\`\`\``);
    return '\u0000';
  });
  // Tables → markdown tables
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (tbl) => {
    const rows: string[][] = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr: RegExpExecArray | null;
    while ((tr = trRe.exec(tbl)) !== null) {
      const cells: string[] = [];
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let td: RegExpExecArray | null;
      while ((td = tdRe.exec(tr[1])) !== null) cells.push(inline(td[1]).replace(/\|/g, '\\|'));
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return '\u0000';
    const md = [rows[0].join(' | '), rows[0].map(() => '---').join(' | '), ...rows.slice(1).map((r) => r.join(' | '))];
    out.push(md.join('\n'));
    return '\u0000';
  });
  // Lists (flatten nested lists with indentation)
  s = s.replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, kind: string, inner: string) => {
    const items: string[] = [];
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li: RegExpExecArray | null;
    let n = 0;
    while ((li = liRe.exec(inner)) !== null) {
      n++;
      const bullet = kind === 'ol' ? `${n}.` : '-';
      const text = inline(li[1]).replace(/\n/g, ' ');
      const box = /<input[^>]*checked/i.test(li[1]) ? '[x]' : /\bcheckbox\b/i.test(li[1]) ? '[ ]' : null;
      items.push(box ? `${bullet} ${box} ${text.replace(/^\[.\]\s*/, '')}` : `${bullet} ${text}`);
    }
    out.push(items.join('\n'));
    return '\u0000';
  });
  // Blockquotes
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    out.push(inline(inner).split('\n').map((l) => `> ${l}`).join('\n'));
    return '\u0000';
  });
  // Images → ![alt](src)
  s = s.replace(/<img[^>]*>/gi, (img) => {
    const src = /src="([^"]*)"/i.exec(img)?.[1] ?? '';
    const alt = /alt="([^"]*)"/i.exec(img)?.[1] ?? 'image';
    out.push(src ? `![${alt}](${src})` : '');
    return '\u0000';
  });
  // Horizontal rules
  s = s.replace(/<hr[^>]*>/gi, () => {
    out.push('---');
    return '\u0000';
  });
  // Paragraphs / divs → text blocks
  s = s.replace(/<(p|div)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => {
    const t = inline(inner);
    if (t) out.push(t);
    return '\u0000';
  });
  // Anything left standing becomes plain text.
  const rest = inline(s.replace(/\u0000/g, '\n'));
  const blocks: string[] = [];
  for (const b of out) {
    if (b.trim()) blocks.push(b.trim());
  }
  if (rest) {
    for (const line of rest.split('\n')) {
      const t = line.trim();
      if (t && !blocks.includes(t)) blocks.push(t);
    }
  }
  return blocks.join('\n\n').slice(0, 200_000);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
