// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import {
  extractDocumentText,
  detectDocKind,
  EXTRACT_TEXT_CAP,
} from '../src/document-extract.js';

const WORK_DIR = join(tmpdir(), 'doc-extract-test');

/** Build a minimal one-page PDF with the given text lines (uncompressed). */
function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let y = 720;
  const ops = lines.map((l) => `BT /F1 12 Tf 72 ${y} Td (${esc(l)}) Tj ET`).join('\n');
  y -= 20;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>Hello DOCX world</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph here</w:t></w:r></w:p>
</w:body>
</w:document>`;

const XLSX_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><t>Alice</t></si><si><t>Bob</t></si>
</sst>`;

const XLSX_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
</sheetData>
</worksheet>`;

const slideXml = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
  // Self-contained fixtures: generated in-test so CI never depends on /tmp/fixtures.
  writeFileSync(join(WORK_DIR, 'test.pdf'), makePdf(['Hello PDF world', 'Second line of text']));
  writeFileSync(
    join(WORK_DIR, 'test.docx'),
    zipSync({ 'word/document.xml': strToU8(DOCX_XML) }),
  );
  writeFileSync(
    join(WORK_DIR, 'test.xlsx'),
    zipSync({
      'xl/sharedStrings.xml': strToU8(XLSX_STRINGS),
      'xl/worksheets/sheet1.xml': strToU8(XLSX_SHEET),
    }),
  );
  writeFileSync(
    join(WORK_DIR, 'test.pptx'),
    zipSync({
      'ppt/slides/slide1.xml': strToU8(slideXml('Welcome to the presentation')),
      'ppt/slides/slide2.xml': strToU8(slideXml('Slide two content')),
    }),
  );
  writeFileSync(join(WORK_DIR, 'hello.txt'), 'plain text file\nsecond line');
  writeFileSync(join(WORK_DIR, 'fake.pdf'), 'not a real pdf');
});

describe('detectDocKind', () => {
  it('detects by mime type', () => {
    expect(detectDocKind('application/pdf', 'x.bin')).toBe('pdf');
    expect(detectDocKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x.bin')).toBe('docx');
  });
  it('detects by extension fallback', () => {
    expect(detectDocKind('application/octet-stream', 'report.pdf')).toBe('pdf');
    expect(detectDocKind('application/octet-stream', 'data.xlsx')).toBe('xlsx');
    expect(detectDocKind('application/octet-stream', 'deck.pptx')).toBe('pptx');
    expect(detectDocKind('application/octet-stream', 'notes.txt')).toBe('text');
  });
  it('returns unsupported for unknown', () => {
    expect(detectDocKind('application/octet-stream', 'blob.xyz')).toBe('unsupported');
    expect(detectDocKind('image/png', 'pic.png')).toBe('unsupported');
  });
});

describe('PDF extraction', () => {
  it('extracts text per page', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'test.pdf'), 'application/pdf', 'test.pdf');
    expect(r.kind).toBe('pdf');
    expect(r.text).toContain('Hello PDF world');
    expect(r.text).toContain('Second line of text');
    expect(r.units).toBe(1);
    expect(r.unitLabel).toBe('pages');
  });
  it('returns empty on corrupt pdf without throwing', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'fake.pdf'), 'application/pdf', 'fake.pdf');
    expect(r.text).toBe('');
  });
});

describe('DOCX extraction', () => {
  it('extracts paragraph text', async () => {
    const r = await extractDocumentText(
      join(WORK_DIR, 'test.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'test.docx',
    );
    expect(r.kind).toBe('docx');
    expect(r.text).toContain('Hello DOCX world');
    expect(r.text).toContain('Second paragraph here');
  });
});

describe('XLSX extraction', () => {
  it('extracts sheets as markdown tables', async () => {
    const r = await extractDocumentText(
      join(WORK_DIR, 'test.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'test.xlsx',
    );
    expect(r.kind).toBe('xlsx');
    expect(r.text).toContain('Alice');
    expect(r.text).toContain('Bob');
    expect(r.text).toContain('|');
    expect(r.units).toBe(1);
    expect(r.unitLabel).toBe('sheets');
  });
});

describe('PPTX extraction', () => {
  it('extracts slide text', async () => {
    const r = await extractDocumentText(
      join(WORK_DIR, 'test.pptx'),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'test.pptx',
    );
    expect(r.kind).toBe('pptx');
    expect(r.text).toContain('Welcome to the presentation');
    expect(r.text).toContain('Slide two content');
    expect(r.units).toBe(2);
    expect(r.unitLabel).toBe('slides');
  });
});

describe('text files', () => {
  it('passes through with cap', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'hello.txt'), 'text/plain', 'hello.txt');
    expect(r.kind).toBe('text');
    expect(r.text).toContain('plain text file');
    expect(r.truncated).toBe(false);
  });
});

describe('unsupported', () => {
  it('returns empty without throwing', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'hello.txt'), 'image/png', 'pic.png');
    expect(r.kind).toBe('unsupported');
    expect(r.text).toBe('');
  });
  it('never throws on missing file', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'nope.pdf'), 'application/pdf', 'nope.pdf');
    expect(r.text).toBe('');
  });
});

describe('EXTRACT_TEXT_CAP', () => {
  it('is 100KB', () => {
    expect(EXTRACT_TEXT_CAP).toBe(100_000);
  });
});
